// DSHBOTS-99：达到限额不指数退避——先切备用模型，主备都限额才进受阻。
// 用户口径（2026-11-03）：「如果提示达到限额，不要做指数退避，有备用模型直接切备用模型，
// 只有当备用模型和主模型都限额了才进受阻。」
// 瞬时限流（网关节流、秒级 Retry-After）保持原语义：退避重打，不切备用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { isQuotaExhausted, needsSynthesizedBackoff, rateLimitBackoffMs } from '../src/services/backoff.js'
import { shouldFallbackOn } from '../src/services/model-fallback.js'

// 不真正启动会话：finishRun / 派生逻辑全部用直接落库的 run 行驱动。
class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quota-'))
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

// 线上真实失败形态（生产库 ~/.dsh/workspace/team-bots/.data/team.sqlite 实测）：
// 形态 B —— Token Plan 用量上限，正文是 JSON，内嵌 (2056) 额度码，中文措辞是「用量上限」。
const TOKEN_PLAN_LIMIT_MESSAGE = '429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"},"request_id":"07379df9c0d859b797721b746c26d38e"}'
// 英文形态：正文只有 "code":"1308"，没有任何中文额度措辞——靠内嵌码锚点命中。
const ENGLISH_LIMIT_MESSAGE = '429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-11-02 15:17:01"}'

