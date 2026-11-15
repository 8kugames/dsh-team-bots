// src/services/bot-quota.ts —— Bot 额度墙状态域（DSHBOTS-241）
// provider 额度墙（已达限额）是 bot 级状态：主 provider 耗尽时，耗尽期内的新任务派发
// 直接走备用模型（备用 provider 同样耗尽则排队等待），恢复时间过后自动回主模型。
// 状态按 (bot, provider) 存：主备 provider 是两套额度，互相不能顶替。
// 方法挂在 TeamService 原型上（见 src/service.ts 的 defineMethods 调用）。

import { badRequest, forbidden, notFound } from '../errors.js'
import { nowIso, text } from '../util.js'

// 解析失败时的保守等待窗口：与网关「5 小时使用上限」同口径。
// 选保守等待而非「立即可用」：后者会让新任务继续撞同一堵墙；需要提前恢复时走人工解除入口。
export const QUOTA_DEFAULT_RESET_MS = 5 * 60 * 60_000

// 解析出的恢复时长上界：超过视为不可信文案（防把「30 天」之类当成重置窗口）。
const QUOTA_MAX_RESET_MS = 30 * 24 * 60 * 60_000

// 绝对时刻：reset at 2026-11-02 15:17:01 / 额度将于 2026-11-02 15:17 恢复。
const ABSOLUTE_TIME = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/g
// 同段须命中恢复语义关键词，避免把请求体里的其它时间戳误判为重置时间。
const RESET_KEYWORD = /(reset|resets|resetting|retry|available|恢复|重置)/i
// 时长：X 小时 / X minutes / Xh。
const DURATION = /(\d+(?:\.\d+)?)\s*(小时|个小时|分钟|分|秒|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi
const UNIT_MS = {
  小时: 60 * 60_000,
  个小时: 60 * 60_000,
  分钟: 60_000,
  分: 60_000,
  秒: 1_000,
}

function pad(value: string) {
  return value.padStart(2, '0')
}

function clampResetMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > QUOTA_MAX_RESET_MS) return null
  return Math.round(ms)
}

function unitMs(unit: string) {
  const lower = unit.toLowerCase()
  if (UNIT_MS[unit]) return UNIT_MS[unit]
  if (lower === 'h' || lower === 'hr' || lower === 'hrs' || lower === 'hour' || lower === 'hours') return 60 * 60_000
  if (lower === 'm' || lower === 'min' || lower === 'mins' || lower === 'minute' || lower === 'minutes') return 60_000
  return 1_000
}

