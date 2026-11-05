// P3/P4 验收护栏：记忆作用域与冻结、提案评估与灰度、技能版本回滚、
// 用量口径与对账、数据保留、CSV 导出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { recordUsage } from '../src/usage.js'
import { applyRetention, exportUsageCsv, reconcileUsage } from '../src/usage-reconcile.js'
import { publishSkill, readCurrentPointer } from '../src/skills.js'
import type { Store } from '../src/db.js'

class FakeRuntime {
  declare service: { store: Store }
  declare memoryItems: Array<{ scope: string; topic: string; content: string; confidence: number }>
  declare models: Array<{
    ref: string; provider: string; providerName: string; model: string; name: string
    efforts: Array<{ id: string; name: string }>; defaultEffort: string
  }>
  declare started: Array<{ id: string; kind: string; botId: string; taskId: string | null }>
  declare handler: (result: { runId: string; status: string; output: string; error: null }) => unknown

  constructor(service, options: { memoryItems?: Array<{ scope: string; topic: string; content: string; confidence: number }> } = {}) {
    this.service = service
    this.memoryItems = options.memoryItems ?? [
      { scope: 'bot', topic: '交付习惯', content: '交付前先跑一遍校验脚本。', confidence: 0.9 },
      { scope: 'project', topic: '目录约定', content: '演示页面放在 src/demo.js。', confidence: 0.85 },
    ]
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
    this.started = []
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return this.models }

  async validateBotConfig() {}

  async startRun({ run, bot, task }) {
    this.started.push({ id: run.id, kind: run.kind, botId: run.bot_id, taskId: run.task_id ?? null })
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
        status: 'succeeded',
        output: run.kind === 'memory_review'
          ? JSON.stringify(this.memoryItems)
          : (task ? `Implemented ${task.title}.` : `Reply from ${bot.name}.`),
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
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timeout waiting for condition')
}

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

function insertRun(store, { id, projectId, botId, kind = 'task', mode = 'write' }) {
  const now = new Date().toISOString()
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
     VALUES (?, ?, ?, ?, ?, 'manual', 'succeeded', 1, ?, ?)`,
    id, projectId, botId, kind, mode, `test:${id}`, now,
  )
}

async function setup(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-acc-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`)
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new FakeRuntime(service, options)
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  return { root, workspace, config, store, service, runtime, director, dev }
}

