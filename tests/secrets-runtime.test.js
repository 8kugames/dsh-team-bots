import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync, utimesSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { nowIso, id } from '../src/util.js'

// DSHBOTS-106 一次性密钥运行时：明文只在批准后写 <dataDir>/secrets-runtime/<projectId>.env，
// 三种先到者焚毁——任务运行 finishRun / TTL / 吊销删除；旧 .team/secrets.env 残留迁移清理。
class ManualRuntime {
  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  sessionBusy() { return false }

  async startRun({ run }) { return `session-${run.id}` }

  async steer() { return true }

  async cancelRun() { return true }
}

async function runtimeSetup({ ttlMs } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-secrets-rt-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({
    workspace, dataDir,
    skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000,
    ...(ttlMs ? { secretsRuntimeTtlMs: ttlMs } : {}),
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Runner', role: '开发', instructions: 'Run.', provider: 'fake', model: 'model-a',
  })
  const project = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: director.id, memberIds: [dev.id] })
  const runtimeEnvOf = projectId => join(dataDir, 'secrets-runtime', `${projectId}.env`)
  const legacyEnvOf = () => join(workspace, project.slug, '.team', 'secrets.env')

  // 走完整申请-批准链路，返回一次性文件路径。
  let requestSeq = 0
  const approve = async (value = 'rt_live_1234567890') => {
    requestSeq += 1
    const sessionId = `sess-rt-${requestSeq}`
    store.run(
      "INSERT OR REPLACE INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, 'project', ?)",
      sessionId, dev.id, project.id, nowIso(),
    )
    const request = service.requestSecretFromBot({ sessionId, name: 'RT_KEY', reason: '运行时测试' })
    await service.approveSecretRequest(request.requestId, { value })
    return runtimeEnvOf(project.id)
  }
  // 插一条挂起中的运行行（kind 可指定），finishRun 直接驱动它到终态。
  const insertRun = (kind) => {
    const runId = id('run')
    store.run(
      "INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at) VALUES (?, ?, ?, NULL, ?, 'read', 'test', 'running', 1, ?, ?)",
      runId, project.id, dev.id, kind, `test:${runId}`, nowIso(),
    )
    return runId
  }
  const auditOf = (action, targetId = project.id) =>
    store.all('SELECT * FROM audit_log WHERE action = ? AND target_id = ?', action, targetId)
  return { root, store, service, project, workspace, dataDir, runtimeEnvOf, legacyEnvOf, approve, insertRun, auditOf }
}

