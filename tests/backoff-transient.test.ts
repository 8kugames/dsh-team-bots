// DSHBOTS-266：网络瞬态失败（ECONNRESET/5xx/408 等过性错误）分类接入既有重试链。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import {
  TRANSIENT_PATTERN,
  isTransientNetworkError,
  needsTransientBackoff,
  transientBackoffMs,
} from '../src/services/backoff.js'

// 不真正启动会话：finishRun / 派生逻辑全部用直接落库的 run 行驱动。
class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-transient-'))
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

// a) 纯函数分类 ─────────────────────────────────────────────────────────────

test('TRANSIENT_PATTERN：各过性错误串命中（错误码与正文双通道）', () => {
  const hits = [
    { code: 'ECONNRESET', message: 'read ECONNRESET' },
    { code: null, message: 'connect ECONNREFUSED 127.0.0.1:443' },
    { code: null, message: 'ETIMEDOUT waiting for response' },
    { code: null, message: 'dns lookup EAI_AGAIN api.example.com' },
    { code: null, message: 'write EPIPE' },
    { code: null, message: 'UND_ERR_HEADERS timeout' },
    { code: null, message: 'socket hang up' },
    { code: null, message: 'fetch failed' },
    { code: null, message: 'Overloaded' },
    { code: null, message: 'Request failed with status 502' },
    { code: null, message: 'HTTP 408 request timeout' },
    { code: 'HTTP_503', message: 'upstream error' }, // 错误码通道命中
    { code: 'RUN_FAILED', message: 'fetch failed' }, // 码无关、正文命中
  ]
  for (const error of hits) {
    assert.ok(TRANSIENT_PATTERN.test(`${error.code ?? ''} ${error.message}`), `应命中: ${JSON.stringify(error)}`)
    assert.ok(isTransientNetworkError(error), `isTransientNetworkError 应为 true: ${JSON.stringify(error)}`)
  }
})

test('限流/额度分类优先级不变：不误入 transient', () => {
  assert.equal(isTransientNetworkError({ code: 'RATE_LIMIT', message: 'rate limit' }), false)
  // 限流码 + 正文带瞬态词：仍走限流路径（429 吃服务端 retry_after）。
  assert.equal(isTransientNetworkError({ code: 'RATE_LIMIT', message: 'fetch failed' }), false)
  assert.equal(isTransientNetworkError({ code: 'QUOTA', message: 'quota exceeded' }), false)
  assert.equal(isTransientNetworkError({ code: 'ACCOUNT_QUOTA', message: '已达上限' }), false)
  // 额度耗尽靠正文判定时同样不进瞬态（切备用模型路径）。
  assert.equal(isTransientNetworkError({ code: 'MODEL_ERROR', message: '额度不足 overloaded' }), false)
  assert.equal(needsTransientBackoff({ code: 'RATE_LIMIT', message: 'rate limit' }), false)
})

test('常规错误不命中瞬态', () => {
  assert.equal(isTransientNetworkError({ code: 'AUTH', message: 'bad api key' }), false)
  assert.equal(isTransientNetworkError({ code: 'RUN_STALLED', message: '超过 30 分钟没有任何进展，已中止' }), false)
  assert.equal(isTransientNetworkError({ code: null, message: '模型未返回文本' }), false)
  // 1408x / 75038 之类的长数字不得被数字锚点误伤。
  assert.equal(isTransientNetworkError({ code: 'MODEL_ERROR', message: 'invalid model id gpt-1408x' }), false)
  assert.equal(isTransientNetworkError({ code: 'AUTH', message: 'account 75038 expired' }), false)
})

test('transientBackoffMs：15s 起步翻倍，非法 attempt 按 1 计', () => {
  assert.equal(transientBackoffMs(1), 15_000)
  assert.equal(transientBackoffMs(2), 30_000)
  assert.equal(transientBackoffMs(3), 60_000)
  assert.equal(transientBackoffMs(0), 15_000)
  assert.equal(transientBackoffMs(null), 15_000)
  assert.equal(transientBackoffMs(undefined), 15_000)
})

// b/c/d/e) 链路行为 ─────────────────────────────────────────────────────────

