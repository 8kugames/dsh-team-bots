// tests/task-deadline.test.ts —— DSHBOTS-274 任务级死线守门（DSHBOTS-281 基准升级）。
// 根因：time_budget_minutes 只经 runTimeoutMsForTaskRun 约束单运行，卡的多轮运行
// （交付→退回→再交付）各自重置预算，整卡累计耗时无上限。守门五类：
// a) 死线计算与重派重算（taskDeadlineMs 纯函数：最新派发基准/重派即新窗口/无预算无派发不约束）；
// b) 超线拒绝启动新 task 运行 + 自动升级（canceled TASK_DEADLINE + 卡面评论点名总监含自动重置口径 +
//    status→blocked + owner 系统通知，run_events 留 task_deadline 锚）；
// c) review 运行豁免（kind!=='task' 不走死线闸）；
// d) 施工提示词时效段注入剩余时间（Deadline: ... / N min remaining）与耗尽收尾轮文案；
//    review 提示词不注入 Deadline 行；
// e) 重派即新窗口（DSHBOTS-281）：存量老卡重派不改预算不升级（正例）+ 新窗口内预算×2
//    耗尽仍照常拦截（负例）。
// f) review 运行预算分档（DSHBOTS-302）：review/handle 取 min(全局, 分档)（默认 10，
//    settings review_timeout_minutes [3,60]，env 显式最高）；chat/dm/solo 沿用全局。

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
import { runTimeoutMsForTaskRun, effectiveReviewTimeoutMinutes } from '../src/services/runtime/session.js'

const T0 = '2026-11-06T02:00:00.000Z'

