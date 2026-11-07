// tests/review-auto.test.js —— DSHBOTS-113：验收自动委派护栏。
// 任务交付迁移 in_review 的同一事务里自动派生 kind='review' 核验运行（复用 D-107 的
// spawnReviewDelegate 共享入口，手动按钮同源）；开关 autoReviewDelegate 默认开；派生
// 失败走 outbox 退避重试、上限 3 次，耗尽后失败可见（任务卡「未核验」+消息+审计），
// 任何失败都不阻塞交付迁移。owner_bot 卡串联两跳：核验→总监裁决；user 卡核验后人工裁决。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { sessionMethods } from '../src/services/runtime/session.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

// 不完结的运行时：运行停在 queued/running，供状态/幂等类用例稳定断言运行行。
class HoldRuntime {
  declare handler: (result: { runId: string; status: string; output: string; error: null }) => unknown

  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-hold' }
  async steer() { return true }
  async cancelRun() { return true }
}

// 立即成功的运行时：task 运行交付转 in_review（触发自动委派链），review 运行产出
// 「子代理核验：」结论，memory_review 产出空数组。
class AutoRuntime {
  declare handler: (result: { runId: string; status: string; output: string; error: null }) => unknown

  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run, bot, task }) {
    setImmediate(() => {
      void this.handler({
        runId: run.id,
        status: 'succeeded',
        output: run.kind === 'review'
          ? '子代理核验：建议 accept——写范围未越界，目标测试 2/2 绿。'
          : run.kind === 'memory_review'
            ? '[]'
            : `Implemented ${task?.title ?? 'it'}.`,
        error: null,
      })
    })
    return `session-${run.id}`
  }
  async cancelRun() { return true }
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timeout waiting for condition')
}

