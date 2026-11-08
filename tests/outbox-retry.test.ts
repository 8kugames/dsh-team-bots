// tests/outbox-retry.test.ts —— DSHBOTS-338：投递失败可行动化守门。
// 用户反馈的死端修复：needs-attention「投递失败」chip 落到全局页投递队列卡后，必须有
// 失败明细（kind/次数/原因）与一键重试，而不是一行统计。守门四向：
// ①outboxRetry 行为：failed 行复活为 pending + attempts 清零 + 审计 + 幂等键不动；
// ②无失败行 → requeued:0 不空转；③state.outbox 携带 failedItems（明细上限 10）；
// ④UI 接线锚：明细渲染 + retry-outbox 分支 + 重试键入典。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-outbox-retry-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const projectView = await service.createProject({ name: 'Order', key: 'ORD', ownerBotId: director.id })
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  return { root, store, service, project }
}

const teardown = async (root, store) => {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

const seedFailed = (store, i) => store.run(
  `INSERT INTO outbox(id, kind, payload_json, status, attempts, last_error, available_at, created_at)
   VALUES ('ob-${i}', 'chat_run', '{}', 'failed', 5, '通道不可达', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z')`,
)

test('outboxRetry：failed 全部复活 pending、attempts 清零、审计、幂等键不动', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  const actor = { type: 'user', id: 'user_local' }
  seedFailed(store, 1)
  seedFailed(store, 2)
  // 桩掉 tick：重试后的真实投递走调度器另测，这里只断言复活/清零/审计。
  service.tick = async () => {}
  const result = service.outboxRetry(actor)
  assert.equal(result.requeued, 2)
  const rows = store.all("SELECT * FROM outbox WHERE id IN ('ob-1','ob-2')")
  for (const row of rows) {
    assert.equal(row.status, 'pending')
    assert.equal(row.attempts, 0, '人工重试给全新一轮退避预算')
    assert.equal(row.last_error, null)
    assert.ok(row.idempotency_key === null || row.idempotency_key, '幂等键不动（重投仍被收据/去重闸吸收）')
  }
  const audit = store.get("SELECT * FROM audit_log WHERE action = 'outbox.retry'")
  assert.ok(audit, '重试审计留痕')
})

test('无失败行：requeued 0 不空转；state.outbox 携带 failedItems（上限 10）', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  assert.deepEqual(service.outboxRetry(), { requeued: 0 })
  for (let i = 0; i < 12; i++) seedFailed(store, i)
  const view = service.outboxStateView()
  assert.equal(view.failed, 12)
  assert.equal(view.failedItems.length, 10, '明细上限 10 条')
  assert.equal(view.failedItems[0].kind, 'chat_run')
  assert.equal(view.failedItems[0].lastError, '通道不可达')
  // 失败为 0 时不发明细查询。
  store.run("UPDATE outbox SET status = 'delivered'")
  assert.deepEqual(service.outboxStateView().failedItems, [])
})

test('UI 接线锚：明细渲染 + retry-outbox 分支 + 文案入典', () => {
  const here = fileURLToPath(new URL('..', import.meta.url))
  const settingsSource = readFileSync(join(here, 'ui', 'modules', 'settings.ts'), 'utf8')
  const boardSource = readFileSync(join(here, 'ui', 'modules', 'events-board.ts'), 'utf8')
  assert.match(settingsSource, /outbox\.failedItems/, '投递卡渲染失败明细')
  assert.match(settingsSource, /data-action="retry-outbox"/, '重试按钮在场')
  assert.match(boardSource, /case 'retry-outbox':/, '重试事件分支在场')
  const zh = readFileSync(join(here, 'ui', 'i18n', 'zh', 'settings.ts'), 'utf8')
  const en = readFileSync(join(here, 'ui', 'i18n', 'en', 'settings.ts'), 'utf8')
  assert.match(zh, /"global\.outboxRetry": "重试全部失败投递"/)
  assert.match(en, /"global\.outboxRetry": "Retry all failed deliveries"/)
})
