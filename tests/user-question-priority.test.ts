// tests/user-question-priority.test.ts —— DSHBOTS-272 用户提问运行优先级守门
// （DSHBOTS-290 随争用口径 A 改钉挂起队列语义：bot 忙时消息挂起，空闲建回合批）。
// 事故（2026-11-06）：owner 群内提问被后台通知触发的 chat 运行先占道/先落屏，真答询延后，
// 且提示层无「直接回答」锚点，通知运行回一条轻备忘就算处理完。守门四类：
// ①判定：heldItemIsUserQuestion 按触发消息 sender_type 区分用户提问与通知/唤醒消息；
// ②合批保护：用户提问挂起组不得并入非用户触发的挂起组（D-231 用户→用户合批不回退）；
// ③建回优先：用户提问组先于更早挂起的通知组放行（不被静默压后）；
// ④提示层：chatRunPrompt 用户触发注入直接回答锚点，通知触发（sender_type='bot'）不注入；
// 既有锚点（# Group message / Reply as 前缀）不回归（D-269 手法：源码级钉住）。
// DSHBOTS-283 守门（同文件承载）：⑤群聊回复 Markdown 结构化分级锚点（长文固定小标题/
// 短回复自然语言）+ 微信分支纯文本版式锚点（源码锚与渲染行为两层）。

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
const RUNS_SRC = readFileSync(fileURLToPath(new URL('../src/services/runs.ts', import.meta.url)), 'utf8')
const PROMPT_SRC = readFileSync(fileURLToPath(new URL('../src/services/runtime/prompt.ts', import.meta.url)), 'utf8')

test('判定：heldItemIsUserQuestion 按触发消息 sender_type 区分用户提问与通知消息', async () => {
  const t = await setup()
  try {
    const userMsg = userMessage(t.service, t.project.id, '评估一下 GS 生产数据')
    const noticeMsg = noticeMessage(t.service, t.project.id, '【通知】备忘一条', t.director.id)
    // DSHBOTS-290：run 向判定随 mergeRunIntoQueuedLane 删除，语义迁到挂起消息向
    // （drainPendingMessages 分组用 heldItemIsUserQuestion）。
    assert.equal(t.service.heldItemIsUserQuestion({ kind: 'chat', messageId: userMsg }), true, '用户消息触发的 chat 运行是用户提问')
    assert.equal(t.service.heldItemIsUserQuestion({ kind: 'chat', messageId: noticeMsg }), false, '通知（bot 消息）触发的 chat 运行不是用户提问')
  } finally {
    await cleanup(t.root, t.store)
  }
})

// 驱动 tick 直到目标消息的运行启动：中间运行（收尾 memory_review 等）逐个完成，
// 让 bot 回到空闲、挂起消息得以建回。按 chatMessage.id 匹配。
async function drainUntilChatStarted(t, messageId, maxTicks = 8) {
  for (let i = 0; i < maxTicks; i += 1) {
    const hit = t.runtime.started.find(item => item.chatMessage?.id === messageId)
    if (hit) return hit
    await t.service.tick()
    for (const runId of [...t.runtime.pendingRuns.keys()]) {
      await t.runtime.complete(runId)
    }
  }
  return t.runtime.started.find(item => item.chatMessage?.id === messageId)
}

const heldItems = (t, botId = t.dev.id) =>
  JSON.parse(t.store.setting(`bot_pending_msgs:${botId}`) ?? '[]')

