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

const heldItems = (store, botId) =>
  JSON.parse(store.setting(`bot_pending_msgs:${botId}`) ?? '[]')

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

test('耗尽期派发走备用模型（新语义）：忙时挂起留路由快照，空闲建回仍走备用、恢复后回主模型', async () => {
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
    // one_active_run_per_bot：bot 被备用运行占用，派发挂起不落 runs 行（返回 null）。
    assert.equal(service.enqueueTaskRun(next, 'manual', { type: 'user', id: 'u' }), null, 'bot 忙时派发挂起')
    assert.ok(
      heldItems(store, bot.id).some(item => item.messageId === `task:${next.id}` && item.routing?.mode === 'fallback' && item.routing?.model === 'MiniMax-M3.1-Flash'),
      '挂起项应带备用模型路由快照',
    )

    // 备用运行置终态释放 → 空闲 drain 按快照建回：直接走备用模型并留痕 quota_fallback。
    await flushTicks(service)
    releaseBot(store, bot.id)
    const rebuilt = await pollRun(store, service, 'SELECT * FROM runs WHERE task_id = ? AND kind = ?', next.id, 'task')
    assert.ok(rebuilt, '空闲后挂起任务建回运行')
    assert.equal(rebuilt.model_provider, 'minimax-cn', '建回运行直接走备用 provider')
    assert.equal(rebuilt.model_model, 'MiniMax-M3.1-Flash')
    assert.ok(store.get("SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = 'quota_fallback'", rebuilt.id), '留痕 quota_fallback')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM bot_quota WHERE bot_id = ? AND provider = ?', bot.id, 'minimax-cn').n, 0, '备用 provider 未被标记耗尽')

    // 人工解除后，下一条新任务回主模型（先释放仍在跑的建回运行）。
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
