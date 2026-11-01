import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { TencentIlinkTransport } from '../../vendor/wechat-ilink/index.js'
import { handleCommand, isRetryable, outboundChunks, WechatBusinessError, WechatIlinkError } from './commands.js'
import { AppError } from '../errors.js'

const { version: PLUGIN_VERSION } = createRequire(import.meta.url)('../../package.json')
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const VERIFICATION_WAIT_MS = 180_000
/** 已发送的出站消息默认保留 7 天，之后清理。 */
const OUTBOX_RETENTION_DAYS = 7
/** 进程内记忆已处理消息，避免 cursor 未推进时重复回复。 */
const PROCESSED_MEMORY_LIMIT = 500
/** 用户侧只给通用失败提示，具体错误写日志。 */
const GENERIC_FAILURE_TEXT = '消息处理失败，稍后重试'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 授权响应里可能出现的用户标识字段（vendor 的 confirmed 返回 userId=ilink_user_id）。 */
const AUTH_USER_ID_KEYS = ['userId', 'ilink_user_id', 'ilinkUserId', 'peerId', 'wxid', 'from_user_id', 'fromUserId']

/**
 * 个人微信（腾讯 iLink 官方协议）通道宿主：
 * 凭证持久化、扫码授权、长轮询生命周期、管理员指令路由、事件推送。
 * 协议细节全部在 vendor/wechat-ilink（见 NOTICE 出处）。
 */
export class WechatChannel {
  constructor({ store, config, log = console }) {
    this.store = store
    this.config = config
    this.log = log
    this.service = null
    this.transport = null
    this.epoch = null
    this.authAbort = null
    this.phase = 'disabled'
    this.error = null
    this.auth = null
    this.peers = new Map()
    /** 授权成功但响应未带用户标识时的降级绑定标记。 */
    this.pendingAdmin = null
    /** 本进程内已放弃重试的出站消息 id。 */
    this.failedOutbox = new Set()
    /** 本进程内已处理过的入站消息 id。 */
    this.processedMessages = new Set()
  }

  setService(service) {
    this.service = service
  }

  enabled() {
    return Boolean(this.config.wechat?.enabled)
  }

  async start() {
    if (!this.enabled()) return
    // 启动即清理过期的已发送记录（默认保留 7 天），避免出站历史无限堆积
    this.store.purgeSentOutbox?.(OUTBOX_RETENTION_DAYS)
    const state = this.store.getState()
    const credentials = state?.credentials_json ? JSON.parse(state.credentials_json) : null
    if (!credentials) {
      this.phase = 'unbound'
      return
    }
    await this.connect(credentials)
  }

  async stop() {
    if (this.epoch) {
      this.epoch.abort.abort()
      await this.epoch.drain.catch(() => {})
      this.epoch = null
    }
    this.authAbort?.abort()
    this.authAbort = null
    this.transport = null
    this.peers.clear()
  }

  status() {
    return {
      phase: this.phase,
      enabled: this.enabled(),
      error: this.error,
      adminPeerId: this.store.getState()?.admin_peer_id ?? null,
      pendingAdmin: Boolean(this.pendingAdmin),
      auth: this.auth
        ? { state: this.auth.state, qrCodeUrl: this.auth.challenge?.qrCodeUrl ?? null, event: this.auth.event }
        : null,
    }
  }

