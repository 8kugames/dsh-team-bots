import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { handleAction } from '../src/api.js'
import { applyRetention } from '../src/usage-reconcile.js'

// 轨迹（思考过程）记账：根会话与子代理会话的事件都要落成可展示的条目。

function seedRun(store, { runId = 'r1', sessionId = 'sess-root' } = {}) {
  const now = new Date().toISOString()
  store.run(
    `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, created_at, updated_at)
     VALUES ('b1', 'Builder', '开发', '', 'blue', 'active', 0, ?, ?)`, now, now,
  )
  store.run(
    `INSERT INTO projects(id, key, name, slug, owner_bot_id, status, created_at, updated_at)
     VALUES ('p1', 'RUN', 'Run', 'run', 'b1', 'active', ?, ?)`, now, now,
  )
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
     VALUES (?, 'p1', 'b1', 'chat', 'write', 'chat_message', 'running', 1, ?, ?)`,
    runId, `key-${runId}`, now,
  )
  return sessionId
}

function makeRuntime(store) {
  const runtime = new DshRuntime({
    ctx: {},
    config: { runTimeoutMs: 60_000 },
    store,
    logger: { info() {}, warn() {}, error() {} },
  })
  runtime.pending.set('sess-root', {
    runId: 'r1', sessionId: 'sess-root', bot: { id: 'b1', provider: 'fake', model: 'model-a' },
    projectId: 'p1', started: false, texts: [], lastText: '', usageCounter: 0, tokens: 0, timeout: null,
  })
  runtime.pendingByRun.set('r1', runtime.pending.get('sess-root'))
  return runtime
}

async function withStore(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-trajectory-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  try {
    await fn(store, root)
  } finally {
    try {
      store.close()
    } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

test('会话事件被翻译成可展示的轨迹条目', async () => {
  await withStore(async (store) => {
    seedRun(store)
    const runtime = makeRuntime(store)

    await runtime.handleEvent({ id: 'sess-root' }, { type: 'turn/start', data: { turn: 1 } })
    await runtime.handleEvent({ id: 'sess-root' }, {
      type: 'assistant/message',
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: '先看日志再判断' },
            { type: 'text', text: '结论是配置缺失' },
            { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
          ],
        },
      },
    })
    await runtime.handleEvent({ id: 'sess-root' }, {
      type: 'tool/result',
      time: Date.now(),
      data: { message: { toolCallId: 'call-1', content: [{ type: 'text', text: '文件内容' }] } },
    })
    await runtime.handleEvent({ id: 'sess-root' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

    const rows = store.all('SELECT * FROM run_trajectory WHERE run_id = ? ORDER BY seq ASC', 'r1')
    assert.deepEqual(rows.map(row => row.kind), ['turn', 'thinking', 'text', 'tool_call', 'tool_result', 'end'])
    assert.equal(rows[0].title, '第 1 轮开始')
    assert.equal(rows[1].detail, '先看日志再判断')
    assert.equal(rows[2].detail, '结论是配置缺失')
    assert.equal(rows[3].title, '调用工具 read_file')
    assert.equal(rows[3].detail, '{"path":"a.txt"}')
    assert.equal(rows[4].title, '工具 read_file 返回')
    assert.equal(rows[4].detail, '文件内容')
    assert.equal(rows[5].kind, 'end')
    assert.deepEqual(rows.map(row => row.seq), [1, 2, 3, 4, 5, 6])
  })
})

test('工具调用事件与消息里的工具块只记一条', async () => {
  await withStore(async (store) => {
    seedRun(store)
    const runtime = makeRuntime(store)

    await runtime.handleEvent({ id: 'sess-root' }, {
      type: 'assistant/message',
      time: Date.now(),
      data: { message: { content: [{ type: 'tool-call', id: 'call-1', name: 'grep', arguments: '{}' }] } },
    })
    await runtime.handleEvent({ id: 'sess-root' }, {
      type: 'tool/call',
      time: Date.now(),
      data: { callId: 'call-1', name: 'grep', arguments: '{}' },
    })

    const rows = store.all('SELECT * FROM run_trajectory WHERE run_id = ? ORDER BY seq ASC', 'r1')
    assert.equal(rows.filter(row => row.kind === 'tool_call').length, 1)
  })
})

test('子代理会话的思考条目归到根运行', async () => {
  await withStore(async (store) => {
    seedRun(store)
    const runtime = makeRuntime(store)

    await runtime.handleEvent({ id: 'sess-root' }, { type: 'turn/start', data: { turn: 1 } })
    await runtime.handleEvent({ id: 'sess-child', parentSessionId: 'sess-root' }, {
      type: 'assistant/message',
      time: Date.now(),
      data: { message: { content: [{ type: 'reasoning', text: '子代理的思考' }] } },
    })

    const rows = store.all('SELECT * FROM run_trajectory WHERE run_id = ? ORDER BY seq ASC', 'r1')
    assert.deepEqual(rows.map(row => row.kind), ['turn', 'thinking'])
    assert.equal(rows[1].detail, '子代理的思考')
  })
})

test('轨迹接口按 seq 返回条目，未知运行报 NOT_FOUND', async () => {
  await withStore(async (store) => {
    seedRun(store)
    const runtime = makeRuntime(store)
    const service = new TeamService({ store, config: {}, logger: { info() {}, warn() {}, error() {} } })

    await runtime.handleEvent({ id: 'sess-root' }, { type: 'turn/start', data: { turn: 1 } })
    await runtime.handleEvent({ id: 'sess-root' }, {
      type: 'assistant/message',
      time: Date.now(),
      data: { message: { content: [{ type: 'reasoning', text: '想一想' }] } },
    })

    const view = await handleAction(service, 'run_trajectory', { runId: 'r1' })
    assert.equal(view.runId, 'r1')
    assert.deepEqual(view.entries.map(entry => entry.kind), ['turn', 'thinking'])
    assert.equal(view.entries[1].detail, '想一想')

    await assert.rejects(
      () => handleAction(service, 'run_trajectory', { runId: 'missing' }),
      error => (error as { code?: string }).code === 'NOT_FOUND',
    )
  })
})

test('轨迹条目数量与正文长度都有上限', async () => {
  await withStore(async (store) => {
    seedRun(store)
    const runtime = makeRuntime(store)

    await runtime.handleEvent({ id: 'sess-root' }, {
      type: 'assistant/message',
      time: Date.now(),
      data: { message: { content: [{ type: 'reasoning', text: 'x'.repeat(5000) }] } },
    })
    for (let i = 0; i < 320; i += 1) {
      await runtime.handleEvent({ id: 'sess-root' }, {
        type: 'assistant/message',
        time: Date.now(),
        data: { message: { content: [{ type: 'reasoning', text: `思考 ${i}` }] } },
      })
    }

    const rows = store.all('SELECT * FROM run_trajectory WHERE run_id = ? ORDER BY seq ASC', 'r1')
    assert.equal(rows.length, 300)
    assert.ok(rows[0].detail.length <= 4100)
    assert.match(rows[0].detail, /已截断/)
  })
})

test('被主动中止的运行补一条结束条目', async () => {
  await withStore(async (store) => {
    seedRun(store)
    const runtime = new DshRuntime({
      ctx: {},
      config: { runTimeoutMs: 60_000, maxRunTokens: 10 },
      store,
      logger: { info() {}, warn() {}, error() {} },
    })
    runtime.pending.set('sess-root', {
      runId: 'r1', sessionId: 'sess-root', bot: { id: 'b1', provider: 'fake', model: 'model-a' },
      projectId: 'p1', started: true, texts: [], lastText: '', usageCounter: 0, tokens: 0, timeout: null,
    })
    runtime.pendingByRun.set('r1', runtime.pending.get('sess-root'))

    await runtime.handleEvent({ id: 'sess-root' }, {
      type: 'assistant/message',
      time: Date.now(),
      data: { usage: { inputTokens: 50, outputTokens: 1 }, message: { content: [{ type: 'text', text: '超预算' }] } },
    })

    const rows = store.all('SELECT * FROM run_trajectory WHERE run_id = ? ORDER BY seq ASC', 'r1')
    assert.equal(rows.at(-1).kind, 'end')
    assert.match(rows.at(-1).title, /中止/)
  })
})

test('保留策略按运行事件期限清理轨迹', async () => {
  await withStore(async (store) => {
    seedRun(store)
    const runtime = makeRuntime(store)

    const old = Date.now() - 10 * 86_400_000
    await runtime.handleEvent({ id: 'sess-root' }, {
      type: 'assistant/message',
      time: old,
      data: { message: { content: [{ type: 'reasoning', text: '很久以前的思考' }] } },
    })
    assert.equal(store.all('SELECT * FROM run_trajectory WHERE run_id = ?', 'r1').length, 1)

    const removed = applyRetention(store, { runEventDays: 1 })
    assert.equal(removed.runTrajectory, 1)
    assert.equal(store.all('SELECT * FROM run_trajectory WHERE run_id = ?', 'r1').length, 0)
  })
})
