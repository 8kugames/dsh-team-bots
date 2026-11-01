import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { TencentIlinkTransport } from '../../vendor/wechat-ilink/index.js'
import { handleCommand, isRetryable, outboundChunks, WechatIlinkError } from './commands.js'

const { version: PLUGIN_VERSION } = createRequire(import.meta.url)('../../package.json')
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const VERIFICATION_WAIT_MS = 180_000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
  }

  setService(service) {
    this.service = service
  }

  enabled() {
    return Boolean(this.config.wechat?.enabled)
  }

  async start() {
    if (!this.enabled()) return
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
    const auth = {
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
          this.auth = null
          this.log.info?.('[wechat] 授权成功，开始连接')
          await this.connect(credentials)
        })
        .catch(error => this.failAuth(error))
      return auth.challenge
    } catch (error) {
      this.failAuth(error)
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

  failAuth(error) {
    this.auth = null
    this.error = error instanceof WechatIlinkError ? `${error.code}: ${error.message}` : String(error?.message ?? error)
    this.phase = this.store.getState()?.credentials_json ? 'needs_reauth' : 'unbound'
    this.log.warn?.(`[wechat] 授权失败: ${this.error}`)
  }

  async logout() {
    await this.stop()
    this.store.clearCredentials()
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
      this.log.warn?.(`[wechat] notifystart 失败，继续轮询: ${error?.message ?? error}`)
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
        if (result.cursor && result.cursor !== cursor) {
          cursor = result.cursor
          this.store.saveCursor(cursor)
        }
        for (const message of result.messages) {
          if (message.text) await this.onInbound(message, transport, signal)
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
        this.log.warn?.(`[wechat] 轮询失败(${failures})，${delay}ms 后重试: ${error?.message ?? error}`)
        await sleep(delay)
      }
    }
  }

  adminPeerId() {
    return this.store.getState()?.admin_peer_id ?? null
  }

  async onInbound(message, transport, signal) {
    const peerId = message.senderId
    this.peers.set(peerId, { contextToken: message.contextToken, clientId: message.clientId, at: Date.now() })
    const admin = this.adminPeerId()
    if (!admin && /^\s*绑定\s*$/.test(message.text)) {
      this.store.saveAdminPeer(peerId)
      this.log.info?.(`[wechat] 管理员绑定: ${peerId}`)
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
      await this.sendTo(peerId, `指令执行失败：${error?.message ?? error}`, signal).catch(() => {})
    }
  }

  async sendTo(peerId, text, signal = new AbortController().signal) {
    if (!this.transport) throw new Error('微信通道未连接')
    const peer = this.peers.get(peerId)
    if (!peer?.contextToken) throw new Error('尚无该联系人的会话凭证')
    for (const chunk of outboundChunks(text)) {
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
    try {
      this.store.enqueue(text)
    } catch (error) {
      this.log.warn?.(`[wechat] 推送入队失败: ${error?.message ?? error}`)
      return
    }
    if (this.phase === 'connected' && this.transport) {
      const signal = this.epoch?.abort?.signal ?? new AbortController().signal
      void this.flushOutbox(this.transport, signal).catch(error => {
        if (!isRetryable(error)) this.log.warn?.(`[wechat] 推送失败(不可重试): ${error?.message ?? error}`)
      })
    }
  }

  async flushOutbox(transport, signal) {
    const admin = this.adminPeerId()
    if (!admin) return
    const pending = this.store.pendingOutbox()
    for (const item of pending) {
      await this.sendTo(admin, item.text, signal)
      this.store.markSent([item.id])
    }
  }
}
