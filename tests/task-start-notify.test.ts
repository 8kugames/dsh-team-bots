// DSHBOTS-100：任务进入「进行中」的通知与开工入队——
// 任何路径（看板拖拽 todo/blocked/in_review → in_progress、编辑表单 update_task 改状态）
// 让任务进入「进行中」且有负责人时，都要发一条系统消息 @负责人（任务 X 已开始（botName）。）
// 并入队一次 task_run；已有活跃运行时既不重复入队也不重复发消息（幂等）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// startRun 只记账不回调完成：任务 run 停在 running，便于断言活跃运行守卫。
class HoldingRuntime {
  declare started: string[]
  declare canceled: string[]
  constructor() {
    this.started = []
    this.canceled = []
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) {
    this.started.push(run.id)
    return `session-${run.id}`
  }
  async cancelRun(runId) {
    this.canceled.push(runId)
    return true
  }
}

// schedulerIntervalMs 拉满 30s（resolveConfig 上限）：测试期内定时 tick 不掺和，
// 开工只由联动逻辑里的显式 this.tick() 驱动，断言时序确定。
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-start-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new HoldingRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  return { root, store, service, runtime }
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timeout waiting for condition')
}

async function closeQuietly(store, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch {
      break
    }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    store.close()
  } catch {}
}

async function seedProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({ name: 'Start', key: 'TSN', ownerBotId: director.id, memberIds: [dev.id] })
  return { dev, project }
}

const systemMessages = (store, projectId) =>
  store.all("SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' ORDER BY rowid", projectId)

const taskRuns = (store, taskId) =>
  store.all("SELECT * FROM runs WHERE task_id = ? AND kind = 'task' ORDER BY rowid", taskId)

const startMessages = (store, projectId) =>
  systemMessages(store, projectId).filter(message => message.body.includes('已开始'))

