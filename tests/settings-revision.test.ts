// tests/settings-revision.test.ts —— B2/DSHBOTS-325：设置乐观并发守门。
// ① revision 匹配保存成功且令牌单调递增；② 不匹配 → conflict 409（后保存者不静默覆盖）；
// ③ 不带 revision 的旧调用形态行为不变；④ state 下发 settingsRevision；⑤ settings_revision
// 键不可经 patch 直写（防旁路伪造令牌）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { handleAction } from '../src/api.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settings-rev-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

async function teardown(root, store) {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

test('revision 匹配保存成功、令牌递增；不匹配 409 拒绝', async () => {
  const { root, store, service } = await setup()
  try {
    const actor = { type: 'user', id: 'u1' }
    const revision0 = service.settingsRevision()
    assert.equal(revision0, 0, '初始令牌为 0')
    await service.updateSettings({ budget_currency: 'USD' }, actor, revision0)
    assert.equal(service.settingsRevision(), 1)
    assert.equal(service.store.setting('budget_currency'), 'USD')

    // 另一窗口持旧令牌保存 → conflict（AppError status 409）。
    assert.throws(
      () => service.updateSettings({ budget_currency: 'CNY' }, actor, revision0),
      (error: any) => {
        assert.equal(error.status, 409)
        assert.match(error.message, /已被其他人或窗口修改/)
        return true
      },
      '旧令牌保存必须被拒绝',
    )
    // 新令牌（他人保存后的最新值）可正常继续。
    await service.updateSettings({ budget_currency: 'CNY' }, actor, service.settingsRevision())
    assert.equal(service.store.setting('budget_currency'), 'CNY')
    assert.equal(service.settingsRevision(), 2)
  } finally {
    await teardown(root, store)
  }
})

test('不带 revision 的旧调用形态不受影响；state 下发 settingsRevision', async () => {
  const { root, store, service } = await setup()
  try {
    const actor = { type: 'user', id: 'u1' }
    await service.updateSettings({ memory_review: '0' }, actor)
    assert.equal(service.store.setting('memory_review'), '0')
    assert.equal(service.settingsRevision(), 1, '无 revision 参数也推进令牌')
    await service.updateSettings({ memory_review: '1' }, actor, undefined)
    assert.equal(service.settingsRevision(), 2)
    // settings_revision 不可经 patch 直写（updateSettings 只认 settingsView 键）。
    assert.throws(
      () => service.updateSettings({ settings_revision: '999' }, actor),
      /不支持的设置项/,
      '旁路伪造令牌必须拒绝',
    )
    const state = await service.state(null, null)
    assert.equal(state.settingsRevision, service.settingsRevision())
  } finally {
    await teardown(root, store)
  }
})

// DSHBOTS-350：前端契约修复后，update_settings 的 HTTP 入口收 { patch, revision } 载荷。
test('handleAction update_settings 收 { patch, revision }：保存成功且 revision 不进白名单', async () => {
  const { root, store, service } = await setup()
  try {
    const actor = { type: 'user', id: 'u1' }
    const revision = service.settingsRevision()
    await handleAction(service, 'update_settings', { patch: { budget_currency: 'USD' }, revision }, actor)
    assert.equal(store.setting('budget_currency'), 'USD')
    assert.equal(service.settingsRevision(), revision + 1)
  } finally {
    await teardown(root, store)
  }
})

test('并发闸：handleAction 带过期 revision 保存返回 409 CONFLICT 且不落库', async () => {
  const { root, store, service } = await setup()
  try {
    const actor = { type: 'user', id: 'u1' }
    await handleAction(service, 'update_settings', { patch: { budget_currency: 'USD' }, revision: 0 }, actor)
    await assert.rejects(
      () => handleAction(service, 'update_settings', { patch: { budget_currency: 'CNY' }, revision: 0 }, actor),
      (error: any) => {
        assert.equal(error.status, 409)
        assert.equal(error.code, 'CONFLICT')
        assert.match(error.message, /已被其他人或窗口修改/)
        return true
      },
      '旧令牌保存必须被拒绝',
    )
    assert.equal(store.setting('budget_currency'), 'USD', '被拒绝的保存不得落库')
  } finally {
    await teardown(root, store)
  }
})
