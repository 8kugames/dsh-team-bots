import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
        output: shouldFail ? '' : this.outputFor(run, bot, task),
        error: shouldFail ? { code: 'TEST_FAILURE', message: 'simulated failure' } : null,
      })
    })
    return `session-${run.id}`
  }

  outputFor(run, bot, task) {
    if (run.kind === 'memory_review') {
      return JSON.stringify([
        { scope: 'bot', topic: '交付习惯', content: '交付前先跑一遍校验脚本。', confidence: 0.9 },
        { scope: 'project', topic: '目录约定', content: '演示页面放在 src/demo.js。', confidence: 0.85 },
      ])
    }
    return task ? `Implemented ${task.title}. Changed src/demo.js and verified it.` : `Reply from ${bot.name}.`
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

// FakeRuntime 通过 setImmediate 异步收尾；关闭数据库前先等队列排空，避免收尾写入落到已关闭的连接上。
async function closeQuietly(store, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch {
      break
    }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    store.close()
  } catch {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`)
  const config = resolveConfig({ workspace, dataDir, modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new FakeRuntime(service)
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  return { root, workspace, dataDir, config, store, service, runtime }
}

test('boot seeds owner chief, default companions and shared skills', async () => {
  const { store, service, root } = await setup()
  try {
    const bots = store.all('SELECT * FROM bots ORDER BY created_at')
    assert.equal(bots.length, 6)
    assert.equal(bots[0].name, 'chief')
    assert.equal(bots[0].provider, 'fake')
    for (const name of ['designer', 'programmer', 'graphics', 'devops', 'artist']) {
      assert.ok(bots.some(bot => bot.name === name), `missing seed bot ${name}`)
    }
    const state = await service.state()
    assert.equal(state.skills.length, 1)
    assert.equal(state.skills[0].slug, 'review')
    assert.equal(state.models.length, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('project, group task assignment and completion form a closed loop', async () => {
  const { root, store, service } = await setup()
  try {
    const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
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
    assert.ok(state.usage.scope.global.totalTokens > 0)
    assert.equal(state.usage.scope.project.totalTokens, state.usage.scope.global.totalTokens)
    assert.ok(state.usage.byBot.some(item => item.name === 'Builder' && item.totalTokens > 0))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('plain mention runs a chat reply while an empty mention goes to owner', async () => {
  const { root, store, service } = await setup()
  try {
    const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
    const project = await service.createProject({ name: 'Chat Project', key: 'CHAT', ownerBotId: chief.id })
    await service.sendMessage(project.id, '你好，负责人')
    await waitFor(() => service.store.get("SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND sender_type = 'bot'", project.id)?.n >= 1)
    await service.sendMessage(project.id, ' @chief 请回复')
    await waitFor(() => service.store.get("SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND sender_type = 'bot'", project.id)?.n >= 2)
    const botMessages = service.store.all("SELECT * FROM messages WHERE project_id = ? AND sender_type = 'bot'", project.id)
    assert.equal(botMessages.length, 2)
  } finally {
    await closeQuietly(store)
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
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

async function ownerSetup(projectKey) {
  const env = await setup()
  const { store, service } = env
  const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
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
      task.id, store.get("SELECT id FROM bots WHERE name = 'chief'").id,
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
    await closeQuietly(store)
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
    await closeQuietly(store)
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
      first.taskId, store.get("SELECT id FROM bots WHERE name = 'chief'").id,
    )?.status === 'succeeded')
    assert.equal(store.get("SELECT status FROM tasks WHERE id = ?", first.taskId)?.status, 'blocked')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'task'", first.taskId)?.n, 1)
    // 负责人重派同一任务 → 重新执行并按派单人转负责人验收
    const updated = await service.assignFromBot(sessionId, { assignee: 'Builder', task: 'BLK-1' })
    assert.equal(updated.review_target, 'owner_bot')
    await waitFor(() => store.get("SELECT status FROM tasks WHERE id = ?", first.taskId)?.status === 'in_review')
    await waitFor(() => (store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'task'", first.taskId)?.n ?? 0) >= 2)
    await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND kind = 'review'", first.taskId)?.status === 'succeeded')
    const task = await service.taskDetail(first.taskId)
    assert.equal(task.review_target, 'owner_bot')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('team data defaults under /workspace/.data and skill pool is separate', async () => {
  const { resolveConfig } = await import('../src/config.js')
  const config = resolveConfig({ workspace: '/tmp/example-workspace' })
  assert.equal(config.dataDir, '/tmp/example-workspace/.data')
  assert.equal(config.dbPath, '/tmp/example-workspace/.data/team.sqlite')
  assert.equal(config.skillRoot, '/tmp/example-workspace/.agents')
})

test('workspace default resolves to ~/.dsh/workspace/team-bots unless configured', async () => {
  const { resolveConfig, defaultWorkspace } = await import('../src/config.js')
  const previous = process.env.DSH_TEAM_WORKSPACE
  try {
    delete process.env.DSH_TEAM_WORKSPACE
    assert.equal(defaultWorkspace(), join(homedir(), '.dsh', 'workspace', 'team-bots'))
    process.env.DSH_TEAM_WORKSPACE = '/srv/team'
    assert.equal(defaultWorkspace(), resolve('/srv/team'))
    assert.equal(resolveConfig().workspace, resolve('/srv/team'))
  } finally {
    if (previous === undefined) delete process.env.DSH_TEAM_WORKSPACE
    else process.env.DSH_TEAM_WORKSPACE = previous
  }
})

test('项目生产目录：可选绝对路径，默认与管理目录一致，可更新可清空', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const chief = store.get("SELECT id FROM bots WHERE name = 'chief'").id
    const prod = join(root, 'prod-repo')
    const project = await service.createProject({ name: 'External', key: 'EXT', ownerBotId: chief, productionDir: prod })
    // macOS 上 /var 是 /private/var 的符号链接，服务端会 realpath 后落库
    assert.equal(project.workspace_path, await realpath(prod))
    assert.equal(project.data_path, join(workspace, 'ext'))
    await assert.rejects(
      () => service.createProject({ name: 'Bad', key: 'BAD', ownerBotId: chief, productionDir: 'relative/dir' }),
      /绝对路径/,
    )
    const plain = await service.createProject({ name: 'Plain', key: 'PLN', ownerBotId: chief })
    assert.equal(plain.workspace_path, join(workspace, 'pln'))
    assert.equal(plain.data_path, join(workspace, 'pln'))
    const updated = await service.updateProject(project.id, { productionDir: join(root, 'prod-2') })
    assert.equal(updated.workspace_path, await realpath(join(root, 'prod-2')))
    const cleared = await service.updateProject(project.id, { productionDir: '' })
    assert.equal(cleared.workspace_path, join(workspace, 'ext'))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('browse_dirs 只列目录（含符号链接目录），默认从主目录开始', async () => {
  const { root, store, service } = await setup()
  try {
    await mkdir(join(root, 'repo-a', '.git'), { recursive: true })
    await mkdir(join(root, 'repo-b'), { recursive: true })
    await writeFile(join(root, 'plain.txt'), 'not a dir')
    await symlink(join(root, 'repo-a'), join(root, 'repo-link'))
    const result = service.browseDirectories({ path: root })
    assert.equal(result.path, root)
    assert.deepEqual(result.dirs, ['data', 'repo-a', 'repo-b', 'repo-link', 'workspace'])
    const parent = service.browseDirectories({ path: result.parent })
    assert.ok(parent.dirs.length > 0)
    // 指向文件报错而不是崩
    await assert.throws(() => service.browseDirectories({ path: join(root, 'plain.txt') }), /无法读取目录/)
    // 缺省与空串都落到主目录
    assert.equal(service.browseDirectories({}).path, resolve(homedir()))
    assert.equal(service.browseDirectories({ path: '   ' }).path, resolve(homedir()))
    // API 白名单放行：走 handleAction 全链路（曾漏加 ACTIONS 导致 404 未知操作）
    const actor = { type: 'user', id: service.localUserId }
    const viaApi = await handleAction(service, 'browse_dirs', { path: root }, actor)
    assert.equal(viaApi.path, root)
    await assert.rejects(() => handleAction(service, 'browse_dirs', { path: join(root, 'plain.txt') }, actor), /无法读取目录/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('skill proposal approval publishes into shared skill pool', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const actor = { type: 'user', id: service.localUserId }
    const project = await service.createProject({ name: 'Skills', key: 'SKL', ownerBotId: store.get("SELECT id FROM bots WHERE name = 'chief'").id })
    const proposal = await service.createProposal({
      kind: 'skill', projectId: project.id, title: 'Add deploy skill', rationale: 'Repeated deploy work',
      payload: { slug: 'deploy-check', name: 'Deploy check', description: 'Check deployment', version: '1.0.0', content: '# Deploy check\n\nRun smoke tests.' },
    }, actor)
    // 没有评估结论时不允许直接批准。
    await assert.rejects(() => service.decideProposal(proposal.id, 'approved', actor), /评估/)
    await service.evaluateProposal(proposal.id, { verdict: 'pass', notes: '内容可执行' }, actor)
    const approved = await service.decideProposal(proposal.id, 'approved', actor)
    assert.equal(approved.status, 'approved')
    const state = await service.state(project.id)
    assert.ok(state.skills.some(skill => skill.slug === 'deploy-check'))
    assert.ok(state.skillBindings.some(binding => binding.slug === 'deploy-check'))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('/clear empties group chat history without touching tasks or memories', async () => {
  const { root, store, service } = await setup()
  try {
    const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
    const project = await service.createProject({ name: 'Clear', key: 'CLR', ownerBotId: chief.id })
    await service.sendMessage(project.id, '/remember 先写测试再上线', { type: 'user', id: 'u1' })
    await service.sendMessage(project.id, '你好，请看一下这个问题', { type: 'user', id: 'u1' })
    await waitFor(() => store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')")?.n === 0)
    const before = Number(store.get('SELECT COUNT(*) AS n FROM messages WHERE project_id = ?', project.id)?.n ?? 0)
    assert.ok(before >= 3, '清空前应已有消息')

    const result = await service.sendMessage(project.id, '/clear', { type: 'user', id: 'u1' })
    assert.equal(result.cleared, before)
    assert.equal(Number(store.get('SELECT COUNT(*) AS n FROM messages WHERE project_id = ?', project.id)?.n ?? 0), 0)
    // /clear 不入消息、不触发 Bot 运行
    const runsAfter = Number(store.get('SELECT COUNT(*) AS n FROM runs')?.n ?? 0)
    await waitFor(() => store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')")?.n === 0)
    assert.equal(Number(store.get('SELECT COUNT(*) AS n FROM runs')?.n ?? 0), runsAfter)
    // 记忆与后续聊天不受影响
    assert.ok(store.get("SELECT COUNT(*) AS n FROM memories WHERE scope_type = 'project' AND scope_id = ?", project.id)?.n >= 1)
    await service.sendMessage(project.id, '继续聊', { type: 'user', id: 'u1' })
    assert.equal(Number(store.get('SELECT COUNT(*) AS n FROM messages WHERE project_id = ?', project.id)?.n ?? 0), 1)
    // 审计留痕
    assert.ok(store.get("SELECT id FROM audit_log WHERE action = 'chat.clear' AND target_id = ?", project.id))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
