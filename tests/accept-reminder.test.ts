// tests/accept-reminder.test.ts —— 验收边界沉淀提醒（吸收 dsh-agent-team
// acceptance-boundary 理念，搭车投递形态）：验收通过只落 per-(bot, project) 待提醒标记；
// 负责人下次在该项目的运行提示词里渲染一次性提醒块（team_remember 指引）并清标记。
// 不 steer、不注入会话日志、不产生额外轮次（steer 形态的三宗罪）。
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
  declare handler: (result: { runId: string; status: string; output: string; error: unknown }) => void
  declare steered: { sessionId: string; body: string }[]
  constructor() { this.steered = [] }
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-x' }
  async steer(sessionId, body) { this.steered.push({ sessionId, body }); return true }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-accept-remind-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Remind', key: 'RM', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-accept-remind-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  const promptRuntime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const devRow = store.get('SELECT * FROM bots WHERE id = ?', dev.id)
  const projectRow = store.get('SELECT * FROM projects WHERE id = ?', project.id)
  const taskRun = { kind: 'task', mode: 'write', trigger_type: 'task_created' }
  return { root, store, service, runtime, promptRuntime, taskRun, devRow, projectRow, director, dev, project, sessionId, close: async () => {
    for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
      try { await service.cancelRunInternal(run.id, false) } catch {}
    }
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  } }
}

const reviewable = async (t) => {
  const task = await t.service.assignFromBot(t.sessionId, {
    assignee: 'Builder', title: '提醒卡', description: '正常实施。', write_scopes: ['src/r.js'],
  })
  for (const run of t.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)) {
    await t.service.cancelRunInternal(run.id, false)
  }
  t.store.run(
    "INSERT INTO task_events(id, task_id, type, actor_type, actor_id, data_json, created_at) VALUES (?, ?, 'run_succeeded', 'bot', ?, ?, ?)",
    `evt-deliver-${task.id}`, task.id, t.dev.id,
    JSON.stringify({ runId: `run-${task.id}`, identifier: 'RM-1' }), new Date().toISOString(),
  )
  t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
  return t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
}

const flagKey = t => `accept_remind:${t.dev.id}:${t.project.id}`

test('验收通过：落待提醒标记（不 steer、不注入会话）', async () => {
  const t = await setup()
  try {
    const task = await reviewable(t)
    const done = await t.service.applyReview(task, t.project, 'accept', '管理员验收', { type: 'user', id: 'local' })
    assert.equal(done.status, 'done')
    assert.equal(t.runtime.steered.length, 0, '不 steer')
    const flag = JSON.parse(t.store.get('SELECT value FROM settings WHERE key = ?', flagKey(t)).value)
    assert.deepEqual(flag.map(item => item.identifier), ['RM-1'])
  } finally { await t.close() }
})

test('负责人下次运行：提示词渲染一次性提醒块并清标记，再下次不重复', async () => {
  const t = await setup()
  try {
    const task = await reviewable(t)
    await t.service.applyReview(task, t.project, 'accept', '管理员验收', { type: 'user', id: 'local' })
    const taskRow = t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
    const first = t.promptRuntime.promptFor({
      run: t.taskRun, bot: t.devRow, project: t.projectRow, task: taskRow, sessionId: 's1',
    })
    assert.match(first, /Accepted tasks — persist durable conclusions/, '提醒块注入下一次运行')
    assert.match(first, /RM-1（提醒卡/, '点名任务号与标题')
    assert.match(first, /team_remember/, '指引沉淀工具')
    assert.equal(JSON.parse(t.store.get('SELECT value FROM settings WHERE key = ?', flagKey(t)).value).length, 0, '渲染即清标记')
    const second = t.promptRuntime.promptFor({
      run: t.taskRun, bot: t.devRow, project: t.projectRow, task: taskRow, sessionId: 's1',
    })
    assert.ok(!second.includes('Accepted tasks'), '再下一次不重复')
  } finally { await t.close() }
})

test('标记积压封顶 3 条：第 4 条顶掉最旧一条', async () => {
  const t = await setup()
  try {
    for (let i = 1; i <= 4; i++) {
      const task = await reviewable(t)
      await t.service.applyReview(task, t.project, 'accept', `验收 ${i}`, { type: 'user', id: 'local' })
    }
    const flag = JSON.parse(t.store.get('SELECT value FROM settings WHERE key = ?', flagKey(t)).value)
    assert.equal(flag.length, 3, '封顶 3 条')
    assert.deepEqual(flag.map(item => item.identifier), ['RM-2', 'RM-3', 'RM-4'], '最旧被顶掉')
  } finally { await t.close() }
})
