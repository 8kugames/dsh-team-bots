// DSHBOTS-54：看板拖拽联动——拖入「执行中」自动入队开工并发系统指令消息；
// 拖出到 todo/blocked 暂停活跃运行（PAUSED_BY_BOARD，区别于 SUPERSEDED）；
// system 消息本身不触发 bot 运行；同状态重复拖拽零副作用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// startRun 只记账不回调完成：任务 run 停在 running，拖出暂停路径才有活跃运行可停。
class HoldingRuntime { declare started: any[]; declare canceled: any[];
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
// 运行开工只由联动逻辑里的显式 this.tick() 驱动，断言时序确定。
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-board-drag-'))
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

async function seedProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({ name: 'Board', key: 'BRD', ownerBotId: director.id, memberIds: [dev.id] })
  return { dev, project }
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

const systemMessages = (store, projectId) =>
  store.all("SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' ORDER BY rowid", projectId)

const runEventTypes = (store, runId) =>
  store.all('SELECT type FROM run_events WHERE run_id = ?', runId).map(row => row.type)

test('拖入执行中：自动入队 board_resume 运行并发系统指令消息（文案全等、mentions 带 assignee、返回视图不过期）', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '落地看板联动', assigneeBotId: dev.id, postCard: false })
    assert.equal(task.status, 'todo')

    const view = await service.transitionTask(task.id, 'in_progress', { type: 'user', id: service.localUserId })

    const run = store.get('SELECT * FROM runs WHERE task_id = ?', task.id)
    assert.ok(run, '拖入执行中自动入队了任务运行')
    assert.equal(run.kind, 'task')
    assert.equal(run.trigger_type, 'board_resume')
    assert.ok(run.write_scopes, '写范围快照照旧落库')
    await waitFor(() => store.get('SELECT status FROM runs WHERE id = ?', run.id).status === 'running')
    assert.ok(runEventTypes(store, run.id).includes('board_resume'), 'run 侧记 board_resume 事件')

    assert.equal(view.status, 'in_progress')
    assert.equal(view.identifier, `BRD-${task.number}`)
    assert.equal(view.latestRun?.id, run.id, '返回视图带最新入队的运行，不是过期快照')

    const messages = systemMessages(store, project.id)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].task_id, task.id)
    assert.equal(messages[0].sender_id, 'system')
    assert.equal(messages[0].body, `任务 BRD-${task.number} 已开始（Builder）。`)
    assert.deepEqual(JSON.parse(messages[0].mentions_json), [dev.id])
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('拖出执行中（todo 与 blocked 两跳）：活跃运行 canceled + PAUSED_BY_BOARD + board_pause 事件 + 系统消息', async () => {
  const { root, store, service, runtime } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '看板暂停验证', assigneeBotId: dev.id, postCard: false })
    const actor = { type: 'user', id: service.localUserId }
    const resumeBody = `任务 BRD-${task.number} 已开始（Builder）。`
    const pauseBody = `任务 BRD-${task.number} 已移出执行中，运行已暂停。`

    await service.transitionTask(task.id, 'in_progress', actor)
    let run1
    await waitFor(() => {
      run1 = store.get("SELECT * FROM runs WHERE task_id = ? AND status = 'running'", task.id)
      return run1
    })

    await service.transitionTask(task.id, 'todo', actor)
    const paused1 = store.get('SELECT * FROM runs WHERE id = ?', run1.id)
    assert.equal(paused1.status, 'canceled')
    assert.equal(paused1.error_code, 'PAUSED_BY_BOARD', '看板暂停专用错误码，区别于 SUPERSEDED')
    assert.equal(paused1.error_message, '任务被移出执行中，运行暂停')
    assert.ok(paused1.ended_at)
    assert.equal(paused1.cancel_requested, 1)
    assert.ok(runEventTypes(store, run1.id).includes('board_pause'), 'run 侧记 board_pause 事件')
    assert.ok(runtime.canceled.includes(run1.id), 'runtime.cancelRun 已下发')
    assert.equal(service.taskRow(task.id).status, 'todo')
    assert.equal(systemMessages(store, project.id).at(-1).body, pauseBody)

    // 再拖入 → 新运行；再拖出到 blocked（出向枚举第二跳）→ 同样暂停
    await service.transitionTask(task.id, 'in_progress', actor)
    let run2
    await waitFor(() => {
      run2 = store.get("SELECT * FROM runs WHERE task_id = ? AND status = 'running'", task.id)
      return run2
    })
    await service.transitionTask(task.id, 'blocked', actor)
    const paused2 = store.get('SELECT * FROM runs WHERE id = ?', run2.id)
    assert.equal(paused2.status, 'canceled')
    assert.equal(paused2.error_code, 'PAUSED_BY_BOARD')
    assert.ok(runEventTypes(store, run2.id).includes('board_pause'))
    assert.equal(service.taskRow(task.id).status, 'blocked')

    const bodies = systemMessages(store, project.id).map(message => message.body)
    assert.deepEqual(bodies, [resumeBody, pauseBody, resumeBody, pauseBody], '两轮拖入+拖出各一条指令消息')

    // 暂停的运行保留在执行历史（latestRun 可见），不会被 SUPERSEDED 口径排除
    const view = service.taskView(service.taskRow(task.id))
    assert.equal(view.latestRun?.id, run2.id)
    assert.equal(view.latestRun?.error_code, 'PAUSED_BY_BOARD')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('重复拖拽零副作用；拖出到 in_review 释放写占用（中止写运行）但不发指令消息', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '重复拖拽验证', assigneeBotId: dev.id, postCard: false })
    const actor = { type: 'user', id: service.localUserId }
    await service.transitionTask(task.id, 'in_progress', actor)
    await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND status = 'running'", task.id))

    const counts = () => ({
      runs: Number(store.get('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?', task.id).n),
      messages: systemMessages(store, project.id).length,
      events: Number(store.get('SELECT COUNT(*) AS n FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?)', task.id).n),
    })
    const before = counts()
    await service.transitionTask(task.id, 'in_progress', actor)
    await service.transitionTask(task.id, 'in_progress', actor)
    assert.deepEqual(counts(), before, '同状态重复拖拽：零新运行、零新消息、零新事件')

    // DSHBOTS-73：任务离开「进行中」即释放写占用——写运行被中止，写槽让给同项目其他写运行。
    // 看板指令消息仍只覆盖 todo/blocked 两跳，拖到 in_review 不发消息、不新建运行。
    await service.transitionTask(task.id, 'in_review', actor)
    const after = counts()
    assert.equal(after.runs, before.runs, '拖出到 in_review 不新建运行')
    assert.equal(after.messages, before.messages, '拖出到 in_review 不发指令消息')
    assert.ok(after.events > before.events, '拖出到 in_review 记写占用释放事件')
    const run = store.get('SELECT * FROM runs WHERE task_id = ?', task.id)
    assert.equal(run.status, 'canceled', 'in_review 出向中止写运行，释放写占用')
    assert.equal(run.error_code, 'TASK_LEFT_IN_PROGRESS')
    assert.ok(runEventTypes(store, run.id).includes('task_left_in_progress'), 'run 侧记写占用释放事件')
    assert.equal(service.taskRow(task.id).status, 'in_review')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('系统指令消息不触发 bot 运行：无会话类 run、无以消息为触发源的 run、无 chat_run outbox', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '系统消息语义', assigneeBotId: dev.id, postCard: false })
    await service.transitionTask(task.id, 'in_progress', { type: 'user', id: service.localUserId })
    await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND status = 'running'", task.id))

    const messages = systemMessages(store, project.id)
    assert.equal(messages.length, 1)
    assert.ok(messages[0].body.startsWith('任务 '), '生命周期状态消息照常投递')
    assert.equal(messages[0].sender_type, 'system')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE kind IN ('chat', 'solo_chat', 'dm_reply')").n, 0, '无任何会话类运行')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE trigger_ref = ?', messages[0].id).n, 0, '指令消息不是任何运行的触发源')
    assert.equal(Number(store.get('SELECT COUNT(*) AS n FROM runs WHERE project_id = ?', project.id).n), 1, '项目下仅自动入队的任务运行')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'chat_run'").n, 0, '系统消息不挂 chat_run outbox')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('已有活跃运行时拖入执行中：不重复入队、不发指令消息', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '活跃运行守卫', assigneeBotId: dev.id, postCard: false })
    // 同步直入队一条运行且不触发 tick：任务保持 todo，活跃运行已存在
    service.enqueueTaskRun(service.taskRow(task.id), 'manual', { type: 'system', id: 'system' })

    await service.transitionTask(task.id, 'in_progress', { type: 'user', id: service.localUserId })

    const runs = store.all('SELECT * FROM runs WHERE task_id = ?', task.id)
    assert.equal(runs.length, 1, '不重复入队')
    assert.equal(runs[0].trigger_type, 'manual')
    assert.equal(systemMessages(store, project.id).length, 0, '不发指令消息（不能对已在跑的任务喊立即开始）')
    assert.equal(service.taskRow(task.id).status, 'in_progress', '状态迁移本身照常生效')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
