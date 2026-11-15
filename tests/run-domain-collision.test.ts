// 回归（生产异常「UNIQUE constraint failed: index 'one_active_run_per_bot'」）：
// ①memory_review 与 ②review_delegate 的 INSERT 占 bot 串行域但入队点无兜底——同
// (bot, 工作区) 已有活跃非任务运行时直插撞部分唯一索引，异常沿收尾/委派路径上抛。
// 修复口径：memory_review 撞车降级跳过返 null（调用方走沉淀兜底/忽略）；review_delegate
// 撞车视同 busy 闸——挂待处理队列返回 deferred，空闲后建回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-run-collision-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 30_000,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  await service.initialize()
  service.started = true
  return { root, store, service }
}

const cleanup = async ({ root, store }: any) => {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

// 直接落一条同 (bot, 工作区) 的活跃非任务运行，占住串行域。
const occupyDomain = (store: any, botId: string, projectId: string) => {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status,
       attempt, idempotency_key, queued_at)
     VALUES (?, ?, ?, 'chat', 'read', 'mention', 'occ', 'running', 1, ?, ?)`,
    'run_occupier', projectId, botId, `chat:occ:${botId}`, new Date().toISOString(),
  )
}

test('串行域被占时 enqueueMemoryReview 降级跳过，不抛 UNIQUE', async (t) => {
  const ctx = await setup()
  t.after(async () => { await cleanup(ctx) })
  const { store, service } = ctx
  const dev = await service.createBot({ name: 'mem', role: '开发', instructions: 'x', provider: 'fake', model: 'm' })
  const project = await service.createProject({ name: 'MC', key: 'MCOL', memberIds: [dev.id] })
  occupyDomain(store, dev.id, project.id)

  const runId = service.enqueueMemoryReview(project, service.botRow(dev.id), null, 'run_src_1')
  assert.equal(runId, null, '撞串行域时返回 null（跳过），不抛异常')
  assert.equal(
    store.get("SELECT count(*) AS n FROM runs WHERE kind = 'memory_review'").n, 0,
    '不落半截运行行',
  )
})

test('串行域被占时 spawnReviewDelegate 挂起返回 deferred，不抛 UNIQUE', async (t) => {
  const ctx = await setup()
  t.after(async () => { await cleanup(ctx) })
  const { store, service } = ctx
  const owner = await service.createBot({ name: 'boss', role: '总监', instructions: 'x', provider: 'fake', model: 'm' })
  const dev = await service.createBot({ name: 'dev1', role: '开发', instructions: 'x', provider: 'fake', model: 'm' })
  const project = await service.createProject({ name: 'RD', key: 'RDEL', memberIds: [dev.id], ownerBotId: owner.id })
  const task = await service.createTask({
    projectId: project.id, title: 't', description: 'd',
    assigneeType: 'bot', assigneeBotId: dev.id,
  }, { type: 'user', id: 'u1' })
  store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
  // 总监的串行域先被占：busy 闸之外，这里直接构造查后插竞态不可行（同进程内 busy 会先拦），
  // 故占住域后走 busy 分支同款的 hold；再单独验证 INSERT 兜底分支：释放域、占回、直插路径。
  occupyDomain(store, owner.id, project.id)
  // ①busy 闸路径：查得见活跃运行 → 挂起返回 deferred。
  const busyResult = service.spawnReviewDelegate(service.taskRow(task.id), { actor: { type: 'user', id: 'u1' } })
  assert.deepEqual(busyResult, { runId: null, deferred: true }, '域被占时挂起返回 deferred')
  store.run("DELETE FROM settings WHERE key = ?", `bot_pending_msgs:${owner.id}:${project.id}`)
  // ②查后插竞态路径（本次修复的新分支）：busy 检查被绕过（多进程同拍过检），INSERT
  // 撞 one_active_run_per_bot → catch 兜底挂起返回 deferred，不向上抛 UNIQUE。
  const realBotBusy = service.botBusy.bind(service)
  service.botBusy = () => false
  try {
    const raceResult = service.spawnReviewDelegate(service.taskRow(task.id), { actor: { type: 'user', id: 'u1' } })
    assert.deepEqual(raceResult, { runId: null, deferred: true }, '查后插竞态撞索引时同样挂起返回 deferred')
  } finally {
    service.botBusy = realBotBusy
  }
  assert.ok(
    store.get("SELECT value FROM settings WHERE key = ?", `bot_pending_msgs:${owner.id}:${project.id}`),
    '挂起项已落待处理队列',
  )
})
