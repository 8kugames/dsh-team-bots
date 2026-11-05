// tests/run-coalesce.test.js —— DSHBOTS-231 入站消息合批守门。
// 用户拍板：同一会话/同一 bot 排队尚未处理的多条消息，领取 run 时合并注入同一次运行，
// 不再一条消息一次运行。守四条边界：
// ①同一条绑定道内多条排队 → 单次运行携带全部消息（群聊与单聊各一组）；
// ②跨道（跨项目/跨会话类别）不合批，D-219 四道解耦语义不回退；
// ③合并条数上限走 settings，默认保守；
// ④合并窗口走 settings，窗口外的排队消息不合并。

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
  // 关闭自动调度，由测试显式驱动 tick。
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

test('群聊同通道多条排队消息合并成一次运行，单次运行携带全部消息', async () => {
  const t = await setup()
  try {
    const m1 = say(t.service, t.project.id, '第一条：先看一下现状')
    const m2 = say(t.service, t.project.id, '第二条：顺便把测试补上')
    const m3 = say(t.service, t.project.id, '第三条：最后跑一遍验证')
    for (const messageId of [m1, m2, m3]) t.service.enqueueChatRun(t.project, t.dev, messageId)

    t.service.started = true
    await t.service.tick()

    const running = t.store.all("SELECT * FROM runs WHERE status = 'running'")
    const merged = t.store.all("SELECT * FROM runs WHERE error_code = 'MERGED' ORDER BY queued_at")
    assert.equal(running.length, 1, '同通道三条排队消息只应领取一次运行')
    assert.equal(merged.length, 2, '另外两条应被合并取消')
    assert.equal(t.runtime.started.length, 1, '只应启动一次运行')
    const primary = t.runtime.started[0]
    assert.equal(primary.chatMessage.id, m1, '触发消息应是最早的那条')
    assert.deepEqual(primary.extraMessages.map(item => item.id), [m2, m3], '合并消息应按入队顺序全部携带')

    // 提示词：三条消息都进同一轮上下文，合批消息不再回烧进尾窗（正文只出现一次）。
    const runRow = t.store.get('SELECT * FROM runs WHERE id = ?', running[0].id)
    const prompt = groupPrompt(t, runRow, primary.chatMessage, primary.extraMessages)
    for (const body of ['第一条：先看一下现状', '第二条：顺便把测试补上', '第三条：最后跑一遍验证']) {
      assert.ok(prompt.includes(body), `提示词应包含消息正文：${body}`)
    }
    assert.ok(prompt.includes('# Merged messages'), '合批段落应出现')
    assert.equal(prompt.split('第二条：顺便把测试补上').length - 1, 1, '合批消息正文只出现一次')
    assert.equal(prompt.split('第三条：最后跑一遍验证').length - 1, 1, '合批消息正文只出现一次')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('单聊通道多条排队消息同样合并，单聊与群聊提示词都带合批段', async () => {
  const t = await setup()
  try {
    const bodies = ['单聊第一条：在吗', '单聊第二点：帮我看下这个报错', '单聊第三点：改完跑一下测试']
    const ids = bodies.map(body => t.service.insertSoloMessage({ botId: t.dev.id, senderType: 'user', senderId: 'u1', body }))
    for (const messageId of ids) t.service.enqueueSoloChatRun(t.dev, messageId)

    t.service.started = true
    await t.service.tick()

    const running = t.store.all("SELECT * FROM runs WHERE status = 'running'")
    assert.equal(running.length, 1, '单聊同通道三条排队消息只应领取一次运行')
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE error_code = 'MERGED'").n, 2)
    const primary = t.runtime.started[0]
    assert.equal(primary.chatMessage.id, ids[0])
    assert.deepEqual(primary.extraMessages.map(item => item.id), [ids[1], ids[2]])

    const botRow = t.store.get('SELECT * FROM bots WHERE id = ?', t.dev.id)
    const prompt = t.promptRuntime.promptFor({
      run: running[0], bot: botRow, project: null, task: null,
      chatMessage: primary.chatMessage, extraMessages: primary.extraMessages, sessionId: 's-solo-coalesce',
    })
    for (const body of bodies) assert.ok(prompt.includes(body), `单聊提示词应包含消息正文：${body}`)
    assert.ok(prompt.includes('# Merged messages'), '单聊合批段落应出现')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('跨绑定道不合批：同 bot 跨项目与单聊各自独立领取，D-219 四道解耦不回退', async () => {
  const t = await setup()
  try {
    // 同一个 bot 分布在三条项目通道 + 一条单聊通道，每条通道各一条消息。
    const lanes = [t.project]
    for (const [name, key] of [['Beta', 'BET'], ['Gamma', 'GAM']]) {
      lanes.push(await t.service.createProject({ name, key, ownerBotId: t.director.id, memberIds: [t.dev.id] }))
    }
    for (const lane of lanes) {
      t.service.enqueueChatRun(lane, t.dev, say(t.service, lane.id, `来自 ${lane.key} 的消息`))
    }
    const soloId = t.service.insertSoloMessage({ botId: t.dev.id, senderType: 'user', senderId: 'u1', body: '单聊消息' })
    t.service.enqueueSoloChatRun(t.dev, soloId)

    t.service.started = true
    await t.service.tick()

    const running = t.store.all("SELECT * FROM runs WHERE status = 'running'")
    assert.equal(running.length, 4, '三条项目通道 + 单聊通道各自领取一条运行')
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE error_code = 'MERGED'").n, 0, '跨道不合批')
    assert.equal(t.runtime.started.length, 4, '四条通道各启动一次运行')
    assert.ok(t.runtime.started.every(item => item.extraMessages.length === 0), '跨道运行不应携带合并消息')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('合并条数上限走 settings：每条运行最多合并到上限，剩下的下一拍再组成新运行', async () => {
  const t = await setup()
  try {
    t.store.setSetting('coalesce_max_messages', '2')
    const ids = [1, 2, 3, 4].map(index => say(t.service, t.project.id, `消息 ${index}`))
    for (const messageId of ids) t.service.enqueueChatRun(t.project, t.dev, messageId)

    t.service.started = true
    await t.service.tick()

    // 同一通道严格串行：第一条运行带走前两条，后两条继续排队。
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").n, 1)
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE error_code = 'MERGED'").n, 1)
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'").n, 2)
    assert.deepEqual(t.runtime.started[0].extraMessages.map(item => item.id), [ids[1]], '第一次运行携带前两条')

    // 第一条运行结束后，剩下的两条组成第二次运行。
    await t.runtime.complete(t.runtime.started[0].runId)
    await t.service.tick()
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").n, 1)
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE error_code = 'MERGED'").n, 2)
    const second = t.runtime.started[1]
    assert.equal(second.chatMessage.id, ids[2])
    assert.deepEqual(second.extraMessages.map(item => item.id), [ids[3]], '第二次运行携带后两条')
  } finally {
    await cleanup(t.root, t.store)
  }
})

test('合并窗口走 settings：窗口外的排队消息不合并，保持排队', async () => {
  const t = await setup()
  try {
    t.store.setSetting('coalesce_window_ms', '60000')
    const m1 = say(t.service, t.project.id, '窗口内第一条')
    const m2 = say(t.service, t.project.id, '窗口内第二条')
    const m3 = say(t.service, t.project.id, '窗口外第三条')
    t.service.enqueueChatRun(t.project, t.dev, m1)
    t.service.enqueueChatRun(t.project, t.dev, m2)
    const lateRunId = t.service.enqueueChatRun(t.project, t.dev, m3)
    // 把第三条的入队时间推到一小时后：与最早那条的相差远超合并窗口。
    t.store.run(
      'UPDATE runs SET queued_at = ? WHERE id = ?',
      new Date(Date.now() + 3_600_000).toISOString(), lateRunId,
    )

    const primary = t.store.get('SELECT * FROM runs WHERE trigger_ref = ?', m1)
    const mergedRuns = t.service.coalesceQueuedRuns(primary)

    assert.deepEqual(mergedRuns.map(row => row.trigger_ref), [m2], '窗口内的第二条合并进来')
    assert.equal(t.store.get('SELECT status FROM runs WHERE id = ?', lateRunId).status, 'queued', '窗口外的第三条保持排队')
    assert.equal(
      t.store.get('SELECT merged_messages FROM runs WHERE id = ?', primary.id).merged_messages,
      JSON.stringify([m2]),
    )
  } finally {
    await cleanup(t.root, t.store)
  }
})
