// tests/review-delegate.test.js —— DSHBOTS-107：验收核验委派产品化护栏。
// owner 一键把 in_review 任务的核验委派给总监 Bot 的子代理：派生 kind='review' 运行
// （trigger_type='review_delegate'、read 模式、空写范围），提示词含 subagent 并行指示，
// 结论以「子代理核验：」开头写回任务评论；裁决权仍归 owner。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

// 不完结的运行时：让委派运行停在 queued/running，供状态类用例断言运行行。
class HoldRuntime {
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-hold' }
  async steer() { return true }
  async cancelRun() { return true }
}

// 立即成功的运行时：task 运行交付转 in_review，review 运行产出「子代理核验：」结论。
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

async function setup({ auto = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-rvd-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(
    join(workspace, '.agents', 'skills', 'review', 'SKILL.md'),
    `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`,
  )
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20,
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
    name: 'Delegate', key: 'DLG', ownerBotId: director.id, memberIds: [dev.id],
  })
  // 提示词断言用真实 DshRuntime（FakeRuntime 无 promptFor）。
  const promptRuntime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const actor = { type: 'user', id: service.localUserId }
  const close = async () => {
    // 自动完结的运行等收尾落库；HoldRuntime 的运行永不完结，直接关。
    if (auto) {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')")?.n ?? 0)
        if (active === 0) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { root, store, service, director, dev, project, promptRuntime, actor, close }
}

function inReviewTask(store, service, project, dev) {
  // 直接建卡后置 in_review：绕开执行链，聚焦委派守卫本身。
  return service.createTask({ projectId: project.id, title: '交付核验', assigneeBotId: dev.id, postCard: false })
    .then(task => {
      store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
      return store.get('SELECT * FROM tasks WHERE id = ?', task.id)
    })
}

test('委派核验只有 owner（user）可发起，Bot 被拒绝', async () => {
  const t = await setup()
  try {
    const task = await inReviewTask(t.store, t.service, t.project, t.dev)
    await assert.rejects(
      () => t.service.taskReviewDelegate(task.id, { type: 'bot', id: t.director.id }),
      /owner/,
    )
    assert.equal(
      t.store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'review'", task.id).n, 0,
      '被拒时不派生运行',
    )
  } finally { await t.close() }
})

test('非 in_review 任务拒绝委派', async () => {
  const t = await setup()
  try {
    const task = await t.service.createTask({
      projectId: t.project.id, title: '未交付', assigneeBotId: t.dev.id, postCard: false,
    })
    assert.equal(task.status, 'todo')
    await assert.rejects(() => t.service.taskReviewDelegate(task.id, t.actor), /不在待验收状态/)
  } finally { await t.close() }
})

test('委派派生 kind=review 运行：read 模式、空写范围、绑总监，提示词含 subagent 指示', async () => {
  const t = await setup()
  try {
    const task = await inReviewTask(t.store, t.service, t.project, t.dev)
    const view = await t.service.taskReviewDelegate(task.id, t.actor)
    assert.equal(view.kind, 'review')
    assert.equal(view.mode, 'read')
    assert.equal(view.triggerType ?? view.trigger_type, 'review_delegate')
    assert.equal(view.botId ?? view.bot_id, t.director.id)
    assert.deepEqual(view.writeScopes, [], '核验运行写范围必须为空')
    const row = t.store.get('SELECT * FROM runs WHERE id = ?', view.id)
    assert.equal(row.write_scopes, null, '行级 write_scopes 为 NULL')

    const prompt = t.promptRuntime.promptFor({
      run: row, bot: t.director, project: t.project, task,
      chatMessage: null, sessionId: 's-review-delegate',
    })
    assert.match(prompt, /subagent\/subagent_fork/, '明确指示用子代理并行核验')
    assert.ok(prompt.includes('「子代理核验：」'), '结论必须以固定前缀落任务评论')
    assert.ok(prompt.includes('建议 accept') && prompt.includes('建议 return'), '结论须给双向建议')
    assert.ok(prompt.includes('Do NOT call team_review_task'), '不得代 owner 裁决')
    assert.ok(prompt.includes(task.title), '提示词携带任务标题')
  } finally { await t.close() }
})

test('重复委派幂等返回同一运行；他种活跃运行在途时拒绝', async () => {
  const t = await setup()
  try {
    const task = await inReviewTask(t.store, t.service, t.project, t.dev)
    const first = await t.service.taskReviewDelegate(task.id, t.actor)
    const second = await t.service.taskReviewDelegate(task.id, t.actor)
    assert.equal(second.id, first.id, '委派运行在途时幂等复看')

    // 另一任务上造一条非委派的活跃执行运行（DB 层 one_active_run_per_task 保证
    // 同任务只有一条活跃运行），委派应被服务守卫拒绝。
    const other = await t.service.createTask({
      projectId: t.project.id, title: '另单', assigneeBotId: t.dev.id, postCard: false,
    })
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", other.id)
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
       VALUES ('run_busy', ?, ?, ?, 'task', 'write', 'manual', 'running', 1, 'test:busy', ?)`,
      t.project.id, t.dev.id, other.id, new Date().toISOString(),
    )
    await assert.rejects(() => t.service.taskReviewDelegate(other.id, t.actor), /已有运行在排队或执行/)
  } finally { await t.close() }
})

test('全链路：交付转待验收后委派，结论评论写回任务', async () => {
  const t = await setup({ auto: true })
  try {
    await t.service.sendMessage(t.project.id, '/task @Builder 交付登录页', { type: 'user', id: 'u1' })
    const task = await waitFor(() => {
      const row = t.store.get("SELECT * FROM tasks WHERE status = 'in_review'")
      return row ?? false
    })
    await t.service.taskReviewDelegate(task.id, t.actor)
    await waitFor(() => {
      const comment = t.store.get(
        "SELECT * FROM task_comments WHERE task_id = ? AND author_type = 'bot' AND body LIKE '子代理核验：%'",
        task.id,
      )
      return Boolean(comment)
    })
    const comment = t.store.get(
      "SELECT * FROM task_comments WHERE task_id = ? AND body LIKE '子代理核验：%'",
      task.id,
    )
    assert.equal(comment.author_id, t.director.id, '结论评论署名总监 Bot')
    assert.ok(comment.body.includes('建议 accept'), '结论给出验收建议')
    assert.equal(task.status, 'in_review', '核验不代裁决，任务状态不变')
    const after = t.store.get('SELECT status FROM tasks WHERE id = ?', task.id)
    assert.equal(after.status, 'in_review')
  } finally { await t.close() }
})
