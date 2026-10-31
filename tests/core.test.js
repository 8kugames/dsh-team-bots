import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { recordUsage } from '../src/usage.js'
import { ensureProjectWorkspace, safeSlug } from '../src/paths.js'
import { handleAction } from '../src/api.js'

class FakeRuntime {
  constructor(service) {
    this.service = service
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
    this.started = []
    this.failNextTaskRun = false
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return this.models }

  async validateBotConfig() {}

  async startRun({ run, bot, task }) {
    this.started.push({ id: run.id, kind: run.kind, botId: run.bot_id, taskId: run.task_id ?? null })
    const shouldFail = this.failNextTaskRun && run.kind === 'task'
    if (shouldFail) this.failNextTaskRun = false
    recordUsage(this.service.store, {
      sourceKey: `test:${run.id}`,
      run,
      provider: bot.provider,
      model: bot.model,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
    })
    setImmediate(() => {
      void this.handler({
        runId: run.id,
        status: shouldFail ? 'failed' : 'succeeded',
        output: shouldFail ? '' : (task ? `Implemented ${task.title}. Changed src/demo.js and verified it.` : `Reply from ${bot.name}.`),
        error: shouldFail ? { code: 'TEST_FAILURE', message: 'simulated failure' } : null,
      })
    })
    return `session-${run.id}`
  }