async function setup({ auto = false, autoReviewDelegate }: { auto?: boolean; autoReviewDelegate?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-rva-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(
    join(workspace, '.agents', 'skills', 'review', 'SKILL.md'),
    `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`,
  )
  // 环境变量隔离：本套件断言开关与超时默认值，外层 env 不许串扰。
  const savedAuto = process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE
  const savedTimeout = process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
  delete process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE
  delete process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20,
    ...(autoReviewDelegate === undefined ? {} : { autoReviewDelegate }),
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(auto ? new AutoRuntime() : new HoldRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const project = await service.createProject({
    name: 'AutoDelegate', key: 'ADL', ownerBotId: director.id, memberIds: [dev.id],
  })
  const promptRuntime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const actor = { type: 'user', id: service.localUserId }
  const close = async () => {
    if (auto) {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')")?.n ?? 0)
        if (active === 0) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    try { store.close() } catch {}
    if (savedAuto === undefined) delete process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE
    else process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE = savedAuto
    if (savedTimeout === undefined) delete process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
    else process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS = savedTimeout
    await rm(root, { recursive: true, force: true })
  }
  return { root, store, service, director, dev, project, promptRuntime, actor, close }
}

// 造一张执行中的卡并跑完一次交付：actor 决定 review_target（bot→owner_bot，user→user）。
async function deliverTask(t, { actor }: { actor?: Actor } = {}) {
  const task = await t.service.createTask({
    projectId: t.project.id, title: '交付登录页', assigneeBotId: t.dev.id,
    status: 'in_progress', postCard: false,
  }, actor ?? { type: 'bot', id: t.director.id })
  const runId = t.service.enqueueTaskRun(task, 'task_started', { type: 'bot', id: t.dev.id })
  // DSHBOTS-311 夹具适配：施工交付过闸须有子代理账目——本助手代表「合规施工」路径。
  t.store.run(
    "INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, 'subagent_spawned', '夹具：已开子代理施工', ?)",
    `evt_fixture_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, runId, new Date().toISOString(),
  )
  void t.service.tick()
  return waitFor(() => t.store.get("SELECT * FROM tasks WHERE id = ? AND status = 'in_review'", task.id))
}

function runRow(t, where, ...args) {
  return t.store.get(`SELECT * FROM runs WHERE ${where}`, ...args)
}

test('交付迁移 in_review 自动派生核验运行：同入口形态、留痕、不阻塞迁移', async () => {
  const t = await setup({ auto: true })
  try {
    const task = await deliverTask(t)
    // 迁移未被阻塞：任务确实进了 in_review，且交付评论落库。
    assert.equal(task.status, 'in_review')
    assert.ok(t.store.get('SELECT id FROM task_comments WHERE task_id = ? AND author_type = ?', task.id, 'bot'))
    // 自动派生：与手动同一 spawnReviewDelegate 入口的运行形态。
    const delegate = await waitFor(() => runRow(
      t, "task_id = ? AND kind = 'review' AND trigger_type = 'review_delegate'", task.id,
    ))
    assert.equal(delegate.mode, 'read', '核验运行只读')
    assert.equal(delegate.bot_id, t.director.id, '核验运行绑总监')
    assert.equal(delegate.write_scopes, null, '核验运行写范围为空')
    // 留痕：run_events 标注自动来源，审计 review.auto_delegate。
    const event = t.store.get("SELECT * FROM run_events WHERE run_id = ? AND type = 'queued'", delegate.id)
    assert.match(event.message, /交付后自动委派子代理核验（system:system）/)
    assert.ok(
      t.store.get("SELECT id FROM audit_log WHERE action = 'review.auto_delegate' AND target_id = ?", task.id),
      '自动委派有审计',
    )
    // outbox 承接记录已投递。
    const outbox = t.store.get(
      "SELECT * FROM outbox WHERE kind = 'review_delegate_auto' AND task_id = ?", task.id,
    )
    assert.equal(outbox.status, 'delivered')
  } finally { await t.close() }
})

test('开关关闭（autoReviewDelegate=false）不自动派生，owner_bot 卡回到总监验收老链路', async () => {
  const t = await setup({ auto: true, autoReviewDelegate: false })
  try {
    const task = await deliverTask(t)
    assert.equal(task.status, 'in_review', '关闭开关不影响交付迁移')
    // 老链路：交付后直接排总监验收运行（review_requested）。
    await waitFor(() => runRow(t, "task_id = ? AND trigger_type = 'review_requested'", task.id))
    assert.ok(
      !runRow(t, "task_id = ? AND trigger_type = 'review_delegate'", task.id),
      '开关关闭时不得派生自动核验运行',
    )
    assert.ok(
      !t.store.get("SELECT id FROM outbox WHERE kind = 'review_delegate_auto' AND task_id = ?", task.id),
      '开关关闭时不排 review_delegate_auto outbox',
    )
    assert.ok(
      !t.store.get("SELECT id FROM audit_log WHERE action = 'review.auto_delegate' AND target_id = ?", task.id),
      '开关关闭时无自动委派审计',
    )
  } finally { await t.close() }
})

test('派生守卫冲突不阻塞迁移：任务保持 in_review，outbox 留痕退避重试', async () => {
  const t = await setup()
  try {
    const task = await t.service.createTask({
      projectId: t.project.id, title: '冲突卡', assigneeBotId: t.dev.id, postCard: false,
    }, { type: 'bot', id: t.director.id })
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
    // 场景还原：任务上有一条非委派活跃运行占位（如总监验收运行在跑），
    // 自动委派在投递时撞守卫 conflict。
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at)
       VALUES ('run_busy', ?, ?, ?, 'task', 'write', 'manual', ?, 'running', 1, 'test:busy', ?)`,
      t.project.id, t.dev.id, task.id, task.id, new Date().toISOString(),
    )
    t.service.enqueueOutbox({
      kind: 'review_delegate_auto',
      payload: { taskId: task.id },
      projectId: t.project.id,
      taskId: task.id,
      idempotencyKey: `review_auto:${task.id}:conflict`,
    })
    // 冲突被 outbox 捕获转退避：行 pending、attempts=1、有错误留痕。
    const row = t.store.get(
      "SELECT * FROM outbox WHERE kind = 'review_delegate_auto' AND task_id = ?", task.id,
    )
    assert.equal(row.status, 'pending', '守卫冲突转退避重试')
    assert.equal(row.attempts, 1)
    assert.match(row.last_error, /已有运行在排队或执行/)
    assert.ok(new Date(row.available_at).getTime() > Date.now(), '退避到未来再试')
    // 重试审计第一跳已落。
    const retry = t.store.get(
      "SELECT * FROM audit_log WHERE action = 'review.auto_delegate_retry' AND target_id = ?", task.id,
    )
    assert.equal(JSON.parse(retry.data_json).attempt, 1)
    assert.equal(JSON.parse(retry.data_json).final, false)
    // 迁移不受任何影响：任务保持 in_review，未派生运行。
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'in_review')
    assert.ok(!runRow(t, "task_id = ? AND trigger_type = 'review_delegate'", task.id))
    // 退避窗口内再次派发也不重复撞。
    t.service.dispatchOutbox()
    assert.equal(t.store.get('SELECT attempts FROM outbox WHERE id = ?', row.id).attempts, 1)
  } finally { await t.close() }
})

