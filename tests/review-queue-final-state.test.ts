// tests/review-queue-final-state.test.js —— DSHBOTS-275 review 运行入队前终态预检守门
// 纯源码级断言钉住入队点改造，另用临时库（openDatabase 全量迁移基建）做端到端：
// ① 终态预检代码路径：enqueueOwnerTaskRun 在 INSERT INTO runs 之前按库内最新任务状态
//    （this.taskRow 重读，不吃调用方过期行）预检，done/canceled 直接 return null 不产生 run 行；
// ② 兜底取消路径保留：任务流转终态时的 cancelSupersededQueuedRuns / cancelStaleQueuedTaskRuns
//    与「任务已结束，排队运行被清理」（SUPERSEDED + stale_superseded）文案一行不动，仍治
//    「入队后才到终态」的残留排队运行；run-finish 的 owner_task_run outbox 投递链路不变；
// ③ 端到端：终态任务经 enqueueOwnerTaskRun 不再产生 review run 行；非终态照常入队（语义不变）；
//    已排队 review 运行遇任务关单仍走兜底取消文案。
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

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const taskRunsSource = read('../src/services/task-runs.ts')
const schedulerSource = read('../src/services/scheduler.ts')
const runFinishSource = read('../src/services/run-finish.ts')

function methodBody(source, signature) {
  const at = source.indexOf(signature)
  assert.ok(at >= 0, `应存在方法 ${signature}`)
  return source.slice(at, source.indexOf('\n  },', at))
}

test('预检①：enqueueOwnerTaskRun 入队前按库内最新状态终态预检，终态即跳过不产生 run 行', () => {
  const body = methodBody(taskRunsSource, 'enqueueOwnerTaskRun(task, kind) {')
  // 预检存在且按最新库内状态判定（this.taskRow 重读），不吃调用方可能过期的 task 行
  assert.match(body, /const current = this\.taskRow\(task\.id\)/, '应以库内最新任务行判定终态')
  assert.match(
    body,
    /if \(!current \|\| current\.status === 'done' \|\| current\.status === 'canceled'\) return null/,
    '任务 done/canceled（或已删除）应直接返回 null，不入队',
  )
  // 预检必须先于 run 行落库与排队检查，保证终态分支不可能产生任何 runs 行
  const precheck = body.indexOf('this.taskRow(task.id)')
  const insert = body.indexOf('INSERT INTO runs')
  const activeCheck = body.indexOf("status IN ('queued', 'running')")
  assert.ok(precheck >= 0 && insert > precheck, '终态预检应在 INSERT INTO runs 之前')
  assert.ok(activeCheck < 0 || activeCheck > precheck, '终态预检应在排队去重检查之前（终态短路不并入已有运行）')
})

