// DSHBOTS-241：provider 额度墙优化守门。
// ①撞墙记录恢复时间（绝对时刻 / 相对时长 / 兜底保守等待），主备 provider 两套额度互不顶替；
// ②耗尽期新任务派发不撞墙——走备用模型或排队等待，恢复后自动回主模型；
// ③手动解除限 owner/总监，审计留痕；非总监成员解除被拒。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { parseQuotaResetMs, QUOTA_DEFAULT_RESET_MS, quotaRouteFor } from '../src/services/bot-quota.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bot-quota-'))
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

const HOUR = 60 * 60_000
const future = (ms) => new Date(Date.now() + ms).toISOString()

// 本地时区的「YYYY-MM-DD HH:mm:ss」，用于拼出未来的绝对恢复时刻。
function resetAt(msFromNow) {
  const d = new Date(Date.now() + msFromNow)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function seedAssignedBot(service, { fallback = true } = {}) {
  const director = service.store.get("SELECT * FROM bots WHERE name = 'director'")
  const project = await service.createProject({ name: 'Quota', key: 'QUOTA', ownerBotId: director.id })
  const bot = await service.createBot({
    name: 'quota-bot', role: 'dev', provider: 'deepseek', model: 'deepseek-chat',
    ...(fallback ? { fallbackProvider: 'minimax-cn', fallbackModel: 'MiniMax-M3.1-Flash' } : {}),
  })
  await service.addProjectMember(project.id, bot.id, { type: 'user', id: 'u' })
  return { project, bot }
}

function insertRunningRun(store, { id, projectId, botId, taskId, modelProvider = null }) {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, status, attempt, idempotency_key,
       model_provider, model_model, queued_at, started_at)
     VALUES (?, ?, ?, ?, 'task', 'manual', 'running', 1, ?, ?, ?, ?, ?)`,
    id, projectId, botId, taskId, `idem-${id}`,
    modelProvider, modelProvider ? `${modelProvider}/fallback-model` : null,
    future(-2 * 60_000), future(-2 * 60_000),
  )
}

// one_active_run_per_bot（DSHBOTS-289）：同 bot 同时至多一条 queued/running。夹具连播
// 多条撞墙样本前，先把上一轮派生运行（备用接手/记忆审查等）置终态释放 bot。
function releaseBot(store, botId) {
  store.run(
    "UPDATE runs SET status = 'succeeded', ended_at = ? WHERE bot_id = ? AND status IN ('queued', 'running')",
    new Date().toISOString(), botId,
  )
}

// 等后台 tick（interval 20ms 与 finishRun 的 void tick）把派生 outbox 落成 runs 行。
async function flushTicks(service, ms = 40) {
  await service.tick()
  await new Promise(resolve => setTimeout(resolve, ms))
}

// 轮询驱动 tick 直到目标行出现（drainPendingMessages 建回挂起任务属异步拍）。
async function pollRun(store, service, sql, ...params) {
  const deadline = Date.now() + 2000
  let row
  while (Date.now() < deadline) {
    await service.tick()
    row = store.get(sql, ...params)
    if (row) return row
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return store.get(sql, ...params)
}

// DSHBOTS-308：挂起队列键带域段（bot_pending_msgs:<bot>:<domain>）——按 bot 扫全部域键合并读取。
const heldItems = (store, botId) => {
  const rows = store.all('SELECT value FROM settings WHERE key LIKE ?', `bot_pending_msgs:${botId}:%`)
  const out = []
  for (const row of rows) {
    const arr = JSON.parse(row.value ?? '[]')
    if (Array.isArray(arr)) out.push(...arr)
  }
  return out
}

test('恢复时间解析：绝对时刻 / 相对时长 / 关键词缺失 / 已过期 / 超上界', () => {
  const now = Date.parse('2026-11-05T12:00:00')
  assert.equal(
    parseQuotaResetMs('Your limit will reset at 2026-11-05 15:17:01', now),
    (Date.parse('2026-11-05T15:17:01') - now),
    '绝对时刻按本地时区解析',
  )
  assert.equal(parseQuotaResetMs('额度将在 2026-11-05 18:00 恢复', now), 6 * HOUR, '中文绝对时刻')
  assert.equal(parseQuotaResetMs('quota resets in 2 hours', now), 2 * HOUR, '英文时长')
  assert.equal(parseQuotaResetMs('已达到 5 小时的使用上限', now), null, '无恢复关键词不算时长')
  assert.equal(parseQuotaResetMs('Your limit will reset at 2026-11-04 15:17:01', now), null, '已过期视为无效')
  assert.equal(parseQuotaResetMs('reset in 40 days', now), null, '超过 30 天视为不可信')
  assert.equal(parseQuotaResetMs('', now), null, '空消息')
  assert.equal(parseQuotaResetMs('{"code":"1308","message":"usage limit reached"}', now), null, '无恢复时间')
})

test('路由纯函数：主未耗尽走主模型；主耗尽走备用；主备都耗尽排队等待', () => {
  const bot = { id: 'b1', provider: 'deepseek', fallback_provider: 'minimax-cn', fallback_model: 'M', fallback_effort: 'low' }
  const primary = { provider: 'deepseek', exhausted: true, resetAt: null }
  assert.deepEqual(quotaRouteFor(bot, { exhausted: false }, null), { mode: 'primary' })
  assert.deepEqual(
    quotaRouteFor(bot, primary, { exhausted: false }),
    { mode: 'fallback', provider: 'minimax-cn', model: 'M', effort: 'low', ref: 'minimax-cn/M' },
  )
  assert.deepEqual(
    quotaRouteFor(bot, primary, { exhausted: true }),
    { mode: 'wait', provider: 'deepseek', resetAt: null },
  )
  assert.deepEqual(
    quotaRouteFor({ ...bot, fallback_provider: null, fallback_model: null }, primary, null),
    { mode: 'wait', provider: 'deepseek', resetAt: null },
    '未配备用也排队等待',
  )
})

test('撞墙记录：解析恢复时间落库、审计留痕、备用 provider 不顶替主额度', async () => {
  const { root, store, service } = await setup()
  try {
    const { project, bot } = await seedAssignedBot(service)
    const task = await service.createTask({ projectId: project.id, title: '撞墙', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'r1', projectId: project.id, botId: bot.id, taskId: task.id })

    await service.finishRun({
      runId: 'r1', status: 'failed', output: '',
      error: { code: '1308', message: `Your limit will reset at ${resetAt(3 * HOUR)}` },
    })

    const row = store.get('SELECT * FROM bot_quota WHERE bot_id = ? AND provider = ?', bot.id, 'deepseek')
    assert.ok(row, '主 provider 额度行已落库')
    assert.equal(row.state, 'exhausted')
    assert.equal(row.reset_source, 'message', '恢复时间来自消息解析')
    assert.ok(
      Math.abs(Date.parse(row.reset_at) - (Date.now() + 3 * HOUR)) < 5_000,
      `绝对时刻应落在 3 小时后，实际 ${row.reset_at}`,
    )
    assert.ok(store.get("SELECT 1 AS ok FROM audit_log WHERE action = 'bot.quota_exhausted' AND target_id = ?", bot.id), '审计留痕')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM bot_quota WHERE bot_id = ?', bot.id).n, 1, '备用 provider 不产生额度行')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'quota_exhausted'", 'r1').n, 1,
      '真撞墙才记一条 quota_exhausted 运行事件',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('quota_exhausted 事件条件化（DSHBOTS-246）：成功运行与非额度失败都不记', async () => {
  const { root, store, service } = await setup()
  try {
    const { project, bot } = await seedAssignedBot(service)
    const task = await service.createTask({ projectId: project.id, title: '成功运行', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'ok-1', projectId: project.id, botId: bot.id, taskId: task.id })
    await service.finishRun({ runId: 'ok-1', status: 'succeeded', output: 'done' })
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'quota_exhausted'", 'ok-1').n, 0,
      '成功运行不得记额度耗尽',
    )
    // 交付派生的记忆审查/验收运行会占住 bot：置终态释放后再播下一条撞墙样本。
    await flushTicks(service)
    releaseBot(store, bot.id)

    const task2 = await service.createTask({ projectId: project.id, title: '普通失败', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'fail-1', projectId: project.id, botId: bot.id, taskId: task2.id })
    await service.finishRun({ runId: 'fail-1', status: 'failed', output: '', error: { code: 'E_OTHER', message: 'boom' } })
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'quota_exhausted'", 'fail-1').n, 0,
      '非额度失败不得记额度耗尽',
    )
    assert.equal(
      store.get('SELECT COUNT(*) AS n FROM bot_quota WHERE bot_id = ?', bot.id).n, 0,
      '非额度失败不得写 bot_quota 状态行',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('解析失败兜底保守等待：reset_at 为默认窗口且来源标记 default', async () => {
  const { root, store, service } = await setup()
  try {
    const { project, bot } = await seedAssignedBot(service)
    const task = await service.createTask({ projectId: project.id, title: '撞墙', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'r2', projectId: project.id, botId: bot.id, taskId: task.id })

    await service.finishRun({
      runId: 'r2', status: 'failed', output: '',
      error: { code: '1308', message: 'usage limit reached' },
    })

    const row = store.get('SELECT * FROM bot_quota WHERE bot_id = ?', bot.id)
    assert.equal(row.reset_source, 'default')
    const delta = Date.parse(row.reset_at) - Date.now()
    assert.ok(Math.abs(delta - QUOTA_DEFAULT_RESET_MS) < 5_000, `兜底窗口应接近 5 小时，实际 ${delta}ms`)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('耗尽期派发走备用模型（新语义）：派发直落 runs 行带备用路由快照，恢复后回主模型', async () => {
  const { root, store, service } = await setup()
  try {
    const { project, bot } = await seedAssignedBot(service)
    const task = await service.createTask({ projectId: project.id, title: '耗尽期任务', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'r3', projectId: project.id, botId: bot.id, taskId: task.id })
    await service.finishRun({
      runId: 'r3', status: 'failed', output: '',
      error: { code: '1308', message: '已达到 5 小时的使用上限，额度将在 2026-11-05 18:00 恢复' },
    })
    // 撞墙即派生备用运行接手（minimax），占住 bot。
    const derived = await pollRun(store, service, "SELECT * FROM runs WHERE parent_run_id = 'r3' AND status IN ('queued', 'running')")
    assert.ok(derived, '撞墙时已派生备用模型运行')

    const next = await service.createTask({ projectId: project.id, title: '耗尽期新任务', assigneeBotId: bot.id })
    // 任务运行豁免 bot 串行域（单 bot 多任务并行）：bot 忙时派发不再挂起，直落 runs 行——
    // 备用模型路由快照写进运行行（model_provider/model_model），并留痕 quota_fallback。
    const nextRunId = service.enqueueTaskRun(next, 'manual', { type: 'user', id: 'u' })
    assert.ok(nextRunId, 'bot 忙时派发仍直接落 runs 行（不挂起）')
    const nextRun = store.get('SELECT * FROM runs WHERE id = ?', nextRunId)
    assert.equal(nextRun.model_provider, 'minimax-cn', '派发行的备用 provider 快照')
    assert.equal(nextRun.model_model, 'MiniMax-M3.1-Flash', '派发行的备用模型快照')
    assert.ok(store.get("SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = 'quota_fallback'", nextRunId), '留痕 quota_fallback')
    assert.deepEqual(heldItems(store, bot.id), [], '任务派发不进挂起队列')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM bot_quota WHERE bot_id = ? AND provider = ?', bot.id, 'minimax-cn').n, 0, '备用 provider 未被标记耗尽')

    // 人工解除后，下一条新任务回主模型（先释放仍在跑的运行）。
    await flushTicks(service)
    releaseBot(store, bot.id)
    await service.releaseBotQuota(bot.id, { type: 'user', id: 'u' })
    const after = await service.createTask({ projectId: project.id, title: '解除后任务', assigneeBotId: bot.id })
    const runId2 = service.enqueueTaskRun(after, 'manual', { type: 'user', id: 'u' })
    assert.ok(runId2, '解除且 bot 空闲时直接落 runs 行')
    assert.equal(store.get('SELECT model_provider FROM runs WHERE id = ?', runId2).model_provider, null, '解除后回主模型')
    assert.equal(service.botQuotaState(bot.id, 'deepseek').exhausted, false)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('主备都耗尽：派发排队等待，调度器不放行；解除后自动回主模型', async () => {
  const { root, store, service } = await setup()
  try {
    const { project, bot } = await seedAssignedBot(service)
    // 主 provider（deepseek）撞墙：finishRun 同步派生备用运行（minimax）接手同一条任务链。
    const wallTask = await service.createTask({ projectId: project.id, title: '撞墙 deepseek', assigneeBotId: bot.id, writeScopes: ['src/services/'] })
    insertRunningRun(store, { id: 'wall-0', projectId: project.id, botId: bot.id, taskId: wallTask.id })
    await service.finishRun({
      runId: 'wall-0', status: 'failed', output: '',
      error: { code: '1308', message: '已达到 5 小时的使用上限', retryAfterMs: 60 * 60_000 },
    })
    const derived = await pollRun(store, service, "SELECT * FROM runs WHERE parent_run_id = 'wall-0' AND status IN ('queued', 'running')")
    assert.ok(derived, '撞墙时已派生备用运行')
    // 备用运行也撞墙（同 bot 第二条撞墙样本需先等派生运行占道再收尾）：
    // 链内已用过备用（fallbackUsedInChain），不再派生，主备两套额度都标记耗尽。
    await flushTicks(service)
    await service.finishRun({
      runId: derived.id, status: 'failed', output: '',
      error: { code: '1308', message: '已达到 5 小时的使用上限', retryAfterMs: 60 * 60_000 },
    })
    assert.equal(store.get('SELECT COUNT(*) AS n FROM bot_quota WHERE bot_id = ?', bot.id).n, 2, '主备各一套额度')

    const task = await service.createTask({
      projectId: project.id, title: '耗尽期任务', assigneeBotId: bot.id, writeScopes: ['docs/api/'],
    })
    const runId = service.enqueueTaskRun(task, 'manual', { type: 'user', id: 'u' })
    assert.ok(runId, 'bot 空闲时直接落 runs 行')
    assert.equal(store.get('SELECT model_provider FROM runs WHERE id = ?', runId).model_provider, null, '无可用备用时不带模型覆盖')
    assert.ok(store.get("SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = 'quota_wait'", runId), '派发时留痕 quota_wait')

    await flushTicks(service)
    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', runId).status, 'queued', '调度器额度闸门：留 queued 不撞墙')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'quota_wait'", runId).n, 1,
      '同一 run 只记一条 quota_wait，不刷屏',
    )

    // 解除后下一拍自动回主模型（主 provider 直接领取）。
    await service.releaseBotQuota(bot.id, { type: 'user', id: 'u' })
    const released = await pollRun(store, service, 'SELECT status FROM runs WHERE id = ?', runId)
    assert.equal(released.status, 'running', '解除后下一拍自动回主模型')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('恢复时间到点后惰性恢复：不人工解除也自动回主模型', async () => {
  const { root, store, service } = await setup()
  try {
    const { project, bot } = await seedAssignedBot(service)
    const task = await service.createTask({ projectId: project.id, title: '撞墙', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'r4', projectId: project.id, botId: bot.id, taskId: task.id })
    await service.finishRun({
      runId: 'r4', status: 'failed', output: '',
      error: { code: '1308', message: 'quota', retryAfterMs: 60_000 },
    })
    assert.equal(service.botQuotaState(bot.id, 'deepseek').exhausted, true)
    // 撞墙派生的备用运行占住 bot：置终态释放后再验证恢复后的派发口径。
    await flushTicks(service)
    releaseBot(store, bot.id)

    store.run("UPDATE bot_quota SET reset_at = ? WHERE bot_id = ?", future(-1_000), bot.id)
    assert.equal(service.botQuotaState(bot.id, 'deepseek').exhausted, false, 'reset_at 已过即视为恢复')
    const next = await service.createTask({ projectId: project.id, title: '恢复后任务', assigneeBotId: bot.id })
    const runId = service.enqueueTaskRun(next, 'manual', { type: 'user', id: 'u' })
    assert.ok(runId, 'bot 空闲时直接落 runs 行')
    assert.equal(store.get('SELECT model_provider FROM runs WHERE id = ?', runId).model_provider, null, '恢复后回主模型')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('手动解除权限：owner 可解除并审计；非总监成员被拒；总监可解除', async () => {
  const { root, store, service } = await setup()
  try {
    const { project, bot } = await seedAssignedBot(service)
    const task = await service.createTask({ projectId: project.id, title: '撞墙', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'r5', projectId: project.id, botId: bot.id, taskId: task.id })
    await service.finishRun({
      runId: 'r5', status: 'failed', output: '',
      error: { code: '1308', message: 'quota', retryAfterMs: 60 * 60_000 },
    })
    // 撞墙派生的备用运行占住 bot：置终态释放后再走解除链路。
    await flushTicks(service)
    releaseBot(store, bot.id)

    const member = await service.createBot({ name: 'plain-member', role: 'dev' })
    await assert.rejects(
      async () => { service.releaseBotQuota(bot.id, { type: 'bot', id: member.id }) },
      /只有工作台 owner 或项目总监/,
      '非总监成员解除被拒',
    )

    const view = service.releaseBotQuota(bot.id, { type: 'user', id: 'u' })
    assert.equal(view.quota.exhausted, false)
    const audit = store.get("SELECT * FROM audit_log WHERE action = 'bot.quota_released' AND target_id = ?", bot.id)
    assert.ok(audit, '解除留痕')
    assert.equal(JSON.parse(audit.data_json).providers.join(','), 'deepseek')

    // 再次撞墙后由项目总监解除。
    const task2 = await service.createTask({ projectId: project.id, title: '再撞墙', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'r6', projectId: project.id, botId: bot.id, taskId: task2.id })
    await service.finishRun({
      runId: 'r6', status: 'failed', output: '',
      error: { code: '1308', message: 'quota', retryAfterMs: 60 * 60_000 },
    })
    await flushTicks(service)
    releaseBot(store, bot.id)
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const released = service.releaseBotQuota(bot.id, { type: 'bot', id: director.id })
    assert.equal(released.quota.exhausted, false, '项目总监可解除')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'bot.quota_released' AND target_id = ?", bot.id).n, 2)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('director 工具入口：经会话绑定鉴权，按名字解除', async () => {
  const { root, store, service } = await setup()
  try {
    const { project, bot } = await seedAssignedBot(service)
    const task = await service.createTask({ projectId: project.id, title: '撞墙', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'r7', projectId: project.id, botId: bot.id, taskId: task.id })
    await service.finishRun({
      runId: 'r7', status: 'failed', output: '',
      error: { code: '1308', message: 'quota', retryAfterMs: 60 * 60_000 },
    })
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
       VALUES ('sess-director', ?, ?, 'project', NULL, ?)`,
      director.id, project.id, future(-60 * 60_000),
    )

    const view = service.releaseBotQuotaFromBot('sess-director', bot.name)
    assert.equal(view.quota.exhausted, false, '按名字解除成功')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

