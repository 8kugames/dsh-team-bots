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
  declare started: Array<{ runId: string; botId: string; taskId: string | null; mode: string }>
  declare steers: Array<{ sessionId: string; text: string }>
  declare pendingRuns: Map<string, unknown>
  declare handler: (result: { runId: string; status: string; output: string; error: null }) => unknown

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
  // 种子总监 Bot：名字可能被改名（Chief/director），按 id 取第一条种子 Bot，避免耦合具体名字。
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  // DSHBOTS-290：bot 级串行（one_active_run_per_bot）下同 bot 双运行必串行（第二条直接挂起
  // 不落 runs 行）；需要并行的用例把第二条任务/消息路由到 dev2 车道。
  const dev2 = await service.createBot({
    name: 'Builder2', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  return { root, store, service, runtime, director, dev, dev2 }
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

// 驱动 tick 直到目标条件成立：任务交付级联出的 memory_review/核验运行会占住 bot 车道
// （DSHBOTS-290 同 bot 至多一条活跃运行），逐拍完成中间运行让 bot 回到空闲，挂起的
// 任务/消息才能建回。命中即停，不完成目标运行。构造与 tests/run-coalesce.test.js 同款。
async function drainUntilStarted(service, runtime, predicate, maxTicks = 8) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return true
    await service.tick()
    if (predicate()) return true
    for (const runId of [...runtime.pendingRuns.keys()]) await runtime.complete(runId)
  }
  return Boolean(predicate())
}

