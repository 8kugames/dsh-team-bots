// tests/outbox-coalesce.test.js —— DSHBOTS-136：outbox 补强护栏。
// ① per-kind coalescing 白名单：review_delegate_auto 同幂等键重排按「合并」处理（覆盖 payload、
//    清零重试预算、复活 pending、保队列位），白名单外保持先写者赢（消息类 kind 合并即丢消息）；
//    queueAutoReviewDelegate 的幂等键取任务级，同一任务反复交付并入同一行。
// ② defer 不计数延迟（原型 Later 语义）：error.defer = true 不是失败——不动 attempts、不进 5 次
//    上限，只前移 available_at；deferred 行不阻塞其他行领取。既有退避（计数 + 指数曲线 + 5 次转
//    failed + permanent 立即终局）回归钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class HoldRuntime { declare handler: (...args: unknown[]) => unknown;
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-hold' }
  async steer() { return true }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-oco-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(
    join(workspace, '.agents', 'skills', 'review', 'SKILL.md'),
    `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`,
  )
  // 环境变量隔离：queueAutoReviewDelegate 用例断言开关默认开，外层 env 不许串扰。
  const savedAuto = process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE
  delete process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const project = await service.createProject({
    name: 'Coalesce', key: 'OCL', ownerBotId: director.id, memberIds: [dev.id],
  })
  const close = async () => {
    try { store.close() } catch {}
    if (savedAuto === undefined) delete process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE
    else process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE = savedAuto
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, director, dev, project, close }
}

