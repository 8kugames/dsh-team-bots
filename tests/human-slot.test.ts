// tests/human-slot.test.js —— DSHBOTS-43 人的消息保底并发槽。
// 覆盖：满并发时人消息运行仍能起来 1 条、第二条仍排队、写范围冲突时仍被拦。

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

async function manualSetup({ maxConcurrentRuns }: { maxConcurrentRuns?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-human-slot-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir,
    skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0,
    schedulerIntervalMs: 60_000,
  })
  if (maxConcurrentRuns !== undefined) config.maxConcurrentRuns = maxConcurrentRuns
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = false // 测试手动驱动 tick
  const director = store.get('SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)')
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  // 串行域 = (bot, 工作区)（DSHBOTS-308）：占槽任务与借槽人消息必须分属不同 bot——
  // 同 bot 同工作区的第二条人消息会被串行挂起、观测不到保底槽行为。
  const dev2 = await service.createBot({ name: 'Builder2', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'HumanSlot', key: 'HSLOT', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
  return { root, store, service, runtime, director, dev, dev2, project }
}

// 造一条人触发的群聊运行（queued），返回 runId。
function primeChatRun(service, project, dev, body) {
  const messageId = service.insertMessage({
    projectId: project.id,
    senderType: 'user',
    senderId: 'user_local',
    body,
    mentions: [dev.id],
  })
  return service.enqueueChatRun(project, dev, messageId)
}

async function cleanup(root, store) { await store.close(); await rm(root, { recursive: true, force: true }) }

// DSHBOTS-308：挂起队列键带域段（bot_pending_msgs:<bot>:<domain>）——按 bot 扫全部域键合并读取。
const heldItems = (store, botId) => {
  const rows = store.all('SELECT value FROM settings WHERE key LIKE ?', `bot_pending_msgs:${botId}:%`)
  const out = []
  for (const row of rows) {
    const arr = JSON.parse(row.value ?? '[]')
    if (Array.isArray(arr)) out.push(...arr)
  }
  return out
}

test('满并发时人消息运行借保底槽仍能起来 1 条，并写 human_slot 事件', async () => {
  const { root, store, service, runtime, director, dev, dev2, project } = await manualSetup({ maxConcurrentRuns: 1 })
  try {
    // 占满唯一的正常槽：1 条任务运行先跑起来（另一 bot 的人消息不受 bot 级串行影响）
    const task = await service.createTask({ projectId: project.id, title: '占槽任务', assigneeBotId: dev.id, writeScopes: ['src/x/'], autoStart: true })
    service.started = true
    await service.tick()
    assert.equal(runtime.started.length, 1, '任务运行占住正常槽')
    // 人触发的运行：借额外槽放行
    const runId = primeChatRun(service, project, dev2, '@Builder2 追问一句')
    await service.tick()
    assert.ok(runtime.started.includes(runId), '人消息运行应借保底槽启动')
    const event = store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'human_slot'", runId)
    assert.equal(Number(event.n), 1, '应写 human_slot 事件')
  } finally { await cleanup(root, store) }
})

test('第二条人消息在借槽运行期间挂起（保底槽仍只放行 1 条），空闲后建回（新语义）', async () => {
  const { root, store, service, runtime, director, dev, dev2, project } = await manualSetup({ maxConcurrentRuns: 1 })
  try {
    const task = await service.createTask({ projectId: project.id, title: '占槽任务', assigneeBotId: dev.id, writeScopes: ['src/x/'], autoStart: true })
    service.started = true
    await service.tick()
    const first = primeChatRun(service, project, dev2, '@Builder2 追问一')
    await service.tick()
    assert.ok(runtime.started.includes(first), '第一条人消息借槽启动')
    // 收尾会派生 memory_review 占住 bot，关掉让「空闲建回」可观测。
    store.setSetting('chat_memory_review', '0')
    // bot 级串行（争用口径 A）：借槽运行在跑期间，同 bot 同一工作区的第二条人消息不再于
    // 领取时合并，而是挂 bot_pending_msgs:<bot>:<domain> 待处理队列、不落 runs 行。
    const second = primeChatRun(service, project, dev2, '@Builder2 追问二')
    assert.equal(second, null, '忙时第二条人消息挂起不落 runs 行')
    const held = heldItems(store, dev2.id)
    assert.equal(held.length, 1, '挂起队列留痕')
    await service.tick()
    assert.equal(runtime.started.length, 2, '保底槽期间只有占槽任务与第一条借槽运行，不再放行第二条')
    // 第一条终态释放 bot：挂起消息建回，保底槽空出后再次借槽启动。
    await runtime.complete(first)
    service.drainPendingMessages()
    const rebuilt = store.get('SELECT * FROM runs WHERE trigger_ref = ?', held[0].messageId)
    assert.ok(rebuilt, '空闲后挂起消息建回运行')
    await service.tick()
    assert.ok(runtime.started.includes(rebuilt.id), '建回运行借保底槽启动')
  } finally { await cleanup(root, store) }
})

test('满并发时机器任务运行不借保底槽', async () => {
  const { root, store, service, runtime, director, dev, project } = await manualSetup({ maxConcurrentRuns: 1 })
  try {
    const taskA = await service.createTask({ projectId: project.id, title: '占槽任务A', assigneeBotId: dev.id, writeScopes: ['src/a/'], autoStart: true })
    const taskB = await service.createTask({ projectId: project.id, title: '排队任务B', assigneeBotId: dev.id, writeScopes: ['src/b/'], autoStart: true })
    service.started = true
    await service.tick()
    assert.equal(runtime.started.length, 1, '只有一条任务运行启动')
  } finally { await cleanup(root, store) }
})

test('写范围冲突时借槽的人消息运行仍被拦（write 运行不绕过写闸门）', async () => {
  const { root, store, service, runtime, director, dev, dev2, project } = await manualSetup({ maxConcurrentRuns: 1 })
  try {
    // 占住正常槽的写运行声明 src/x/（DSHBOTS-168：一级目录声明派单即驳回，锚点迁到二级）
    const task = await service.createTask({ projectId: project.id, title: '占槽任务', assigneeBotId: dev.id, writeScopes: ['src/x/'], autoStart: true })
    service.started = true
    await service.tick()
    // 写范围冲突的机器任务挂在另一空闲 bot：真实落 queued 被「写闸门」挡下（而非 bot 级串行）。
    const taskB = await service.createTask({ projectId: project.id, title: '冲突任务', assigneeBotId: dev2.id, writeScopes: ['src/x/'], autoStart: true })
    const conflictRun = store.get("SELECT id, status FROM runs WHERE task_id = ? AND kind = 'task'", taskB.id)
    assert.equal(conflictRun.status, 'queued', '写范围冲突的任务应被写闸门挡在队列里')
    // 人触发的借槽运行发给无在跑运行的总监：全局槽已满，必须借保底槽启动。
    const first = primeChatRun(service, project, director, '@director 追问')
    await service.tick()
    assert.ok(runtime.started.includes(first), '人消息借槽启动')
    // 借槽放行不影响写闸门：冲突任务依旧排队，不因保底槽被绕过。
    assert.equal(
      store.get("SELECT status FROM runs WHERE task_id = ? AND kind = 'task'", taskB.id).status,
      'queued',
      '写范围冲突的任务仍应排队，不因保底槽被绕过',
    )
  } finally { await cleanup(root, store) }
})
