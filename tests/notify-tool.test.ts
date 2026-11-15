// tests/notify-tool.test.ts —— DSHBOTS-243 守门：team_notify 通知通道。
// 锁定四支：
//  ① target=member 双写（宿主通道 steer + 插件 messages 留痕）与降级单写（宿主句柄
//     不可达 / 投递失败 → 群聊流 insertMessage + chat_run），失败只 warn 不抛；
//  ② target=task 有活跃运行（running + 会话）→ steer 注入该运行会话；
//  ③ target=task 无活跃运行 → 落任务线程消息（task_id 锚定，owner 验收面板可见）；
//  ④ 鉴权限本项目：跨项目成员/任务一律拒绝，非项目成员会话 forbidden。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// 只实现 attachRuntime / notify 链路需要的宿主句柄；steer 可注入（记录调用或抛错）。
class StubRuntime {
  steerImpl: ((sessionId: string, body: string) => Promise<void>) | null
  sent: Array<{ sessionId: string; body: string }>
  // 可选：宿主句柄不可达时删除该字段，服务层即走群聊流降级。
  steer?: (sessionId: string, body: string) => Promise<void>
  constructor({ steer }: { steer?: (sessionId: string, body: string) => Promise<void> } = {}) {
    this.steerImpl = steer ?? null
    this.sent = []
    this.steer = async (sessionId, body) => {
      this.sent.push({ sessionId, body })
      if (this.steerImpl) await this.steerImpl(sessionId, body)
    }
  }
  setCompletionHandler() {}
  setMask() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  sessionBusy() { return false }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-notify-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const logger = { info() {}, warn() {}, error() {} }
  const service = new TeamService({ store, config, logger })
  const runtime = new StubRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const caller = await service.createBot({ name: 'Caller', role: '开发', instructions: 'Call.', provider: 'fake', model: 'model-a' })
  const target = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Notify', key: 'NTF', ownerBotId: director.id, memberIds: [caller.id, target.id] })
  const other = await service.createBot({ name: 'Outsider', role: '开发', instructions: 'Out.', provider: 'fake', model: 'model-a' })
  const otherProject = await service.createProject({ name: 'Other', key: 'OTH', ownerBotId: director.id, memberIds: [other.id] })
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, runtime, logger, director, caller, target, project, other, otherProject, close }
}

const bindSession = (store, { sessionId, botId, projectId, kind = 'project', taskId = null }) => {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId, botId, projectId, kind, taskId, new Date().toISOString(),
  )
}

const lastMessage = (store, projectId) =>
  store.get('SELECT * FROM messages WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', projectId)

const outboxFor = (store, kind, like) =>
  store.get('SELECT * FROM outbox WHERE kind = ? AND payload_json LIKE ?', kind, like)

test('target=member 双写：宿主通道 steer 投递 + 群聊留痕（来源 bot、@目标）', async () => {
  const t = await setup()
  try {
    bindSession(t.store, { sessionId: 'sess-caller', botId: t.caller.id, projectId: t.project.id, kind: 'bot' })
    bindSession(t.store, { sessionId: 'sess-target', botId: t.target.id, projectId: t.project.id, kind: 'bot' })
    const result = await t.service.notifyFromBot('sess-caller', {
      target: 'member', member: 'Builder', message: '请复核 D-243 的守门断言',
    })
    assert.match(result, /宿主通道投递/, '宿主通道可达时应走即时投递')
    assert.equal(t.runtime.sent.length, 1, '应向目标项目会话 steer 一次')
    assert.equal(t.runtime.sent[0].sessionId, 'sess-target', '投递到目标成员的项目会话')
    assert.match(t.runtime.sent[0].body, /请复核 D-243/, '投递正文应含通知内容')
    const message = lastMessage(t.store, t.project.id)
    assert.equal(message.sender_type, 'bot', '留痕来源应是发起 bot')
    assert.equal(message.sender_id, t.caller.id, '留痕应记录来源 bot')
    assert.equal(message.task_id, null, '成员通知不锚任务线程')
    assert.ok(JSON.parse(message.mentions_json).includes(t.target.id), '留痕应 @ 目标成员')
    assert.match(message.body, /Caller/, '留痕正文应注明来源 bot')
    assert.equal(outboxFor(t.store, 'chat_run', `%${message.id}%`), undefined, '宿主通道已投递时不得再排 chat_run（避免重复唤醒）')
  } finally { await t.close() }
})

