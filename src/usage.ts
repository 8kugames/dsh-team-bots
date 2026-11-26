import { currentPriceMap, effectivePrice, lookupPrice } from './pricing.js'
import { id, nowIso } from './util.js'

const count = value => (Number.isSafeInteger(value) && value > 0 ? value : 0)

export const BUDGET_CURRENCY = 'CNY'

function currentPrice(store, provider, model) {
  return effectivePrice(store, provider, model)
}

// 单条明细成本：输入侧（含缓存读写）+ 输出侧，按每百万 token 计价。
// recordUsage 入库与事后追认共用同一公式，保证两条口径算出的金额一致。
// 导出给 ./usage-reconcile.js 的 CSV 追认口径复用，避免两处各写一份公式。
export function costForTokens(price, tokens = {} as any) {
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
  chatStore = null,
}) {
  if (!usage || typeof usage !== 'object') return null
  const input = count(usage.inputTokens ?? usage.input)
  const cacheRead = count(usage.cacheReadTokens ?? usage.cache_read)
  const cacheWrite = count(usage.cacheWriteTokens ?? usage.cache_write)
  const output = count(usage.outputTokens ?? usage.output)
  const reasoning = count(usage.reasoningTokens ?? usage.reasoning)
  if (input + cacheRead + cacheWrite + output + reasoning === 0) return null
  // 明细住运行归属的聊天库（chat-db-split Phase 2）；未注入路由（测试/独立构造）回落顶库。
  const detailStore = chatStore ?? store
  const existing = detailStore.get('SELECT * FROM usage_events WHERE source_key = ?', sourceKey)
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
  detailStore.run(
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
  // 顶库小时汇总同步累加（视图/预算只读这里）；project_key 冗余存档，项目移除后不丢账。
  const projectId = run?.project_id ?? null
  const projectKey = projectId
    ? String(store.get('SELECT key FROM projects WHERE id = ?', projectId)?.key ?? '')
    : ''
  store.run(
    `INSERT INTO usage_rollup(hour_utc, project_id, project_key, bot_id, provider, model, currency, priced,
        calls, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, stored_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hour_utc, project_id, bot_id, provider, model, currency, priced) DO UPDATE SET
       calls = calls + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
       stored_cost = stored_cost + excluded.stored_cost`,
    String(occurredAt).slice(0, 13),
    projectId ?? '',
    projectKey,
    run?.bot_id ?? '',
    provider ?? '',
    model ?? '',
    currency,
    totalCost === null ? 0 : 1,
    input, cacheRead, cacheWrite, output, reasoning,
    totalCost ?? 0,
  )
  return detailStore.get('SELECT * FROM usage_events WHERE id = ?', eventId)
}

// —— 汇总读层（chat-db-split Phase 2）——
// 视图/预算全部走顶库 usage_rollup（小时粒度）：滚动窗口最多带进边界处的
// 不足一小时用量；日历日/月度分组按小时桶换算，与明细口径一致。
// project_id/bot_id 空串哨兵对应「无归属」。

const ROLLUP_TOKENS = `
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(calls), 0) AS calls`

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
// 导出给 ./usage-reconcile.js 的导出/对账口径复用。
export function filterClause(filters) {
  const list = filters.filter(Boolean)
  return list.length ? `WHERE ${list.join(' AND ')}` : ''
}

// 在既有 where 上追加分组条件：where 为空时补 WHERE，否则接 AND。
function andClause(where, clause) {
  return `${where ? `${where} AND` : 'WHERE'} ${clause}`
}

// 计价状态聚合：与 AGGREGATES 分开——它只服务成本 breakdown，按 (currency, provider, model) 归集。
const BREAKDOWN_AGGREGATES = `
  SUM(CASE WHEN u.total_cost IS NOT NULL THEN 1 ELSE 0 END) AS priced_calls,
  SUM(CASE WHEN u.total_cost IS NULL THEN 1 ELSE 0 END) AS null_calls,
  COALESCE(SUM(CASE WHEN u.total_cost IS NOT NULL THEN u.total_cost ELSE 0 END), 0) AS stored_cost,
  COALESCE(SUM(CASE WHEN u.total_cost IS NULL THEN u.input_tokens ELSE 0 END), 0) AS null_input_tokens,
  COALESCE(SUM(CASE WHEN u.total_cost IS NULL THEN u.cache_read_tokens ELSE 0 END), 0) AS null_cache_read_tokens,
  COALESCE(SUM(CASE WHEN u.total_cost IS NULL THEN u.cache_write_tokens ELSE 0 END), 0) AS null_cache_write_tokens,
  COALESCE(SUM(CASE WHEN u.total_cost IS NULL THEN u.output_tokens ELSE 0 END), 0) AS null_output_tokens,
  COALESCE(SUM(CASE WHEN u.total_cost IS NULL THEN u.reasoning_tokens ELSE 0 END), 0) AS null_reasoning_tokens`

const EMPTY_BREAKDOWN = { cost: null, costByCurrency: {}, pricedCalls: 0, unpricedCalls: 0, unpricedTokens: 0 }

// 分组行 → breakdown：已计价明细用入库时算死的成本，未计价（total_cost IS NULL）按当前价目表
// 补算；能追认的计入 priced，仍无价可追认的才是真未计价。抽出来给「单次全量查询」与
// 「分维度预取」共用，避免同一套金额口径在两处各写一遍。
function mergeBreakdownRows(rows, priceMap, budgetCurrency) {
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
    pricedCalls += priced + nullCalls
  }
  return {
    cost: costByCurrency[budgetCurrency] ?? null,
    costByCurrency,
    pricedCalls,
    unpricedCalls,
    unpricedTokens,
  }
}

