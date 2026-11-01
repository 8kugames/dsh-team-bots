import { effectivePrice } from './pricing.js'
import { id, nowIso } from './util.js'

const count = value => (Number.isSafeInteger(value) && value > 0 ? value : 0)

export const BUDGET_CURRENCY = 'CNY'

function currentPrice(store, provider, model) {
  return effectivePrice(store, provider, model)
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
    inputCost = (input / 1_000_000) * price.input_per_mtok
      + (cacheRead / 1_000_000) * price.cache_read_per_mtok
      + (cacheWrite / 1_000_000) * price.cache_write_per_mtok
    outputCost = (output / 1_000_000) * price.output_per_mtok
    totalCost = inputCost + outputCost
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

function costBreakdown(store, where, params, budgetCurrency) {
  const rows = store.all(
    `SELECT u.currency AS currency, SUM(u.total_cost) AS cost
       FROM usage_events u ${where ? `${where} AND` : 'WHERE'} u.total_cost IS NOT NULL
      GROUP BY u.currency`,
    ...params,
  )
  const costByCurrency = {}
  for (const row of rows) {
    costByCurrency[String(row.currency ?? BUDGET_CURRENCY)] = Number(row.cost ?? 0)
  }
  const cost = costByCurrency[budgetCurrency] ?? null
  return { cost, costByCurrency }
}

function mapTotals(row, breakdown = { cost: null, costByCurrency: {} }, pricedCalls = 0) {
  const input = Number(row?.input_tokens ?? 0)
  const cacheRead = Number(row?.cache_read_tokens ?? 0)
  const cacheWrite = Number(row?.cache_write_tokens ?? 0)
  const output = Number(row?.output_tokens ?? 0)
  const reasoning = Number(row?.reasoning_tokens ?? 0)
  const calls = Number(row?.calls ?? 0)
  return {
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: input + cacheRead + cacheWrite + output + reasoning,
    calls,
    cost: breakdown.cost,
    costByCurrency: breakdown.costByCurrency,
    costConfigured: pricedCalls > 0,
    pricedCalls,
    unpricedCalls: Math.max(calls - pricedCalls, 0),
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
}

// 单条件聚合：token 与调用次数 + 成本分币种。
export function aggregateUsage(store, filters = [], params = [], budgetCurrency = BUDGET_CURRENCY) {
  const where = filterClause(filters)
  const row = store.get(`SELECT ${AGGREGATES} FROM usage_events u ${where}`, ...params)
  const breakdown = costBreakdown(store, where, params, budgetCurrency)
  const pricedCalls = store.get(
    `SELECT COUNT(*) AS count FROM usage_events u ${where ? `${where} AND` : 'WHERE'} u.total_cost IS NOT NULL`,
    ...params,
  )?.count ?? 0
  return mapTotals(row, breakdown, Number(pricedCalls))
}

export function runUsageTotals(store, runId, budgetCurrency = BUDGET_CURRENCY) {
  return aggregateUsage(store, ['u.run_id = ?'], [runId], budgetCurrency)
}

function byBotRows(store, filters, params, budgetCurrency) {
  const where = filterClause(filters)
  const rows = store.all(
    `SELECT u.bot_id AS bot_id, b.name AS name, ${AGGREGATES},
            SUM(CASE WHEN u.total_cost IS NULL THEN 0 ELSE 1 END) AS priced_calls
       FROM usage_events u JOIN bots b ON b.id = u.bot_id ${where}
      GROUP BY u.bot_id, b.name
      ORDER BY input_tokens + output_tokens DESC`,
    ...params,
  )
  return rows.map(row => {
    const breakdown = costBreakdown(store, `${where}${where ? ' AND' : ' WHERE'} u.bot_id = ?`, [...params, row.bot_id], budgetCurrency)
    return { botId: row.bot_id, name: row.name, ...mapTotals(row, breakdown, Number(row.priced_calls ?? 0)) }
  })
}

function byProjectRows(store, filters, params, budgetCurrency) {
  const where = filterClause(filters)
  const rows = store.all(
    `SELECT u.project_id AS project_id, p.name AS name, p.key AS key, ${AGGREGATES},
            SUM(CASE WHEN u.total_cost IS NULL THEN 0 ELSE 1 END) AS priced_calls
       FROM usage_events u JOIN projects p ON p.id = u.project_id ${where}
      GROUP BY u.project_id, p.name, p.key
      ORDER BY input_tokens + output_tokens DESC`,
    ...params,
  )
  return rows.map(row => {
    const breakdown = costBreakdown(store, `${where}${where ? ' AND' : ' WHERE'} u.project_id = ?`, [...params, row.project_id], budgetCurrency)
    return { projectId: row.project_id, name: row.name, key: row.key, ...mapTotals(row, breakdown, Number(row.priced_calls ?? 0)) }
  })
}

function byModelRows(store, filters, params, budgetCurrency) {
  const where = filterClause(filters)
  const rows = store.all(
    `SELECT u.provider AS provider, u.model AS model, ${AGGREGATES},
            SUM(CASE WHEN u.total_cost IS NULL THEN 0 ELSE 1 END) AS priced_calls
       FROM usage_events u ${where}
      GROUP BY u.provider, u.model
      ORDER BY input_tokens + output_tokens DESC`,
    ...params,
  )
  return rows.map(row => {
    const breakdown = costBreakdown(store, `${where}${where ? ' AND' : ' WHERE'} u.provider = ? AND u.model = ?`, [...params, row.provider, row.model], budgetCurrency)
    return { provider: row.provider, model: row.model, ...mapTotals(row, breakdown, Number(row.priced_calls ?? 0)) }
  })
}

function byDayRows(store, filters, params, budgetCurrency) {
  const where = filterClause(filters)
  const rows = store.all(
    `SELECT substr(u.occurred_at, 1, 10) AS day, ${AGGREGATES},
            SUM(CASE WHEN u.total_cost IS NULL THEN 0 ELSE 1 END) AS priced_calls
       FROM usage_events u ${where}
      GROUP BY day ORDER BY day`,
    ...params,
  )
  return rows.map(row => {
    const breakdown = costBreakdown(store, `${where}${where ? ' AND' : ' WHERE'} substr(u.occurred_at, 1, 10) = ?`, [...params, row.day], budgetCurrency)
    return { day: row.day, ...mapTotals(row, breakdown, Number(row.priced_calls ?? 0)) }
  })
}

function tierSet(store, filters, params, budgetCurrency) {
  return {
    byBot: byBotRows(store, filters, params, budgetCurrency),
    byProject: byProjectRows(store, filters, params, budgetCurrency),
    byModel: byModelRows(store, filters, params, budgetCurrency),
    byDay: byDayRows(store, filters, params, budgetCurrency),
  }
}

export function usageSnapshot(store, projectId, days = 30, options = {}) {
  const budgetCurrency = String(options.currency ?? BUDGET_CURRENCY).toUpperCase() || BUDGET_CURRENCY
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const globalFilters = ['u.occurred_at >= ?']
  const globalParams = [since]
  const projectFilters = ['u.occurred_at >= ?', 'u.project_id = ?']
  const projectParams = [since, projectId]
  const global = aggregateUsage(store, globalFilters, globalParams, budgetCurrency)
  const project = projectId ? aggregateUsage(store, projectFilters, projectParams, budgetCurrency) : { ...ZERO_TOTALS }
  const globalTiers = tierSet(store, globalFilters, globalParams, budgetCurrency)
  const projectTiers = projectId ? tierSet(store, projectFilters, projectParams, budgetCurrency) : null
  const cutoff = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10)
  const dayFilters = ['substr(u.occurred_at, 1, 10) >= ?']
  const dayParams = [cutoff]
  globalTiers.byDay = byDayRows(store, [...globalFilters, ...dayFilters], [...globalParams, ...dayParams], budgetCurrency)
  if (projectTiers) {
    projectTiers.byDay = byDayRows(store, [...projectFilters, ...dayFilters], [...projectParams, ...dayParams], budgetCurrency)
  }
  const priceCount = store.get(
    "SELECT COUNT(DISTINCT provider || '|' || lower(model)) AS count FROM model_prices",
  )?.count ?? 0
  return {
    days,
    currency: budgetCurrency,
    global,
    project,
    scope: { global, project },
    byBot: globalTiers.byBot,
    byProject: globalTiers.byProject,
    byModel: globalTiers.byModel,
    byDay: globalTiers.byDay,
    scopeTiers: { global: globalTiers, project: projectTiers },
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
            SUM(CASE WHEN status = 'repaired' THEN 1 ELSE 0 END) AS repaired,
            MAX(checked_at) AS checked_at
       FROM usage_reconciliation`,
  )
  return {
    checkedAt: row?.checked_at ?? null,
    runsChecked: Number(row?.runs_checked ?? 0),
    runsWithEvents: Number(row?.ok_runs ?? 0) + Number(row?.repaired ?? 0),
    missingUsage: Number(row?.missing_usage ?? 0),
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
export function reconcileUsage(store, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const runs = store.all(
    `SELECT id, usage_input, usage_cache_read, usage_cache_write, usage_output
       FROM runs WHERE ended_at IS NOT NULL AND ended_at >= ?`,
    since,
  )
  const summary = {
    checkedAt: nowIso(),
    runsChecked: runs.length,
    runsWithEvents: 0,
    missingUsage: 0,
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
      status = 'missing'
      note = '运行表有用量但缺少用量明细'
      summary.missingUsage += 1
      summary.mismatched += 1
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
export function applyRetention(store, { usageDays = 0, runEventDays = 0, messageDays = 0 } = {}) {
  const removed = { usageEvents: 0, runEvents: 0, runTrajectory: 0, messages: 0, soloMessages: 0 }
  const cutoff = days => new Date(Date.now() - days * 86_400_000).toISOString()
  if (usageDays > 0) {
    removed.usageEvents = store.run('DELETE FROM usage_events WHERE occurred_at < ?', cutoff(usageDays)).changes
  }
  if (runEventDays > 0) {
    removed.runEvents = store.run('DELETE FROM run_events WHERE created_at < ?', cutoff(runEventDays)).changes
    removed.runTrajectory = store.run('DELETE FROM run_trajectory WHERE created_at < ?', cutoff(runEventDays)).changes
  }
  if (messageDays > 0) {
    removed.messages = store.run('DELETE FROM messages WHERE created_at < ?', cutoff(messageDays)).changes
    removed.soloMessages = store.run('DELETE FROM solo_messages WHERE created_at < ?', cutoff(messageDays)).changes
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

export function exportUsageCsv(store, { projectId = null, days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const filters = ['u.occurred_at >= ?']
  const params = [since]
  if (projectId) {
    filters.push('u.project_id = ?')
    params.push(projectId)
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
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map(column => csvCell(row[column])).join(','))
  }
  return lines.join('\n')
}
