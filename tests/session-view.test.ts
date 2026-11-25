// 会话查看域（session-view）守门：宿主事件日志 → 查看器条目的抽取口径
//（append 面语义、tool/call 配对、增量游标、翻旧页、runId 归属解析、错误映射）。
// 宿主 sessionQuery 用桩观察 lease 复刻（live/prepared 两种来源、Symbol.dispose 契约）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { setupTeam } from './helpers/harness.js'

// 桩运行时：ctx.sessionQuery.observeSession(sessionId) → observations 表里的假 lease。
class SessionQueryStubRuntime {
  declare ctx: any
  constructor(observations: Map<string, any>) {
    this.ctx = {
      sessionQuery: {
        observeSession: async (sessionId: string) => {
          const observation = observations.get(sessionId)
          if (!observation) {
            const error = new Error(`session "${sessionId}" not found`) as any
            error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
            throw error
          }
          return observation
        },
      },
    }
  }
  setCompletionHandler() {}
  setMask() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }: { run: { id: string } }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

function fakeObservation(events, source = 'live') {
  return {
    source,
    events,
    cursor: events.length - 1,
    header: {},
    inheritedEventCount: 0,
    [Symbol.dispose]() {},
  }
}

// 一次典型交互的事件流：管线事件、三类 append 消息、tool/call 配对、一个 replace 影子事件。
function sampleEvents() {
  const at = (i: number) => 1_760_000_000_000 + i * 1_000
  return [
    { type: 'turn/start', seq: 0, time: at(0), data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: at(1), surfaceOp: 'append', data: { role: 'user', id: 'm1', content: [{ type: 'text', text: '请修复登录' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: at(2), surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm2', content: [{ type: 'reasoning', text: '先看日志' }, { type: 'text', text: '马上处理' }], source: { kind: 'model' } } } },
    { type: 'tool/call', seq: 3, time: at(3), data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
    { type: 'tool/result', seq: 4, time: at(4), surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'tool', id: 'm3', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'exit 1' }], source: { kind: 'tool' } }, error: { name: 'bash', code: 'EXIT', reason: '命令失败' } } },
    // replace 影子事件：模型可见面的重写，人类 transcript 不展示（宿主 surface 层语义）。
    { type: 'assistant/message', seq: 5, time: at(5), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, data: { turn: 1, step: 2, message: { role: 'assistant', id: 'm4', content: [{ type: 'text', text: '重写后的回答' }], source: { kind: 'model' } } } },
  ] as any[]
}

async function setup(observations = new Map()) {
  const team = await setupTeam({
    prefix: 'dsh-session-view-',
    schedulerIntervalMs: 20,
    runtime: new SessionQueryStubRuntime(observations),
  })
  const { store, service } = team
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const worker = await service.createBot({ name: 'Worker', role: '开发', instructions: 'Build.' })
  const project = await service.createProject({ name: 'View Project', key: 'VIEW', ownerBotId: director.id, memberIds: [worker.id] })
  const task = await service.createTask({ projectId: project.id, title: '接线会话查看', assigneeBotId: worker.id })
  const ts = new Date().toISOString()
  const bind = (sessionId: string, { kind = 'task', botId = worker.id, projectId = project.id, taskId = task.id, alias = 0 }: any = {}) =>
    store.run(
      'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sessionId, botId, projectId, kind, taskId, ts, alias,
    )
  const run = (id: string, { sessionId, status = 'running', botId = worker.id, projectId = project.id }) => store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, session_id, queued_at, started_at)
     VALUES (?, ?, ?, 'task', 'manual', ?, ?, ?, ?, ?)`,
    id, projectId, botId, status, `idem-${id}`, sessionId, ts, ts,
  )
  return { ...team, director, worker, project, task, bind, run }
}

test('session_messages 尾部读取：append 消息事件抽取、tool 配对、replace 影子不展示', async () => {
  const observations = new Map([['sess-task-1', fakeObservation(sampleEvents())]])
  const { root, store, service, worker, project, task, bind, run } = await setup(observations)
  try {
    bind('sess-task-1')
    run('run-v1', { sessionId: 'sess-task-1' })

    const result = await service.sessionMessages({ sessionId: 'sess-task-1' })
    assert.equal(result.live, true)
    assert.equal(result.running, true)
    assert.equal(result.cursor, 5)
    assert.equal(result.entries.length, 3)
    assert.equal(result.hasMore, false)

    const [user, assistant, tool] = result.entries
    assert.equal(user.role, 'user')
    assert.equal(user.text, '请修复登录')
    assert.equal(user.seq, 1)
    assert.equal(assistant.role, 'assistant')
    assert.equal(assistant.text, '马上处理')
    assert.equal(assistant.reasoning, '先看日志')
    assert.equal(tool.role, 'tool')
    assert.equal(tool.toolName, 'bash')
    assert.equal(tool.toolCallId, 'c1')
    assert.equal(tool.isError, true)
    assert.ok(tool.text.includes('exit 1') && tool.text.includes('命令失败'), tool.text)
    // replace 影子（seq 5）不得出现
    assert.equal(result.entries.some(entry => entry.seq === 5), false)

    // 头部上下文：绑定行 → bot/任务标识
    assert.equal(result.context.botName, 'Worker')
    assert.equal(result.context.kind, 'task')
    assert.equal(result.context.taskIdentifier, `VIEW-${task.number}`)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('session_messages 增量与翻旧：afterSeq 正向增量、limit 截断 hasMore、beforeSeq 排他', async () => {
  const observations = new Map([['sess-task-2', fakeObservation(sampleEvents())]])
  const { root, store, service, bind } = await setup(observations)
  try {
    bind('sess-task-2')

    // 增量：afterSeq=2 之后只有 tool/result（seq 4）
    const inc = await service.sessionMessages({ sessionId: 'sess-task-2', afterSeq: 2 })
    assert.deepEqual(inc.entries.map(entry => entry.seq), [4])

    // 截断：afterSeq=0 限 1 条 → 第一条 user，hasMore=true（后面还有消息事件）
    const paged = await service.sessionMessages({ sessionId: 'sess-task-2', afterSeq: 0, limit: 1 })
    assert.deepEqual(paged.entries.map(entry => entry.seq), [1])
    assert.equal(paged.hasMore, true)

    // 翻旧：beforeSeq=4 排他 → 只剩 user/assistant（seq 1、2），正序返回
    const older = await service.sessionMessages({ sessionId: 'sess-task-2', beforeSeq: 4 })
    assert.deepEqual(older.entries.map(entry => entry.seq), [1, 2])
    assert.equal(older.hasOlder, true)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('session_messages runId 归属解析；冷会话（prepared）与非插件会话的错误映射', async () => {
  const observations = new Map([
    ['sess-task-3', fakeObservation(sampleEvents(), 'prepared')],
  ])
  const { root, store, service, bind, run } = await setup(observations)
  try {
    bind('sess-task-3')
    run('run-v3', { sessionId: 'sess-task-3' })

    // runId → run.session_id；prepared 来源 live=false
    const byRun = await service.sessionMessages({ runId: 'run-v3' })
    assert.equal(byRun.sessionId, 'sess-task-3')
    assert.equal(byRun.live, false)
    assert.equal(byRun.entries.length, 3)

    // 无归属会话的运行 → 404
    run('run-v4', { sessionId: null })
    await assert.rejects(
      () => service.sessionMessages({ runId: 'run-v4' }),
      (err: any) => err.code === 'NOT_FOUND',
    )
    // 未登记绑定（宿主用户自己的会话）→ 404，不做任意会话读取代理
    observations.set('sess-foreign', fakeObservation(sampleEvents()))
    await assert.rejects(
      () => service.sessionMessages({ sessionId: 'sess-foreign' }),
      (err: any) => err.code === 'NOT_FOUND',
    )
    // 绑定过但宿主查不到（已删除/从未落盘）→ 404
    bind('sess-gone')
    await assert.rejects(
      () => service.sessionMessages({ sessionId: 'sess-gone' }),
      (err: any) => err.code === 'NOT_FOUND',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('sessionCatalog：绑定家谱 + 运行态 + 项目域过滤；宿主无 sessionQuery 时 503', async () => {
  const observations = new Map([['sess-task-4', fakeObservation(sampleEvents())]])
  const { root, store, service, director, worker, project, task, bind, run } = await setup(observations)
  try {
    bind('sess-task-4')
    run('run-v5', { sessionId: 'sess-task-4' })
    // 结转别名行（alias=1）：仍可查历史，目录可见并带 alias 标记
    bind('sess-old', { kind: 'bot', taskId: null, alias: 1 })
    // solo 控制面绑定（project NULL）
    store.run(
      'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias) VALUES (?, ?, NULL, ?, NULL, ?, 0)',
      'sess-solo', worker.id, 'bot', new Date().toISOString(),
    )

    const global = service.sessionCatalog(null)
    assert.equal(global.sessions.length, 3)
    const taskRow = global.sessions.find(row => row.sessionId === 'sess-task-4')
    assert.equal(taskRow.running, true)
    assert.equal(taskRow.botName, 'Worker')
    assert.equal(taskRow.kind, 'task')
    assert.equal(taskRow.projectKey, 'VIEW')
    assert.equal(taskRow.taskIdentifier, `VIEW-${task.number}`)
    const aliasRow = global.sessions.find(row => row.sessionId === 'sess-old')
    assert.equal(aliasRow.alias, true)
    assert.equal(aliasRow.running, false)
    const soloRow = global.sessions.find(row => row.sessionId === 'sess-solo')
    assert.equal(soloRow.projectId, null)

    // 项目域过滤：solo 不出现，任务会话出现
    const scoped = service.sessionCatalog(project.id)
    assert.equal(scoped.sessions.some(row => row.sessionId === 'sess-solo'), false)
    assert.equal(scoped.sessions.some(row => row.sessionId === 'sess-task-4'), true)

    // 宿主无 sessionQuery（旧宿主/未装）→ DSH_UNAVAILABLE
    ;(service as any).runtime = { ctx: {} }
    await assert.rejects(
      () => service.sessionMessages({ sessionId: 'sess-task-4' }),
      (err: any) => err.code === 'DSH_UNAVAILABLE',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