test('ECONNRESET 失败：合成退避落 retry_after_ms，到期派生重排队 attempt+1，不等 owner', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'TR Project', key: 'TRPROJ', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '瞬态失败', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'tr1', projectId: project.id, botId: director.id, taskId: task.id })
    await service.finishRun({
      runId: 'tr1', status: 'failed', output: '',
      error: { code: 'ECONNRESET', message: 'read ECONNRESET' },
    })
    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'tr1'").retry_after_ms, 15_000)
    const evt = store.get("SELECT * FROM run_events WHERE run_id = 'tr1' AND type = 'transient_backoff'")
    assert.ok(evt, '应写 transient_backoff 事件')
    assert.match(evt.message, /第 1 次退避/)
    // 不切备用模型、不派生重试运行（等 plan_retry 到期）、不排总监处理——不是等 owner 的终局 blocked。
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = \'tr1\'').n, 0, '不应立刻派生备用/重试运行')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'owner_task_run' AND task_id = ?", task.id).n, 0,
      'attempt<上限不应排 owner handle',
    )
    const msg = store.get("SELECT body FROM messages WHERE run_id = 'tr1' AND body LIKE '任务执行失败%'")
    assert.match(msg.body, /网络瞬态失败，第 1 次退避/)
    assert.match(msg.body, /后自动重试/)

    // 退避到期（回拨 ended_at）→ 复用既有 plan_wait 派生：重排队、attempt+1。
    store.run("UPDATE runs SET ended_at = ? WHERE id = 'tr1'", mins(-1))
    service.retryExpiredPlanWaits()
    const derived = store.get("SELECT * FROM runs WHERE parent_run_id = 'tr1'")
    assert.ok(derived, '到期应派生重试 run')
    assert.equal(derived.attempt, 2)
    assert.equal(derived.trigger_type, 'plan_retry')
    assert.equal(derived.status, 'queued')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('正文命中同样进链：RUN_FAILED + fetch failed 到期派生', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'TM Project', key: 'TMPROJ', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '正文瞬态', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'tm1', projectId: project.id, botId: director.id, taskId: task.id, attempt: 2 })
    await service.finishRun({
      runId: 'tm1', status: 'failed', output: '',
      error: { code: 'RUN_FAILED', message: 'fetch failed' },
    })
    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'tm1'").retry_after_ms, transientBackoffMs(2))
    store.run("UPDATE runs SET ended_at = ? WHERE id = 'tm1'", mins(-1))
    service.retryExpiredPlanWaits()
    const derived = store.get("SELECT * FROM runs WHERE parent_run_id = 'tm1'")
    assert.ok(derived, '正文命中的瞬态失败同样派生')
    assert.equal(derived.attempt, 3)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('第 4 次 transient（attempt=3 链耗尽）：照常转 blocked + 延迟总监处理', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'EX Project', key: 'EXPROJ', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '链耗尽', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'ex3', projectId: project.id, botId: director.id, taskId: task.id, attempt: 3 })
    await service.finishRun({
      runId: 'ex3', status: 'failed', output: '',
      error: { code: 'ECONNRESET', message: 'read ECONNRESET' },
    })
    assert.equal(store.get("SELECT status FROM tasks WHERE id = ?", task.id).status, 'blocked', '链耗尽任务转 blocked')
    const handle = store.get("SELECT * FROM outbox WHERE kind = 'owner_task_run' AND task_id = ?", task.id)
    assert.ok(handle, '链耗尽应排总监处理')
    assert.ok(handle.available_at > new Date().toISOString(), `available_at 应延迟到退避期满，实际 ${handle.available_at}`)
    // attempt=3 不再派生第 4 次。
    store.run("UPDATE runs SET ended_at = ? WHERE id = 'ex3'", mins(-1))
    service.retryExpiredPlanWaits()
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = \'ex3\'').n, 0, '不再派生')
    const msg = store.get("SELECT body FROM messages WHERE run_id = 'ex3' AND body LIKE '任务执行失败%'")
    assert.match(msg.body, /已达自动重试上限/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('非 transient 常规错误：立即 blocked + 立即投递 handle（现状不变）', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'NT Project', key: 'NTPROJ', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '常规失败', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'nt1', projectId: project.id, botId: director.id, taskId: task.id })
    await service.finishRun({
      runId: 'nt1', status: 'failed', output: '',
      error: { code: 'AUTH', message: 'bad api key' },
    })
    const run = store.get("SELECT retry_after_ms, error_code FROM runs WHERE id = 'nt1'")
    assert.equal(run.retry_after_ms, null, '常规错误不合成退避')
    assert.equal(store.get("SELECT status FROM tasks WHERE id = ?", task.id).status, 'blocked', '立即转 blocked')
    const handle = store.get("SELECT * FROM outbox WHERE kind = 'owner_task_run' AND task_id = ?", task.id)
    assert.ok(handle, '常规失败立即排 handle')
    assert.ok(
      new Date(handle.available_at).getTime() <= Date.now() + 1_000,
      `无退避延迟应立即可投递，实际 ${handle.available_at}`,
    )
    store.run("UPDATE runs SET ended_at = ? WHERE id = 'nt1'", mins(-1))
    service.retryExpiredPlanWaits()
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = \'nt1\'').n, 0, '不进重试链')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('429 仍走限流路径：真 Retry-After 优先，不被瞬态合成值覆盖', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'RL Project', key: 'RLPROJ', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '限流优先', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'rl1', projectId: project.id, botId: director.id, taskId: task.id })
    await service.finishRun({
      runId: 'rl1', status: 'failed', output: '',
      error: { code: 'RATE_LIMIT', message: 'rate limit', retryAfterMs: 120_000 },
    })
    const run = store.get("SELECT retry_after_ms FROM runs WHERE id = 'rl1'")
    assert.equal(run.retry_after_ms, 120_000, '服务端 retry_after 原样保留')
    assert.notEqual(run.retry_after_ms, transientBackoffMs(1), '不用瞬态合成值')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'rl1' AND type = 'transient_backoff'").n, 0,
      '限流失败不写瞬态事件',
    )
    const evt = store.get("SELECT * FROM run_events WHERE run_id = 'rl1' AND type = 'rate_limit_backoff'")
    assert.equal(evt, undefined, '有真值时不写合成退避事件')
    const msg = store.get("SELECT body FROM messages WHERE run_id = 'rl1' AND body LIKE '任务执行失败%'")
    assert.match(msg.body, /上游限流/)
    assert.doesNotMatch(msg.body, /网络瞬态失败/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
