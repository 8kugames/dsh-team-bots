// tests/bot-pause-dispatch.test.ts —— DSHBOTS-262 守门：paused 状态真正拦截派发。
// 拒绝式收口（不做「入队等 resume」新机制）：
//  ① paused assignee 新建派单 / 改派 / 重派（task=KEY-N）→ badRequest 且 runs 零新行；
//  ② team_notify 的 member/task 目标处于 paused → badRequest 不投递（无消息行、无 steer）；
//  ③ 看板/表单把任务转「进行中」是派发链路的隐形入口——paused 负责人不入队、不发「已开始」；
//     pending task_run 补投（入队后才暂停）同样不建 run（enqueueTaskRun 兜底）；
//  ④ resume 后派发恢复正常；
//  ⑤ active bot 全路径行为不变（新建即入队、member/task 通知照常投递）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// 手动 runtime：steer 记录调用（验证通知是否真的唤醒目标会话），不自动完成运行。
class StubRuntime {
  sent: any[]
  constructor() {
    this.sent = []
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }: any) { return `session-${run.id}` }
  async steer(sessionId: string, body: string) { this.sent.push({ sessionId, body }) }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pause-dispatch-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new StubRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  // 关闭自动调度：queued 运行停在队列里，由测试显式 dispatchOutbox 驱动。
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const other = await service.createBot({ name: 'Other', role: '测试', instructions: 'Test.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'PauseDispatch', key: 'BPD', ownerBotId: director.id, memberIds: [builder.id, other.id] })
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, runtime, director, builder, other, project, close }
}

const userActor = (service: any) => ({ type: 'user', id: service.localUserId })
const runsCount = (store: any, taskId: string | null = null) => Number(store.get(
  taskId ? 'SELECT COUNT(*) AS n FROM runs WHERE task_id = ?' : 'SELECT COUNT(*) AS n FROM runs',
  ...(taskId ? [taskId] : []),
)?.n ?? 0)
const messagesCount = (store: any) => Number(store.get('SELECT COUNT(*) AS n FROM messages')?.n ?? 0)
const pause = (service: any, botId: string) => service.updateBot(botId, { status: 'paused' }, userActor(service))
const resume = (service: any, botId: string) => service.updateBot(botId, { status: 'active' }, userActor(service))

test('① paused assignee：新建派单拒绝、runs 零新行；改派同样拒绝', async () => {
  const { store, service, builder, other, project, close } = await setup()
  try {
    await pause(service, builder.id)
    const before = runsCount(store)
    await assert.rejects(
      service.createTask({ projectId: project.id, title: '新卡', assigneeBotId: builder.id, writeScopes: ['src/a/'], autoStart: true }),
      /已暂停，先恢复再派卡/,
    )
    // 卡面改派（工作台 updateTask assignee 入口）同口径。
    const backlog = await service.createTask({ projectId: project.id, title: '无主卡', writeScopes: ['src/b/'] })
    await assert.rejects(
      service.updateTask(backlog.id, { assigneeBotId: builder.id }, userActor(service)),
      /已暂停，先恢复再派卡/,
    )
    assert.equal(runsCount(store), before, '新建/改派被拒后 runs 零新行')
    // 派给 active 成员不受影响（回归锚）。
    const ok = await service.createTask({ projectId: project.id, title: '给别人', assigneeBotId: other.id, writeScopes: ['src/c/'], autoStart: false })
    assert.equal(ok.assignee_bot_id, other.id)
    assert.equal(runsCount(store), before, 'autoStart:false 不入队')
  } finally {
    await close()
  }
})

test('② 重派（assignTask task=KEY-N）对 paused assignee 拒绝且 runs 零新行', async () => {
  const { store, service, builder, project, close } = await setup()
  try {
    // builder active 时建卡（autoStart:false 无运行），随后暂停再重派。
    const task = await service.createTask({ projectId: project.id, title: '待重派', assigneeBotId: builder.id, writeScopes: ['src/a/'], autoStart: false })
    await pause(service, builder.id)
    const before = runsCount(store)
    await assert.rejects(
      service.assignTask(task.id, builder.id, userActor(service), { autoStart: true }),
      /已暂停，先恢复再派卡/,
    )
    // 换负责人到 paused bot（重派给不同人）同样拒绝。
    await assert.rejects(
      service.assignTask(task.id, builder.id, userActor(service)),
      /已暂停，先恢复再派卡/,
    )
    assert.equal(runsCount(store), before, '重派被拒后 runs 零新行')
  } finally {
    await close()
  }
})

test('③ notify：member 目标 paused 不投递；task 目标负责人 paused 不投递', async () => {
  const { store, service, runtime, director, builder, other, project, close } = await setup()
  try {
    const task = await service.createTask({ projectId: project.id, title: '提醒对象', assigneeBotId: builder.id, writeScopes: ['src/a/'], autoStart: false })
    await pause(service, builder.id)
    const messagesBefore = messagesCount(store)
    await assert.rejects(
      service.notifyMemberFromBot({ project, from: director, memberName: 'Builder', body: '醒醒' }),
      /已暂停，先恢复再通知/,
    )
    await assert.rejects(
      service.notifyTaskFromBot({ project, from: director, ref: `BPD-${task.number}`, body: '继续' }),
      /已暂停，先恢复再提醒/,
    )
    assert.equal(messagesCount(store), messagesBefore, '两条拒绝都不落消息行')
    assert.equal(runtime.sent.length, 0, '没有 steer 唤醒调用')
    // active 目标不受影响（回归锚）：member 通知照常投递。
    const ok = await service.notifyMemberFromBot({ project, from: director, memberName: 'Other', body: '在吗' })
    assert.match(ok, /已通知 Other/)
    assert.equal(messagesCount(store), messagesBefore + 1, 'active 目标正常留痕一条')
  } finally {
    await close()
  }
})

