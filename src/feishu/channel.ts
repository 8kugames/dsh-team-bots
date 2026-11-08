import { spawn } from 'node:child_process'
import { outboundChunks, failureText, welcomeAdmin } from './format.js'
import { handleCommand, NON_OWNER_NOTICE } from './commands.js'

/** 出站最大尝试次数（含首次）：达到上限废弃，永不补发（与微信通道同治理口径）。 */
const OUTBOX_MAX_ATTEMPTS = 3
/** 合批窗口：窗口内到达的多条推送合并到同一次 flush（每条仍独立带幂等键发送）。 */
const OUTBOX_BATCH_WINDOW_MS = 1500
/** 已发送/已废弃出站记录保留 7 天。 */
const OUTBOX_RETENTION_DAYS = 7
/** 入站事件消费断线退避（卡②接线用）：1s 起指数退避，上限 60s（参考实现同款）。 */
export const CONSUME_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]
/** 入站事件就绪信号等待上限：45s 内 stderr 未出现 `[event] ready` 即杀进程（卡②用）。 */
export const CONSUME_READY_TIMEOUT_MS = 45_000
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

/** lark-cli 失败：code 为飞书业务错误码（非零退出且能从输出解析出码时携带），无码=本地执行失败。 */
export class CliError extends Error {
  declare readonly code: number | undefined
  constructor(message, code = undefined) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

/**
 * gone 判定（参照 dsh-superagent-prototype 同款）：飞书侧永久拒绝回复——目标消息
 * 已被撤回（230011 / withdrawn）或 2300xx not found。只有带这些码的 CliError 才算
 * gone；本地超时/崩溃不算。
 */
export function isGone(error) {
  if (!(error instanceof CliError) || error.code === undefined) return false
  return error.code === 230011
    || /withdrawn/i.test(error.message)
    || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message))
}

/** 传输/执行类错误可重试；带飞书错误码的业务拒绝不可重试（重试也不会变对）。 */
export function isRetryable(error) {
  if (!error) return false
  if (error instanceof CliError) return error.code === undefined
  if (error?.permanent === true) return false
  if (error instanceof SyntaxError || error instanceof RangeError || error instanceof ReferenceError) return false
  return true
}

/** 从 lark-cli 输出里尽力解析飞书错误码（如 "code": 230011 或裸 230011）。 */
function parseCliCode(output) {
  const json = /"code"\s*:\s*(\d+)/.exec(output)?.[1]
  if (json) return Number(json)
  const bare = /\b(23\d{4})\b/.exec(output)?.[1]
  return bare ? Number(bare) : undefined
}

/** 从 messages-reply 输出里取回消息 id（同键幂等重试时即原消息 id）。 */
function parseReplyMessageId(output) {
  return /"message_id"\s*:\s*"([^"]+)"/.exec(String(output ?? ''))?.[1] ?? null
}

/** 飞书连接数冲突（对齐 cindy exceed_conn_limit）：1000040350=本应用事件已有别的消费者在长连接。 */
export function isConnLimit(error) {
  if (!(error instanceof CliError)) return false
  return error.code === 1000040350 || /exceed[_\s-]?conn[_\s-]?limit/i.test(error.message)
}

/**
 * 默认入站事件消费原语：spawn `lark event consume im.message.receive_v1 --as bot`
 * 长连接子进程——stdout 按行回抛 JSON 事件（onEvent）、stderr 出现 `[event] ready`
 * 回调 onReady、readyTimeoutMs 内未见 ready 即杀进程判超时；进程退出/失败经返回的
 * Promise 结算（测试注入桩同形）。
 */
