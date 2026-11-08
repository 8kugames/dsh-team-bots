import { outboundChunks, failureText, welcomeAdmin } from './format.js'
import { handleCommand, NON_OWNER_NOTICE } from './commands.js'

/** 出站最大尝试次数（含首次）：达到上限废弃，永不补发（与微信通道同治理口径）。 */
const OUTBOX_MAX_ATTEMPTS = 3
/** 合批窗口：窗口内到达的多条推送合并到同一次 flush（每条仍独立带幂等键发送）。 */
const OUTBOX_BATCH_WINDOW_MS = 1500
/** 已发送/已废弃出站记录保留 7 天。 */
const OUTBOX_RETENTION_DAYS = 7
/** 入站去重 LRU：TTL 10 分钟、上限 1000 条，重连不清空（对齐 cindy 口径）。 */
export const INBOUND_DEDUP_TTL_MS = 10 * 60 * 1000
export const INBOUND_DEDUP_LIMIT = 1000
/** 群聊非 owner @bot 的礼貌回应冷却：同一发送者 60s 至多一条，不起 turn。 */
export const NON_OWNER_COOLDOWN_MS = 60_000
/** 出站单条同幂等键的有界重试：超时/传输类不确定失败重发同键（飞书侧同键至多一条）。 */
const SEND_RETRY_MAX_ATTEMPTS = 2
const SEND_RETRY_DELAY_MS = 250
/** 退避/重试定时器一律 unref：通道重连节奏不得阻止宿主进程退出（与 flushTimer 同口径）。 */
const sleep = ms => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/** 飞书接口错误：code 为飞书业务错误码（无码=传输/本地失败，可重试）。 */
export class FeishuError extends Error {
  declare readonly code: number | undefined
  constructor(message, code = undefined) {
    super(message)
    this.name = 'FeishuError'
    this.code = code
  }
}

/**
 * gone 判定：飞书侧永久拒绝回复——目标消息已被撤回（230011 / withdrawn）或
 * 2300xx not found。只有带这些码的 FeishuError 才算 gone；本地超时/网络失败不算。
 */
export function isGone(error) {
  if (!(error instanceof FeishuError) || error.code === undefined) return false
  return error.code === 230011
    || /withdrawn/i.test(error.message)
    || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message))
}

/** 传输/执行类错误可重试；带飞书错误码的业务拒绝不可重试（重试也不会变对）。 */
export function isRetryable(error) {
  if (!error) return false
  if (error instanceof FeishuError) return error.code === undefined
  if (error?.permanent === true) return false
  if (error instanceof SyntaxError || error instanceof RangeError || error instanceof ReferenceError) return false
  return true
}

/** 飞书连接数冲突：1000040350=本应用事件已有别的消费者在长连接（SDK 报错文案带此码）。 */
export function isConnLimit(error) {
  if (error?.code === 1000040350) return true
  return /exceed[_\s-]?conn[_\s-]?limit|1000040350/i.test(String(error?.message ?? ''))
}

/** im.message.receive_v1 事件体的入站解析：SDK 回调为顶层 sender/message 字段。 */
export function parseInboundEvent(payload) {
  const message = payload?.message
  if (!message?.message_id) return null
  let text = ''
  if (message.message_type === 'text' && message.content) {
    try {
      text = String(JSON.parse(message.content)?.text ?? '')
    } catch {
      text = ''
    }
  }
  const senderOpenId = payload?.sender?.sender_id?.open_id
  return {
    messageId: String(message.message_id),
    chatId: message.chat_id ? String(message.chat_id) : null,
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    senderOpenId: senderOpenId ? String(senderOpenId) : null,
    rootId: message.root_id ? String(message.root_id) : null,
    text,
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
  }
}

/** lane 编码（对齐 cindy）：群= g/{chatId}[/{threadId}]（话题挂 root），p2p=发送者 open_id。 */
export function laneOf(parsed) {
  if (parsed?.chatType === 'group') {
    return `g/${parsed.chatId}${parsed.rootId ? `/${parsed.rootId}` : ''}`
  }
  return parsed?.senderOpenId ?? null
}