test('target=member 降级单写：宿主句柄不可达 → 群聊流 insertMessage + chat_run', async () => {
  const t = await setup()
  try {
    // 运行时无 steer 句柄（宿主通道在服务层不可达）。
    delete t.runtime.steer
    bindSession(t.store, { sessionId: 'sess-caller', botId: t.caller.id, projectId: t.project.id, kind: 'bot' })
    bindSession(t.store, { sessionId: 'sess-target', botId: t.target.id, projectId: t.project.id, kind: 'bot' })
    const result = await t.service.notifyFromBot('sess-caller', {
      target: 'member', member: 'Builder', message: '宿主通道不可达时的兜底',
    })
    assert.match(result, /群聊流投递/, '句柄不可达应降级群聊流')
    const message = lastMessage(t.store, t.project.id)
    assert.equal(message.sender_id, t.caller.id, '留痕仍应记录来源 bot')
    assert.ok(JSON.parse(message.mentions_json).includes(t.target.id), '留痕应 @ 目标成员')
    const outbox = outboxFor(t.store, 'chat_run', `%${message.id}%`)
    assert.ok(outbox, '降级应排 chat_run outbox')
    const run = t.store.get('SELECT * FROM runs WHERE kind = ? AND bot_id = ?', 'chat', t.target.id)
    assert.ok(run, 'chat_run 应立即落一条目标成员的聊天运行')
  } finally { await t.close() }
})

test('target=member 失败降级：宿主通道投递抛错只 warn 不抛，转群聊流', async () => {
  const t = await setup()
  const warnings: string[] = []
  t.logger.warn = (...args: unknown[]) => warnings.push(args.join(' '))
  t.runtime.steerImpl = async () => { throw new Error('host channel down') }
  try {
    bindSession(t.store, { sessionId: 'sess-caller', botId: t.caller.id, projectId: t.project.id, kind: 'bot' })
    bindSession(t.store, { sessionId: 'sess-target', botId: t.target.id, projectId: t.project.id, kind: 'bot' })
    const result = await t.service.notifyFromBot('sess-caller', {
      target: 'member', member: 'Builder', message: '通道抖动',
    })
    assert.match(result, /群聊流投递/, '投递失败应降级群聊流')
    assert.ok(warnings.some(line => line.includes('宿主通道投递失败')), '失败应留 warn')
    const message = lastMessage(t.store, t.project.id)
    assert.ok(outboxFor(t.store, 'chat_run', `%${message.id}%`), '降级应排 chat_run outbox')
  } finally { await t.close() }
})