// DSHBOTS-358：内部运行（review / handle / memory_review）同样接额度路由与额度闸门。
test('内部运行入队也接额度路由：review 带备用模型快照', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'QR1', key: 'QR1', ownerBotId: director.id })
    await service.updateBot(director.id, {
      provider: 'deepseek', model: 'deepseek-chat',
      fallbackProvider: 'minimax-cn', fallbackModel: 'MiniMax-M3.1-Flash',
    }, { type: 'user', id: 'u' })
    const task = await service.createTask({ projectId: project.id, title: '验收路由', assigneeBotId: director.id, status: 'in_review' })
    service.recordBotQuotaExhaustion({
      botId: director.id, provider: 'deepseek', errorCode: '1308', errorMessage: 'quota', retryAfterMs: 60 * 60_000,
    })
    const runId = service.enqueueOwnerTaskRun(service.taskRow(task.id), 'review')
    assert.ok(runId, 'review 运行应入队')
    const run = store.get('SELECT * FROM runs WHERE id = ?', runId)
    assert.equal(run.kind, 'review')
    assert.equal(run.model_provider, 'minimax-cn', 'review 入队带备用 provider 快照')
    assert.equal(run.model_model, 'MiniMax-M3.1-Flash', 'review 入队带备用模型快照')
    assert.ok(store.get("SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = 'quota_fallback'", runId), '留痕 quota_fallback')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('主备都耗尽：review 入队留 wait，调度器额度闸门留 queued 不下发', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'QR2', key: 'QR2', ownerBotId: director.id })
    await service.updateBot(director.id, {
      provider: 'deepseek', model: 'deepseek-chat',
      fallbackProvider: 'minimax-cn', fallbackModel: 'MiniMax-M3.1-Flash',
    }, { type: 'user', id: 'u' })
    const task = await service.createTask({ projectId: project.id, title: '验收等待', assigneeBotId: director.id, status: 'in_review' })
    for (const provider of ['deepseek', 'minimax-cn']) {
      service.recordBotQuotaExhaustion({
        botId: director.id, provider, errorCode: '1308', errorMessage: 'quota', retryAfterMs: 60 * 60_000,
      })
    }
    const runId = service.enqueueOwnerTaskRun(service.taskRow(task.id), 'review')
    assert.ok(runId, 'review 运行应入队')
    const run = store.get('SELECT * FROM runs WHERE id = ?', runId)
    assert.equal(run.model_provider, null, '无可用备用时不带模型覆盖')
    assert.ok(store.get("SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = 'quota_wait'", runId), '留痕 quota_wait')
    await flushTicks(service)
    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', runId).status, 'queued', '调度器额度闸门：留 queued 不撞墙')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'quota_wait'", runId).n, 1,
      '同一 run 只记一条 quota_wait',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('额度扣持闸：内部运行留 queued 等恢复；聊天类照常下发', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'QR3', key: 'QR3', ownerBotId: director.id })
    await service.updateBot(director.id, { provider: 'deepseek', model: 'deepseek-chat' }, { type: 'user', id: 'u' })
    service.recordBotQuotaExhaustion({
      botId: director.id, provider: 'deepseek', errorCode: '1308', errorMessage: 'quota', retryAfterMs: 60 * 60_000,
    })
    const task = await service.createTask({ projectId: project.id, title: '扣持', assigneeBotId: director.id, status: 'in_review' })
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status, attempt,
         idempotency_key, queued_at)
       VALUES ('rvq', ?, ?, ?, 'review', 'read', 'review_requested', ?, 'queued', 1, 'idem-rvq', ?)`,
      project.id, director.id, task.id, task.id, future(-60_000),
    )
    // 另一个 bot 的群聊运行（provider 未耗尽）：聊天类不受额度闸门影响
    const chatBot = await service.createBot({ name: 'chat-bot-q', role: 'dev', provider: 'deepseek', model: 'deepseek-chat' })
    await service.addProjectMember(project.id, chatBot.id, { type: 'user', id: 'u' })
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status, attempt,
         idempotency_key, queued_at)
       VALUES ('chq', ?, ?, NULL, 'chat', 'read', 'mention', NULL, 'queued', 1, 'idem-chq', ?)`,
      project.id, chatBot.id, future(-60_000),
    )
    await service.tick()
    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', 'rvq').status, 'queued', '额度闸门：review 运行留 queued 等恢复')
    assert.ok(store.get("SELECT 1 AS ok FROM run_events WHERE run_id = 'rvq' AND type = 'quota_wait'"), '留痕 quota_wait')
    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', 'chq').status, 'running', '聊天类照常下发')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Bot 改 provider：额度记录随键迁移，保留更严的一条，操作日志留痕', async () => {
  const { root, store, service } = await setup()
  try {
    const { project, bot } = await seedAssignedBot(service)
    const task = await service.createTask({ projectId: project.id, title: '撞墙', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'mig-1', projectId: project.id, botId: bot.id, taskId: task.id })
    await service.finishRun({
      runId: 'mig-1', status: 'failed', output: '',
      error: { code: '1308', message: 'quota', retryAfterMs: 2 * HOUR },
    })
    const oldRow = store.get('SELECT * FROM bot_quota WHERE bot_id = ? AND provider = ?', bot.id, 'deepseek')
    assert.ok(oldRow, '主 provider 额度行已落库')
    assert.equal(oldRow.state, 'exhausted')

    // 改主 provider → 旧键迁移到新键，耗尽态随迁移保留
    await service.updateBot(bot.id, { provider: 'anthropic', model: 'claude-sonnet' }, { type: 'user', id: 'u' })
    const moved = store.all('SELECT * FROM bot_quota WHERE bot_id = ?', bot.id)
    assert.equal(moved.length, 1, '旧 provider 键不留孤儿行')
    assert.equal(moved[0].provider, 'anthropic', '额度行迁移到新 provider')
    assert.equal(moved[0].state, 'exhausted', '耗尽态随迁移保留')
    assert.equal(moved[0].reset_at, oldRow.reset_at, '恢复时间随迁移保留')
    const audit = store.get("SELECT * FROM audit_log WHERE action = 'bot.quota_provider_changed' AND target_id = ?", bot.id)
    assert.ok(audit, '换 provider 留操作日志')
    assert.match(audit.data_json ?? '', /deepseek/)
    assert.match(audit.data_json ?? '', /anthropic/)

    // 新 provider 已有耗尽记录：迁移保留更严的那条，不抹掉正在生效的墙
    service.recordBotQuotaExhaustion({
      botId: bot.id, provider: 'anthropic', errorCode: '1308', errorMessage: 'quota', retryAfterMs: 4 * HOUR,
    })
    service.recordBotQuotaExhaustion({
      botId: bot.id, provider: 'moonshot', errorCode: '1308', errorMessage: 'quota', retryAfterMs: 6 * HOUR,
    })
    await service.updateBot(bot.id, { provider: 'moonshot', model: 'moonshot-v1' }, { type: 'user', id: 'u' })
    const merged = store.all('SELECT * FROM bot_quota WHERE bot_id = ?', bot.id)
    assert.equal(merged.length, 1, '合并后仍只留一条额度行')
    assert.equal(merged[0].provider, 'moonshot')
    assert.equal(merged[0].state, 'exhausted', '正在生效的墙不被迁移抹掉')
    assert.ok(
      Math.abs(Date.parse(merged[0].reset_at) - (Date.now() + 6 * HOUR)) < 5_000,
      `保留更严的一条（恢复时间更晚），实际 ${merged[0].reset_at}`,
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('provider 未变：额度记录不动（不产生迁移日志）', async () => {
  const { root, store, service } = await setup()
  try {
    const { project, bot } = await seedAssignedBot(service)
    const task = await service.createTask({ projectId: project.id, title: '撞墙', assigneeBotId: bot.id })
    insertRunningRun(store, { id: 'mig-2', projectId: project.id, botId: bot.id, taskId: task.id })
    await service.finishRun({
      runId: 'mig-2', status: 'failed', output: '',
      error: { code: '1308', message: 'quota', retryAfterMs: 2 * HOUR },
    })
    await service.updateBot(bot.id, { model: 'deepseek-chat-v2' }, { type: 'user', id: 'u' })
    const rows = store.all('SELECT * FROM bot_quota WHERE bot_id = ?', bot.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].provider, 'deepseek', 'provider 未变则额度行不动')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'bot.quota_provider_changed' AND target_id = ?", bot.id).n, 0,
      'provider 未变不记迁移日志',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('review 挂起后建回仍带备用模型快照（额度路由随挂起项带回）', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'QR4', key: 'QR4', ownerBotId: director.id })
    await service.updateBot(director.id, {
      provider: 'deepseek', model: 'deepseek-chat',
      fallbackProvider: 'minimax-cn', fallbackModel: 'MiniMax-M3.1-Flash',
    }, { type: 'user', id: 'u' })
    const task = await service.createTask({ projectId: project.id, title: '挂起验收', assigneeBotId: director.id, status: 'in_review' })
    service.recordBotQuotaExhaustion({
      botId: director.id, provider: 'deepseek', errorCode: '1308', errorMessage: 'quota', retryAfterMs: 60 * 60_000,
    })
    // 制造 owner 忙：一条在跑的群聊运行
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status, attempt,
         idempotency_key, queued_at, started_at)
       VALUES ('busy1', ?, ?, NULL, 'chat', 'read', 'mention', NULL, 'running', 1, 'idem-busy1', ?, ?)`,
      project.id, director.id, future(-60_000), future(-60_000),
    )
    assert.equal(service.enqueueOwnerTaskRun(service.taskRow(task.id), 'review'), null, 'owner 忙时挂起不落 runs 行')
    // 释放 owner → 挂起项建回
    store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = 'busy1'", future(-30_000))
    const row = await pollRun(store, service, 'SELECT * FROM runs WHERE kind = ? AND task_id = ?', 'review', task.id)
    assert.ok(row, 'owner 空闲后建回 review 运行')
    assert.equal(row.model_provider, 'minimax-cn', '建回仍带备用 provider 快照')
    assert.equal(row.model_model, 'MiniMax-M3.1-Flash', '建回仍带备用模型快照')
    assert.ok(store.get("SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = 'quota_fallback'", row.id), '留痕 quota_fallback')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
