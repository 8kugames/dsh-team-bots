import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { handleAction } from '../src/api.js'

// 归档/再开/移除追踪本身不启动 run，runtime 只需存在。
class StubRuntime { declare models: any[];
  constructor() {
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }
  setCompletionHandler() {}
  async catalog() { return this.models }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

function insertRun(store, { id: runId, projectId, botId, status = 'succeeded' }) {
  const ts = new Date().toISOString()
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, 'task', 'manual', ?, ?, ?, ?, ?)`,
    runId, projectId, botId, status, `idem-${runId}`, ts, ts, ts,
  )
}

function insertMemory(store, { id, projectId, status = 'active' }) {
  const ts = new Date().toISOString()
  store.run(
    `INSERT INTO memories(id, scope_type, scope_id, topic, content, source, status, created_by, created_at, updated_at)
     VALUES (?, 'project', ?, ?, ?, 'manual', ?, 'user:owner', ?, ?)`,
    id, projectId, `话题-${id}`, `内容-${id}`, status, ts, ts,
  )
}

async function makeProject(service, store, name = 'Archive Demo') {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  // 项目 key 与 slug 均 UNIQUE，用名称派生保证同库多项目不冲突。
  const key = name.replace(/[^A-Za-z]/g, '').slice(0, 8).toUpperCase() || 'ARCH'
  return service.createProject({ name, key, ownerBotId: director.id })
}

const ACTOR = { type: 'user', id: 'owner' }

test('reopen_project 把归档冻结的项目记忆解回 active 并留 unfrozen 审计', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await makeProject(service, store)
    insertMemory(store, { id: 'mem-1', projectId: project.id, status: 'active' })
    await handleAction(service, 'archive_project', { projectId: project.id }, ACTOR)
    assert.equal(store.get('SELECT status FROM memories WHERE id = ?', 'mem-1').status, 'frozen')

    const view = await handleAction(service, 'reopen_project', { projectId: project.id }, ACTOR)
    assert.equal(view.status, 'active')
    assert.equal(store.get('SELECT status FROM memories WHERE id = ?', 'mem-1').status, 'active')
    const event = store.get("SELECT * FROM memory_events WHERE memory_id = ? AND action = 'unfrozen'", 'mem-1')
    assert.ok(event, 'memory_events 应有 unfrozen 行')
    assert.equal(event.before_text, 'frozen')
    assert.equal(event.after_text, 'active')
    assert.ok(store.get("SELECT 1 AS ok FROM audit_log WHERE action = 'project.reopen' AND target_id = ?", project.id))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('对未归档项目调 reopen_project → badRequest', async () => {
  const { root, service, store } = await setup()
  try {
    const project = await makeProject(service, store)
    await assert.rejects(
      () => handleAction(service, 'reopen_project', { projectId: project.id }, ACTOR),
      (err: any) => err.code === 'BAD_REQUEST',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('对 active 项目调 remove_project_tracking → badRequest 且数据原样', async () => {
  const { root, service, store } = await setup()
  try {
    const project = await makeProject(service, store)
    await assert.rejects(
      () => handleAction(service, 'remove_project_tracking', { projectId: project.id, confirmName: project.name }, ACTOR),
      (err: any) => err.code === 'BAD_REQUEST',
    )
    assert.ok(store.get('SELECT 1 AS ok FROM projects WHERE id = ?', project.id))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('confirmName 不匹配 → badRequest 且数据原样', async () => {
  const { root, service, store } = await setup()
  try {
    const project = await makeProject(service, store)
    await handleAction(service, 'archive_project', { projectId: project.id }, ACTOR)
    await assert.rejects(
      () => handleAction(service, 'remove_project_tracking', { projectId: project.id, confirmName: '错误的名字' }, ACTOR),
      (err: any) => err.code === 'BAD_REQUEST',
    )
    assert.ok(store.get('SELECT 1 AS ok FROM projects WHERE id = ?', project.id))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('移除追踪：逐表清空、usage_events 保留置空、audit 留痕、项目行消失', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await makeProject(service, store)
    const projectId = project.id
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const ts = new Date().toISOString()

    // 造满数据：task 族、run 族、消息、密钥、绑定、终端、outbox、提案、记忆、用量。
    store.run(
      `INSERT INTO tasks(id, project_id, number, title, creator_type, creator_id, created_at, updated_at)
       VALUES ('task-1', ?, 1, '任务一', 'user', 'owner', ?, ?)`,
      projectId, ts, ts,
    )
    store.run(
      `INSERT INTO tasks(id, project_id, number, title, creator_type, creator_id, created_at, updated_at)
       VALUES ('task-2', ?, 2, '任务二', 'user', 'owner', ?, ?)`,
      projectId, ts, ts,
    )
    store.run("INSERT INTO task_labels(task_id, label) VALUES ('task-1', 'bug')")
    store.run("INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES ('task-1', 'task-2')")
    store.run(
      `INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at)
       VALUES ('tc-1', 'task-1', 'user', 'owner', '看下', ?)`,
      ts,
    )
    store.run(
      `INSERT INTO task_events(id, task_id, type, actor_type, actor_id, created_at)
       VALUES ('te-1', 'task-1', 'created', 'user', 'owner', ?)`,
      ts,
    )
    insertRun(store, { id: 'run-1', projectId, botId: director.id })
    store.run(
      `INSERT INTO run_events(id, run_id, type, message, created_at) VALUES ('rev-1', 'run-1', 'note', '', ?)`,
      ts,
    )
    store.run(
      `INSERT INTO run_trajectory(id, run_id, seq, kind, title, created_at) VALUES ('traj-1', 'run-1', 1, 'turn', '回合', ?)`,
      ts,
    )
    store.run(
      `INSERT INTO usage_reconciliation(id, run_id, checked_at) VALUES ('ur-1', 'run-1', ?)`,
      ts,
    )
    store.run(
      `INSERT INTO usage_events(id, source_key, run_id, project_id, bot_id, task_id, occurred_at, created_at)
       VALUES ('ue-1', 'src-ue-1', 'run-1', ?, ?, 'task-1', ?, ?)`,
      projectId, director.id, ts, ts,
    )
    const group = store.get('SELECT * FROM group_chats WHERE project_id = ?', projectId)
    store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, created_at)
       VALUES ('msg-1', ?, ?, 'user', 'owner', '你好', ?)`,
      projectId, group.id, ts,
    )
    store.run(
      `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, created_at)
       VALUES ('bm-1', ?, ?, ?, 'req-1', '请帮忙', ?)`,
      projectId, director.id, director.id, ts,
    )
    await service.upsertSecret({ scope: 'project', projectId, name: 'API_TOKEN', purpose: '测试', value: '1234567890abcd' }, ACTOR)
    store.run(
      `INSERT INTO secret_requests(id, project_id, bot_id, name, reason, status, created_at)
       VALUES ('sr-1', ?, ?, 'API_TOKEN', '需要调用', 'pending', ?)`,
      projectId, director.id, ts,
    )
    store.run(
      `INSERT INTO skill_bindings(id, scope_type, scope_id, slug, version, status, created_by, created_at, updated_at)
       VALUES ('sb-1', 'project', ?, 'some-skill', '1.0.0', 'active', 'user:owner', ?, ?)`,
      projectId, ts, ts,
    )
    insertMemory(store, { id: 'mem-2', projectId })
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at)
       VALUES ('sess-1', ?, ?, 'project', ?)`,
      director.id, projectId, ts,
    )
    store.run(
      `INSERT INTO terminal_commands(id, project_id, command, status, output, created_at)
       VALUES ('term-1', ?, 'ls', 'succeeded', '', ?)`,
      projectId, ts,
    )
    store.run(
      `INSERT INTO outbox(id, kind, project_id, source_id, payload_json, status, available_at, created_at)
       VALUES ('ob-1', 'task.created', ?, 'task-1', '{}', 'pending', ?, ?)`,
      projectId, ts, ts,
    )
    store.run(
      `INSERT INTO proposals(id, kind, project_id, title, created_by, created_at)
       VALUES ('prop-1', 'memory.promote', ?, '提案一', 'user:owner', ?)`,
      projectId, ts,
    )

    await handleAction(service, 'archive_project', { projectId }, ACTOR)
    const result = await handleAction(
      service, 'remove_project_tracking', { projectId, confirmName: 'Archive Demo' }, ACTOR,
    )
    assert.deepEqual(result, { removed: true, key: 'ARCHIVED' })

    // 逐表断言无残留（含跨表依赖：另一任务的 task_dependencies、proposals 的 SET NULL FK）。
    const leftovers = [
      ['messages', 'project_id', projectId],
      ['bot_messages', 'project_id', projectId],
      ['run_trajectory', 'run_id', 'run-1'],
      ['run_events', 'run_id', 'run-1'],
      ['usage_reconciliation', 'run_id', 'run-1'],
      ['runs', 'project_id', projectId],
      ['task_labels', 'task_id', 'task-1'],
      ['task_dependencies', 'task_id', 'task-1'],
      ['task_comments', 'task_id', 'task-1'],
      ['task_events', 'task_id', 'task-1'],
      ['tasks', 'project_id', projectId],
      ['session_bindings', 'project_id', projectId],
      ['terminal_commands', 'project_id', projectId],
      ['outbox', 'project_id', projectId],
      ['group_chats', 'project_id', projectId],
      ['secret_requests', 'project_id', projectId],
      ['secrets', 'project_id', projectId],
      ['skill_bindings', 'scope_id', projectId],
      ['memories', 'scope_id', projectId],
      ['memory_events', 'memory_id', 'mem-2'],
      ['project_members', 'project_id', projectId],
      ['proposals', 'project_id', projectId],
    ]
    for (const [table, column, value] of leftovers) {
      assert.equal(
        store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, value).n, 0,
        `${table}.${column} 应无残留`,
      )
    }
    assert.ok(!store.get('SELECT 1 AS ok FROM projects WHERE id = ?', projectId), 'projects 行应已删除')

    // 全局口径保留：usage_events 行存活且引用置空；audit_log 留痕。
    const usage = store.get('SELECT * FROM usage_events WHERE id = ?', 'ue-1')
    assert.ok(usage, 'usage_events 应保留')
    assert.equal(usage.run_id, null)
    assert.equal(usage.project_id, null)
    assert.equal(usage.task_id, null)
    assert.equal(usage.bot_id, director.id)
    const audit = store.get(
      "SELECT * FROM audit_log WHERE action = 'project.remove_tracking' AND target_id = ?", projectId,
    )
    assert.ok(audit, 'audit_log 应有 project.remove_tracking')
    const auditData = JSON.parse(audit.data_json)
    assert.equal(auditData.key, 'ARCHIVED')
    assert.equal(auditData.deleteProductionDir, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('存在 queued run → 拒绝移除', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await makeProject(service, store)
    await handleAction(service, 'archive_project', { projectId: project.id }, ACTOR)
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    insertRun(store, { id: 'run-q', projectId: project.id, botId: director.id, status: 'queued' })
    await assert.rejects(
      () => handleAction(
        service, 'remove_project_tracking', { projectId: project.id, confirmName: project.name }, ACTOR,
      ),
      (err: any) => err.code === 'BAD_REQUEST',
    )
    assert.ok(store.get('SELECT 1 AS ok FROM projects WHERE id = ?', project.id))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('生产目录默认保留；显式要求才删除（含外置目录场景）', async () => {
  const { root, store, service } = await setup()
  try {
    // 场景一：默认管理目录，缺省不删。
    const projectA = await makeProject(service, store, 'Keep Dir')
    await handleAction(service, 'archive_project', { projectId: projectA.id }, ACTOR)
    await handleAction(
      service, 'remove_project_tracking', { projectId: projectA.id, confirmName: 'Keep Dir' }, ACTOR,
    )
    const dirA = join(service.config.workspace, projectA.slug)
    assert.ok(existsSync(dirA), '缺省时管理目录应保留')

    // 场景二：外置生产目录 + deleteProductionDir=true → 删除。
    const external = await mkdtemp(join(tmpdir(), 'dsh-archive-ext-'))
    const projectB = await makeProject(service, store, 'Delete Dir')
    await handleAction(service, 'update_project', { projectId: projectB.id, patch: { productionDir: external } }, ACTOR)
    await handleAction(service, 'archive_project', { projectId: projectB.id }, ACTOR)
    await handleAction(
      service, 'remove_project_tracking',
      { projectId: projectB.id, confirmName: 'Delete Dir', deleteProductionDir: true }, ACTOR,
    )
    assert.ok(!existsSync(external), '外置生产目录应被删除')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('remove_project_tracking 经 handleAction 返回 { removed, key }', async () => {
  const { root, service, store } = await setup()
  try {
    const project = await makeProject(service, store, 'Action Shape')
    await handleAction(service, 'archive_project', { projectId: project.id }, ACTOR)
    const result = await handleAction(
      service, 'remove_project_tracking', { projectId: project.id, confirmName: 'Action Shape' }, ACTOR,
    )
    assert.deepEqual(result, { removed: true, key: 'ACTIONSH' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('归档项目不收 mention：入口拒绝发送，残留 chat_run 出队跳过不派 run', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await makeProject(service, store)
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await handleAction(service, 'archive_project', { projectId: project.id }, ACTOR)

    // 入口闸门：归档后消息发不进，mention 无从定向（chat.js sendMessage 的项目状态判断）。
    await assert.rejects(
      () => handleAction(service, 'send_message', { projectId: project.id, body: '@director 在吗' }, ACTOR),
      (err: any) => err.code === 'CONFLICT',
    )

    // 出队闸门：归档瞬间残留的 pending chat_run，dispatchOutbox 按项目状态跳过——
    // 行标记 delivered（不重试不报警），且不为归档项目派生任何 run。
    const ts = new Date().toISOString()
    store.run(
      `INSERT INTO outbox(id, kind, project_id, source_id, payload_json, status, available_at, created_at)
       VALUES ('ob-arch', 'chat_run', ?, 'msg-arch', ?, 'pending', ?, ?)`,
      project.id, JSON.stringify({ projectId: project.id, botId: director.id, messageId: 'msg-arch' }), ts, ts,
    )
    service.dispatchOutbox()
    assert.equal(store.get('SELECT status FROM outbox WHERE id = ?', 'ob-arch').status, 'delivered')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE project_id = ?', project.id).n, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
