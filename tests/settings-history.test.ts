// tests/settings-history.test.ts —— A4/DSHBOTS-330：设置变更历史守门。
// audit_log 本就是 append-only 不可变账本（B2 起每次保存审计 values），本卡只做只读视图：
// ① settings.update 与 prompt_segment.update/reset 都入历史，按时间倒序、带 actor/keys；
// ② state 下发 settingsHistory（UI 唯一真值）；③ 不做一键恢复的边界注释随代码钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settings-history-'))
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

const teardown = async (root, store) => {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

test('变更历史：settings.update 与 prompt_segment 保存/恢复都入账并倒序', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  const actor = { type: 'user', id: 'u1' }
  await service.updateSettings({ budget_currency: 'USD' }, actor)
  await service.updateSettings({ memory_review: '0' }, actor)
  service.updatePromptSegment('selfcheck', '自定义自校。', actor)
  service.updatePromptSegment('selfcheck', '', actor) // 恢复默认

  const history = service.settingsHistoryView(50)
  assert.deepEqual(history.map(item => item.action), [
    'prompt_segment.reset', 'prompt_segment.update', 'settings.update', 'settings.update',
  ], '按时间倒序、四条全入账')
  assert.equal(history[1].keys.join(','), 'selfcheck', 'prompt_segment 行变更键用段键呈现（data 只记字符数）')
  assert.equal(history[0].target, 'selfcheck', '恢复默认按段键定位')
  assert.ok(history.every(item => item.actor === 'user:u1'), 'actor 署名在场')

  // 只读性：视图不写任何行（反双真值——audit_log 是唯一账本）。
  const before = Number(store.get('SELECT COUNT(*) AS count FROM audit_log')?.count ?? 0)
  service.settingsHistoryView(50)
  assert.equal(Number(store.get('SELECT COUNT(*) AS count FROM audit_log')?.count ?? 0), before)
})

test('state 下发 settingsHistory；limit 边界收敛', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  const actor = { type: 'user', id: 'u1' }
  for (let i = 0; i < 5; i++) await service.updateSettings({ memory_review: i % 2 === 0 ? '1' : '0' }, actor)
  assert.equal(service.settingsHistoryView(3).length, 3, 'limit 生效')
  assert.equal(service.settingsHistoryView(999).length, 5, '上限收敛不越界')
  const state = await service.state(null, null)
  assert.equal(state.settingsHistory.length, 5, 'state 唯一真值下发')
})
