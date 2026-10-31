import { effectivePrice } from './pricing.js'
import { id, nowIso } from './util.js'

const count = value => (Number.isSafeInteger(value) && value > 0 ? value : 0)

function currentPrice(store, provider, model) {
  return effectivePrice(store, provider, model)
}

export function recordUsage(store, { sourceKey, run, provider, model, usage, occurredAt = nowIso(), purpose = 'run' }) {
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
  const eventId = id('use')
  store.run(
    `INSERT INTO usage_events(id, source_key, run_id, project_id, bot_id, provider, model, purpose,
       input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
       input_cost, output_cost, total_cost, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventId,
    sourceKey,
    run?.id ?? null,
    run?.project_id ?? null,
    run?.bot_id ?? null,
    provider ?? '',
    model ?? '',
    purpose,
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

export function runUsageTotals(store, runId) {
  const row = store.get(
    `SELECT
       COALESCE(SUM(input_tokens), 0) AS input,
       COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
       COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
       COALESCE(SUM(output_tokens), 0) AS output,
       COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
       CASE WHEN COUNT(total_cost) = 0 THEN NULL ELSE SUM(total_cost) END AS cost,
       COUNT(*) AS calls
     FROM usage_events WHERE run_id = ?`,
    runId,
  )
  return {
    input: Number(row?.input ?? 0),
    cacheRead: Number(row?.cacheRead ?? 0),
    cacheWrite: Number(row?.cacheWrite ?? 0),
    output: Number(row?.output ?? 0),
    reasoning: Number(row?.reasoning ?? 0),
    cost: row?.cost === null || row?.cost === undefined ? null : Number(row.cost),
    calls: Number(row?.calls ?? 0),
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
  costConfigured: false,
}

function mapTotals(row) {
  const input = Number(row?.input_tokens ?? 0)
  const cacheRead = Number(row?.cache_read_tokens ?? 0)
  const cacheWrite = Number(row?.cache_write_tokens ?? 0)
  const output = Number(row?.output_tokens ?? 0)
  const reasoning = Number(row?.reasoning_tokens ?? 0)
  const cost = row?.cost === null || row?.cost === undefined ? null : Number(row.cost)
  return {
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: input + cacheRead + cacheWrite + output + reasoning,
    calls: Number(row?.calls ?? 0),
    cost,
    costConfigured: cost !== null,
  }
}

const AGGREGATES = `
  COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
  COUNT(*) AS calls,
  CASE WHEN COUNT(u.total_cost) = 0 THEN NULL ELSE SUM(u.total_cost) END AS cost`

const baseSelect = `SELECT ${AGGREGATES} FROM usage_events u`

export function usageSnapshot(store, projectId, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const global = mapTotals(store.get(`${baseSelect} WHERE occurred_at >= ?`, since))
  const project = projectId
    ? mapTotals(store.get(`${baseSelect} WHERE project_id = ? AND occurred_at >= ?`, projectId, since))
    : { ...ZERO_TOTALS }
  const byBot = store.all(
    `SELECT u.bot_id AS bot_id, b.name AS name, ${AGGREGATES}
     FROM usage_events u JOIN bots b ON b.id = u.bot_id
     WHERE u.occurred_at >= ? GROUP BY u.bot_id, b.name ORDER BY input_tokens + output_tokens DESC`,
    since,
  ).map(row => ({ botId: row.bot_id, name: row.name, ...mapTotals(row) }))
  const byProject = store.all(
    `SELECT u.project_id AS project_id, p.name AS name, p.key AS key, ${AGGREGATES}
     FROM usage_events u JOIN projects p ON p.id = u.project_id
     WHERE u.occurred_at >= ? GROUP BY u.project_id, p.name, p.key ORDER BY input_tokens + output_tokens DESC`,
    since,
  ).map(row => ({ projectId: row.project_id, name: row.name, key: row.key, ...mapTotals(row) }))
  const byModel = store.all(
    `SELECT u.provider AS provider, u.model AS model, ${AGGREGATES}
     FROM usage_events u
     WHERE u.occurred_at >= ? GROUP BY u.provider, u.model ORDER BY input_tokens + output_tokens DESC`,
    since,
  ).map(row => ({ provider: row.provider, model: row.model, ...mapTotals(row) }))
  const cutoff = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10)
  const rawByDay = projectId
    ? store.all(
      `SELECT substr(occurred_at, 1, 10) AS day,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COUNT(*) AS calls,
         CASE WHEN COUNT(total_cost) = 0 THEN NULL ELSE SUM(total_cost) END AS cost
       FROM usage_events WHERE substr(occurred_at, 1, 10) >= ? AND project_id = ?
       GROUP BY day ORDER BY day`,
      cutoff,
      projectId,
    )
    : []
  const dayMap = new Map(rawByDay.map(row => [row.day, mapTotals(row)]))
  const byDay = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(Date.now() - (13 - index) * 86_400_000)
    const day = date.toISOString().slice(0, 10)
    return { day, ...(dayMap.get(day) ?? ZERO_TOTALS) }
  })
  const priceCount = store.get(
    "SELECT COUNT(DISTINCT provider || '|' || lower(model)) AS count FROM model_prices",
  )?.count ?? 0
  return {
    days,
    ...global,
    scope: { global, project },
    byBot,
    byProject,
    byModel,
    byDay,
    priceCount,
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
    String(input.currency ?? 'CNY').trim().toUpperCase() || 'CNY',
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

export function monthUsageForProject(store, projectId) {
  const month = new Date().toISOString().slice(0, 7)
  const row = store.get(
    `${baseSelect} WHERE project_id = ? AND substr(occurred_at, 1, 7) = ?`,
    projectId,
    month,
  )
  return mapTotals(row)
}
