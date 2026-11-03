// tests/review-auto.test.js —— DSHBOTS-113：验收自动委派护栏。
// 任务交付迁移 in_review 的同一事务里自动派生 kind='review' 核验运行（复用 D-107 的
// spawnReviewDelegate 共享入口，手动按钮同源）；开关 autoReviewDelegate 默认开；派生
// 失败走 outbox 退避重试、上限 3 次，耗尽后失败可见（任务卡「未核验」+消息+审计），
// 任何失败都不阻塞交付迁移。owner_bot 卡串联两跳：核验→总监裁决；user 卡核验后人工裁决。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

// 不完结的运行时：运行停在 queued/running，供状态/幂等类用例稳定断言运行行。
class HoldRuntime {
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

async function setup({ auto = false, autoReviewDelegate } = {}) {
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
async function deliverTask(t, { actor } = {}) {
  const task = await t.service.createTask({
    projectId: t.project.id, title: '交付登录页', assigneeBotId: t.dev.id,
    status: 'in_progress', postCard: false,
  }, actor ?? { type: 'bot', id: t.director.id })
  t.service.enqueueTaskRun(task, 'task_started', { type: 'bot', id: t.dev.id })
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
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", long.id)
    const longView = await t.service.taskReviewDelegate(long.id, t.actor)
    const longRow = t.store.get('SELECT * FROM runs WHERE id = ?', longView.id)
    const longTask = t.store.get('SELECT * FROM tasks WHERE id = ?', long.id)
    const longPrompt = t.promptRuntime.promptFor({
      run: longRow, bot: t.director, project: t.project, task: longTask,
      chatMessage: null, sessionId: 's-trunc-long',
    })
    assert.ok(longPrompt.includes('[任务描述共 9000 字符，超过 8000 已截断'), '截断必须注明')
    assert.ok(!longPrompt.includes('x'.repeat(8_100)), '超出部分确实未进提示词')
    assert.ok(longPrompt.length < 10_000, '提示词总量受控，不再有 400 超长风险')

    const short = await t.service.createTask({
      projectId: t.project.id, title: '短卡', assigneeBotId: t.dev.id,
      description: '实现登录页。', postCard: false,
    })
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", short.id)
    const shortView = await t.service.taskReviewDelegate(short.id, t.actor)
    const shortRow = t.store.get('SELECT * FROM runs WHERE id = ?', shortView.id)
    const shortTask = t.store.get('SELECT * FROM tasks WHERE id = ?', short.id)
    const shortPrompt = t.promptRuntime.promptFor({
      run: shortRow, bot: t.director, project: t.project, task: shortTask,
      chatMessage: null, sessionId: 's-trunc-short',
    })
    assert.ok(shortPrompt.includes('实现登录页。'), '短描述全文保留')
    assert.ok(!shortPrompt.includes('已截断'), '短描述不出现截断注明')
  } finally { await t.close() }
})

test('approvalTimeoutMs 默认 180_000，DSH_TEAM_APPROVAL_TIMEOUT_MS 可覆盖', async () => {
  const saved = process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
  try {
    delete process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
    assert.equal(resolveConfig({}).approvalTimeoutMs, 180_000, '默认授权窗口 3 分钟')
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