test('预检②：outbox 投递侧既有终态预检保留（owner_task_run / review_delegate 双闸不回退）', () => {
  const ownerRun = schedulerSource
  assert.match(
    ownerRun,
    /if \(!task \|\| \['done', 'canceled'\]\.includes\(task\.status\)\) return null\s*\n\s*return this\.enqueueOwnerTaskRun\(/,
    'owner_task_run outbox 应用时仍先跳过终态任务再入队',
  )
  assert.match(
    ownerRun,
    /if \(!task \|\| task\.status !== 'in_review'\) return null/,
    'review_delegate_auto 的 in_review 守卫不动',
  )
  // run-finish 只投 outbox 行、不经手 run 行，链路应保持零改动（无直插 review run 的新路径）
  assert.doesNotMatch(runFinishSource, /INSERT INTO runs/, 'run-finish 不得直插 run 行（只投 outbox）')
})

test('兜底③：入队后终态的取消清理路径与「任务已结束，排队运行被清理」文案一行不动', () => {
  const cancelBody = methodBody(schedulerSource, 'cancelQueuedRunAsSuperseded(runId) {')
  assert.match(cancelBody, /'任务已结束，排队运行被清理'/, 'UPDATE 取消文案保留')
  assert.match(cancelBody, /'stale_superseded', '任务已结束，排队运行被清理（SUPERSEDED）'/, 'stale_superseded 事件文案保留')
  const supersedeBody = methodBody(taskRunsSource, 'cancelSupersededQueuedRuns(taskId) {')
  assert.match(supersedeBody, /this\.cancelQueuedRunAsSuperseded\(row\.id\)/, '任务终态流转仍全量清理残留排队运行')
  assert.match(
    schedulerSource,
    /this\.cancelStaleQueuedTaskRuns\(\)/,
    'tick 前置清理（kind=.task. 陈旧排队守卫）保留',
  )
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-final-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const now = new Date().toISOString()
  store.run(
    "INSERT INTO bots(id, name, role, status, created_at, updated_at) VALUES ('bot_owner', 'owner-x', '总监', 'active', ?, ?)",
    now, now,
  )
  store.run(
    "INSERT INTO projects(id, key, name, slug, owner_bot_id, status, created_at, updated_at) VALUES ('prj_1', 'T1', '竞态验证', 't1', 'bot_owner', 'active', ?, ?)",
    now, now,
  )
  store.run(
    "INSERT INTO tasks(id, project_id, number, title, status, creator_type, creator_id, review_target, created_at, updated_at)"
      + " VALUES ('tsk_1', 'prj_1', 1, '验收竞态卡', 'done', 'user', 'u1', 'owner_bot', ?, ?)",
    now, now,
  )
  return { store, service, root }
}

async function teardown({ store, root }) {
  store.close()
  await rm(root, { recursive: true, force: true })
}

test('端到端：终态任务不再产生 review run 行；非终态照常入队；入队后关单仍走兜底取消', async () => {
  const state = await setup()
  try {
    const { store, service } = state
    const runCount = () => Number(store.get('SELECT COUNT(*) AS n FROM runs')?.n ?? 0)

    // done：入队即跳过，不产生 run 行
    const doneTask = store.get('SELECT * FROM tasks WHERE id = ?', 'tsk_1') 
    assert.equal(service.enqueueOwnerTaskRun(doneTask, 'review'), null, 'done 任务入队返回 null')
    assert.equal(runCount(), 0, 'done 任务不应产生任何 run 行')

    // canceled：同口径跳过
    store.run("UPDATE tasks SET status = 'canceled' WHERE id = 'tsk_1'")
    const canceledTask = store.get('SELECT * FROM tasks WHERE id = ?', 'tsk_1')
    assert.equal(service.enqueueOwnerTaskRun(canceledTask, 'review'), null, 'canceled 任务入队返回 null')
    assert.equal(runCount(), 0, 'canceled 任务不应产生任何 run 行')

    // 过期行防护：调用方手里还是旧状态（in_progress），库内已终态 → 以库内为准跳过
    store.run("UPDATE tasks SET status = 'done' WHERE id = 'tsk_1'")
    const staleRow = { ...store.get('SELECT * FROM tasks WHERE id = ?', 'tsk_1'), status: 'in_progress' }
    assert.equal(service.enqueueOwnerTaskRun(staleRow, 'review'), null, '库内终态时调用方过期行不得入队')
    assert.equal(runCount(), 0, '过期行路径也不应产生 run 行')

    // 非终态（in_review）：照常入队，review 运行语义不变
    store.run("UPDATE tasks SET status = 'in_review' WHERE id = 'tsk_1'")
    const reviewTask = store.get('SELECT * FROM tasks WHERE id = ?', 'tsk_1')
    const runId = service.enqueueOwnerTaskRun(reviewTask, 'review')
    assert.ok(typeof runId === 'string' && runId.startsWith('run'), '非终态任务应正常入队')
    const run = store.get('SELECT * FROM runs WHERE id = ?', runId)
    assert.equal(run.kind, 'review')
    assert.equal(run.status, 'queued')
    assert.equal(runCount(), 1, '非终态任务恰好产生一条 run 行')

    // 兜底：已排队 review 运行遇到任务关单（终态流转）仍被「任务已结束，排队运行被清理」取消
    store.run("UPDATE tasks SET status = 'done' WHERE id = 'tsk_1'")
    const canceled = service.cancelSupersededQueuedRuns('tsk_1')
    assert.equal(canceled, 1, '关单时应清理残留排队 review 运行')
    const after = store.get('SELECT * FROM runs WHERE id = ?', runId)
    assert.equal(after.status, 'canceled')
    assert.equal(after.error_code, 'SUPERSEDED')
    assert.equal(after.error_message, '任务已结束，排队运行被清理')
    const evt = store.get("SELECT * FROM run_events WHERE run_id = ? AND type = 'stale_superseded'", runId)
    assert.ok(evt, 'stale_superseded 事件应保留')
  } finally {
    await teardown(state)
  }
})