test('同项目写运行串行，跨项目与只读运行可并行', async () => {
  const { root, store, service, runtime, director, dev, dev2 } = await manualSetup()
  try {
    const alpha = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    const beta = await service.createProject({ name: 'Beta', key: 'BET', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    const first = await service.createTask({ projectId: alpha.id, title: 'A1', assigneeBotId: dev.id, autoStart: true })
    // A2 与 A1 同 bot 同项目：one_active_run_per_bot 下 A2 挂待处理队列（不落 runs 行），A1 结束后建回。
    const second = await service.createTask({ projectId: alpha.id, title: 'A2', assigneeBotId: dev.id, autoStart: true })
    // 跨项目并行需要异 bot 车道（DSHBOTS-290）：B1 走 dev2。
    await service.createTask({ projectId: beta.id, title: 'B1', assigneeBotId: dev2.id, autoStart: true })

    service.started = true
    await service.tick()

    // Alpha 同时只允许一个写运行；Beta 是另一个工作目录，可以并行。
    const running = runningRuns(store)
    assert.equal(running.length, 2)
    assert.equal(running.filter(run => run.project_id === alpha.id).length, 1)
    assert.equal(running.filter(run => run.project_id === beta.id).length, 1)
    assert.ok(running.every(run => run.mode === 'write'))
    assert.ok(runtime.started.some(item => item.taskId === first.id))

    // 唯一的正在运行的 Alpha 写运行结束后，挂起的第二个任务才会建回并被领取；
    // 交付级联的 memory_review 运行先消化，让 dev 车道回到空闲。
    const alphaRun = running.find(run => run.project_id === alpha.id)
    await runtime.complete(alphaRun.id)
    const drained = await drainUntilStarted(service, runtime, () =>
      runtime.started.some(item => item.taskId === second.id))
    assert.ok(drained, 'A1 结束后 A2 应建回并被领取')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status = 'running' AND mode = 'write'", alpha.id).n, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('同项目写运行：声明的写范围不重叠时并行放行', async () => {
  const { root, store, service, runtime, director, dev, dev2 } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Scopes', key: 'SCP', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    const first = await service.createTask({
      projectId: project.id, title: '改聊天模块', assigneeBotId: dev.id,
      writeScopes: ['ui/modules/chat.js'], autoStart: true,
    })
    // DSHBOTS-290：第二条走 dev2 车道，两条运行同时排队供闸门比对。
    const second = await service.createTask({
      projectId: project.id, title: '改调度模块', assigneeBotId: dev2.id,
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

test('同 Bot 任务运行与群聊回复串行（忙时挂起、空闲建回），跨 Bot 群聊不被他人任务挡住', async () => {
  const { root, store, service, runtime, director, dev, dev2 } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Mix', key: 'MIX', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    await service.createTask({ projectId: project.id, title: 'Long task', assigneeBotId: dev.id, autoStart: true })
    service.started = true
    await service.tick()
    const taskRun = runningRuns(store).find(run => run.kind === 'task')
    assert.ok(taskRun)
    assert.equal(runningRuns(store).length, 1)

    // DSHBOTS-290：dev 忙（one_active_run_per_bot）时 @Builder 的群聊回复不落 runs 行，
    // 挂待处理队列；同一条消息里空闲 bot（Builder2）的 @ 照常落行调度。
    await service.sendMessage(project.id, '@Builder @Builder2 顺便回复一句')
    const heldForDev = JSON.parse(store.setting(`bot_pending_msgs:${dev.id}`) ?? '[]')
    assert.equal(heldForDev.length, 1, '忙 bot 的群聊消息应挂待处理队列')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM runs WHERE kind = 'chat' AND bot_id = ?", dev.id).n,
      0,
      '挂起期间不得为忙 bot 建群聊运行',
    )

    await service.tick()
    const otherChat = runningRuns(store).find(run => run.kind === 'chat' && run.bot_id === dev2.id)
    assert.ok(otherChat, '空闲 bot 的群聊回复在他人任务运行期间照常被调度')
    assert.equal(service.claimKey(otherChat), `bot:${dev2.id}`, '串行键已收敛到 bot（DSHBOTS-289）')
    assert.ok(runningRuns(store).some(run => run.id === taskRun.id), '任务运行不被群聊回复打断')

    // 任务结束（消化交付级联的 memory_review 等）后，挂起的群聊建回执行。
    await runtime.complete(taskRun.id)
    const drained = await drainUntilStarted(service, runtime, () =>
      Boolean(store.get("SELECT * FROM runs WHERE kind = 'chat' AND bot_id = ? AND status = 'running'", dev.id)))
    assert.ok(drained, 'bot 空闲后挂起的群聊回复应建回执行')
    const chatRun = runningRuns(store).find(run => run.kind === 'chat' && run.bot_id === dev.id)
    assert.equal(chatRun.bot_id, dev.id)
    assert.equal(service.claimKey(chatRun), `bot:${dev.id}`)
    assert.deepEqual(JSON.parse(store.setting(`bot_pending_msgs:${dev.id}`) ?? '[]'), [], '建回后挂起队列清空')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('出队顺序按任务优先级，紧急任务不被积压拖死', async () => {
  const { root, store, service, runtime, director, dev, dev2 } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Prio', key: 'PRI', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    // 同项目只有一个写运行槽位：先入队的低优先级任务不应挡住后入队的紧急任务。
    // DSHBOTS-290：领取顺序的比对需要两条运行同时排队，两条任务分属 dev/dev2 车道。
    const backlog = await service.createTask({ projectId: project.id, title: 'Backlog', priority: 'low', assigneeBotId: dev.id, autoStart: true })
    const urgent = await service.createTask({ projectId: project.id, title: 'Hotfix', priority: 'urgent', assigneeBotId: dev2.id, autoStart: true })

    service.started = true
    await service.tick()

    const running = runningRuns(store).filter(run => run.kind === 'task')
    assert.equal(running.length, 1)
    assert.equal(running[0].task_id, urgent.id, '紧急任务应先于更早入队的低优先级任务领取')

    // 紧急任务结束后，低优先级任务照旧被执行，队列不饿死
    // （先消化交付级联的 memory_review/核验运行，再驱动下一拍）。
    await runtime.complete(running[0].id)
    const drained = await drainUntilStarted(service, runtime, () =>
      runtime.started.some(item => item.taskId === backlog.id))
    assert.ok(drained, '紧急任务结束后低优先级任务应被领取')
    const next = runningRuns(store).filter(run => run.kind === 'task')
    assert.equal(next.length, 1)
    assert.notEqual(next[0].task_id, urgent.id)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('运行中的任务会把新评论直通到执行会话', async () => {
  const { root, store, service, runtime, director, dev } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Steer', key: 'STR', ownerBotId: director.id, memberIds: [dev.id] })
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
      // DSHBOTS-285：车道唯一索引已退役，project 车道行可共存（历史/过渡态），不再被拒
      store.run(
        'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?,?,?,?,?,?)',
        's4', 'b1', 'p1', 'project', null, now,
      )
      // 收敛不变量：迁移已把旧 project 活跃行转为该 bot 的控制面绑定，每 bot 恰一条 kind='bot' 活跃绑定
      assert.equal(store.get('SELECT kind FROM session_bindings WHERE session_id = ?', 's1').kind, 'bot')
      assert.throws(() => store.run(
        "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias) VALUES (?,?,?,?,?,?,0)",
        's5', 'b1', 'p1', 'bot', null, now,
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
      logger: { warn() {}, error() {} } as DshLogger,
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
    assert.equal((runtime.pending.get('root') as { texts: unknown[] }).texts.length, 0)
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
    const runtime = new DshRuntime({ ctx: {}, config: { workspace: join(root, 'workspace') }, store, logger: { warn() {} } as DshLogger })

    const taskPrompt = runtime.systemPromptFor({ agent: { id: 'sess-task' } })
    assert.match(taskPrompt, /executing one assigned task/)
    assert.match(taskPrompt, /DEMO-7: 实现对账页/)
    assert.doesNotMatch(taskPrompt, /team_assign_task/)
    assert.doesNotMatch(taskPrompt, /Triage requests/)
    assert.doesNotMatch(taskPrompt, /Long-term memory/)

    const chatPrompt = runtime.systemPromptFor({ agent: { id: 'sess-project' } })
    assert.match(chatPrompt, /Triage requests/)
    assert.match(chatPrompt, /team_assign_task/)
    assert.doesNotMatch(chatPrompt, /Long-term memory/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('system 区会话级冻结，记忆块走 runtime context 尾部快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-freeze-'))
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
       VALUES ('t1', 'p1', 7, '旧标题', 'in_progress', 'medium', 'user', 'u1', ?, ?)`, now, now,
    )
    store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id, created_at, updated_at)
       VALUES ('t2', 'p1', 8, '另一个任务', 'in_progress', 'medium', 'user', 'u1', ?, ?)`, now, now,
    )
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?,?,?,?,?,?)`,
      'sess-a', 'b1', 'p1', 'task', 't1', now,
    )
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?,?,?,?,?,?)`,
      'sess-b', 'b1', 'p1', 'task', 't2', now,
    )
    const runtime = new DshRuntime({ ctx: {}, config: { workspace: join(root, 'workspace') }, store, logger: { warn() {} } as DshLogger })

    const first = runtime.systemPromptFor({ agent: { id: 'sess-a' } })
    assert.match(first, /旧标题/)
    assert.doesNotMatch(first, /Long-term memory/)

    // 中途改任务标题 + 落一条新记忆：system 区字节不变（冻结），新记忆经 context 通道可见
    store.run("UPDATE tasks SET title = '新标题' WHERE id = 't1'")
    store.run(
      `INSERT INTO memories(scope_type, scope_id, topic, content, status, created_by, created_at, updated_at)
       VALUES ('project', 'p1', '中途', '会话中途落库的记忆', 'active', 'user:user_local', ?, ?)`, now, now,
    )
    const frozen = runtime.systemPromptFor({ agent: { id: 'sess-a' } })
    assert.equal(frozen, first, '同 session 二次求值应逐字节相同')
    const memoryContext = runtime.memoryContextFor({ agent: { id: 'sess-a' } })
    assert.match(memoryContext, /Long-term memory/)
    assert.match(memoryContext, /会话中途落库的记忆/, '新记忆对进行中会话仍可见（尾部快照通道）')

    // 新 session 不复用旧冻结
    const other = runtime.systemPromptFor({ agent: { id: 'sess-b' } })
    assert.notEqual(other, first)
    assert.match(other, /另一个任务/)

    // 未绑定会话返回空且不冻结空值：绑定落库后的首次非空求值可正常定格
    assert.equal(runtime.systemPromptFor({ agent: { id: 'sess-late' } }), '')
    assert.equal(runtime.promptFreeze.has('sess-late'), false, '空结果不得进冻结缓存')
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?,?,?,?,?)`,
      'sess-late', 'b1', 'p1', 'project', now,
    )
    const late = runtime.systemPromptFor({ agent: { id: 'sess-late' } })
    assert.match(late, /# Team bot identity/, '绑定后首次非空求值应正常返回')
    assert.equal(runtime.promptFreeze.get('sess-late'), late)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

// DSHBOTS-300 守门：busy 闸是先查后插，多进程共享 team.sqlite 时两进程可同拍过检后
// 各自 INSERT，后者撞 one_active_run_per_bot 直抛——outbox 计为投递失败重试耗尽置
// failed。单进程可测等价：预插同 bot queued 运行（对端落行）后把 botBusy 桩成 false
// （模拟竞态窗），断言 enqueueTaskRun/enqueueOwnerTaskRun 不抛错、落挂起队列、
// bot 空闲后 drainPendingMessages 建回运行。
test('查后插竞态撞 one_active_run_per_bot：task/owner_task 入队落挂起队列不抛错，空闲建回', async () => {
  const { root, store, service, director, dev } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Race', key: 'RCE', ownerBotId: director.id, memberIds: [dev.id] })
    // 两个任务分道：task 走 enqueueTaskRun、owner 验收走 enqueueOwnerTaskRun——同 task_id
    // 会互撞 one_active_run_per_task，建回断言需要两条互不冲突的运行。
    const task = await service.createTask({ projectId: project.id, title: 'R1 竞态任务', assigneeBotId: dev.id })
    const reviewTask = await service.createTask({ projectId: project.id, title: 'R2 待验收任务', assigneeBotId: dev.id })
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at)
       VALUES ('run_race_dev', ?, ?, 'chat', 'read', 'mention', 'race-peer-1', 'queued', 1, 'race:dev', ?)`,
      project.id, dev.id, now,
    )
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at)
       VALUES ('run_race_owner', ?, ?, 'chat', 'read', 'mention', 'race-peer-2', 'queued', 1, 'race:owner', ?)`,
      project.id, director.id, now,
    )
    // 模拟对端进程在「本进程 busy 过检之后、INSERT 之前」落行：busy 检查桩成 false。
    const realBusy = service.botBusy.bind(service)
    service.botBusy = () => false
    const taskRunId = service.enqueueTaskRun(task, 'task_created', { type: 'system', id: 'system' })
    const ownerRunId = service.enqueueOwnerTaskRun(reviewTask, 'review')
    service.botBusy = realBusy
    assert.equal(taskRunId, null, 'task_run 撞 UNIQUE 返 null 不抛错')
    assert.equal(ownerRunId, null, 'owner_task_run 同款兜底')
    const devHeld = JSON.parse(store.setting(`bot_pending_msgs:${dev.id}`) ?? '[]')
    assert.equal(devHeld.at(-1)?.kind, 'task', '任务挂起项入队')
    const ownerHeld = JSON.parse(store.setting(`bot_pending_msgs:${director.id}`) ?? '[]')
    assert.ok(ownerHeld.some(item => item.kind === 'owner_task'), 'owner 任务挂起项入队')

    // 对端运行结束，bot 空闲：挂起项建回运行。
    store.run("UPDATE runs SET status = 'canceled', ended_at = ? WHERE id IN ('run_race_dev', 'run_race_owner')", now)
    service.drainPendingMessages()
    assert.ok(store.get("SELECT id FROM runs WHERE kind = 'task' AND task_id = ? AND status = 'queued'", task.id), '挂起任务建回运行')
    assert.ok(store.get("SELECT id FROM runs WHERE kind = 'review' AND task_id = ? AND status = 'queued'", reviewTask.id), '挂起 owner 验收建回运行')
    assert.equal(JSON.parse(store.setting(`bot_pending_msgs:${dev.id}`) ?? '[]').length, 0, 'dev 挂起队列清空')
    assert.equal(JSON.parse(store.setting(`bot_pending_msgs:${director.id}`) ?? '[]').length, 0, 'owner 挂起队列清空')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