// 从额度耗尽反馈消息里解析恢复时长（毫秒）。解析不出返回 null。
// 支持两种口径：绝对时刻（reset at YYYY-MM-DD HH:mm[:ss]）与相对时长（5 小时 / 15 minutes），
// 且该段必须含恢复语义关键词；已过期或超过 30 天的结果视为无效。
export function parseQuotaResetMs(message: unknown, nowMs = Date.now()): number | null {
  const body = String(message ?? '')
  if (!body) return null
  for (const segment of body.split(/[。；;！!？?\n]+/)) {
    if (!RESET_KEYWORD.test(segment)) continue
    const absolute = ABSOLUTE_TIME.exec(segment)
    if (absolute) {
      ABSOLUTE_TIME.lastIndex = 0
      const [, year, month, day, hour, minute, second] = absolute
      const ms = Date.parse(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:${pad(second ?? '0')}`)
      const delta = clampResetMs(ms - nowMs)
      if (delta) return delta
    }
    let match: RegExpExecArray | null
    DURATION.lastIndex = 0
    while ((match = DURATION.exec(segment))) {
      const delta = clampResetMs(Number(match[1]) * unitMs(match[2]))
      if (delta) return delta
    }
    DURATION.lastIndex = 0
  }
  return null
}

// 读状态时的惰性判定：reset_at 已过即视为已自动恢复（不落库回填，下次派发自然回主模型）。
function quotaRowState(row: any, nowMs = Date.now()) {
  if (!row) return { exhausted: false, state: 'ok' as const }
  const resetAt = row.reset_at ?? null
  const resetMs = resetAt ? Date.parse(resetAt) : NaN
  const exhausted = row.state === 'exhausted' && (!resetAt || Number.isFinite(resetMs) && resetMs > nowMs)
  return { exhausted: Boolean(exhausted), state: exhausted ? ('exhausted' as const) : ('ok' as const) }
}

// 额度耗尽派发路由：主 provider 未耗尽 → primary；主耗尽且备用可用 → fallback；
// 主耗尽且无可用备用 → wait（留 queued，等恢复后自动回主模型）。
export function quotaRouteFor(bot: any, primary: any, fallback: any) {
  if (!primary?.exhausted) return { mode: 'primary' as const }
  if (bot?.fallback_provider && bot?.fallback_model && !fallback?.exhausted) {
    return {
      mode: 'fallback' as const,
      provider: bot.fallback_provider,
      model: bot.fallback_model,
      effort: bot.fallback_effort || null,
      ref: `${bot.fallback_provider}/${bot.fallback_model}`,
    }
  }
  return { mode: 'wait' as const, provider: primary.provider, resetAt: primary.resetAt }
}

// 更严的一条额度记录（DSHBOTS-358）：耗尽状态优先，其次恢复时间更晚者。
// Bot 换 provider 时用于合并旧键与新键的记录，避免迁移把正在生效的墙抹掉。
function stricterQuotaRow(a: any, b: any) {
  const aExhausted = quotaRowState(a).exhausted
  const bExhausted = quotaRowState(b).exhausted
  if (aExhausted !== bExhausted) return aExhausted ? a : b
  const aAt = a?.reset_at ? Date.parse(a.reset_at) : 0
  const bAt = b?.reset_at ? Date.parse(b.reset_at) : 0
  return aAt >= bAt ? a : b
}

export const botQuotaMethods = {
  // 单套 provider 的额度状态视图。provider 为空（bot 未配主模型）时视为无限制。
  botQuotaState(botId: string | null | undefined, provider: string | null | undefined) {
    if (!botId || !provider) return null
    const row = this.store.get('SELECT * FROM bot_quota WHERE bot_id = ? AND provider = ?', botId, provider)
    const effective = quotaRowState(row)
    return {
      provider,
      state: effective.state,
      exhausted: effective.exhausted,
      exhaustedAt: row?.exhausted_at ?? null,
      resetAt: row?.reset_at ?? null,
      resetSource: row?.reset_source ?? null,
      errorCode: row?.error_code ?? null,
      errorMessage: row?.error_message ?? null,
      releasedAt: row?.released_at ?? null,
      releasedBy: row?.released_by ?? null,
    }
  },

  // 记录撞墙：恢复时间优先取反馈自带的 retryAfterMs，其次解析消息正文，最后保守兜底。
  recordBotQuotaExhaustion({ botId, provider, errorCode = null, errorMessage = '', retryAfterMs = null }) {
    if (!botId || !provider) return null
    const retry = Number(retryAfterMs)
    const parsed = Number.isFinite(retry) && retry > 0 ? null : parseQuotaResetMs(errorMessage)
    const resetMs = Number.isFinite(retry) && retry > 0 ? Math.round(retry) : parsed ?? QUOTA_DEFAULT_RESET_MS
    const resetSource = Number.isFinite(retry) && retry > 0 ? 'retry-after' : parsed ? 'message' : 'default'
    const now = nowIso()
    const resetAt = new Date(Date.now() + resetMs).toISOString()
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO bot_quota(bot_id, provider, state, exhausted_at, reset_at, reset_source, released_at, released_by, error_code, error_message, updated_at)
         VALUES (?, ?, 'exhausted', ?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(bot_id, provider) DO UPDATE SET
           state = 'exhausted', exhausted_at = excluded.exhausted_at, reset_at = excluded.reset_at,
           reset_source = excluded.reset_source, released_at = NULL, released_by = NULL,
           error_code = excluded.error_code, error_message = excluded.error_message, updated_at = excluded.updated_at`,
        botId,
        provider,
        now,
        resetAt,
        resetSource,
        errorCode ?? null,
        text(errorMessage ?? '', 2_000),
        now,
      )
      this.audit({ type: 'system', id: 'system' }, 'bot.quota_exhausted', 'bot', botId, {
        provider,
        resetAt,
        resetSource,
        errorCode: errorCode ?? null,
      })
    })
    return this.botQuotaState(botId, provider)
  },

  // 手动解除：立即恢复派发（不等自动恢复）。限工作台 owner（user）或项目总监（director bot）。
  releaseBotQuota(botId: string, actor: any = this.actor()) {
    const bot = this.botRow(botId)
    this.assertQuotaReleaseActor(actor)
    const rows = this.store.all('SELECT * FROM bot_quota WHERE bot_id = ?', botId)
    const cleared = rows.filter(row => quotaRowState(row).exhausted).map(row => row.provider)
    const now = nowIso()
    const releasedBy = `${actor.type}:${actor.id}`
    this.store.transaction(() => {
      for (const row of rows) {
        this.store.run(
          `UPDATE bot_quota SET state = 'ok', reset_at = NULL, released_at = ?, released_by = ?, updated_at = ?
           WHERE bot_id = ? AND provider = ?`,
          now,
          releasedBy,
          now,
          botId,
          row.provider,
        )
      }
      this.audit(actor, 'bot.quota_released', 'bot', botId, { providers: cleared })
    })
    void this.tick()
    return this.botView(bot)
  },

  assertQuotaReleaseActor(actor: any) {
    if (actor?.type === 'user') return
    if (actor?.type === 'bot') {
      const director = this.store.get(
        "SELECT 1 AS ok FROM projects WHERE owner_bot_id = ? AND status = 'active' LIMIT 1",
        actor.id,
      )
      if (director) return
    }
    throw forbidden('只有工作台 owner 或项目总监可以解除额度耗尽')
  },

  // bot 级额度视图（botView/system.state 共用）。
  botQuotaView(bot: any) {
    const primary = bot?.provider ? this.botQuotaState(bot.id, bot.provider) : null
    const fallback = bot?.fallback_provider ? this.botQuotaState(bot.id, bot.fallback_provider) : null
    return {
      exhausted: Boolean(primary?.exhausted),
      primary: primary
        ? {
            provider: primary.provider,
            exhausted: primary.exhausted,
            resetAt: primary.resetAt,
            resetSource: primary.resetSource,
            exhaustedAt: primary.exhaustedAt,
            errorCode: primary.errorCode,
            releasedAt: primary.releasedAt,
            releasedBy: primary.releasedBy,
          }
        : null,
      fallback: fallback
        ? { provider: fallback.provider, exhausted: fallback.exhausted, resetAt: fallback.resetAt }
        : null,
    }
  },

  // 派发路由：主 provider 耗尽时走备用模型；无可用备用则排队等待。
  quotaRoutingForBot(bot: any) {
    if (!bot) return { mode: 'primary' }
    const primary = this.botQuotaState(bot.id, bot.provider)
    const fallback = bot.fallback_provider ? this.botQuotaState(bot.id, bot.fallback_provider) : null
    return quotaRouteFor(bot, primary, fallback)
  },

  // 换 provider 时迁移额度记录（DSHBOTS-358）：额度墙按 (bot, provider) 存，
  // Bot 改用别的 provider 后旧键会成孤儿（永远查不到、也永远清不掉）。
  // 迁移口径：目标 provider 无记录 → 直接改键；目标已有记录 → 保留更严的一条（不抹掉
  // 正在生效的墙），删掉旧键。仅 provider 真变才动，并落一条操作日志。
  migrateBotQuotaProvider(botId: string, fromProvider: string | null | undefined, toProvider: string | null | undefined, actor: any = this.actor()) {
    if (!botId || !fromProvider || !toProvider || fromProvider === toProvider) return null
    const oldRow = this.store.get('SELECT * FROM bot_quota WHERE bot_id = ? AND provider = ?', botId, fromProvider)
    const newRow = this.store.get('SELECT * FROM bot_quota WHERE bot_id = ? AND provider = ?', botId, toProvider)
    if (!oldRow && !newRow) {
      this.audit(actor, 'bot.quota_provider_changed', 'bot', botId, {
        from: fromProvider, to: toProvider, migrated: false,
      })
      return null
    }
    const now = nowIso()
    this.store.transaction(() => {
      if (oldRow) {
        if (!newRow) {
          this.store.run(
            'UPDATE bot_quota SET provider = ?, updated_at = ? WHERE bot_id = ? AND provider = ?',
            toProvider, now, botId, fromProvider,
          )
        } else {
          const keep = stricterQuotaRow(oldRow, newRow)
          if (keep === oldRow) {
            this.store.run(
              `UPDATE bot_quota SET state = ?, exhausted_at = ?, reset_at = ?, reset_source = ?, released_at = NULL,
                released_by = NULL, error_code = ?, error_message = ?, updated_at = ?
               WHERE bot_id = ? AND provider = ?`,
              keep.state, keep.exhausted_at, keep.reset_at, keep.reset_source,
              keep.error_code ?? null, keep.error_message ?? null, now, botId, toProvider,
            )
          }
          this.store.run('DELETE FROM bot_quota WHERE bot_id = ? AND provider = ?', botId, fromProvider)
        }
      }
      this.audit(actor, 'bot.quota_provider_changed', 'bot', botId, {
        from: fromProvider, to: toProvider, migrated: Boolean(oldRow),
      })
    })
    return this.botQuotaState(botId, toProvider)
  },

  // 解析 bot 标识（id 或 name），供 director 工具按名字解除。
  resolveBotForQuota(input: unknown) {
    const raw = String(input ?? '').trim()
    if (!raw) throw badRequest('缺少 Bot 标识')
    const bot = this.store.get('SELECT * FROM bots WHERE id = ? OR name = ?', raw, raw)
    if (!bot) throw notFound('Bot 不存在')
    return bot
  },

  // director 工具入口：经 ownerContextFor 复用会话绑定与项目归属校验。
  releaseBotQuotaFromBot(sessionId: string, input: unknown) {
    const { actor } = this.ownerContextFor(sessionId)
    const bot = this.resolveBotForQuota(input)
    return this.releaseBotQuota(bot.id, actor)
  },
}

