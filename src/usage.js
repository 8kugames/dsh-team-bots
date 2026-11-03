import { currentPriceMap, effectivePrice, lookupPrice } from './pricing.js'
import { id, nowIso } from './util.js'

const count = value => (Number.isSafeInteger(value) && value > 0 ? value : 0)

// 时间边界归一：接受 ISO 字符串或毫秒时间戳，无法解析时返回 null。
function toMillis(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

export const BUDGET_CURRENCY = 'CNY'

function currentPrice(store, provider, model) {
  return effectivePrice(store, provider, model)
}

// 单条明细成本：输入侧（含缓存读写）+ 输出侧，按每百万 token 计价。
// recordUsage 入库与事后追认共用同一公式，保证两条口径算出的金额一致。
function costForTokens(price, tokens = {}) {
  const input = Number(tokens.input ?? 0)
  const cacheRead = Number(tokens.cacheRead ?? 0)
  const cacheWrite = Number(tokens.cacheWrite ?? 0)
  const output = Number(tokens.output ?? 0)
  const inputCost = (input / 1_000_000) * price.input_per_mtok
    + (cacheRead / 1_000_000) * price.cache_read_per_mtok
    + (cacheWrite / 1_000_000) * price.cache_write_per_mtok
  const outputCost = (output / 1_000_000) * price.output_per_mtok
  return { inputCost, outputCost, totalCost: inputCost + outputCost }
}

export function recordUsage(store, {
  sourceKey,
  sourceEventId = null,
  run,
  provider,
  model,
  usage,
  occurredAt = nowIso(),
  purpose = 'run',
}) {
  if (!usage || typeof usage !== 'object') return null
  const input = count(usage.inputTokens ?? usage.input)
  const cacheRead = count(usage.cacheReadTokens ?? usage.cache_read)
  const cacheWrite = count(usage.cacheWriteTokens ?? usage.cache_write)
  const output = count(usage.outputTokens ?? usage.output)
  const reasoning = count(usage.reasoningTokens ?? usage.reasoning)
  if (input + cacheRead + cacheWrite + output + reasoning === 0) return null
  const existing = store.get('SELECT * FROM usage_events WHERE source_key = ?', sourceKey)
  if (existing) return existing
  const price = currentPrice(store, provider, model)
  let inputCost = null
  let outputCost = null
  let totalCost = null
  if (price) {
    const costs = costForTokens(price, { input, cacheRead, cacheWrite, output })
    inputCost = costs.inputCost
    outputCost = costs.outputCost
    totalCost = costs.totalCost
  }
  const currency = String(price?.currency ?? BUDGET_CURRENCY).toUpperCase() || BUDGET_CURRENCY
  const eventId = id('use')
  store.run(
    `INSERT INTO usage_events(id, source_key, source_event_id, run_id, project_id, bot_id, task_id,
       provider, model, purpose, currency,
       input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
       input_cost, output_cost, total_cost, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventId,
    sourceKey,
    sourceEventId,
    run?.id ?? null,
    run?.project_id ?? null,
    run?.bot_id ?? null,
    run?.task_id ?? null,
    provider ?? '',
    model ?? '',
    purpose,
    currency,
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    inputCost,
    outputCost,
    totalCost,
    occurredAt,
    nowIso(),
  )
  return store.get('SELECT * FROM usage_events WHERE id = ?', eventId)
}

// 明细级聚合：token 与调用次数。计价状态（priced/unpriced）由 costBreakdown 统一给出，
// 口径是「入库已算死 + 现价可追认」，避免同一语义在两处各统计一遍。
const AGGREGATES = `
  COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
  COUNT(*) AS calls`

// 汇总口径：成本按币种分列，cost 只取预算币种的金额，不同币种不混算。
function filterClause(filters) {
  const list = filters.filter(Boolean)
  return list.length ? `WHERE ${list.join(' AND ')}` : ''
}

// 在既有 where 上追加分组条件：where 为空时补 WHERE，否则接 AND。
function andClause(where, clause) {
  return `${where ? `${where} AND` : 'WHERE'} ${clause}`
}

// 成本聚合（含追认）：已计价明细用入库时算死的成本，未计价明细（total_cost IS NULL）
// 按当前价目表补算——价目配齐后无需迁移，聚合结果即全量。pricedCalls/unpricedCalls
// 也随之按「当前能否计价」统计：能追认的未计价计入 priced，仍无价可追认的才是真未计价。
function costBreakdown(store, where, params, budgetCurrency, prices = null) {
  const priceMap = prices ?? currentPriceMap(store)
  const rows = store.all(
    `SELECT u.currency AS currency,
            u.provider AS provider,
            u.model AS model,
            SUM(CASE WHEN u.total_cost IS NOT NULL THEN 1 ELSE 0 END) AS priced_calls,
            SUM(CASE WHEN u.total_cost IS NULL THEN 1 ELSE 0 END) AS null_calls,
            COALESCE(SUM(CASE WHEN u.total_cost IS NOT NULL THEN u.total_cost ELSE 0 END), 0) AS stored_cost,
            COALESCE(SUM(CASE WHEN u.total_cost IS NULL THEN u.input_tokens ELSE 0 END), 0) AS null_input_tokens,
            COALESCE(SUM(CASE WHEN u.total_cost IS NULL THEN u.cache_read_tokens ELSE 0 END), 0) AS null_cache_read_tokens,
            COALESCE(SUM(CASE WHEN u.total_cost IS NULL THEN u.cache_write_tokens ELSE 0 END), 0) AS null_cache_write_tokens,
            COALESCE(SUM(CASE WHEN u.total_cost IS NULL THEN u.output_tokens ELSE 0 END), 0) AS null_output_tokens,
            COALESCE(SUM(CASE WHEN u.total_cost IS NULL THEN u.reasoning_tokens ELSE 0 END), 0) AS null_reasoning_tokens
       FROM usage_events u ${where}
      GROUP BY u.currency, u.provider, u.model`,
    ...params,
  )
  const costByCurrency = {}
  let pricedCalls = 0
  let unpricedCalls = 0
  let unpricedTokens = 0
  for (const row of rows) {
    const priced = Number(row.priced_calls ?? 0)
    const nullCalls = Number(row.null_calls ?? 0)
    // 入库已计价的金额仍记在明细自己的币种下，不因后续改价改写历史。
    if (priced > 0) {
      const currency = String(row.currency ?? BUDGET_CURRENCY)
      costByCurrency[currency] = (costByCurrency[currency] ?? 0) + Number(row.stored_cost ?? 0)
    }
    pricedCalls += priced
    const price = lookupPrice(priceMap, row.provider, row.model)
    if (!price) {
      unpricedCalls += nullCalls
      unpricedTokens += Number(row.null_input_tokens ?? 0) + Number(row.null_cache_read_tokens ?? 0)
        + Number(row.null_cache_write_tokens ?? 0) + Number(row.null_output_tokens ?? 0)
        + Number(row.null_reasoning_tokens ?? 0)
      continue
    }
    if (nullCalls > 0) {
      const { totalCost } = costForTokens(price, {
        input: Number(row.null_input_tokens ?? 0),
        cacheRead: Number(row.null_cache_read_tokens ?? 0),
        cacheWrite: Number(row.null_cache_write_tokens ?? 0),
        output: Number(row.null_output_tokens ?? 0),
      })
      // 追认金额记在价目币种下，与入库计价同口径。
      const priceCurrency = String(price.currency ?? BUDGET_CURRENCY)
      costByCurrency[priceCurrency] = (costByCurrency[priceCurrency] ?? 0) + totalCost
    }
    pricedCalls += nullCalls
  }
  return {
    cost: costByCurrency[budgetCurrency] ?? null,
    costByCurrency,
    pricedCalls,
    unpricedCalls,
    unpricedTokens,
  }
}

function mapTotals(row, breakdown = {
  cost: null, costByCurrency: {}, pricedCalls: 0, unpricedCalls: 0, unpricedTokens: 0,
}) {
  const input = Number(row?.input_tokens ?? 0)
  const cacheRead = Number(row?.cache_read_tokens ?? 0)
  const cacheWrite = Number(row?.cache_write_tokens ?? 0)
  const output = Number(row?.output_tokens ?? 0)
  const reasoning = Number(row?.reasoning_tokens ?? 0)
  const calls = Number(row?.calls ?? 0)
  const pricedCalls = Number(breakdown.pricedCalls ?? 0)
  const unpricedCalls = Number(breakdown.unpricedCalls ?? 0)
  const totalTokens = input + cacheRead + cacheWrite + output + reasoning
  return {
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens,
    calls,
    cost: breakdown.cost,
    costByCurrency: breakdown.costByCurrency,
    costConfigured: pricedCalls > 0,
    pricedCalls,
    unpricedCalls,
    // 未计价调用占掉的 token：预算估算按它折算成本，避免把未计价当成 0 成本而低估预算。
    unpricedTokens: Number(breakdown.unpricedTokens ?? 0),
    // 成本完整性：存在未计价调用时 cost 只是部分值，不能当作完整成本使用。
    costComplete: unpricedCalls === 0,
  }
}

const ZERO_TOTALS = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  calls: 0,
  cost: null,
  costByCurrency: {},
  costConfigured: false,
  pricedCalls: 0,
  unpricedCalls: 0,
  unpricedTokens: 0,
  costComplete: true,
}

// 单条件聚合：token 与调用次数 + 成本分币种。
// prices 为调用方已取好的当前价目表（usageSnapshot 只取一次，避免 N+1）；缺省自行加载。
export function aggregateUsage(store, filters = [], params = [], budgetCurrency = BUDGET_CURRENCY, prices = null) {
  const where = filterClause(filters)
  const row = store.get(`SELECT ${AGGREGATES} FROM usage_events u ${where}`, ...params)
  const breakdown = costBreakdown(store, where, params, budgetCurrency, prices)
  return mapTotals(row, breakdown)
}

export function runUsageTotals(store, runId, budgetCurrency = BUDGET_CURRENCY) {
  return aggregateUsage(store, ['u.run_id = ?'], [runId], budgetCurrency)
}

// 用量时间窗（DSHBOTS-121）：今日 / 7 日 / 30 日 / 至今 四档。
// 口径：今日 = 产品时区（默认 Asia/Shanghai）当日 0 点起；7 日 / 30 日 = 滚动窗口；
// 至今 = 不设下界。明细 occurred_at 存的是 ISO UTC 字符串，窗口起点先换算成 UTC ISO 再比较。
export const USAGE_WINDOW_KEYS = ['today', '7d', '30d', 'all']
export const USAGE_WINDOW_LABELS = { today: '今日', '7d': '7 日', '30d': '30 日', all: '至今' }
export const USAGE_TIME_ZONE = process.env.DSH_USAGE_TIME_ZONE || 'Asia/Shanghai'

const DAY_MS = 86_400_000

// 某一时刻在指定时区的挂钟分量与偏移（分钟，东为正）。
function zoneClock(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = {}
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  const hour = Number(parts.hour) % 24
  const minute = Number(parts.minute)
  const second = Number(parts.second)
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  return { year, month, day, hour, minute, offsetMinutes: Math.round((wall - ms) / 60_000) }
}

// 指定时区当日 0 点对应的 UTC 毫秒（夏令时切换日按当日实际偏移二次校正）。
function zoneDayStartUtc(ms, timeZone) {
  const clock = zoneClock(ms, timeZone)
  const wallStart = Date.UTC(clock.year, clock.month - 1, clock.day, 0, 0, 0)
  const offset = zoneClock(wallStart - clock.offsetMinutes * 60_000, timeZone).offsetMinutes
  return wallStart - offset * 60_000
}

// 时区内的日历日（YYYY-MM-DD）。
function zoneDay(ms, timeZone) {
  const clock = zoneClock(ms, timeZone)
  return `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`
}

// 解析时间窗：today / 7d / 30d / all，非法键回退 30 日。
// since 为 null 表示「至今」（没有下界）；dayCount 是日历面板要画的根数。
export function resolveUsageWindow(key, options = {}) {
  const now = Number(options.now ?? Date.now())
  const timeZone = options.timeZone ?? USAGE_TIME_ZONE
  const wanted = USAGE_WINDOW_KEYS.includes(String(key)) ? String(key) : '30d'
  const clock = zoneClock(now, timeZone)
  let since = null
  let days = null
  let dayCount = 30
  if (wanted === 'today') {
    since = new Date(zoneDayStartUtc(now, timeZone)).toISOString()
    days = 1
    dayCount = 1
  } else if (wanted === '7d') {
    since = new Date(now - 7 * DAY_MS).toISOString()
    days = 7
    dayCount = 7
  } else if (wanted === '30d') {
    since = new Date(now - 30 * DAY_MS).toISOString()
    days = 30
    dayCount = 30
  }
  return {
    key: wanted,
    label: USAGE_WINDOW_LABELS[wanted],
    since,
    days,
    dayCount,
    timeZone,
    offsetMinutes: clock.offsetMinutes,
    // 日历面板起点：产品时区下的日历日。
    daySince: zoneDay(now - (dayCount - 1) * DAY_MS, timeZone),
  }
}

// 日历日表达式：offsetMinutes 为空时沿用 UTC 日期（旧口径），否则按固定偏移换算到产品时区。
function dayExpression(column, offsetMinutes) {
  if (offsetMinutes === null || offsetMinutes === undefined) return `substr(${column}, 1, 10)`
  const sign = offsetMinutes < 0 ? '-' : '+'
  return `substr(datetime(substr(replace(${column}, 'T', ' '), 1, 19), '${sign}${Math.abs(offsetMinutes)} minutes'), 1, 10)`
}

// 统计口径：since 为窗口起点（ISO 字符串），projectId 限定项目（null 表示全局）；
// since 为 null 表示「至今」——没有下界，不加时间过滤。
function scopeFilters(scope) {
  const filters = []
  const params = []
  if (scope.since) {
    filters.push('u.occurred_at >= ?')
    params.push(scope.since)
  }
  if (scope.projectId) {
    filters.push('u.project_id = ?')
    params.push(scope.projectId)
  }
  // 单聊口径（DSHBOTS-9）：该 Bot 的项目外用量，与 view.solo.runs 同口径。
  if (scope.soloBotId) {
    filters.push('u.bot_id = ?', 'u.project_id IS NULL')
    params.push(scope.soloBotId)
  }
  // 至今窗口没有时间下界时可能一条条件都不剩，补一条恒真条件，保证 where 子句非空。
  if (!filters.length) filters.push('1 = 1')
  return { filters, params }
}

// 运行窗口：结束、开始、入队任一时间落在窗口内即视为「窗口内跑过」。
const RUN_IN_WINDOW = 'COALESCE(r.ended_at, r.started_at, r.queued_at) >= ?'

function runWindowFilter(scope) {
  if (!scope.since) return { clause: '1 = 1', params: [] }
  return { clause: RUN_IN_WINDOW, params: [scope.since] }
}

// 零用量行口径：token 与调用数为 0；成本记 0（没有发生消费，不属于未计价），
// 币种按预算币种记 0，界面直接显示金额而不是「未配置」。
function zeroTotals(budgetCurrency) {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    calls: 0,
    cost: 0,
    costByCurrency: { [budgetCurrency]: 0 },
    costConfigured: false,
    pricedCalls: 0,
    unpricedCalls: 0,
    costComplete: true,
  }
}

// 零用量 Bot：窗口内跑过、但窗口内没有任何用量明细。
function zeroUsageBotRows(store, scope, budgetCurrency) {
  const runFilters = []
  const runParams = []
  if (scope.projectId) {
    runFilters.push('r.project_id = ?')
    runParams.push(scope.projectId)
  }
  const { filters: eventFilters, params: eventParams } = scopeFilters(scope)
  const runWindow = runWindowFilter(scope)
  const rows = store.all(
    `SELECT b.id AS bot_id, b.name AS name
       FROM bots b
       JOIN runs r ON r.bot_id = b.id
      WHERE ${runFilters.length ? `${runFilters.join(' AND ')} AND` : ''} ${runWindow.clause}
        AND NOT EXISTS (
          SELECT 1 FROM usage_events u WHERE u.bot_id = b.id${eventFilters.length ? ` AND ${eventFilters.join(' AND ')}` : ''}
        )
      GROUP BY b.id, b.name
      ORDER BY b.name`,
    ...runParams, ...runWindow.params, ...eventParams,
  )
  return rows.map(row => ({ botId: row.bot_id, name: row.name, ...zeroTotals(budgetCurrency) }))
}

// 零用量项目：窗口内跑过、但窗口内没有任何用量明细。
function zeroUsageProjectRows(store, scope, budgetCurrency) {
  const runFilters = []
  const runParams = []
  if (scope.projectId) {
    runFilters.push('r.project_id = ?')
    runParams.push(scope.projectId)
  }
  const { filters: eventFilters, params: eventParams } = scopeFilters(scope)
  const runWindow = runWindowFilter(scope)
  const rows = store.all(
    `SELECT p.id AS project_id, p.name AS name, p.key AS key
       FROM projects p
       JOIN runs r ON r.project_id = p.id
      WHERE ${runFilters.length ? `${runFilters.join(' AND ')} AND` : ''} ${runWindow.clause}
        AND NOT EXISTS (
          SELECT 1 FROM usage_events u WHERE u.project_id = p.id${eventFilters.length ? ` AND ${eventFilters.join(' AND ')}` : ''}
        )
      GROUP BY p.id, p.name, p.key
      ORDER BY p.name`,
    ...runParams, ...runWindow.params, ...eventParams,
  )
  return rows.map(row => ({ projectId: row.project_id, name: row.name, key: row.key, ...zeroTotals(budgetCurrency) }))
}

// 零用量日期：窗口内跑过、但当天没有任何用量明细的日期。
function zeroUsageDayRows(store, scope, budgetCurrency, daySince) {
  const runFilters = []
  const runParams = []
  if (scope.projectId) {
    runFilters.push('r.project_id = ?')
    runParams.push(scope.projectId)
  }
  const { filters: eventFilters, params: eventParams } = scopeFilters(scope)
  const runWindow = runWindowFilter(scope)
  const runDay = dayExpression('COALESCE(r.ended_at, r.started_at, r.queued_at)', scope.offsetMinutes)
  const eventDay = dayExpression('u.occurred_at', scope.offsetMinutes)
  const rows = store.all(
    `SELECT d.day AS day FROM (
        SELECT DISTINCT ${runDay} AS day
          FROM runs r
         WHERE ${runFilters.length ? `${runFilters.join(' AND ')} AND` : ''} ${runWindow.clause}
       ) d
      WHERE ${daySince ? 'd.day >= ? AND' : ''} NOT EXISTS (
        SELECT 1 FROM usage_events u
         WHERE ${eventDay} = d.day${eventFilters.length ? ` AND ${eventFilters.join(' AND ')}` : ''}
      )
      ORDER BY d.day`,
    ...runParams, ...runWindow.params, ...(daySince ? [daySince] : []), ...eventParams,
  )
  return rows.map(row => ({ day: row.day, ...zeroTotals(budgetCurrency) }))
}

// 分档口径：Bot / 项目 / 日期维度用 LEFT JOIN + 零用量行补齐，
// 跑过但没有产出用量明细的 run 也会出现在分档结果里。
function byBotRows(store, scope, budgetCurrency, prices = null) {
  const { filters, params } = scopeFilters(scope)
  const where = filterClause(filters)
  const rows = store.all(
    `SELECT u.bot_id AS bot_id, b.name AS name, ${AGGREGATES}
       FROM usage_events u LEFT JOIN bots b ON b.id = u.bot_id ${where}
      GROUP BY u.bot_id, b.name
      ORDER BY input_tokens + output_tokens DESC`,
    ...params,
  )
  const used = rows.map(row => {
    const breakdown = costBreakdown(store, andClause(where, 'u.bot_id IS ?'), [...params, row.bot_id], budgetCurrency, prices)
    return { botId: row.bot_id, name: row.name, ...mapTotals(row, breakdown) }
  })
  return [...used, ...zeroUsageBotRows(store, scope, budgetCurrency)]
}

function byProjectRows(store, scope, budgetCurrency, prices = null) {
  const { filters, params } = scopeFilters(scope)
  const where = filterClause(filters)
  const rows = store.all(
    `SELECT u.project_id AS project_id, p.name AS name, p.key AS key, ${AGGREGATES}
       FROM usage_events u LEFT JOIN projects p ON p.id = u.project_id ${where}
      GROUP BY u.project_id, p.name, p.key
      ORDER BY input_tokens + output_tokens DESC`,
    ...params,
  )
  const used = rows.map(row => {
    const breakdown = costBreakdown(store, andClause(where, 'u.project_id IS ?'), [...params, row.project_id], budgetCurrency, prices)
    return { projectId: row.project_id, name: row.name, key: row.key, ...mapTotals(row, breakdown) }
  })
  return [...used, ...zeroUsageProjectRows(store, scope, budgetCurrency)]
}

// 模型维度来自明细本身，无法归集「跑过但零用量」的 run，因此只有事件行。
function byModelRows(store, scope, budgetCurrency, prices = null) {
  const { filters, params } = scopeFilters(scope)
  const where = filterClause(filters)
  const rows = store.all(
    `SELECT u.provider AS provider, u.model AS model, ${AGGREGATES}
       FROM usage_events u ${where}
      GROUP BY u.provider, u.model
      ORDER BY input_tokens + output_tokens DESC`,
    ...params,
  )
  return rows.map(row => {
    const breakdown = costBreakdown(store, andClause(where, 'u.provider = ? AND u.model = ?'), [...params, row.provider, row.model], budgetCurrency, prices)
    return { provider: row.provider, model: row.model, ...mapTotals(row, breakdown) }
  })
}

function byDayRows(store, scope, budgetCurrency, daySince = null, prices = null) {
  const { filters, params } = scopeFilters(scope)
  const dayExpr = dayExpression('u.occurred_at', scope.offsetMinutes)
  const allFilters = daySince ? [...filters, `${dayExpr} >= ?`] : filters
  const allParams = daySince ? [...params, daySince] : params
  const where = filterClause(allFilters)
  const rows = store.all(
    `SELECT ${dayExpr} AS day, ${AGGREGATES}
       FROM usage_events u ${where}
      GROUP BY day ORDER BY day`,
    ...allParams,
  )
  const used = rows.map(row => {
    const breakdown = costBreakdown(store, andClause(where, `${dayExpr} = ?`), [...allParams, row.day], budgetCurrency, prices)
    return { day: row.day, ...mapTotals(row, breakdown) }
  })
  return [...used, ...zeroUsageDayRows(store, scope, budgetCurrency, daySince)]
}

function tierSet(store, scope, budgetCurrency, daySince = null, prices = null) {
  return {
    byBot: byBotRows(store, scope, budgetCurrency, prices),
    byProject: byProjectRows(store, scope, budgetCurrency, prices),
    byModel: byModelRows(store, scope, budgetCurrency, prices),
    byDay: byDayRows(store, scope, budgetCurrency, daySince, prices),
  }
}

function scopeUsage(store, scope, budgetCurrency, prices = null) {
  const { filters, params } = scopeFilters(scope)
  return aggregateUsage(store, filters, params, budgetCurrency, prices)
}

function windowSpanDays(store, window) {
  if (Number.isFinite(window.days) && window.days > 0) return window.days
  const earliest = store.get('SELECT MIN(occurred_at) AS earliest FROM usage_events')?.earliest ?? null
  if (!earliest) return 1
  const from = Date.parse(String(earliest))
  if (!Number.isFinite(from)) return 1
  return Math.max(1, Math.ceil((Date.now() - from) / DAY_MS))
}

export function usageSnapshot(store, projectId, days = 30, options = {}) {
  const budgetCurrency = String(options.currency ?? BUDGET_CURRENCY).toUpperCase() || BUDGET_CURRENCY
  const soloBotId = options.soloBotId ?? null
  // 时间窗口径（DSHBOTS-121）：传 window 走四档窗口；不传时沿用旧的「近 N 天」滚动窗口。
  const window = options.window
    ? resolveUsageWindow(options.window, { now: options.now, timeZone: options.timeZone })
    : null
  const since = window ? window.since : new Date(Date.now() - days * 86_400_000).toISOString()
  // 窗口口径下日历日按产品时区分组；旧口径（offsetMinutes 为空）仍按 UTC 日期。
  const offsetMinutes = window ? window.offsetMinutes : null
  const globalScope = { since, projectId: null, offsetMinutes }
  const projectScope = projectId ? { since, projectId, offsetMinutes } : null
  const soloScope = soloBotId ? { since, projectId: null, soloBotId, offsetMinutes } : null
  // 价目表只取一次：所有口径的追认共用同一张「当前价目」，避免每个分组各查一遍。
  const prices = currentPriceMap(store)
  const global = scopeUsage(store, globalScope, budgetCurrency, prices)
  const project = projectScope ? scopeUsage(store, projectScope, budgetCurrency, prices) : { ...ZERO_TOTALS }
  const solo = soloScope ? scopeUsage(store, soloScope, budgetCurrency, prices) : null
  // 日历面板：窗口口径下画窗口对应的天数（今日 1 根 / 7 日 7 根 / 30 日 30 根 / 至今封顶 30 根）；
  // 旧口径沿用近 14 天。
  const cutoff = window
    ? window.daySince
    : new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10)
  const globalTiers = tierSet(store, globalScope, budgetCurrency, cutoff, prices)
  const projectTiers = projectScope ? tierSet(store, projectScope, budgetCurrency, cutoff, prices) : null
  const soloTiers = soloScope ? tierSet(store, soloScope, budgetCurrency, cutoff, prices) : null
  const priceCount = store.get(
    "SELECT COUNT(DISTINCT provider || '|' || lower(model)) AS count FROM model_prices",
  )?.count ?? 0
  return {
    days: window ? window.days : days,
    window: window ? { ...window, spanDays: windowSpanDays(store, window) } : null,
    currency: budgetCurrency,
    global,
    project,
    solo,
    scope: { global, project, solo },
    byBot: globalTiers.byBot,
    byProject: globalTiers.byProject,
    byModel: globalTiers.byModel,
    byDay: globalTiers.byDay,
    scopeTiers: { global: globalTiers, project: projectTiers, solo: soloTiers },
    priceCount,
    reconciliation: reconciliationSummary(store),
  }
}

// 对账结果摘要（只读，不触发对账）。
export function reconciliationSummary(store) {
  const row = store.get(
    `SELECT COUNT(*) AS runs_checked,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_runs,
            SUM(CASE WHEN status = 'missing' THEN 1 ELSE 0 END) AS missing_usage,
            SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired_usage,
            SUM(CASE WHEN status = 'repaired' THEN 1 ELSE 0 END) AS repaired,
            MAX(checked_at) AS checked_at
       FROM usage_reconciliation`,
  )
  return {
    checkedAt: row?.checked_at ?? null,
    runsChecked: Number(row?.runs_checked ?? 0),
    runsWithEvents: Number(row?.ok_runs ?? 0) + Number(row?.repaired ?? 0),
    missingUsage: Number(row?.missing_usage ?? 0),
    // 因保留期清理而消失的明细：不计入不一致，只作为过期计数暴露。
    expiredUsage: Number(row?.expired_usage ?? 0),
    mismatched: Number(row?.missing_usage ?? 0) + Number(row?.repaired ?? 0),
    repaired: Number(row?.repaired ?? 0),
  }
}

export function setPrice(store, input) {
  const provider = String(input.provider ?? '').trim()
  const model = String(input.model ?? '').trim()
  // provider 允许为空：空 provider 表示按模型名通配任意 provider。
  if (!model) throw new Error('model 必填')
  const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt).toISOString() : nowIso()
  const existing = store.get(
    'SELECT id FROM model_prices WHERE provider = ? AND model = ? AND effective_at = ?',
    provider,
    model,
    effectiveAt,
  )
  const vals = [
    Number(input.inputPerMtok ?? 0),
    Number(input.cacheReadPerMtok ?? 0),
    Number(input.cacheWritePerMtok ?? 0),
    Number(input.outputPerMtok ?? 0),
    String(input.currency ?? BUDGET_CURRENCY).trim().toUpperCase() || BUDGET_CURRENCY,
  ]
  if (vals.slice(0, 4).some(value => !Number.isFinite(value) || value < 0)) throw new Error('价格必须是非负数')
  if (existing) {
    store.run(
      `UPDATE model_prices SET input_per_mtok = ?, cache_read_per_mtok = ?, cache_write_per_mtok = ?,
       output_per_mtok = ?, currency = ? WHERE id = ?`,
      ...vals, existing.id,
    )
    return existing.id
  }
  const priceId = id('price')
  store.run(
    `INSERT INTO model_prices(id, provider, model, input_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
       output_per_mtok, currency, effective_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    priceId, provider, model, ...vals, effectiveAt,
  )
  return priceId
}

export function monthUsageForProject(store, projectId, budgetCurrency = BUDGET_CURRENCY) {
  const month = new Date().toISOString().slice(0, 7)
  return aggregateUsage(store, ['u.project_id = ?', 'substr(u.occurred_at, 1, 7) = ?'], [projectId, month], budgetCurrency)
}

export function monthUsageGlobal(store, budgetCurrency = BUDGET_CURRENCY) {
  const month = new Date().toISOString().slice(0, 7)
  return aggregateUsage(store, ['substr(u.occurred_at, 1, 7) = ?'], [month], budgetCurrency)
}

// 对账：运行表记录的用量与 usage_events 明细比对，修复「事件晚到」造成的缺口。
// expiredBefore：用量明细的保留期清理边界（ISO 字符串或毫秒时间戳）。
// 早于该边界、且明细已被清理的 run 判为 'expired'（不是丢数据，不计入不一致）。
export function reconcileUsage(store, { days = 30, expiredBefore = null } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const expiredAt = toMillis(expiredBefore)
  const runs = store.all(
    `SELECT id, ended_at, usage_input, usage_cache_read, usage_cache_write, usage_output
       FROM runs WHERE ended_at IS NOT NULL AND ended_at >= ?`,
    since,
  )
  const summary = {
    checkedAt: nowIso(),
    runsChecked: runs.length,
    runsWithEvents: 0,
    missingUsage: 0,
    expiredUsage: 0,
    mismatched: 0,
    repaired: 0,
  }
  for (const run of runs) {
    const events = store.get(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
              COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
              COALESCE(SUM(output_tokens), 0) AS output
         FROM usage_events WHERE run_id = ?`,
      run.id,
    )
    const calls = Number(events?.calls ?? 0)
    const eventTokens = Number(events?.input ?? 0) + Number(events?.cacheRead ?? 0)
      + Number(events?.cacheWrite ?? 0) + Number(events?.output ?? 0)
    const runTokens = Number(run.usage_input ?? 0) + Number(run.usage_cache_read ?? 0)
      + Number(run.usage_cache_write ?? 0) + Number(run.usage_output ?? 0)
    let status = 'ok'
    let note = ''
    if (calls > 0) {
      summary.runsWithEvents += 1
      if (runTokens !== eventTokens) {
        status = 'repaired'
        note = `运行表 ${runTokens} → 事件明细 ${eventTokens}`
        store.run(
          `UPDATE runs SET usage_input = ?, usage_cache_read = ?, usage_cache_write = ?, usage_output = ?
            WHERE id = ?`,
          Number(events?.input ?? 0),
          Number(events?.cacheRead ?? 0),
          Number(events?.cacheWrite ?? 0),
          Number(events?.output ?? 0),
          run.id,
        )
        summary.repaired += 1
        summary.mismatched += 1
      }
    } else if (runTokens > 0) {
      const endedAt = toMillis(run.ended_at)
      if (expiredAt !== null && endedAt !== null && endedAt < expiredAt) {
        // 明细早于保留期边界被清理：属于过期，不是数据丢失。
        status = 'expired'
        note = '用量明细已按保留期清理'
        summary.expiredUsage += 1
      } else {
        status = 'missing'
        note = '运行表有用量但缺少用量明细'
        summary.missingUsage += 1
        summary.mismatched += 1
      }
    }
    store.run(
      `INSERT INTO usage_reconciliation(id, run_id, event_calls, event_tokens, run_tokens, delta_tokens, status, note, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET event_calls = excluded.event_calls, event_tokens = excluded.event_tokens,
         run_tokens = excluded.run_tokens, delta_tokens = excluded.delta_tokens, status = excluded.status,
         note = excluded.note, checked_at = excluded.checked_at`,
      id('rec'),
      run.id,
      calls,
      eventTokens,
      runTokens,
      eventTokens - runTokens,
      status,
      note,
      summary.checkedAt,
    )
  }
  return summary
}

// 数据保留：按天清理明细与事件，审计与聚合结果保留。
// 返回值里带上每类清理的时间边界（before = 被删掉内容的时间上界，ISO 字符串），
// 调用方可以把 usage.before 传给 reconcileUsage，让「明细被清理」的 run 判为 expired。
export function applyRetention(store, {
  usageDays = 0,
  runEventDays = 0,
  messageDays = 0,
  reconciliationDays = 30,
} = {}) {
  const removed = {
    usageEvents: 0,
    runEvents: 0,
    runTrajectory: 0,
    messages: 0,
    soloMessages: 0,
    reconciliationRecords: 0,
    usage: { removed: 0, before: null },
    reconciliation: { removed: 0, before: null },
  }
  const cutoff = days => new Date(Date.now() - days * 86_400_000).toISOString()
  if (usageDays > 0) {
    const before = cutoff(usageDays)
    removed.usageEvents = store.run('DELETE FROM usage_events WHERE occurred_at < ?', before).changes
    removed.usage = { removed: removed.usageEvents, before }
  }
  if (runEventDays > 0) {
    removed.runEvents = store.run('DELETE FROM run_events WHERE created_at < ?', cutoff(runEventDays)).changes
    removed.runTrajectory = store.run('DELETE FROM run_trajectory WHERE created_at < ?', cutoff(runEventDays)).changes
  }
  if (messageDays > 0) {
    removed.messages = store.run('DELETE FROM messages WHERE created_at < ?', cutoff(messageDays)).changes
    removed.soloMessages = store.run('DELETE FROM solo_messages WHERE created_at < ?', cutoff(messageDays)).changes
  }
  if (reconciliationDays > 0) {
    // 对账记录同样按保留期清理，避免 usage_reconciliation 无限增长。
    const before = cutoff(reconciliationDays)
    removed.reconciliationRecords = store.run('DELETE FROM usage_reconciliation WHERE checked_at < ?', before).changes
    removed.reconciliation = { removed: removed.reconciliationRecords, before }
  }
  return removed
}

const CSV_COLUMNS = [
  'occurred_at', 'project_key', 'project_name', 'bot_name', 'run_id', 'task_id',
  'provider', 'model', 'purpose', 'currency',
  'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens',
  'input_cost', 'output_cost', 'total_cost',
]

function csvCell(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function exportUsageCsv(store, { projectId = null, soloBotId = null, days = 30, window = null } = {}) {
  // 时间窗口径（DSHBOTS-121）：导出跟随页面选中的窗口；至今窗口没有下界，不加时间过滤。
  const resolved = window ? resolveUsageWindow(window) : null
  const since = resolved ? resolved.since : new Date(Date.now() - days * 86_400_000).toISOString()
  const filters = []
  const params = []
  if (since) {
    filters.push('u.occurred_at >= ?')
    params.push(since)
  }
  if (projectId) {
    filters.push('u.project_id = ?')
    params.push(projectId)
  }
  // 单聊口径：该 Bot 的项目外明细，与用量页 solo 口径一致。
  if (soloBotId) {
    filters.push('u.bot_id = ?', 'u.project_id IS NULL')
    params.push(soloBotId)
  }
  const rows = store.all(
    `SELECT u.occurred_at AS occurred_at, u.run_id AS run_id, u.task_id AS task_id,
            u.provider AS provider, u.model AS model, u.purpose AS purpose, u.currency AS currency,
            u.input_tokens AS input_tokens, u.cache_read_tokens AS cache_read_tokens,
            u.cache_write_tokens AS cache_write_tokens, u.output_tokens AS output_tokens,
            u.reasoning_tokens AS reasoning_tokens, u.input_cost AS input_cost,
            u.output_cost AS output_cost, u.total_cost AS total_cost,
            p.key AS project_key, p.name AS project_name, b.name AS bot_name
       FROM usage_events u
       LEFT JOIN projects p ON p.id = u.project_id
       LEFT JOIN bots b ON b.id = u.bot_id
       ${filterClause(filters)}
      ORDER BY u.occurred_at`,
    ...params,
  )
  // 与用量页同口径：入库时未计价的明细按当前价目追认后再导出，避免页面与导出不一致。
  const prices = currentPriceMap(store)
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    const price = row.total_cost === null ? lookupPrice(prices, row.provider, row.model) : null
    const costs = price ? costForTokens(price, {
      input: Number(row.input_tokens ?? 0),
      cacheRead: Number(row.cache_read_tokens ?? 0),
      cacheWrite: Number(row.cache_write_tokens ?? 0),
      output: Number(row.output_tokens ?? 0),
    }) : null
    // 追认出来的金额按价目币种记，不用入库时的占位币种。
    const currency = price ? String(price.currency ?? BUDGET_CURRENCY) : row.currency
    lines.push(CSV_COLUMNS.map(column => {
      if (column === 'currency') return csvCell(currency)
      if (column === 'input_cost') return csvCell(costs ? costs.inputCost : row.input_cost)
      if (column === 'output_cost') return csvCell(costs ? costs.outputCost : row.output_cost)
      if (column === 'total_cost') return csvCell(costs ? costs.totalCost : row.total_cost)
      return csvCell(row[column])
    }).join(','))
  }
  return lines.join('\n')
}
