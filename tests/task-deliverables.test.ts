// tests/task-deliverables.test.ts —— DSHBOTS-345 复盘：卡面结构化交付物路径。
// ① 迁移：tasks.deliverables 列随 openDatabase 落库；
// ② createTask/updateTask：deliverables 校验（相对路径、拒绝对绝对路径与 ..）、落库、taskView 暴露；
// ③ assignFromBot：新卡带 deliverables、重派改卡可同步修正；
// ④ 提示词：任务分支注入 Deliverables (file paths) 行、交付纪律句在场；
//    review 两分支（委派核验 / owner 验收）注入 Declared deliverables 行与按路径读文件的核验指引。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

class HoldingRuntime {
  declare started: unknown[]
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push(run.id); return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-deliverables-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Deliv', key: 'DLV', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-deliverables-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  const runtime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const actor = { type: 'user', id: service.localUserId }
  return { root, store, service, director, dev, project, sessionId, runtime, actor, config }
}

async function cleanup(root, service, store) {
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try { await service.cancelRunInternal(run.id, false) } catch {}
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const rowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

test('迁移与建档：deliverables 列在场，createTask 校验并落库，taskView 暴露数组', async () => {
  const t = await setup()
  try {
    const columns = t.store.all("SELECT name FROM pragma_table_info('tasks')").map(column => column.name)
    assert.ok(columns.includes('deliverables'), 'tasks.deliverables 列应随迁移落库')

    const card = await t.service.createTask(
      { projectId: t.project.id, title: '带交付物', writeScopes: ['src/a.js'], deliverables: ['src/a.js', './docs/x.md'] },
      t.actor,
    )
    assert.deepEqual(card.deliverables, ['src/a.js', 'docs/x.md'], '归一化（去 ./）去重后落库')
    assert.deepEqual(JSON.parse(rowOf(t.store, card.id).deliverables), ['src/a.js', 'docs/x.md'])

    const bare = await t.service.createTask({ projectId: t.project.id, title: '无交付物', writeScopes: ['src/b.js'] }, t.actor)
    assert.deepEqual(bare.deliverables, [], '未声明 = 空数组')

    await assert.rejects(
      t.service.createTask({ projectId: t.project.id, title: '坏路径', writeScopes: ['src/'], deliverables: ['/abs/x'] } as any, t.actor),
      /交付物包含非法路径/,
    )
    await assert.rejects(
      t.service.createTask({ projectId: t.project.id, title: '坏路径2', writeScopes: ['src/'], deliverables: ['../esc.js'] } as any, t.actor),
      /交付物包含非法路径/,
    )
  } finally { await cleanup(t.root, t.service, t.store) }
})

test('updateTask 与派单链：patch 可改 deliverables；assignFromBot 新卡带、重派改卡修正', async () => {
  const t = await setup()
  try {
    const created = await t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '派单卡', description: '做 A', write_scopes: ['src/a.js'],
      deliverables: ['src/a.js'],
    })
    assert.deepEqual(created.deliverables, ['src/a.js'], '新卡经派单链带 deliverables')

    const amended = await t.service.assignFromBot(t.sessionId, {
      task: 'DLV-1', assignee: 'Builder', deliverables: ['src/a.js', 'docs/a.md'],
    })
    assert.deepEqual(amended.deliverables, ['src/a.js', 'docs/a.md'], '重派改卡同步修正 deliverables')

    const patched = await t.service.updateTask(rowOf(t.store, created.id).id, { deliverables: ['only.md'] }, t.actor)
    assert.deepEqual(patched.deliverables, ['only.md'], 'updateTask patch 可改')
    await assert.rejects(
      t.service.updateTask(rowOf(t.store, created.id).id, { deliverables: ['../x'] } as any, t.actor),
      /交付物包含非法路径/,
    )
  } finally { await cleanup(t.root, t.service, t.store) }
})

test('提示词：任务分支注入交付物行与禁贴正文纪律；review 两分支注入声明与按路径核验指引', async () => {
  const t = await setup()
  try {
    const card = await t.service.createTask(
      { projectId: t.project.id, title: '提示词卡', writeScopes: ['src/a.js'], deliverables: ['src/a.js'] },
      t.actor,
    )
    const task = rowOf(t.store, card.id)
    const prompt = t.runtime.promptFor({ run: { kind: 'task' }, bot: t.dev, project: t.project, task })
    assert.match(prompt, /Deliverables \(file paths\): src\/a\.js/, '任务分支应注入交付物路径行')
    assert.match(prompt, /Never paste file contents into the report or chat/, '交付纪律句在场')
    assert.match(prompt, new RegExp(`delivery report \\(≤${t.config.deliveryReportMaxChars} chars\\)`), '体量红线注入')
    const barePrompt = t.runtime.promptFor({
      run: { kind: 'task' }, bot: t.dev, project: t.project,
      task: rowOf(t.store, (await t.service.createTask({ projectId: t.project.id, title: '裸卡', writeScopes: ['src/c/'] }, t.actor)).id),
    })
    assert.ok(!barePrompt.includes('Deliverables (file paths)'), '未声明不注入该行')

    const delegatePrompt = t.runtime.promptFor({ run: { kind: 'review', trigger_type: 'review_delegate' }, bot: t.dev, project: t.project, task })
    assert.match(delegatePrompt, /Declared deliverables: src\/a\.js/, '委派核验分支注入声明行')
    assert.match(delegatePrompt, /every declared deliverable path below must exist; read the files directly/, '按路径读文件的核验指引在场')

    const ownerPrompt = t.runtime.promptFor({ run: { kind: 'review', trigger_type: 'review_requested' }, bot: t.dev, project: t.project, task })
    assert.match(ownerPrompt, /Declared deliverables: src\/a\.js/, 'owner 验收分支注入声明行')
    assert.match(ownerPrompt, /open the files at those paths instead of trusting the report prose/, 'owner 验收按路径读文件')
  } finally { await cleanup(t.root, t.service, t.store) }
})
