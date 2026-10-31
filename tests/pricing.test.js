import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { DEFAULT_MODEL_PRICES, effectivePrice, normalizePriceEntry, resolveModelPrices, seedModelPrices } from '../src/pricing.js'
import { recordUsage, setPrice, usageSnapshot } from '../src/usage.js'

async function db() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-team-price-'))
  const store = openDatabase(join(dir, 'team.sqlite'))
  return { dir, store }
}

test('默认价格是四个 CNY 模型，provider 通配', () => {
  const prices = resolveModelPrices({}, {})
  assert.equal(prices.length, 4)
  assert.deepEqual(prices.map(item => item.model), ['deepseek-flash', 'glm-5.3', 'glm-5.3-flash', 'MiniMax-M3.1-Flash'])
  assert.ok(prices.every(item => item.currency === 'CNY'))
  assert.ok(prices.every(item => item.provider === ''))
  const flash = prices.find(item => item.model === 'deepseek-flash')
  assert.equal(flash.cacheReadPerMtok, 0.2)
  assert.equal(flash.inputPerMtok, 2)
  assert.equal(flash.outputPerMtok, 8)
})

test('配置和环境变量都能覆盖默认价格，空数组表示关闭', () => {
  const custom = resolveModelPrices({
    modelPrices: [{ id: 'glm-5.3', provider: 'zhipu', hit: 1, miss: 4, out: 16, currency: 'cny' }],
  }, {})
  assert.equal(custom.length, 1)
  assert.equal(custom[0].provider, 'zhipu')
  assert.equal(custom[0].currency, 'CNY')

  const fromEnv = resolveModelPrices({}, { DSH_TEAM_MODEL_PRICES: '[{"model":"x","miss":1,"out":2}]' })
  assert.equal(fromEnv.length, 1)
  assert.equal(fromEnv[0].cacheReadPerMtok, 0)

  assert.deepEqual(resolveModelPrices({ modelPrices: [] }, {}), [])
  assert.equal(resolveModelPrices({}, {}).length, DEFAULT_MODEL_PRICES.length)
})

test('normalizePriceEntry 跳过没有 model 的条目并支持全称字段', () => {
  assert.equal(normalizePriceEntry({ hit: 1 }), null)
  const entry = normalizePriceEntry({
    id: 'm', inputPerMtok: 3, cacheReadPerMtok: 0.5, cacheWritePerMtok: 1, outputPerMtok: 9,
  })
  assert.equal(entry.model, 'm')
  assert.equal(entry.inputPerMtok, 3)
  assert.equal(entry.outputPerMtok, 9)
})

test('播种只写一次，Web 修改后不会被配置重新覆盖', async () => {
  const { dir, store } = await db()
  try {
    const first = seedModelPrices(store, resolveModelPrices({}, {}))
    assert.equal(first.inserted, 4)
    const second = seedModelPrices(store, resolveModelPrices({}, {}))
    assert.equal(second.inserted, 0)
    assert.equal(second.skipped, 4)

    setPrice(store, { provider: '', model: 'glm-5.3', inputPerMtok: 99, cacheReadPerMtok: 9, cacheWritePerMtok: 0, outputPerMtok: 999, currency: 'CNY' })
    seedModelPrices(store, resolveModelPrices({}, {}))
    const price = effectivePrice(store, 'zhipu', 'glm-5.3')
    assert.equal(price.input_per_mtok, 99)
    assert.equal(price.output_per_mtok, 999)

    const snap = usageSnapshot(store, null, 30)
    assert.equal(snap.priceCount, 4)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('成本按 hit/miss/out 精确计算，通配 provider 生效', async () => {
  const { dir, store } = await db()
  try {
    seedModelPrices(store, resolveModelPrices({}, {}))
    const event = recordUsage(store, {
      sourceKey: 'price:1',
      run: null,
      provider: 'deepseek',
      model: 'deepseek-flash',
      usage: { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    assert.ok(event)
    assert.equal(Number(event.input_cost.toFixed(6)), 2.2)
    assert.equal(Number(event.output_cost.toFixed(6)), 8)
    assert.equal(Number(event.total_cost.toFixed(6)), 10.2)

    const unknown = recordUsage(store, {
      sourceKey: 'price:2',
      run: null,
      provider: 'deepseek',
      model: 'no-such-model',
      usage: { inputTokens: 1000, outputTokens: 100 },
    })
    assert.equal(unknown.total_cost, null)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveConfig 带上默认价格，且 provider 精确价优先于通配价', async () => {
  const config = resolveConfig({ workspace: '/tmp/dsh-team-ws', dataDir: '/tmp/dsh-team-data' })
  assert.equal(config.modelPrices.length, 4)

  const { dir, store } = await db()
  try {
    seedModelPrices(store, config.modelPrices)
    setPrice(store, { provider: 'deepseek', model: 'deepseek-flash', inputPerMtok: 50, cacheReadPerMtok: 5, cacheWritePerMtok: 0, outputPerMtok: 60, currency: 'CNY' })
    const exact = effectivePrice(store, 'deepseek', 'deepseek-flash')
    assert.equal(exact.input_per_mtok, 50)
    const wildcard = effectivePrice(store, 'other', 'DeepSeek-Flash')
    assert.equal(wildcard.input_per_mtok, 2)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