test('手动与自动入口幂等不双派：两个方向都复看同一运行', async () => {
  const t = await setup()
  try {
    // 方向一：手动先委派（运行停在 queued），自动投递撞上时复看不新增。
    const first = await t.service.createTask({
      projectId: t.project.id, title: '手动先', assigneeBotId: t.dev.id, postCard: false,
    })
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", first.id)
    const manual = await t.service.taskReviewDelegate(first.id, t.actor)
    t.service.enqueueOutbox({
      kind: 'review_delegate_auto',
      payload: { taskId: first.id },
      projectId: t.project.id,
      taskId: first.id,
      idempotencyKey: `review_auto:${first.id}:dup`,
    })
    assert.equal(
      runRow(t, "task_id = ? AND trigger_type = 'review_delegate'", first.id).id, manual.id,
      '自动入口复看手动委派的运行，不双派',
    )
    const dupOutbox = t.store.get(
      "SELECT * FROM outbox WHERE kind = 'review_delegate_auto' AND task_id = ?", first.id,
    )
    assert.equal(dupOutbox.status, 'delivered', '复看也算投递成功，不进重试')
    // DSHBOTS-290：one_active_run_per_bot 下方向二的自动派生也占 owner 运行位——先完结
    // 方向一的委派运行再验方向二（幂等语义与运行位无关）。
    t.store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?", new Date().toISOString(), manual.id)

    // 方向二：自动先派生（模拟交付链排的 outbox），手动按钮随后幂等复看。
    const second = await t.service.createTask({
      projectId: t.project.id, title: '自动先', assigneeBotId: t.dev.id, postCard: false,
    })
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", second.id)
    t.service.enqueueOutbox({
      kind: 'review_delegate_auto',
      payload: { taskId: second.id },
      projectId: t.project.id,
      taskId: second.id,
      idempotencyKey: `review_auto:${second.id}:run1`,
    })
    const spawned = runRow(t, "task_id = ? AND trigger_type = 'review_delegate'", second.id)
    assert.ok(spawned, '自动入口先派生运行')
    const manualView = await t.service.taskReviewDelegate(second.id, t.actor)
    assert.equal(manualView.id, spawned.id, '手动入口复看自动派生的运行，不双派')
    assert.equal(
      Number(t.store.get(
        "SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND trigger_type = 'review_delegate'", second.id,
      ).n), 1,
    )
  } finally { await t.close() }
})

test('重试耗尽（上限 3 次）转终态：消息+审计+owner_bot 兜底，任务卡标记 failed', async () => {
  const t = await setup()
  try {
    const task = await t.service.createTask({
      projectId: t.project.id, title: '耗尽卡', assigneeBotId: t.dev.id, postCard: false,
    }, { type: 'bot', id: t.director.id })
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
    const earlier = new Date(Date.now() - 60_000).toISOString()
    // 造一次成功交付（reviewStatus 的基准）+ 一条占位活跃运行（让每次派生都撞守卫）。
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at, started_at, ended_at)
       VALUES ('run_delivered', ?, ?, ?, 'task', 'write', 'task_started', ?, 'succeeded', 1, 'test:delivered', ?, ?, ?)`,
      t.project.id, t.dev.id, task.id, task.id, earlier, earlier, new Date(Date.now() - 30_000).toISOString(),
    )
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at)
       VALUES ('run_busy2', ?, ?, ?, 'task', 'write', 'manual', ?, 'running', 1, 'test:busy2', ?)`,
      t.project.id, t.dev.id, task.id, task.id, new Date().toISOString(),
    )
    // 直接造 attempts=3 的待投递行：下一次投递失败即耗尽。
    t.store.run(
      `INSERT INTO outbox(id, kind, project_id, task_id, idempotency_key, payload_json, status, attempts, available_at, created_at)
       VALUES ('out_exhaust', 'review_delegate_auto', ?, ?, 'review_auto:exhaust', ?, 'pending', 3, ?, ?)`,
      t.project.id, task.id, JSON.stringify({ taskId: task.id }), earlier, earlier,
    )
    t.service.dispatchOutbox()
    // 耗尽：行转 failed 终态，审计 final:true。
    const row = t.store.get('SELECT * FROM outbox WHERE id = ?', 'out_exhaust')
    assert.equal(row.status, 'failed', '耗尽后终态 failed，运维在 outboxView 可见')
    const retry = t.store.get(
      "SELECT * FROM audit_log WHERE action = 'review.auto_delegate_retry' AND target_id = ?", task.id,
    )
    assert.equal(JSON.parse(retry.data_json).final, true)
    assert.equal(JSON.parse(retry.data_json).attempt, 4)
    // 失败可见：系统消息 + owner_bot 卡兜底交接已排（占位运行在途时 enqueueOwnerTaskRun
    // 幂等跳过插入，交接仍记 delivered；占位运行结束后由人工/下轮补上）。
    assert.ok(
      t.store.get(
        "SELECT id FROM messages WHERE task_id = ? AND body LIKE '自动核验委派连续失败%'", task.id,
      ),
      '耗尽必须发消息，不得只写日志',
    )
    const fallback = t.store.get(
      "SELECT * FROM outbox WHERE kind = 'owner_task_run' AND idempotency_key = ?",
      `owner_review:${task.id}:after_failed:out_exhaust`,
    )
    assert.ok(fallback, '耗尽后 owner_bot 卡必须排总监验收兜底交接')
    assert.equal(fallback.status, 'delivered')
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'in_review')
    // 任务卡核验状态：failed（UI 显示「未核验」标记）。
    const view = t.service.taskView(t.service.taskRow(task.id))
    assert.equal(view.reviewStatus, 'failed')
  } finally { await t.close() }
})