  /** UI 触发扫码登录；返回二维码内容，后续进度经 status() 暴露。
   * 注意：begin 与 wait 必须走同一个 transport 实例——vendor 的授权状态机
   * 把 challenge 记在实例内部的 active Map 上，换实例 wait 必然 AUTH_EXPIRED。
   */
  async beginLogin() {
    if (!this.enabled()) throw new Error('微信通道未启用（DSH_TEAM_WECHAT=1）')
    if (this.phase === 'connected' || this.phase === 'reconnecting') throw new Error('微信通道已登录，如需换号请先退出')
    await this.stop()
    this.error = null
    // 新的授权流程开始，上一次授权会话的待绑定标记失效
    this.pendingAdmin = null
    const auth = {
      id: randomUUID(),
      state: 'pending',
      event: null,
      challenge: null,
      verificationResolve: null,
    }
    this.auth = auth
    const abort = new AbortController()
    this.authAbort = abort
    const transport = this.makeTransport(null, { authorizationObserver: this.authObserver(auth) })
    try {
      auth.challenge = await transport.beginAuthorization(abort.signal)
      auth.state = 'scanning'
      void transport.waitAuthorization(auth.challenge, abort.signal)
        .then(async credentials => {
          this.store.saveCredentials(credentials)
          if (this.auth === auth) this.auth = null
          this.log.info?.('[wechat] 授权成功，开始连接')
          this.bindAuthorizedAdmin(credentials)
          try {
            await this.connect(credentials)
          } catch (error) {
            this.log.warn?.(`[wechat] 授权后连接失败: ${this.errorText(error)}`)
          }
        })
        .catch(error => this.failAuth(error, auth))
      return auth.challenge
    } catch (error) {
      this.failAuth(error, auth)
      throw error
    }
  }

