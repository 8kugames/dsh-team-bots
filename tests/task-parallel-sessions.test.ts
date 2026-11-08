// tests/task-parallel-sessions.test.ts —— 单 bot 多任务并行守门：
//  ① 派单即建运行：同 bot 两张卡（写范围不重叠）同时 queued，领取后两条并行 running
//     （claimKey 按任务维度，不再被 bot 串行域互斥）；
//  ② 任务专属会话：两条运行的会话各自独立，绑定行 kind='task' 带 task_id，
//     会话标题命名 `${bot.name} · ${project.key}-${task.number}`；
//  ③ 同任务幂等：重复入队返回既有 active 运行（one_active_run_per_task 口径）；
//  ④ 写安全不降级：写范围重叠的两张卡仍被写闸门串行（一张 running 一张留 queued）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { sessionMethods } from '../src/services/runtime/session.js'

const renames = []

class StubRuntime {
  declare store: any
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) {
    this.store.run('UPDATE runs SET session_id = ?, started_at = ?, last_progress_at = ? WHERE id = ?',
      `sess_${run.id}`, new Date().toISOString(), new Date().toISOString(), run.id)
    if (run.task_id) {
      this.store.run(
        `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias)
         VALUES (?, ?, ?, 'task', ?, ?, 0) ON CONFLICT(session_id) DO NOTHING`,
        `sess_${run.id}`, run.bot_id, run.project_id, run.task_id, new Date().toISOString(),
      )
      renames.push(run)
    }
    return `sess_${run.id}`
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-parallel-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new StubRuntime()
  runtime.store = store
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const devView = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const projectView = await service.createProject({ name: 'Order', key: 'ORD', ownerBotId: director.id, memberIds: [devView.id] })
  const dev = store.get('SELECT * FROM bots WHERE id = ?', devView.id)
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, director, dev, project, close }
}

test('单 bot 多任务并行：两张不重叠卡同时 running，任务专属会话独立且 kind=task', async () => {
  const t = await setup()
  try {
    const actor = { type: 'bot', id: t.director.id }
    const cardA = await t.service.createTask({ projectId: t.project.id, title: '卡A', assigneeBotId: t.dev.id, writeScopes: ['src/a/'], postCard: false }, actor)
    const cardB = await t.service.createTask({ projectId: t.project.id, title: '卡B', assigneeBotId: t.dev.id, writeScopes: ['src/b/'], postCard: false }, actor)
    const runA = t.service.enqueueTaskRun(t.service.taskRow(cardA.id), 'task_started', actor)
    const runB = t.service.enqueueTaskRun(t.service.taskRow(cardB.id), 'task_started', actor)
    assert.ok(runA && runB, '派单即建运行（不挂待处理队列）')
    await t.service.tick()
    const a = t.store.get('SELECT * FROM runs WHERE id = ?', runA)
    const b = t.store.get('SELECT * FROM runs WHERE id = ?', runB)
    assert.equal(a.status, 'running', '卡A 在跑')
    assert.equal(b.status, 'running', '卡B 同时在跑（同 bot 并行）')
    assert.notEqual(a.session_id, b.session_id, '两卡各自独立会话')
    for (const run of [a, b]) {
      const binding = t.store.get('SELECT * FROM session_bindings WHERE session_id = ?', run.session_id)
      assert.ok(binding, '任务会话有绑定行')
      assert.equal(binding.kind, 'task')
      assert.equal(binding.task_id, run.task_id)
    }
    // bot 已有两条在跑仍照派不挂起：第三张卡入队即返回运行 id。
    const cardC = await t.service.createTask({ projectId: t.project.id, title: '卡C', assigneeBotId: t.dev.id, writeScopes: ['src/c/'], postCard: false }, actor)
    const runC = t.service.enqueueTaskRun(t.service.taskRow(cardC.id), 'task_started', actor)
    assert.ok(runC, 'bot 忙时派单照建运行（不挂待处理队列）')
    // 同任务幂等：重复入队合并返回既有 active 运行。
    assert.equal(t.service.enqueueTaskRun(t.service.taskRow(cardA.id), 'task_started', actor), runA, '同任务重复入队返回既有运行')
  } finally { await t.close() }
})

test('写安全不降级：写范围重叠的两张卡仍串行', async () => {
  const t = await setup()
  try {
    const actor = { type: 'bot', id: t.director.id }
    const cardA = await t.service.createTask({ projectId: t.project.id, title: '重叠A', assigneeBotId: t.dev.id, writeScopes: ['src/shared/'], postCard: false }, actor)
    const cardB = await t.service.createTask({ projectId: t.project.id, title: '重叠B', assigneeBotId: t.dev.id, writeScopes: ['src/shared/x.js'], postCard: false }, actor)
    const runA = t.service.enqueueTaskRun(t.service.taskRow(cardA.id), 'task_started', actor)
    const runB = t.service.enqueueTaskRun(t.service.taskRow(cardB.id), 'task_started', actor)
    await t.service.tick()
    const statuses = t.store.all("SELECT id, status FROM runs WHERE id IN (?, ?)", runA, runB)
    const running = statuses.filter(row => row.status === 'running')
    const queued = statuses.filter(row => row.status === 'queued')
    assert.equal(running.length, 1, '写范围重叠只放行一条')
    assert.equal(queued.length, 1, '另一条留队待写锁释放')
  } finally { await t.close() }
})

