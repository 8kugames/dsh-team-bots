// tests/user-question-priority.test.ts —— DSHBOTS-272 用户提问运行优先级守门。
// 事故（2026-11-06）：owner 群内提问被后台通知触发的 chat 运行先占道/先落屏，真答询延后，
// 且提示层无「直接回答」锚点，通知运行回一条轻备忘就算处理完。守门四类：
// ①判定：isUserQuestionRun 按触发消息 sender_type 区分用户提问与通知/唤醒运行；
// ②合批保护：用户提问排队运行不得被并进非用户触发的运行（D-231 用户→用户合批不回退）；
// ③出队优先：同车道内用户提问运行先于更早排队的通知运行领取（不被静默压后）；
// ④提示层：chatRunPrompt 用户触发注入直接回答锚点，通知触发（sender_type='bot'）不注入；
// 既有锚点（# Group message / Reply as 前缀）不回归（D-269 手法：源码级钉住）。

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

class ManualRuntime {
  declare started: any[]
  declare pendingRuns: any
  declare handler: any
  constructor() { this.started = []; this.pendingRuns = new Map() }
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run, chatMessage, extraMessages }) {
    this.started.push({ runId: run.id, kind: run.kind, chatMessage, extraMessages })
    this.pendingRuns.set(run.id, run)
    return `session-${run.id}`
  }
  async steer() { return true }
  async cancelRun() { return true }
  complete(runId, status = 'succeeded', output = 'done') {
    this.pendingRuns.delete(runId)
    return this.handler({ runId, status, output, error: null })
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-uqp-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  // 关闭自动调度，由测试显式驱动 tick。
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Priority', key: 'UQP', ownerBotId: director.id, memberIds: [dev.id] })
  const promptRuntime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  return { root, store, service, runtime, promptRuntime, director, dev, project }
}

async function cleanup(root, store) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch {
      break
    }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

function userMessage(service, projectId, body) {
  return service.insertMessage({ projectId, senderType: 'user', senderId: 'u1', body })
}
// 通知降级路径（notify.ts）与 bot 回复 @mention 唤醒（run-finish.ts）的触发消息都是 bot 发的。
function noticeMessage(service, projectId, body, botId) {
  return service.insertMessage({ projectId, senderType: 'bot', senderId: botId, body })
}

function chatRunRow(t, runId) {
  return t.store.get('SELECT * FROM runs WHERE id = ?', runId)
}

function groupPrompt(t, run, chatMessage) {
  const botRow = t.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
  return t.promptRuntime.promptFor({
    run, bot: botRow, project: t.project, task: null,
    chatMessage, extraMessages: [], sessionId: `s-${run.id}`,
  })
}

const SCHEDULER_SRC = readFileSync(fileURLToPath(new URL('../src/services/scheduler.ts', import.meta.url)), 'utf8')
const PROMPT_SRC = readFileSync(fileURLToPath(new URL('../src/services/runtime/prompt.ts', import.meta.url)), 'utf8')

