// tests/review-subagent-gate.test.ts —— DSHBOTS-318/353 验收机械闸。
// 353 起按「评审周期」查账：周期起点 T = 最近一次交付（task_events.run_succeeded）
// 或看板流转（task_events.type='status' 且 to='in_review'）的 MAX(created_at)；
// 周期内存在 subagent_spawned 账目，且账目运行归属本任务的 owner 运行
// （task_id+bot_id）或调用方会话 → 放行。两跳正规流程（review_delegate 派子代理 →
// 新运行只裁决）的账目挂在上一跳已结束运行上，旧「当运行查账」必漏（353 缺陷）。
// 守门方向 + 旁路锚：
// ① 已结束 review 运行（本任务/owner）带账 + 裁决运行 running 无账 → 放行（核心回归）；
// ② 同会话上一条已结束 chat 运行（task_id NULL）带账且在看板 in_review 之后 → 放行；
// ③ 本周期无账 → badRequest 且文案含「先派验收子代理」；
// ④ 无账但 comment 含「兜底验收」→ 放行；
// ⑤ 账挂另一任务的运行 → 拒；
// ⑥ 账挂 director 另一会话运行 → 拒；
// ⑦ 账挂成员 bot 施工运行（kind='task'）→ 拒；
// ⑧ 账时间早于最近一次交付锚点（退回重做再交付）→ 拒；
// ⑨ 非 in_review 状态仍走既有 conflict（闸不改变原状态校验顺序）；
// ⑩ applyReview 直调（微信管理员/看板路径）不经闸。
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-gate-'))
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
  const project = await service.createProject({ name: 'Gate', key: 'GATE', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-review-gate-owner'
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

// 建卡并清掉自动施工运行（不动状态），返回最新任务行。
async function bareTask(t, title, scopes) {
  const task = await t.service.assignFromBot(t.sessionId, {
    assignee: 'Builder', title, description: '正常实施。', write_scopes: scopes,
  })
  for (const run of t.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)) {
    await t.service.cancelRunInternal(run.id, false)
  }
  return t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
}

// 固定时钟：锚点与账目时间全部显式指定，避免真实时钟竞态。
const T0 = '2026-11-13T03:00:00.000Z'
const at = (offsetMs) => new Date(new Date(T0).getTime() + offsetMs).toISOString()

// 交付锚点（交付路径）：直插 run_succeeded 事件 + 直改 in_review，复刻 run-finish
// 同事务写入的事件形态（data: {runId, identifier}）。
function deliverAt(t, task, when) {
  t.store.run(
    'INSERT INTO task_events(id, task_id, type, actor_type, actor_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    `evt-deliver-${task.id}-${when}`, task.id, 'run_succeeded', 'bot', t.director.id,
    JSON.stringify({ runId: `run-deliver-${task.id}`, identifier: `GATE-${task.number}` }), when,
  )
  t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
}

// 种一条运行；ledgerAt 给定则同时落 subagent_spawned 账目。
function seedRun(t: {
  store: { run: (sql: string, ...params: unknown[]) => unknown }
  project: { id: string }
  director: { id: string }
}, {
  id, kind = 'review', status = 'succeeded', taskId = null, sessionId = null, botId, ledgerAt,
}: {
  id: string
  kind?: string
  status?: string
  taskId?: string | null
  sessionId?: string | null
  botId?: string
  ledgerAt?: string
}) {
  const now = new Date().toISOString()
  t.store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
       attempt, idempotency_key, session_id, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, 'read', 'review_delegate', ?, ?, 1, ?, ?, ?, ?, ?)`,
    id, t.project.id, botId ?? t.director.id, taskId, kind, taskId ?? 'chat', status, `idem-${id}`,
    sessionId, now, now, status === 'succeeded' ? now : null,
  )
  if (ledgerAt) {
    t.store.run(
      "INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, 'subagent_spawned', ?, ?)",
      `evt-${id}`, id, 'GATE 核验子代理 spawned', ledgerAt,
    )
  }
  return id
}

test('① 已结束 review 运行（本任务/owner）带账 + 裁决运行 running 无账 → 放行（353 核心回归）', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t, '实施卡', ['src/a.js'])
    deliverAt(t, task, T0)
    // 第一跳：review_delegate 运行（kind='review'/本任务/owner）已结束且带账。
    seedRun(t, { id: 'run-hop1', kind: 'review', taskId: task.id, sessionId: t.sessionId, status: 'succeeded', ledgerAt: at(60_000) })
    // 第二跳：裁决运行 running、无账——旧「当运行查账」在此必拦。
    seedRun(t, { id: 'run-verdict', kind: 'review', taskId: task.id, sessionId: t.sessionId, status: 'running' })
    const done = await t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept', comment: '核验通过：范围一致、目标测试绿' })
    assert.equal(done.status, 'done')
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'done')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('② 同会话已结束 chat 运行（task_id NULL）带账且在看板 in_review 之后 → 放行', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t, '看板流转卡', ['src/board.js'])
    // 看板路径锚点：真实 updateTask 写 status→in_review 事件（校验 json_extract 口径）。
    t.store.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", task.id)
    await t.service.updateTask(task.id, { status: 'in_review' }, { type: 'bot', id: t.director.id })
    seedRun(t, { id: 'run-chat', kind: 'chat', taskId: null, sessionId: t.sessionId, status: 'succeeded', ledgerAt: new Date().toISOString() })
    const done = await t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept', comment: '子代理核验：范围一致' })
    assert.equal(done.status, 'done')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('③ 本周期无账 → badRequest 且文案含「先派验收子代理」', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t, '实施卡', ['src/b.js'])
    deliverAt(t, task, T0)
    seedRun(t, { id: 'run-verdict', kind: 'review', taskId: task.id, sessionId: t.sessionId, status: 'running' })
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept', comment: '看起来没问题' }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 400, 'badRequest 同款错误链')
        assert.match(error.message, /本次评审没有子代理账目/)
        assert.match(error.message, /先派验收子代理（subagent\/subagent_fork）做范围比对\/目标测试\/红线预测/)
        assert.match(error.message, /兜底验收/)
        return true
      },
    )
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'in_review', '拒绝不翻转任务状态')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('④ 无账但 comment 含「兜底验收」→ 放行', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t, '实施卡', ['src/c.js'])
    deliverAt(t, task, T0)
    const done = await t.service.reviewFromBot(t.sessionId, {
      task: 'GATE-1', decision: 'accept', comment: '兜底验收：子代理两次失败，亲自复核目标测试全绿',
    })
    assert.equal(done.status, 'done')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('⑤ 账挂另一任务的运行 → 拒', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t, '本任务', ['src/d.js'])
    deliverAt(t, task, T0)
    const other = await bareTask(t, '另一任务', ['src/e.js'])
    seedRun(t, { id: 'run-other-task', kind: 'review', taskId: other.id, sessionId: null, status: 'succeeded', ledgerAt: at(60_000) })
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept', comment: '核验通过' }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /本次评审没有子代理账目/)
        return true
      },
    )
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('⑥ 账挂 director 另一会话运行 → 拒', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t, '实施卡', ['src/f.js'])
    deliverAt(t, task, T0)
    seedRun(t, { id: 'run-other-session', kind: 'chat', taskId: null, sessionId: 'sess-review-gate-other', status: 'succeeded', ledgerAt: at(60_000) })
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept', comment: '核验通过' }),
      (error: { status: number }) => error.status === 400,
    )
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('⑦ 账挂成员 bot 施工运行（kind=\'task\'）→ 拒', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t, '实施卡', ['src/g.js'])
    deliverAt(t, task, T0)
    const other = await bareTask(t, '成员另一卡', ['src/h.js'])
    seedRun(t, { id: 'run-member', kind: 'task', taskId: other.id, sessionId: 'sess-builder', botId: t.dev.id, status: 'succeeded', ledgerAt: at(60_000) })
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept', comment: '核验通过' }),
      (error: { status: number }) => error.status === 400,
    )
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('⑧ 账时间早于最近一次交付锚点（退回重做再交付）→ 拒', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t, '退回重做卡', ['src/i.js'])
    // 第一周期：交付 @T0，chat 运行带账 @T0+1min → return 过闸（账在周期内）。
    deliverAt(t, task, T0)
    seedRun(t, { id: 'run-cycle1', kind: 'chat', taskId: null, sessionId: t.sessionId, status: 'succeeded', ledgerAt: at(60_000) })
    const returned = await t.service.reviewFromBot(t.sessionId, {
      task: 'GATE-1', decision: 'return', comment: '退回重做：测试覆盖不足，需要补充边界用例',
    })
    assert.equal(returned.status, 'in_progress', '第一周期账目有效，return 过闸')
    // 第二周期：重新交付锚点 @T0+5min，无新账 → 旧账（@T0+1min）落窗外，accept 拒。
    deliverAt(t, task, at(300_000))
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept', comment: '复核通过' }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /本次评审没有子代理账目/)
        return true
      },
    )
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('⑨ 非 in_review 状态仍走既有 conflict（闸不改变原状态校验顺序）', async () => {
  const t = await setup()
  try {
    // 不播种任何运行/账目：in_progress 卡必须先撞 applyReview 的状态 conflict，
    // 而不是闸的 badRequest——闸只拦真验收动作，不抢状态校验的跑。
    const task = await t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '进行中卡', description: '正常实施。', write_scopes: ['src/j.js'],
    })
    // HoldingRuntime 下卡停在开工态（todo/in_progress 均非 in_review，可验冲突路径）。
    const before = t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status
    assert.notEqual(before, 'in_review')
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept' }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 409, 'conflict 同款错误链')
        assert.match(error.message, /不在待验收状态/)
        assert.doesNotMatch(error.message, /先派验收子代理/, '状态 conflict 先于闸文案')
        return true
      },
    )
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, before, '拒绝不翻转任务状态')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('⑩ applyReview 直调（微信管理员/看板路径）不经闸', async () => {
  const t = await setup()
  try {
    const task = await bareTask(t, '实施卡', ['src/k.js'])
    deliverAt(t, task, T0)
    const fresh = t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
    const actor = { type: 'bot', id: t.director.id }
    const done = await t.service.applyReview(fresh, t.project, 'accept', '管理员验收', actor)
    assert.equal(done.status, 'done', '无账目无兜底标记仍放行：闸只在 reviewFromBot 机器人路径')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})
