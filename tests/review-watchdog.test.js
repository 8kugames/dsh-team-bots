// DSHBOTS-194 验收滞留守门：in_review 卡滞留检测 + owner 系统提醒。
// 覆盖：effectiveReviewIdleMinutes 优先级（env > settings > 默认 30）、0 关闭、
// 阈值边界（29m 不报 / 31m 报）、评论与 run 活动重置锚点、非 in_review 不扫、
// 单卡去重与离开 in_review 重置、系统消息文案与 task_id 关联、scheduler/UI 接线锁。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig, effectiveReviewIdleMinutes } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { REVIEW_IDLE_ALERTED_KEY, latestAnchorMs, runReviewWatchdog } from '../src/services/review-watchdog.js'

class HoldingRuntime {
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push(run.id); return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rvw-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

async function seedProject(service, key = 'RVW') {
  const director = service.store.get("SELECT * FROM bots WHERE name = 'director'")
  const project = await service.createProject({ name: `验收-${key}`, key, ownerBotId: director.id })
  return { director, project }
}

const minutesAgoIso = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()

// 直接以受控时间戳落 in_review 卡：createTask 后改 updated_at，模拟进入验收后静置 N 分钟。
async function seedReviewTask(service, project, idleMinutes, { title = '滞留卡' } = {}) {
  const task = await service.createTask({ projectId: project.id, title, status: 'in_review' })
  service.store.run('UPDATE tasks SET updated_at = ? WHERE id = ?', minutesAgoIso(idleMinutes), task.id)
  return task
}

const seedComment = (service, task, minutesAgo, body = '核验结论：建议 accept') => {
  service.store.run(
    'INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    `cmt-${task.id}-${minutesAgo}-${Math.floor(Math.random() * 1e6)}`, task.id, 'bot', 'reviewer', body, minutesAgoIso(minutesAgo),
  )
}

const seedRunEnded = (service, task, minutesAgo, botId) => {
  service.store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, idempotency_key, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'review_delegate', 'read', 'review_delegate', 'succeeded', ?, ?, ?, ?)`,
    `run-${task.id}-${minutesAgo}-${Math.floor(Math.random() * 1e6)}`, task.project_id, botId, task.id,
    `idem-${task.id}-${minutesAgo}-${Math.floor(Math.random() * 1e6)}`,
    minutesAgoIso(minutesAgo + 5), minutesAgoIso(minutesAgo + 4), minutesAgoIso(minutesAgo),
  )
}

// harness 的 scheduler 在 await 边界实时跑 tick（含本守门），会让显式调用与插队 tick 竞争
// 去重 map。行为测试统一在播种期把阈值置 '0'（tick 全程 skipped），播种完成后同步段
// 切到目标阈值再显式调用——中间无 await，无插队窗口，断言确定。
const silenceWatchdog = (service) => service.store.setSetting('review_idle_minutes', '0')
const primeThreshold = (service, value) => service.store.setSetting('review_idle_minutes', value)

const systemAlerts = (store, projectId) =>
  store.all("SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '【系统指令】%' ORDER BY rowid", projectId)

const alertedMap = (store) => JSON.parse(store.setting(REVIEW_IDLE_ALERTED_KEY) ?? '{}')

test('effectiveReviewIdleMinutes：env 显式 > settings 保存值 > 默认 30；非法保存值回退；0 原样保留', () => {
  const get = (key) => (key === 'review_idle_minutes' ? '45' : null)
  assert.equal(effectiveReviewIdleMinutes({ reviewIdleMinutes: 30 }, get).minutes, 45)
  assert.equal(effectiveReviewIdleMinutes({ reviewIdleMinutes: 30 }, () => 'abc').minutes, 30)
  assert.equal(effectiveReviewIdleMinutes({ reviewIdleMinutes: 30 }, () => null).minutes, 30)
  assert.equal(effectiveReviewIdleMinutes({ reviewIdleMinutes: 30 }, () => '0').minutes, 0)
  process.env.DSH_TEAM_REVIEW_IDLE_MINUTES = '15'
  try {
    // env 显式时生效值取 config（resolveConfig 启动快照已吃进 env 值），与 effectiveRunLimits 同口径。
    assert.equal(effectiveReviewIdleMinutes({ reviewIdleMinutes: 15 }, get).minutes, 15)
    assert.equal(effectiveReviewIdleMinutes({ reviewIdleMinutes: 15 }, get).env, true)
  } finally {
    delete process.env.DSH_TEAM_REVIEW_IDLE_MINUTES
  }
  assert.equal(effectiveReviewIdleMinutes({ reviewIdleMinutes: 30 }, get).env, false)
})

test('latestAnchorMs：取 updated_at/评论/run 三锚最大者；空值跳过；全空返回 null', () => {
  const a = minutesAgoIso(60)
  const b = minutesAgoIso(20)
  const c = minutesAgoIso(45)
  assert.equal(latestAnchorMs({ updated_at: a, last_comment_at: null, last_run_at: null }), new Date(a).getTime())
  assert.equal(latestAnchorMs({ updated_at: a, last_comment_at: b, last_run_at: c }), new Date(b).getTime())
  assert.equal(latestAnchorMs({ updated_at: null, last_comment_at: null, last_run_at: null }), null)
})

test('滞留判定边界：31m 报、29m 不报；文案含「验收已滞留 N 分钟」且挂 task_id', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project } = await seedProject(service)
  const over = await seedReviewTask(service, project, 31)
  const under = await seedReviewTask(service, project, 29, { title: '未到线' })
  primeThreshold(service, '')
  const result = runReviewWatchdog(service)
  assert.equal(result.skipped, undefined)
  assert.equal(result.alerted.length, 1)
  assert.equal(result.alerted[0], over.id)
  const alerts = systemAlerts(store, project.id)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0].body, /【系统指令】RVW-\d+ 验收已滞留 \d+ 分钟/)
  assert.equal(alerts[0].task_id, over.id)
  assert.ok(!alertedMap(store)[under.id])
})

test('活动重置锚点：旧 updated_at + 新评论或新 run 结束都不报；两者皆旧才报', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project, director } = await seedProject(service)
  const freshComment = await seedReviewTask(service, project, 90, { title: '新评论' })
  seedComment(service, freshComment, 5)
  const freshRun = await seedReviewTask(service, project, 90, { title: '新核验' })
  seedRunEnded(service, freshRun, 3, director.id)
  const stale = await seedReviewTask(service, project, 90, { title: '全旧' })
  seedComment(service, stale, 80)
  seedRunEnded(service, stale, 70, director.id)
  primeThreshold(service, '')
  const result = runReviewWatchdog(service)
  assert.deepEqual(result.alerted, [stale.id])
  assert.equal(systemAlerts(store, project.id).length, 1)
})

test('非 in_review 卡不扫：todo 卡再旧也不报', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project } = await seedProject(service)
  const todo = await service.createTask({ projectId: project.id, title: '未进验收', status: 'todo' })
  service.store.run('UPDATE tasks SET updated_at = ? WHERE id = ?', minutesAgoIso(600), todo.id)
  primeThreshold(service, '')
  const result = runReviewWatchdog(service)
  assert.deepEqual(result.alerted, [])
  assert.equal(systemAlerts(store, project.id).length, 0)
})

test('0 关闭：settings 保存 0 → skipped 且不产生消息', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project } = await seedProject(service)
  await seedReviewTask(service, project, 500)
  const result = runReviewWatchdog(service)
  assert.equal(result.skipped, 'disabled')
  assert.equal(systemAlerts(store, project.id).length, 0)
})

test('单卡去重：同滞留卡只报一次；离开 in_review 摘除；再次滞留重报', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project } = await seedProject(service)
  const task = await seedReviewTask(service, project, 45)
  primeThreshold(service, '')
  runReviewWatchdog(service)
  runReviewWatchdog(service)
  assert.equal(systemAlerts(store, project.id).length, 1)
  assert.ok(alertedMap(store)[task.id])
  // 卡离开 in_review：去重表摘除，恢复再报资格。
  service.store.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", task.id)
  const leave = runReviewWatchdog(service)
  assert.deepEqual(leave.recovered, [task.id])
  assert.ok(!alertedMap(store)[task.id])
  // 再次滞留：同卡再报一条（合计 2 条）。
  service.store.run("UPDATE tasks SET status = 'in_review', updated_at = ? WHERE id = ?", minutesAgoIso(50), task.id)
  const again = runReviewWatchdog(service)
  assert.deepEqual(again.alerted, [task.id])
  assert.equal(systemAlerts(store, project.id).length, 2)
})

test('阈值可经 settings 覆盖：90m 卡在阈值 120 下不报', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project } = await seedProject(service)
  await seedReviewTask(service, project, 90)
  primeThreshold(service, '120')
  const result = runReviewWatchdog(service)
  assert.deepEqual(result.alerted, [])
  assert.equal(systemAlerts(store, project.id).length, 0)
})

test('接线锁：scheduler tick 调 runReviewWatchdog；UI badge 读 runLimits.reviewIdleMinutes', () => {
  const scheduler = readFileSync(join('src', 'services', 'scheduler.js'), 'utf8')
  assert.ok(scheduler.includes("from './review-watchdog.js'"), 'scheduler.js 应 import review-watchdog')
  assert.ok(scheduler.includes('runReviewWatchdog(this)'), 'scheduler tick 应调用 runReviewWatchdog(this)')
  const tasks = readFileSync(join('ui', 'modules', 'tasks.js'), 'utf8')
  assert.ok(tasks.includes('reviewIdleBadge'), 'tasks.js 应有滞留 badge 标记函数')
  assert.ok(tasks.includes('runLimits?.reviewIdleMinutes'), 'badge 阈值应与后端 runLimits 同源')
  const core = readFileSync(join('src', 'services', 'core.js'), 'utf8')
  assert.ok(core.includes('reviewIdleMinutes'), 'runLimitsView 应透出生效阈值')
})
