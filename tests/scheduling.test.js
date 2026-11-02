import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

// 手动完成的 runtime：startRun 后运行保持 running，直到测试显式调用 complete。
class ManualRuntime {
  constructor() {
    this.started = []
    this.steers = []
    this.pendingRuns = new Map()
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  async startRun({ run }) {
    this.started.push({ runId: run.id, botId: run.bot_id, taskId: run.task_id ?? null, mode: run.mode })
    this.pendingRuns.set(run.id, run)
    return `session-${run.id}`
  }

  async steer(sessionId, text) {
    this.steers.push({ sessionId, text })
    return true
  }

  async cancelRun() { return true }

  complete(runId, status = 'succeeded', output = 'done') {
    this.pendingRuns.delete(runId)
    return this.handler({ runId, status, output, error: null })
  }
}

async function manualSetup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-sched-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  // 关闭自动调度，由测试显式驱动 tick。
  service.started = false
  // 种子负责人 Bot：名字可能被改名（Chief/Director），按 id 取第一条种子 Bot，避免耦合具体名字。
  const chief = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  return { root, store, service, runtime, chief, dev }
}

function runningRuns(store) {
  return store.all("SELECT * FROM runs WHERE status = 'running'")
}

// 运行可能仍在异步收尾；关闭数据库前先等队列排空。
async function closeQuietly(store, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch {
      break
    }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    store.close()
  } catch {}
}

