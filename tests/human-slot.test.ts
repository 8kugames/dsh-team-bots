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
  const project = await service.createProject({ name: 'HumanSlot', key: 'HSLOT', ownerBotId: director.id, memberIds: [dev.id] })
  return { root, store, service, runtime, director, dev, project }
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

test('满并发时人消息运行借保底槽仍能起来 1 条，并写 human_slot 事件', async () => {
  const { root, store, service, runtime, director, dev, project } = await manualSetup({ maxConcurrentRuns: 1 })
  try {
    // 占满唯一的正常槽：1 条任务运行先跑起来
    const task = await service.createTask({ projectId: project.id, title: '占槽任务', assigneeBotId: dev.id, writeScopes: ['src/x/'], autoStart: true })
    service.started = true
    await service.tick()
    assert.equal(runtime.started.length, 1, '任务运行占住正常槽')
    // 人触发的运行：借额外槽放行
    const runId = primeChatRun(service, project, dev, '@Builder 追问一句')
    await service.tick()
    assert.ok(runtime.started.includes(runId), '人消息运行应借保底槽启动')
    const event = store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'human_slot'", runId)
    assert.equal(Number(event.n), 1, '应写 human_slot 事件')
  } finally { await cleanup(root, store) }
})

test('第二条人消息合并进第一条运行（保底槽仍只放行 1 条）', async () => {
  const { root, store, service, runtime, director, dev, project } = await manualSetup({ maxConcurrentRuns: 1 })
  try {
    const task = await service.createTask({ projectId: project.id, title: '占槽任务', assigneeBotId: dev.id, writeScopes: ['src/x/'], autoStart: true })
    service.started = true
    await service.tick()
    const first = primeChatRun(service, project, dev, '@Builder 追问一')
    const second = primeChatRun(service, project, dev, '@Builder 追问二')
    await service.tick()
    assert.ok(runtime.started.includes(first), '第一条人消息借槽启动')
    assert.ok(!runtime.started.includes(second), '第二条人消息不应再启动一次运行')
    const status = store.get('SELECT status FROM runs WHERE id = ?', second).status
    // DSHBOTS-231 合批：同一通道第二条人消息被合并进第一条运行的上下文，不再单独排队。
    assert.equal(status, 'canceled', '第二条应被合并进第一条运行')
    assert.equal(store.get('SELECT error_code FROM runs WHERE id = ?', second).error_code, 'MERGED')
    const firstRun = store.get('SELECT * FROM runs WHERE id = ?', first)
    assert.equal(JSON.parse(firstRun.merged_messages).length, 1, '第一条运行应携带被合并的第二条消息')
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
  const { root, store, service, runtime, director, dev, project } = await manualSetup({ maxConcurrentRuns: 1 })
  try {
    // 占住正常槽的写运行声明 src/x/（DSHBOTS-168：一级目录声明派单即驳回，锚点迁到二级）
    const task = await service.createTask({ projectId: project.id, title: '占槽任务', assigneeBotId: dev.id, writeScopes: ['src/x/'], autoStart: true })
    service.started = true
    await service.tick()
    // 人触发的写运行（单聊 kind='solo_chat' 是 write 模式，但 project_id 为空不占项目锁；
    // 用一个带项目写范围的场景：给同项目造一条 queued 的写模式人触发运行不现实——
    // 现有 chat 运行都是 read 模式。这里验证的是「借槽不影响写闸门」：
    // 借槽启动的保底槽运行之后，写范围冲突的机器任务依旧被拦。
    const first = primeChatRun(service, project, dev, '@Builder 追问')
    await service.tick()
    assert.ok(runtime.started.includes(first), '人消息借槽启动')
    const taskB = await service.createTask({ projectId: project.id, title: '冲突任务', assigneeBotId: dev.id, writeScopes: ['src/x/'], autoStart: true })
    await service.tick()
    const conflictRun = store.get("SELECT id, status FROM runs WHERE task_id = ? AND kind = 'task'", taskB.id)
    assert.equal(conflictRun.status, 'queued', '写范围冲突的任务仍应排队，不因保底槽被绕过')
  } finally { await cleanup(root, store) }
})
