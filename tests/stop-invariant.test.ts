import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { StubRuntime } from './helpers/runtime-stub.js'

// 停机不变量（插件热重载）：插件卸载会关闭底层库，已停机的实例必须完全静默——
// 再触发的定时器会打到已关闭的库，报 "database is not open"。
// 这条曾真实发生：重载时旧实例的延迟首拍（start() 里的 300ms setTimeout）在
// 库关闭后触发，报 scheduler tick failed。

async function setup(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  return { root, store, service, config }
}

test('停机后不得再起拍：延迟首拍与周期拍都不落到已关闭的库', async () => {
  const { root, store, service } = await setup('dsh-stop-invariant-')
  try {
    await service.initialize()
    service.start()
    // 停机并关闭底层库（与插件卸载同序：先 stop 后 close）。
    service.stop()
    store.close()
    // 等待越过 300ms 延迟首拍与一次周期拍窗口，确认没有写库动作发生。
    await new Promise(resolve => setTimeout(resolve, 600))
    // 停机后 tick 必须是空操作：库里没有新行，且调用不抛错。
    await service.tick()
    assert.equal(service.started, false)
    assert.equal(service.timer, null)
    assert.equal(service.bootTimer, null)
  } finally {
    try { store.close() } catch { /* 已关闭的库再关一次不算错误 */ }
    await rm(root, { recursive: true, force: true })
  }
})

test('停机后 start() 不再起拍（重载竞态：初始化未完成就卸载）', async () => {
  const { root, store, service } = await setup('dsh-stop-restart-')
  try {
    await service.initialize()
    service.stop()
    // 重载竞态：卸载后 boot promise 才 resolve，随后调 start()——必须被停机标志挡住。
    service.start()
    assert.equal(service.started, false, '停机后的 start() 不得置 started')
    assert.equal(service.timer, null, '停机后不得再建周期拍定时器')
    assert.equal(service.bootTimer, null, '停机后不得再建延迟首拍定时器')
    store.close()
  } finally {
    try { store.close() } catch { /* 已关闭的库再关一次不算错误 */ }
    await rm(root, { recursive: true, force: true })
  }
})

test('停机后 tick 与 tickIdleGate 都是空操作，不读已关闭的库', async () => {
  const { root, store, service } = await setup('dsh-stop-tick-')
  try {
    await service.initialize()
    service.start()
    service.stop()
    store.close()
    // 这两个入口在停机后都不得碰库（tickIdleGate 直接读库，未捕获会变成未处理 rejection）。
    await service.tick()
    assert.equal(service.tickIdleGate(), null)
  } finally {
    try { store.close() } catch { /* 已关闭的库再关一次不算错误 */ }
    await rm(root, { recursive: true, force: true })
  }
})