test('合批保护：用户提问不并入通知触发的挂起组，独立建回保住独立回复', async () => {
  const t = await setup()
  try {
    // 通知先落 runs 行开跑（bot 随即忙），用户提问与另一条通知相继挂起。
    const noticeMsg = noticeMessage(t.service, t.project.id, '【通知】轻量备忘', t.director.id)
    const noticeRunId = t.service.enqueueChatRun(t.project, t.dev, noticeMsg)
    const userMsg = userMessage(t.service, t.project.id, '请回答我的问题：结论是什么')
    assert.equal(t.service.enqueueChatRun(t.project, t.dev, userMsg), null, 'bot 忙时用户提问挂起（不落 runs 行）')
    const noticeMsg2 = noticeMessage(t.service, t.project.id, '【通知】第二条备忘', t.director.id)
    assert.equal(t.service.enqueueChatRun(t.project, t.dev, noticeMsg2), null, '后续通知同样挂起')
    assert.deepEqual(heldItems(t).map(item => item.messageId), [userMsg, noticeMsg2], '挂起队列保序')

    t.service.started = true
    await t.service.tick()
    await t.runtime.complete(t.runtime.started[0].runId)
    const q = await drainUntilChatStarted(t, userMsg)

    assert.ok(q, '用户提问必须建回自己的运行')
    assert.deepEqual(q.extraMessages.map(item => item.id), [], '用户提问不得并入通知触发的挂起组')
    assert.ok(!chatRunRow(t, noticeRunId).merged_messages, '通知运行不得携带用户提问作为合批消息')
    assert.deepEqual(heldItems(t).map(item => item.messageId), [noticeMsg2], '通知挂起留队列下一拍')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('合批不回退：用户消息之间仍合批，通知消息之间仍合批（D-231 语义保留）', async () => {
  const t = await setup()
  try {
    // 阶段一：首条用户消息开跑，第二、三条用户消息挂起 → 空闲后合批建回一条运行。
    const m1 = userMessage(t.service, t.project.id, '第一条用户消息')
    t.service.enqueueChatRun(t.project, t.dev, m1)
    const m2 = userMessage(t.service, t.project.id, '第二条用户消息')
    const m3 = userMessage(t.service, t.project.id, '第三条用户消息')
    t.service.enqueueChatRun(t.project, t.dev, m2)
    t.service.enqueueChatRun(t.project, t.dev, m3)
    t.service.started = true
    await t.service.tick()
    await t.runtime.complete(t.runtime.started[0].runId)
    const second = await drainUntilChatStarted(t, m2)
    assert.ok(second, '用户消息建回运行')
    assert.equal(second.chatMessage.id, m2)
    assert.deepEqual(second.extraMessages.map(item => item.id), [m3], '用户消息之间仍照旧合批')

    // 阶段二：通知消息之间同样合批。
    await t.runtime.complete(second.runId)
    const n1 = noticeMessage(t.service, t.project.id, '【通知】备忘一', t.director.id)
    const n2 = noticeMessage(t.service, t.project.id, '【通知】备忘二', t.director.id)
    t.service.enqueueChatRun(t.project, t.dev, n1)
    t.service.enqueueChatRun(t.project, t.dev, n2)
    const noticeRun = await drainUntilChatStarted(t, n1)
    assert.ok(noticeRun, '通知消息建回运行')
    assert.deepEqual(noticeRun.extraMessages.map(item => item.id), [n2], '通知运行之间仍照旧合批')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('建回优先：用户提问组先于更早挂起的通知组放行（不被静默压后）', async () => {
  const t = await setup()
  try {
    // 先占道：一条运行跑起来，通知与用户提问相继挂起（通知更早）。
    const warmMsg = userMessage(t.service, t.project.id, '占道消息')
    t.service.enqueueChatRun(t.project, t.dev, warmMsg)
    t.service.started = true
    await t.service.tick()
    const noticeMsg = noticeMessage(t.service, t.project.id, '【通知】先挂起的备忘', t.director.id)
    t.service.enqueueChatRun(t.project, t.dev, noticeMsg)
    await new Promise(resolve => setTimeout(resolve, 15))
    const userMsg = userMessage(t.service, t.project.id, 'owner 提问：现在回答我')
    t.service.enqueueChatRun(t.project, t.dev, userMsg)
    assert.ok(
      heldItems(t).find(item => item.messageId === noticeMsg).queuedAt
        < heldItems(t).find(item => item.messageId === userMsg).queuedAt,
      '前置：通知消息确实更早挂起',
    )

    await t.runtime.complete(t.runtime.started[0].runId)
    const q = await drainUntilChatStarted(t, userMsg)
    assert.ok(q, '用户提问建回运行')
    assert.equal(q.chatMessage.id, userMsg, '触发消息是用户的提问')
    assert.equal(
      t.runtime.started.filter(item => item.chatMessage?.id === noticeMsg).length,
      0,
      '更早挂起的通知不得先于用户提问建回',
    )
    assert.deepEqual(heldItems(t).map(item => item.messageId), [noticeMsg], '通知留队列下一拍')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('提示层：用户触发的 chat 运行注入直接回答锚点，通知触发不注入', async () => {
  const t = await setup()
  try {
    // 两条运行分属两个 bot（dev/director）：one_active_run_per_bot 下同 bot 不能同时
    // 排两条 chat 运行，提示层断言不依赖同 bot 排队。
    const userMsg = userMessage(t.service, t.project.id, '请直接回答这个问题')
    const userRunId = t.service.enqueueChatRun(t.project, t.dev, userMsg)
    const noticeMsg = noticeMessage(t.service, t.project.id, '【通知】背景备忘', t.director.id)
    const noticeRunId = t.service.enqueueChatRun(t.project, t.director, noticeMsg)
    const userPrompt = groupPrompt(t, chatRunRow(t, userRunId), t.store.get('SELECT * FROM messages WHERE id = ?', userMsg))
    assert.ok(userPrompt.includes('# Owner question priority'), '用户触发的提示词应含提问优先锚点段')
    assert.match(userPrompt, /answer it directly in this reply/, '锚点句式：必须直接回答')
    assert.match(userPrompt, /must not substitute for the answer/, '锚点句式：通知内容不得顶替答案')

    const noticePrompt = groupPrompt(t, chatRunRow(t, noticeRunId), t.store.get('SELECT * FROM messages WHERE id = ?', noticeMsg))
    assert.ok(!noticePrompt.includes('# Owner question priority'), '通知触发的运行不注入提问锚点')
    assert.ok(noticePrompt.includes('# Group message'), '通知运行提示词仍走群聊分支（既有语义不变）')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('源码锚点：挂起分组的提问保护/窗口/上限与出队降档的代码路径被钉住', () => {
  // DSHBOTS-290：合批语义随争用口径 A 迁到 runs.ts drainPendingMessages（入队合并已删）。
  assert.ok(
    RUNS_SRC.includes('this.heldItemIsUserQuestion(item) === this.heldItemIsUserQuestion(last.first)'),
    '合批保护守卫必须在 drainPendingMessages 分组循环内（用户提问不被通知挂起组吸收）',
  )
  assert.ok(
    RUNS_SRC.includes('Number(this.heldItemIsUserQuestion(b.first)) - Number(this.heldItemIsUserQuestion(a.first))'),
    '用户提问组必须排序优先放行（不被更早挂起的通知压后）',
  )
  assert.ok(RUNS_SRC.includes("'coalesce_window_ms'"), '合并窗口设置项在建回侧消费')
  assert.ok(RUNS_SRC.includes("'coalesce_max_messages'"), '合并上限设置项在建回侧消费')
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

test('提示层（D-283）：分级要求注入所有群聊提示，微信运行追加纯文本版式段', async () => {
  const t = await setup()
  try {
    const userMsg = userMessage(t.service, t.project.id, '给我一份进展评估')
    const runId = t.service.enqueueChatRun(t.project, t.dev, userMsg)
    const msgRow = t.store.get('SELECT * FROM messages WHERE id = ?', userMsg)
    const prompt = groupPrompt(t, chatRunRow(t, runId), msgRow)
    assert.match(
      prompt,
      /Long replies \(交付\/进展\/评估\) use Markdown headings 结论\/证据\/风险\/下一步/,
      '分级口径必须进群聊提示：长文用固定小标题',
    )
    assert.ok(prompt.includes('short replies stay natural'), '短回复保持自然语言豁免必须在场')
    assert.ok(
      prompt.indexOf('结论/证据/风险/下一步') < prompt.indexOf('# Group message'),
      '分级要求属静态指令段，必须先于消息变化段（前缀缓存原则）',
    )
    assert.ok(!prompt.includes('WeChat renders no Markdown'), '非微信运行不得注入纯文本版式段')

    const wxPrompt = groupPrompt(t, { ...chatRunRow(t, runId), trigger_type: 'wechat' }, msgRow)
    assert.ok(wxPrompt.includes('WeChat renders no Markdown'), '微信运行必须注入纯文本版式提示')
    assert.match(
      wxPrompt,
      /plain text with blank lines and - lists, never \* or #/,
      '微信版式：空行+符号列表、禁 * # 原样字符',
    )
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('源码锚点：D-283 chatRunPrompt 分级要求与微信纯文本分支被钉住', () => {
  assert.ok(PROMPT_SRC.includes('结论/证据/风险/下一步'), '分级段：固定小标题在场')
  assert.ok(PROMPT_SRC.includes('short replies stay natural'), '分级段：短回复自然语言豁免在场')
  assert.ok(PROMPT_SRC.includes("run.trigger_type === 'wechat' ?"), '微信分支门控保留（差异化提示只进微信运行）')
  assert.ok(PROMPT_SRC.includes('WeChat renders no Markdown'), '微信分支：纯文本版式提示在场')
  assert.ok(PROMPT_SRC.includes('never * or #'), '微信分支：明示禁 * # 原样字符')
})
