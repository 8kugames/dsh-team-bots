import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { effectiveSandbox } from '../src/services/runtime/prompt.js'

// 派发沙箱档位缺省规则守门（DSHBOTS-234）：档位解析顺序=卡面显式声明 > bot 配置（inherit 为缺省）。
// ①非只读卡派发（未传 sandbox）→ 运行档位 = 执行 bot 自身配置档（两档都断言），列落 NULL=inherit；
// ②显式只读卡（sandbox='read-only'）→ 运行档位 = read-only（只收紧，存量覆盖行为不变）；
// ③起会话把生效档写进宿主 sandbox/mode，run_events 留档——缺省不是 read-only，也不是宿主默认兜底。

class FakeRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-sandboxdefault-'))
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

// fake ctx 沿用 tests/task-permission-dispatch.test.js 的口径：services Map + get(name)。
function fakeCtx() {
  const appended = []
  const session = { append(type, data) { appended.push({ type, data }) } }
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

async function ownerSetup() {
  const env = await setup()
  const { store, service } = env
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a', filePolicy: 'workspace-write' })
  const auditor = await service.createBot({ name: 'Auditor', role: '审查', instructions: 'Audit.', provider: 'fake', model: 'model-a', filePolicy: 'read-only' })
  const project = await service.createProject({ name: 'SandboxDefault Project', key: 'SD', ownerBotId: director.id, memberIds: [dev.id, auditor.id] })
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    'sess-sd', director.id, project.id, 'project', new Date().toISOString(),
  )
  return { ...env, director, dev, auditor, project, sessionId: 'sess-sd' }
}

test('非只读卡派发：运行档位=执行 bot 自身配置（workspace-write 与 read-only 两档），缺省不落 read-only', async () => {
  const { root, store, service, config, project, sessionId, dev, auditor } = await ownerSetup()
  try {
    await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '开发模块', description: '写代码。', write_scopes: ['src/module.js'],
    })
    // DSHBOTS-314 派单策略闸后写卡不经 assignFromBot 派只读 bot——直建卡+入队保持测试意图。
    const auditTaskSeed = await service.createTask({ projectId: project.id, title: '审查模块', assigneeBotId: auditor.id, writeScopes: ['src/audit.js'] })
    service.enqueueTaskRun(auditTaskSeed, 'assigned', { type: 'bot', id: dev.id })
    const devRun = await waitFor(
      () => store.get("SELECT * FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE assignee_bot_id = ?) AND kind = 'task'", dev.id),
      'dev run',
    )
    const auditRun = await waitFor(
      () => store.get("SELECT * FROM tasks WHERE assignee_bot_id = ?", auditor.id),
      'audit task',
    )
    const auditTaskRun = await waitFor(
      () => store.get('SELECT * FROM runs WHERE task_id = ? AND kind = ?', auditRun.id, 'task'),
      'audit run',
    )
    const devTask = store.get('SELECT * FROM tasks WHERE id = ?', devRun.task_id)
    const auditTask = store.get('SELECT * FROM tasks WHERE id = ?', auditTaskRun.task_id)
    const devBot = store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const auditorBot = store.get('SELECT * FROM bots WHERE id = ?', auditor.id)

    // 卡面未声明 → 列落 NULL=inherit，运行档位取 bot 配置档（不是缺省 read-only）。
    assert.equal(devTask.sandbox_override, null, '未传 sandbox 必须落 NULL=inherit')
    assert.equal(auditTask.sandbox_override, null)
    assert.deepEqual(effectiveSandbox(devRun, devBot, devTask), { mode: 'workspace-write', source: 'bot_config' })
    assert.deepEqual(effectiveSandbox(auditTaskRun, auditorBot, auditTask), { mode: 'read-only', source: 'bot_config' })

    // 起会话：缺省档必须真的写进宿主 sandbox/mode（workspace-write 侧），并落 run_events。
    const ctx = fakeCtx()
    const runtime = new DshRuntime({ ctx, config, store, logger: { info() {}, warn() {}, error() {} } })
    await runtime.ensureSession(devBot, project, { run: devRun, task: devTask })
    const modes = ctx.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(modes.length, 1, '缺省档应写一次 sandbox/mode')
    assert.deepEqual(modes[0].data, { mode: 'workspace-write' }, '缺省档=bot 配置档，不得收紧为 read-only')
    const event = store.get("SELECT * FROM run_events WHERE run_id = ? AND type = 'sandbox_mode'", devRun.id)
    assert.ok(event, '缺省档也要落 sandbox_mode 事件')
    assert.match(event.message, /workspace-write/)
    assert.match(event.message, /bot_config/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('显式只读卡派发：运行档位=read-only（卡面声明优先于 bot 配置，存量覆盖行为不变）', async () => {
  const { root, store, service, config, project, sessionId, dev } = await ownerSetup()
  try {
    await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '只读审查跑法', description: '读代码。', write_scopes: ['src/module.js'],
      sandbox: 'read-only',
    })
    const taskRow = store.get('SELECT * FROM tasks WHERE assignee_bot_id = ?', dev.id)
    assert.equal(taskRow.sandbox_override, 'read-only', '卡面显式声明必须落列')
    const runRow = await waitFor(
      () => store.get('SELECT * FROM runs WHERE task_id = ? AND kind = ?', taskRow.id, 'task'),
      'read-only task run',
    )
    const botRow = store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    assert.deepEqual(effectiveSandbox(runRow, botRow, taskRow), { mode: 'read-only', source: 'override' })

    const ctx = fakeCtx()
    const runtime = new DshRuntime({ ctx, config, store, logger: { info() {}, warn() {}, error() {} } })
    await runtime.ensureSession(botRow, project, { run: runRow, task: taskRow })
    const modes = ctx.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(modes.length, 1)
    assert.deepEqual(modes[0].data, { mode: 'read-only' }, '显式只读卡必须落 read-only')
    const event = store.get("SELECT * FROM run_events WHERE run_id = ? AND type = 'sandbox_mode'", runRow.id)
    assert.match(event.message, /read-only/)
    assert.match(event.message, /override/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('重派 inherit 清覆盖回落 bot 配置；未传 sandbox 不动既有覆盖', async () => {
  const { root, store, service, sessionId, dev } = await ownerSetup()
  try {
    const task = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '重派链', description: '写范围：src/b.js',
    })
    await service.assignFromBot(sessionId, { task: `SD-${task.number}`, assignee: 'Builder', sandbox: 'read-only' })
    assert.equal(store.get('SELECT sandbox_override FROM tasks WHERE id = ?', task.id).sandbox_override, 'read-only')
    await service.assignFromBot(sessionId, { task: `SD-${task.number}`, assignee: 'Builder' })
    assert.equal(store.get('SELECT sandbox_override FROM tasks WHERE id = ?', task.id).sandbox_override, 'read-only', '未传 sandbox 不动既有覆盖')
    await service.assignFromBot(sessionId, { task: `SD-${task.number}`, assignee: 'Builder', sandbox: 'inherit' })
    assert.equal(store.get('SELECT sandbox_override FROM tasks WHERE id = ?', task.id).sandbox_override, null, 'inherit 清覆盖回落 bot 配置')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