test('owner_bot 卡串联两跳：核验结论评论写回后自动触发总监裁决运行，user 卡不裁决', async () => {
  const t = await setup({ auto: true })
  try {
    // owner_bot 卡：交付 → 自动核验 → 结论评论 → 总监裁决运行。
    const ownerCard = await deliverTask(t)
    const delegate = await waitFor(() => runRow(
      t, "task_id = ? AND trigger_type = 'review_delegate'", ownerCard.id,
    ))
    await waitFor(() => t.store.get(
      "SELECT * FROM task_comments WHERE task_id = ? AND author_type = 'bot' AND body LIKE '子代理核验：%'",
      ownerCard.id,
    ))
    const verdict = await waitFor(() => runRow(
      t, "task_id = ? AND trigger_type = 'review_requested'", ownerCard.id,
    ))
    assert.equal(verdict.bot_id, t.director.id, '裁决运行绑总监')
    assert.ok(verdict.queued_at >= delegate.queued_at, '裁决运行在核验运行之后排队')
    assert.equal(
      t.store.get('SELECT status FROM tasks WHERE id = ?', ownerCard.id).status, 'in_review',
      '核验与裁决都不代 owner 改状态',
    )
    const ownerView = t.service.taskView(t.service.taskRow(ownerCard.id))
    assert.equal(ownerView.reviewStatus, 'done', '核验结论已落，任务卡不再标未核验')

    // user 卡：同样自动核验评论，但不触发总监裁决（人工验收维持现状）。
    const userCard = await deliverTask(t, { actor: { type: 'user', id: 'u1' } })
    await waitFor(() => t.store.get(
      "SELECT * FROM task_comments WHERE task_id = ? AND body LIKE '子代理核验：%'", userCard.id,
    ))
    assert.equal(
      t.store.get('SELECT review_target FROM tasks WHERE id = ?', userCard.id).review_target, 'user',
    )
    assert.ok(
      !runRow(t, "task_id = ? AND trigger_type = 'review_requested'", userCard.id),
      'user 卡不派总监裁决运行',
    )
    assert.equal(t.service.taskView(t.service.taskRow(userCard.id)).reviewStatus, 'done')
  } finally { await t.close() }
})

test('核验提示词超长防护：任务描述超 8K 截断并注明，短描述不截断', async () => {
  const t = await setup()
  try {
    const long = await t.service.createTask({
      projectId: t.project.id, title: '超长卡', assigneeBotId: t.dev.id,
      description: 'x'.repeat(9_000), postCard: false,
    })
    // DSHBOTS-198 后建档即补缺省预算；本例锁 8K 截断管线的原始余量，直改库置 NULL 模拟存量老卡。
    t.store.run('UPDATE tasks SET time_budget_minutes = NULL WHERE id = ?', long.id)
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", long.id)
    const longView = await t.service.taskReviewDelegate(long.id, t.actor)
    const longRow = t.store.get('SELECT * FROM runs WHERE id = ?', longView.id)
    const longTask = t.store.get('SELECT * FROM tasks WHERE id = ?', long.id)
    const longPrompt = t.promptRuntime.promptFor({
      run: longRow, bot: t.director, project: t.project, task: longTask,
      chatMessage: null, sessionId: 's-trunc-long',
    })
    assert.ok(longPrompt.includes('[Task description is 9000 characters, over the 8000 limit'), '截断必须注明')
    assert.ok(!longPrompt.includes('x'.repeat(8_100)), '超出部分确实未进提示词')
    assert.ok(longPrompt.length < 10_000, '提示词总量受控，不再有 400 超长风险')

    const short = await t.service.createTask({
      projectId: t.project.id, title: '短卡', assigneeBotId: t.dev.id,
      description: '实现登录页。', postCard: false,
    })
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", short.id)
    // DSHBOTS-290：owner 忙时第二次委派走挂起（runId null）——先完结第一条再委派短卡。
    t.store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?", new Date().toISOString(), longView.id)
    const shortView = await t.service.taskReviewDelegate(short.id, t.actor)
    const shortRow = t.store.get('SELECT * FROM runs WHERE id = ?', shortView.id)
    const shortTask = t.store.get('SELECT * FROM tasks WHERE id = ?', short.id)
    const shortPrompt = t.promptRuntime.promptFor({
      run: shortRow, bot: t.director, project: t.project, task: shortTask,
      chatMessage: null, sessionId: 's-trunc-short',
    })
    assert.ok(shortPrompt.includes('实现登录页。'), '短描述全文保留')
    assert.ok(!shortPrompt.includes('Task description is'), '短描述不出现截断注明')
  } finally { await t.close() }
})

// DSHBOTS-140：owner review（review_requested）与 handle（blocked_handoff）分支与
// review_delegate 共用同一 8K 截断管线——超长描述不再全文拼装（防 400 Prompt exceeds
// max length 重演）；标题/状态/写范围/最近交付评论开头是截断点外的保底字段，恒在场。
function insertDeliveryComment(t, taskId, body) {
  t.store.run(
    'INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    `task_c_${taskId.slice(-6)}_${Math.random().toString(36).slice(2, 6)}`,
    taskId, 'bot', t.dev.id, body, new Date().toISOString(),
  )
}