test('归档项目会冻结记忆并拒绝新写入', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const actor = { type: 'user', id: service.localUserId }
    const project = await service.createProject({ name: 'Frozen', key: 'FRZ', ownerBotId: director.id, memberIds: [dev.id] })
    await service.createMemory({
      scopeType: 'project', scopeId: project.id, topic: '约定', content: '发布前跑测试。', actor,
    })
    await service.updateProject(project.id, { status: 'archived' }, actor)
    const frozen = store.all('SELECT * FROM memories WHERE scope_id = ?', project.id)
    assert.ok(frozen.length >= 1)
    assert.ok(frozen.every(item => item.status === 'frozen'))
    assert.throws(
      () => service.createMemory({ scopeType: 'project', scopeId: project.id, topic: '新记忆', content: '内容', actor }),
      /归档/,
    )
    assert.ok(store.get("SELECT COUNT(*) AS n FROM memory_events WHERE action = 'frozen'").n >= 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('团队记忆只有总监能写，成员 Bot 被拒绝', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Team', key: 'TEM', ownerBotId: director.id, memberIds: [dev.id] })
    assert.throws(
      () => service.createMemory({ scopeType: 'team', scopeId: 'team', topic: '规则', content: '内容', actor: { type: 'bot', id: dev.id } }),
      /总监/,
    )
    const memory = await service.createMemory({
      scopeType: 'team', scopeId: 'team', topic: '规则', content: '先跑测试再上线。', actor: { type: 'bot', id: director.id },
    })
    assert.equal(memory.scope_type, 'team')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('记忆检索按项目隔离并命中全文索引', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const alpha = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: director.id, memberIds: [dev.id] })
    const beta = await service.createProject({ name: 'Beta', key: 'BET', ownerBotId: director.id, memberIds: [dev.id] })
    const actor = { type: 'user', id: service.localUserId }
    await service.createMemory({
      scopeType: 'project', scopeId: alpha.id, topic: '发布流程', content: '发布前必须执行 npm test。', actor,
    })
    await service.createMemory({
      scopeType: 'project', scopeId: beta.id, topic: '其他流程', content: '与发布无关的内容。', actor,
    })
    const hits = service.searchMemories({ projectId: alpha.id, query: '发布前' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].scope_id, alpha.id)
    const otherHits = service.searchMemories({ projectId: beta.id, query: '发布前' })
    assert.equal(otherHits.length, 0)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('低置信度记忆进入待审队列，批准后生效', async () => {
  const { root, store, service, director, dev } = await setup({
    memoryItems: [{ scope: 'bot', topic: '推测', content: '可能需要先跑迁移。', confidence: 0.6 }],
  })
  try {
    const project = await service.createProject({ name: 'Review', key: 'REV', ownerBotId: director.id, memberIds: [dev.id] })
    await service.sendMessage(project.id, '/task @Builder 跑一次校验', { type: 'user', id: 'u1' })
    await waitFor(() => Number(store.get("SELECT COUNT(*) AS n FROM memories WHERE status = 'pending'").n) >= 1)
    const pending = store.get("SELECT * FROM memories WHERE status = 'pending'")
    assert.equal(pending.confidence, 0.6)
    const approved = await service.approveMemory(pending.id, { type: 'user', id: 'u1' })
    assert.equal(approved.status, 'active')
    assert.equal(approved.revision, 2)
    assert.match(approved.approved_by, /user/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('提案必须先有通过的评估才能批准', async () => {
  const { root, store, service, director } = await setup()
  try {
    const actor = { type: 'user', id: service.localUserId }
    const project = await service.createProject({ name: 'Prop', key: 'PRP', ownerBotId: director.id })
    const proposal = await service.createProposal({
      kind: 'skill', projectId: project.id, title: '新增技能', rationale: '重复劳动',
      payload: { slug: 'gate-skill', name: 'Gate', description: 'Gate skill', version: '1.0.0', content: '# Gate' },
    }, actor)
    await assert.rejects(() => service.decideProposal(proposal.id, 'approved', actor), /评估/)
    await service.evaluateProposal(proposal.id, { verdict: 'fail', notes: '内容不完整' }, actor)
    await assert.rejects(() => service.decideProposal(proposal.id, 'approved', actor), /评估/)
    await service.evaluateProposal(proposal.id, { verdict: 'pass', notes: '已补全' }, actor)
    const approved = await service.decideProposal(proposal.id, 'approved', actor)
    assert.equal(approved.status, 'approved')
    assert.equal(approved.evaluation.verdict, 'pass')
    assert.equal(approved.diff.version.to, '1.0.0')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('技能提案可灰度到项目并转正为全量', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const actor = { type: 'user', id: service.localUserId }
    const alpha = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: director.id, memberIds: [dev.id] })
    const beta = await service.createProject({ name: 'Beta', key: 'BET', ownerBotId: director.id, memberIds: [dev.id] })
    const proposal = await service.createProposal({
      kind: 'skill', projectId: alpha.id, title: '灰度技能', rationale: '先小范围验证',
      canary: { projectIds: [alpha.id] },
      payload: { slug: 'canary-skill', name: 'Canary', description: 'Canary skill', version: '1.0.0', content: '# Canary' },
    }, actor)
    await service.evaluateProposal(proposal.id, { verdict: 'pass', notes: '可以灰度' }, actor)
    const decided = await service.decideProposal(proposal.id, 'approved', actor)
    assert.equal(decided.status, 'canary')
    const bindings = service.skillBindings(alpha.id)
    assert.ok(bindings.some(item => item.slug === 'canary-skill' && item.status === 'canary'))
    // 灰度期间技能不进入全量池。
    assert.ok(!store.get("SELECT * FROM skills WHERE slug = 'canary-skill'"))
    const promoted = await service.promoteProposal(proposal.id, actor)
    assert.equal(promoted.status, 'approved')
    assert.ok(store.get("SELECT * FROM skills WHERE slug = 'canary-skill'"))
    assert.ok(service.skillBindings(beta.id).some(item => item.slug === 'canary-skill' && item.status === 'active'))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('技能可以回滚到历史版本', async () => {
  const { root, store, service, config, director } = await setup()
  try {
    await publishSkill(config, { slug: 'rb-skill', name: 'RB', description: '版本回滚', content: '# v1', version: '1.0.0' })
    await publishSkill(config, { slug: 'rb-skill', name: 'RB', description: '版本回滚', content: '# v2', version: '1.1.0' })
    assert.equal(readCurrentPointer(config.skillRoot, 'rb-skill').version, '1.1.0')
    const result = await service.rollbackSkillVersion('rb-skill', '1.0.0', { type: 'user', id: service.localUserId })
    assert.equal(result.version, '1.0.0')
    const pointer = readCurrentPointer(config.skillRoot, 'rb-skill')
    assert.equal(pointer.version, '1.0.0')
    const versions = store.all("SELECT version FROM skill_versions WHERE slug = 'rb-skill' ORDER BY version")
    assert.ok(versions.some(item => item.version === '1.0.0'))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('用量三档口径一致，按项目过滤，币种分列', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const alpha = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: director.id, memberIds: [dev.id] })
    const beta = await service.createProject({ name: 'Beta', key: 'BET', ownerBotId: director.id, memberIds: [dev.id] })
    insertRun(store, { id: 'run_a', projectId: alpha.id, botId: dev.id })
    insertRun(store, { id: 'run_b', projectId: beta.id, botId: director.id })
    recordUsage(store, {
      sourceKey: 'u:alpha', run: { id: 'run_a', project_id: alpha.id, bot_id: dev.id },
      provider: 'fake', model: 'model-a', usage: { inputTokens: 100, outputTokens: 10 },
    })
    recordUsage(store, {
      sourceKey: 'u:beta', run: { id: 'run_b', project_id: beta.id, bot_id: director.id },
      provider: 'fake', model: 'model-a', usage: { inputTokens: 200, outputTokens: 20 },
    })
    const state = await service.state(alpha.id)
    const usage = state.usage
    assert.equal(usage.global.totalTokens, 330)
    assert.equal(usage.project.totalTokens, 110)
    // 项目口径下只统计本项目的 Bot。
    const projectBots = usage.scopeTiers.project.byBot.map(item => item.id ?? item.botId)
    assert.ok(projectBots.every(id => !id || id === dev.id))
    assert.equal(usage.scopeTiers.project.byBot.length, 1)
    assert.equal(usage.scopeTiers.global.byBot.length, 2)
    // 项目口径汇总与分组行相加一致。
    const sum = usage.scopeTiers.project.byBot.reduce((acc, item) => acc + item.totalTokens, 0)
    assert.equal(sum, usage.project.totalTokens)
    // 未配置价格时不写 0，cost 为空且标记未定价。
    assert.equal(usage.project.costConfigured, false)
    assert.equal(usage.project.unpricedCalls, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('CSV 导出行数与用量事件一致', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Csv', key: 'CSV', ownerBotId: director.id, memberIds: [dev.id] })
    insertRun(store, { id: 'run_c', projectId: project.id, botId: dev.id })
    recordUsage(store, {
      sourceKey: 'u:csv:1', run: { id: 'run_c', project_id: project.id, bot_id: dev.id },
      provider: 'fake', model: 'model-a', usage: { inputTokens: 10, outputTokens: 2 },
    })
    const csv = exportUsageCsv(store, { projectId: project.id, days: 30 })
    const lines = csv.trim().split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0], /occurred_at/)
    assert.match(lines[0], /currency/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('对账把运行级用量修正到明细口径', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Recon', key: 'RCN', ownerBotId: director.id, memberIds: [dev.id] })
    const runId = 'run_recon'
    insertRun(store, { id: runId, projectId: project.id, botId: dev.id })
    store.run(
      'UPDATE runs SET usage_input = 0, usage_output = 0, ended_at = ? WHERE id = ?',
      new Date().toISOString(), runId,
    )
    recordUsage(store, {
      sourceKey: 'u:recon:1', run: { id: runId, project_id: project.id, bot_id: dev.id },
      provider: 'fake', model: 'model-a', usage: { inputTokens: 120, outputTokens: 30 },
    })
    const result = reconcileUsage(store, { days: 30 })
    assert.ok(result.repaired >= 1)
    const run = store.get('SELECT * FROM runs WHERE id = ?', runId)
    assert.equal(run.usage_input, 120)
    assert.equal(run.usage_output, 30)
    const record = store.get('SELECT * FROM usage_reconciliation WHERE run_id = ?', runId)
    assert.equal(record.status, 'repaired')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('数据保留按设置清理过期数据', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Keep', key: 'KEE', ownerBotId: director.id, memberIds: [dev.id] })
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString()
    store.run(
      `INSERT INTO usage_events(id, source_key, run_id, project_id, bot_id, provider, model, purpose, currency,
        input_tokens, output_tokens, occurred_at, created_at)
       VALUES ('use_old', 'old:1', NULL, ?, ?, 'fake', 'model-a', 'run', 'CNY', 10, 5, ?, ?)`,
      project.id, dev.id, old, old,
    )
    insertRun(store, { id: 'run_keep', projectId: project.id, botId: dev.id })
    recordUsage(store, {
      sourceKey: 'u:keep:1', run: { id: 'run_keep', project_id: project.id, bot_id: dev.id },
      provider: 'fake', model: 'model-a', usage: { inputTokens: 7, outputTokens: 3 },
    })
    const result = applyRetention(store, { usageDays: 30, runEventDays: 0, messageDays: 0 })
    assert.equal(result.usageEvents, 1)
    assert.ok(!store.get("SELECT * FROM usage_events WHERE source_key = 'old:1'"))
    assert.ok(store.get("SELECT * FROM usage_events WHERE source_key = 'u:keep:1'"))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('outbox 可靠交接：消息入库后必定产生回复运行', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Outbox', key: 'OBX', ownerBotId: director.id, memberIds: [dev.id] })
    await service.sendMessage(project.id, '汇报一下当前进度', { type: 'user', id: 'u1' })
    const rows = store.all("SELECT * FROM outbox WHERE kind = 'chat_run'")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'delivered')
    assert.ok(rows[0].delivered_at)
    assert.ok(store.get("SELECT id FROM runs WHERE kind = 'chat' AND project_id = ?", project.id))
    assert.equal(service.outboxCounts().failed, 0)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('outbox 投递失败会记录错误并标记 failed', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'OutboxFail', key: 'OBF', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: '无人认领' })
    service.enqueueOutbox({
      kind: 'task_run',
      payload: { taskId: task.id, triggerType: 'manual' },
      projectId: project.id,
      taskId: task.id,
      idempotencyKey: `task:${task.id}:manual`,
    })
    const row = store.get("SELECT * FROM outbox WHERE idempotency_key = ?", `task:${task.id}:manual`)
    assert.equal(row.status, 'failed')
    assert.equal(row.attempts, 1)
    assert.match(row.last_error, /负责人/)
    assert.equal(service.outboxCounts().failed, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('重启后调度器补投未投递的 outbox 记录', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'OutboxRedeliver', key: 'OBR', ownerBotId: director.id, memberIds: [dev.id] })
    const messageId = service.insertMessage({
      projectId: project.id, senderType: 'user', senderId: 'u1', body: '补投这条消息',
    })
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO outbox(id, kind, project_id, source_id, idempotency_key, payload_json, status, attempts, available_at, created_at)
       VALUES (?, 'chat_run', ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      'obx_pending_1', project.id, messageId, `chat:${messageId}:${dev.id}`,
      JSON.stringify({ projectId: project.id, botId: dev.id, messageId }), now, now,
    )
    service.dispatchOutbox()
    const row = store.get("SELECT * FROM outbox WHERE id = ?", 'obx_pending_1')
    assert.equal(row.status, 'delivered')
    assert.ok(store.get("SELECT id FROM runs WHERE kind = 'chat' AND trigger_ref = ?", messageId))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