async function closeQuietly(store, root) {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

test('批准后一次性文件落在数据目录而非项目工作区，权限 0600/0700，回执披露路径', async () => {
  const ctx = await runtimeSetup()
  try {
    const envPath = await ctx.approve()
    assert.equal(existsSync(envPath), true, '批准后一次性文件应存在')
    assert.ok(envPath.startsWith(join(ctx.dataDir, 'secrets-runtime')), '路径必须在数据目录下')
    assert.equal(statSync(envPath).mode & 0o777, 0o600, '文件必须 0600')
    assert.equal(statSync(join(ctx.dataDir, 'secrets-runtime')).mode & 0o777, 0o700, '目录必须 0700')
    const contents = await readFile(envPath, 'utf8')
    assert.ok(contents.includes('RT_KEY=rt_live_1234567890\n'))
    // 项目工作区不出现任何明文文件（.team 目录整个不存在）。
    assert.equal(existsSync(ctx.legacyEnvOf()), false)
    assert.equal(existsSync(join(ctx.workspace, ctx.project.slug, '.team')), false)
    // 批准回执披露数据目录路径与即焚语义。
    const receipt = ctx.store.get(
      "SELECT body FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '%已批准%' ORDER BY created_at DESC LIMIT 1",
      ctx.project.id,
    )
    assert.ok(receipt.body.includes(envPath))
    assert.ok(receipt.body.includes('自动焚毁'))
    // 物化审计带 projectId 不带值。
    const materialized = ctx.auditOf('secret.materialize')
    assert.equal(materialized.length, 1)
    const data = JSON.parse(materialized[0].data_json)
    assert.ok(!JSON.stringify(data).includes('rt_live_1234567890'), '审计不得含明文值')
    assert.equal(typeof data.ttlMs, 'number')
  } finally {
    await closeQuietly(ctx.store, ctx.root)
  }
})

test('项目下一条任务运行 finishRun 即焚（成功失败都焚），再次批准重新物化', async () => {
  const ctx = await runtimeSetup()
  try {
    // 失败也焚。
    let envPath = await ctx.approve('burn_fail_12345678')
    assert.equal(existsSync(envPath), true)
    const failedRun = ctx.insertRun('task')
    await ctx.service.finishRun({ runId: failedRun, status: 'failed', error: { code: 'E_TEST', message: 'boom' } })
    assert.equal(existsSync(envPath), false, 'task 运行失败结束也要焚毁')
    assert.ok(ctx.auditOf('secret.burn').some(row => JSON.parse(row.data_json).reason === 'run_finish'))

    // 重新批准 → 重新物化（一次批准一次可用）；成功结束同样焚毁。
    envPath = await ctx.approve('burn_ok_1234567')
    assert.equal(existsSync(envPath), true, '再次批准必须重新物化')
    const okRun = ctx.insertRun('task')
    await ctx.service.finishRun({ runId: okRun, status: 'succeeded', output: 'done' })
    assert.equal(existsSync(envPath), false, 'task 运行成功结束也要焚毁')
  } finally {
    await closeQuietly(ctx.store, ctx.root)
  }
})

test('非任务运行结束不焚毁，TTL 到期由巡检焚毁', async () => {
  const ctx = await runtimeSetup()
  try {
    const envPath = await ctx.approve('ttl_probe_123456')
    const chatRun = ctx.insertRun('chat')
    await ctx.service.finishRun({ runId: chatRun, status: 'succeeded', output: 'hi' })
    assert.equal(existsSync(envPath), true, '非任务运行结束不得误焚（文件留待 TTL）')

    // 把 mtime 回拨一小时，默认 TTL 30 分钟即视为过期；巡检焚毁。
    const hourAgo = new Date(Date.now() - 60 * 60_000)
    utimesSync(envPath, hourAgo, hourAgo)
    ctx.service.sweepSecretsRuntime()
    assert.equal(existsSync(envPath), false, 'TTL 过期必须由巡检焚毁')
    assert.ok(ctx.auditOf('secret.burn').some(row => JSON.parse(row.data_json).reason === 'ttl'))
  } finally {
    await closeQuietly(ctx.store, ctx.root)
  }
})

test('TTL 可经 config 配置，未过期的不焚', async () => {
  const ctx = await runtimeSetup({ ttlMs: 24 * 60 * 60_000 })
  try {
    const envPath = await ctx.approve('ttl_long_1234567')
    const hourAgo = new Date(Date.now() - 60 * 60_000)
    utimesSync(envPath, hourAgo, hourAgo)
    ctx.service.sweepSecretsRuntime()
    assert.equal(existsSync(envPath), true, '未到 TTL 不得焚毁')
    assert.equal(ctx.auditOf('secret.burn').length, 0)
  } finally {
    await closeQuietly(ctx.store, ctx.root)
  }
})

test('吊销/删除密钥即焚一次性文件', async () => {
  const ctx = await runtimeSetup()
  try {
    const envPath = await ctx.approve('revoke_me_123456')
    assert.equal(existsSync(envPath), true)
    const secretRow = ctx.store.get("SELECT * FROM secrets WHERE name = 'RT_KEY'")
    await ctx.service.deleteSecret(secretRow.id)
    assert.equal(existsSync(envPath), false, '吊销必须当场焚毁')
    assert.ok(ctx.auditOf('secret.burn').some(row => JSON.parse(row.data_json).reason === 'secret_delete'))
  } finally {
    await closeQuietly(ctx.store, ctx.root)
  }
})

test('旧 .team/secrets.env 残留在启动巡检时迁移清理', async () => {
  const ctx = await runtimeSetup()
  try {
    // 先批准拿一个运行时文件，证明巡检只清项目侧残留、不动数据目录。
    const envPath = await ctx.approve('legacy_probe_12345')
    await mkdir(join(ctx.workspace, ctx.project.slug, '.team'), { recursive: true })
    await writeFile(ctx.legacyEnvOf(), 'RT_KEY=legacy_plaintext_should_die\n')
    ctx.service.sweepSecretsRuntime()
    assert.equal(existsSync(ctx.legacyEnvOf()), false, '项目侧旧残留必须清理')
    assert.equal(existsSync(join(ctx.workspace, ctx.project.slug, '.team')), false, '空 .team 目录一并收走')
    assert.equal(existsSync(envPath), true, '数据目录一次性文件不受残留清理影响')
  } finally {
    await closeQuietly(ctx.store, ctx.root)
  }
})
