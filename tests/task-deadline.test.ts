// tests/task-deadline.test.ts —— DSHBOTS-274 任务级死线守门。
// 根因：time_budget_minutes 只经 runTimeoutMsForTaskRun 约束单运行，卡的多轮运行
// （交付→退回→再交付）各自重置预算，整卡累计耗时无上限。守门四类：
// a) 死线计算与延期重算（taskDeadlineMs 纯函数：首次派发基准/延期阀基准/无预算无派发不约束）；
// b) 超线拒绝启动新 task 运行 + 自动升级（canceled TASK_DEADLINE + 卡面评论 D-269 口径 +
//    status→blocked + owner 系统通知，run_events 留 task_deadline 锚）；
// c) review 运行豁免（kind!=='task' 不走死线闸）；
// d) 施工提示词时效段注入剩余时间（Deadline: ... / N min remaining）与耗尽收尾轮文案；
//    review 提示词不注入 Deadline 行。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { TASK_BUDGET_ROUNDS, taskDeadlineMs } from '../src/services/tasks.js'

const T0 = '2026-11-06T02:00:00.000Z'

test('a) 死线计算：首次派发 + 预算×轮数；延期阀换基准；无预算/无派发不约束', () => {
  assert.equal(TASK_BUDGET_ROUNDS, 2, '允许轮数常量为 2（可调，导出供测试）')
  // 首次派发基准：02:00 + 10min×2 = 02:20
  assert.equal(
    taskDeadlineMs({ budgetMinutes: 10, firstDispatchAt: T0, firstDispatchSinceBudgetChangeAt: null }),
    Date.parse('2026-11-06T02:20:00.000Z'),
    '死线 = 首次派发 + time_budget_minutes × TASK_BUDGET_ROUNDS',
  )
  // 延期阀重算：改过预算后基准切到改预算之后的首个派发（05:00 + 10×2 = 05:20），非首次派发
  assert.equal(
    taskDeadlineMs({ budgetMinutes: 10, firstDispatchAt: T0, firstDispatchSinceBudgetChangeAt: '2026-11-06T05:00:00.000Z' }),
    Date.parse('2026-11-06T05:20:00.000Z'),
    '延期阀：改预算后死线按新预算从改后首个派发重算，不沿用首次派发',
  )
  // 多轮派发自身不重置窗口：基准只认首次（或改预算后的首个），后续轮次不进公式
  assert.equal(taskDeadlineMs({ budgetMinutes: 0, firstDispatchAt: T0, firstDispatchSinceBudgetChangeAt: null }), null, '无预算不约束')
  assert.equal(taskDeadlineMs({ budgetMinutes: 10, firstDispatchAt: null, firstDispatchSinceBudgetChangeAt: null }), null, '无派发记录不约束')
})

class ManualRuntime {
  declare started: any[]
  declare pendingRuns: any
  constructor() { this.started = []; this.pendingRuns = new Map() }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }: any) { this.started.push(run.id); this.pendingRuns.set(run.id, run); return `session-${run.id}` }
  async steer() { return true }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-tdl-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = false
  // 隔离执行层：本守门只钉领取闸与升级路径，不起真会话。
  service.executeRun = async () => {}
  const director = store.get('SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)')
  const dev = await service.createBot({ name: 'DeadlineDev', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Deadline', key: 'TDL', ownerBotId: director.id, memberIds: [dev.id] })
  const promptRuntime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  return { root, store, service, runtime, promptRuntime, director, dev, project }
}

async function cleanup(root, store) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    let active = 0
    try {
      active = Number(store.get('SELECT COUNT(*) AS n FROM runs WHERE status IN (\'queued\', \'running\')')?.n ?? 0)
    } catch { break }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

// 建一张带预算与负责人的卡，派一轮施工运行并把派发时刻回拨到超线（预算×2 窗口之外）。
async function overdueTask(t, { budget = 5, backdateMs = 60 * 60_000 } = {}) {
  const created = await t.service.createTask({
    projectId: t.project.id, title: '死线卡', assigneeBotId: t.dev.id,
    timeBudgetMinutes: budget, writeScopes: ['src/**'], description: 'Do it.',
  })
  const taskId = created.id
  const run1 = t.service.enqueueTaskRun(t.service.taskRow(taskId), 'task_started', { type: 'user', id: 'u1' })
  const past = new Date(Date.now() - backdateMs).toISOString()
  t.store.run("UPDATE runs SET status = 'canceled', ended_at = ? WHERE id = ?", past, run1)
  t.store.run('UPDATE runs SET queued_at = ? WHERE id = ?', past, run1)
  return { taskId, run1 }
}

// 死线升级经 fire-and-forget 异步落库（领取路径保持同步），测试侧短轮询收敛。
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return fn()
}