test('源码锚：任务专属会话命名口径与串行豁免', () => {
  const sessionSource = readFileSync(fileURLToPath(new URL('../src/services/runtime/session.ts', import.meta.url)), 'utf8')
  assert.match(sessionSource, /`\$\{bot\.name\} · \$\{project\.key\}-\$\{task\.number\}`/, '会话标题=bot 名+任务号')
  assert.match(sessionSource, /'task', \?, \?, 0/, '任务会话绑定行 kind=task 带 task_id')
  const schedulerSource = readFileSync(fileURLToPath(new URL('../src/services/scheduler.ts', import.meta.url)), 'utf8')
  assert.match(schedulerSource, /if \(run\.kind === 'task' && run\.task_id\) return `task:\$\{run\.task_id\}`/, 'claimKey 任务维度串行键')
  const migrationSource = readFileSync(fileURLToPath(new URL('../src/db-migrations.ts', import.meta.url)), 'utf8')
  assert.match(migrationSource, /kind <> 'task'/, 'bot 串行索引豁免任务运行')
  assert.match(
    migrationSource,
    /kind NOT IN \('task', 'session_compact', 'rollover_summary'\)/,
    '最终串行索引还豁免只读治理运行（否则 startRun 途中排入的压缩/结转摘要被 INSERT OR IGNORE 静默吞掉）',
  )
  const taskRunsSource = readFileSync(fileURLToPath(new URL('../src/services/task-runs.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(taskRunsSource, /holdPendingMessage\(task\.assignee_bot_id/, '任务入队不再挂待处理队列')
})

// 总监侧运行（review/handle，owner_task 运行族）不吃任务亲和：亲和按 assignee 归属解析，
// 会把总监的核验/受阻处置运行开进成员的任务专属会话——会话绑定属成员（ownerContextFor
// 按 session_bindings 判身份，总监专权工具 403，与 D-306 治的验收错位同款），总监话语
// 也会混进成员任务上下文。应落总监自己的 (owner,project) 控制面绑定（ensureSession ③）。
// 守门三向：①blocked 卡上 handle 运行落总监控制面，不进成员任务会话；②in_review 卡上
// review 运行同样落总监控制面；③成员自己的 task 运行照旧亲和回任务会话（不回归）。
test('总监侧 review/handle 运行不进成员任务会话，落总监控制面绑定', async () => {
  const t = await setup()
  try {
    const { store, service, director, dev, project } = t
    const rt = {
      store, config: service.config, logger: { info() {}, warn() {}, error() {} },
      sessionCreates: new Map(),
      ctx: {
        sessionController: {
          resolveAgent: async () => ({}),
          selectModel: async () => ({}),
          create: async () => { throw new Error('本测全部走既有绑定，不应新建会话') },
        },
      },
      selectModel: async () => {},
      defaultAgentPreset: async () => ({}),
      applyFilePolicy() {},
      shouldRolloverSession: () => false,
      maybeCompactSession() {},
      taskAffinityBinding: sessionMethods.taskAffinityBinding,
      ensureTaskSession: sessionMethods.ensureTaskSession,
      ensureBotBinding: sessionMethods.ensureBotBinding,
      retireBinding: sessionMethods.retireBinding,
    } as any
    const resolve = (bot, run, task) => sessionMethods.ensureSession.call(rt, bot, project, { run, task })

    const card = await service.createTask({ projectId: project.id, title: '受阻卡', assigneeBotId: dev.id, writeScopes: ['src/x/'], postCard: false }, { type: 'bot', id: director.id })
    const task = service.taskRow(card.id)
    const now = new Date().toISOString()
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, alias, created_at) VALUES ('sess-task-x', ?, ?, 'task', ?, 0, ?)",
      dev.id, project.id, task.id, now,
    )
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, alias, created_at) VALUES ('sess-owner-cp', ?, ?, 'bot', 0, ?)",
      director.id, project.id, now,
    )
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, session_id, queued_at, started_at)
       VALUES ('run_dev_work', ?, ?, ?, 'task', 'write', 'assigned', 'succeeded', 1, 'own:1', 'sess-task-x', ?, ?)`,
      project.id, dev.id, task.id, now, now,
    )

    store.run("UPDATE tasks SET status = 'blocked' WHERE id = ?", task.id)
    assert.equal(
      await resolve(director, { id: 'run_handle', kind: 'handle', bot_id: director.id }, service.taskRow(task.id)),
      'sess-owner-cp',
      'blocked 卡上的 handle 运行落总监控制面绑定，不进成员任务会话',
    )

    store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
    assert.equal(
      await resolve(director, { id: 'run_review', kind: 'review', bot_id: director.id }, service.taskRow(task.id)),
      'sess-owner-cp',
      'in_review 卡上的 review 运行落总监控制面绑定',
    )

    store.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", task.id)
    assert.equal(
      await resolve(dev, { id: 'run_rework', kind: 'task', bot_id: dev.id }, service.taskRow(task.id)),
      'sess-task-x',
      '成员自己的施工运行照旧亲和回任务会话（不回归）',
    )
  } finally { await t.close() }
})