test('a) 死线计算：最新派发 + 预算×轮数；重派即新窗口；无预算/无派发不约束', () => {
  assert.equal(TASK_BUDGET_ROUNDS, 2, '允许轮数常量为 2（可调，导出供测试）')
  // 唯一派发即基准：02:00 + 10min×2 = 02:20
  assert.equal(
    taskDeadlineMs({ budgetMinutes: 10, firstDispatchAt: T0, latestDispatchAt: T0 }),
    Date.parse('2026-11-06T02:20:00.000Z'),
    '死线 = 派发 + time_budget_minutes × TASK_BUDGET_ROUNDS',
  )
  // 重派即新窗口（DSHBOTS-281）：基准=最新一次派发（05:00 + 10×2 = 05:20），
  // 存量老卡重派自动重置窗口，不沿用首次派发（旧口径曾取首次 → 立即超线）。
  assert.equal(
    taskDeadlineMs({ budgetMinutes: 10, firstDispatchAt: T0, latestDispatchAt: '2026-11-06T05:00:00.000Z' }),
    Date.parse('2026-11-06T05:20:00.000Z'),
    '重派即新窗口：基准=最新派发，每次派发都把死线推到本次 queued_at + 预算×轮数',
  )
  assert.equal(taskDeadlineMs({ budgetMinutes: 0, firstDispatchAt: T0, latestDispatchAt: T0 }), null, '无预算不约束')
  assert.equal(taskDeadlineMs({ budgetMinutes: 10, firstDispatchAt: null, latestDispatchAt: null }), null, '无派发记录不约束')
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
// D-281 基准=最新派发：升级条件是「最新派发本身超线」，调用方须把本次测试的派发同样回拨。
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
  return { taskId, run1, past }
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
    const { taskId, past } = await overdueTask(t)
    const run2 = t.service.enqueueTaskRun(t.service.taskRow(taskId), 'task_started', { type: 'user', id: 'u1' })
    // 最新派发也回拨超线：D-281 基准=最新 queued_at，只回拨首轮派发不再构成升级条件。
    t.store.run('UPDATE runs SET queued_at = ? WHERE id = ?', past, run2)
    t.service.started = true
    await t.service.tick()
    assert.ok(await waitFor(() => t.store.get('SELECT status FROM runs WHERE id = ?', run2)?.status === 'canceled'), '超线的施工运行必须拒绝启动')
    const runRow = t.store.get('SELECT * FROM runs WHERE id = ?', run2)
    assert.equal(runRow.error_code, 'TASK_DEADLINE', '拒绝原因码 TASK_DEADLINE')
    assert.ok(t.runtime.started.length === 0, '超线运行不得进入执行层')
    assert.ok(await waitFor(() => t.store.get('SELECT status FROM tasks WHERE id = ?', taskId)?.status === 'blocked'), '任务自动转 blocked')
    const comment = t.store.get('SELECT body FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId)
    assert.match(comment.body, /超时中止（预算×2）已到，任务未关单/, '卡面评论保留超时原因（D-269 口径）')
    assert.match(comment.body, /总监/, '卡面评论点名总监（第一负责人）')
    assert.match(comment.body, /自动重置死线窗口/, '卡面评论含「重派即自动重置窗口」事实口径')
    assert.doesNotMatch(comment.body, /owner 可改/, '不得再写「owner 可改 time_budget_minutes」转接话术')
    const notice = t.store.get('SELECT * FROM messages WHERE task_id = ? AND sender_type = \'system\' ORDER BY created_at DESC LIMIT 1', taskId)
    assert.ok(notice, '总监系统通知落库（复用 insertMessage 通道）')
    assert.deepEqual(JSON.parse(notice.mentions_json ?? '[]'), [t.director.id], '通知点名项目 owner（=总监）')
    assert.ok(t.store.get("SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = 'task_deadline'", run2), 'run_events 留 task_deadline 锚')

    // 延期阀兼容：总监改 time_budget_minutes 后重派，死线按新预算从新派发重算，新运行可启动。
    await t.service.updateTask(taskId, { timeBudgetMinutes: 30 }, { type: 'user', id: 'u1' })
    const taskRow = t.service.taskRow(taskId)
    assert.ok(taskRow.budget_updated_at, '改预算落 budget_updated_at 锚')
    const run3 = t.service.enqueueTaskRun(taskRow, 'task_started', { type: 'user', id: 'u1' })
    await t.service.tick()
    const run3Row = t.store.get('SELECT * FROM runs WHERE id = ?', run3)
    assert.equal(run3Row.status, 'running', '改预算后重派拿到完整新窗口，正常领取')
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
    assert.ok(stalePrompt.includes('this is a wrap-up turn, prioritize a small deliverable step'), '预算耗尽后施工提示词含收尾轮口径')
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

// 重派即新窗口（DSHBOTS-281）：存量老卡重派不改预算不升级（正例）+ 新窗口内预算×2 耗尽仍拦截（负例）。
test('e) 重派即新窗口：老卡重派不升级（正例）；新窗口真超时仍拦截（负例）', async () => {
  const t = await setup()
  try {
    // 正例：存量老卡（首次派发早已超线）不改预算直接重派——死线基准自动切到本次 queued_at，
    // 新运行正常领取，不触发升级、不转 blocked。
    const { taskId } = await overdueTask(t)
    const redispatch = t.service.enqueueTaskRun(t.service.taskRow(taskId), 'task_started', { type: 'user', id: 'u1' })
    t.service.started = true
    await t.service.tick()
    const row = t.store.get('SELECT * FROM runs WHERE id = ?', redispatch)
    assert.equal(row.status, 'running', '老卡重派（无预算实改）必须正常领取，不得升级')
    assert.notEqual(row.error_code, 'TASK_DEADLINE')
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', taskId)?.status, 'in_progress', '重派卡正常进入施工')
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?', taskId)?.n, 0, '不升级即不落超时评论')

    // 负例：新窗口内预算×2 耗尽仍照常拦截——收掉本轮后把最新派发整体回拨到窗口之外，
    // 下一次领取照常升级（canceled TASK_DEADLINE + blocked）。
    const older = new Date(Date.now() - 120 * 60_000).toISOString()
    t.store.run("UPDATE runs SET status = 'canceled', ended_at = ?, queued_at = ? WHERE id = ?", older, older, redispatch)
    const run4 = t.service.enqueueTaskRun(t.service.taskRow(taskId), 'task_started', { type: 'user', id: 'u1' })
    t.store.run('UPDATE runs SET queued_at = ? WHERE id = ?', new Date(Date.now() - 60 * 60_000).toISOString(), run4)
    await t.service.tick()
    assert.ok(await waitFor(() => t.store.get('SELECT status FROM runs WHERE id = ?', run4)?.status === 'canceled'), '新窗口超时的施工运行必须拒绝启动')
    assert.equal(t.store.get('SELECT * FROM runs WHERE id = ?', run4)?.error_code, 'TASK_DEADLINE', '拒绝原因码 TASK_DEADLINE')
    assert.ok(await waitFor(() => t.store.get('SELECT status FROM tasks WHERE id = ?', taskId)?.status === 'blocked'), '真超时自动转 blocked')
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

// f) review 运行预算分档（DSHBOTS-302）：director 单车道上 review/handle（owner_task 运行族）
// 长尾会堵住同 bot 的 chat 消息运行——上限取 min(全局, review 分档)；分档生效链与
// effectiveRunLimits 同款（env 显式 > settings review_timeout_minutes [3,60] > 默认 10）；
// chat/dm/solo 沿用全局不受影响；task 时效取 min 逻辑不变。
test('f) review 预算分档：默认 10 / settings 覆盖 8 / 全局更小取全局 / chat 不受影响', () => {
  const min = (m) => m * 60_000
  const reviewRun = { kind: 'review', task_id: 't1' }
  const handleRun = { kind: 'handle', task_id: 't1' }
  // 生效链：默认 10；settings 整数 [3,60] 可覆盖；非法/越界值回退默认。
  assert.equal(effectiveReviewTimeoutMinutes(() => null), 10, '默认 10 分钟')
  assert.equal(effectiveReviewTimeoutMinutes(key => (key === 'review_timeout_minutes' ? '8' : null)), 8, 'settings 覆盖 8')
  assert.equal(effectiveReviewTimeoutMinutes(key => (key === 'review_timeout_minutes' ? '2' : null)), 10, '低于 3 回退默认')
  assert.equal(effectiveReviewTimeoutMinutes(key => (key === 'review_timeout_minutes' ? '61' : null)), 10, '高于 60 回退默认')
  assert.equal(effectiveReviewTimeoutMinutes(key => (key === 'review_timeout_minutes' ? 'abc' : null)), 10, '非整数回退默认')
  // 分档计算：默认 10（全局 30 → 10）；handle 同款。
  assert.equal(runTimeoutMsForTaskRun({ run: reviewRun, task: null, globalRunTimeoutMs: min(30), reviewTimeoutMs: min(effectiveReviewTimeoutMinutes(() => null)) }), min(10), 'review 默认分档 10 分钟')
  assert.equal(runTimeoutMsForTaskRun({ run: handleRun, task: null, globalRunTimeoutMs: min(30), reviewTimeoutMs: min(8) }), min(8), 'handle 同款分档')
  // 全局更小取全局：分档 10、全局 5 → 5。
  assert.equal(runTimeoutMsForTaskRun({ run: reviewRun, task: null, globalRunTimeoutMs: min(5), reviewTimeoutMs: min(10) }), min(5), '全局更小时取全局')
  // chat/dm/solo 不受分档影响（负例）：传了 reviewTimeoutMs 也沿用全局。
  for (const kind of ['chat', 'dm', 'dm_reply', 'solo_chat']) {
    assert.equal(runTimeoutMsForTaskRun({ run: { kind }, task: null, globalRunTimeoutMs: min(30), reviewTimeoutMs: min(10) }), min(30), `${kind} 沿用全局`)
  }
  // task 时效取 min 逻辑不变（DSHBOTS-131 原口径）。
  assert.equal(runTimeoutMsForTaskRun({ run: { kind: 'task', task_id: 't2' }, task: { time_budget_minutes: 15 }, globalRunTimeoutMs: min(30), reviewTimeoutMs: min(10) }), min(15), 'task 时效取 min 不变')
  // env 显式最高优先（含钳位）：进程内改 env 后恢复，防污染同文件其他用例。
  const savedEnv = process.env.DSH_TEAM_REVIEW_TIMEOUT_MINUTES
  try {
    process.env.DSH_TEAM_REVIEW_TIMEOUT_MINUTES = '6'
    assert.equal(effectiveReviewTimeoutMinutes(key => '8'), 6, 'env 显式压过 settings')
    process.env.DSH_TEAM_REVIEW_TIMEOUT_MINUTES = '999'
    assert.equal(effectiveReviewTimeoutMinutes(() => null), 60, 'env 越界钳到 60')
  } finally {
    if (savedEnv === undefined) delete process.env.DSH_TEAM_REVIEW_TIMEOUT_MINUTES
    else process.env.DSH_TEAM_REVIEW_TIMEOUT_MINUTES = savedEnv
  }
})
