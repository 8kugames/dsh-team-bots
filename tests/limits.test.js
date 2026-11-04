import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

class ManualRuntime {
  constructor() {
    this.started = []
    this.steers = []
    this.cancelled = []
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  async startRun({ run }) {
    this.started.push({ runId: run.id, botId: run.bot_id, kind: run.kind, mode: run.mode })
    return `session-${run.id}`
  }

  async steer(sessionId, text) {
    this.steers.push({ sessionId, text })
    return true
  }

  async cancelRun(runId) {
    this.cancelled.push(runId)
    return true
  }

  complete(runId, status = 'succeeded', output = 'done') {
    return this.handler({ runId, status, output, error: null })
  }
}

async function setup(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-limits-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000, ...overrides,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  return { root, workspace, config, store, service, runtime, director, dev }
}

async function closeQuietly(store) {
  try {
    store.close()
  } catch {}
}

test('单运行 token 上限触发中止并把降级交给总监', async () => {
  const { root, store, service, runtime, director, dev } = await setup({ maxRunTokens: 100 })
  try {
    const project = await service.createProject({ name: 'Budget', key: 'BUD', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: 'Runaway', assigneeBotId: dev.id, autoStart: true })
    service.started = true
    await service.tick()
    const run = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task'", task.id)
    assert.equal(run.status, 'running')

    const cancelled = []
    const runtimeWithContext = new DshRuntime({
      ctx: {
        sessionController: {
          // 公开 Remote 契约：宿主内部等价 agent.cancel({kind:'user'},{keepInbox:true})。
          cancel: async payload => cancelled.push(payload),
        },
      },
      config: { runTimeoutMs: 60_000, maxRunTokens: 100, modelCacheMs: 0 },
      store,
      logger: { warn() {}, error() {} },
    })
    const completions = []
    runtimeWithContext.setCompletionHandler(result => { completions.push(result) })
    const pending = {
      runId: run.id, sessionId: 'sess', bot: { id: dev.id, provider: 'fake', model: 'model-a' },
      projectId: project.id, started: true, texts: [], lastText: '', usageCounter: 0, tokens: 0,
      aborting: false, timeout: null,
    }
    runtimeWithContext.pending.set('sess', pending)
    runtimeWithContext.pendingByRun.set(run.id, pending)

    await runtimeWithContext.handleEvent(
      { id: 'sess' },
      { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 80, outputTokens: 40 } } },
    )
    assert.equal(completions.length, 1)
    assert.equal(completions[0].status, 'failed')
    assert.equal(completions[0].error.code, 'RUN_BUDGET_EXCEEDED')
    assert.equal(cancelled.length, 1)
    assert.equal(runtimeWithContext.pending.has('sess'), false)

    // 收尾照常走 blocked → 总监处理链路
    await service.finishRun(completions[0])
    assert.equal(store.get("SELECT status FROM tasks WHERE id = ?", task.id).status, 'blocked')
    assert.ok(store.get("SELECT id FROM runs WHERE task_id = ? AND kind = 'handle'", task.id))
    assert.ok(runtime.started.some(item => item.kind === 'handle'))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('长时间没有进展的运行被看门狗回收', async () => {
  const { root, store, service, runtime, director, dev } = await setup({ stallTimeoutMs: 30_000 })
  try {
    const project = await service.createProject({ name: 'Stall', key: 'STL', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: 'Hang', assigneeBotId: dev.id, autoStart: true })
    service.started = true
    await service.tick()
    const run = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task'", task.id)
    assert.equal(run.status, 'running')

    // 伪造“很久没有事件”
    store.run('UPDATE runs SET last_progress_at = ? WHERE id = ?', new Date(Date.now() - 10 * 60_000).toISOString(), run.id)
    await service.tick()

    const reaped = store.get('SELECT * FROM runs WHERE id = ?', run.id)
    assert.equal(reaped.status, 'failed')
    assert.equal(reaped.error_code, 'RUN_STALLED')
    assert.deepEqual(runtime.cancelled, [run.id])
    assert.equal(store.get("SELECT status FROM tasks WHERE id = ?", task.id).status, 'blocked')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('提问 pending 未过期时，等待人类作答的运行不计入 stall', async () => {
  const { root, store, service, runtime, director, dev } = await setup({ stallTimeoutMs: 30_000, questionTimeoutMs: 180_000 })
  try {
    const project = await service.createProject({ name: 'Ask', key: 'ASK', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: 'Wait for human', assigneeBotId: dev.id, autoStart: true })
    service.started = true
    await service.tick()
    const run = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task'", task.id)
    assert.equal(run.status, 'running')

    // 伪造“很久没有事件”+ 一条 pending 未过期提问（用户正作答）
    store.run('UPDATE runs SET last_progress_at = ? WHERE id = ?', new Date(Date.now() - 10 * 60_000).toISOString(), run.id)
    store.run(
      `INSERT INTO questions(id, project_id, run_id, bot_id, session_id, call_id, questions, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 'pending', ?, ?)`,
      'qst_open', project.id, run.id, dev.id, JSON.stringify([{ id: 'q1', question: '方案 A 还是 B？' }]),
      new Date().toISOString(), new Date(Date.now() + 120_000).toISOString(),
    )
    await service.tick()

    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', run.id).status, 'running')
    assert.deepEqual(runtime.cancelled, [])
    assert.equal(store.get("SELECT status FROM tasks WHERE id = ?", task.id).status, 'in_progress')
    assert.equal(store.get("SELECT status FROM questions WHERE id = 'qst_open'").status, 'pending')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('提问进入终态或窗口过期后，超龄运行照常被看门狗回收', async () => {
  const { root, store, service, runtime, director, dev } = await setup({ stallTimeoutMs: 30_000, questionTimeoutMs: 180_000 })
  try {
    // 两个项目各挂一条超龄 run（同项目未声明写范围的写运行会保守串行，第二条起不了跑）：
    // A 挂已答（终态）提问、expires_at 还在未来；B 挂泄漏 pending（窗口已过）。
    const projectA = await service.createProject({ name: 'AskDone', key: 'ASD', ownerBotId: director.id, memberIds: [dev.id] })
    const projectB = await service.createProject({ name: 'AskLeak', key: 'ASL', ownerBotId: director.id, memberIds: [dev.id] })
    const taskA = await service.createTask({ projectId: projectA.id, title: 'Answered', assigneeBotId: dev.id, autoStart: true })
    const taskB = await service.createTask({ projectId: projectB.id, title: 'Leaked pending', assigneeBotId: dev.id, autoStart: true })
    service.started = true
    await service.tick()
    const runA = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task'", taskA.id)
    const runB = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task'", taskB.id)
    assert.equal(runA.status, 'running')
    assert.equal(runB.status, 'running')

    store.run('UPDATE runs SET last_progress_at = ? WHERE id IN (?, ?)',
      new Date(Date.now() - 10 * 60_000).toISOString(), runA.id, runB.id)
    store.run(
      `INSERT INTO questions(id, project_id, run_id, bot_id, session_id, call_id, questions, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 'answered', ?, ?)`,
      'qst_done', projectA.id, runA.id, dev.id, JSON.stringify([{ id: 'q1', question: '继续吗？' }]),
      new Date().toISOString(), new Date(Date.now() + 120_000).toISOString(),
    )
    store.run(
      `INSERT INTO questions(id, project_id, run_id, bot_id, session_id, call_id, questions, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 'pending', ?, ?)`,
      'qst_leak', projectB.id, runB.id, dev.id, JSON.stringify([{ id: 'q1', question: '继续吗？' }]),
      new Date(Date.now() - 5 * 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString(),
    )
    await service.tick()

    const reapedA = store.get('SELECT * FROM runs WHERE id = ?', runA.id)
    const reapedB = store.get('SELECT * FROM runs WHERE id = ?', runB.id)
    assert.equal(reapedA.status, 'failed')
    assert.equal(reapedA.error_code, 'RUN_STALLED')
    assert.equal(reapedB.status, 'failed')
    assert.equal(reapedB.error_code, 'RUN_STALLED')
    assert.deepEqual(runtime.cancelled.sort(), [runA.id, runB.id].sort())
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('群聊只放结论，完整交付留在任务评论', async () => {
  const { root, store, service, runtime, director, dev } = await setup({ chatReplyMaxChars: 120 })
  try {
    const project = await service.createProject({ name: 'Split', key: 'SPL', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: 'Long report', assigneeBotId: dev.id, autoStart: true })
    service.started = true
    await service.tick()
    const run = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task'", task.id)
    const longOutput = `${'改了三个文件并跑了测试。'.repeat(40)}`
    await runtime.complete(run.id, 'succeeded', longOutput)

    const comment = store.get("SELECT body FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", task.id)
    assert.equal(comment.body, longOutput)
    const message = store.get("SELECT body FROM messages WHERE task_id = ? AND sender_type = 'bot' ORDER BY created_at DESC LIMIT 1", task.id)
    assert.match(message.body, /任务 \S+ 已交付，待(总监)?验收。/)
    assert.match(message.body, /（完整记录见任务评论）/)
    assert.ok(message.body.length < longOutput.length / 2)
    assert.ok(message.body.includes('…'))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('team_recall 能按短 id 展开消息、评论、运行和任务', async () => {
  const { root, store, service, runtime, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Recall', key: 'RCL', ownerBotId: director.id, memberIds: [dev.id] })
    const sent = await service.sendMessage(project.id, '这是一条很长很长的消息内容，需要能按需展开')
    const task = await service.createTask({
      projectId: project.id, title: 'Recall target', description: 'Full description here.', assigneeBotId: dev.id, autoStart: true,
    })
    service.started = true
    await service.tick()
    const run = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task'", task.id)
    await runtime.complete(run.id, 'succeeded', '运行输出的完整内容')
    const comment = store.get("SELECT id FROM task_comments WHERE task_id = ? LIMIT 1", task.id)

    store.run(
      'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?,?,?,?,?,?)',
      'sess-recall', director.id, project.id, 'project', null, new Date().toISOString(),
    )

    assert.match(service.recall('sess-recall', `m_${sent.messageId.slice(-6)}`), /很长很长的消息/)
    assert.match(service.recall('sess-recall', `c_${comment.id.slice(-6)}`), /运行输出的完整内容|已交付|完整/)
    assert.match(service.recall('sess-recall', `run_${run.id.slice(-6)}`), /运行输出的完整内容/)
    assert.match(service.recall('sess-recall', 'RCL-1'), /Full description here\./)
    assert.throws(() => service.recall('sess-recall', 'NOPE-9'), /任务/)
    assert.throws(() => service.recall('unknown-session', 'RCL-1'), /不属于任何项目/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('只读运行改动了工作区会在群聊里点名', async () => {
  const { root, workspace, store, service, runtime, director } = await setup()
  try {
    const project = await service.createProject({ name: 'Audit', key: 'AUD', ownerBotId: director.id })
    const dir = join(workspace, project.slug)
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' })
    await service.sendMessage(project.id, '随便聊聊，不要改文件')
    service.started = true
    await service.tick()
    const run = store.get("SELECT * FROM runs WHERE kind = 'chat'", )
    assert.ok(run, '群聊运行应已领取')
    // 等待 executeRun 记录指纹后再制造改动
    await new Promise(resolve => setTimeout(resolve, 30))
    await writeFile(join(dir, 'sneaky.txt'), 'written by a read-only run\n')
    await runtime.complete(run.id, 'succeeded', '好的')

    const alert = store.get("SELECT body FROM messages WHERE project_id = ? AND sender_type = 'system'", project.id)
    assert.ok(alert, '应产生越权写入提示')
    assert.match(alert.body, /只读运行/)
    assert.match(alert.body, /sneaky\.txt/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('Router 与 Worker 会话按配置选择 agent preset，缺失时回退 standard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-preset-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  try {
    const presets = { list: async () => [{ id: 'standard' }, { id: 'router-lite' }, { id: 'worker-full' }] }
    const runtime = new DshRuntime({
      ctx: { get: name => (name === 'agentPresets' ? presets : undefined) },
      config: { routerPreset: 'router-lite', workerPreset: 'does-not-exist' },
      store,
      logger: { warn() {} },
    })
    assert.deepEqual(await runtime.defaultAgentPreset('project'), { agentPreset: 'router-lite' })
    assert.deepEqual(await runtime.defaultAgentPreset('task'), { agentPreset: 'standard' })
    assert.deepEqual(await runtime.defaultAgentPreset('review'), { agentPreset: 'router-lite' })

    const bare = new DshRuntime({ ctx: { get: () => undefined }, config: {}, store, logger: { warn() {} } })
    assert.deepEqual(await bare.defaultAgentPreset('task'), {})
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