  authObserver(auth) {
    return {
      onEvent: event => {
        auth.event = event
      },
      requestVerificationCode: async () => {
        auth.state = 'verification'
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new WechatIlinkError('AUTH_TIMEOUT', '验证码等待超时', true)), VERIFICATION_WAIT_MS)
          auth.verificationResolve = value => {
            clearTimeout(timer)
            resolve(value)
          }
        })
        auth.state = 'scanning'
        return code
      },
    }
  }

  submitVerificationCode(code) {
    if (!this.auth?.verificationResolve) throw new Error('当前没有等待验证码的授权流程')
    if (!/^\d{1,12}$/.test(code)) throw new Error('验证码应为数字')
    this.auth.verificationResolve(code)
    return true
  }

  /** 只有当失败属于当前这次登录流程时才清登录态，避免旧流程的失败抹掉新登录。 */
  failAuth(error, auth) {
    const current = this.auth
    if (auth && (!current || current.id !== auth.id)) {
      this.log.warn?.(`[wechat] 忽略过期授权流程的失败（保留当前登录状态）: ${this.errorText(error)}`)
      return
    }
    this.auth = null
    this.error = error instanceof WechatIlinkError ? `${error.code}: ${error.message}` : String(error?.message ?? error)
    this.phase = this.store.getState()?.credentials_json ? 'needs_reauth' : 'unbound'
    this.log.warn?.(`[wechat] 授权失败: ${this.error}`)
  }

  /** 扫码授权即绑定授权者：授权响应带用户标识就直接落盘，否则降级到本次会话首条入站消息。 */
  bindAuthorizedAdmin(credentials) {
    const authUserId = extractAuthUserId(credentials)
    if (authUserId) {
      this.store.saveAdminPeer(authUserId)
      this.pendingAdmin = null
      this.log.info?.(`[wechat] 管理员已绑定（扫码授权者）: ${authUserId}`)
      return authUserId
    }
    this.pendingAdmin = { armedAt: Date.now() }
    this.log.info?.('[wechat] 授权成功但响应未带用户标识，等待本次会话首条入站消息绑定管理员')
    return null
  }

  async logout() {
    await this.stop()
    this.store.clearCredentials()
    this.pendingAdmin = null
    this.failedOutbox.clear()
    this.phase = 'unbound'
  }

  makeTransport(credentials, extra = {}) {
    return new TencentIlinkTransport({
      baseUrl: credentials?.baseUrl ?? 'https://ilinkai.weixin.qq.com',
      token: credentials?.token,
      botAgent: `DSHTeamBots/${PLUGIN_VERSION}`,
      clientVersion: PLUGIN_VERSION,
      fetch,
      ...extra,
    })
  }

  async connect(credentials) {
    await this.stop()
    const transport = this.makeTransport(credentials)
    const abort = new AbortController()
    const epoch = { abort, credentials }
    this.transport = transport
    this.epoch = epoch
    this.phase = 'connecting'
    try {
      await transport.notifyStart(abort.signal)
    } catch (error) {
      if (abort.signal.aborted) return
      this.log.warn?.(`[wechat] notifystart 失败，继续轮询: ${this.errorText(error)}`)
    }
    if (abort.signal.aborted) return
    this.phase = 'connected'
    this.error = null
    const drain = this.pollLoop(epoch, transport, abort.signal).finally(() => {
      if (this.epoch === epoch) {
        this.transport = null
        this.epoch = null
      }
    })
    epoch.drain = drain
    void drain.catch(() => {})
  }

  async pollLoop(epoch, transport, signal) {
    let cursor = this.store.getState()?.cursor ?? ''
    let failures = 0
    while (!signal.aborted && this.epoch === epoch) {
      try {
        const result = await transport.poll(cursor, signal)
        failures = 0
        // 先处理消息，全部成功后再推进并落盘 cursor；失败则留在原处等下一轮重试
        const batchOk = await this.handleBatch(result.messages, transport, signal)
        if (batchOk && result.cursor && result.cursor !== cursor) {
          cursor = result.cursor
          this.store.saveCursor(cursor)
        }
      } catch (error) {
        if (signal.aborted || this.epoch !== epoch) return
        if (error instanceof WechatIlinkError && ['AUTH_REPLACED', 'AUTH_EXPIRED'].includes(error.code)) {
          this.phase = 'needs_reauth'
          this.error = `${error.code}: ${error.message}`
          this.log.warn?.('[wechat] 凭证失效，需要重新扫码')
          return
        }
        const delay = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)]
        failures += 1
        this.phase = failures > 1 ? 'reconnecting' : 'connected'
        this.log.warn?.(`[wechat] 轮询失败(${failures})，${delay}ms 后重试: ${this.errorText(error)}`)
        await sleep(delay)
      }
    }
  }

  /** 处理一批入站消息；返回是否整批成功（失败时 cursor 不推进）。 */
  async handleBatch(messages, transport, signal) {
    let ok = true
    for (const message of messages) {
      if (!message.text) continue
      const key = message.messageId
      if (key && this.processedMessages.has(key)) continue
      try {
        await this.onInbound(message, transport, signal)
        if (key) this.rememberProcessed(key)
      } catch (error) {
        ok = false
        this.log.warn?.(`[wechat] 消息处理失败（cursor 不推进，稍后重试）: ${this.errorText(error)}`)
      }
    }
    return ok
  }

  rememberProcessed(key) {
    this.processedMessages.add(key)
    if (this.processedMessages.size > PROCESSED_MEMORY_LIMIT) {
      const oldest = this.processedMessages.values().next().value
      this.processedMessages.delete(oldest)
    }
  }

  adminPeerId() {
    return this.store.getState()?.admin_peer_id ?? null
  }

  async onInbound(message, transport, signal) {
    const peerId = message.senderId
    this.peers.set(peerId, { contextToken: message.contextToken, clientId: message.clientId, at: Date.now() })
    const admin = this.adminPeerId()
    if (!admin && this.pendingAdmin) {
      // 降级路径：本次授权会话内的第一条入站消息的发送者即管理员
      this.store.saveAdminPeer(peerId)
      this.pendingAdmin = null
      this.log.info?.(`[wechat] 管理员已绑定（本次授权会话首条消息）: ${peerId}`)
      await this.sendTo(peerId, '已绑定为本团队管理员。回复「帮助」查看指令。', signal)
      await this.flushOutbox(transport, signal)
      return
    }
    if (peerId !== admin) {
      this.log.info?.(`[wechat] 忽略非管理员消息来自 ${peerId}`)
      return
    }
    // 与管理员的会话凭证已可用，之前因缺凭证放弃的推送可以再试
    this.failedOutbox.clear()
    try {
      const reply = await handleCommand(this.service, message.text)
      await this.sendTo(peerId, reply, signal)
    } catch (error) {
      if (isBusinessError(error)) {
        // 业务性拒绝（如任务不存在、任务号非法）：给用户可读提示即可，不算处理失败
        this.log.warn?.(`[wechat] 指令被拒绝: ${this.errorText(error)}`)
        await this.sendTo(peerId, String(error?.message ?? '指令无法执行'), signal)
          .catch(sendError => this.log.warn?.(`[wechat] 提示发送失败: ${this.errorText(sendError)}`))
        return
      }
      this.log.warn?.(`[wechat] 指令执行失败: ${this.errorText(error)}`)
      await this.sendTo(peerId, GENERIC_FAILURE_TEXT, signal)
        .catch(sendError => this.log.warn?.(`[wechat] 失败提示发送失败: ${this.errorText(sendError)}`))
      // 交给上层：这条没处理成功，cursor 不推进，下一轮还会重试
      throw error
    }
  }

  async sendTo(peerId, text, signal = new AbortController().signal) {
    if (!this.transport) throw new Error('微信通道未连接')
    const peer = this.peers.get(peerId)
    // 尚无会话凭证属于可恢复状态（等对方发来消息即可），重试有意义
    if (!peer?.contextToken) throw new Error('尚无该联系人的会话凭证，等待对方发来消息')
    const body = String(text ?? '').trim()
    if (!body) return
    for (const chunk of outboundChunks(body)) {
      await this.transport.sendMessage({
        peerId,
        text: chunk,
        contextToken: peer.contextToken,
        clientId: randomUUID(),
      }, signal)
    }
  }

  /** 对外事件推送入口：未连接或无会话凭证时落盘，管理员出现后补发。 */
  notify(text) {
    if (!this.enabled()) return
    const body = String(text ?? '').trim()
    if (!body) {
      this.log.warn?.('[wechat] 空文本不入队')
      return
    }
    try {
      this.store.enqueue(body)
    } catch (error) {
      this.log.warn?.(`[wechat] 推送入队失败: ${this.errorText(error)}`)
      return
    }
    if (this.phase === 'connected' && this.transport) {
      const signal = this.epoch?.abort?.signal ?? new AbortController().signal
      void this.flushOutbox(this.transport, signal).catch(error => {
        this.log.warn?.(`[wechat] 推送刷新失败${isRetryable(error) ? '（可重试）' : '（不可重试）'}: ${this.errorText(error)}`)
      })
    }
  }

  async flushOutbox(transport, signal) {
    const admin = this.adminPeerId()
    if (!admin) return
    const pending = this.store.pendingOutbox()
    for (const item of pending) {
      if (this.failedOutbox.has(item.id)) continue
      try {
        await this.sendTo(admin, item.text, signal)
        this.store.markSent([item.id])
        this.failedOutbox.delete(item.id)
      } catch (error) {
        // 发送失败绝不能标记为已发送
        if (isRetryable(error)) {
          this.log.warn?.(`[wechat] 推送失败(可重试，保留待发) id=${item.id}: ${this.errorText(error)}`)
        } else {
          this.failedOutbox.add(item.id)
          this.log.warn?.(`[wechat] 推送失败(不可重试，本进程不再重试该条) id=${item.id}: ${this.errorText(error)}`)
        }
      }
    }
  }

  errorText(error) {
    if (error instanceof WechatIlinkError) return `${error.code}: ${error.message}`
    return String(error?.message ?? error)
  }
}

/** 业务性拒绝（任务不存在、参数非法等）：可读提示即可，不重试。 */
function isBusinessError(error) {
  return error instanceof AppError || error instanceof WechatBusinessError || error?.permanent === true
}

/** 从授权响应里取用户标识（vendor confirmed 返回 userId=ilink_user_id）。 */
function extractAuthUserId(credentials) {
  if (!credentials || typeof credentials !== 'object') return null
  for (const key of AUTH_USER_ID_KEYS) {
    const value = credentials[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}