function spawnConsumeViaCli(cliPath) {
  return ({ onEvent, onReady, signal, readyTimeoutMs }) => new Promise((resolve, reject) => {
    const child = spawn(cliPath, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      },
    })
    let ready = false
    let settled = false
    let buffer = ''
    let stderr = ''
    const settle = finish => {
      if (settled) return
      settled = true
      clearTimeout(readyTimer)
      finish()
    }
    const readyTimer = setTimeout(() => {
      child.kill()
      settle(() => reject(new CliError(`事件消费 ${readyTimeoutMs}ms 内未见 [event] ready`, undefined)))
    }, readyTimeoutMs)
    readyTimer.unref?.()
    child.stdout.on('data', chunk => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) onEvent(line)
        newline = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${chunk}`.slice(-4000)
      if (!ready && String(chunk).includes('[event] ready')) {
        ready = true
        clearTimeout(readyTimer)
        onReady?.()
      }
    })
    child.once('error', error => settle(() => reject(error)))
    child.once('close', code => {
      if (signal?.aborted) return settle(() => resolve('aborted'))
      settle(() => {
        if (ready) resolve(`exit ${code}`)
        else reject(new CliError(stderr.trim() || `lark-cli 退出码 ${code}`, parseCliCode(stderr)))
      })
    })
    signal?.addEventListener('abort', () => child.kill(), { once: true })
  })
}

/** im.message.receive_v1 事件体的入站解析（schema 2.0）：未成形事件返回 null。 */
export function parseInboundEvent(payload) {
  const message = payload?.event?.message
  if (!message?.message_id) return null
  let text = ''
  if (message.message_type === 'text' && message.content) {
    try {
      text = String(JSON.parse(message.content)?.text ?? '')
    } catch {
      text = ''
    }
  }
  const senderOpenId = payload?.event?.sender?.sender_id?.open_id
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

/** 默认 lark 执行原语：spawn 配置的 cli，静默更新/技能提示；非零退出抛 CliError。 */
function spawnLark(cliPath) {
  return args => new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve(stdout)
      else reject(new CliError(stderr.trim() || `lark-cli 退出码 ${code}`, parseCliCode(`${stderr}\n${stdout}`)))
    })
  })
}

/** 从 `auth status` 输出取第一个 JSON 对象（输出可能带人类可读前缀）。 */
function parseAuthStatus(text) {
  const start = String(text ?? '').indexOf('{')
  if (start < 0) return null
  try {
    const parsed = JSON.parse(String(text).slice(start))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 飞书机器人通道宿主（DSHBOTS-323 卡①：骨架 + 凭据自检 + 出站发送）。
 * 架构：不直连飞书 SDK，全部经 lark-cli 子进程——
 *  - 出站：`lark im +messages-reply --message-id <id> --markdown <text>
 *    --idempotency-key <outbox 行 id>`（幂等键=件箱行 id，飞书侧同键至多一条回复）；
 *  - 自检：auth status（bot ready）→ config strict-mode（=bot）→
 *    api GET /open-apis/bot/v3/info（取 botId），任一步失败进 phase='unbound' 不 crash；
 *  - 凭据：app secret 存 lark-cli 自己的 keychain（LARKSUITE_CLI_CONFIG_DIR），
 *    本插件只持久化 cli 路径/botId/appId，secret 不进库不进 env。
 * 入站事件消费（spawn `lark event consume im.message.receive_v1 --as bot`）是卡②范围，
 * 本卡只留 consumeLoop 接口占位。
 */
export class FeishuChannel {
  constructor({ store, config, log: logger = console as unknown as DshLogger, batchWindowMs = OUTBOX_BATCH_WINDOW_MS, runLark = null, spawnConsume = null }) {
    this.store = store
    this.config = config
    this.log = logger
    this.service = null
    this.phase = 'disabled'
    this.error = null
    /** lark 执行原语（测试注入桩）；缺省按配置的 cli 路径 spawn。 */
    this.runLark = runLark ?? spawnLark(String(config.feishu?.cliPath ?? ''))
    /** 入站事件消费原语（测试注入桩）；缺省 spawn lark event consume 长连接。 */
    this.spawnConsume = spawnConsume ?? spawnConsumeViaCli(String(config.feishu?.cliPath ?? ''))
    this.batchWindowMs = batchWindowMs
    this.flushTimer = null
    /** flushOutbox 串行化链：并发 flush 会重复读取同一批 pending 造成重复发送。 */
    this.flushChain = Promise.resolve()
    /** 入站去重 LRU（重连不清空）与连接 generation 门禁。 */
    this.inboundSeen = new Map()
    this.consumeGeneration = 0
    this.consumeLoopActive = false
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
   * 启动自检序列（抄参考实现 resolveFeishuBot）：auth status → bot ready →
   * strict-mode=bot → GET /open-apis/bot/v3/info 取 botId。
   * 任一步失败：phase='unbound' + error 留痕，绝不抛出（通道坏不拖垮工作台）。
   */
  async start() {
    if (!this.enabled()) return
    this.store.purgeSentOutbox?.(OUTBOX_RETENTION_DAYS)
    const cli = String(this.config.feishu?.cliPath ?? '').trim()
    if (!cli) {
      this.phase = 'unbound'
      this.error = '未配置 lark-cli 路径（DSH_BOTS_FEISHU_CLI）'
      this.log.warn?.(`[feishu] ${this.error}`)
      return
    }
    try {
      const bot = await this.selfCheck(cli)
      this.store.saveBot(bot)
      // 重新绑定完成：此前的待发堆积一律作废不补发（与微信通道同治理口径）
      const voided = this.store.giveUpAllPending?.() ?? 0
      if (voided > 0) this.log.info?.(`[feishu] 绑定完成，作废此前待发堆积 ${voided} 条（不补发）`)
      this.phase = 'ready'
      this.error = null
      this.log.info?.(`[feishu] 自检通过 app=${bot.appId} brand=${bot.brand} bot=${bot.botId}`)
      // 卡②：绑定即开始入站事件消费（后台循环，断线自退避重连；冲突信号停循环）
      this.consumeAbort = new AbortController()
      void this.consumeLoop(this.consumeAbort.signal).catch(error => {
        this.log.warn?.(`[feishu] 事件消费循环退出: ${this.errorText(error)}`)
      })
    } catch (error) {
      this.phase = 'unbound'
      this.error = this.errorText(error)
      this.log.warn?.(`[feishu] 自检失败，通道未绑定（不 crash）: ${this.error}`)
    }
  }

  /** 自检四步；全部通过返回 bot 绑定信息（cliPath/botId/appId/brand）。 */
  async selfCheck(cli) {
    const authText = await this.runLark(['auth', 'status'])
    const status = parseAuthStatus(authText)
    if (!status?.appId) throw new Error('auth status 未返回 app 信息（feishuNoApp）')
    if (status.identities?.bot?.status !== 'ready') {
      throw new Error(`bot 身份未就绪（${status.identities?.bot?.status ?? 'unknown'}）`)
    }
    const modeText = await this.runLark(['config', 'strict-mode'])
    const mode = /strict-mode:\s*(\w+)/.exec(String(modeText ?? ''))?.[1]
    if (mode !== 'bot') throw new Error(`strict-mode 非 bot（${mode ?? 'unknown'}），禁止用户身份 CLI 出站`)
    const infoText = await this.runLark(['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson'])
    let info = null
    try {
      info = JSON.parse(String(infoText ?? '').split('\n')[0] || '{}')
    } catch {
      info = null
    }
    if (!info?.bot?.open_id) throw new Error('bot/v3/info 未返回 open_id（feishuNoBot）')
    return { cliPath: cli, appId: String(status.appId), brand: String(status.brand ?? 'feishu'), botId: String(info.bot.open_id) }
  }

  async stop() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.consumeAbort?.abort()
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
   * 出站底层原语：回复目标消息所在话题。飞书同一 idempotency-key 至多产生一条回复，
   * 键即 outbox 行 id——CLI 重试/进程重启后重复发送也不会在飞书侧重复落消息。
   * 超时/传输类不确定失败（卡②对齐 cindy 增量）：同键有界重试（1 次），飞书侧同键
   * 幂等命中时从响应取回原 message_id，既不双发也不丢发。多块文本第 2 块起键尾加
   * `#序号`（同键多块会被飞书幂等吞掉，块间必须可区分）。
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
          const output = await this.runLark([
            'im', '+messages-reply',
            '--message-id', String(messageId),
            '--markdown', chunks[index],
            '--idempotency-key', key,
          ])
          this.sendAttempts.delete(key)
          if (attempt > 1) {
            const recovered = parseReplyMessageId(output)
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

  /**
   * 入站事件消费循环（卡②）：spawn `lark event consume im.message.receive_v1 --as bot`
   * 长连接——ready 信号=stderr `[event] ready`（45s 超时杀进程）、stdout 按行 JSON 事件、
   * 断线按 CONSUME_RETRY_DELAYS_MS 指数退避重连。每次重连 bump generation：旧连接
   * 轮次里尚未完成的事件处理整体丢弃（防双连接重复起 turn）。exceed_conn_limit
   * （1000040350）是确定性冲突（别的实例占用长连接），重试无意义：置 phase='conflict'
   * 广播并停循环。
   */
  async consumeLoop(signal = new AbortController().signal) {
    if (this.consumeLoopActive) return
    this.consumeLoopActive = true
    let failures = 0
    try {
      while (!signal.aborted) {
        const generation = (this.consumeGeneration += 1)
        try {
          const outcome = await this.spawnConsume({
            onEvent: line => {
              void this.handleEventLine(line, generation, signal).catch(error => {
                this.log.warn?.(`[feishu] 事件处理异常: ${this.errorText(error)}`)
              })
            },
            onReady: () => {
              if (generation === this.consumeGeneration) {
                this.phase = 'ready'
                this.error = null
                this.log.info?.('[feishu] 事件消费连接已就绪')
              }
            },
            signal,
            readyTimeoutMs: CONSUME_READY_TIMEOUT_MS,
          })
          if (signal.aborted) return
          failures += 1
          this.log.warn?.(`[feishu] 事件消费连接退出（${outcome}），按退避重连`)
        } catch (error) {
          if (signal.aborted) return
          if (isConnLimit(error)) {
            this.phase = 'conflict'
            this.error = 'exceed_conn_limit（1000040350）：已有其他实例在消费本应用事件'
            this.log.warn?.(`[feishu] ${this.error}，停消费循环`)
            return
          }
          failures += 1
          this.log.warn?.(`[feishu] 事件消费失败(${failures})，按退避重连: ${this.errorText(error)}`)
        }
        if (failures > 1) this.phase = 'reconnecting'
        await sleep(CONSUME_RETRY_DELAYS_MS[Math.min(failures - 1, CONSUME_RETRY_DELAYS_MS.length - 1)])
      }
    } finally {
      this.consumeLoopActive = false
    }
  }

  /** 单行 JSON 事件入口：解析 → (appId, message_id) LRU 去重 → 会话门禁分发。 */
  async handleEventLine(line, generation, signal = new AbortController().signal) {
    let payload = null
    try {
      payload = JSON.parse(String(line ?? ''))
    } catch {
      return
    }
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
    if (error instanceof CliError) return error.code !== undefined ? `cli ${error.code}: ${error.message}` : `cli: ${error.message}`
    return String(error?.message ?? error)
  }
}
