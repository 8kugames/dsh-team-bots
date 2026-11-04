import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { TencentIlinkTransport } from '../../vendor/wechat-ilink/index.js'
import { handleCommand, isRetryable, outboundChunks, WechatBusinessError, WechatIlinkError } from './commands.js'
import { AppError } from '../errors.js'

const { version: PLUGIN_VERSION } = createRequire(import.meta.url)('../../package.json')
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const VERIFICATION_WAIT_MS = 180_000
/** 已发送的出站消息默认保留 7 天，之后清理（废弃行同样按此清理）。 */
const OUTBOX_RETENTION_DAYS = 7
/** 会话凭证（contextToken）时效上限：最后刷新超过 7 天视为过期，
 *  回落到「等对方发来消息」的既有可恢复路径，不报错刷屏。 */
const PEER_TTL_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
/** 待发消息最大尝试次数（含首次发送）：达到上限仍未发出即废弃，永不补发。
 *  治理口径：历史堆积不无限重试，通道恢复后只发新事件，避免逐条补发刷屏占额度。 */
const OUTBOX_MAX_ATTEMPTS = 3
/** 合批窗口：窗口内到达的多条推送合并为一次发送（一轮任务事件常并发多条，逐条发占消息额度）。 */
const OUTBOX_BATCH_WINDOW_MS = 1500
/** 合批摘要的明细行数上限：超过只保留最旧的 N 条原文，其余以「等 N 项」汇总。 */
const OUTBOX_BATCH_LINES = 5
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
  constructor({ store, config, log = console, batchWindowMs = OUTBOX_BATCH_WINDOW_MS }) {
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
    /** 本进程内已处理过的入站消息 id。 */
    this.processedMessages = new Set()
    /** 合批窗口毫秒数（测试可注入）；窗口内多次 notify 合并为一次发送。 */
    this.batchWindowMs = batchWindowMs
    /** 合批窗口定时器；unref，不阻止进程退出。 */
    this.flushTimer = null
    /** flushOutbox 串行化链：并发 flush 会重复读取同一批 pending 造成重复发送。 */
    this.flushChain = Promise.resolve()
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
    // 同步清理过期的会话凭证，避免 peers 表随时间无限堆积
    this.store.purgeExpiredPeers?.(PEER_TTL_DAYS)
    const state = this.store.getState()
    const credentials = state?.credentials_json ? JSON.parse(state.credentials_json) : null
    if (!credentials) {
      this.phase = 'unbound'
      return
    }
    await this.connect(credentials)
  }

  async stop() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
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
    // 读回持久化的会话凭证：重启/重连后无需对方先发消息即可主动发送（过期条目跳过）
    this.loadPeers()
    // 本次链接建立之前的堆积一律作废不补发（历史积压治理口径）：
    // 重启恢复或换号重登都不追溯旧状态，链接之后产生的新事件才发送。
    const voided = this.store.giveUpAllPending?.() ?? 0
    if (voided > 0) this.log.info?.(`[wechat] 链接建立，作废此前待发堆积 ${voided} 条（不补发）`)
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
    const peer = { contextToken: message.contextToken, clientId: message.clientId, at: Date.now() }
    this.peers.set(peerId, peer)
    this.persistPeer(peerId, peer)
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

  /** 会话凭证写库：失败只降级（本进程内存凭证仍可用），不阻断消息处理与 cursor 推进。 */
  persistPeer(peerId, peer) {
    try {
      this.store.savePeer?.(peerId, peer)
    } catch (error) {
      this.log.warn?.(`[wechat] 会话凭证写库失败: ${this.errorText(error)}`)
    }
  }

  /** 从库读回会话凭证（connect 时调用）：过期条目跳过，回落「等对方发来消息」的既有路径。 */
  loadPeers() {
    const rows = this.store.loadPeers?.() ?? []
    const cutoff = Date.now() - PEER_TTL_DAYS * DAY_MS
    for (const row of rows) {
      if (!row?.peer_id || !row.context_token || Number(row.at) < cutoff) continue
      this.peers.set(row.peer_id, { contextToken: row.context_token, clientId: row.client_id, at: Number(row.at) })
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

  /** 对外事件推送入口：入队后经合批窗口合并发送；未连接时仅落盘，链接建立后由新事件触发。 */
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
    if (this.phase === 'connected' && this.transport) this.scheduleOutboxFlush()
  }

  /** 合批窗口：窗口内的多次推送合并到同一次 flush，一轮并发任务事件只占一次消息额度。 */
  scheduleOutboxFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const transport = this.transport
      if (!transport || this.phase !== 'connected') return
      const signal = this.epoch?.abort?.signal ?? new AbortController().signal
      void this.flushOutbox(transport, signal).catch(error => {
        this.log.warn?.(`[wechat] 推送刷新失败${isRetryable(error) ? '（可重试）' : '（不可重试）'}: ${this.errorText(error)}`)
      })
    }, this.batchWindowMs)
    this.flushTimer.unref?.()
  }

  /** 刷出全部待发：串行化（防并发重复发送），合批为一次通道调用（单条保持原文）。 */
  async flushOutbox(transport, signal) {
    const previous = this.flushChain
    let release
    this.flushChain = new Promise(resolve => {
      release = resolve
    })
    await previous.catch(() => {})
    try {
      return await this.flushOutboxLocked(transport, signal)
    } finally {
      release()
    }
  }

  async flushOutboxLocked(transport, signal) {
    const admin = this.adminPeerId()
    if (!admin) return
    const pending = this.store.pendingOutbox()
    if (!pending.length) return
    // 发送中止不算失败：不烧尝试次数，条目保留待发由下次 flush 再试
    if (signal?.aborted) return
    const digest = pending.length === 1 ? pending[0].text : batchDigest(pending)
    try {
      await this.sendTo(admin, digest, signal)
      this.store.markSent(pending.map(item => item.id))
    } catch (error) {
      if (signal?.aborted) return
      for (const item of pending) this.recordOutboxFailure(item, error)
    }
  }

  /** 失败记账：可重试错误计一次尝试，达到上限废弃；不可重试错误直接废弃。废弃后永不补发。 */
  recordOutboxFailure(item, error) {
    const retryable = isRetryable(error)
    const attempts = retryable ? this.store.markAttempt(item.id) : null
    if (!retryable || (attempts ?? 0) >= OUTBOX_MAX_ATTEMPTS) {
      this.store.giveUp([item.id])
      this.log.warn?.(
        `[wechat] 推送废弃(不再补发) id=${item.id}${retryable ? `(尝试 ${attempts}/${OUTBOX_MAX_ATTEMPTS} 次超限)` : '(不可重试)'}: ${this.errorText(error)}`,
      )
      return
    }
    this.log.warn?.(
      `[wechat] 推送失败(可重试 ${attempts}/${OUTBOX_MAX_ATTEMPTS}，保留待发) id=${item.id}: ${this.errorText(error)}`,
    )
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

/** 合批摘要：首行条数，逐条保留原文（每条自带 KEY-N 与状态），超明细上限截断加「等 N 项」。 */
function batchDigest(items) {
  const shown = items.slice(0, OUTBOX_BATCH_LINES)
  const rest = items.length - shown.length
  const lines = [`任务动态 ${items.length} 条：`, ...shown.map(item => item.text)]
  if (rest > 0) lines.push(`……等 ${rest} 项`)
  return lines.join('\n')
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