test('b) 超线拒绝启动新 task 运行 + 升级：canceled TASK_DEADLINE + 卡面评论 + blocked + owner 通知', async () => {
  const t = await setup()
  try {
    const { taskId } = await overdueTask(t)
    const run2 = t.service.enqueueTaskRun(t.service.taskRow(taskId), 'task_started', { type: 'user', id: 'u1' })
    t.service.started = true
    await t.service.tick()
    assert.ok(await waitFor(() => t.store.get('SELECT status FROM runs WHERE id = ?', run2)?.status === 'canceled'), '超线的施工运行必须拒绝启动')
    const runRow = t.store.get('SELECT * FROM runs WHERE id = ?', run2)
    assert.equal(runRow.error_code, 'TASK_DEADLINE', '拒绝原因码 TASK_DEADLINE')
    assert.ok(t.runtime.started.length === 0, '超线运行不得进入执行层')
    assert.ok(await waitFor(() => t.store.get('SELECT status FROM tasks WHERE id = ?', taskId)?.status === 'blocked'), '任务自动转 blocked')
    const comment = t.store.get('SELECT body FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId)
    assert.match(comment.body, /超时中止（预算×2）已到，任务未关单：owner 可改 time_budget_minutes 延期后重派/, '卡面评论走 D-269 引导口径')
    const notice = t.store.get('SELECT * FROM messages WHERE task_id = ? AND sender_type = \'system\' ORDER BY created_at DESC LIMIT 1', taskId)
    assert.ok(notice, 'owner 系统通知落库（复用 insertMessage 通道）')
    assert.deepEqual(JSON.parse(notice.mentions_json ?? '[]'), [t.director.id], '通知点名项目 owner')
    assert.ok(t.store.get("SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = 'task_deadline'", run2), 'run_events 留 task_deadline 锚')

    // 延期阀（④）：owner 改 time_budget_minutes 后重派，死线按新预算从新派发重算，新运行可启动。
    await t.service.updateTask(taskId, { timeBudgetMinutes: 30 }, { type: 'user', id: 'u1' })
    const taskRow = t.service.taskRow(taskId)
    assert.ok(taskRow.budget_updated_at, '改预算落 budget_updated_at 锚')
    const run3 = t.service.enqueueTaskRun(taskRow, 'task_started', { type: 'user', id: 'u1' })
    await t.service.tick()
    const run3Row = t.store.get('SELECT * FROM runs WHERE id = ?', run3)
    assert.equal(run3Row.status, 'running', '延期重派后新派发拿到完整新窗口，正常领取')
    assert.notEqual(run3Row.error_code, 'TASK_DEADLINE')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('c) review 豁免：同一超线任务上的 review 运行不走死线闸', async () => {
  const t = await setup()
  try {
    const { taskId } = await overdueTask(t)
    const reviewRun = 'run_review_x'
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, ?, 'review', 'read', 'review', ?, 'queued', 1, ?, ?)`,
      reviewRun, t.project.id, t.director.id, taskId, taskId, `rev:${taskId}`, new Date().toISOString(),
    )
    t.service.started = true
    await t.service.tick()
    const row = t.store.get('SELECT * FROM runs WHERE id = ?', reviewRun)
    assert.notEqual(row.error_code, 'TASK_DEADLINE', 'review 运行不得被死线拒绝')
    assert.equal(row.status, 'running', 'review 运行照常领取（kind!=="task" 豁免）')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('d) 提示词：时效段注入剩余时间；耗尽后收尾轮口径；review 提示词不注入 Deadline 行', async () => {
  const t = await setup()
  try {
    const { taskId } = await overdueTask(t)
    const taskRow = t.service.taskRow(taskId)
    const base = { bot: t.dev, project: t.project, task: taskRow, sessionId: 's-x' }
    // 剩余时间：另一张刚派发的卡（派发=现在，窗口=预算×2 内）。
    const fresh = await t.service.createTask({
      projectId: t.project.id, title: '新鲜卡', assigneeBotId: t.dev.id,
      timeBudgetMinutes: 30, writeScopes: ['src/**'], description: 'Do it.',
    })
    const freshRun = t.service.enqueueTaskRun(t.service.taskRow(fresh.id), 'task_started', { type: 'user', id: 'u1' })
    const runRow = t.store.get('SELECT * FROM runs WHERE id = ?', freshRun)
    const prompt = t.promptRuntime.promptFor({ run: runRow, ...base, task: t.service.taskRow(fresh.id) })
    assert.match(prompt, /# Time budget/, '时效段仍注入（既有锚点不回归）')
    assert.match(prompt, /Deadline: \S+ \/ \d+ min remaining\./, '施工提示词含剩余时间一行')
    // 耗尽文案：直接按超线派发史构造（派发已回拨，死线已过）。
    const stalePrompt = t.promptRuntime.promptFor({
      run: { kind: 'task', task_id: taskId, trigger_type: 'task_started' } as any, ...base,
    })
    assert.ok(stalePrompt.includes('超线，本轮是收尾轮，优先可交付小步'), '预算耗尽后施工提示词含收尾轮口径')
    // review 豁免传导到提示词：review 分支不传 deadline，不注入 Deadline 行。
    const reviewPrompt = t.promptRuntime.promptFor({
      run: { kind: 'review', task_id: taskId, trigger_type: 'review' } as any, ...base,
    })
    assert.ok(reviewPrompt.includes('# Time budget'), 'review 提示词保留单运行时效段（D-131 口径）')
    assert.ok(!reviewPrompt.includes('Deadline:'), 'review 提示词不注入整卡死线剩余时间')
  } finally {
    await cleanup(t.root, t.store)
  }
})

// 源码级钉住（D-269 手法）：死线闸必须挂在 kind='task' 领取分支内（review 豁免的结构保证）。
const SCHEDULER_SRC = readFileSync(fileURLToPath(new URL('../src/services/scheduler.ts', import.meta.url)), 'utf8')
test('源码锚：死线闸在 kind=\'task\' 领取分支内，升级路径与文案被钉住', () => {
  const gate = SCHEDULER_SRC.indexOf("if (run.kind === 'task' && run.task_id)")
  const deadlineGate = SCHEDULER_SRC.indexOf('escalateTaskPastDeadline(taskRow, run.id)')
  assert.ok(gate >= 0 && deadlineGate > gate, '死线闸位于施工运行领取分支（依赖闸之后）')
  assert.ok(SCHEDULER_SRC.includes('TASK_DEADLINE'), '拒绝原因码 TASK_DEADLINE 被钉')
})