test('owner review 提示词超长防护：8K 截断同口径，保底字段在场，短描述不截断', async () => {
  const t = await setup()
  try {
    const long = await t.service.createTask({
      projectId: t.project.id, title: '超长验收卡', assigneeBotId: t.dev.id,
      description: 'x'.repeat(9_000), writeScopes: ['src/login/'], postCard: false,
    })
    insertDeliveryComment(t, long.id, '交付报告：登录页完成，测试 2/2 绿，改动 src/login/ 三文件。')
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", long.id)
    const ownerRunId = t.service.enqueueOwnerTaskRun(t.service.taskRow(long.id), 'review')
    const ownerRow = t.store.get('SELECT * FROM runs WHERE id = ?', ownerRunId)
    assert.equal(ownerRow.trigger_type, 'review_requested', 'owner review 运行形态')
    const longTask = t.store.get('SELECT * FROM tasks WHERE id = ?', long.id)
    const longPrompt = t.promptRuntime.promptFor({
      run: ownerRow, bot: t.director, project: t.project, task: longTask,
      chatMessage: null, sessionId: 's-owner-trunc-long',
    })
    assert.ok(longPrompt.includes('[Task description is 9000 characters, over the 8000 limit'), '截断必须注明')
    assert.ok(!longPrompt.includes('x'.repeat(8_100)), '超出部分确实未进提示词')
    assert.ok(longPrompt.length < 10_000, '提示词总量受控，不再有 400 超长风险')
    assert.ok(longPrompt.includes('Title: 超长验收卡'), '保底字段：标题')
    assert.ok(longPrompt.includes('Status: in_review'), '保底字段：状态')
    assert.ok(longPrompt.includes('Declared write scopes: src/login'), '保底字段：写范围')
    assert.ok(longPrompt.includes('交付报告：登录页完成，测试 2/2 绿'), '保底字段：最近交付评论开头')

    const short = await t.service.createTask({
      projectId: t.project.id, title: '短验收卡', assigneeBotId: t.dev.id,
      description: '实现注册页。', postCard: false,
    })
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", short.id)
    // DSHBOTS-290：同上，两次入队间释放 owner 运行位。
    t.store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?", new Date().toISOString(), ownerRunId)
    const shortRunId = t.service.enqueueOwnerTaskRun(t.service.taskRow(short.id), 'review')
    const shortRow = t.store.get('SELECT * FROM runs WHERE id = ?', shortRunId)
    const shortTask = t.store.get('SELECT * FROM tasks WHERE id = ?', short.id)
    const shortPrompt = t.promptRuntime.promptFor({
      run: shortRow, bot: t.director, project: t.project, task: shortTask,
      chatMessage: null, sessionId: 's-owner-trunc-short',
    })
    assert.ok(shortPrompt.includes('实现注册页。'), '短描述全文保留')
    assert.ok(!shortPrompt.includes('Task description is'), '短描述不出现截断注明')
  } finally { await t.close() }
})

