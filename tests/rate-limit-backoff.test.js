// DSHBOTS-38：限流失败（无 Retry-After）合成指数退避，等待期内禁止立刻重打上游。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { rateLimitBackoffMs } from '../src/services/backoff.js'

// 不真正启动会话：finishRun / 派生逻辑全部用直接落库的 run 行驱动。
class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rate-backoff-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

const mins = n => new Date(Date.now() + n * 60_000).toISOString()

// 落一条 running 的任务 run，交给 finishRun 走真实失败路径。
function insertRunningRun(store, { id, projectId, botId, taskId, attempt = 1 }) {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, status, attempt, idempotency_key, queued_at, started_at)
     VALUES (?, ?, ?, ?, 'task', 'manual', 'running', ?, ?, ?, ?)`,
    id, projectId, botId, taskId, attempt, `idem-${id}`, mins(-2), mins(-2),
  )
}

test('rateLimitBackoffMs：1 分钟起步、翻倍递进、30 分钟封顶，非法 attempt 按 1 计', () => {
  assert.equal(rateLimitBackoffMs(1), 60_000)
  assert.equal(rateLimitBackoffMs(2), 120_000)
  assert.equal(rateLimitBackoffMs(3), 240_000)
  assert.equal(rateLimitBackoffMs(6), 1_800_000, '第 6 次起触顶')
  assert.equal(rateLimitBackoffMs(9), 1_800_000, '封顶后不再增长')
  assert.equal(rateLimitBackoffMs(0), 60_000)
  assert.equal(rateLimitBackoffMs(null), 60_000)
  assert.equal(rateLimitBackoffMs(undefined), 60_000)
})

test('RATE_LIMIT 无 Retry-After：finishRun 合成 retry_after_ms 并写 rate_limit_backoff 事件', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'SB Project', key: 'SBPROJ', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '合成退避', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'sb1', projectId: project.id, botId: director.id, taskId: task.id })
    await service.finishRun({
      runId: 'sb1', status: 'failed', output: '',
      error: { code: 'RATE_LIMIT', message: 'upstream rate-limited (bili_throttle_terminal)' },
    })
    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'sb1'").retry_after_ms, rateLimitBackoffMs(1))
    const evt = store.get("SELECT * FROM run_events WHERE run_id = 'sb1' AND type = 'rate_limit_backoff'")
    assert.ok(evt, '应写 rate_limit_backoff 事件')
    assert.match(evt.message, /第 1 次退避/)
    const msg = store.get('SELECT body FROM messages WHERE task_id = ? ORDER BY created_at DESC', task.id)
    assert.ok(msg, '任务失败消息应存在')
    assert.match(msg.body, /指数退避/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('禁止立刻重打：attempt<上限不排总监处理运行；链耗尽才延迟投递 handle', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'NH Project', key: 'NHPROJ', ownerBotId: director.id })
    const task1 = await service.createTask({ projectId: project.id, title: '第一次限流', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'nh1', projectId: project.id, botId: director.id, taskId: task1.id, attempt: 1 })
    await service.finishRun({
      runId: 'nh1', status: 'failed', output: '',
      error: { code: 'RATE_LIMIT', message: 'rate limit' },
    })
    // attempt=1：交给 plan_retry 到期派生，不排 owner handle，也不切备用模型。
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'owner_task_run' AND task_id = ?", task1.id).n, 0,
      'attempt<上限不应排 handle',
    )
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'nh1'").n, 0,
      '不应立刻派生备用/重试运行',
    )

    // attempt=3（链耗尽）：排 handle，但延迟到退避期满才可投递。
    const task3 = await service.createTask({ projectId: project.id, title: '链耗尽', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'nh3', projectId: project.id, botId: director.id, taskId: task3.id, attempt: 3 })
    await service.finishRun({
      runId: 'nh3', status: 'failed', output: '',
      error: { code: 'RATE_LIMIT', message: 'rate limit' },
    })
    const row = store.get("SELECT * FROM outbox WHERE kind = 'owner_task_run' AND task_id = ?", task3.id)
    assert.ok(row, '链耗尽应排 handle')
    assert.ok(row.available_at > nowIsoStrict(), `available_at 应在未来，实际 ${row.available_at}`)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND status = 'queued'", task3.id).n, 0,
      'handle 运行不应在退避期内生成')
    const msg = store.get('SELECT body FROM messages WHERE task_id = ? ORDER BY created_at DESC', task3.id)
    assert.match(msg.body, /已达自动重试上限/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('到期派生：attempt=1 可派生、attempt=3 不派生、非限流码不进派生', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'RD Project', key: 'RDPROJ', ownerBotId: director.id })
    const mk = (id, taskId, code, attempt, retryMs = 600_000, endedMin = -11) => store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, status, attempt, idempotency_key,
         error_code, retry_after_ms, queued_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, 'task', 'manual', 'failed', ?, ?, ?, ?, ?, ?, ?)`,
      id, project.id, director.id, taskId, attempt, `idem-${id}`, code, retryMs, mins(-20), mins(-20), mins(endedMin),
    )
    const t1 = await service.createTask({ projectId: project.id, title: '首败', assigneeBotId: director.id })
    mk('rd1', t1.id, 'RATE_LIMIT', 1)
    const t3 = await service.createTask({ projectId: project.id, title: '末败', assigneeBotId: director.id })
    mk('rd3', t3.id, 'RATE_LIMIT', 3)
    const tn = await service.createTask({ projectId: project.id, title: '非限流', assigneeBotId: director.id })
    mk('rdn', tn.id, 'AUTH', 1)

    service.retryExpiredPlanWaits()
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'rd1'").n, 1, 'attempt=1 到期应派生')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'rd3'").n, 0, 'attempt=3 不再派生')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'rdn'").n, 0, '非限流码不派生')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('真 Retry-After 优先：不被合成值覆盖，也不写退避事件', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'RA Project', key: 'RAPROJ', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '真退避头', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'ra1', projectId: project.id, botId: director.id, taskId: task.id })
    await service.finishRun({
      runId: 'ra1', status: 'failed', output: '',
      error: { code: 'RATE_LIMIT', message: 'rate limit', retryAfterMs: 120_000 },
    })
    const run = store.get("SELECT retry_after_ms FROM runs WHERE id = 'ra1'")
    assert.equal(run.retry_after_ms, 120_000, '真值保留')
    assert.notEqual(run.retry_after_ms, rateLimitBackoffMs(1), '不能被合成值覆盖')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'ra1' AND type = 'rate_limit_backoff'").n, 0,
      '有真值时不写合成退避事件',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

function nowIsoStrict() { return new Date().toISOString() }