test('白名单 kind 同键重排合并：覆盖 payload、清零重试预算、复活 delivered、保队列位', async () => {
  const t = await setup()
  try {
    let calls = 0
    t.service.applyOutbox = () => { calls += 1; throw new Error('guard busy') }
    const first = t.service.enqueueOutbox({
      kind: 'review_delegate_auto', payload: { taskId: 'task-a', v: 1 },
      idempotencyKey: 'review_auto:task-a',
    })
    let row = t.store.get('SELECT * FROM outbox WHERE id = ?', first)
    assert.equal(row.status, 'pending', '投递失败留 pending 走退避')
    assert.equal(row.attempts, 1)
    // 同键重排（任务再次交付）：合并而非丢弃——payload 取最新，重试预算清零后本次失败仍只记 1。
    const second = t.service.enqueueOutbox({
      kind: 'review_delegate_auto', payload: { taskId: 'task-a', v: 2 },
      idempotencyKey: 'review_auto:task-a',
    })
    assert.equal(second, first, '同键合并保队列位：返回既有行 id')
    row = t.store.get('SELECT * FROM outbox WHERE id = ?', first)
    assert.equal(JSON.parse(row.payload_json).v, 2, 'payload 覆盖为最新')
    assert.equal(row.attempts, 1, '重排清零重试预算，本次失败只记 1 而非累计 2')
    assert.equal(
      Number(t.store.get('SELECT COUNT(*) AS n FROM outbox WHERE kind = ?', 'review_delegate_auto').n),
      1, '重排不产生第二行',
    )
    assert.equal(calls, 2, '合并命中立即补投一次')
    // 投递成功后同键再来一次：delivered 行复活重投，仍取最新 payload。
    t.service.applyOutbox = () => 'ok'
    t.store.run('UPDATE outbox SET available_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), first)
    t.service.dispatchOutbox()
    assert.equal(t.store.get('SELECT status FROM outbox WHERE id = ?', first).status, 'delivered')
    t.service.enqueueOutbox({
      kind: 'review_delegate_auto', payload: { taskId: 'task-a', v: 3 },
      idempotencyKey: 'review_auto:task-a',
    })
    row = t.store.get('SELECT * FROM outbox WHERE id = ?', first)
    assert.equal(row.status, 'delivered', '复活后立即重投成功')
    assert.equal(JSON.parse(row.payload_json).v, 3)
    assert.equal(row.attempts, 1, '复活清零后成功只记 1 次')
    assert.equal(
      Number(t.store.get('SELECT COUNT(*) AS n FROM outbox WHERE kind = ?', 'review_delegate_auto').n),
      1,
    )
  } finally { await t.close() }
})

test('非白名单 kind 先写者赢：同键重排不覆盖 payload、不重置 attempts、不刷新退避窗口', async () => {
  const t = await setup()
  try {
    let calls = 0
    t.service.applyOutbox = () => { calls += 1; throw new Error('down') }
    const first = t.service.enqueueOutbox({
      kind: 'dm_reply', payload: { messageId: 'm1' }, idempotencyKey: 'dm_reply:m1',
    })
    const before = t.store.get('SELECT * FROM outbox WHERE id = ?', first)
    assert.equal(before.attempts, 1)
    const second = t.service.enqueueOutbox({
      kind: 'dm_reply', payload: { messageId: 'm1-REPLACED' }, idempotencyKey: 'dm_reply:m1',
    })
    assert.equal(second, first)
    const after = t.store.get('SELECT * FROM outbox WHERE id = ?', first)
    assert.equal(JSON.parse(after.payload_json).messageId, 'm1', '先写者赢：消息 payload 不被覆盖')
    assert.equal(after.attempts, 1, 'attempts 不被重置')
    assert.equal(after.available_at, before.available_at, '退避窗口不被新入队刷新')
    assert.equal(calls, 1, '撞键的重复入队不触发第二次投递')
  } finally { await t.close() }
})

test('defer 不计数不阻塞：error.defer 只前移 available_at，attempts 不动，别的行照投', async () => {
  const t = await setup()
  try {
    t.service.applyOutbox = row => {
      if (JSON.parse(row.payload_json).tag === 'busy') {
        const error = new Error('暂无空闲 slot，稍后再试') as Error & { defer: boolean }
        error.defer = true
        throw error
      }
      return 'ok'
    }
    const busy = t.service.enqueueOutbox({
      kind: 'review_delegate_auto', payload: { tag: 'busy' }, idempotencyKey: 'coalesce:defer:busy',
    })
    let row = t.store.get('SELECT * FROM outbox WHERE id = ?', busy)
    assert.equal(row.status, 'pending', 'defer 保持 pending')
    assert.equal(row.attempts, 0, 'defer 不计入重试次数')
    assert.ok(new Date(row.available_at).getTime() > Date.now(), 'available_at 前移到未来')
    assert.match(row.last_error, /暂无空闲 slot/, 'defer 原因留痕')
    // 不阻塞：另一行到点照常领取投递，deferred 行未到点不被领取。
    const okId = t.service.enqueueOutbox({
      kind: 'dm_reply', payload: { tag: 'go' }, idempotencyKey: 'dm_reply:defer-ok',
      availableAt: new Date(Date.now() + 60_000),
    })
    t.store.run('UPDATE outbox SET available_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), okId)
    t.service.dispatchOutbox()
    assert.equal(t.store.get('SELECT status FROM outbox WHERE id = ?', okId).status, 'delivered', 'deferred 行不阻塞其他行领取')
    assert.equal(t.store.get('SELECT status FROM outbox WHERE id = ?', busy).status, 'pending')
    // 到点后再领：仍 defer，attempts 依旧 0——可无限次等待，不进 5 次上限。
    t.store.run('UPDATE outbox SET available_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), busy)
    t.service.dispatchOutbox()
    row = t.store.get('SELECT * FROM outbox WHERE id = ?', busy)
    assert.equal(row.attempts, 0, '反复 defer 也不计数')
    assert.ok(new Date(row.available_at).getTime() > Date.now(), '再次前移等待')
  } finally { await t.close() }
})

test('既有退避回归：普通失败计数并指数退避，5 次转 failed，permanent 立即终局', async () => {
  const t = await setup()
  try {
    t.service.applyOutbox = () => { throw new Error('boom') }
    const id1 = t.service.enqueueOutbox({ kind: 'task_run', payload: {}, idempotencyKey: 'backoff:normal' })
    let row = t.store.get('SELECT * FROM outbox WHERE id = ?', id1)
    assert.equal(row.status, 'pending')
    assert.equal(row.attempts, 1)
    const waitMs = new Date(row.available_at).getTime() - Date.now()
    assert.ok(waitMs > 1500 && waitMs <= 2100, `第 1 次退避约 2s（实测 ${waitMs}ms）`)
    // 连撞到第 5 次：转 failed 停止重试。
    t.store.run('UPDATE outbox SET attempts = 4, available_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), id1)
    t.service.dispatchOutbox()
    row = t.store.get('SELECT * FROM outbox WHERE id = ?', id1)
    assert.equal(row.status, 'failed', 'attempts 到 5 转 failed')
    assert.equal(row.attempts, 5)
    assert.match(row.last_error, /boom/)
    // permanent 错误：第一次就终局。
    t.service.applyOutbox = () => { const error = new Error('nope') as Error & { permanent: boolean }; error.permanent = true; throw error }
    const id2 = t.service.enqueueOutbox({ kind: 'task_run', payload: {}, idempotencyKey: 'backoff:perm' })
    row = t.store.get('SELECT * FROM outbox WHERE id = ?', id2)
    assert.equal(row.status, 'failed', 'permanent 失败立即终局')
    assert.equal(row.attempts, 1)
  } finally { await t.close() }
})

test('queueAutoReviewDelegate 幂等键任务级：同一任务两次交付并入同一行', async () => {
  const t = await setup()
  try {
    t.service.applyOutbox = () => null
    const task = await t.service.createTask({
      projectId: t.project.id, title: '合并排队', assigneeBotId: t.dev.id, postCard: false,
    }, { type: 'bot', id: t.director.id })
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
    const queued1 = t.service.queueAutoReviewDelegate(task, t.project, { id: 'run-1' }, false)
    const queued2 = t.service.queueAutoReviewDelegate(task, t.project, { id: 'run-2' }, false)
    assert.ok(queued1 && queued2)
    const rows = t.store.all("SELECT * FROM outbox WHERE kind = 'review_delegate_auto' AND task_id = ?", task.id)
    assert.equal(rows.length, 1, '任务级键：两次交付并入同一行')
    assert.equal(rows[0].idempotency_key, `review_auto:${task.id}`)
  } finally { await t.close() }
})