test('handle 提示词超长防护：8K 截断同口径，保底字段与失败原因在场，短描述不截断', async () => {
  const t = await setup()
  try {
    const long = await t.service.createTask({
      projectId: t.project.id, title: '超长受阻卡', assigneeBotId: t.dev.id,
      description: 'y'.repeat(9_000), writeScopes: ['src/pay/'], postCard: false,
    })
    insertDeliveryComment(t, long.id, '受阻说明：支付网关沙箱一直 502，重试三次未恢复。')
    const failedRunId = t.service.enqueueTaskRun(t.service.taskRow(long.id), 'task_started', { type: 'bot', id: t.dev.id })
    t.store.run(
      "UPDATE runs SET status = 'failed', error_code = 'E_UPSTREAM', error_message = 'gateway 502', ended_at = ? WHERE id = ?",
      new Date().toISOString(), failedRunId,
    )
    t.store.run("UPDATE tasks SET status = 'blocked' WHERE id = ?", long.id)
    const handleRunId = t.service.enqueueOwnerTaskRun(t.service.taskRow(long.id), 'handle')
    const handleRow = t.store.get('SELECT * FROM runs WHERE id = ?', handleRunId)
    assert.equal(handleRow.kind, 'handle', 'handle 运行形态')
    assert.equal(handleRow.trigger_type, 'blocked_handoff', 'handle 触发口径')
    const longTask = t.store.get('SELECT * FROM tasks WHERE id = ?', long.id)
    const longPrompt = t.promptRuntime.promptFor({
      run: handleRow, bot: t.director, project: t.project, task: longTask,
      chatMessage: null, sessionId: 's-handle-trunc-long',
    })
    assert.ok(longPrompt.includes('[Task description is 9000 characters, over the 8000 limit'), '截断必须注明')
    assert.ok(!longPrompt.includes('y'.repeat(8_100)), '超出部分确实未进提示词')
    assert.ok(longPrompt.length < 10_000, '提示词总量受控，不再有 400 超长风险')
    assert.ok(longPrompt.includes('Title: 超长受阻卡'), '保底字段：标题')
    assert.ok(longPrompt.includes('Status: blocked'), '保底字段：状态')
    assert.ok(longPrompt.includes('Declared write scopes: src/pay'), '保底字段：写范围')
    assert.ok(longPrompt.includes('受阻说明：支付网关沙箱一直 502'), '保底字段：最近交付评论开头')
    assert.ok(longPrompt.includes('Last failure: gateway 502'), '失败原因仍在描述之后')

    const short = await t.service.createTask({
      projectId: t.project.id, title: '短受阻卡', assigneeBotId: t.dev.id,
      description: '修复支付回调。', postCard: false,
    })
    t.store.run("UPDATE tasks SET status = 'blocked' WHERE id = ?", short.id)
    // DSHBOTS-290：同上，两次入队间释放 owner 运行位。
    t.store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?", new Date().toISOString(), handleRunId)
    const shortRunId = t.service.enqueueOwnerTaskRun(t.service.taskRow(short.id), 'handle')
    const shortRow = t.store.get('SELECT * FROM runs WHERE id = ?', shortRunId)
    const shortTask = t.store.get('SELECT * FROM tasks WHERE id = ?', short.id)
    const shortPrompt = t.promptRuntime.promptFor({
      run: shortRow, bot: t.director, project: t.project, task: shortTask,
      chatMessage: null, sessionId: 's-handle-trunc-short',
    })
    assert.ok(shortPrompt.includes('修复支付回调。'), '短描述全文保留')
    assert.ok(!shortPrompt.includes('Task description is'), '短描述不出现截断注明')
  } finally { await t.close() }
})

test('approvalTimeoutMs 默认 600_000（DSHBOTS-309 由 180s 上调），DSH_TEAM_APPROVAL_TIMEOUT_MS 可覆盖', async () => {
  const saved = process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
  try {
    delete process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
    assert.equal(resolveConfig({}).approvalTimeoutMs, 600_000, '默认授权窗口 10 分钟')
    process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS = '90000'
    assert.equal(resolveConfig({}).approvalTimeoutMs, 90_000, 'env 覆盖机制不变')
    assert.equal(resolveConfig({ approvalTimeoutMs: 300000 }).approvalTimeoutMs, 300_000, '配置文件优先于 env')
  } finally {
    if (saved === undefined) delete process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
    else process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS = saved
  }
})

test('交付带提问（attention）不派核验也不排总监验收：先让 owner 答话', async () => {
  const t = await setup()
  try {
    const task = await t.service.createTask({
      projectId: t.project.id, title: '带提问的交付', assigneeBotId: t.dev.id,
      status: 'in_progress', postCard: false,
    }, { type: 'bot', id: t.director.id })
    const runId = t.service.enqueueTaskRun(task, 'task_started', { type: 'bot', id: t.dev.id })
    t.store.run(
      "INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, 'subagent_spawned', '夹具：已开子代理施工', ?)",
      `evt_fixture_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, runId, new Date().toISOString(),
    )
    t.store.run(
      "UPDATE runs SET status = 'running', started_at = ?, last_progress_at = ? WHERE id = ?",
      new Date().toISOString(), new Date().toISOString(), runId,
    )
    await t.service.finishRun({
      runId, status: 'succeeded', output: '做完了',
      attention: { question: '评审意见按哪版走？', options: ['v1', 'v2'] },
    })
    // 迁移不被阻塞；但验收链整体退位——提问要先让 owner 回答。
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'in_review')
    assert.ok(!runRow(t, "task_id = ? AND trigger_type = 'review_delegate'", task.id), '不派自动核验')
    assert.ok(!runRow(t, "task_id = ? AND trigger_type = 'review_requested'", task.id), '不排总监验收')
    assert.ok(!t.store.get("SELECT id FROM outbox WHERE kind = 'review_delegate_auto'"), '无自动委派交接')
    assert.ok(!t.store.get("SELECT id FROM outbox WHERE kind = 'owner_task_run'"), '无总监验收交接')
    // 提问不被派生运行顶掉：阶段保持「等待你回答」。
    const view = t.service.taskView(t.service.taskRow(task.id))
    assert.deepEqual(view.attention, { question: '评审意见按哪版走？', options: ['v1', 'v2'] })
    assert.equal(view.stage.stage, 'person')
    assert.equal(view.stage.action, 'answer')
    assert.equal(view.reviewStatus, 'none')
  } finally { await t.close() }
})

// DSHBOTS-291 卡面增补②（D-290 红线臂 4d70a415：M5a owner_task busy 闸 0 直接覆盖）：
// owner 真忙（有 queued/running 运行）时 enqueueOwnerTaskRun 返回 null 不落 runs 行、
// 挂待处理队列；owner 空闲后 drainPendingMessages 建回一条 review 运行。
// 现有用例都在第二次入队前把第一条 run 置 succeeded 释放 owner，未覆盖真忙场景。
test('owner 真忙时 enqueueOwnerTaskRun 挂起：返回 null 不落 runs 行，空闲 drain 建回一条', async () => {
  const t = await setup()
  try {
    const task = await t.service.createTask({
      projectId: t.project.id, title: '忙时验收', assigneeBotId: t.dev.id,
      status: 'in_progress', postCard: false,
    }, t.actor)
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
       VALUES ('run_owner_busy', ?, ?, 'chat', 'read', 'test', 'running', 1, 'busy:owner_gate', ?)`,
      t.project.id, t.director.id, new Date().toISOString(),
    )
    const pending = () => JSON.parse(t.store.setting(`bot_pending_msgs:${t.director.id}`) ?? '[]')
    assert.equal(t.service.enqueueOwnerTaskRun(t.service.taskRow(task.id), 'review'), null, 'owner 真忙时返回 null')
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM runs WHERE kind = 'review'")?.n, 0, '不落 runs 行')
    assert.equal(pending().length, 1, '挂待处理队列')
    assert.equal(pending()[0].kind, 'owner_task')

    t.store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = 'run_owner_busy'", new Date().toISOString())
    t.service.drainPendingMessages()
    const review = t.store.get("SELECT * FROM runs WHERE kind = 'review'")
    assert.ok(review, 'owner 空闲后建回一条 review 运行')
    assert.equal(review.bot_id, t.director.id)
    assert.equal(review.task_id, task.id)
    assert.deepEqual(pending(), [], '挂起队列清空')
  } finally { await t.close() }
})

