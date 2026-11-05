// tests/attention.test.js —— DSHBOTS-43 结构化提问（attention）后端通道。
// 覆盖：带 attention 的运行能被读出、回答后清空并写事件、无 attention 为 null、
// 超长问题截断不报错、非 owner 调用被拒。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

import { resolveConfig } from '../src/config.js'
import { openDatabase } from '../src/db.js'
import { TeamService } from '../src/service.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attention-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir,
    skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0,
    schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Attention', key: 'ATTN', ownerBotId: director.id, memberIds: [dev.id] })
  return { root, store, service, director, dev, project }
}

// 造一条 running 状态的群聊运行（chat 运行占并发但测试里不真跑 runtime）。
async function primeRunningChatRun(service, project, dev) {
  const messageId = service.insertMessage({
    projectId: project.id,
    senderType: 'user',
    senderId: 'user_local',
    body: `@Builder 帮我看看`,
    mentions: [dev.id],
  })
  const runId = service.enqueueChatRun(project, dev, messageId)
  service.store.run("UPDATE runs SET status = 'running', started_at = ?, last_progress_at = ? WHERE id = ?", new Date().toISOString(), new Date().toISOString(), runId)
  return runId
}

test('finishRun 落库 attention，runView 能读出', async () => {
  const { root, store, service, dev, project } = await setup()
  try {
    const runId = await primeRunningChatRun(service, project, dev)
    await service.finishRun({
      runId, status: 'succeeded', output: '看完了',
      attention: { question: '要用哪个方案？', options: ['A', 'B'] },
    })
    const view = service.runView(store.get('SELECT * FROM runs WHERE id = ?', runId))
    assert.deepEqual(view.attention, { question: '要用哪个方案？', options: ['A', 'B'] })
    assert.equal(view.attention_json, undefined, 'attention_json 原始列不得外泄')
    // 迁移名落了 schema_migrations
    assert.ok(store.get("SELECT 1 AS ok FROM schema_migrations WHERE name = 'runs_attention'"))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('answer_attention：回答作为 mention 消息投递、清空 attention、写 attention_answered 事件', async () => {
  const { root, store, service, dev, project } = await setup()
  try {
    const runId = await primeRunningChatRun(service, project, dev)
    await service.finishRun({
      runId, status: 'succeeded', output: '看完了',
      attention: { question: '要用哪个方案？', options: ['A', 'B'] },
    })
    const actor = { type: 'user', id: 'user_local' }
    const view = await service.answerAttention(runId, '用方案 B', actor)
    assert.equal(view.attention, null, '回答后 attention 清空')
    assert.equal(store.get('SELECT attention_json AS v FROM runs WHERE id = ?', runId).v, null)
    const event = store.get("SELECT type, message FROM run_events WHERE run_id = ? AND type = 'attention_answered'", runId)
    assert.ok(event, '应写 attention_answered 事件')
    // 回答作为一条 @Builder 的群聊消息投回会话（同秒可能有多条消息，按用户消息过滤）
    const message = store.get("SELECT * FROM messages WHERE run_id = ? AND sender_type = 'user' ORDER BY created_at DESC LIMIT 1", runId)
    assert.ok(message, '应插入群聊消息')
    assert.ok(JSON.parse(message.mentions_json).includes(dev.id), '消息应 mention 目标 bot')
    assert.ok(message.body.includes('用方案 B'))
    // 且排了 chat_run outbox（复用既有 chat 投递通道）
    const outbox = store.get("SELECT 1 AS ok FROM outbox WHERE kind = 'chat_run' AND source_id = ?", message.id)
    assert.ok(outbox, '应排 chat_run outbox')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('无 attention 的运行 runView.attention 为 null，answer_attention 报冲突', async () => {
  const { root, store, service, dev, project } = await setup()
  try {
    const runId = await primeRunningChatRun(service, project, dev)
    await service.finishRun({ runId, status: 'succeeded', output: '完成' })
    const view = service.runView(store.get('SELECT * FROM runs WHERE id = ?', runId))
    assert.equal(view.attention, null)
    await assert.rejects(
      () => service.answerAttention(runId, '随便答', { type: 'user', id: 'user_local' }),
      /没有待回答的结构化提问/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('超长问题被截断到 200 字、选项截到 4 条，不报错', async () => {
  const { root, store, service, dev, project } = await setup()
  try {
    const runId = await primeRunningChatRun(service, project, dev)
    await service.finishRun({
      runId, status: 'succeeded', output: '完成',
      attention: { question: '问'.repeat(500), options: ['1', '2', '3', '4', '5', '6'] },
    })
    const view = service.runView(store.get('SELECT * FROM runs WHERE id = ?', runId))
    assert.equal(view.attention.question.length, 200)
    assert.equal(view.attention.options.length, 4)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('非 owner 调用 answer_attention 被拒', async () => {
  const { root, store, service, dev, project } = await setup()
  try {
    const runId = await primeRunningChatRun(service, project, dev)
    await service.finishRun({
      runId, status: 'succeeded', output: '完成',
      attention: { question: '要继续吗？' },
    })
    await assert.rejects(
      () => service.answerAttention(runId, '继续', { type: 'bot', id: dev.id }),
      /只有项目负责人/,
    )
    assert.ok(store.get('SELECT attention_json AS v FROM runs WHERE id = ?', runId).v, '被拒后 attention 不应被清空')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('taskView 透出 attention，任务阶段进入 person/answer', async () => {
  const { root, store, service, dev, project } = await setup()
  try {
    const task = await service.createTask({ projectId: project.id, title: '带提问的任务', assigneeBotId: dev.id, writeScopes: ['src/x/'], autoStart: false })
    const runId = service.enqueueTaskRun(store.get('SELECT * FROM tasks WHERE id = ?', task.id), 'assigned', { type: 'system', id: 'system' })
    service.store.run("UPDATE runs SET status = 'running', started_at = ?, last_progress_at = ? WHERE id = ?", new Date().toISOString(), new Date().toISOString(), runId)
    await service.finishRun({
      runId, status: 'succeeded', output: '做完了',
      attention: { question: '评审意见按哪版走？', options: ['v1', 'v2'] },
    })
    const view = await service.taskView(store.get('SELECT * FROM tasks WHERE id = ?', task.id))
    assert.deepEqual(view.attention, { question: '评审意见按哪版走？', options: ['v1', 'v2'] })
    assert.equal(view.stage.stage, 'person')
    assert.equal(view.stage.action, 'answer')
    assert.equal(view.stageLabel, '等待你回答')
  } finally { await rm(root, { recursive: true, force: true }) }
})
