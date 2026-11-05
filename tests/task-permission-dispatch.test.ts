import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { effectiveSandbox, sandboxModeForRun } from '../src/services/runtime/prompt.js'

// 权限分发产品化（DSHBOTS-156）：任务运行的会话沙箱档位跟随 bot 配置，
// 派发可选 sandbox 覆盖（只收紧不放大），生效档落 run_events 可查。
// 守门三件事：
// 1) 默认链锁死——task 运行入队恒 mode='write'（enqueue/retry/model-fallback 三个来源），
//    沙箱解析取 bot.file_policy（workspace-write / read-only 两档都断言）；
// 2) 非 write 运行恒 read-only（覆盖不参与读运行，防 dm_reply 回投任务会话被放宽）；
// 3) 覆盖全链——落库 tasks.sandbox_override、起会话生效、run_events type='sandbox_mode'
//    记档位与来源、runView 透出 sandboxMode；重派 inherit 清覆盖、缺省不动；宽松覆盖拒收。

class FakeRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  // 不回调 completion：运行停在排队/运行态即可，本文件只断言入队列与生效链。
  async startRun({ run }) { return `session-${run.id}` }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-permdispatch-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new FakeRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

async function closeQuietly(store) {
  try { store.close() } catch {}
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timeout waiting for: ${label}`)
}

// fake ctx 沿用 tests/run-sandbox-mode.test.js 的口径：services Map + get(name)。
function fakeCtx() {
  const appended = []
  const session = {
    append(type, data) { appended.push({ type, data }) },
  }
  const agent = { agent: { session } }
  const services = new Map()
  services.set('sandboxPolicy', { overrideOf: () => undefined })
  return {
    appended,
    session,
    services,
    get(name) { return services.get(name) },
    sessionController: {
      async resolveAgent() { return agent },
      async create() { return { sessionId: 'sess-1' } },
      async selectModel() { return { selected: {} } },
    },
    sessionTitle: { rename() {} },
  }
}

// owner 派单环境（tests/core.test.js ownerSetup 同款）：director 会话 + 两档配置的成员 bot。
async function ownerSetup() {
  const env = await setup()
  const { store, service } = env
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a', filePolicy: 'workspace-write' })
  const auditor = await service.createBot({ name: 'Auditor', role: '审查', instructions: 'Audit.', provider: 'fake', model: 'model-a', filePolicy: 'read-only' })
  const project = await service.createProject({ name: 'PermA Project', key: 'PA', ownerBotId: director.id, memberIds: [dev.id, auditor.id] })
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    'sess-perma', director.id, project.id, 'project', new Date().toISOString(),
  )
  return { ...env, director, dev, auditor, project, sessionId: 'sess-perma' }
}

test('task 运行入队恒 mode=write，沙箱解析取 bot.file_policy（两档断言）', async () => {
  const { root, store, service, project, sessionId, dev, auditor } = await ownerSetup()
  try {
    await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '开发模块', description: '写代码。', write_scopes: ['src/module.js'],
    })
    await service.assignFromBot(sessionId, {
      assignee: 'Auditor', title: '审查模块', description: '读代码报告问题。', write_scopes: ['src/audit.js'],
    })
    const devRun = waitFor(() => store.get("SELECT * FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE assignee_bot_id = ?) AND kind = 'task'", dev.id), 'dev run')
    const auditRun = waitFor(() => store.get("SELECT * FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE assignee_bot_id = ?) AND kind = 'task'", auditor.id), 'audit run')
    assert.equal((await devRun).mode, 'write', '开发任务运行必须入队为 write')
    assert.equal((await auditRun).mode, 'write', '审查任务运行同样入队为 write（只读只经派发覆盖收紧，不改运行类型）')

    const devBot = store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const auditorBot = store.get('SELECT * FROM bots WHERE id = ?', auditor.id)
    const devTask = store.get('SELECT * FROM tasks WHERE assignee_bot_id = ?', dev.id)
    const auditTask = store.get('SELECT * FROM tasks WHERE assignee_bot_id = ?', auditor.id)
    assert.equal(sandboxModeForRun(await devRun, devBot), 'workspace-write')
    assert.equal(sandboxModeForRun(await auditRun, auditorBot), 'read-only')
    assert.deepEqual(effectiveSandbox(await devRun, devBot, devTask), { mode: 'workspace-write', source: 'bot_config' })
    assert.deepEqual(effectiveSandbox(await auditRun, auditorBot, auditTask), { mode: 'read-only', source: 'bot_config' })
    assert.equal(devTask.sandbox_override, null, '未传 sandbox 时列必须为 NULL（默认行为不变）')
    assert.equal(auditTask.sandbox_override, null)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('retryRun 与 model-fallback 派生运行同样继承 write', async () => {
  const { root, store, service, project, dev } = await ownerSetup()
  try {
    const task = await service.createTask({ projectId: project.id, title: 'T1', assigneeBotId: dev.id, writeScopes: ['src/a.js'] })
    const firstRunId = service.enqueueTaskRun(service.taskRow(task.id), 'manual', { type: 'user', id: 'u1' })
    const firstRun = store.get('SELECT * FROM runs WHERE id = ?', firstRunId)
    assert.equal(firstRun.mode, 'write', 'enqueueTaskRun 直连入队也是 write')

    // retryRun 派生：先置 failed 再重试。
    store.run("UPDATE runs SET status = 'failed' WHERE id = ?", firstRunId)
    const retried = await service.retryRun(firstRunId, { type: 'user', id: 'u1' })
    assert.equal(retried.mode, 'write', 'retryRun 派生运行继承 write')

    // model-fallback 派生：给 bot 配备用模型，源运行 failed 后派生。
    store.run("UPDATE runs SET status = 'failed' WHERE id = ?", retried.id)
    store.run("UPDATE bots SET fallback_provider = 'fake', fallback_model = 'model-b' WHERE id = ?", dev.id)
    const botRow = store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const spawned = service.spawnModelFallback({ run: store.get('SELECT * FROM runs WHERE id = ?', retried.id), bot: botRow, error: { code: 'SERVER' } })
    assert.ok(spawned, '应派生备用运行')
    const derived = store.get('SELECT * FROM runs WHERE id = ?', spawned.runId)
    assert.equal(derived.mode, 'write', 'model-fallback 派生运行继承 write（run.mode ?? write）')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('非 write 运行恒 read-only：纯函数边界与运行时收紧兜底', async () => {
  const { root, store } = await ownerSetup()
  try {
    const dangerBot = { file_policy: 'danger-full-access' }
    for (const run of [
      { kind: 'dm', mode: 'read' },
      { kind: 'chat', mode: 'read' },
      { kind: 'review', mode: 'read' },
      { kind: 'memory_review', mode: 'read' },
      { kind: 'handle', mode: 'read' },
    ]) {
      assert.equal(sandboxModeForRun(run, dangerBot), 'read-only', `${run.kind} 运行必须 read-only`)
      assert.deepEqual(effectiveSandbox(run, dangerBot, { sandbox_override: 'read-only' }), { mode: 'read-only', source: 'run_type' })
    }
    // 带覆盖的任务 + 读运行（dm_reply 回投任务会话）：覆盖不参与，恒只读。
    assert.deepEqual(
      effectiveSandbox({ kind: 'dm_reply', mode: 'read' }, dangerBot, { sandbox_override: 'workspace-write' }),
      { mode: 'read-only', source: 'run_type' },
    )
    // 运行时收紧兜底：旁路落库的宽松覆盖（比 bot 配置更宽）不得生效。
    assert.deepEqual(
      effectiveSandbox({ kind: 'task', mode: 'write' }, { file_policy: 'read-only' }, { sandbox_override: 'workspace-write' }),
      { mode: 'read-only', source: 'bot_config' },
    )
    // 垃圾覆盖值（不在档位表）不采用，落 bot 配置档。
    assert.deepEqual(
      effectiveSandbox({ kind: 'task', mode: 'write' }, { file_policy: 'workspace-write' }, { sandbox_override: 'rm -rf /' }),
      { mode: 'workspace-write', source: 'bot_config' },
    )
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('派发覆盖全链：落库 → 起会话生效 → run_events 留档 → runView 透出', async () => {
  const { root, store, service, config, project, sessionId, dev } = await ownerSetup()
  try {
    const task = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '只读审查跑法', description: '读代码。', write_scopes: ['src/module.js'],
      sandbox: 'read-only',
    })
    const taskRow = store.get('SELECT * FROM tasks WHERE id = ?', task.id)
    assert.equal(taskRow.sandbox_override, 'read-only', 'sandbox=read-only 应落 tasks.sandbox_override')

    const runRow = await waitFor(
      () => store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task'", task.id),
      'sandbox task run',
    )
    const botRow = store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    // 生效口径：bot 配置 workspace-write，覆盖收紧到 read-only。
    assert.deepEqual(effectiveSandbox(runRow, botRow, taskRow), { mode: 'read-only', source: 'override' })

    // 起会话：宿主 sandbox/mode 收到收紧档，run_events 落 sandbox_mode 事件（档位+来源）。
    const ctx = fakeCtx()
    const runtime = new DshRuntime({ ctx, config, store, logger: { info() {}, warn() {}, error() {} } })
    const sessionUsed = await runtime.ensureSession(botRow, project, { run: runRow, task: taskRow })
    assert.equal(sessionUsed, 'sess-1')
    const modes = ctx.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(modes.length, 1)
    assert.deepEqual(modes[0].data, { mode: 'read-only' }, '覆盖档必须写进宿主会话沙箱')
    const event = store.get("SELECT * FROM run_events WHERE run_id = ? AND type = 'sandbox_mode'", runRow.id)
    assert.ok(event, '起会话必须落 sandbox_mode 事件')
    assert.match(event.message, /read-only/)
    assert.match(event.message, /override/)

    // runView 透出与事件同口径的 sandboxMode。
    assert.equal(service.runView(runRow).sandboxMode, 'read-only')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('覆盖只收紧不放大；重派 inherit 清覆盖、缺省不动；垃圾值拒收', async () => {
  const { root, store, service, project, sessionId, dev } = await ownerSetup()
  try {
    // 宽松覆盖（比 bot 配置宽）与非法档位都拒收。
    await assert.rejects(
      () => service.assignFromBot(sessionId, { assignee: 'Auditor', title: 'x', description: '写范围：src/a.js', sandbox: 'workspace-write' }),
      /只能收紧不能放宽/,
    )
    await assert.rejects(
      () => service.assignFromBot(sessionId, { assignee: 'Builder', title: 'x', description: '写范围：src/a.js', sandbox: 'danger-full-access' }),
      /沙箱覆盖无效/,
    )
    // createTask 直写垃圾值同样拒收（列只收合法收紧档）。
    await assert.rejects(
      () => service.createTask({ projectId: project.id, title: 'x', sandboxOverride: 'rm -rf /' }),
      /沙箱覆盖无效/,
    )

    // 重派链：显式收紧落列并记 task_events；缺省不动；inherit 清回 NULL。
    const task = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '重派链', description: '写范围：src/b.js',
    })
    await service.assignFromBot(sessionId, { task: `PA-${task.number}`, assignee: 'Builder', sandbox: 'read-only' })
    assert.equal(store.get('SELECT sandbox_override FROM tasks WHERE id = ?', task.id).sandbox_override, 'read-only')
    const assignedEvent = store.get(
      "SELECT data_json FROM task_events WHERE task_id = ? AND type = 'assigned' ORDER BY created_at DESC LIMIT 1",
      task.id,
    )
    assert.match(assignedEvent.data_json, /"sandbox":"read-only"/, '重派覆盖应记进 assigned 事件')

    await service.assignFromBot(sessionId, { task: `PA-${task.number}`, assignee: 'Builder' })
    assert.equal(store.get('SELECT sandbox_override FROM tasks WHERE id = ?', task.id).sandbox_override, 'read-only', '缺省重派不动覆盖')

    await service.assignFromBot(sessionId, { task: `PA-${task.number}`, assignee: 'Builder', sandbox: 'inherit' })
    assert.equal(store.get('SELECT sandbox_override FROM tasks WHERE id = ?', task.id).sandbox_override, null, 'inherit 清覆盖回落 bot 配置')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
