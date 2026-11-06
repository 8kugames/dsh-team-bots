// tests/avatar-lanes.test.js —— 争用口径 A（DSHBOTS-289/290）后的 bot 级串行守门。
// 原分身通道隔离（DSHBOTS-219 单聊/群聊/私信互不阻塞）已被 one_active_run_per_bot 取代：
// 同 bot 任意两条运行互斥——忙时入站消息不落 runs 行，挂 settings 键 bot_pending_msgs:<bot>，
// 空闲后 drainPendingMessages 合批建回；跨 bot 并行不受限。
// claimKey 已收敛为 bot:<bot_id>（单控制面单绑定），不再按 task/project/dm/solo 分道。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { id, nowIso } from '../src/util.js'

class ManualRuntime { declare started: any[]; declare pendingRuns: any; declare handler: any;
  constructor() { this.started = []; this.pendingRuns = new Map() }
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push(run.id); this.pendingRuns.set(run.id, run); return `session-${run.id}` }
  async steer() { return true }
  async cancelRun() { return true }
  complete(runId, status = 'succeeded', output = 'done') { this.pendingRuns.delete(runId); return this.handler({ runId, status, output, error: null }) }
}

async function laneSetup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-lanes-'))
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
  // 记忆审查派生运行与本卡的串行语义无关，关掉保时序确定。
  store.setSetting('memory_review', '0')
  store.setSetting('chat_memory_review', '0')
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  return { root, store, service, runtime, director, dev }
}