  async cancelRun() { return true }
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timeout waiting for condition')
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`)
  const config = resolveConfig({ workspace, dataDir, seedOwnerName: 'Chief', modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new FakeRuntime(service)
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  return { root, workspace, dataDir, config, store, service, runtime }
}

test('boot creates Chief and syncs shared skills', async () => {
  const { store, service, root } = await setup()
  try {
    const bots = store.all('SELECT * FROM bots')
    assert.equal(bots.length, 1)
    assert.equal(bots[0].name, 'Chief')
    assert.equal(bots[0].provider, 'fake')
    const state = await service.state()
    assert.equal(state.skills.length, 1)
    assert.equal(state.skills[0].slug, 'review')
    assert.equal(state.models.length, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('project, group task assignment and completion form a closed loop', async () => {
  const { root, store, service } = await setup()
  try {
    const chief = store.get("SELECT * FROM bots WHERE name = 'Chief'")
    const dev = await service.createBot({
      name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
    })
    const project = await service.createProject({
      name: 'Demo Project', key: 'DEMO', ownerBotId: chief.id, memberIds: [dev.id],
    })
    assert.equal(project.members.length, 2)
    const first = await service.sendMessage(project.id, '/task @Builder Build the demo page')
    assert.ok(first.taskId)
    await waitFor(() => service.store.get("SELECT status FROM tasks WHERE id = ?", first.taskId)?.status === 'in_review')
    const task = await service.taskDetail(first.taskId)
    assert.equal(task.identifier, 'DEMO-1')
    assert.equal(task.comments.length, 1)
    assert.match(task.comments[0].body, /Implemented/)
    assert.equal(task.runs[0].status, 'succeeded')
    assert.ok(task.runs[0].usage_input >= 100)
    const memories = service.store.all("SELECT * FROM memories WHERE status = 'active'")
    assert.ok(memories.length >= 2)
    assert.ok(memories.some(memory => memory.scope_type === 'project'))
    const state = await service.state(project.id)
    assert.equal(state.project.stats.inReview, 1)
    assert.ok(state.messages.some(message => message.taskIdentifier === 'DEMO-1'))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('plain mention runs a chat reply while an empty mention goes to owner', async () => {
  const { root, store, service } = await setup()
  try {
    const chief = store.get("SELECT * FROM bots WHERE name = 'Chief'")
    const project = await service.createProject({ name: 'Chat Project', key: 'CHAT', ownerBotId: chief.id })
    await service.sendMessage(project.id, '你好，负责人')
    await waitFor(() => service.store.get("SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND sender_type = 'bot'", project.id)?.n >= 1)
    await service.sendMessage(project.id, '@Chief 请回复')
    await waitFor(() => service.store.get("SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND sender_type = 'bot'", project.id)?.n >= 2)
    const botMessages = service.store.all("SELECT * FROM messages WHERE project_id = ? AND sender_type = 'bot'", project.id)
    assert.equal(botMessages.length, 2)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('path guard rejects traversal and accepts safe project directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-path-'))
  try {
    assert.throws(() => safeSlug('../escape'), /slug/)
    const path = await ensureProjectWorkspace(root, 'safe-dir')
    assert.ok(path.endsWith('safe-dir'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('API exposes state and rejects unknown actions', async () => {
  const { root, store, service } = await setup()
  try {
    const actor = { type: 'user', id: service.localUserId }
    const state = await handleAction(service, 'state', {}, actor)
    assert.ok(Array.isArray(state.bots))
    await assert.rejects(() => handleAction(service, 'rm_rf', {}, actor), /未知操作/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function ownerSetup(projectKey) {
  const env = await setup()
  const { store, service } = env
  const chief = store.get("SELECT * FROM bots WHERE name = 'Chief'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({
    name: `${projectKey} Project`, key: projectKey, ownerBotId: chief.id, memberIds: [dev.id],
  })
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    `sess-${projectKey}`, chief.id, project.id, 'project', new Date().toISOString(),
  )
  return { ...env, chief, dev, project, sessionId: `sess-${projectKey}` }
}

test('owner-dispatched delivery routes review to the owner bot, not the user', async () => {
  const { root, store, service, project, sessionId } = await ownerSetup('OWN')
  try {
    const task = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: 'Build module', description: 'Do it well.',
    })
    assert.equal(task.review_target, 'owner_bot')
    await waitFor(() => store.get("SELECT status FROM tasks WHERE id = ?", task.id)?.status === 'in_review')
    await waitFor(() => store.get(
      "SELECT status FROM runs WHERE task_id = ? AND kind = 'review' AND bot_id = ?",
      task.id, store.get("SELECT id FROM bots WHERE name = 'Chief'").id,
    )?.status === 'succeeded')
    // 验收运行不翻转任务状态，也不产生新的执行运行
    assert.equal(store.get("SELECT status FROM tasks WHERE id = ?", task.id)?.status, 'in_review')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'task'", task.id)?.n, 1)
    // 红点只计用户待验收；负责人待验收单独计数
    const state = await service.state(project.id)
    assert.equal(state.project.stats.inReview, 0)
    assert.equal(state.project.stats.ownerReview, 1)
    assert.equal(state.projects.find(item => item.id === project.id).reviewTasks, 0)
    assert.equal(state.projects.find(item => item.id === project.id).ownerReviewTasks, 1)
    assert.ok(store.all('SELECT body FROM messages WHERE project_id = ?', project.id)
      .some(message => message.body.includes('等待负责人验收')))
    // 负责人验收通过 → done
    const done = await service.reviewFromBot(sessionId, { task: 'OWN-1', decision: 'accept' })
    assert.equal(done.status, 'done')
    const after = await service.state(project.id)
    assert.equal(after.project.stats.ownerReview, 0)
    assert.equal(after.project.stats.inReview, 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('owner return sends the task back for rework and it re-enters owner review', async () => {
  const { root, store, service, sessionId } = await ownerSetup('RET')
  try {
    const task = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: 'Fix bug', description: 'Fix it.',
    })
    await waitFor(() => store.get("SELECT status FROM tasks WHERE id = ?", task.id)?.status === 'in_review')
    await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND kind = 'review'", task.id)?.status === 'succeeded')
    const returned = await service.reviewFromBot(sessionId, {
      task: 'RET-1', decision: 'return', comment: '需要补充测试',
    })
    assert.equal(returned.status, 'in_progress')
    assert.match(
      store.get("SELECT body FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", task.id)?.body ?? '',
      /退回重做/,
    )
    await waitFor(() => (store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'task'", task.id)?.n ?? 0) >= 2)
    await waitFor(() => store.get("SELECT status FROM tasks WHERE id = ?", task.id)?.status === 'in_review')
    await waitFor(() => (store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'review'", task.id)?.n ?? 0) >= 2)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('blocked task goes to the owner bot and re-dispatch restarts it as owner-dispatched', async () => {
  const { root, store, service, runtime, project, sessionId } = await ownerSetup('BLK')
  try {
    runtime.failNextTaskRun = true
    const first = await service.sendMessage(project.id, '/task @Builder Build the demo page')
    await waitFor(() => store.get("SELECT status FROM tasks WHERE id = ?", first.taskId)?.status === 'blocked')
    // 受阻自动转负责人处理；处理运行不翻转任务状态，也不会自动重跑
    await waitFor(() => store.get(
      "SELECT status FROM runs WHERE task_id = ? AND kind = 'handle' AND bot_id = ?",
      first.taskId, store.get("SELECT id FROM bots WHERE name = 'Chief'").id,
    )?.status === 'succeeded')
    assert.equal(store.get("SELECT status FROM tasks WHERE id = ?", first.taskId)?.status, 'blocked')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'task'", first.taskId)?.n, 1)
    // 负责人重派同一任务 → 重新执行并按派单人转负责人验收
    const updated = await service.assignFromBot(sessionId, { assignee: 'Builder', task: 'BLK-1' })
    assert.equal(updated.review_target, 'owner_bot')
    await waitFor(() => store.get("SELECT status FROM tasks WHERE id = ?", first.taskId)?.status === 'in_review')
    await waitFor(() => (store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'task'", first.taskId)?.n ?? 0) >= 2)
    await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND kind = 'review'", first.taskId) !== undefined)
    const task = await service.taskDetail(first.taskId)
    assert.equal(task.review_target, 'owner_bot')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
