// DSHBOTS-294 守门①：子代理账本——模拟宿主事件（tools 瀑布 + subagent 生命周期）
// 断言 subagent_spawned/subagent_result 含任务号标签落入所属 task 运行的 run_events；
// 根级注册面与 cordis dispatch 可达性用真 cordis+dsh-scope 运行实测（D-292 限制③）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
const execFile = promisify(execFileCb)
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { installSubagentLedger, taskLabelOf } from '../src/subagent-ledger.js'

// 宿主 cordis 瀑布流语义复刻（与 tests/questions.test.ts 同款）：监听器按注册先后排队，
// waterfall 逐个 shift，先到的监听器不调用 next() 就截断后续链路。
class FakeCordisCtx {
  declare hooks: Map<string, any[]>
  constructor() { this.hooks = new Map() }
  on(name, listener) {
    const list = this.hooks.get(name) ?? []
    this.hooks.set(name, list)
    list.push(listener)
    return () => { const i = list.indexOf(listener); if (i >= 0) list.splice(i, 1) }
  }
  emit(name, ...args) {
    for (const listener of [...(this.hooks.get(name) ?? [])]) listener(...args)
  }
  async waterfall(name, req, inner) {
    const cbs = (this.hooks.get(name) ?? []).map(l => l)
    const next = () => {
      const cb = cbs.shift() ?? inner
      return cb(req, () => next())
    }
    return next()
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subledger-'))
  const store = openDatabase(join(root, 'team.db'))
  const ctx = new FakeCordisCtx()
  const dispose = installSubagentLedger(ctx, store, { info() {}, warn() {}, error() {} })
  const seed = () => {
    store.run("INSERT INTO bots(id, name, role, instructions, color, file_policy, status, current_revision, created_at, updated_at) VALUES ('b1', 'worker', '', '', 'blue', 'workspace-write', 'active', 0, ?, ?)", new Date().toISOString(), new Date().toISOString())
    store.run("INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES ('ctrl-1', 'b1', NULL, 'bot', NULL, ?)", new Date().toISOString())
    store.run("INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, session_id, queued_at, started_at) VALUES ('run-1', NULL, 'b1', 'task', 'agent', 'task', 'DSHBOTS-294', 'running', 1, 'idem-ledger-1', 'ctrl-1', ?, ?)", new Date().toISOString(), new Date().toISOString())
  }
  seed()
  return { root, store, ctx, dispose }
}

const events = (store, runId) => store.all(
  'SELECT type, message FROM run_events WHERE run_id = ? ORDER BY created_at, rowid', runId,
)

test('subagent_spawned/subagent_result 落 run_events 且含任务号标签', async () => {
  const { root, store, ctx, dispose } = await setup()
  try {
    await ctx.waterfall('tools/pre-execute', {
      name: 'subagent',
      callId: 'call-1',
      arguments: { description: 'DSHBOTS-294 子代理账本接线', prompt: 'do the ledger wiring' },
      agent: { session: { id: 'ctrl-1' } },
    }, async () => ({ allowed: true }))

    ctx.emit('subagent/end', { runId: 'r1', id: 'child-9', stopReason: 'end_turn', lastAssistantMessage: 'ledger wired' })
    ctx.emit('tools/result', {
      name: 'subagent',
      callId: 'call-1',
      arguments: {},
      agent: { session: { id: 'ctrl-1' } },
    }, { value: { sessionId: 'child-9', summary: 'done' } })

    const rows = events(store, 'run-1')
    const spawned = rows.filter(r => r.type === 'subagent_spawned')
    const result = rows.filter(r => r.type === 'subagent_result')
    assert.equal(spawned.length, 1)
    assert.ok(spawned[0].message.includes('DSHBOTS-294'), spawned[0].message)
    assert.ok(result.length >= 1)
    assert.ok(result.some(r => r.message.includes('DSHBOTS-294')), JSON.stringify(result))
    // 终态摘要源：stopReason 与末条产出截断进入 subagent_result
    assert.ok(result.some(r => r.message.includes('end_turn') && r.message.includes('ledger wired')), JSON.stringify(result))
    // 子代理不占 runs 行
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs').n, 1)
  } finally {
    dispose()
    store.close?.()
    await rm(root, { recursive: true, force: true })
  }
})

test('无所属 task 运行或非 subagent 工具不落账', async () => {
  const { root, store, ctx, dispose } = await setup()
  try {
    await ctx.waterfall('tools/pre-execute', {
      name: 'bash', callId: 'call-2', arguments: { command: 'ls' }, agent: { session: { id: 'ctrl-1' } },
    }, async () => ({ allowed: true }))
    await ctx.waterfall('tools/pre-execute', {
      name: 'subagent', callId: 'call-3', arguments: { description: 'DSHBOTS-000 x' },
      agent: { session: { id: 'unbound-session' } },
    }, async () => ({ allowed: true }))
    assert.equal(store.get('SELECT COUNT(*) AS n FROM run_events').n, 0)
  } finally {
    dispose()
    store.close?.()
    await rm(root, { recursive: true, force: true })
  }
})

// DSHBOTS-353 落账回退：owner bot 无 kind='task' running 时，subagent 派单账回退记到
// 该 bot 任意 kind 的 running 运行（总监验收链的核验子代理挂在 review 运行上）。
test('DSHBOTS-353 回退：无 task 运行时账落 owner bot 的 running review 运行', async () => {
  const { root, store, ctx, dispose } = await setup()
  try {
    const now = new Date().toISOString()
    store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = 'run-1'", now)
    store.run("INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, session_id, queued_at, started_at) VALUES ('run-rev', NULL, 'b1', 'review', 'read', 'review_delegate', 'GATE-9', 'running', 1, 'idem-ledger-rev', 'ctrl-1', ?, ?)", now, now)
    await ctx.waterfall('tools/pre-execute', {
      name: 'subagent',
      callId: 'call-rev',
      arguments: { description: 'GATE-9 验收核验', prompt: 'verify the delivery' },
      agent: { session: { id: 'ctrl-1' } },
    }, async () => ({ allowed: true }))
    const spawned = events(store, 'run-rev').filter(r => r.type === 'subagent_spawned')
    assert.equal(spawned.length, 1, '核验子代理账目应回退落到 review 运行')
    assert.ok(spawned[0].message.includes('GATE-9'), spawned[0].message)
  } finally {
    dispose()
    store.close?.()
    await rm(root, { recursive: true, force: true })
  }
})

// kind='task' 优先（D-294 施工账语义）：task 与 review 运行并存时仍记 task 运行。
test('DSHBOTS-353 优先级：task 与 review 运行并存时账仍记 kind=\'task\'', async () => {
  const { root, store, ctx, dispose } = await setup()
  try {
    const now = new Date().toISOString()
    store.run("INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, session_id, queued_at, started_at) VALUES ('run-rev2', NULL, 'b1', 'review', 'read', 'review_delegate', 'GATE-9', 'running', 1, 'idem-ledger-rev2', 'ctrl-1', ?, ?)", now, now)
    await ctx.waterfall('tools/pre-execute', {
      name: 'subagent',
      callId: 'call-pri',
      arguments: { description: 'GATE-9 并存优先级', prompt: 'check priority' },
      agent: { session: { id: 'ctrl-1' } },
    }, async () => ({ allowed: true }))
    assert.equal(events(store, 'run-1').filter(r => r.type === 'subagent_spawned').length, 1, 'task 运行优先承接账目')
    assert.equal(events(store, 'run-rev2').filter(r => r.type === 'subagent_spawned').length, 0, 'review 运行不抢 task 运行的账')
  } finally {
    dispose()
    store.close?.()
    await rm(root, { recursive: true, force: true })
  }
})

test('taskLabelOf 优先任务号形态，缺省回退截断描述', () => {
  assert.equal(taskLabelOf({ description: 'DSHBOTS-294 子代理账本' }), 'DSHBOTS-294')
  assert.equal(taskLabelOf({ prompt: 'implement ALPHA-12 wiring' }), 'ALPHA-12')
  assert.equal(taskLabelOf({ description: 'plain description without task number' }), 'plain description without task number'.slice(0, 60))
  assert.equal(taskLabelOf({}), null)
})

// D-292 限制③运行实测：真 cordis + 真 dsh-scope 子 scope 发射，插件根 ctx（untagged）
// 监听可达 emit 与 waterfall。子进程执行探针，避免宿主 Context 句柄吊住测试进程。
test('根级注册面与 cordis dispatch 可达性（真 cordis+dsh-scope 探针）', async () => {
  const { stdout } = await execFile(process.execPath,
    [join(import.meta.dirname, 'fixtures', 'scope-reach-probe.mjs')], { encoding: 'utf8' })
  const line = stdout.trim().split('\n').pop()
  if (line?.startsWith('SKIP')) return
  assert.equal(line, 'RESULT emit=true waterfall=true', '根级监听应可达 emit 与 waterfall 两条派发面')
})