test('④ 看板/表单转「进行中」不唤醒 paused 负责人；pending task_run 补投不建 run', async () => {
  const { store, service, builder, project, close } = await setup()
  try {
    // 看板路径：todo 卡转 in_progress。
    const task = await service.createTask({ projectId: project.id, title: '拖拽卡', assigneeBotId: builder.id, writeScopes: ['src/a/'], autoStart: false })
    await pause(service, builder.id)
    await service.updateTask(task.id, { status: 'in_progress' }, userActor(service))
    assert.equal(runsCount(store, task.id), 0, 'paused 负责人转进行中不建运行')
    assert.equal(
      Number(store.get("SELECT COUNT(*) AS n FROM messages WHERE task_id = ? AND body LIKE '%已开始%'", task.id)?.n ?? 0),
      0, 'paused 负责人转进行中不发「已开始」',
    )
    // 补投路径：active 时入队一条延迟投递的 task_run（availableAt 在未来 → 留 pending），
    // 到点补投时负责人已暂停。
    await resume(service, builder.id)
    const task2 = await service.createTask({ projectId: project.id, title: '补投卡', assigneeBotId: builder.id, writeScopes: ['src/b/'], autoStart: false })
    await service.enqueueOutbox({
      kind: 'task_run',
      payload: { taskId: task2.id, triggerType: 'assigned' },
      projectId: project.id,
      taskId: task2.id,
      availableAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const pendingOutbox = store.get("SELECT * FROM outbox WHERE kind = 'task_run' AND task_id = ? AND status = 'pending'", task2.id)
    assert.ok(pendingOutbox, '延迟投递的派发在 outbox 留 pending task_run')
    await pause(service, builder.id)
    // 到点补投（applyOutboxRow 即调度器的单条领取路径，不受 available_at 领取窗口限制）。
    service.applyOutboxRow(pendingOutbox)
    assert.equal(runsCount(store, task2.id), 0, 'pending task_run 补投时负责人已暂停：不建 run')
    assert.equal(store.get('SELECT status FROM outbox WHERE id = ?', pendingOutbox.id)?.status, 'delivered', '该 outbox 行按丢弃口径标记 delivered')
  } finally {
    await close()
  }
})

test('⑤ resume 后派发恢复正常（拒绝式收口不吞恢复后的正常路径）', async () => {
  const { store, service, builder, project, close } = await setup()
  try {
    const task = await service.createTask({ projectId: project.id, title: '恢复后重派', assigneeBotId: builder.id, writeScopes: ['src/a/'], autoStart: false })
    await pause(service, builder.id)
    await assert.rejects(service.assignTask(task.id, builder.id, userActor(service)), /已暂停/)
    await resume(service, builder.id)
    await service.assignTask(task.id, builder.id, userActor(service), { autoStart: false })
    service.dispatchOutbox()
    assert.equal(runsCount(store, task.id), 1, 'resume 后重派正常建 queued 运行')
    assert.equal(store.get('SELECT status FROM runs WHERE task_id = ?', task.id)?.status, 'queued')
  } finally {
    await close()
  }
})

test('⑥ active bot 全路径行为不变：新建即入队、通知照常、看板转进行中照常开工', async () => {
  const { store, service, builder, project, close } = await setup()
  try {
    const task = await service.createTask({ projectId: project.id, title: '正常卡', assigneeBotId: builder.id, writeScopes: ['src/a/'], autoStart: true })
    service.dispatchOutbox()
    assert.equal(runsCount(store, task.id), 1, 'active 新建派单照常建运行')
    // 看板转进行中：发「已开始」+ 入队（todo → in_progress 联动）。
    const task2 = await service.createTask({ projectId: project.id, title: '拖拽正常卡', assigneeBotId: builder.id, writeScopes: ['src/b/'], autoStart: false })
    await service.updateTask(task2.id, { status: 'in_progress' }, userActor(service))
    service.dispatchOutbox()
    assert.ok(runsCount(store, task2.id) >= 1, 'active 负责人转进行中照常开工')
    assert.equal(
      Number(store.get("SELECT COUNT(*) AS n FROM messages WHERE task_id = ? AND body LIKE '%已开始%'", task2.id)?.n ?? 0),
      1, 'active 负责人转进行中发一条「已开始」',
    )
    // 任务提醒（无活跃运行）照常落线程。
    const reminder = await service.notifyTaskFromBot({ project, from: store.get('SELECT * FROM bots WHERE id = ?', builder.id), ref: `BPD-${task.number}`, body: '自查' })
    assert.match(reminder, /已向任务 BPD-\d+ 落线程提醒/)
  } finally {
    await close()
  }
})