test('判定：isUserQuestionRun 按触发消息 sender_type 区分用户提问与通知运行', async () => {
  const t = await setup()
  try {
    const userMsg = userMessage(t.service, t.project.id, '评估一下 GS 生产数据')
    const noticeMsg = noticeMessage(t.service, t.project.id, '【通知】备忘一条', t.director.id)
    const userRunId = t.service.enqueueChatRun(t.project, t.dev, userMsg)
    const noticeRunId = t.service.enqueueChatRun(t.project, t.dev, noticeMsg)
    assert.equal(t.service.isUserQuestionRun(chatRunRow(t, userRunId)), true, '用户消息触发的 chat 运行是用户提问')
    assert.equal(t.service.isUserQuestionRun(chatRunRow(t, noticeRunId)), false, '通知（bot 消息）触发的 chat 运行不是用户提问')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('合批保护：用户提问不并入通知触发的运行，留队保住独立回复', async () => {
  const t = await setup()
  try {
    const noticeMsg = noticeMessage(t.service, t.project.id, '【通知】轻量备忘', t.director.id)
    const userMsg = userMessage(t.service, t.project.id, '请回答我的问题：结论是什么')
    const noticeRunId = t.service.enqueueChatRun(t.project, t.dev, noticeMsg)
    const userRunId = t.service.enqueueChatRun(t.project, t.dev, userMsg)
    const noticeRun = chatRunRow(t, noticeRunId)
    const merged = t.service.coalesceQueuedRuns(noticeRun)
    assert.equal(merged.length, 0, '用户提问不得被并进通知触发的运行')
    const userRun = chatRunRow(t, userRunId)
    assert.equal(userRun.status, 'queued', '用户提问运行必须留队等待自己的正式回复')
    assert.notEqual(userRun.error_code, 'MERGED', '用户提问运行不得被合并取消')
    assert.ok(!noticeRun.merged_messages, '通知运行不得携带用户提问作为合批消息')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('合批不回退：用户触发运行仍合批排队用户消息，通知运行间仍合批（D-231 语义保留）', async () => {
  const t = await setup()
  try {
    const m1 = userMessage(t.service, t.project.id, '第一条用户消息')
    const m2 = userMessage(t.service, t.project.id, '第二条用户消息')
    const r1 = t.service.enqueueChatRun(t.project, t.dev, m1)
    t.service.enqueueChatRun(t.project, t.dev, m2)
    const mergedUser = t.service.coalesceQueuedRuns(chatRunRow(t, r1))
    assert.equal(mergedUser.length, 1, '用户触发的运行仍合批排队的用户消息（D-231 不回退）')

    const n1 = noticeMessage(t.service, t.project.id, '【通知】备忘一', t.director.id)
    const n2 = noticeMessage(t.service, t.project.id, '【通知】备忘二', t.director.id)
    const rn1 = t.service.enqueueChatRun(t.project, t.dev, n1)
    t.service.enqueueChatRun(t.project, t.dev, n2)
    const mergedNotice = t.service.coalesceQueuedRuns(chatRunRow(t, rn1))
    assert.equal(mergedNotice.length, 1, '通知运行之间仍照旧合批')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('出队优先：用户提问运行先于更早排队的通知运行领取（不被静默压后）', async () => {
  const t = await setup()
  try {
    // 通知运行先入队（FIFO 本应它先走），用户提问后到。
    const noticeMsg = noticeMessage(t.service, t.project.id, '【通知】先排队的备忘', t.director.id)
    const noticeRunId = t.service.enqueueChatRun(t.project, t.dev, noticeMsg)
    await new Promise(resolve => setTimeout(resolve, 15))
    const userMsg = userMessage(t.service, t.project.id, 'owner 提问：现在回答我')
    const userRunId = t.service.enqueueChatRun(t.project, t.dev, userMsg)
    assert.ok(chatRunRow(t, noticeRunId).queued_at < chatRunRow(t, userRunId).queued_at, '前置：通知运行确实更早入队')

    t.service.started = true
    await t.service.tick()

    assert.equal(t.runtime.started.length, 1, '同车道串行：只领取一条运行')
    assert.equal(t.runtime.started[0].runId, userRunId, '领取的必须是用户提问运行，不是更早排队的通知运行')
    assert.equal(t.runtime.started[0].chatMessage.id, userMsg, '触发消息是用户的提问')
    assert.equal(chatRunRow(t, userRunId).status, 'running', '用户提问运行已被领取')
    assert.equal(chatRunRow(t, noticeRunId).status, 'queued', '通知运行留在队列，不先占道')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('提示层：用户触发的 chat 运行注入直接回答锚点，通知触发不注入', async () => {
  const t = await setup()
  try {
    const userMsg = userMessage(t.service, t.project.id, '请直接回答这个问题')
    const userRunId = t.service.enqueueChatRun(t.project, t.dev, userMsg)
    const userPrompt = groupPrompt(t, chatRunRow(t, userRunId), t.store.get('SELECT * FROM messages WHERE id = ?', userMsg))
    assert.ok(userPrompt.includes('# Owner question priority'), '用户触发的提示词应含提问优先锚点段')
    assert.match(userPrompt, /answer it directly in this reply/, '锚点句式：必须直接回答')
    assert.match(userPrompt, /must not substitute for the answer/, '锚点句式：通知内容不得顶替答案')

    const noticeMsg = noticeMessage(t.service, t.project.id, '【通知】背景备忘', t.director.id)
    const noticeRunId = t.service.enqueueChatRun(t.project, t.dev, noticeMsg)
    const noticePrompt = groupPrompt(t, chatRunRow(t, noticeRunId), t.store.get('SELECT * FROM messages WHERE id = ?', noticeMsg))
    assert.ok(!noticePrompt.includes('# Owner question priority'), '通知触发的运行不注入提问锚点')
    assert.ok(noticePrompt.includes('# Group message'), '通知运行提示词仍走群聊分支（既有语义不变）')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('源码锚点：调度保护与出队置顶的代码路径被钉住', () => {
  assert.ok(SCHEDULER_SRC.includes('isUserQuestionRun(run)'), 'scheduler.ts 应有用户提问判定方法')
  assert.ok(
    SCHEDULER_SRC.includes('if (!claimedIsUserQuestion && this.isUserQuestionRun(candidate)) continue'),
    '合批保护守卫必须在 coalesceQueuedRuns 候选循环内（用户提问不被通知运行吸收）',
  )
  assert.ok(
    SCHEDULER_SRC.includes("LEFT JOIN messages m ON m.id = r.trigger_ref"),
    '出队候选查询应 join 触发消息以识别用户提问',
  )
  assert.ok(
    SCHEDULER_SRC.includes("WHEN r.kind = 'chat' AND m.sender_type = 'bot' THEN 2"),
    '通知/伙伴唤醒触发的 chat 运行必须降档（机器流量档），用户提问先于它领取（不被静默压后）',
  )
})

test('源码锚点：chatRunPrompt 锚点门控与既有文案前缀不回归（D-269 手法）', () => {
  assert.ok(
    PROMPT_SRC.includes("chatMessage?.sender_type === 'user' ?"),
    '锚点注入必须以触发消息 sender_type=user 为门（通知运行不注入）',
  )
  assert.ok(PROMPT_SRC.includes('# Owner question priority'), '锚点段标题存在')
  assert.ok(PROMPT_SRC.includes('answer it directly in this reply'), '锚点正文存在')
  // 既有锚点（tests/prompt-prefix-order.test.ts / prompt-watermark.test.ts 锚定的前缀）不回归。
  assert.ok(PROMPT_SRC.includes('# Group message\n'), '既有 # Group message 段落标题保留')
  assert.ok(PROMPT_SRC.includes('Reply as '), '既有 Reply as 前缀句保留')
  assert.ok(PROMPT_SRC.includes('# Merged messages'), 'D-231 合批段落保留')
})