/** 剥掉群消息里的 @占位符（@_user_N），剩下的才是指令/正文。 */
export function stripMentionPlaceholders(text) {
  return String(text ?? '').replace(/@_user_\d+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 传输层接口：进程内官方 SDK 实现（见 createSdkTransport），测试全 stub。
 *  - botInfo(): 取机器人身份（appId/botId）。
 *  - reply(messageId, text, uuid): 回复一条消息，uuid 即幂等键。
 *  - startEvents({onEvent,onReady,onError}): 起长连接收事件。
 *  - stop(): 断开长连接。 */
export interface FeishuTransport {
  botInfo: () => Promise<{ appId?: string; botId: string; brand?: string }>
  reply: (messageId: string, text: string, uuid: string) => Promise<{ messageId?: string | null }>
  startEvents: (hooks: {
    onEvent: (payload: any) => void
    onReady?: () => void
    onError?: (error: unknown) => void
  }) => Promise<void> | void
  stop: () => Promise<void> | void
}

/** SDK 日志适配：把 SDK 内部日志转发到宿主 logger，并把 app secret 从日志里抹掉。 */
function sdkLogger(log: any, secret: string) {
  const emit = (level: string, args: any[]) => {
    let text = ''
    try {
      text = args.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')
    } catch {
      text = String(args?.[0] ?? '')
    }
    if (secret && text.includes(secret)) text = text.split(secret).join('***')
    log?.[level]?.(text)
  }
  return {
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    debug: (...args) => emit('debug', args),
    trace: (...args) => emit('trace', args),
  }
}

/** 出站载荷：含 markdown 记号走交互卡片（飞书卡片 markdown 元素原生渲染），纯文本走 text 消息。 */
function outboundPayload(text) {
  const body = String(text ?? '')
  if (/[*#`_]|\n\s*[-*]\s|\[[^\]]+\]\(/.test(body)) {
    const card = {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: body }],
    }
    return { msgType: 'interactive', content: JSON.stringify(card) }
  }
  return { msgType: 'text', content: JSON.stringify({ text: body }) }
}

/** SDK 抛出的错误归一：尽量取出飞书业务错误码（axios 响应体 code / 错误文案里的 code），
 *  便于 gone（230011/2300xx）与可重试判定按业务码分流。 */
export function toFeishuError(error) {
  if (error instanceof FeishuError) return error
  const raw = Number(
    error?.response?.data?.code
    ?? error?.code
    ?? /code[:=]\s*(\d+)/.exec(String(error?.message ?? ''))?.[1]
    ?? NaN,
  )
  const message = String(error?.response?.data?.msg ?? error?.msg ?? error?.message ?? error)
  return new FeishuError(message, Number.isFinite(raw) ? raw : undefined)
}

/**
 * 进程内官方 SDK 传输层（@larksuiteoapi/node-sdk）：
 *  - 入站：WSClient 长连接 + EventDispatcher 订阅 im.message.receive_v1
 *    （autoReconnect/ping 由 SDK 内建，token 由 SDK 自管，无外部二进制依赖）；
 *  - 出站：im.v1.message.reply，data.uuid 作幂等键（飞书侧同 uuid 至多一条）；
 *  - 身份：GET /open-apis/bot/v3/info 取 bot open_id。
 * SDK 缺席（依赖未安装）时抛错，由调用方降级为 unbound。
 */
export async function createSdkTransport({ appId, appSecret, log = console as unknown as DshLogger }): Promise<FeishuTransport> {
  const lark: any = await import('@larksuiteoapi/node-sdk')
  const logger = sdkLogger(log, appSecret)
  const client = new lark.Client({ appId, appSecret, logger, loggerLevel: lark.LoggerLevel.warn })
  let wsClient: any = null
  return {
    async botInfo() {
      let res: any
      try {
        res = await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
      } catch (error) {
        throw toFeishuError(error)
      }
      const code = Number(res?.code ?? 0)
      if (code !== 0) throw new FeishuError(res?.msg || `bot/v3/info 返回错误码 ${code}`, code)
      const botId = res?.bot?.open_id
      if (!botId) throw new FeishuError('bot/v3/info 未返回 open_id（feishuNoBot）')
      return { appId: String(res?.bot?.app_id ?? appId), botId: String(botId), brand: 'feishu' }
    },
    async reply(messageId, text, uuid) {
      const { msgType, content } = outboundPayload(text)
      let res: any
      try {
        res = await client.im.v1.message.reply({
          path: { message_id: String(messageId) },
          data: { content, msg_type: msgType, uuid: String(uuid) },
        })
      } catch (error) {
        throw toFeishuError(error)
      }
      const code = Number(res?.code ?? 0)
      if (code !== 0) throw new FeishuError(res?.msg || `飞书回复失败（错误码 ${code}）`, code)
      return { messageId: res?.data?.message_id ?? null }
    },
    async startEvents({ onEvent, onReady, onError }) {
      const dispatcher = new lark.EventDispatcher({ logger, loggerLevel: lark.LoggerLevel.warn })
      dispatcher.register({
        'im.message.receive_v1': async (data: any) => {
          onEvent(data)
        },
      })
      wsClient = new lark.WSClient({
        appId,
        appSecret,
        logger,
        loggerLevel: lark.LoggerLevel.warn,
        onReady: () => onReady?.(),
        onReconnected: () => onReady?.(),
        onError: (error: unknown) => onError?.(error),
      })
      await wsClient.start({ eventDispatcher: dispatcher })
    },
    stop() {
      try {
        wsClient?.close?.()
      } catch {
        // 关闭失败不影响进程退出
      }
      wsClient = null
    },
  }
}

/**
 * 飞书机器人通道宿主（DSHBOTS-333：传输层换进程内官方 SDK）。
 * 架构：传输层=进程内 @larksuiteoapi/node-sdk（WSClient 长连接收事件 +
 * im.v1.message.reply 出站，uuid 幂等），入站模型（LRU 去重/TOFU 认主/群@门禁/
 * lane 编码/generation 门禁）与传输无关，原样保留。
 * 凭据：AppID/Secret 由配置注入（cordis.patch.yml 或 env），secret 不落库不进日志。
 */
export class FeishuChannel {
  constructor({ store, config, log: logger = console as unknown as DshLogger, batchWindowMs = OUTBOX_BATCH_WINDOW_MS, transport = null }) {
    this.store = store
    this.config = config
    this.log = logger
    this.service = null
    this.phase = 'disabled'
    this.error = null
    /** 传输层（测试注入桩）；缺省按凭据创建进程内 SDK 传输。 */
    this.transport = transport
    this.batchWindowMs = batchWindowMs
    this.flushTimer = null
    /** flushOutbox 串行化链：并发 flush 会重复读取同一批 pending 造成重复发送。 */
    this.flushChain = Promise.resolve()
    /** 入站去重 LRU（重连不清空）与连接 generation 门禁。 */
    this.inboundSeen = new Map()
    this.consumeGeneration = 0
    this.consumeAbort = new AbortController()
    /** 群聊非 owner @bot 礼貌回应的冷却表（发送者 open_id → 上次回应时间）。 */
    this.politeAt = new Map()
    /** 同幂等键发送调用计数（send 层重试与 outbox 层重试共享 3 次总预算）。 */
    this.sendAttempts = new Map()
  }

  setService(service) {
    this.service = service
  }

  enabled() {
    return Boolean(this.config.feishu?.enabled)
  }

  /**
   * 启动：凭据齐备即连（开关+凭据=开箱即用）——先用 bot/v3/info 自检身份，
   * 再起 WSClient 长连接。任一步失败：phase='unbound' + error 留痕，绝不抛出。
   */
  async start() {
    if (!this.enabled()) return
    this.store.purgeSentOutbox?.(OUTBOX_RETENTION_DAYS)
    const appId = String(this.config.feishu?.appId ?? '').trim()
    const appSecret = String(this.config.feishu?.appSecret ?? '').trim()
    if (!appId || !appSecret) {
      this.phase = 'unbound'
      this.error = '未配置飞书应用凭据（feishuAppId / feishuAppSecret）'
      this.log.warn?.(`[feishu] ${this.error}`)
      return
    }
    try {
      const transport = this.transport ?? await createSdkTransport({ appId, appSecret, log: this.log })
      this.transport = transport
      const bot = await transport.botInfo()
      this.store.saveBot({ appId: bot.appId || appId, botId: bot.botId, brand: bot.brand ?? 'feishu' })
      // 重新绑定完成：此前的待发堆积一律作废不补发（与微信通道同治理口径）
      const voided = this.store.giveUpAllPending?.() ?? 0
      if (voided > 0) this.log.info?.(`[feishu] 绑定完成，作废此前待发堆积 ${voided} 条（不补发）`)
      this.phase = 'ready'
      this.error = null
      this.log.info?.(`[feishu] 绑定完成 app=${bot.appId ?? appId} bot=${bot.botId}`)
      await transport.startEvents({
        onEvent: payload => this.onEvent(payload),
        onReady: () => {
          // 每次（重）连接就绪即换代 generation：旧连接轮次里未完成的事件整体丢弃
          this.consumeGeneration += 1
          if (this.phase !== 'conflict') {
            this.phase = 'ready'
            this.error = null
          }
          this.log.info?.('[feishu] 长连接已就绪')
        },
        onError: error => this.onTransportError(error),
      })
    } catch (error) {
      this.phase = 'unbound'
      this.error = this.errorText(error)
      this.log.warn?.(`[feishu] 绑定失败，通道未绑定（不 crash）: ${this.error}`)
    }
  }

  /** 长连接异常：连接数冲突（1000040350）是确定性冲突，置 conflict；其余按重连中处理。 */
  onTransportError(error) {
    if (isConnLimit(error)) {
      this.phase = 'conflict'
      this.error = 'exceed_conn_limit（1000040350）：已有其他实例在消费本应用事件'
      this.log.warn?.(`[feishu] ${this.error}`)
      return
    }
    this.phase = 'reconnecting'
    this.error = this.errorText(error)
    this.log.warn?.(`[feishu] 长连接异常：${this.error}`)
  }

  async stop() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.consumeAbort?.abort()
    try {
      await this.transport?.stop?.()
    } catch (error) {
      this.log.warn?.(`[feishu] 传输层关闭失败: ${this.errorText(error)}`)
    }
  }

  status() {
    const state = this.store.getState()
    return {
      phase: this.phase,
      enabled: this.enabled(),
      error: this.error,
      appId: state?.app_id ?? null,
      botId: state?.bot_id ?? null,
      brand: state?.brand ?? null,
      adminOuId: state?.admin_ou_id ?? null,
    }
  }

  /**
   * 出站底层原语：回复目标消息所在话题。飞书同一 uuid 至多产生一条回复，
   * uuid 即 outbox 行 id——重试/进程重启后重复发送也不会在飞书侧重复落消息。
   * 超时/传输类不确定失败：同 uuid 有界重试（1 次），飞书侧幂等命中时从响应取回
   * 原 message_id，既不双发也不丢发。多块文本第 2 块起 uuid 尾加 `#序号`
   * （同 uuid 多块会被飞书幂等吞掉，块间必须可区分）。
   * gone（目标消息已撤回/不存在）返回 'gone'，其余失败抛出由调用方记账。
   */
  async sendFeishu(messageId, text, idempotencyKey) {
    if (!messageId) throw new Error('缺少飞书回复目标消息 id')
    if (!idempotencyKey) throw new Error('缺少幂等键（应为 outbox 行 id）')
    const chunks = outboundChunks(text)
    for (let index = 0; index < chunks.length; index++) {
      const key = index > 0 ? `${idempotencyKey}#${index}` : idempotencyKey
      for (let attempt = 1; ; attempt++) {
        // 同键发送总预算 = OUTBOX_MAX_ATTEMPTS（与 outbox 尝试计数同一口径）：
        // send 层重试与 flush 层重试共享预算，总调用数恒 ≤ 3，不放大消息额度。
        const used = Number(this.sendAttempts.get(key) ?? 0)
        if (used >= OUTBOX_MAX_ATTEMPTS) throw new Error(`同键 ${key} 发送尝试已达上限（${OUTBOX_MAX_ATTEMPTS}）`)
        this.sendAttempts.set(key, used + 1)
        if (this.sendAttempts.size > INBOUND_DEDUP_LIMIT) this.sendAttempts.delete(this.sendAttempts.keys().next().value)
        try {
          const result = await this.transport.reply(String(messageId), chunks[index], key)
          this.sendAttempts.delete(key)
          if (attempt > 1) {
            const recovered = result?.messageId
            this.log.info?.(`[feishu] 同键重试发送成功${recovered ? `，取回原消息 ${recovered}` : ''}`)
          }
          break
        } catch (error) {
          if (isGone(error)) {
            this.sendAttempts.delete(key)
            return 'gone'
          }
          const budgetLeft = Number(this.sendAttempts.get(key) ?? 0) < OUTBOX_MAX_ATTEMPTS
          if (!isRetryable(error) || attempt >= SEND_RETRY_MAX_ATTEMPTS || !budgetLeft) throw error
          await sleep(SEND_RETRY_DELAY_MS)
        }
      }
    }
    return 'sent'
  }

  /**
   * 对外事件推送入口：入队（receiptKey 幂等吸收）后经合批窗口合并一次 flush；
   * 未绑定时仅落盘，绑定后由新事件触发。与微信 notify 同形。
   */
  notify(text, { receiptKey = null } = {}) {
    if (!this.enabled()) return
    const body = String(text ?? '').trim()
    if (!body) {
      this.log.warn?.('[feishu] 空文本不入队')
      return
    }
    try {
      const outcome = this.store.enqueue(body, receiptKey)
      if (outcome === 'duplicate') {
        this.log.warn?.(`[feishu] 重复推送已按收据键吸收（${receiptKey}）`)
        return
      }
    } catch (error) {
      this.log.warn?.(`[feishu] 推送入队失败: ${this.errorText(error)}`)
      return
    }
    if (this.phase === 'ready') this.scheduleOutboxFlush()
  }

  /** 合批窗口：窗口内的多次推送合并到同一次 flush（每条仍独立幂等发送）。 */
  scheduleOutboxFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.phase !== 'ready') return
      void this.flushOutbox().catch(error => {
        this.log.warn?.(`[feishu] 推送刷新失败: ${this.errorText(error)}`)
      })
    }, this.batchWindowMs)
    this.flushTimer.unref?.()
  }

  /** 刷出全部待发：串行化（防并发重复发送）；每条独立发送，幂等键=outbox 行 id。 */
  async flushOutbox(signal = new AbortController().signal) {
    const previous = this.flushChain
    let release
    this.flushChain = new Promise(resolve => {
      release = resolve
    })
    await previous.catch(() => {})
    try {
      return await this.flushOutboxLocked(signal)
    } finally {
      release()
    }
  }

  async flushOutboxLocked(signal) {
    const target = this.store.getState()?.reply_message_id
    // 尚无回复目标（管理员未发过消息）：可恢复状态，条目保留待发，绑定后由新事件触发
    if (!target) return
    const pending = this.store.pendingOutbox()
    for (const item of pending) {
      if (signal?.aborted) return
      try {
        const outcome = await this.sendFeishu(target, item.text, String(item.id))
        if (outcome === 'sent') this.store.markSent([item.id])
        else this.store.giveUp([item.id], 'gone')
      } catch (error) {
        if (signal?.aborted) return
        this.recordOutboxFailure(item, error)
      }
    }
  }

  /** 失败记账：可重试错误计一次尝试，达到上限（3 次）废弃；不可重试错误直接废弃。废弃后永不补发。 */
  recordOutboxFailure(item, error) {
    const retryable = isRetryable(error)
    const reason = this.errorText(error)
    const attempts = retryable ? this.store.markAttempt(item.id, reason) : null
    if (!retryable || (attempts ?? 0) >= OUTBOX_MAX_ATTEMPTS) {
      this.store.giveUp([item.id], reason)
      this.log.warn?.(
        `[feishu] 推送废弃(不再补发) id=${item.id}${retryable ? `(尝试 ${attempts}/${OUTBOX_MAX_ATTEMPTS} 次超限)` : '(不可重试)'}: ${reason}`,
      )
      return
    }
    this.log.warn?.(
      `[feishu] 推送失败(可重试 ${attempts}/${OUTBOX_MAX_ATTEMPTS}，保留待发) id=${item.id}: ${reason}`,
    )
  }

  /** 长连接收到事件：按当前 generation 打标后交给入站模型处理。 */
  onEvent(payload) {
    const generation = this.consumeGeneration
    void this.handleEvent(payload, generation, this.consumeAbort.signal).catch(error => {
      this.log.warn?.(`[feishu] 事件处理异常: ${this.errorText(error)}`)
    })
  }

  /** JSON 行事件入口（守门与日志回放用）：解析后走 SDK 形状的入站模型。 */
  async handleEventLine(line, generation, signal = new AbortController().signal) {
    let payload = null
    try {
      payload = JSON.parse(String(line ?? ''))
    } catch {
      return
    }
    await this.handleEvent(payload, generation, signal)
  }

  /** 单事件入口：解析 → (appId, message_id) LRU 去重 → 会话门禁分发。 */
  async handleEvent(payload, generation, signal = new AbortController().signal) {
    const parsed = parseInboundEvent(payload)
    if (!parsed?.messageId || !parsed.text) {
      this.recordTrigger(parsed, 'filtered', 'no-text')
      return
    }
    const appId = this.store.getState()?.app_id ?? 'unknown'
    if (this.seenInbound(`${appId}:${parsed.messageId}`)) {
      this.recordTrigger(parsed, 'duplicate', 'lru')
      return
    }
    await this.dispatchInbound(parsed, generation, signal)
  }

  /**
   * 入站 LRU 去重闸（对齐 cindy）：键 (appId, message_id)，TTL 10 分钟、上限 1000 条、
   * 重连不清空（飞书事件可能重投）。命中返回 true；未命中记录后返回 false。
   */
  seenInbound(key) {
    const now = Date.now()
    const seen = this.inboundSeen.get(key)
    if (seen !== undefined) {
      if (now - seen < INBOUND_DEDUP_TTL_MS) {
        this.inboundSeen.delete(key)
        this.inboundSeen.set(key, seen)
        return true
      }
      this.inboundSeen.delete(key)
    }
    this.inboundSeen.set(key, now)
    if (this.inboundSeen.size > INBOUND_DEDUP_LIMIT) {
      this.inboundSeen.delete(this.inboundSeen.keys().next().value)
    }
    return false
  }

  /**
   * 会话门禁分发（对齐 cindy TOFU/群@门禁）：
   * - p2p：无 owner 时首名发送者 TOFU 成 owner（按 bot-app 持久化）；非 owner 私聊丢弃留痕；
   * - 群聊绝不 TOFU：必须 @本 bot——非 owner @bot 走 60s 冷却礼貌回应（不起 turn），
   *   owner @bot 剥占位符后正常起 turn。
   */
  async dispatchInbound(parsed, generation, signal) {
    const state = this.store.getState()
    const adminOu = state?.admin_ou_id ?? null
    const botId = state?.bot_id ?? null
    const stale = () => Boolean(signal?.aborted) || generation !== this.consumeGeneration

    if (parsed.chatType === 'group') {
      const mentioned = Boolean(botId) && parsed.mentions.some(item => String(item?.id?.open_id ?? '') === String(botId))
      if (!mentioned) {
        this.recordTrigger(parsed, 'filtered', 'no-mention', '群聊未 @本 bot')
        return
      }
      const text = stripMentionPlaceholders(parsed.text)
      if (!text) {
        this.recordTrigger(parsed, 'filtered', 'mention-only')
        return
      }
      if (!adminOu || parsed.senderOpenId !== adminOu) {
        const last = Number(this.politeAt.get(parsed.senderOpenId) ?? 0)
        if (Date.now() - last < NON_OWNER_COOLDOWN_MS) {
          this.recordTrigger(parsed, 'filtered', 'cooldown', '非 owner @bot 冷却中')
          return
        }
        this.politeAt.set(parsed.senderOpenId, Date.now())
        this.recordTrigger(parsed, 'handled', 'polite')
        try {
          await this.sendFeishu(parsed.messageId, NON_OWNER_NOTICE, `polite:${parsed.messageId}`)
        } catch (error) {
          this.log.warn?.(`[feishu] 礼貌回应发送失败: ${this.errorText(error)}`)
        }
        return
      }
      await this.adminTurn(parsed, text, generation, signal, stale)
      return
    }

    // p2p：TOFU 认主只认首个私聊者
    if (!parsed.senderOpenId) {
      this.recordTrigger(parsed, 'filtered', 'no-sender')
      return
    }
    if (!adminOu) {
      this.store.saveAdminOu(parsed.senderOpenId)
      this.store.saveReplyMessageId(parsed.messageId, parsed.senderOpenId)
      this.log.info?.(`[feishu] 管理员已绑定（TOFU 首个私聊者）: ${parsed.senderOpenId}`)
      this.recordTrigger(parsed, 'handled', 'tofu')
      try {
        await this.sendFeishu(parsed.messageId, welcomeAdmin(), `welcome:${parsed.messageId}`)
      } catch (error) {
        this.log.warn?.(`[feishu] 欢迎语发送失败: ${this.errorText(error)}`)
      }
      return
    }
    if (parsed.senderOpenId !== adminOu) {
      this.log.info?.(`[feishu] 忽略非管理员私聊来自 ${parsed.senderOpenId}`)
      this.recordTrigger(parsed, 'filtered', 'non-admin', '发送者不是已绑定管理员')
      return
    }
    await this.adminTurn(parsed, parsed.text, generation, signal, stale)
  }

  /**
   * owner/admin 消息起 turn：复用微信通道无关命令层（/指令 + 答/批 token + 自由文本
   * 直达 director），回复经 reply 锚点挂回触发消息。事件处理中的每个 await 之后复查
   * generation：旧连接轮次整体丢弃（双连接防重）。
   */
  async adminTurn(parsed, text, generation, signal, stale) {
    const ctx = {
      boundKey: null,
      bind: () => {},
      // 上方已过 owner/admin 门，显式带过命令层的 fail-closed 管理员门
      isAdmin: true,
    }
    let reply = ''
    try {
      reply = await handleCommand(this.service, text, ctx)
    } catch (caught) {
      const error = caught as any
      const business = error?.permanent === true || error?.name === 'WechatBusinessError' || error?.name === 'AppError'
      this.recordTrigger(parsed, business ? 'rejected' : 'failed', 'command', this.errorText(error))
      reply = business ? String(error?.message ?? '指令无法执行') : failureText()
    }
    if (stale()) {
      this.recordTrigger(parsed, 'dropped', 'stale-generation', '事件处理中连接换代，旧轮次整体丢弃')
      return
    }
    const trigger = (ctx as any).trigger ?? { kind: 'chat', verb: null }
    this.recordTrigger(parsed, 'handled', `${trigger.kind}${trigger.verb ? `:${trigger.verb}` : ''}`)
    // 回复锚点：管理员/owner 最近一条触发消息（后续出站 notify 也挂到这里）
    this.store.saveReplyMessageId(parsed.messageId, parsed.senderOpenId)
    if (reply) {
      try {
        await this.sendFeishu(parsed.messageId, reply, `reply:${parsed.messageId}`)
      } catch (error) {
        this.log.warn?.(`[feishu] 回复发送失败: ${this.errorText(error)}`)
      }
    }
  }

  /**
   * 入站 Trigger 留痕（对齐微信 B4-① 观测面）：每条入站事件的处置经
   * service.recordFeishuTrigger 落库，稳定 id=feishu:<messageId>（channel='feishu'），
   * peer_id 记 lane 编码。service 不在场（测试桩）时静默跳过。
   */
  recordTrigger(parsed, disposition, route, reason = null) {
    try {
      this.service?.recordFeishuTrigger?.({
        nativeId: parsed?.messageId ?? null,
        senderId: laneOf(parsed),
        text: parsed?.text ?? '',
        disposition,
        route,
        reason,
      })
    } catch (error) {
      this.log.warn?.(`[feishu] 触发留痕失败: ${this.errorText(error)}`)
    }
  }

  errorText(error) {
    if (error instanceof FeishuError) return error.code !== undefined ? `飞书 ${error.code}: ${error.message}` : `飞书: ${error.message}`
    return String(error?.message ?? error)
  }
}
