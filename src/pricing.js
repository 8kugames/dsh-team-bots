import { id, nowIso } from './util.js'

// 内置默认价格（每百万 token，CNY）。provider 留空表示「按模型名通配」，
// 任意 provider 下同名模型都命中；配置里写 provider 则只覆盖该 provider。
export const DEFAULT_MODEL_PRICES = [
  { id: 'deepseek-flash', provider: '', hit: 0.2, miss: 2, out: 8, currency: 'CNY' },
  { id: 'glm-5.3', provider: '', hit: 2, miss: 8, out: 28, currency: 'CNY' },
  { id: 'glm-5.3-flash', provider: '', hit: 0.23, miss: 0.8, out: 2.8, currency: 'CNY' },
  { id: 'MiniMax-M3.1-Flash', provider: '', hit: 0.1, miss: 1, out: 4, currency: 'CNY' },
]

const num = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const first = (...values) => values.find(value => value !== undefined && value !== null && value !== '')

// 接受两种写法：简写 hit/miss/out，或全称 inputPerMtok/cacheReadPerMtok/outputPerMtok。
export function normalizePriceEntry(raw = {}       ) {
  const model = String(first(raw.model, raw.id, raw.name, '') ?? '').trim()
  if (!model) return null
  return {
    provider: String(raw.provider ?? '').trim(),
    model,
    inputPerMtok: num(first(raw.miss, raw.input, raw.inputPerMtok)),
    cacheReadPerMtok: num(first(raw.hit, raw.cacheRead, raw.cacheReadPerMtok)),
    cacheWritePerMtok: num(first(raw.cacheWrite, raw.cacheWritePerMtok)),
    outputPerMtok: num(first(raw.out, raw.output, raw.outputPerMtok)),
    currency: String(first(raw.currency, 'CNY') ?? 'CNY').trim().toUpperCase() || 'CNY',
  }
}

function parseEnv(value) {
  if (!value || !String(value).trim()) return null
  try {
    const parsed = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// 优先级：插件配置 config.modelPrices > 环境变量 DSH_TEAM_MODEL_PRICES(JSON) > 内置默认。
// 显式配置空数组 = 关闭默认价格（成本显示未配置）。
export function resolveModelPrices(config = {}       , env = process.env) {
  const source = Array.isArray(config.modelPrices) && !config.modelPrices.disabled
    ? config.modelPrices
    : (parseEnv(env.DSH_TEAM_MODEL_PRICES) ?? DEFAULT_MODEL_PRICES)
  const list = Array.isArray(source) ? source : DEFAULT_MODEL_PRICES
  const seen = new Set()
  const entries = []
  for (const raw of list) {
    const entry = normalizePriceEntry(raw)
    if (!entry) continue
    const key = `${entry.provider}|${entry.model.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return entries
}

export function priceKey(provider, model) {
  return `${String(provider ?? '').toLowerCase()}|${String(model ?? '').toLowerCase()}`
}

// 只播种「从未有过任何价格记录」的模型，Web 中改过的价格不会被配置覆盖。
export function seedModelPrices(store, entries = []) {
  const effectiveAt = nowIso()
  let inserted = 0
  let skipped = 0
  for (const entry of entries) {
    const existing = store.get(
      'SELECT id FROM model_prices WHERE provider = ? AND lower(model) = lower(?) LIMIT 1',
      entry.provider,
      entry.model,
    )
    if (existing) {
      skipped += 1
      continue
    }
    store.run(
      `INSERT INTO model_prices(id, provider, model, input_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
         output_per_mtok, currency, effective_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id('price'),
      entry.provider,
      entry.model,
      entry.inputPerMtok,
      entry.cacheReadPerMtok,
      entry.cacheWritePerMtok,
      entry.outputPerMtok,
      entry.currency,
      effectiveAt,
    )
    inserted += 1
  }
  return { inserted, skipped }
}

// 当前生效价格：先精确匹配 provider，再退化到通配 provider=''，最后忽略大小写。
export function effectivePrice(store, provider, model, at = nowIso()) {
  if (!model) return undefined
  const sql = `SELECT * FROM model_prices WHERE provider = ? AND model = ? COLLATE NOCASE
    AND effective_at <= ? ORDER BY effective_at DESC LIMIT 1`
  return store.get(sql, String(provider ?? ''), model, at)
    ?? store.get(sql, '', model, at)
}

// 当前价目表：每个 provider|model 只保留最新一条生效价格（与 Web 价格列表同口径）。
// 入库时没命中价目的历史明细按这张表追认成本——价目配齐后无需迁移，聚合时自动补算。
export function currentPriceMap(store, at = nowIso()) {
  const rows = store.all(
    'SELECT * FROM model_prices WHERE effective_at <= ? ORDER BY effective_at DESC',
    at,
  )
  const map = new Map()
  for (const row of rows) {
    const key = priceKey(row.provider, row.model)
    if (!map.has(key)) map.set(key, row)
  }
  return map
}

// 与 effectivePrice 同口径的两级回退：先精确 provider，再退到通配 provider=''。
export function lookupPrice(prices, provider, model) {
  if (!model) return undefined
  return prices.get(priceKey(provider, model)) ?? prices.get(priceKey('', model))
}
