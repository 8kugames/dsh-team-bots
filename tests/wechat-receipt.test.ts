// tests/wechat-receipt.test.ts —— A3/DSHBOTS-323：外发幂等收据与可解释终态守门。
// 收据真值唯一落通道出站库（wechat-channel.sqlite，反双真值不在插件库建第二张表）：
// ① receipt_key 幂等吸收（同键存留期内只入队一次）；② sent/gone 终态带原因（last_error）；
// ③ 插件四个外发调用点带稳定键；④ notifyReceiptsView 同源读取并映射终态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { WechatStore } from '../src/wechat/store.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-receipt-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  // initialize 只播种默认 bots，不建项目：测试用项目在此显式创建。
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const projectView = await service.createProject({ name: 'Order', key: 'ORD', ownerBotId: director.id })
  const project = service.projectRow(projectView.id)
  return { root, store, service, config, project }
}

async function teardown(root, store) {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

test('通道库：receipt_key 幂等吸收与终态查询', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weceipt-store-'))
  const store = new WechatStore(join(root, 'wechat-channel.sqlite'))
  try {
    await store.open()
    assert.equal(store.enqueue('第一条', 'task-done:t1'), 'enqueued')
    assert.equal(store.enqueue('重复条', 'task-done:t1'), 'duplicate')
    assert.equal(store.enqueue('另一条', 'task-created:t1'), 'enqueued')
    assert.equal(store.enqueue('无键旧形态'), 'enqueued')
    assert.equal(store.enqueue(''), 'skipped')
    const rows = store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()
    assert.equal(rows.n, 3, '同键吸收后共 3 行（两条带键 + 一条无键）')

    // 终态与原因：发送成功 → sent；失败废弃 → gone + last_error。
    // 终态时间戳显式回拨，避免与 purge 截止时间同毫秒时清理不掉（ISO 字符串严格小于）。
    const pending = store.pendingOutbox()
    store.markAttempt(pending[0].id, '网络超时')
    store.giveUp([pending[0].id], '重试超限')
    store.markSent([pending[1].id])
    store.db.prepare("UPDATE outbox SET sent_at = '2026-01-01T00:00:00.000Z' WHERE receipt_key = 'task-created:t1'").run()
    store.db.prepare("UPDATE outbox SET gave_up_at = '2026-01-01T00:00:00.000Z' WHERE receipt_key = 'task-done:t1'").run()
    const states = store.receiptStates(['task-done:t1', 'task-created:t1'])
    const byKey = Object.fromEntries(states.map(row => [row.receipt_key, row]))
    assert.equal(byKey['task-done:t1'].sent_at, null)
    assert.equal(byKey['task-done:t1'].attempts, 1)
    assert.equal(byKey['task-done:t1'].last_error, '重试超限')
    assert.ok(byKey['task-created:t1'].sent_at, 'sent 终态带 sent_at')

    // 存留期清理后同键可重新入队（吸收只在存留期内有效）。
    store.purgeSentOutbox(0)
    assert.equal(store.enqueue('重发', 'task-created:t1'), 'enqueued')
    assert.deepEqual(store.receipts(10).map(row => row.receipt_key), ['task-created:t1'])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('插件调用点带稳定收据键，notifyReceiptsView 映射终态', async () => {
  const { root, store, service, project } = await setup()
  try {
    const pushes = []
    service.wechat = { notify: (text, opts) => pushes.push({ text, opts }), receipts: () => [
      { receipt_key: 'task-done:t9', sent_at: null, gave_up_at: '2026-11-07T00:00:00.000Z', attempts: 3, last_error: '重试超限', created_at: '2026-11-07T00:00:00.000Z' },
      { receipt_key: 'task-created:t9', sent_at: '2026-11-07T00:01:00.000Z', gave_up_at: null, attempts: 0, last_error: null, created_at: '2026-11-07T00:00:00.000Z' },
    ] } as any
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id, created_at, updated_at)
       VALUES ('t9', ?, 9, '收据卡', 'done', 'medium', 'user', 'u1', ?, ?)`,
      project.id, now, now,
    )
    const task = service.taskRow('t9')
    service.notifyTaskCreated(task)
    service.notifyTaskDone(task)
    assert.deepEqual(pushes.map(item => item.opts.receiptKey), ['task-created:t9', 'task-done:t9'])

    const view = service.notifyReceiptsView()
    assert.equal(view.available, true)
    assert.equal(view.items.find(item => item.receiptKey === 'task-done:t9').state, 'gone')
    assert.equal(view.items.find(item => item.receiptKey === 'task-done:t9').lastError, '重试超限')
    assert.equal(view.items.find(item => item.receiptKey === 'task-created:t9').state, 'sent')

    // 通道未启用：可解释的不可用态，不假装有流水。
    service.wechat = null
    assert.deepEqual(service.notifyReceiptsView(), { available: false, reason: 'wechat-disabled', items: [] })
  } finally {
    await teardown(root, store)
  }
})

test('提问/审批转发微信带条目级收据键', async () => {
  const { root, store, service, project } = await setup()
  try {
    const pushes = []
    service.wechat = { notify: (text, opts) => pushes.push(opts) } as any
    service.wechatQuestion(project, { id: 'q-abc123', bot_name: 'Builder' }, [{ question: '用哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }])
    service.wechatApproval(project, { id: 'ap-def456', bot_name: 'Builder', tool_name: 'bash', reason: '需要写文件' })
    assert.deepEqual(pushes.map(item => item.receiptKey), ['question:q-abc123', 'approval:ap-def456'])
  } finally {
    await teardown(root, store)
  }
})
