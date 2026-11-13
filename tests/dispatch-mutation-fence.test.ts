// tests/dispatch-mutation-fence.test.ts —— 变更栅栏（吸收 dsh-agent-team mutation-fence
// 理念，落在本项目形态）：team_assign_task 改卡可选带 expected_version（bot 最后看到的
// 卡 version），不匹配即拒且拒绝附带最近变更事实（task_changes 摘要），写者可就地重新
// 裁决；不带参数保持 last-write-wins。updateTask 的既有 CAS 同享该事实文案面。
// ① 改卡带过时 expected_version → 拒，文案含错过的事实（交付/改字段），卡面未被覆写；
// ② 改卡带当前 expected_version → 放行，改卡生效；
// ③ 不带 expected_version → 并发改动后仍放行（既有行为不变）；
// ④ updateTask 直调带过时 version → 同一事实文案面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class HoldingRuntime {
  declare started: unknown[]
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push({ id: run.id, kind: run.kind }); return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mutation-fence-'))
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
  const project = await service.createProject({ name: 'Fence', key: 'FENCE', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-mutation-fence-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return { root, store, service, director, dev, project, sessionId }
}

async function cleanup(root, service, store) {
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try { await service.cancelRunInternal(run.id, false) } catch {}
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

async function bareTask(t) {
  const task = await t.service.assignFromBot(t.sessionId, {
    assignee: 'Builder', title: '原卡标题', description: '原描述。', write_scopes: ['src/f.js'],
  })
  for (const run of t.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)) {
    await t.service.cancelRunInternal(run.id, false)
  }
  return t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
}

test('① 改卡带过时 expected_version → 拒，文案含错过的事实，卡面未被覆写', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t)
    const staleVersion = task.version
    // bot 读取之后、改卡之前：成员交付，卡 version 前进。
    t.store.run(
      "INSERT INTO task_events(id, task_id, type, actor_type, actor_id, data_json, created_at) VALUES (?, ?, 'run_succeeded', 'bot', ?, ?, ?)",
      `evt-deliver-${task.id}`, task.id, t.dev.id,
      JSON.stringify({ runId: `run-${task.id}`, identifier: 'FENCE-1' }), new Date().toISOString(),
    )
    t.store.run("UPDATE tasks SET status = 'in_review', version = version + 1 WHERE id = ?", task.id)
    await assert.rejects(
      t.service.assignFromBot(t.sessionId, {
        assignee: 'Builder', task: 'FENCE-1', title: '覆写标题', expected_version: staleVersion,
      }),
      (error: any) => {
        assert.match(error.message, /已被更新（你基于 version /)
        assert.match(error.message, /Builder 交付/)
        assert.match(error.message, /expected_version 重试/)
        return true
      },
    )
    const after = t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
    assert.equal(after.title, '原卡标题', '过时写入未落库')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('② 改卡带当前 expected_version → 放行且改卡生效', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t)
    const updated = await t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', task: 'FENCE-1', title: '修正标题', expected_version: task.version,
    })
    assert.equal(updated.title, '修正标题')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('③ 不带 expected_version → 并发改动后仍放行（last-write-wins 行为不变）', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t)
    t.store.run("UPDATE tasks SET version = version + 1, title = '他人改过' WHERE id = ?", task.id)
    const updated = await t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', task: 'FENCE-1', title: '无栅栏覆写',
    })
    assert.equal(updated.title, '无栅栏覆写')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('④ updateTask 直调带过时 version → 同一事实文案面', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t)
    t.store.run("UPDATE tasks SET version = version + 1 WHERE id = ?", task.id)
    await assert.rejects(
      t.service.updateTask(task.id, { version: task.version, title: '直调改卡' }, { type: 'user', id: 'local' }),
      (error: any) => {
        assert.match(error.message, /已被更新（你基于 version /)
        assert.match(error.message, /最近变更/)
        return true
      },
    )
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})