test('todo → in_progress（看板拖拽路径）：发一条 @负责人的系统消息，并入队一次运行', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '拖入执行中', assigneeBotId: dev.id, postCard: false })
    assert.equal(task.status, 'todo')

    await service.transitionTask(task.id, 'in_progress', { type: 'user', id: service.localUserId })

    const messages = startMessages(store, project.id)
    assert.equal(messages.length, 1, '只发一条开始消息')
    assert.equal(messages[0].body, `任务 TSN-${task.number} 已开始（Builder）。`)
    assert.equal(messages[0].sender_type, 'system')
    assert.equal(messages[0].task_id, task.id)
    assert.deepEqual(JSON.parse(messages[0].mentions_json), [dev.id], '消息点名负责人')

    const runs = taskRuns(store, task.id)
    assert.equal(runs.length, 1, '只入队一次运行')
    assert.equal(runs[0].trigger_type, 'board_resume', '看板拖入沿用既有运行触发类型')
    await waitFor(() => store.get('SELECT status FROM runs WHERE id = ?', runs[0].id).status === 'running')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('blocked → in_progress（用户把卡移出受阻再移回执行中）：同样通知并开工', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '受阻后恢复', assigneeBotId: dev.id, postCard: false })
    const actor = { type: 'user', id: service.localUserId }
    await service.transitionTask(task.id, 'blocked', actor)
    assert.equal(service.taskRow(task.id).status, 'blocked')

    await service.transitionTask(task.id, 'in_progress', actor)

    const messages = startMessages(store, project.id)
    assert.equal(messages.length, 1, 'blocked → in_progress 也要发开始消息')
    assert.equal(messages[0].body, `任务 TSN-${task.number} 已开始（Builder）。`)
    assert.deepEqual(JSON.parse(messages[0].mentions_json), [dev.id])

    const runs = taskRuns(store, task.id)
    assert.equal(runs.length, 1, '入队一次运行')
    assert.equal(runs[0].trigger_type, 'board_resume')
    assert.equal(service.taskRow(task.id).status, 'in_progress')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('in_review → in_progress（总监退回/用户改回执行中）：同样通知并开工', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '待验收改回执行中', assigneeBotId: dev.id, postCard: false })
    const actor = { type: 'user', id: service.localUserId }
    await service.transitionTask(task.id, 'in_progress', actor)
    await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND status = 'running'", task.id))
    await service.transitionTask(task.id, 'in_review', actor)
    await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND status = 'canceled'", task.id))

    await service.transitionTask(task.id, 'in_progress', actor)

    const messages = startMessages(store, project.id)
    assert.equal(messages.length, 2, '两次进入执行中各一条开始消息')
    assert.equal(messages[1].body, `任务 TSN-${task.number} 已开始（Builder）。`)
    assert.deepEqual(JSON.parse(messages[1].mentions_json), [dev.id])

    const runs = taskRuns(store, task.id)
    assert.equal(runs.length, 2, '第二次进入执行中再入队一次运行')
    assert.equal(runs[1].trigger_type, 'board_resume')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('update_task 改成 in_progress（任务编辑表单）：同样通知并开工，同状态重复提交不重复发', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '编辑表单改状态', assigneeBotId: dev.id, postCard: false })
    const actor = { type: 'user', id: service.localUserId }

    await service.updateTask(task.id, { status: 'in_progress' }, actor)

    const messages = startMessages(store, project.id)
    assert.equal(messages.length, 1, 'update_task 路径也要发开始消息')
    assert.equal(messages[0].body, `任务 TSN-${task.number} 已开始（Builder）。`)
    assert.equal(messages[0].task_id, task.id)
    assert.deepEqual(JSON.parse(messages[0].mentions_json), [dev.id])

    const runs = taskRuns(store, task.id)
    assert.equal(runs.length, 1, 'update_task 路径也要入队一次运行')
    assert.equal(runs[0].trigger_type, 'task_started', '非看板路径用默认触发类型')

    // 同一任务重复提交同一状态：零新消息、零新运行（幂等）
    await service.updateTask(task.id, { status: 'in_progress' }, actor)
    assert.equal(startMessages(store, project.id).length, 1, '重复提交不重复发消息')
    assert.equal(taskRuns(store, task.id).length, 1, '重复提交不重复入队')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('总监退回重做（in_review → in_progress）：负责人收到开始消息，运行沿用 returned 触发类型', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '退回重做', assigneeBotId: dev.id, postCard: false })
    const actor = { type: 'user', id: service.localUserId }
    await service.transitionTask(task.id, 'in_progress', actor)
    await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND status = 'running'", task.id))
    await service.transitionTask(task.id, 'in_review', actor)
    await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND status = 'canceled'", task.id))

    await service.applyReview(
      service.taskRow(task.id),
      service.projectRow(project.id),
      'return',
      '需要补充测试',
      actor,
    )

    const messages = startMessages(store, project.id)
    assert.equal(messages.length, 2, '退回重做也算一次「进入进行中」，负责人收到开始消息')
    assert.equal(messages[1].body, `任务 TSN-${task.number} 已开始（Builder）。`)
    assert.deepEqual(JSON.parse(messages[1].mentions_json), [dev.id])

    const runs = taskRuns(store, task.id)
    assert.equal(runs.length, 2, '退回重做入队一次运行')
    assert.equal(runs[1].trigger_type, 'returned', '退回重做的运行沿用既有触发类型')
    assert.equal(service.taskRow(task.id).status, 'in_progress')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('无负责人：不发消息、不入队（没人可通知、也没人可开工）', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { project } = await seedProject(service, store)
    // 无负责人的任务默认落在 backlog（backlog → in_progress 服务端按 TRANSITIONS 拒绝），
    // 这里显式建成 todo，才能测「进入进行中但无负责人」这条路径。
    task = await service.createTask({ projectId: project.id, title: '无主任务', status: 'todo', postCard: false })
    assert.equal(task.status, 'todo')

    await service.transitionTask(task.id, 'in_progress', { type: 'user', id: service.localUserId })

    assert.equal(service.taskRow(task.id).status, 'in_progress', '状态迁移本身照常生效')
    assert.equal(startMessages(store, project.id).length, 0, '无负责人不发开始消息')
    assert.equal(taskRuns(store, task.id).length, 0, '无负责人不入队运行')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('已有活跃运行：既不重复入队也不重复发消息（幂等）', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '活跃运行守卫', assigneeBotId: dev.id, postCard: false })
    // 同步直入队一条运行且不触发 tick：任务保持 todo，活跃运行已存在
    service.enqueueTaskRun(service.taskRow(task.id), 'manual', { type: 'system', id: 'system' })

    await service.transitionTask(task.id, 'in_progress', { type: 'user', id: service.localUserId })

    const runs = taskRuns(store, task.id)
    assert.equal(runs.length, 1, '不重复入队')
    assert.equal(runs[0].trigger_type, 'manual', '既有运行不被替换')
    assert.equal(startMessages(store, project.id).length, 0, '不重复发消息（不能对已在跑的任务喊开始）')
    assert.equal(service.taskRow(task.id).status, 'in_progress', '状态迁移本身照常生效')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
