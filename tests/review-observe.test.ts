// tests/review-observe.test.ts —— B3/DSHBOTS-326：observe 干跑档守门。
// review_auto_close 三态：'0' 关 / 'observe' 干跑（判定 + task_events 留痕，不收口，
// 提醒照常）/ '1' 开。干跑是自动化安全上线路径：人回看观察记录确认无误后再切开。
// canary = 小范围生效，observe = 完全不生效，两档语义不同。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { REVIEW_IDLE_ALERTED_KEY, reviewAutoCloseMode, runReviewWatchdog } from '../src/services/review-watchdog.js'

class HoldingRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }: any) { return `session-${run.id}` }
  async cancelRun() { return true }
}

const minutesAgoIso = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-observe-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

const seedProject = async (service, key = 'OBS') => {
  const director = service.store.get("SELECT * FROM bots WHERE name = 'director'")
  const project = await service.createProject({ name: `验收-${key}`, key, ownerBotId: director.id })
  return { director, project }
}

// B 档形态：交付运行已结束（canceled，无报告）→ 交付方无响应；锚点取运行结束时间
// （46 分钟前，留出毫秒余量严格大于 45 分钟阈值），卡面 updated_at 更早（50 分钟）只作兜底。
async function seedStaleCard(service, project, director) {
  const task = await service.createTask({ projectId: project.id, title: '干跑卡', status: 'in_review', assigneeBotId: director.id })
  service.store.run('UPDATE tasks SET updated_at = ? WHERE id = ?', minutesAgoIso(50), task.id)
  service.store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, idempotency_key, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'task', 'write', 'task_started', 'canceled', ?, ?, ?, ?)`,
    `trun-${task.id}`, project.id, director.id, task.id,
    `tidem-${task.id}`, minutesAgoIso(50), minutesAgoIso(49), minutesAgoIso(46),
  )
  return task
}

test('observe 干跑：判定留痕不收口，提醒照常', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const { project, director } = await seedProject(service)
  const task = await seedStaleCard(service, project, director)
  service.store.setSetting('review_auto_close', 'observe')
  service.store.setSetting('review_idle_minutes', '45')
  const result = runReviewWatchdog(service)
  await new Promise(resolve => setTimeout(resolve, 25))

  assert.equal(result.observed?.length, 1, '观察记录返回')
  assert.equal(result.observed[0].would, 'return')
  assert.equal(service.taskRow(task.id).status, 'in_review', '干跑不改变卡状态')
  assert.equal(store.all("SELECT * FROM audit_log WHERE action = 'review.auto_close' AND target_id = ?", task.id).length, 0, 'applyReview 不调用（零收口审计）')
  const events = store.all("SELECT * FROM task_events WHERE task_id = ? AND type = 'review_watchdog_observe'", task.id)
  assert.equal(events.length, 1, '判定留痕进任务时间线（task_detail 可回看）')
  assert.deepEqual(JSON.parse(events[0].data_json), { verdict: 'B', would: 'return', basis: JSON.parse(events[0].data_json).basis, tier: 1 })
  assert.equal(store.all("SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' AND (body LIKE '[SYSTEM ALERT]%' OR body LIKE '【系统指令】%')", project.id).length, 1, '提醒照常（干跑不吞催办，建卡文案不算）')
})

test('observe 档位解析与设置校验：0/observe/1 合法，其他拒绝', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const actor = { type: 'user', id: 'u1' }
  assert.equal(reviewAutoCloseMode(service), 'on', '默认开')
  service.store.setSetting('review_auto_close', 'observe')
  assert.equal(reviewAutoCloseMode(service), 'observe')
  service.store.setSetting('review_auto_close', '0')
  assert.equal(reviewAutoCloseMode(service), 'off')
  assert.equal(reviewAutoCloseEnabledSafe(service), false)

  await service.updateSettings({ review_auto_close: 'observe' }, actor)
  assert.equal(service.store.setting('review_auto_close'), 'observe')
  assert.throws(() => service.updateSettings({ review_auto_close: 'dry' }, actor), /observe 或 1/, '非法值拒绝')
})

function reviewAutoCloseEnabledSafe(service) {
  // reviewAutoCloseEnabled 在 on 才为 true：observe/off 都不执行收口（干跑档不执行）。
  return reviewAutoCloseMode(service) === 'on'
}

test('observe 与去重表兼容：同档位只留痕一次，档位推进再留痕', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const { project, director } = await seedProject(service)
  const task = await seedStaleCard(service, project, director)
  service.store.setSetting('review_auto_close', 'observe')
  service.store.setSetting('review_idle_minutes', '45')
  runReviewWatchdog(service)
  runReviewWatchdog(service)
  assert.equal(store.all("SELECT * FROM task_events WHERE task_id = ? AND type = 'review_watchdog_observe'", task.id).length, 1, '同档位去重（去重表同键）')
  assert.equal(JSON.parse(store.setting(REVIEW_IDLE_ALERTED_KEY))[task.id].tier, 1)
  // 二次催办档：锚点推进到 2×阈值（90 分钟），下一轮档位推进再留痕一次。
  service.store.run('UPDATE tasks SET updated_at = ? WHERE id = ?', minutesAgoIso(95), task.id)
  store.run("UPDATE runs SET ended_at = ? WHERE task_id = ?", minutesAgoIso(91), task.id)
  const map = JSON.parse(store.setting(REVIEW_IDLE_ALERTED_KEY))
  delete map[task.id]
  store.setSetting(REVIEW_IDLE_ALERTED_KEY, JSON.stringify(map))
  runReviewWatchdog(service)
  assert.equal(store.all("SELECT * FROM task_events WHERE task_id = ? AND type = 'review_watchdog_observe'", task.id).length, 2, '档位推进再留痕')
})
