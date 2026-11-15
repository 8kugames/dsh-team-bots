// DSHBOTS-252 守门：bot 群聊回复 @mention → chat_run 派发 + 防循环三护栏。
// 覆盖：含 @mention 派发（幂等键 chat_bot:<messageId>:<botId>）、无 mention 零派发、
// @自己剔除、链路深度 2 截断、taskId 消息双保险不触发、用户消息路径（chat.ts:169）行为不变。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// 按 bot 名脚本化 chat 回复正文，驱动 mention 唤醒链。
class FakeRuntime { declare service: any; declare replies: Record<string, string>; declare models: any[]; declare handler: any;
  constructor(service, replies = {}) {
    this.service = service
    this.replies = replies
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return this.models }

  async validateBotConfig() {}

  async startRun({ run, bot }) {
    setImmediate(() => {
      void this.handler({
        runId: run.id,
        status: 'succeeded',
        output: run.kind === 'chat' ? (this.replies[bot.name] ?? '收到，无进一步动作。') : 'Done.',
        error: null,
      })
    })
    return `session-${run.id}`
  }

  async cancelRun() { return true }
}

async function setup(replies = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mention-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`)
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new FakeRuntime(service, replies))
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const names = ['Builder', 'Polisher', 'Second', 'Third']
  const bots: Record<string, any> = {}
  for (const name of names) {
    bots[name] = await service.createBot({
      name, role: '开发', instructions: 'Do work.', provider: 'fake', model: 'model-a', effort: 'high',
    })
  }
  const project = await service.createProject({
    name: 'Mention Project', key: 'MENTION', ownerBotId: director.id,
    memberIds: names.map(name => bots[name].id),
  })
  return { root, store, service, director, bots, project }
}

async function waitFor(store, predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate(store)) return true
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  return predicate(store)
}

// 级联静默判定：无排队/运行中的运行、无待投递 outbox。
const quiet = store => {
  const runs = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
  const pending = Number(store.get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'")?.n ?? 0)
  return runs === 0 && pending === 0
}

async function settle(store, timeoutMs = 5000) {
  const ok = await waitFor(store, quiet, timeoutMs)
  // 再留一个调度周期，确保截断路径下「不该出现的派发」有时间暴露。
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(ok, '运行级联应在时限内静默')
}

async function closeQuietly(store) {
  await waitFor(store, quiet, 2000)
  try { store.close() } catch {}
}

const chatRunsFor = (store, botId) => store.all("SELECT * FROM runs WHERE kind = 'chat' AND bot_id = ?", botId)

test('bot 回复含 @mention → 派发 chat_run（chat_bot 幂等键 + mentions_json 落行）', async () => {
  const { root, store, service, bots, project } = await setup({ Builder: '@Polisher 请复核这段实现。' })
  try {
    const actor = { type: 'user', id: 'u1' }
    const sent = await service.sendMessage(project.id, '@Builder 开始实现', actor)
    assert.deepEqual(sent.runBots, [bots.Builder.id])

    const builderRun = chatRunsFor(store, bots.Builder.id)[0]
    assert.ok(builderRun, 'Builder 应有一条 chat 运行')
    assert.ok(await waitFor(store, s => chatRunsFor(s, bots.Polisher.id).length > 0), 'Polisher 应被唤醒')

    const replyRow = store.get('SELECT * FROM messages WHERE run_id = ?', builderRun.id)
    assert.ok(replyRow, 'Builder 回复应落库')
    assert.deepEqual(JSON.parse(replyRow.mentions_json), [bots.Polisher.id], '回复行应记录 @ 目标')

    const outboxRow = store.get(
      'SELECT * FROM outbox WHERE idempotency_key = ?',
      `chat_bot:${replyRow.id}:${bots.Polisher.id}`,
    )
    assert.ok(outboxRow, '应派出 chat_bot 前缀幂等键的 chat_run outbox')
    assert.equal(outboxRow.kind, 'chat_run')
    assert.equal(outboxRow.status, 'delivered')

    const reviewerRun = chatRunsFor(store, bots.Polisher.id)[0]
    assert.equal(reviewerRun.trigger_type, 'mention')
    assert.equal(reviewerRun.trigger_ref, replyRow.id, '唤醒运行的触发消息应是 bot 回复行')
    assert.ok(await waitFor(store, s => chatRunsFor(s, bots.Polisher.id)[0]?.status === 'succeeded'))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('bot 回复无 @mention → 零派发', async () => {
  const { root, store, service, bots, project } = await setup({ Builder: '普通回复，不含唤醒目标。' })
  try {
    await service.sendMessage(project.id, '@Builder 汇报一下', { type: 'user', id: 'u1' })
    await settle(store)

    assert.equal(chatRunsFor(store, bots.Polisher.id).length, 0)
    assert.equal(chatRunsFor(store, bots.Second.id).length, 0)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key LIKE 'chat_bot:%'")?.n, 0)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('@自己被剔除，@他 bot 照常唤醒', async () => {
  // 注：正文里 @ 前必须是行首或空白（parseMentions 与用户路径同语义），
  // 这里用空格衔接；全角标点紧跟 @ 的写法在用户路径同样不触发。
  const { root, store, service, bots, project } = await setup({ Builder: '@Builder 自检完成 @Polisher 请接力。' })
  try {
    await service.sendMessage(project.id, '@Builder 先自查', { type: 'user', id: 'u1' })
    assert.ok(await waitFor(store, s => chatRunsFor(s, bots.Polisher.id).length > 0), 'Polisher 应被唤醒')

    const builderRun = chatRunsFor(store, bots.Builder.id)[0]
    const replyRow = store.get('SELECT * FROM messages WHERE run_id = ?', builderRun.id)
    assert.deepEqual(JSON.parse(replyRow.mentions_json), [bots.Polisher.id], '自 mention 不进目标列表')
    // 唤醒自己的唯一入口不存在：Builder 全程只有用户消息触发的那一条 chat 运行。
    await settle(store)
    assert.equal(chatRunsFor(store, bots.Builder.id).length, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('链路深度 2 截断：第二跳回复不再派发第三跳', async () => {
  const { root, store, service, bots, project } = await setup({
    Builder: '@Polisher 第一跳。',
    Polisher: '@Second 第二跳。',
    Second: '@Third 第三跳（应被截断）。',
    Third: '@Builder 若被唤醒则说明护栏失效。',
  })
  try {
    await service.sendMessage(project.id, '@Builder 起链', { type: 'user', id: 'u1' })
    // 链：Builder(深度0，人触发) → Polisher(1) → Second(2)；Second 的回复不再派发 Third。
    assert.ok(await waitFor(store, s => chatRunsFor(s, bots.Second.id).some(run => run.status === 'succeeded')),
      'Second 应被唤醒并完成（深度 2 的运行本身允许存在）')

    await settle(store)
    assert.equal(chatRunsFor(store, bots.Third.id).length, 0, 'Third 不应被唤醒')
    assert.equal(chatRunsFor(store, bots.Builder.id).length, 1, '链尾不得回环唤醒 Builder')

    const secondRun = chatRunsFor(store, bots.Second.id)[0]
    const secondReply = store.get('SELECT * FROM messages WHERE run_id = ?', secondRun.id)
    // mentions_json 记录内容引用（含被截断目标），派发与否由护栏决定——两者解耦。
    assert.deepEqual(JSON.parse(secondReply.mentions_json), [bots.Third.id])
    assert.equal(
      store.get('SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key = ?', `chat_bot:${secondReply.id}:${bots.Third.id}`)?.n, 0,
      '截断的第三跳不应产生 chat_run outbox',
    )
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('护栏三双保险：taskId 非空的消息不参与派发', async () => {
  const { root, store, service, bots, project } = await setup()
  try {
    const taskMessageId = service.insertMessage({
      projectId: project.id,
      senderType: 'bot',
      senderId: bots.Builder.id,
      body: '@Polisher 任务卡消息不应唤醒。',
      taskId: 'task_probe',
    })
    const projectRow = store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const builderRow = store.get('SELECT * FROM bots WHERE id = ?', bots.Builder.id)
    const woken = service.dispatchBotMentionRuns(projectRow, { trigger_ref: null }, builderRow, taskMessageId)
    assert.deepEqual(woken, [])
    assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key LIKE 'chat_bot:%'")?.n, 0)
    assert.equal(store.get('SELECT mentions_json FROM messages WHERE id = ?', taskMessageId)?.mentions_json, '[]')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('用户消息路径行为不变：chat: 幂等键与 runBots 语义保持', async () => {
  const { root, store, service, bots, project } = await setup({ Builder: '好的。' })
  try {
    const sent = await service.sendMessage(project.id, '@Builder 用户直发', { type: 'user', id: 'u1' })
    assert.deepEqual(sent.runBots, [bots.Builder.id])

    const userRow = store.get('SELECT * FROM messages WHERE id = ?', sent.messageId)
    assert.deepEqual(JSON.parse(userRow.mentions_json), [bots.Builder.id])

    const outboxRow = store.get('SELECT * FROM outbox WHERE idempotency_key = ?', `chat:${sent.messageId}:${bots.Builder.id}`)
    assert.ok(outboxRow, '用户路径幂等键仍为 chat:<messageId>:<botId>')
    assert.equal(outboxRow.kind, 'chat_run')

    assert.ok(await waitFor(store, s => chatRunsFor(s, bots.Builder.id)[0]?.status === 'succeeded'))
    const builderRun = chatRunsFor(store, bots.Builder.id)[0]
    assert.equal(builderRun.trigger_type, 'mention')
    assert.equal(builderRun.trigger_ref, sent.messageId)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