// 成本聚合（含追认）：整段 scope 一次查完，按 (currency, provider, model) 分组后交给
// mergeBreakdownRows 折算。where 形态由调用方给（分档维度的逐组条件或空）。
function costBreakdown(store, where, params, budgetCurrency, prices = null, join = '') {
  const rows = store.all(
    `SELECT u.currency AS currency, u.provider AS provider, u.model AS model, ${BREAKDOWN_AGGREGATES}
       FROM usage_events u ${join} ${where}
      GROUP BY u.currency, u.provider, u.model`,
    ...params,
  )
  return mergeBreakdownRows(rows, prices ?? currentPriceMap(store), budgetCurrency)
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
// join 为可选的 JOIN 子句（任务级口径需要 LEFT JOIN runs 追认历史 task_id，见 taskUsageTotals）。
export function aggregateUsage(store, filters = [], params = [], budgetCurrency = BUDGET_CURRENCY, prices = null, join = '') {
  const where = filterClause(filters)
  const row = store.get(`SELECT ${AGGREGATES} FROM usage_events u ${join} ${where}`, ...params)
  const breakdown = costBreakdown(store, where, params, budgetCurrency, prices, join)
  return mapTotals(row, breakdown)
}

// priceStore：价目表所在库（顶库）。明细聚合跑在聊天库上，model_prices 不在聊天库里。
export function runUsageTotals(store, runId, budgetCurrency = BUDGET_CURRENCY, priceStore = null) {
  const prices = currentPriceMap(priceStore ?? store)
  return aggregateUsage(store, ['u.run_id = ?'], [runId], budgetCurrency, prices)
}

// —— 任务级 usage 聚合
// 口径：一个任务端到端花多少 token。明细按 task_id 归因（lifecycle 记账随 run 透传；
// chat-db-split Phase 2 迁移把历史 NULL 行经顶库 runs 一次性回填），调用方传任务
// 所属项目的聊天库（明细住那里），不再 JOIN runs——聊天库里没有 runs 表。
// 覆盖该任务全部运行：成功交付、失败重试（attempt 递增仍同 run 行）、核验/受阻处理
// 派生运行（task_id 相同）——「端到端成本」即该任务名下发生过的一切模型消费。
// 缓存 token 分列（cache_read/cache_write），计价沿用 costForTokens 既有口径，不另算。
export function taskUsageTotals(store, taskId, budgetCurrency = BUDGET_CURRENCY, priceStore = null) {
  const prices = currentPriceMap(priceStore ?? store)
  return aggregateUsage(store, ['u.task_id = ?'], [taskId], budgetCurrency, prices)
}

// 任务子树 id 集（含自身）：沿 tasks.parent_task_id 下钻全部后代。
// UNION（非 UNION ALL）天然去重：即使脏数据造出环也会收敛终止。
export function taskSubtreeIds(store, taskId) {
  const rows = store.all(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM tasks WHERE id = ?
       UNION
       SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id
     ) SELECT id FROM tree`,
    taskId,
  )
  return rows.map(row => row.id)
}

// 含子树的任务级口径：主项 + 全部后代子卡一并聚合。
// 拆分划算判定（C_removed > C_introduced）用它与「同类整卡任务」的 taskUsageTotals
// 对比：拆分后总成本 = 主项 usageTotal（含子卡），拆掉的是串行等待，引入的是每卡的
// 会话预热/交接重复上下文——两个口径都含缓存 token 分列，可直接看输入侧增量。
export function taskTreeUsageTotals(store, taskId, budgetCurrency = BUDGET_CURRENCY, subtreeIds = null, priceStore = null) {
  const ids = subtreeIds ?? taskSubtreeIds(store, taskId)
  if (!ids.length) return { ...ZERO_TOTALS }
  const marks = `(${ids.map(() => '?').join(', ')})`
  const prices = currentPriceMap(priceStore ?? store)
  return aggregateUsage(store, [`u.task_id IN ${marks}`], ids, budgetCurrency, prices)
}

// 用量时间窗：今日 / 7 日 / 30 日 / 至今 四档。
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
  const parts: any = {}
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
export function resolveUsageWindow(key, options = {} as any) {
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

// 小时桶列（'YYYY-MM-DDTHH'）的日历日表达式：与 dayExpression 同口径，
// 但要补 ':00:00' 才是 SQLite datetime 认的完整时刻。
function hourDayExpression(column, offsetMinutes) {
  if (offsetMinutes === null || offsetMinutes === undefined) return `substr(${column}, 1, 10)`
  const sign = offsetMinutes < 0 ? '-' : '+'
  return `substr(datetime(substr(replace(${column}, 'T', ' '), 1, 13) || ':00:00', '${sign}${Math.abs(offsetMinutes)} minutes'), 1, 10)`
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
    filters.push('u.hour_utc >= ?')
    params.push(String(scope.since).slice(0, 13))
  }
  if (scope.projectId) {
    filters.push('u.project_id = ?')
    params.push(scope.projectId)
  }
  // 单聊口径：该 Bot 的项目外用量，与 view.solo.runs 同口径。
  if (scope.soloBotId) {
    filters.push('u.bot_id = ?', "u.project_id = ''")
    params.push(scope.soloBotId)
  }
  // 至今窗口没有时间下界时可能一条条件都不剩，补一条恒真条件，保证 where 子句非空。
  if (!filters.length) filters.push('1 = 1')
  return { filters, params }
}

// 运行窗口：结束、开始、入队任一时间落在窗口内即视为「窗口内跑过」。
const RUN_IN_WINDOW = 'COALESCE(r.ended_at, r.started_at, r.queued_at) >= ?'

// 至今窗口没有下界：运行过滤条件退化为恒真。
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
  // 用 EXISTS 逐 bot 判定，不 JOIN runs：JOIN 会按「窗口内运行数 × bot」放大行数，
  // 每个组合再跑一次相关子查询（旧版实测 5.8s）。bots 数量小，两次索引查找即可。
  const rows = store.all(
    `SELECT b.id AS bot_id, b.name AS name
       FROM bots b
      WHERE EXISTS (
              SELECT 1 FROM runs r
               WHERE r.bot_id = b.id
                 ${runFilters.length ? `AND ${runFilters.join(' AND ')}` : ''} AND ${runWindow.clause}
            )
        AND NOT EXISTS (
              SELECT 1 FROM usage_rollup u
               WHERE u.bot_id = b.id${eventFilters.length ? ` AND ${eventFilters.join(' AND ')}` : ''}
            )
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
          SELECT 1 FROM usage_rollup u WHERE u.project_id = p.id${eventFilters.length ? ` AND ${eventFilters.join(' AND ')}` : ''}
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
  const eventDay = hourDayExpression('u.hour_utc', scope.offsetMinutes)
  const rows = store.all(
    `SELECT d.day AS day FROM (
        SELECT DISTINCT ${runDay} AS day
          FROM runs r
         WHERE ${runFilters.length ? `${runFilters.join(' AND ')} AND` : ''} ${runWindow.clause}
       ) d
      WHERE ${daySince ? 'd.day >= ? AND' : ''} NOT EXISTS (
        SELECT 1 FROM usage_rollup u
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
    `SELECT u.bot_id AS bot_id, b.name AS name, ${ROLLUP_TOKENS}
       FROM usage_rollup u LEFT JOIN bots b ON b.id = u.bot_id ${where}
      GROUP BY u.bot_id, b.name
      ORDER BY input_tokens + output_tokens DESC`,
    ...params,
  )
  const breakdowns = breakdownByDimension(store, scope, 'u.bot_id', budgetCurrency, prices)
  const used = rows.map(row => {
    const breakdown = breakdowns.get(String(row.bot_id)) ?? EMPTY_BREAKDOWN
    return { botId: row.bot_id, name: row.name, ...mapTotals(row, breakdown) }
  })
  return [...used, ...zeroUsageBotRows(store, scope, budgetCurrency)]
}

function byProjectRows(store, scope, budgetCurrency, prices = null) {
  const { filters, params } = scopeFilters(scope)
  const where = filterClause(filters)
  const rows = store.all(
    `SELECT u.project_id AS project_id, p.name AS name, COALESCE(p.key, u.project_key) AS key, ${ROLLUP_TOKENS}
       FROM usage_rollup u LEFT JOIN projects p ON p.id = u.project_id ${where}
      GROUP BY u.project_id, p.name, p.key
      ORDER BY input_tokens + output_tokens DESC`,
    ...params,
  )
  const breakdowns = breakdownByDimension(store, scope, 'u.project_id', budgetCurrency, prices)
  const used = rows.map(row => {
    const breakdown = breakdowns.get(String(row.project_id)) ?? EMPTY_BREAKDOWN
    return { projectId: row.project_id, name: row.name, key: row.key, ...mapTotals(row, breakdown) }
  })
  return [...used, ...zeroUsageProjectRows(store, scope, budgetCurrency)]
}

// 模型维度来自明细本身，无法归集「跑过但零用量」的 run，因此只有事件行。
function byModelRows(store, scope, budgetCurrency, prices = null) {
  const { filters, params } = scopeFilters(scope)
  const where = filterClause(filters)
  const rows = store.all(
    `SELECT u.provider AS provider, u.model AS model, ${ROLLUP_TOKENS}
       FROM usage_rollup u ${where}
      GROUP BY u.provider, u.model
      ORDER BY input_tokens + output_tokens DESC`,
    ...params,
  )
  const breakdowns = breakdownByDimension(store, scope, "u.provider || '|' || u.model", budgetCurrency, prices)
  return rows.map(row => {
    const breakdown = breakdowns.get(`${row.provider}|${row.model}`) ?? EMPTY_BREAKDOWN
    return { provider: row.provider, model: row.model, ...mapTotals(row, breakdown) }
  })
}

function byDayRows(store, scope, budgetCurrency, daySince = null, prices = null) {
  const { filters, params } = scopeFilters(scope)
  const dayExpr = hourDayExpression('u.hour_utc', scope.offsetMinutes)
  const allFilters = daySince ? [...filters, `${dayExpr} >= ?`] : filters
  const allParams = daySince ? [...params, daySince] : params
  const where = filterClause(allFilters)
  const rows = store.all(
    `SELECT ${dayExpr} AS day, ${ROLLUP_TOKENS}
       FROM usage_rollup u ${where}
      GROUP BY day ORDER BY day`,
    ...allParams,
  )
  const breakdowns = breakdownByDimension(store, scope, dayExpr, budgetCurrency, prices)
  const used = rows.map(row => {
    const breakdown = breakdowns.get(String(row.day)) ?? EMPTY_BREAKDOWN
    return { day: row.day, ...mapTotals(row, breakdown) }
  })
  return [...used, ...zeroUsageDayRows(store, scope, budgetCurrency, daySince)]
}

// 分维度 breakdown 预取：旧口径在每个分组内各调一次 costBreakdown，每次都要扫一遍窗口明细
// （30 天窗口 × global/project 两套分档 = 上百次全表扫描，实测约 6.5s）。这里按
// 「维度值 + currency + provider + model」一次聚合，再在内存里归并出各维度值的同一份 breakdown。
function breakdownByDimension(store, scope, dimensionExpr, budgetCurrency, prices = null) {
  const { filters, params } = scopeFilters(scope)
  const rows = store.all(
    `SELECT ${dimensionExpr} AS dim, u.currency AS currency, u.provider AS provider, u.model AS model,
            SUM(CASE WHEN u.priced = 1 THEN u.calls ELSE 0 END) AS priced_calls,
            SUM(CASE WHEN u.priced = 0 THEN u.calls ELSE 0 END) AS null_calls,
            COALESCE(SUM(u.stored_cost), 0) AS stored_cost,
            COALESCE(SUM(CASE WHEN u.priced = 0 THEN u.input_tokens ELSE 0 END), 0) AS null_input_tokens,
            COALESCE(SUM(CASE WHEN u.priced = 0 THEN u.cache_read_tokens ELSE 0 END), 0) AS null_cache_read_tokens,
            COALESCE(SUM(CASE WHEN u.priced = 0 THEN u.cache_write_tokens ELSE 0 END), 0) AS null_cache_write_tokens,
            COALESCE(SUM(CASE WHEN u.priced = 0 THEN u.output_tokens ELSE 0 END), 0) AS null_output_tokens,
            COALESCE(SUM(CASE WHEN u.priced = 0 THEN u.reasoning_tokens ELSE 0 END), 0) AS null_reasoning_tokens
       FROM usage_rollup u ${filterClause(filters)}
      GROUP BY ${dimensionExpr}, u.currency, u.provider, u.model`,
    ...params,
  )
  const priceMap = prices ?? currentPriceMap(store)
  const grouped = new Map()
  for (const row of rows) {
    const key = String(row.dim)
    const bucket = grouped.get(key)
    if (bucket) bucket.push(row)
    else grouped.set(key, [row])
  }
  const out = new Map()
  for (const [key, bucket] of grouped) out.set(key, mergeBreakdownRows(bucket, priceMap, budgetCurrency))
  return out
}

function tierSet(store, scope, budgetCurrency, daySince = null, prices = null) {
  return {
    byBot: byBotRows(store, scope, budgetCurrency, prices),
    byProject: byProjectRows(store, scope, budgetCurrency, prices),
    byModel: byModelRows(store, scope, budgetCurrency, prices),
    byDay: byDayRows(store, scope, budgetCurrency, daySince, prices),
  }
}

// 汇总层通用聚合（scope 口径与月度预算共用）：token/调用数直读 usage_rollup，
// 成本含按当前价目表追认未计价部分，口径与明细版 mergeBreakdownRows 一致。
export function rollupTotals(store, filters = [], params = [], budgetCurrency = BUDGET_CURRENCY, prices = null) {
  const where = filterClause(filters)
  const row = store.get(`SELECT ${ROLLUP_TOKENS} FROM usage_rollup u ${where}`, ...params)
  const breakdownRows = store.all(
    `SELECT u.currency AS currency, u.provider AS provider, u.model AS model,
            SUM(CASE WHEN u.priced = 1 THEN u.calls ELSE 0 END) AS priced_calls,
            SUM(CASE WHEN u.priced = 0 THEN u.calls ELSE 0 END) AS null_calls,
            COALESCE(SUM(u.stored_cost), 0) AS stored_cost,
            COALESCE(SUM(CASE WHEN u.priced = 0 THEN u.input_tokens ELSE 0 END), 0) AS null_input_tokens,
            COALESCE(SUM(CASE WHEN u.priced = 0 THEN u.cache_read_tokens ELSE 0 END), 0) AS null_cache_read_tokens,
            COALESCE(SUM(CASE WHEN u.priced = 0 THEN u.cache_write_tokens ELSE 0 END), 0) AS null_cache_write_tokens,
            COALESCE(SUM(CASE WHEN u.priced = 0 THEN u.output_tokens ELSE 0 END), 0) as null_output_tokens,
            COALESCE(SUM(CASE WHEN u.priced = 0 THEN u.reasoning_tokens ELSE 0 END), 0) AS null_reasoning_tokens
       FROM usage_rollup u ${where}
      GROUP BY u.currency, u.provider, u.model`,
    ...params,
  )
  return mapTotals(row, mergeBreakdownRows(breakdownRows, prices ?? currentPriceMap(store), budgetCurrency))
}

function scopeUsage(store, scope, budgetCurrency, prices = null) {
  const { filters, params } = scopeFilters(scope)
  return rollupTotals(store, filters, params, budgetCurrency, prices)
}

// 日均折算用的实际天数：滚动窗口用窗口天数；至今用最早明细到今天跨过的天数。
function windowSpanDays(store, window) {
  if (Number.isFinite(window.days) && window.days > 0) return window.days
  const earliest = store.get('SELECT MIN(hour_utc) AS earliest FROM usage_rollup')?.earliest ?? null
  if (!earliest) return 1
  const from = Date.parse(`${String(earliest).slice(0, 13)}:00:00.000Z`)
  if (!Number.isFinite(from)) return 1
  return Math.max(1, Math.ceil((Date.now() - from) / DAY_MS))
}

// —— 用量快照缓存 ——
// state 每 2.8s 轮询一次，每次都跑 30d 全口径聚合（生产库实测约 500ms）。
// 这里加一层 TTL 缓存：同一组参数在 TTL 内直接复用，把 state 从 ~750ms 拉回几十毫秒。
//
// 口径：用量页默认最多滞后 30s；明细 / 对账 / 价目任一变更会立即失效缓存。
// 失效有两条通道，缺一不可：
// 1) 显式：写回方在改完数据后调 clearUsageSnapshotCache
//      （usage-reconcile.js 的 setPrice / reconcileUsage / applyRetention）。
//   2) 兜底：缓存项带「数据版本」，每次先算版本号，与缓存项不同就直接重算。
//      版本由三张会被写回的表推导，用于兜住漏挂钩子的路径（含 UPDATE 不改时间戳的情形，
//      例如 pricing.js 的 seedModelPrices 只 INSERT 新行、不改已有行的时间戳）。
const SNAPSHOT_CACHE_TTL_MS = 30_000
const SNAPSHOT_CACHE_MAX = 8

// 缓存按 store 分桶：测试里每个用例一个临时库，共用一张表会串味。
const snapshotCaches = new WeakMap()
const liveSnapshotCaches = new Set<any>()

function cacheFor(store) {
  let cache = snapshotCaches.get(store)
  if (!cache) {
    cache = new Map()
    snapshotCaches.set(store, cache)
    liveSnapshotCaches.add(cache)
  }
  return cache
}

function snapshotCacheKey(projectId, days, budgetCurrency, soloBotId, options) {
  return JSON.stringify([
    projectId ?? null,
    days,
    budgetCurrency,
    soloBotId ?? null,
    options.window ?? null,
    options.timeZone ?? null,
    options.now ?? null,
  ])
}

function snapshotDataVersion(store) {
  const events = store.get('SELECT COUNT(*) AS n, MAX(hour_utc) AS latest FROM usage_rollup') ?? {}
  const recon = store.get('SELECT runs_checked AS n, checked_at AS checkedAt FROM usage_recon_state WHERE id = 1') ?? {}
  const prices = store.get('SELECT COUNT(*) AS n, MAX(effective_at) AS effectiveAt FROM model_prices') ?? {}
  return [events.n, events.latest, recon.n, recon.checkedAt, prices.n, prices.effectiveAt].join(':')
}

// 写回方在改完明细 / 对账 / 价目后调用；测试也用它隔离用例。
export function clearUsageSnapshotCache() {
  for (const cache of liveSnapshotCaches) cache.clear()
}

export function usageSnapshot(store, projectId, days = 30, options = {} as any) {
  const budgetCurrency = String(options.currency ?? BUDGET_CURRENCY).toUpperCase() || BUDGET_CURRENCY
  const soloBotId = options.soloBotId ?? null
  const ttl = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : SNAPSHOT_CACHE_TTL_MS
  const key = snapshotCacheKey(projectId, days, budgetCurrency, soloBotId, options)
  const version = snapshotDataVersion(store)
  const cache = cacheFor(store)
  const hit = cache.get(key)
  if (hit && hit.version === version && ttl > 0 && Date.now() - hit.at < ttl) return hit.value
  const value = computeUsageSnapshot(store, projectId, days, { ...options, currency: budgetCurrency, soloBotId })
  cache.set(key, { version, at: Date.now(), value })
  // 有界：正常调用参数组合有限，仍兜底按插入序淘汰最旧项，防无界增长。
  while (cache.size > SNAPSHOT_CACHE_MAX) cache.delete(cache.keys().next().value)
  return value
}

function computeUsageSnapshot(store, projectId, days = 30, options = {} as any) {
  const budgetCurrency = String(options.currency ?? BUDGET_CURRENCY).toUpperCase() || BUDGET_CURRENCY
  const soloBotId = options.soloBotId ?? null
  // 时间窗口径：传 window 走四档窗口；不传时沿用旧的「近 N 天」滚动窗口。
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
  // 对账明细住各聊天库（chat-db-split Phase 2）；顶库 usage_recon_state 存每轮对账的
  // 权威计数，由 reconcileUsage 每轮整体覆写——摘要读它，不再扫明细表。
  const row = store.get('SELECT * FROM usage_recon_state WHERE id = 1')
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
