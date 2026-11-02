import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { taskStage, TASK_STAGE_LABEL, taskStageLabel } from '../src/services/tasks.js'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// DSHBOTS-42：任务阶段不存状态位，由 taskStage 纯函数按事实推导（第一匹配行获胜），
// 中文标签由 TASK_STAGE_LABEL 查表，UI 只消费 taskView 下发的 stageLabel，不再从 latestRun.status 拼文案。
// 核心回归锁：终态（done/canceled）一律 ended，不渲染任何运行徽标——线上「已完成列出现已取消/运行中标签」bug。

const srcPath = fileURLToPath(new URL('../src/services/tasks.js', import.meta.url))
const tasksSource = readFileSync(srcPath, 'utf8')
const appSource = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')

test('task-stage 标记块是唯一口径来源：纯函数 + 标签表都住在块内', () => {
  const block = /\/\/ task-stage:start[\s\S]*?\/\/ task-stage:end/.exec(tasksSource)?.[0]
  assert.ok(block, 'src/services/tasks.js 缺少 task-stage 标记块')
  assert.match(block, /export function taskStage\(/)
  assert.match(block, /export const TASK_STAGE_LABEL/)
  assert.match(block, /export function taskStageLabel\(/)
})

test('优先级表逐行：第一匹配行获胜', () => {
  // ended：done / canceled 终态，无视一切运行
  assert.deepEqual(taskStage({ status: 'done' }, { status: 'running', kind: 'task' }), { stage: 'ended' })
  assert.deepEqual(taskStage({ status: 'canceled' }, null), { stage: 'ended' })
  // person/answer：有结构化提问，优先于运行中/排队
  assert.deepEqual(taskStage({ status: 'in_progress' }, { status: 'running', kind: 'task' }, { id: 'q1' }), { stage: 'person', action: 'answer' })
  // working：运行 running 且 kind='task'
  assert.deepEqual(taskStage({ status: 'in_progress' }, { status: 'running', kind: 'task' }), { stage: 'working' })
  // working/queued：运行排队中
  assert.deepEqual(taskStage({ status: 'todo' }, { status: 'queued', kind: 'task' }), { stage: 'working', action: 'queued' })
  // person/failed：最近运行失败
  assert.deepEqual(taskStage({ status: 'in_progress' }, { status: 'failed', kind: 'task' }), { stage: 'person', action: 'failed' })
  // idle：无运行兜底；最近运行成功也不再翻旧账
  assert.deepEqual(taskStage({ status: 'todo' }, null), { stage: 'idle' })
  assert.deepEqual(taskStage({ status: 'in_progress' }, { status: 'succeeded', kind: 'task' }), { stage: 'idle' })
})

test('kind 非 task 的运行不算正在执行：验收/评审运行挂着的任务仍是 idle', () => {
  assert.deepEqual(taskStage({ status: 'in_review' }, { status: 'running', kind: 'review' }), { stage: 'idle' })
})

test('回归锁：done 任务挂着 canceled/running/queued 运行一律 ended、不显示任何运行标签', () => {
  for (const runStatus of ['canceled', 'running', 'queued', 'failed']) {
    const stage = taskStage({ status: 'done' }, { status: runStatus, kind: 'task' })
    assert.deepEqual(stage, { stage: 'ended' }, `done 任务挂 ${runStatus} 运行必须推导为 ended`)
    assert.equal(taskStageLabel(stage), null, `ended 不得有任何运行标签（runStatus=${runStatus}）`)
  }
})

test('标签表口径：七行查表文案，ended 不显示', () => {
  assert.deepEqual(TASK_STAGE_LABEL, {
    'person/answer': '等待你回答',
    'person/failed': '需要你处理',
    'person/review': '等待验收',
    working: '正在执行',
    'working/queued': '排队中',
    idle: '空闲',
    ended: null,
  })
})

test('taskStageLabel 按 stage/action 组合键查表，未知组合返回 null', () => {
  assert.equal(taskStageLabel({ stage: 'person', action: 'answer' }), '等待你回答')
  assert.equal(taskStageLabel({ stage: 'person', action: 'failed' }), '需要你处理')
  assert.equal(taskStageLabel({ stage: 'working' }), '正在执行')
  assert.equal(taskStageLabel({ stage: 'working', action: 'queued' }), '排队中')
  assert.equal(taskStageLabel({ stage: 'idle' }), '空闲')
  assert.equal(taskStageLabel({ stage: 'ended' }), null)
  assert.equal(taskStageLabel(null), null)
  assert.equal(taskStageLabel({ stage: 'unknown', action: 'x' }), null)
})

test('taskView 接线：视图下发结构化 stage 与查表后的 stageLabel', () => {
  assert.match(tasksSource, /const stage = taskStage\(task, runs\[0\] \?\? null, null\)/)
  assert.match(tasksSource, /stageLabel: taskStageLabel\(stage\)/)
})

test('任务卡接线：运行徽标以 stage/stageLabel 为准，不再从 latestRun.status 拼映射', () => {
  assert.match(appSource, /const runLabel = ended \? '' : task\.stageLabel \?\? ''/)
  assert.match(appSource, /\$\{!ended && run \? runDot\(run\.status\) : ''\}/)
  assert.doesNotMatch(appSource, /const runLabel = run \? \(\{/, '不得再用 latestRun.status 映射拼运行文案')
})

test('任务详情接线：modal 徽标走同一标签口径，ended 不显示', () => {
  assert.match(appSource, /badge: task\.stageLabel \? esc\(task\.stageLabel\) : ''/)
})

// ── 服务级管道回归锁：真库真 taskView，锁「数据 → 推导 → 下发」整条链 ──

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-stage-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

function seedRun(store, { id, projectId, botId, taskId, status, kind = 'task', queuedAt }) {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, status, attempt, idempotency_key, queued_at)
     VALUES (?, ?, ?, ?, ?, 'task_created', ?, 1, ?, ?)`,
    id, projectId, botId, taskId, kind, status, `test:${id}`, queuedAt,
  )
}

test('服务级：done 任务挂着真实 canceled 运行 → stage ended、stageLabel null（线上 bug 管道锁）', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Task Stage', key: 'STAGE', ownerBotId: director.id })
    const actor = service.actor()
    const task = await service.createTask({ projectId: project.id, title: '已验收任务' }, actor)
    for (const status of ['todo', 'in_progress', 'in_review', 'done']) {
      await service.updateTask(task.id, { status }, actor)
    }
    seedRun(store, { id: 'run_cancel', projectId: project.id, botId: director.id, taskId: task.id, status: 'canceled', queuedAt: '2026-11-02T10:00:00.000Z' })

    const view = service.taskView(store.get('SELECT * FROM tasks WHERE id = ?', task.id))
    assert.deepEqual(view.stage, { stage: 'ended' })
    assert.equal(view.stageLabel, null, '终态任务不得下发任何运行标签')
    assert.equal(view.latestRun?.status, 'canceled', '真实取消运行仍在 latestRun（历史事实不丢）')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('服务级：in_progress 任务挂着 running task 运行 → 正在执行；running review 运行不算', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Task Stage 2', key: 'STG2', ownerBotId: director.id })
    const actor = service.actor()
    const runningTask = await service.createTask({ projectId: project.id, title: '执行中任务' }, actor)
    for (const status of ['todo', 'in_progress']) {
      await service.updateTask(runningTask.id, { status }, actor)
    }
    seedRun(store, { id: 'run_work', projectId: project.id, botId: director.id, taskId: runningTask.id, status: 'running', kind: 'task', queuedAt: '2026-11-02T10:00:00.000Z' })
    const runningView = service.taskView(store.get('SELECT * FROM tasks WHERE id = ?', runningTask.id))
    assert.deepEqual(runningView.stage, { stage: 'working' })
    assert.equal(runningView.stageLabel, '正在执行')

    const reviewTask = await service.createTask({ projectId: project.id, title: '验收中任务' }, actor)
    for (const status of ['todo', 'in_progress', 'in_review']) {
      await service.updateTask(reviewTask.id, { status }, actor)
    }
    seedRun(store, { id: 'run_review', projectId: project.id, botId: director.id, taskId: reviewTask.id, status: 'running', kind: 'review', queuedAt: '2026-11-02T11:00:00.000Z' })
    const reviewView = service.taskView(store.get('SELECT * FROM tasks WHERE id = ?', reviewTask.id))
    assert.deepEqual(reviewView.stage, { stage: 'idle' }, 'kind 非 task 的运行不推导为 working')
    assert.equal(reviewView.stageLabel, '空闲')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
