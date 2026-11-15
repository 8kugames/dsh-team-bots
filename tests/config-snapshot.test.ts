// tests/config-snapshot.test.ts —— C2/DSHBOTS-334：在途 run 配置版本快照守门。
// 任务运行独占会话（D-308），startRun 时记 run_event 'config_snapshot'（bot 角色版本 +
// 实际下发模型 + 可编辑提示词段覆盖正文），回答「这张卡按哪版规则跑的」；只记账不闸门。
// 守门四向：①任务运行记快照（bot_revision/模型/段覆盖在场）；②消息族运行不记（控制面
// 冻结会话 D-91 下「当时 settings」反而误导）；③覆盖变更后下一张卡快照随之变化；
// ④快照内容可解析且与 settings 一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class RecordingRuntime {
  declare started: any[]
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun(input: any) {
    this.started.push(input.run.id)
    return `session-${input.run.id}`
  }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-config-snapshot-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new RecordingRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const projectView = await service.createProject({ name: 'Order', key: 'ORD', ownerBotId: director.id })
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  return { root, store, service, runtime, director, project }
}

const teardown = async (root, store) => {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

const snapshotsOf = (store, runId) => store.all(
  "SELECT * FROM run_events WHERE run_id = ? AND type = 'config_snapshot'", runId,
)

test('任务运行记 config_snapshot；消息族运行不记', async (t) => {
  const { root, store, service, runtime, director, project } = await setup()
  t.after(async () => { await teardown(root, store) })
  const actor = { type: 'user', id: 'u1' }
  const builderView = await service.createBot({ name: 'Builder', role: '开发', instructions: '', provider: 'fake', model: 'model-a' })
  await service.addProjectMember(project.id, builderView.id)
  const builder = store.get('SELECT * FROM bots WHERE id = ?', builderView.id)
  const card = await service.createTask({ projectId: project.id, title: '快照卡', assigneeBotId: builder.id, writeScopes: ['src/a.js'] }, actor)
  const runId = service.enqueueTaskRun(service.taskRow(card.id), 'task_started', actor)
  await service.executeRun(runId)
  const events = snapshotsOf(store, runId)
  assert.equal(events.length, 1, '任务运行恰一条快照')
  const payload = JSON.parse(events[0].message)
  assert.equal(payload.bot_revision, Number(builder.current_revision) || 0)
  assert.deepEqual(payload.model, { provider: 'fake', model: 'model-a', effort: null }, '模型三元组在场')
  assert.deepEqual(payload.prompt_segment_overrides, { communication: null, subtask: null, splitting: null, selfcheck: null }, '无覆盖时段记 null')
})

test('段覆盖变更后下一张卡快照随之变化；覆盖正文与 settings 一致', async (t) => {
  const { root, store, service, runtime, director, project } = await setup()
  t.after(async () => { await teardown(root, store) })
  const actor = { type: 'user', id: 'u1' }
  const card1 = await service.createTask({ projectId: project.id, title: '卡一', assigneeBotId: director.id }, actor)
  const run1 = { id: service.enqueueTaskRun(service.taskRow(card1.id), 'task_started', actor) }
  await service.executeRun(run1.id)
  const before = JSON.parse(snapshotsOf(store, run1.id)[0].message)

  service.updatePromptSegment('splitting', 'Split only when the owner approves.', actor)
  const card2 = await service.createTask({ projectId: project.id, title: '卡二', assigneeBotId: director.id }, actor)
  const run2 = { id: service.enqueueTaskRun(service.taskRow(card2.id), 'task_started', actor) }
  await service.executeRun(run2.id)
  const after = JSON.parse(snapshotsOf(store, run2.id)[0].message)

  assert.equal(before.prompt_segment_overrides.splitting, null)
  assert.equal(after.prompt_segment_overrides.splitting, 'Split only when the owner approves.')
  assert.equal(after.prompt_segment_overrides.communication, null, '未动段仍记 null')
})

test('备用模型运行快照记录 runs 行三列的实际下发模型', async (t) => {
  const { root, store, service, runtime, director, project } = await setup()
  t.after(async () => { await teardown(root, store) })
  const actor = { type: 'user', id: 'u1' }
  const card = await service.createTask({ projectId: project.id, title: '备用卡', assigneeBotId: director.id }, actor)
  const run = { id: service.enqueueTaskRun(service.taskRow(card.id), 'task_started', actor) }
  store.run('UPDATE runs SET model_provider = ?, model_model = ?, model_effort = ? WHERE id = ?', 'fallback-prov', 'fallback-model', 'high', run.id)
  await service.executeRun(run.id)
  const payload = JSON.parse(snapshotsOf(store, run.id)[0].message)
  assert.deepEqual(payload.model, { provider: 'fallback-prov', model: 'fallback-model', effort: 'high' }, '快照与 D-25 实际下发模型一致')
})
