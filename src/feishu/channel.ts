import { spawn } from 'node:child_process'
import { outboundChunks } from './format.js'

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
  constructor({ store, config, log: logger = console as unknown as DshLogger, batchWindowMs = OUTBOX_BATCH_WINDOW_MS, runLark = null }) {
    this.store = store
    this.config = config
    this.log = logger
    this.service = null
    this.phase = 'disabled'
    this.error = null
    /** lark 执行原语（测试注入桩）；缺省按配置的 cli 路径 spawn。 */
    this.runLark = runLark ?? spawnLark(String(config.feishu?.cliPath ?? ''))
    this.batchWindowMs = batchWindowMs
    this.flushTimer = null
    /** flushOutbox 串行化链：并发 flush 会重复读取同一批 pending 造成重复发送。 */
    this.flushChain = Promise.resolve()
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
   * gone（目标消息已撤回/不存在）返回 'gone'，其余失败抛出由调用方记账。
   */
  async sendFeishu(messageId, text, idempotencyKey) {
    if (!messageId) throw new Error('缺少飞书回复目标消息 id')
    if (!idempotencyKey) throw new Error('缺少幂等键（应为 outbox 行 id）')
    for (const chunk of outboundChunks(text)) {
      try {
        await this.runLark([
          'im', '+messages-reply',
          '--message-id', String(messageId),
          '--markdown', chunk,
          '--idempotency-key', String(idempotencyKey),
        ])
      } catch (error) {
        if (isGone(error)) return 'gone'
        throw error
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
   * 入站事件消费循环（卡②范围，本卡接口占位不实现）：
   * 计划形态=spawn `lark event consume im.message.receive_v1 --as bot`，
   * stdout 按行 JSON 事件、ready 信号=stderr `[event] ready`、45s 超时杀进程、
   * 断线按 CONSUME_RETRY_DELAYS_MS 指数退避。
   */
  async consumeLoop(_signal = new AbortController().signal) {
    this.log.info?.('[feishu] 入站事件消费尚未接线（DSHBOTS 卡②范围），本卡只留接口占位')
    return undefined
  }

  errorText(error) {
    if (error instanceof CliError) return error.code !== undefined ? `cli ${error.code}: ${error.message}` : `cli: ${error.message}`
    return String(error?.message ?? error)
  }
}
