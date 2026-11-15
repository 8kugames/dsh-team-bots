// DSHBOTS 性能子卡：用量快照缓存（TTL + 数据版本校验 + 写回显式失效）。
// 背景：state() 每 2.8s 轮询一次，每次都跑 30d 全口径聚合（生产库实测约 500ms），
// 是侧栏点击路径上的主要服务端延迟。这里锁住三件事：
//   1) TTL 内命中、过期重算、cacheTtlMs=0 关闭；
//   2) 明细增删靠「数据版本」自动失效（版本由三张可写回表的计数/最大时间戳推导）；
//   3) 价目/对账写回走显式失效通道——setPrice 的 UPDATE 不改 effective_at，
//      版本校验抓不到，必须靠 clearUsageSnapshotCache()。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { clearUsageSnapshotCache, recordUsage, usageSnapshot } from '../src/usage.js'
import { reconcileUsage, setPrice } from '../src/usage-reconcile.js'

const OPTIONS = { currency: 'USD', window: '30d', cacheTtlMs: 60_000 }

async function withStore(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-cache-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  try {
    await fn(store)
  } finally {
    clearUsageSnapshotCache()
    try {
      store.close()
    } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

test('快照缓存在 TTL 内命中，过期后重算', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  try {
    await withStore(async (store) => {
      const first = usageSnapshot(store, null, 30, OPTIONS)
      const second = usageSnapshot(store, null, 30, OPTIONS)
      assert.equal(second, first, 'TTL 内应命中缓存（返回同一对象）')
      t.mock.timers.tick(60_001)
      const third = usageSnapshot(store, null, 30, OPTIONS)
      assert.notEqual(third, first, 'TTL 过后应重算')
    })
  } finally {
    t.mock.timers.reset()
  }
})

test('cacheTtlMs = 0 关闭缓存，每次都重算', async () => {
  await withStore(async (store) => {
    const options = { ...OPTIONS, cacheTtlMs: 0 }
    const first = usageSnapshot(store, null, 30, options)
    const second = usageSnapshot(store, null, 30, options)
    assert.notEqual(second, first, 'cacheTtlMs=0 时不应命中')
  })
})

test('明细写入靠数据版本校验失效，无需显式钩子', async () => {
  await withStore(async (store) => {
    const before = usageSnapshot(store, null, 30, OPTIONS)
    recordUsage(store, {
      sourceKey: 'u:cache-version',
      run: null,
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 7, outputTokens: 3 },
      occurredAt: new Date().toISOString(),
    })
    const after = usageSnapshot(store, null, 30, OPTIONS)
    assert.notEqual(after, before, '明细增删应通过版本号让缓存失效')
  })
})

test('价目写回后立即失效缓存（UPDATE 不改 effective_at，只能靠显式失效）', async () => {
  await withStore(async (store) => {
    setPrice(store, {
      provider: '', model: 'model-x', inputPerMtok: 1,
      cacheReadPerMtok: 2, cacheWritePerMtok: 3, outputPerMtok: 4, currency: 'USD',
    })
    const before = usageSnapshot(store, null, 30, OPTIONS)
    // 同 effective_at 的重复写会走 UPDATE 分支：只改价目数值，effective_at 不变，
    // 版本号因此不变——这条断言正是为了钉住「显式失效通道」不是可选的。
    setPrice(store, {
      provider: '', model: 'model-x', inputPerMtok: 9,
      cacheReadPerMtok: 8, cacheWritePerMtok: 7, outputPerMtok: 6, currency: 'USD',
    })
    const after = usageSnapshot(store, null, 30, OPTIONS)
    assert.notEqual(after, before, '价目写回应让快照缓存失效')
  })
})

test('对账写回后立即失效缓存', async () => {
  await withStore(async (store) => {
    const before = usageSnapshot(store, null, 30, OPTIONS)
    reconcileUsage(store, { days: 30 })
    const after = usageSnapshot(store, null, 30, OPTIONS)
    assert.notEqual(after, before, '对账写回应让快照缓存失效')
  })
})

test('clearUsageSnapshotCache 手动清空', async () => {
  await withStore(async (store) => {
    const before = usageSnapshot(store, null, 30, OPTIONS)
    clearUsageSnapshotCache()
    const after = usageSnapshot(store, null, 30, OPTIONS)
    assert.notEqual(after, before)
  })
})

test('不同 key 互不命中（项目/窗口/预算币种）', async () => {
  await withStore(async (store) => {
    const base = usageSnapshot(store, null, 30, OPTIONS)
    const otherWindow = usageSnapshot(store, null, 30, { ...OPTIONS, window: '7d' })
    const otherProject = usageSnapshot(store, 'p1', 30, OPTIONS)
    assert.notEqual(otherWindow, base)
    assert.notEqual(otherProject, base)
  })
})