// 核验纪律提示词守门（DSHBOTS-302，owner 硬口径）：核验/审计/复核他人交付=director 专属，
// 成员 bot 模板只保留自校段（验自己的活）。源码锚（D-269 手法）：核验/验收模板指令只允许
// 出现在 prompt.ts 的 review/handle 分支之后；分支之前的成员/通用模板不得含任何核验类指令
// 标记；委派核验模板保持「不代 owner 裁决」，owner 验收模板才持有 team_review_task 裁决入口。
test('DSHBOTS-302 核验纪律提示词不漂移：核验模板只落 review/handle 分支，成员模板只有自校', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/services/runtime/prompt.ts', import.meta.url)), 'utf8')
  const branch = source.indexOf("if ((run.kind === 'review' || run.kind === 'handle') && task)")
  assert.ok(branch > 0, '找不到 review/handle 模板分支')
  const memberSide = source.slice(0, branch)
  for (const marker of ['do not redo the work', 'Subagent verification', '「子代理核验：」', 'Red verification', '建议 accept or 建议 return']) {
    assert.ok(!memberSide.includes(marker), `成员可见模板不得含核验指令标记：${marker}`)
  }
  assert.match(memberSide, /verify it, and report back|verify it, then return a concise result/, '成员自校段保留（验自己的活）')
  const reviewSide = source.slice(branch)
  assert.match(reviewSide, /Do NOT call team_review_task/, '委派核验模板保持不代 owner 裁决')
  assert.match(reviewSide, /team_review_task with decision "accept"/, 'owner 验收模板保持裁决入口')
  assert.match(reviewSide, /「子代理核验：」/, '委派核验结论锚保持')
})

// DSHBOTS-311 子代理施工硬闸守门：task 施工运行交付须有 subagent_spawned 账目才转
// in_review（owner 铁律不依赖模型自觉）；无账目=运行正常完结+交付评论照落+任务留原状态
// +提示引导重做；settings subagent_delivery_gate=0 为 owner 例外通道；review/handle 与
// 消息族不经闸（d 向由既有 review 用例覆盖）。
test('DSHBOTS-311 硬闸：无子代理账目不转验收留原状态+提示评论；关闸放行', async () => {
  const t = await setup()
  try {
    const mk = async (title, runId) => {
      const task = await t.service.createTask({
        projectId: t.project.id, title, assigneeBotId: t.dev.id, postCard: false,
      }, { type: 'bot', id: t.director.id })
      // 清域内活跃运行（闲时压缩等后台补排会占 dev 车道，避免直插撞 UNIQUE）。
      const now = new Date().toISOString()
      for (const row of t.store.all(
        "SELECT id FROM runs WHERE bot_id = ? AND COALESCE(project_id, '~solo') = ? AND status IN ('queued', 'running')",
        t.dev.id, t.project.id,
      )) t.store.run("UPDATE runs SET status = 'canceled', ended_at = ? WHERE id = ?", now, row.id)
      t.store.run(
        `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at, started_at)
         VALUES (?, ?, ?, ?, 'task', 'write', 'task_started', ?, 'running', 1, ?, ?, ?)`,
        runId, t.project.id, t.dev.id, task.id, task.id, `gate:${runId}`, new Date().toISOString(), new Date().toISOString(),
      )
      return task
    }
    // a) 无账目：交付被闸——运行正常完结、评论照落、任务留 in_progress+提示。
    const task1 = await mk('闸内施工', 'run_gate_on')
    await t.service.finishRun({ runId: 'run_gate_on', status: 'succeeded', output: '亲做交付' })
    assert.equal(t.store.get('SELECT status FROM runs WHERE id = ?', 'run_gate_on').status, 'succeeded', '运行正常完结不被硬闸打断')
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task1.id).status, 'todo', '无账目不转 in_review（留原状态 todo）')
    const gatedComment = t.store.get("SELECT body FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", task1.id)
    assert.match(gatedComment.body, /DSHBOTS-311 硬闸：本运行未经子代理施工/, '提示评论落卡')
    assert.match(gatedComment.body, /subagent_delivery_gate/, '评论指明例外通道')
    assert.ok(gatedComment.body.includes('亲做交付'), '交付文本不丢（照落评论）')

    // c) 开关 0：同款无账目交付放行转 in_review。
    t.store.setSetting('subagent_delivery_gate', '0')
    const task2 = await mk('关闸施工', 'run_gate_off')
    await t.service.finishRun({ runId: 'run_gate_off', status: 'succeeded', output: '关闸交付' })
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task2.id).status, 'in_review', '关闸后无账目交付照转 in_review（owner 例外通道）')
  } finally { await t.close() }
})