test('target=task 有活跃运行：steer 注入该运行会话并落任务线程', async () => {
  const t = await setup()
  try {
    bindSession(t.store, { sessionId: 'sess-caller', botId: t.caller.id, projectId: t.project.id })
    const task = await t.service.createTask({
      projectId: t.project.id,
      title: '通知通道守门',
      description: '补充 notify 工具断言',
      assigneeBotId: t.target.id,
      writeScopes: ['src/notify/'],
      autoStart: false,
      postCard: false,
    }, { type: 'user', id: 'user_local' })
    const runId = 'run-notify-active'
    const now = new Date().toISOString()
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, session_id, queued_at, started_at)
       VALUES (?, ?, ?, ?, 'task', 'write', 'manual', ?, 'running', 1, ?, 'sess-task-run', ?, ?)`,
      runId, t.project.id, t.target.id, task.id, task.id, `notify-test:${task.id}`, now, now,
    )
    const result = await t.service.notifyFromBot('sess-caller', {
      target: 'task', task: `NTF-${task.number}`, message: '请顺带核对跨项目拒绝分支',
    })
    assert.match(result, /活跃运行注入提醒/, '有活跃运行应注入提醒')
    assert.equal(t.runtime.sent.length, 1, '应注入运行会话一次')
    assert.equal(t.runtime.sent[0].sessionId, 'sess-task-run', '注入到活跃运行的会话')
    const message = lastMessage(t.store, t.project.id)
    assert.equal(message.task_id, task.id, '留痕应锚定任务线程')
    assert.equal(message.sender_id, t.caller.id, '留痕应记录来源 bot')
    const event = t.store.get('SELECT * FROM run_events WHERE run_id = ? AND type = ?', runId, 'notified')
    assert.ok(event, '注入应记 run_event notified')
  } finally { await t.close() }
})

test('target=task 无活跃运行：落任务线程消息（owner 验收面板可见）', async () => {
  const t = await setup()
  try {
    bindSession(t.store, { sessionId: 'sess-caller', botId: t.caller.id, projectId: t.project.id })
    const task = await t.service.createTask({
      projectId: t.project.id,
      title: '无运行提醒',
      description: '任务尚未开工',
      assigneeBotId: t.target.id,
      writeScopes: ['src/notify/'],
      autoStart: false,
      postCard: false,
    }, { type: 'user', id: 'user_local' })
    const result = await t.service.notifyFromBot('sess-caller', {
      target: 'task', task: `NTF-${task.number}`, message: '开工前先确认写范围',
    })
    assert.match(result, /落线程提醒/, '无活跃运行应落线程')
    assert.equal(t.runtime.sent.length, 0, '无活跃运行不得注入')
    const message = lastMessage(t.store, t.project.id)
    assert.equal(message.task_id, task.id, '留痕应锚定任务线程')
    assert.equal(message.sender_id, t.caller.id, '留痕应记录来源 bot')
    assert.ok(JSON.parse(message.mentions_json).includes(t.target.id), '任务线程应 @ 负责人')
  } finally { await t.close() }
})

test('鉴权：跨项目成员/任务一律拒绝，非项目成员会话 forbidden', async () => {
  const t = await setup()
  try {
    bindSession(t.store, { sessionId: 'sess-caller', botId: t.caller.id, projectId: t.project.id })
    await assert.rejects(
      () => t.service.notifyFromBot('sess-caller', { target: 'member', member: 'Outsider', message: '越界' }),
      /没有叫 Outsider 的成员 Bot/,
      '跨项目成员应被拒绝',
    )
    const otherTask = await t.service.createTask({
      projectId: t.otherProject.id,
      title: '他项目任务',
      description: '不应被本项目触达',
      assigneeBotId: t.other.id,
      writeScopes: ['src/notify/'],
      autoStart: false,
      postCard: false,
    }, { type: 'user', id: 'user_local' })
    await assert.rejects(
      () => t.service.notifyFromBot('sess-caller', { target: 'task', task: `OTH-${otherTask.number}`, message: '越界' }),
      /找不到任务/,
      '跨项目任务应被拒绝',
    )
    // 非项目成员（未被本项目接纳的 bot）会话：memberContextFor 直接 forbidden。
    bindSession(t.store, { sessionId: 'sess-outsider', botId: t.other.id, projectId: t.project.id })
    await assert.rejects(
      () => t.service.notifyFromBot('sess-outsider', { target: 'member', member: 'Builder', message: '越界' }),
      /不是该项目成员/,
      '非项目成员会话应 forbidden',
    )
    // 参数校验：target=member 缺 member、空正文。
    await assert.rejects(
      () => t.service.notifyFromBot('sess-caller', { target: 'member', message: 'x' }),
      /没有叫 undefined 的成员 Bot|BOT/,
      '缺 member 应报错',
    )
    await assert.rejects(
      () => t.service.notifyFromBot('sess-caller', { target: 'member', member: 'Builder', message: '   ' }),
      /通知内容不能为空/,
      '空正文应报错',
    )
  } finally { await t.close() }
})