test('同项目写运行串行，跨项目与只读运行可并行', async () => {
  const { root, store, service, runtime, chief, dev } = await manualSetup()
  try {
    const alpha = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: chief.id, memberIds: [dev.id] })
    const beta = await service.createProject({ name: 'Beta', key: 'BET', ownerBotId: chief.id, memberIds: [dev.id] })
    const first = await service.createTask({ projectId: alpha.id, title: 'A1', assigneeBotId: dev.id, autoStart: true })
    await service.createTask({ projectId: alpha.id, title: 'A2', assigneeBotId: dev.id, autoStart: true })
    await service.createTask({ projectId: beta.id, title: 'B1', assigneeBotId: dev.id, autoStart: true })

    service.started = true
    await service.tick()

    // Alpha 同时只允许一个写运行；Beta 是另一个工作目录，可以并行。
    const running = runningRuns(store)
    assert.equal(running.length, 2)
    assert.equal(running.filter(run => run.project_id === alpha.id).length, 1)
    assert.equal(running.filter(run => run.project_id === beta.id).length, 1)
    assert.ok(running.every(run => run.mode === 'write'))
    assert.ok(runtime.started.some(item => item.taskId === first.id))

    // 唯一的正在运行的 Alpha 写运行结束后，排队的第二个任务才会被领取。
    const alphaRun = running.find(run => run.project_id === alpha.id)
    await runtime.complete(alphaRun.id)
    await service.tick()
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status = 'running' AND mode = 'write'", alpha.id).n, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('同项目写运行：声明的写范围不重叠时并行放行', async () => {
  const { root, store, service, runtime, chief, dev } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Scopes', key: 'SCP', ownerBotId: chief.id, memberIds: [dev.id] })
    const first = await service.createTask({
      projectId: project.id, title: '改聊天模块', assigneeBotId: dev.id,
      writeScopes: ['ui/modules/chat.js'], autoStart: true,
    })
    const second = await service.createTask({
      projectId: project.id, title: '改调度模块', assigneeBotId: dev.id,
      writeScopes: ['ui/modules/scheduler.js'], autoStart: true,
    })

    service.started = true
    await service.tick()

    const running = runningRuns(store).filter(run => run.project_id === project.id)
    assert.equal(running.length, 2, '写范围不相交的两个写运行应同时在跑')
    const ids = running.map(run => run.task_id).sort()
    assert.deepEqual(ids, [first.id, second.id].sort())
    // 并行放行留痕，便于事后排查
    assert.ok(store.get("SELECT id FROM run_events WHERE type = 'run_parallel'"), '并行放行应记一条 run_parallel 事件')
    // 运行快照带上入队时的写范围
    for (const run of running) {
      assert.ok(Array.isArray(service.runView(run).writeScopes))
      assert.equal(service.runView(run).writeScopes.length, 1)
    }
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('同项目写运行：写范围重叠时仍然串行', async () => {
  const { root, store, service, runtime, chief, dev } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Overlap', key: 'OVL', ownerBotId: chief.id, memberIds: [dev.id] })
    await service.createTask({
      projectId: project.id, title: '改聊天模块', assigneeBotId: dev.id,
      writeScopes: ['ui/modules/chat.js'], autoStart: true,
    })
    await service.createTask({
      projectId: project.id, title: '改聊天目录', assigneeBotId: dev.id,
      writeScopes: ['ui/modules/'], autoStart: true,
    })

    service.started = true
    await service.tick()

    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status = 'running'", project.id).n, 1)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status = 'queued'", project.id).n, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('同项目写运行：任一侧未声明写范围时保守串行', async () => {
  const { root, store, service, runtime, chief, dev } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Undeclared', key: 'UND', ownerBotId: chief.id, memberIds: [dev.id] })
    await service.createTask({
      projectId: project.id, title: '声明了范围', assigneeBotId: dev.id,
      writeScopes: ['ui/modules/chat.js'], autoStart: true,
    })
    await service.createTask({
      projectId: project.id, title: '没声明范围', assigneeBotId: dev.id, autoStart: true,
    })

    service.started = true
    await service.tick()

    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status = 'running'", project.id).n, 1)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status = 'queued'", project.id).n, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('同一 Bot 的任务运行与群聊回复互不阻塞', async () => {
  const { root, store, service, runtime, chief, dev } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Mix', key: 'MIX', ownerBotId: chief.id, memberIds: [dev.id] })
    await service.createTask({ projectId: project.id, title: 'Long task', assigneeBotId: dev.id, autoStart: true })
    service.started = true
    await service.tick()
    assert.equal(runningRuns(store).length, 1)

    await service.sendMessage(project.id, '@Builder 顺便回复一句')
    await service.tick()

    const running = runningRuns(store)
    const chatRun = running.find(run => run.kind === 'chat')
    const taskRun = running.find(run => run.kind === 'task')
    assert.ok(chatRun, '群聊回复应在任务运行期间被调度')
    assert.ok(taskRun, '任务运行不应被群聊回复打断')
    assert.equal(chatRun.bot_id, dev.id)
    // 同一条会话上的运行仍然串行：负责人会话的群聊与验收不会并发。
    assert.equal(service.claimKey(chatRun), `bot:${dev.id}`)
    assert.equal(service.claimKey(taskRun), `task:${taskRun.task_id}`)
    await runtime.complete(chatRun.id)
    await runtime.complete(taskRun.id)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('出队顺序按任务优先级，紧急任务不被积压拖死', async () => {
  const { root, store, service, runtime, chief, dev } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Prio', key: 'PRI', ownerBotId: chief.id, memberIds: [dev.id] })
    // 同项目只有一个写运行槽位：先入队的低优先级任务不应挡住后入队的紧急任务。
    await service.createTask({ projectId: project.id, title: 'Backlog', priority: 'low', assigneeBotId: dev.id, autoStart: true })
    const urgent = await service.createTask({ projectId: project.id, title: 'Hotfix', priority: 'urgent', assigneeBotId: dev.id, autoStart: true })

    service.started = true
    await service.tick()

    const running = runningRuns(store).filter(run => run.kind === 'task')
    assert.equal(running.length, 1)
    assert.equal(running[0].task_id, urgent.id, '紧急任务应先于更早入队的低优先级任务领取')

    // 紧急任务结束后，低优先级任务照旧被执行，队列不饿死。
    await runtime.complete(running[0].id)
    await service.tick()
    const next = runningRuns(store).filter(run => run.kind === 'task')
    assert.equal(next.length, 1)
    assert.notEqual(next[0].task_id, urgent.id)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('运行中的任务会把新评论直通到执行会话', async () => {
  const { root, store, service, runtime, chief, dev } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Steer', key: 'STR', ownerBotId: chief.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: 'Build', assigneeBotId: dev.id, autoStart: true })
    service.started = true
    await service.tick()
    const run = runningRuns(store)[0]
    assert.ok(run)
    store.run('UPDATE runs SET session_id = ? WHERE id = ?', 'session-task-1', run.id)

    const comment = await service.addComment(task.id, '改用方案 B')
    assert.equal(comment.steered, true)
    assert.equal(runtime.steers.length, 1)
    assert.equal(runtime.steers[0].sessionId, 'session-task-1')
    assert.match(runtime.steers[0].text, /STR-\d+/)
    assert.match(runtime.steers[0].text, /改用方案 B/)
    assert.ok(store.get("SELECT id FROM run_events WHERE run_id = ? AND type = 'steered'", run.id))

    // 没有运行中的任务时只落库，不投递。
    await runtime.complete(run.id)
    const idle = await service.addComment(task.id, '验收后再说')
    assert.equal(idle.steered, false)
    assert.equal(runtime.steers.length, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('旧库的 session_bindings 迁移后可容纳每任务会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-migrate-'))
  const file = join(root, 'team.sqlite')
  try {
    const legacy = new DatabaseSync(file)
    legacy.exec(`CREATE TABLE session_bindings (
      session_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'project',
      created_at TEXT NOT NULL,
      UNIQUE(bot_id, project_id, kind)
    )`)
    legacy.exec("INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES ('s1','b1','p1','project','2026-01-01')")
    legacy.close()

    const store = openDatabase(file)
    try {
      const columns = store.all('PRAGMA table_info(session_bindings)').map(column => column.name)
      assert.ok(columns.includes('task_id'))
      assert.ok(store.all('PRAGMA table_info(runs)').some(column => column.name === 'mode'))

      const now = new Date().toISOString()
      store.run(
        `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, created_at, updated_at)
         VALUES ('b1', 'Legacy', '', '', 'blue', 'active', 0, ?, ?)`, now, now,
      )
      store.run(
        `INSERT INTO projects(id, key, name, slug, owner_bot_id, status, created_at, updated_at)
         VALUES ('p1', 'LEG', 'Legacy', 'legacy', 'b1', 'active', ?, ?)`, now, now,
      )
      for (const [taskId, number] of [['t1', 1], ['t2', 2]]) {
        store.run(
          `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id, created_at, updated_at)
           VALUES (?, 'p1', ?, 'Legacy task', 'todo', 'medium', 'user', 'u1', ?, ?)`,
          taskId, number, now, now,
        )
      }
      // 旧行保留，task_id 为空
      assert.equal(store.get('SELECT * FROM session_bindings WHERE session_id = ?', 's1').task_id, null)
      // 同一 Bot 在同一项目可以有多条任务会话
      store.run(
        'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?,?,?,?,?,?)',
        's2', 'b1', 'p1', 'task', 't1', now,
      )
      store.run(
        'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?,?,?,?,?,?)',
        's3', 'b1', 'p1', 'task', 't2', now,
      )
      // 但每 Bot 每项目只能有一个非任务会话
      assert.throws(() => store.run(
        'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?,?,?,?,?,?)',
        's4', 'b1', 'p1', 'project', null, now,
      ))
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('teammate 子会话只计用量，不结束根运行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-usage-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  try {
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, created_at, updated_at)
       VALUES ('b1', 'Builder', '', '', 'blue', 'active', 0, ?, ?)`, now, now,
    )
    store.run(
      `INSERT INTO projects(id, key, name, slug, owner_bot_id, status, created_at, updated_at)
       VALUES ('p1', 'RUN', 'Run', 'run', 'b1', 'active', ?, ?)`, now, now,
    )
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
       VALUES ('r1', 'p1', 'b1', 'task', 'write', 'task_created', 'running', 1, 'k1', ?)`, now,
    )
    const runtime = new DshRuntime({
      ctx: {},
      config: { runTimeoutMs: 60_000, modelCacheMs: 0 },
      store,
      logger: { warn() {}, error() {} },
    })
    const completions = []
    runtime.setCompletionHandler(result => { completions.push(result) })
    runtime.pending.set('root', {
      runId: 'r1', sessionId: 'root', bot: { id: 'b1', provider: 'fake', model: 'model-a' },
      projectId: 'p1', started: false, texts: [], lastText: '', usageCounter: 0, timeout: null,
    })
    runtime.pendingByRun.set('r1', runtime.pending.get('root'))

    await runtime.handleEvent({ id: 'root' }, { type: 'turn/start', data: { turn: 1 } })
    await runtime.handleEvent(
      { id: 'child', parentSessionId: 'root' },
      { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 7, outputTokens: 5 }, message: { content: [{ type: 'text', text: 'teammate output' }] } } },
    )
    // 子会话不写入根运行的输出
    assert.equal(runtime.pending.get('root').texts.length, 0)
    const childUsage = store.all('SELECT * FROM usage_events WHERE run_id = ?', 'r1')
    assert.equal(childUsage.length, 1)
    assert.equal(childUsage[0].input_tokens, 7)
    assert.equal(completions.length, 0, '子会话事件不得结束根运行')

    // 子会话自己结束一轮不影响根运行
    await runtime.handleEvent({ id: 'child', parentSessionId: 'root' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(completions.length, 0)

    await runtime.handleEvent({ id: 'root' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(completions.length, 1)
    assert.equal(completions[0].status, 'succeeded')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('任务会话的 system prompt 走执行者身份，不再承担群聊分派', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-prompt-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  try {
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, created_at, updated_at)
       VALUES ('b1', 'Builder', '开发', '', 'blue', 'active', 0, ?, ?)`, now, now,
    )
    store.run(
      `INSERT INTO projects(id, key, name, slug, owner_bot_id, status, created_at, updated_at)
       VALUES ('p1', 'DEMO', 'Demo', 'demo', 'b1', 'active', ?, ?)`, now, now,
    )
    store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id, created_at, updated_at)
       VALUES ('t1', 'p1', 7, '实现对账页', 'in_progress', 'medium', 'user', 'u1', ?, ?)`, now, now,
    )
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?,?,?,?,?,?)`,
      'sess-task', 'b1', 'p1', 'task', 't1', now,
    )
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?,?,?,?,?,?)`,
      'sess-project', 'b1', 'p1', 'project', null, now,
    )
    const runtime = new DshRuntime({ ctx: {}, config: { workspace: join(root, 'workspace') }, store, logger: { warn() {} } })

    const taskPrompt = runtime.systemPromptFor({ agent: { id: 'sess-task' } })
    assert.match(taskPrompt, /executing one assigned task/)
    assert.match(taskPrompt, /DEMO-7: 实现对账页/)
    assert.doesNotMatch(taskPrompt, /team_assign_task/)
    assert.doesNotMatch(taskPrompt, /Triage requests/)

    const chatPrompt = runtime.systemPromptFor({ agent: { id: 'sess-project' } })
    assert.match(chatPrompt, /Triage requests/)
    assert.match(chatPrompt, /team_assign_task/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
