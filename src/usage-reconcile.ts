// src/usage-reconcile.js —— 用量对账、留存与导出域
// 覆盖对账摘要、价目设置、月度用量、运行明细对账、保留期清理与 CSV 导出。
// 用量明细记录、聚合与窗口解析见 ./usage.js。

import { BUDGET_CURRENCY, aggregateUsage, clearUsageSnapshotCache, costForTokens, filterClause, resolveUsageWindow } from './usage.js'
import { currentPriceMap, lookupPrice } from './pricing.js'
import { id, nowIso } from './util.js'

// 时间边界归一：接受 ISO 字符串或毫秒时间戳，无法解析时返回 null。
function toMillis(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
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
  if (vals.slice(0, 4).some(value => !Number.isFinite(value) || value as number < 0)) throw new Error('价格必须是非负数')
  if (existing) {
    store.run(
      `UPDATE model_prices SET input_per_mtok = ?, cache_read_per_mtok = ?, cache_write_per_mtok = ?,
       output_per_mtok = ?, currency = ? WHERE id = ?`,
      ...vals, existing.id,
    )
    clearUsageSnapshotCache()
    return existing.id
  }
  const priceId = id('price')
  store.run(
    `INSERT INTO model_prices(id, provider, model, input_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
       output_per_mtok, currency, effective_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    priceId, provider, model, ...vals, effectiveAt,
  )
  clearUsageSnapshotCache()
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
  // 对账写回后立即失效快照缓存：否则页面会拿旧对账摘要显示 30s，用户会以为对账没生效。
  clearUsageSnapshotCache()
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
  // 保留期清理会删明细与对账记录，清缓存避免页面继续显示已删数据。
  clearUsageSnapshotCache()
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