test('DSHBOTS-311 提示词无豁免句：每卡都进专属子代理（源码锚）', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/services/runtime/prompt.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /small single-file cards do yourself/, '小卡亲做豁免句已删')
  assert.match(source, /every card runs in a dedicated child agent/, '每卡专属子代理（与硬闸口径一致）')
  const finishSource = readFileSync(fileURLToPath(new URL('../src/services/run-finish.ts', import.meta.url)), 'utf8')
  assert.match(finishSource, /subagent_spawned/, '交付链闸查 subagent_spawned 账目')
  assert.match(finishSource, /subagent_delivery_gate/, '例外开关键锚')
})

// DSHBOTS-306 验收期亲和改判 owner：任务 in_review 后卡线程消息按 assignee 任务亲和
// （D-286）落承接 bot 会话，而验收动作 team_review_task 仅 owner bot 可调（D-190）——
// 指令路由与动作权限错位，每卡绕一步。守门四向：①in_review 亲和改判项目 owner bot 的
// 控制面绑定（优先于 runs 归属/结转亲和）；②in_progress 维持 assignee 亲和（含结转后
// alias 旧会话，D-286 不回归）；③done 无亲和不变；④退回 todo 恢复 assignee 亲和。
test('DSHBOTS-306 验收期亲和改判 owner：in_review 落总监控制面，in_progress 维持 assignee 亲和', async () => {
  const t = await setup()
  try {
    const { store, service, director, dev, project } = t
    const affinity = (task) => sessionMethods.taskAffinityBinding.call(service, task)
    const task = await service.createTask({ projectId: project.id, title: '亲和任务', assigneeBotId: dev.id })
    const now = new Date().toISOString()
    // assignee 任务会话（alias=1 模拟 D-286 结转后的旧任务绑定）+ 该任务的运行归属。
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, alias, created_at) VALUES (?, ?, ?, 'task', ?, 1, ?)",
      'sess-task-dev', dev.id, project.id, task.id, now,
    )
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, session_id, queued_at)
       VALUES ('run_aff_dev', ?, ?, ?, 'task', 'write', 'assigned', 'succeeded', 1, 'aff:1', 'sess-task-dev', ?)`,
      project.id, dev.id, task.id, now,
    )
    // 总监控制面绑定（D-299 三分：每 (owner, project) 一条 kind='bot'）。
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, alias, created_at) VALUES (?, ?, ?, 'bot', 0, ?)",
      'sess-director-proj', director.id, project.id, now,
    )

    store.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", task.id)
    assert.equal(affinity(service.taskRow(task.id))?.session_id, 'sess-task-dev', 'in_progress 维持 assignee 任务会话亲和（含结转 alias 行）')

    store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
    const ownerBinding = affinity(service.taskRow(task.id))
    assert.equal(ownerBinding?.session_id, 'sess-director-proj', 'in_review 亲和改判总监控制面会话（优先于 runs 归属/结转亲和）')
    assert.equal(ownerBinding?.bot_id, director.id, '亲和目标是项目 owner bot')

    store.run("UPDATE tasks SET status = 'done' WHERE id = ?", task.id)
    assert.equal(affinity(service.taskRow(task.id)), undefined, 'done 无亲和（既有口径不变）')

    store.run("UPDATE tasks SET status = 'todo' WHERE id = ?", task.id)
    assert.equal(affinity(service.taskRow(task.id))?.session_id, 'sess-task-dev', '退回 todo 恢复 assignee 亲和')
  } finally { await t.close() }
})
