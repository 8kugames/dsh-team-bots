import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { taskStage, TASK_STAGE_LABEL, taskStageLabel } from '../src/services/task-stage.js'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// DSHBOTS-137（superagent 移植卡 C，机制⑤工单七态）：任务阶段不存状态位，由 taskStage
// 纯函数按事实推导「在等谁」（第一匹配行获胜），判定表以 docs/superagent-port-plan.md §1.5 为准。
// 中文标签由 TASK_STAGE_LABEL 查表，UI 只消费 taskView 下发的 stageLabel。
// 存储真值仍归 tasks.status——stage 是展示层统一视图，不是新状态源（防双真值打架）。

const stagePath = fileURLToPath(new URL('../src/services/task-stage.js', import.meta.url))
const stageSource = readFileSync(stagePath, 'utf8')
const tasksSource = readFileSync(fileURLToPath(new URL('../src/services/tasks.js', import.meta.url)), 'utf8')

test('唯一口径来源：七态判定表住在 task-stage.js，tasks.js 不再自带实现', () => {
  assert.match(stageSource, /export function taskStage\(task, latestRun, attention\)/)
  assert.match(stageSource, /export const TASK_STAGE_LABEL/)
  assert.match(stageSource, /export function taskStageLabel\(/)
  // 单一实现守卫：tasks.js 只允许 import，不允许再定义同名函数（防双真值）。
  assert.match(tasksSource, /import \{ taskStage, taskStageLabel \} from '\.\/task-stage\.js'/)
  assert.doesNotMatch(tasksSource, /export function taskStage\(/)
})

test('判定表矩阵：七态逐行，第一匹配行获胜', () => {
  // ended：done / canceled 终态，无视一切运行。
  assert.deepEqual(taskStage({ status: 'done' }, { status: 'running', kind: 'task' }), { stage: 'ended' })
  assert.deepEqual(taskStage({ status: 'canceled' }, null), { stage: 'ended' })
  // person/answer：有待答提问，优先于一切非终态事实（含执行中）。
  assert.deepEqual(taskStage({ status: 'in_progress' }, { status: 'running', kind: 'task' }, { id: 'q1' }), { stage: 'person', action: 'answer' })
  // person/review：in_review 且无提问——即使核验运行在跑，仍是等验收轴（核验是验收环节的一部分）。
  assert.deepEqual(taskStage({ status: 'in_review' }, null), { stage: 'person', action: 'review' })
  assert.deepEqual(taskStage({ status: 'in_review' }, { status: 'running', kind: 'review' }), { stage: 'person', action: 'review' })
  // person/failed：最近运行失败（blocked 常态与 owner 手动回流 in_progress 同口径）。
  assert.deepEqual(taskStage({ status: 'blocked' }, { status: 'failed', kind: 'task' }), { stage: 'person', action: 'failed' })
  assert.deepEqual(taskStage({ status: 'in_progress' }, { status: 'failed', kind: 'task' }), { stage: 'person', action: 'failed' })
  // person/blocked：人工阻塞且无失败运行（依赖闸门/资源等待等非故障卡法）。
  assert.deepEqual(taskStage({ status: 'blocked' }, null), { stage: 'person', action: 'blocked' })
  assert.deepEqual(taskStage({ status: 'blocked' }, { status: 'succeeded', kind: 'task' }), { stage: 'person', action: 'blocked' })
  // working：running 且 kind='task'。
  assert.deepEqual(taskStage({ status: 'in_progress' }, { status: 'running', kind: 'task' }), { stage: 'working' })
  // working/queued：运行排队中（优先于 todo 的待执行——运行已存在更具体）。
  assert.deepEqual(taskStage({ status: 'todo' }, { status: 'queued', kind: 'task' }), { stage: 'working', action: 'queued' })
  // queued：todo 无活跃运行，已派单待执行（含依赖闸门拦住，不区分）。
  assert.deepEqual(taskStage({ status: 'todo' }, null), { stage: 'queued' })
  assert.deepEqual(taskStage({ status: 'todo' }, { status: 'succeeded', kind: 'task' }), { stage: 'queued' })
  // idle：其余兜底——in_progress 无运行、backlog 未入执行池、最近运行成功不翻旧账。
  assert.deepEqual(taskStage({ status: 'in_progress' }, null), { stage: 'idle' })
  assert.deepEqual(taskStage({ status: 'in_progress' }, { status: 'succeeded', kind: 'task' }), { stage: 'idle' })
  assert.deepEqual(taskStage({ status: 'backlog' }, null), { stage: 'idle' })
})

test('预留位守卫：waiting 与 person/delivery 恒不产出（枚举位在、判定表不返回）', () => {
  const statuses = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled']
  const runs = [null, { status: 'queued', kind: 'task' }, { status: 'running', kind: 'task' },
    { status: 'running', kind: 'review' }, { status: 'succeeded', kind: 'task' },
    { status: 'failed', kind: 'task' }, { status: 'canceled', kind: 'task' }]
  const produced = new Set()
  for (const status of statuses) {
    for (const run of runs) {
      for (const attention of [null, { question: 'q?' }]) {
        const stage = taskStage({ status }, run, attention)
        produced.add(stage.action ? `${stage.stage}/${stage.action}` : stage.stage)
      }
    }
  }
  assert.ok(!produced.has('waiting'), 'waiting 是机制②落地后的预留位，当前判定表不得产出')
  assert.ok(!produced.has('person/delivery'), 'person/delivery 无映射触发事实，当前判定表不得产出')
  assert.deepEqual([...produced].sort(), [
    'ended', 'idle', 'person/answer', 'person/blocked', 'person/failed',
    'person/review', 'queued', 'working', 'working/queued',
  ])
})

test('标签表口径：七态 + 两预留位文案，ended 不显示', () => {
  assert.deepEqual(TASK_STAGE_LABEL, {
    'person/answer': '等待你回答',
    'person/review': '等待验收',
    'person/failed': '需要你处理',
    'person/blocked': '等人处理',
    'person/delivery': '等外部交付',
    working: '正在执行',
    'working/queued': '排队中',
    queued: '待执行',
    waiting: '后台等待',
    idle: '空闲',
    ended: null,
  })
})

test('taskStageLabel 按 stage/action 组合键查表，未知组合返回 null', () => {
  assert.equal(taskStageLabel({ stage: 'person', action: 'answer' }), '等待你回答')
  assert.equal(taskStageLabel({ stage: 'person', action: 'review' }), '等待验收')
  assert.equal(taskStageLabel({ stage: 'person', action: 'blocked' }), '等人处理')
  assert.equal(taskStageLabel({ stage: 'queued' }), '待执行')
  assert.equal(taskStageLabel({ stage: 'working' }), '正在执行')
  assert.equal(taskStageLabel({ stage: 'working', action: 'queued' }), '排队中')
  assert.equal(taskStageLabel({ stage: 'idle' }), '空闲')
  assert.equal(taskStageLabel({ stage: 'ended' }), null)
  assert.equal(taskStageLabel(null), null)
  assert.equal(taskStageLabel({ stage: 'unknown', action: 'x' }), null)
})

test('taskView 接线：视图下发结构化 stage 与查表后的 stageLabel', () => {
  assert.match(tasksSource, /const attention = runs\[0\] \? parseAttention\(runs\[0\]\.attention_json\) : null/)
  assert.match(tasksSource, /const stage = taskStage\(task, runs\[0\] \?\? null, attention\)/)
  assert.match(tasksSource, /stageLabel: taskStageLabel\(stage\)/)
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

test('服务级：in_progress 挂 running task 运行 → 正在执行；in_review 挂 running 核验运行 → 等待验收', async () => {
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
    assert.deepEqual(reviewView.stage, { stage: 'person', action: 'review' }, '核验运行在跑不改变等验收轴')
    assert.equal(reviewView.stageLabel, '等待验收')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('服务级：todo 无运行 → 待执行；blocked 无失败运行 → 等人处理（七态新档管道锁）', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Task Stage 3', key: 'STG3', ownerBotId: director.id })
    const actor = service.actor()
    const todoTask = await service.createTask({ projectId: project.id, title: '待执行任务' }, actor)
    await service.updateTask(todoTask.id, { status: 'todo' }, actor)
    const todoView = service.taskView(store.get('SELECT * FROM tasks WHERE id = ?', todoTask.id))
    assert.deepEqual(todoView.stage, { stage: 'queued' })
    assert.equal(todoView.stageLabel, '待执行')

    const blockedTask = await service.createTask({ projectId: project.id, title: '人工阻塞任务' }, actor)
    for (const status of ['todo', 'in_progress', 'blocked']) {
      await service.updateTask(blockedTask.id, { status }, actor)
    }
    const blockedView = service.taskView(store.get('SELECT * FROM tasks WHERE id = ?', blockedTask.id))
    assert.deepEqual(blockedView.stage, { stage: 'person', action: 'blocked' })
    assert.equal(blockedView.stageLabel, '等人处理')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
