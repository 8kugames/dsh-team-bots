// tests/run-coalesce.test.js —— 入站消息合批守门（D-231 拍板语义；D-287 入队合并；
// D-289 争用口径 A 后由 DSHBOTS-290 改钉「bot 忙挂待处理队列 + 空闲建回时合批」）。
// 用户拍板：同一 bot 排队尚未处理的多条消息，合并注入同一次运行，不再一条消息一次运行。
// 现行时机：bot 忙时消息挂 bot_pending_msgs:<bot>（不落 runs 行）；bot 空闲时
// drainPendingMessages 建回运行——chat/solo_chat 相邻同 kind（同项目）合批成一条
// （merged_messages 注入），首条消息的运行立即执行、后续消息并入下一次建回。
// 守五条边界：
// ①同 bot 多条挂起消息 → 空闲后单次运行携带全部消息（群聊与单聊各一组）；
// ②跨项目/跨 kind 不合批（D-219 解耦在合批键上保留：kind+projectId）；
// ③合并条数上限走 settings（coalesce_max_messages，默认 5，≤1 关闭）；
// ④合并窗口走 settings（coalesce_window_ms，默认 30s，与组首入队时间差超窗不并）；
// ⑤并发护栏（M4 模拟竞争）：建回 INSERT 撞 UNIQUE（botBusy 检查后、INSERT 前被抢占）
// 返回 null 不抛错，消息全量留队列不丢（D-287 原子抢占守卫的口径 A 后继）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
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
    this.started.push({ runId: run.id, kind: run.kind, run, chatMessage, extraMessages })
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-coalesce-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Coalesce', key: 'COA', ownerBotId: director.id, memberIds: [dev.id] })
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

function say(service, projectId, body) {
  return service.insertMessage({ projectId, senderType: 'user', senderId: 'u1', body })
}

function groupPrompt(t, run, chatMessage, extraMessages) {
  const botRow = t.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
  return t.promptRuntime.promptFor({
    run, bot: botRow, project: t.project, task: null,
    chatMessage, extraMessages, sessionId: `s-${run.id}`,
  })
}

const heldItems = (t, botId = t.dev.id) =>
  JSON.parse(t.store.setting(`bot_pending_msgs:${botId}`) ?? '[]')

// 驱动 tick 直到目标运行启动：中间运行（如收尾的 memory_review）逐个完成让 bot 回到
// 空闲，挂起消息才能建回。返回命中的 started 条目。
async function drainUntilStarted(t, triggerId, maxTicks = 8) {
  for (let i = 0; i < maxTicks; i += 1) {
    const hit = t.runtime.started.find(item => item.run?.trigger_ref === triggerId)
    if (hit) return hit
    await t.service.tick()
    for (const runId of [...t.runtime.pendingRuns.keys()]) {
      await t.runtime.complete(runId)
    }
  }
  return t.runtime.started.find(item => item.run?.trigger_ref === triggerId)
}

