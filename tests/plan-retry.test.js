// DSHBOTS-24：限流失败的机器可读退避（retry_after_ms）、成员面板 plan_wait 态、到期自动重试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// 不真正启动会话：finishRun / 派生逻辑全部用直接落库的 run 行驱动。
class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plan-retry-'))
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

// 落一条已终结的失败 run；taskId 传 null 表示单聊（project_id 也可为 null）。
function insertFailedRun(store, { id, projectId, botId, taskId = null, code = 'RATE_LIMIT', retryMs = 600_000, endedInMin = -5, attempt = 1 }) {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, trigger_ref, status, attempt,
       idempotency_key, error_code, retry_after_ms, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'task', 'manual', 't', 'failed', ?, ?, ?, ?, ?, ?, ?)`,
    id, projectId, botId, taskId, attempt, `idem-${id}`, code, retryMs, mins(-10), mins(-10), mins(endedInMin),
  )
}

test('finishRun 把 error.retryAfterMs 落进 retry_after_ms，缺省为 NULL', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'FR Project', key: 'FRPROJ', ownerBotId: director.id })
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, queued_at, started_at)
       VALUES ('fr1', ?, ?, 'task', 'manual', 'running', 'idem-fr1', ?, ?)`,
      project.id, director.id, mins(-2), mins(-2),
    )
    await service.finishRun({
      runId: 'fr1', status: 'failed', output: '',
      error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded', retryAfterMs: 120_000 },
    })
    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'fr1'").retry_after_ms, 120_000)

    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, queued_at, started_at)
       VALUES ('fr2', ?, ?, 'task', 'manual', 'running', 'idem-fr2', ?, ?)`,
      project.id, director.id, mins(-2), mins(-2),
    )
    await service.finishRun({
      runId: 'fr2', status: 'failed', output: '',
      error: { code: 'AUTH', message: 'bad key' },
    })
    assert.equal(store.get("SELECT retry_after_ms FROM runs WHERE id = 'fr2'").retry_after_ms, null)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('plan_wait 判定：限流码+未到期才紫；到期回落 failed；QUOTA 无退避不算', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'PW Project', key: 'PWPROJ', ownerBotId: director.id })
    const status = () => service.projectView(service.projectRow(project.id)).members.find(m => m.id === director.id)

    insertFailedRun(store, { id: 'w1', projectId: project.id, botId: director.id, code: 'RATE_LIMIT', retryMs: 600_000, endedInMin: -5 })
    let row = status()
    assert.equal(row.run_status, 'plan_wait')
    assert.ok(row.retry_wait_seconds > 240 && row.retry_wait_seconds <= 300, `剩余秒数应在 (240,300]，实际 ${row.retry_wait_seconds}`)

    store.run("UPDATE runs SET ended_at = ? WHERE id = 'w1'", mins(-11))
    row = status()
    assert.equal(row.run_status, 'failed')
    assert.equal(row.retry_wait_seconds, null)

    store.run("UPDATE runs SET ended_at = ?, error_code = 'QUOTA', retry_after_ms = NULL WHERE id = 'w1'", mins(-5))
    assert.equal(status().run_status, 'failed')

    store.run("UPDATE runs SET error_code = 'AUTH', retry_after_ms = 900_000 WHERE id = 'w1'")
    assert.equal(status().run_status, 'failed')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('单聊限流失败显示 plan_wait 但不派生重试', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'SO Project', key: 'SOPROJ', ownerBotId: director.id })
    insertFailedRun(store, { id: 's1', projectId: null, botId: director.id, taskId: null, endedInMin: -5 })
    const row = service.projectView(service.projectRow(project.id)).members.find(m => m.id === director.id)
    assert.equal(row.run_status, 'plan_wait')

    service.retryExpiredPlanWaits()
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?', 's1').n, 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('到期派生：attempt+1、parent 链、plan_retry 事件，重复扫描幂等', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'RT Project', key: 'RTPROJ', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '限流任务', assigneeBotId: director.id })
    insertFailedRun(store, { id: 't1', projectId: project.id, botId: director.id, taskId: task.id, endedInMin: -11 })

    service.retryExpiredPlanWaits()
    const derived = store.get("SELECT * FROM runs WHERE parent_run_id = 't1'")
    assert.ok(derived, '应派生新 run')
    assert.equal(derived.attempt, 2)
    assert.equal(derived.trigger_type, 'plan_retry')
    assert.equal(derived.status, 'queued')
    assert.equal(derived.task_id, task.id)
    const evt = store.get("SELECT * FROM run_events WHERE run_id = 't1' AND type = 'plan_retry'")
    assert.ok(evt, '原 run 应留 plan_retry 事件')

    // 再次扫描：幂等，不重复派生
    service.retryExpiredPlanWaits()
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 't1'").n, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('只重试一次：attempt=2 失败不再派生；任务终态/已有活跃 run 也不派生', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'ON Project', key: 'ONPROJ', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '二次失败', assigneeBotId: director.id })
    insertFailedRun(store, { id: 'o1', projectId: project.id, botId: director.id, taskId: task.id, endedInMin: -11, attempt: 2 })
    service.retryExpiredPlanWaits()
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'o1'").n, 0, 'attempt=2 不再派生')

    store.run("UPDATE runs SET attempt = 1 WHERE id = 'o1'")
    await service.updateTask(task.id, { status: 'canceled' }, { type: 'user', id: 'u' })
    service.retryExpiredPlanWaits()
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'o1'").n, 0, '任务已取消不派生')

    const task2 = await service.createTask({ projectId: project.id, title: '手动重试中', assigneeBotId: director.id })
    store.run("UPDATE runs SET task_id = ? WHERE id = 'o1'", task2.id)
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, status, idempotency_key, queued_at)
       VALUES ('o-active', ?, ?, ?, 'task', 'manual', 'queued', 'idem-o-active', ?)`,
      project.id, director.id, task2.id, mins(-1),
    )
    service.retryExpiredPlanWaits()
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'o1'").n, 0, '已有活跃 run 不派生')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
