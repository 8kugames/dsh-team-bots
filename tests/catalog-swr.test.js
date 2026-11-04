// DSHBOTS 性能子卡：模型目录 stale-while-revalidate。
// 背景：catalog 缓存只有 8s，过期时逐 provider 串行 listModels + resolveModelInfo
// （真实网络调用），那是 state() 秒级波动的主因。SWR 让 stale 窗口内直接返回旧值并后台刷新。
// 这里锁住四件事：fresh 直接返回、stale 返回旧值并后台刷新、force 同步等、刷新失败保留旧目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { DshRuntime } from '../src/runtime.js'

class StubLlm {
  constructor({ fail = false } = {}) {
    this.fail = fail
    this.listModelsCalls = 0
  }

  listProviders() {
    return [{ id: 'p1', name: 'Provider One' }]
  }

  async listModels() {
    this.listModelsCalls += 1
    if (this.fail) throw new Error('boom')
    return [{ id: 'm1' }]
  }

  async resolveModelInfo() {
    return { context: { contextWindow: 1000 }, defaultMaxTokens: 100 }
  }
}

async function setup({ modelCacheMs = 1_000, catalogStaleMs = 5_000, fail = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-swr-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace,
    dataDir,
    skillRoot: join(workspace, '.agents'),
    modelCacheMs,
    catalogStaleMs,
    schedulerIntervalMs: 20,
  })
  const store = openDatabase(config.dbPath)
  // catalog 挂在 DshRuntime 上（生产里 service.attachRuntime(runtime)，service.runtime.catalog()）。
  const service = new DshRuntime({ ctx: { llm: new StubLlm({ fail }) }, config, store, logger: { info() {}, warn() {}, error() {} } })
  return { root, store, service }
}

async function withService(options, fn) {
  const ctx = await setup(options)
  try {
    await fn(ctx)
  } finally {
    try {
      ctx.store.close()
    } catch {}
    await rm(ctx.root, { recursive: true, force: true })
  }
}

// 等后台刷新落地（refreshCatalog 是 void 调用的 Promise）。
async function settle(service) {
  for (let i = 0; i < 200 && service.modelsRefreshing; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('fresh 缓存直接返回，不触发网络调用', async () => {
  await withService({}, async ({ service }) => {
    service.modelsCache = { at: Date.now(), value: [{ ref: 'p1/m1' }] }
    const value = await service.catalog()
    assert.deepEqual(value, [{ ref: 'p1/m1' }])
    assert.equal(service.ctx.llm.listModelsCalls, 0, 'fresh 时不应调 listModels')
  })
})

test('stale 但在窗口内：立即返回旧值，并后台刷新出新目录', async () => {
  await withService({ modelCacheMs: 1_000, catalogStaleMs: 5_000 }, async ({ service }) => {
    service.modelsCache = { at: Date.now() - 2_000, value: [{ ref: 'old/m0' }] }
    const value = await service.catalog()
    assert.deepEqual(value, [{ ref: 'old/m0' }], 'stale 窗口内应先返回旧值')
    assert.equal(service.ctx.llm.listModelsCalls, 1, '应触发一次后台刷新')
    await settle(service)
    assert.equal(service.modelsCache.value.length, 1)
    assert.equal(service.modelsCache.value[0].ref, 'p1/m1', '后台刷新应写入新目录')
  })
})

test('catalogStaleMs = 0 关闭 SWR：stale 时同步等刷新', async () => {
  await withService({ modelCacheMs: 1_000, catalogStaleMs: 0 }, async ({ service }) => {
    service.modelsCache = { at: Date.now() - 2_000, value: [{ ref: 'old/m0' }] }
    const value = await service.catalog()
    assert.equal(value.length, 1)
    assert.equal(value[0].ref, 'p1/m1', '关闭 SWR 后应同步返回新目录')
  })
})

test('force 绕过缓存，同步等刷新', async () => {
  await withService({}, async ({ service }) => {
    service.modelsCache = { at: Date.now(), value: [{ ref: 'old/m0' }] }
    const value = await service.catalog(true)
    assert.equal(value[0].ref, 'p1/m1')
    assert.equal(service.ctx.llm.listModelsCalls, 1)
  })
})

test('刷新失败时保留旧目录，不把模型列表清空', async () => {
  await withService({ modelCacheMs: 1_000, catalogStaleMs: 5_000, fail: true }, async ({ service }) => {
    service.modelsCache = { at: Date.now() - 2_000, value: [{ ref: 'old/m0' }] }
    const value = await service.catalog()
    assert.deepEqual(value, [{ ref: 'old/m0' }], '失败应保留旧目录')
    await settle(service)
    assert.deepEqual(service.modelsCache.value, [{ ref: 'old/m0' }], '失败后缓存内容不应被清成空')
  })
})