// 直插一条 runs 行（键位守门用；不走业务入口，专测 claimKey 的键推导）。
// one_active_run_per_bot 激活后同 bot 只能有一条 queued/running：键位推导不读 status，
// 统一插终态行，同 bot 多类运行可共存供逐一断言。
function seedRun(store, { kind, botId, projectId = null, taskId = null, triggerRef = null, sessionId = null, mode = 'read' }) {
  const runId = id('run')
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
       attempt, idempotency_key, session_id, queued_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, 'seed', ?, 'succeeded', 1, ?, ?, ?, ?)`,
    runId, projectId, botId, taskId, kind, mode, triggerRef, `seed:${runId}`, sessionId, nowIso(), nowIso(),
  )
  return store.get('SELECT * FROM runs WHERE id = ?', runId)
}

const heldItems = (store, botId) =>
  JSON.parse(store.setting(`bot_pending_msgs:${botId}`) ?? '[]')

async function cleanup(root, store) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

test('claimKey 键位守门（新语义）：每类运行收敛到同一 bot 键，跨 bot 键互不相同', async () => {
  const { root, store, service, director, dev } = await laneSetup()
  try {
    const project = await service.createProject({ name: 'Lane', key: 'LANE', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: '键位任务', assigneeBotId: dev.id })
    const reviewTask = await service.createTask({ projectId: project.id, title: '验收任务', assigneeBotId: dev.id })
    const handleTask = await service.createTask({ projectId: project.id, title: '受阻任务', assigneeBotId: dev.id })
    const key = (run) => service.claimKey(run)

    // 争用口径 A：task/chat/review/handle/memory_review/vision/solo_chat/dm 全部收敛到
    // bot:<bot_id>（与 one_active_run_per_bot 同口径），分道推导已删除。
    for (const seeded of [
      seedRun(store, { kind: 'task', botId: dev.id, projectId: project.id, taskId: task.id, mode: 'write' }),
      seedRun(store, { kind: 'chat', botId: dev.id, projectId: project.id }),
      seedRun(store, { kind: 'memory_review', botId: dev.id, projectId: project.id }),
      seedRun(store, { kind: 'vision', botId: dev.id, projectId: project.id }),
      seedRun(store, { kind: 'solo_chat', botId: dev.id, mode: 'write' }),
      seedRun(store, { kind: 'vision', botId: dev.id }),
      seedRun(store, { kind: 'dm', botId: dev.id, projectId: project.id }),
    ]) {
      assert.equal(key(seeded), `bot:${dev.id}`, `${seeded.kind} 应收敛到 bot 键`)
    }
    // owner 侧运行（验收/受阻处理）同样是总监自己的 bot 键。
    assert.equal(key(seedRun(store, { kind: 'review', botId: director.id, projectId: project.id, taskId: reviewTask.id })), `bot:${director.id}`)
    assert.equal(key(seedRun(store, { kind: 'handle', botId: director.id, projectId: project.id, taskId: handleTask.id })), `bot:${director.id}`)
  } finally {
    await cleanup(root, store)
  }
})

test('claimKey 键位守门（新语义）：dm_reply 不再按来信 origin 归道，rollover_summary 不再看旧会话绑定', async () => {
  const { root, store, service, director, dev } = await laneSetup()
  try {
    const project = await service.createProject({ name: 'Origin', key: 'ORG', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: 'origin 任务', assigneeBotId: dev.id })
    const seedDm = (originKind, originTaskId = null) => {
      const messageId = id('bm')
      store.run(
        `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_kind, origin_task_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, '来信', ?, ?, 'replied', ?)`,
        messageId, project.id, director.id, dev.id, `req-${messageId}`, originKind, originTaskId, nowIso(),
      )
      return seedRun(store, { kind: 'dm_reply', botId: director.id, projectId: project.id, triggerRef: messageId })
    }
    // 回任务/私信/项目会话的回信运行都落发送方 bot 自己的控制面键。
    assert.equal(service.claimKey(seedDm('task', task.id)), `bot:${director.id}`, 'dm_reply 回任务会话应归发送方 bot 键')
    assert.equal(service.claimKey(seedDm('dm')), `bot:${director.id}`, 'dm_reply 回私信会话应归发送方 bot 键')
    assert.equal(service.claimKey(seedDm('project')), `bot:${director.id}`, 'dm_reply 回项目会话应归发送方 bot 键')

    // rollover_summary 与复用会话的绑定状态解耦：键只看 bot 自身。
    const sessionId = `sess-${id('roll')}`
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, 'project', NULL, ?)",
      sessionId, director.id, project.id, nowIso(),
    )
    const bound = seedRun(store, { kind: 'rollover_summary', botId: director.id, projectId: project.id, sessionId })
    assert.equal(service.claimKey(bound), `bot:${director.id}`, 'rollover_summary 收敛到 bot 键')
    store.run('DELETE FROM session_bindings WHERE session_id = ?', sessionId)
    assert.equal(service.claimKey(bound), `bot:${director.id}`, '绑定删除后键不变（不再读会话绑定）')
  } finally {
    await cleanup(root, store)
  }
})

test('单聊占道时同 bot 群聊挂起、跨 bot 群聊并行（新语义）：空闲后挂起消息逐类建回', async () => {
  const { root, store, service, runtime, director, dev } = await laneSetup()
  try {
    const alpha = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: director.id, memberIds: [dev.id] })
    const beta = await service.createProject({ name: 'Beta', key: 'BET', ownerBotId: director.id, memberIds: [dev.id, director.id] })
    // 单聊先跑起来（ManualRuntime 不收尾即模拟卡在提权/提问 pending）。
    await service.sendSoloMessage(dev.id, '单聊里申请提权')
    await service.sendSoloMessage(dev.id, '单聊追问第二条')
    // 同 bot 的甲项目群聊：忙时挂起，不落 runs 行。
    await service.sendMessage(alpha.id, '@Builder 甲项目问一句')
    // 跨 bot 的乙项目群聊（@总监）：照常并行。
    await service.sendMessage(beta.id, '@director 乙项目也问一句')

    service.started = true
    await service.tick()

    const running = store.all("SELECT * FROM runs WHERE status = 'running'")
    assert.ok(running.some(row => row.kind === 'solo_chat' && row.bot_id === dev.id), '首条单聊应运行中')
    assert.ok(running.some(row => row.kind === 'chat' && row.bot_id === director.id && row.project_id === beta.id), '跨 bot 群聊应并行启动')
    assert.ok(!running.some(row => row.kind === 'chat' && row.bot_id === dev.id), '同 bot 群聊被单聊占道，不得并行')
    assert.equal(store.all("SELECT * FROM runs WHERE kind = 'chat' AND bot_id = ?", dev.id).length, 0, '同 bot 群聊不落 runs 行')
    // 留痕：挂起队列按序保存第二条单聊与甲项目群聊。
    const heldBefore = heldItems(store, dev.id)
    assert.deepEqual(heldBefore.map(item => item.kind), ['solo_chat', 'chat'], '挂起队列保序留痕')

    // 单聊收尾 → 空闲 drain：第二条单聊先建回（用户提问组保序），甲项目群聊仍留队列。
    const soloRun = running.find(row => row.kind === 'solo_chat' && row.bot_id === dev.id)
    await runtime.complete(soloRun.id)
    await service.tick()
    const secondSolo = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND bot_id = ? AND status = 'running'", dev.id)
    assert.ok(secondSolo, '空闲后第二条单聊建回开跑')
    assert.equal(secondSolo.trigger_ref, heldBefore.find(item => item.kind === 'solo_chat').messageId, '建回运行的触发消息来自挂起队列')
    assert.ok(!store.get("SELECT * FROM runs WHERE kind = 'chat' AND bot_id = ?", dev.id), '单聊重建期间群聊仍留队列')
    assert.deepEqual(heldItems(store, dev.id).map(item => item.kind), ['chat'], '单聊建回后队列只剩群聊')

    // 第二条单聊收尾 → 群聊建回开跑。
    await runtime.complete(secondSolo.id)
    await service.tick()
    assert.ok(store.get("SELECT * FROM runs WHERE kind = 'chat' AND bot_id = ? AND status = 'running'", dev.id), '群聊最终建回开跑')
    assert.deepEqual(heldItems(store, dev.id), [], '建回后挂起队列清空')
  } finally {
    await cleanup(root, store)
  }
})

test('私信与群聊同道分离不回退为并行（新语义）：dm 占道时群聊挂起，逐拍按序建回', async () => {
  const { root, store, service, runtime, director, dev } = await laneSetup()
  try {
    const project = await service.createProject({ name: 'DmLane', key: 'DML', ownerBotId: director.id, memberIds: [dev.id] })
    const seedDmMessage = () => {
      const messageId = id('bm')
      store.run(
        `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_kind, status, created_at)
         VALUES (?, ?, ?, ?, ?, '来信', 'project', 'pending', ?)`,
        messageId, project.id, director.id, dev.id, `req-${messageId}`, nowIso(),
      )
      return store.get('SELECT * FROM bot_messages WHERE id = ?', messageId)
    }
    const firstRunId = service.enqueueDmRun(seedDmMessage(), dev)
    assert.ok(firstRunId, '空闲时第一条 dm 直接落 runs 行')
    assert.equal(service.enqueueDmRun(seedDmMessage(), dev), null, 'dm 占道时第二条 dm 挂起不落 runs 行')
    await service.sendMessage(project.id, '@Builder 群里同步一句')

    service.started = true
    await service.tick()

    const running = store.all("SELECT * FROM runs WHERE status = 'running'")
    assert.equal(running.filter(row => row.kind === 'dm' && row.bot_id === dev.id).length, 1, 'dm 通道同时只有一条在跑')
    assert.ok(!running.some(row => row.kind === 'chat' && row.bot_id === dev.id), 'dm 占道时同 bot 群聊挂起，不再并行')
    assert.ok(!store.get("SELECT * FROM runs WHERE kind = 'chat' AND bot_id = ?", dev.id), '群聊不落 runs 行')
    assert.deepEqual(heldItems(store, dev.id).map(item => item.kind), ['dm', 'chat'], '第二条 dm 与群聊都挂起留痕')

    // 首条 dm 收尾 → 空闲 drain：用户提问（群聊）优先放行，第二条 dm 仍留队列逐拍放行。
    await runtime.complete(firstRunId)
    await service.tick()
    assert.ok(store.get("SELECT * FROM runs WHERE kind = 'chat' AND bot_id = ? AND status = 'running'", dev.id), '用户提问的群聊优先建回开跑')
    assert.ok(!store.get("SELECT * FROM runs WHERE kind = 'dm' AND bot_id = ? AND status IN ('queued', 'running')", dev.id), 'dm 尚未放行（逐拍一条）')

    // 群聊收尾 → 第二条 dm 建回开跑。
    const chatRun = store.get("SELECT * FROM runs WHERE kind = 'chat' AND bot_id = ? AND status = 'running'", dev.id)
    await runtime.complete(chatRun.id)
    await service.tick()
    assert.ok(store.get("SELECT * FROM runs WHERE kind = 'dm' AND bot_id = ? AND status = 'running'", dev.id), '第二条 dm 最终建回开跑')
    assert.deepEqual(heldItems(store, dev.id), [], '建回后挂起队列清空')
  } finally {
    await cleanup(root, store)
  }
})

test('同会话串行不回退：总监验收运行占道时，同 bot 群聊挂起等待', async () => {
  const { root, store, service, runtime, director, dev } = await laneSetup()
  try {
    const project = await service.createProject({ name: 'Serial', key: 'SRL', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: '待验收', assigneeBotId: dev.id })
    // 总监验收运行（review，落总监 bot）先入队。
    service.enqueueOwnerTaskRun(task, 'review')
    // 同项目 @总监 的群聊随后到达：总监忙，挂待处理队列。
    const messageId = service.insertMessage({
      projectId: project.id, senderType: 'user', senderId: service.localUserId,
      body: '@director 群里问总监', mentions: [director.id],
    })
    assert.equal(service.enqueueChatRun(project, director, messageId), null, '验收占道时同 bot 群聊挂起不落 runs 行')

    service.started = true
    await service.tick()

    const running = store.all("SELECT * FROM runs WHERE status = 'running'")
    assert.equal(running.length, 1, '总监 bot 一次只放一条')
    assert.equal(running[0].kind, 'review', '先入队的验收运行先跑')
    assert.ok(!store.get("SELECT * FROM runs WHERE kind = 'chat' AND bot_id = ?", director.id), '群聊挂起不落 runs 行')
    assert.deepEqual(heldItems(store, director.id).map(item => item.kind), ['chat'], '群聊挂起留痕')

    // 验收收尾 → 空闲 drain：群聊建回开跑（同会话串行语义在 bot 串行下不回退）。
    await runtime.complete(running[0].id)
    await service.tick()
    assert.ok(store.get("SELECT * FROM runs WHERE kind = 'chat' AND bot_id = ? AND status = 'running'", director.id), '验收结束后群聊建回开跑')
    assert.deepEqual(heldItems(store, director.id), [], '建回后挂起队列清空')
  } finally {
    await cleanup(root, store)
  }
})