// 落一条 running 的任务 run，交给 finishRun 走真实失败路径。
function insertRunningRun(store, { id, projectId, botId, taskId, attempt = 1, modelProvider = null }) {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, status, attempt, idempotency_key,
       model_provider, model_model, queued_at, started_at)
     VALUES (?, ?, ?, ?, 'task', 'manual', 'running', ?, ?, ?, ?, ?, ?)`,
    id, projectId, botId, taskId, attempt, `idem-${id}`,
    modelProvider, modelProvider ? `${modelProvider}/fallback-model` : null,
    mins(-2), mins(-2),
  )
}

async function withFallback(service, botId, { provider = 'openai', model = 'gpt-4o-mini' } = {}) {
  return service.updateBot(botId, { fallbackProvider: provider, fallbackModel: model }, { type: 'user', id: 'u' })
}

// 任务失败消息：每次失败每 run 恰一条，用 run_id 定位（毫秒并列时 ORDER BY 会拿错行）。
function failureMessage(store, runId) {
  return store.get('SELECT body FROM messages WHERE run_id = ? AND body LIKE ?', runId, '任务执行失败%')?.body ?? ''
}

test('额度判定：额度码/限额语义/长窗口重置算耗尽，网关节流与短 Retry-After 不算', () => {
  assert.equal(isQuotaExhausted({ code: '1308', message: '已达到 5 小时的使用上限' }), true)
  assert.equal(isQuotaExhausted({ code: 'ACCOUNT_QUOTA', message: 'account quota used up' }), true)
  assert.equal(isQuotaExhausted({ code: 'QUOTA', message: 'quota exceeded' }), true)
  assert.equal(isQuotaExhausted({ code: 'RATE_LIMIT', message: '已达到 5 小时的使用上限' }), true, '限额语义优先于错误码')
  assert.equal(isQuotaExhausted({ code: 'RATE_LIMIT', message: 'rate limit', retryAfterMs: 6 * 60_000 }), true, '长窗口重置算额度')
  assert.equal(isQuotaExhausted({ code: 'RATE_LIMIT', message: 'rate limit', retryAfterMs: 30_000 }), false, '秒级 Retry-After 是瞬时抖动')
  assert.equal(isQuotaExhausted({ code: 'RATE_LIMIT', message: 'upstream rate-limited (bili_throttle_terminal)' }), false)
  assert.equal(isQuotaExhausted({ code: 'RATE_LIMIT', message: 'bili_throttle_hold' }), false)
  assert.equal(isQuotaExhausted({ code: 'AUTH', message: 'bad key' }), false)
  // 额度耗尽不合成指数退避；瞬时限流维持原语义。
  assert.equal(needsSynthesizedBackoff({ code: '1308', message: '已达到 5 小时的使用上限' }), false)
  assert.equal(needsSynthesizedBackoff({ code: 'RATE_LIMIT', message: 'rate limit' }), true)
  assert.equal(needsSynthesizedBackoff({ code: 'RATE_LIMIT', message: 'rate limit', retryAfterMs: 30_000 }), false)
  // 额度耗尽该切备用；带短 Retry-After 的瞬时限流仍然等待不切。
  assert.equal(shouldFallbackOn({ code: '1308', message: '已达到 5 小时的使用上限' }), true)
  assert.equal(shouldFallbackOn({ code: 'QUOTA', message: 'quota', retryAfterMs: 5 * 60_000 }), true)
  assert.equal(shouldFallbackOn({ code: 'RATE_LIMIT', message: 'rate limit', retryAfterMs: 30_000 }), false)
})

test('额度耗尽（1308）：不合成退避、切备用模型、任务不置 blocked', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Q1', key: 'Q1', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '达到限额', assigneeBotId: director.id })
    await withFallback(service, director.id, { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' })
    insertRunningRun(store, { id: 'q1', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({
      runId: 'q1', status: 'failed', output: '',
      error: { code: '1308', message: '已达到 5 小时的使用上限' },
    })

    const run = store.get("SELECT * FROM runs WHERE id = 'q1'")
    assert.equal(run.retry_after_ms, null, '额度耗尽不合成退避值')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'q1' AND type = 'rate_limit_backoff'").n, 0,
      '不写指数退避事件',
    )
    const derived = store.get("SELECT * FROM runs WHERE parent_run_id = 'q1'")
    assert.ok(derived, '应派生备用模型运行')
    assert.equal(derived.model_provider, 'minimax-cn')
    assert.equal(derived.model_model, 'MiniMax-M3.1-Flash')
    assert.equal(derived.status, 'queued')
    assert.notEqual(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'blocked', '切备用后任务不置 blocked')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'owner_task_run' AND task_id = ?", task.id).n, 0,
      '不排总监处理运行',
    )
    const body = failureMessage(store, 'q1')
    assert.equal(body, '', '切备用时不发失败消息')
    const msg = store.get("SELECT body FROM messages WHERE run_id = 'q1' AND body LIKE '%已切换备用模型%'")
    assert.ok(msg, '应告知已切备用模型')
    assert.match(msg.body, /已达限额（1308）/)
    assert.match(msg.body, /minimax-cn\/MiniMax-M3\.1-Flash/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('额度耗尽且无备用：任务直接转受阻，不派生运行，文案写明限额', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Q2', key: 'Q2', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '无备用限额', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'q2', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({
      runId: 'q2', status: 'failed', output: '',
      error: { code: '1308', message: '已达到 5 小时的使用上限' },
    })

    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?', 'q2').n, 0, '无备用不派生')
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'blocked')
    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'q2'").retry_after_ms, null)
    const body = failureMessage(store, 'q2')
    assert.match(body, /限额/)
    assert.match(body, /主备模型均不可用，任务转为受阻/)
    assert.doesNotMatch(body, /指数退避/, '额度耗尽消息不用指数退避字样')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('主备都限额才进受阻：备用运行再次额度耗尽 → 不派生、不重试、任务转受阻', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Q3', key: 'Q3', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '主备都限额', assigneeBotId: director.id })
    await withFallback(service, director.id, { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' })
    insertRunningRun(store, { id: 'q3', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({
      runId: 'q3', status: 'failed', output: '',
      error: { code: '1308', message: '已达到 5 小时的使用上限' },
    })
    const fallbackRun = store.get("SELECT * FROM runs WHERE parent_run_id = 'q3'")
    assert.ok(fallbackRun, '主模型限额先切备用')
    assert.notEqual(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'blocked')

    // 备用模型也限额：不再派生、不再退避、任务转受阻。
    store.run("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?", mins(-1), fallbackRun.id)
    await service.finishRun({
      runId: fallbackRun.id, status: 'failed', output: '',
      error: { code: '1308', message: '已达到 5 小时的使用上限' },
    })
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?', fallbackRun.id).n, 0, '不再派生')
    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = ?", fallbackRun.id).retry_after_ms, null, '不再退避')
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'blocked')
    const body = failureMessage(store, fallbackRun.id)
    assert.match(body, /主备模型均不可用，任务转为受阻/)
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'owner_task_run' AND task_id = ?", task.id).n, 0,
      '不再派总监处理运行',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('瞬时限流（短 Retry-After）：仍走退避等待、不切备用（不回归 D-38/D-24）', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Q4', key: 'Q4', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '瞬时限流', assigneeBotId: director.id })
    await withFallback(service, director.id, { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' })
    insertRunningRun(store, { id: 'q4', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({
      runId: 'q4', status: 'failed', output: '',
      error: { code: 'RATE_LIMIT', message: 'upstream rate-limited (bili_throttle_terminal)', retryAfterMs: 30_000 },
    })

    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'q4'").retry_after_ms, 30_000, '真 Retry-After 保留')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?', 'q4').n, 0, '等待期内不切备用')
    const body = failureMessage(store, 'q4')
    assert.match(body, /上游限流/)
    const row = service.projectView(service.projectRow(project.id)).members.find(m => m.id === director.id)
    assert.equal(row.run_status, 'plan_wait', '仍显示 plan_wait')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('瞬时限流（无 Retry-After）：仍合成指数退避（不回归 D-38）', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Q5', key: 'Q5', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '合成退避', assigneeBotId: director.id })
    insertRunningRun(store, { id: 'q5', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({
      runId: 'q5', status: 'failed', output: '',
      error: { code: 'RATE_LIMIT', message: 'upstream rate-limited (bili_throttle_hold)' },
    })

    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'q5'").retry_after_ms, rateLimitBackoffMs(1))
    const evt = store.get("SELECT * FROM run_events WHERE run_id = 'q5' AND type = 'rate_limit_backoff'")
    assert.ok(evt, '仍写退避事件')
    assert.match(failureMessage(store, 'q5'), /指数退避/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('scheduler 不为额度耗尽类 run 派生 plan_retry', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Q6', key: 'Q6', ownerBotId: director.id })
    const mk = (id, taskId, code, message, extra = {}) => store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, status, attempt, idempotency_key,
         error_code, error_message, retry_after_ms, model_provider, queued_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, 'task', 'manual', 'failed', 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, project.id, director.id, taskId, `idem-${id}`, code, message, 600_000,
      extra.modelProvider ?? null, mins(-20), mins(-20), mins(-11),
    )
    const quotaTask = await service.createTask({ projectId: project.id, title: '额度耗尽', assigneeBotId: director.id })
    mk('q6a', quotaTask.id, 'QUOTA', '已达到 5 小时的使用上限')
    const limitTask = await service.createTask({ projectId: project.id, title: '限额语义', assigneeBotId: director.id })
    mk('q6b', limitTask.id, 'RATE_LIMIT', '已达上限，稍后重试')
    const chainTask = await service.createTask({ projectId: project.id, title: '备用链', assigneeBotId: director.id })
    mk('q6c', chainTask.id, 'RATE_LIMIT', 'rate limit', { modelProvider: 'minimax-cn' })
    const transientTask = await service.createTask({ projectId: project.id, title: '瞬时限流', assigneeBotId: director.id })
    mk('q6d', transientTask.id, 'RATE_LIMIT', 'rate limit')

    service.retryExpiredPlanWaits()

    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'q6a'").n, 0, '额度码不派生')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'q6b'").n, 0, '限额语义不派生')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'q6c'").n, 0, '备用链运行不派生')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'q6d'").n, 1, '瞬时限流照旧派生')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

// DSHBOTS-103：Token Plan「用量上限」形态与白名单外额度码补漏。
test('Token Plan 用量上限（含内嵌码 2056）：判额度耗尽、不退避、切备用', () => {
  const error = { code: 'RATE_LIMIT', message: TOKEN_PLAN_LIMIT_MESSAGE }
  assert.equal(isQuotaExhausted(error), true, '「用量上限」措辞 + (2056) 内嵌码 = 额度耗尽')
  assert.equal(needsSynthesizedBackoff(error), false, '额度耗尽不合成指数退避')
  assert.equal(shouldFallbackOn(error), true, '额度耗尽切备用模型')
  // 英文形态：正文无中文额度措辞，只有 "code":"1308" 锚点。
  const english = { code: 'RATE_LIMIT', message: ENGLISH_LIMIT_MESSAGE }
  assert.equal(isQuotaExhausted(english), true, '内嵌 1308 锚点兜住英文文案')
  assert.equal(shouldFallbackOn(english), true)
  // 只剩内嵌码、正文措辞完全改掉也不影响判定。
  assert.equal(isQuotaExhausted({ code: 'RATE_LIMIT', message: '429 {"code":"1308"}' }), true)
})

test('白名单外的额度码也切备用（额度判定不再受错误码白名单限制）', () => {
  const error = { code: 'LIMIT_REACHED', message: '已达到 5 小时的使用上限' }
  assert.equal(isQuotaExhausted(error), true, 'LIMIT_REACHED 不在白名单，但正文是额度耗尽')
  assert.equal(needsSynthesizedBackoff(error), false)
  assert.equal(shouldFallbackOn(error), true, '额度耗尽优先于白名单，直接切备用')
})

test('网关节流优先级最高：不判额度耗尽、绝不切备用（不回归 D-38/D-99）', () => {
  const throttle = { code: 'RATE_LIMIT', message: 'upstream rate-limited (bili_throttle_terminal)', retryAfterMs: 30_000 }
  assert.equal(isQuotaExhausted(throttle), false)
  assert.equal(shouldFallbackOn(throttle), false, '带 Retry-After 的节流不切备用')
  const throttleNoWait = { code: 'RATE_LIMIT', message: 'upstream rate-limited (bili_throttle_hold)' }
  assert.equal(isQuotaExhausted(throttleNoWait), false)
  assert.equal(shouldFallbackOn(throttleNoWait), false, '没给 Retry-After 的节流也不切备用')
})

test('Token Plan 用量上限走真实失败路径：不退避、派生备用运行、任务不置 blocked', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Q7', key: 'Q7', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: 'Token Plan 用量上限', assigneeBotId: director.id })
    await withFallback(service, director.id, { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' })
    insertRunningRun(store, { id: 'q7', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({
      runId: 'q7', status: 'failed', output: '',
      error: { code: 'RATE_LIMIT', message: TOKEN_PLAN_LIMIT_MESSAGE },
    })

    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'q7'").retry_after_ms, null, '额度耗尽不合成退避值')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'q7' AND type = 'rate_limit_backoff'").n, 0,
      '不写指数退避事件',
    )
    const derived = store.get("SELECT * FROM runs WHERE parent_run_id = 'q7'")
    assert.ok(derived, 'Token Plan 用量上限应派生备用模型运行')
    assert.equal(derived.model_provider, 'minimax-cn')
    assert.notEqual(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'blocked', '切备用后任务不置 blocked')
    const msg = store.get("SELECT body FROM messages WHERE run_id = 'q7' AND body LIKE '%已切换备用模型%'")
    assert.ok(msg, '应告知已切备用模型')
    assert.match(msg.body, /已达限额（RATE_LIMIT）/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('白名单外额度码走真实失败路径：同样派生备用运行、任务不置 blocked', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Q8', key: 'Q8', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '白名单外额度码', assigneeBotId: director.id })
    await withFallback(service, director.id, { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' })
    insertRunningRun(store, { id: 'q8', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({
      runId: 'q8', status: 'failed', output: '',
      error: { code: 'LIMIT_REACHED', message: '已达到 5 小时的使用上限' },
    })

    const derived = store.get("SELECT * FROM runs WHERE parent_run_id = 'q8'")
    assert.ok(derived, '白名单外的额度码也应派生备用模型运行')
    assert.equal(derived.model_provider, 'minimax-cn')
    assert.notEqual(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'blocked')
    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'q8'").retry_after_ms, null)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('网关节流走真实失败路径：不派生备用运行（不回归）', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Q9', key: 'Q9', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '节流不切备用', assigneeBotId: director.id })
    await withFallback(service, director.id, { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' })
    insertRunningRun(store, { id: 'q9', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({
      runId: 'q9', status: 'failed', output: '',
      error: { code: 'RATE_LIMIT', message: 'upstream rate-limited (bili_throttle_hold)' },
    })

    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?', 'q9').n, 0, '节流不切备用模型')
    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'q9'").retry_after_ms, rateLimitBackoffMs(1), '仍走指数退避')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