test('群聊挂起消息空闲后合并成一次运行，单次运行携带全部消息', async () => {
  const t = await setup()
  try {
    // 首条消息立即入队开跑（bot 空闲），后续两条在运行期到达 → 挂起。
    const m1 = say(t.service, t.project.id, '第一条：先看一下现状')
    t.service.enqueueChatRun(t.project, t.dev, m1)
    t.service.started = true
    await t.service.tick()
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").n, 1, '首条消息先开跑')

    const m2 = say(t.service, t.project.id, '第二条：顺便把测试补上')
    const m3 = say(t.service, t.project.id, '第三条：最后跑一遍验证')
    assert.equal(t.service.enqueueChatRun(t.project, t.dev, m2), null, 'bot 忙时第二条挂起不落 runs 行')
    assert.equal(t.service.enqueueChatRun(t.project, t.dev, m3), null, 'bot 忙时第三条挂起不落 runs 行')
    assert.deepEqual(heldItems(t).map(item => item.messageId), [m2, m3], '挂起队列保序')

    await t.runtime.complete(t.runtime.started[0].runId)
    const second = await drainUntilStarted(t, m2)
    assert.ok(second, '空闲后挂起消息应合批建回一条运行')
    assert.equal(second.chatMessage.id, m2, '建回运行的触发消息是挂起最早的那条')
    assert.deepEqual(second.extraMessages.map(item => item.id), [m3], '后续挂起消息按序并入同轮上下文')

    const runRow = t.store.get("SELECT * FROM runs WHERE id = ?", second.runId)
    const prompt = groupPrompt(t, runRow, second.chatMessage, second.extraMessages)
    for (const body of ['第二条：顺便把测试补上', '第三条：最后跑一遍验证']) {
      assert.ok(prompt.includes(body), `提示词应包含消息正文：${body}`)
    }
    assert.ok(prompt.includes('# Merged messages'), '合批段落应出现')
    assert.equal(prompt.split('第三条：最后跑一遍验证').length - 1, 1, '合批消息正文只出现一次')
    assert.deepEqual(heldItems(t), [], '建回后挂起队列清空')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('单聊挂起消息同样合批，单聊提示词带合批段', async () => {
  const t = await setup()
  try {
    const bodies = ['单聊第一条：在吗', '单聊第二点：帮我看下这个报错', '单聊第三点：改完跑一下测试']
    const ids = bodies.map(body => t.service.insertSoloMessage({ botId: t.dev.id, senderType: 'user', senderId: 'u1', body }))
    t.service.enqueueSoloChatRun(t.dev, ids[0])
    t.service.started = true
    await t.service.tick()
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").n, 1, '首条单聊先开跑')

    t.service.enqueueSoloChatRun(t.dev, ids[1])
    t.service.enqueueSoloChatRun(t.dev, ids[2])
    assert.deepEqual(heldItems(t).map(item => item.messageId), ids.slice(1), '单聊挂起保序')

    await t.runtime.complete(t.runtime.started[0].runId)
    await t.service.tick()

    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").n, 1)
    const second = t.runtime.started[1]
    assert.equal(second.chatMessage.id, ids[1])
    assert.deepEqual(second.extraMessages.map(item => item.id), [ids[2]])

    const botRow = t.store.get('SELECT * FROM bots WHERE id = ?', t.dev.id)
    const prompt = t.promptRuntime.promptFor({
      run: t.store.get('SELECT * FROM runs WHERE id = ?', second.runId), bot: botRow, project: null, task: null,
      chatMessage: second.chatMessage, extraMessages: second.extraMessages, sessionId: 's-solo-coalesce',
    })
    for (const body of bodies.slice(1)) assert.ok(prompt.includes(body), `单聊提示词应包含消息正文：${body}`)
    assert.ok(prompt.includes('# Merged messages'), '单聊合批段落应出现')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('跨项目/跨 kind 不合批：同 bot 串行逐条运行，挂起消息不跨项目并入同一轮', async () => {
  const t = await setup()
  try {
    const beta = await t.service.createProject({ name: 'Beta', key: 'BET', ownerBotId: t.director.id, memberIds: [t.dev.id] })
    // 首条（项目一）开跑后，项目二消息与单聊消息相继到达。
    const m1 = say(t.service, t.project.id, '来自 COA 的消息')
    t.service.enqueueChatRun(t.project, t.dev, m1)
    t.service.started = true
    await t.service.tick()

    const m2 = say(t.service, beta.id, '来自 BET 的消息')
    t.service.enqueueChatRun(beta, t.dev, m2)
    const soloId = t.service.insertSoloMessage({ botId: t.dev.id, senderType: 'user', senderId: 'u1', body: '单聊消息' })
    t.service.enqueueSoloChatRun(t.dev, soloId)
    assert.equal(heldItems(t).length, 2, '两条挂起（不同项目/不同 kind）')

    await t.runtime.complete(t.runtime.started[0].runId)
    const second = await drainUntilStarted(t, m2)
    // bot 级串行：一次只建回一条运行（首个挂起组），且不吞并另一项目的消息。
    assert.ok(second, '挂起组应建回运行')
    assert.equal(second.chatMessage.id, m2, '建回的是最早挂起组（项目二消息）')
    assert.deepEqual(second.extraMessages.map(item => item.id), [], '不得跨项目并入同一轮')
    assert.deepEqual(heldItems(t).map(item => item.messageId), [soloId], '单聊挂起留队列下一拍')

    await t.runtime.complete(second.runId)
    const third = await drainUntilStarted(t, soloId)
    assert.ok(third, '单聊消息最终独立成运行')
    assert.equal(third.chatMessage.id, soloId, '单聊消息独立成运行')
    assert.deepEqual(heldItems(t), [], '全部消化')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('合并条数上限走 settings：单组封顶，超出部分下一拍再组成新运行', async () => {
  const t = await setup()
  try {
    t.store.setSetting('coalesce_max_messages', '2')
    const ids = [1, 2, 3, 4].map(index => say(t.service, t.project.id, `消息 ${index}`))
    t.service.enqueueChatRun(t.project, t.dev, ids[0])
    t.service.started = true
    await t.service.tick()
    // 运行期到达三条：m2、m3、m4 全部挂起。
    for (const messageId of ids.slice(1)) t.service.enqueueChatRun(t.project, t.dev, messageId)

    await t.runtime.complete(t.runtime.started[0].runId)
    const second = await drainUntilStarted(t, ids[1])
    // 上限 2：第一组建回只带 m2+m3，m4 留队列（bot 随即忙，同拍不建第二组）。
    assert.ok(second)
    assert.equal(second.chatMessage.id, ids[1], '第二组以 m2 为首')
    assert.deepEqual(second.extraMessages.map(item => item.id), [ids[2]], '单组封顶 2 条（首条+合并 1 条）')
    assert.deepEqual(heldItems(t).map(item => item.messageId), [ids[3]], 'm4 留队列')

    await t.runtime.complete(second.runId)
    const third = await drainUntilStarted(t, ids[3])
    assert.ok(third)
    assert.equal(third.chatMessage.id, ids[3], 'm4 下一拍独立成运行')
    assert.deepEqual(third.extraMessages, [])
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('合并窗口走 settings：与组首入队时间差超窗的挂起消息不并入，独立成组', async () => {
  const t = await setup()
  try {
    t.store.setSetting('coalesce_window_ms', '60000')
    const m1 = say(t.service, t.project.id, '窗口外最早一条（已老化）')
    t.service.enqueueChatRun(t.project, t.dev, m1)
    t.service.started = true
    await t.service.tick()

    const m2 = say(t.service, t.project.id, '窗口内第二条')
    const m3 = say(t.service, t.project.id, '窗口内第三条')
    t.service.enqueueChatRun(t.project, t.dev, m2)
    t.service.enqueueChatRun(t.project, t.dev, m3)
    // 把 m2 的挂起入队时间推到一小时前：m3 与它的相差远超合并窗口。
    const items = heldItems(t)
    items[0].queuedAt = new Date(Date.now() - 3_600_000).toISOString()
    t.store.setSetting(`bot_pending_msgs:${t.dev.id}`, JSON.stringify(items))

    await t.runtime.complete(t.runtime.started[0].runId)
    const second = await drainUntilStarted(t, m2)

    // m2 老化自成一组；m3 与 m2 超窗不并，留队列下一拍。
    assert.ok(second)
    assert.equal(second.chatMessage.id, m2, '老化的 m2 独立建回')
    assert.deepEqual(second.extraMessages.map(item => item.id), [], '窗口外的 m3 不得并入老化的 m2')
    assert.deepEqual(heldItems(t).map(item => item.messageId), [m3], 'm3 留队列')

    await t.runtime.complete(second.runId)
    const third = await drainUntilStarted(t, m3)
    assert.ok(third)
    assert.equal(third.chatMessage.id, m3, 'm3 下一拍独立成运行')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('M4 模拟竞争：建回前 bot 被抢占则消息全量留队列；INSERT 撞 UNIQUE 返回 null 不抛错', async () => {
  const t = await setup()
  try {
    const m1 = say(t.service, t.project.id, '等待建回的消息')
    // bot 空闲 → 消息直接落 runs 排队（占用 bot），再挂起一条待建回消息。
    const occupyId = t.service.enqueueChatRun(t.project, t.dev, m1)
    assert.ok(occupyId, '空闲时首条消息正常落 runs 行')
    const m2 = say(t.service, t.project.id, '挂起待建回的消息')
    t.service.enqueueChatRun(t.project, t.dev, m2)
    assert.deepEqual(heldItems(t).map(item => item.messageId), [m2])

    // 竞争路径一（busy 闸）：建回检查时 bot 已被抢占 → 跳过，消息留队列不丢。
    t.service.drainPendingMessages()
    assert.deepEqual(heldItems(t).map(item => item.messageId), [m2], 'bot 被抢占时挂起消息必须留队列')
    assert.equal(
      t.store.get("SELECT COUNT(*) AS n FROM runs WHERE trigger_ref = ?", m2).n,
      0,
      '被抢占期间不得为挂起消息建 runs 行',
    )

    // 竞争路径二（UNIQUE 护栏）：绕过 busy 检查直接建回（模拟 busy 检查与 INSERT 之间
    // 的并发窗口）——INSERT 撞 one_active_run_per_bot，必须被捕获返回 null 而非抛错。
    const group = { first: heldItems(t)[0], merge: [] }
    let guardResult = 'no-throw'
    try {
      guardResult = t.service.insertHeldMessageRun(t.dev, group)
    } catch {
      guardResult = 'threw'
    }
    assert.equal(guardResult, null, 'UNIQUE 撞车必须返回 null（被拒重试），不得抛错带崩当前拍')
    assert.deepEqual(heldItems(t).map(item => item.messageId), [m2], '护栏拒后消息不丢')
  } finally {
    await cleanup(t.root, t.store)
  }
})

// DSHBOTS-291 卡面增补①（D-290 红线臂 4d70a415：M4 跨项目不合批键 0 覆盖）：
// 现有跨项目用例两条挂起项 kind 不同（chat vs solo_chat），kind 判定已必然分组、projectId
// 分支恒不可达——本例两条挂起项同为 chat、分属不同项目，钉住「跨项目同 kind 不合批」键。
test('跨项目同 kind 不合批（回归）：两条 chat 分属不同项目，各成独立运行', async () => {
  const t = await setup()
  try {
    const beta = await t.service.createProject({ name: 'Beta', key: 'BET', ownerBotId: t.director.id, memberIds: [t.dev.id] })
    const m1 = say(t.service, t.project.id, 'COA 首条先开跑')
    t.service.enqueueChatRun(t.project, t.dev, m1)
    t.service.started = true
    await t.service.tick()

    const mCoa = say(t.service, t.project.id, 'COA 第二条')
    const mBeta = say(t.service, beta.id, 'BET 第一条')
    assert.equal(t.service.enqueueChatRun(t.project, t.dev, mCoa), null, '忙时 COA 消息挂起')
    assert.equal(t.service.enqueueChatRun(beta, t.dev, mBeta), null, '忙时 BET 消息挂起')
    assert.equal(heldItems(t).length, 2, '两条同 kind（chat）挂起')

    await t.runtime.complete(t.runtime.started[0].runId)
    const second = await drainUntilStarted(t, mCoa)
    assert.ok(second, 'COA 挂起组先建回')
    assert.equal(second.chatMessage.id, mCoa, '建回的是 COA 组')
    assert.deepEqual(second.extraMessages.map(item => item.id), [], 'BET 消息不得因同 kind 跨项目并入 COA 运行')
    assert.deepEqual(heldItems(t).map(item => item.messageId), [mBeta], 'BET 消息留队列下一拍')

    await t.runtime.complete(second.runId)
    const third = await drainUntilStarted(t, mBeta)
    assert.ok(third, 'BET 消息最终独立成运行')
    assert.equal(third.chatMessage.id, mBeta)
    assert.deepEqual(heldItems(t), [], '全部消化')
  } finally {
    await cleanup(t.root, t.store)
  }
})

// DSHBOTS-300 守门：busy 闸是先查后插，多进程共享 team.sqlite 时两进程可同拍过检后
// 各自 INSERT，后者撞 one_active_run_per_bot 直抛——outbox 会把它计为投递失败重试
// 耗尽置 failed，消息卡死。单进程可测等价：预插一条同 bot queued 运行（对端进程的
// 落行）后把 botBusy 桩成 false（模拟「查后插之间」的竞态窗），断言 enqueue 不抛错、
// 消息落挂起队列、bot 空闲后 drainPendingMessages 建回运行。
test('查后插竞态撞 one_active_run_per_bot：入队不抛错落挂起队列，空闲建回', async () => {
  const t = await setup()
  try {
    const m = say(t.service, t.project.id, '竞态窗内到达的消息')
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at)
       VALUES ('run_race_peer', ?, ?, 'chat', 'read', 'mention', 'race-peer-msg', 'queued', 1, 'race:peer', ?)`,
      t.project.id, t.dev.id, new Date().toISOString(),
    )
    t.store.run(
      `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_session_id, origin_kind, status, created_at)
       VALUES ('bm_race', ?, ?, ?, 'req_race', '竞态私信', 'sess-x', 'dm', 'pending', ?)`,
      t.project.id, t.director.id, t.dev.id, new Date().toISOString(),
    )
    const dmMessage = t.store.get('SELECT * FROM bot_messages WHERE id = ?', 'bm_race')
    // 模拟对端进程在「本进程 busy 过检之后、INSERT 之前」落行：busy 检查桩成 false。
    const realBusy = t.service.botBusy.bind(t.service)
    t.service.botBusy = () => false
    const chatRunId = t.service.enqueueChatRun(t.project, t.dev, m)
    const soloRunId = t.service.enqueueSoloChatRun(t.dev, 'solo_race_msg')
    const dmRunId = t.service.enqueueDmRun(dmMessage, t.dev)
    t.service.botBusy = realBusy
    assert.equal(chatRunId, null, 'chat 撞 UNIQUE 返 null 不抛错')
    assert.equal(soloRunId, null, 'solo_chat 同款兜底')
    assert.equal(dmRunId, null, 'dm 同款兜底')
    assert.deepEqual(heldItems(t).map(item => item.kind), ['chat', 'solo_chat', 'dm'], '三族消息全部落挂起队列')

    // 对端运行结束，bot 空闲：挂起消息建回运行（chat 先建回，余量留队列下一拍）。
    t.store.run("UPDATE runs SET status = 'canceled', ended_at = ? WHERE id = 'run_race_peer'", new Date().toISOString())
    t.service.drainPendingMessages()
    assert.ok(t.store.get("SELECT id FROM runs WHERE trigger_ref = ? AND status = 'queued'", m), '空闲后挂起消息建回运行')
    assert.deepEqual(heldItems(t).map(item => item.kind), ['solo_chat', 'dm'], '建回消化 chat，余量留队列')
  } finally {
    await cleanup(t.root, t.store)
  }
})
