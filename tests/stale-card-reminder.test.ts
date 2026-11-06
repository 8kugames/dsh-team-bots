// tests/stale-card-reminder.test.ts —— DSHBOTS-280 守门：in_review/blocked 滞留阈值兜底。
// 锁定四支：
//  ① 阈值常量在场（STALE_REVIEW_HOURS=24 / STALE_BLOCKED_HOURS=48，集中定义可调）；
//  ② 两状态判定纯逻辑阈值内/外两向（in_review 23h/25h、blocked 47h/49h，非目标状态不判）；
//  ③ 同卡每日 ≤1 条防重（同日二次扫描静默：留痕不新增、返回空）；
//  ④ D-269 口径文案含替代命令（in_review→team_review_task；blocked→time_budget_minutes/updateTask），
//     且只提醒不自动处置（扫描后卡状态原样不变）。
// 运行态用例依赖 mkdtemp：沙箱 EPERM 时按卡面口径 skip（源码级断言仍执行）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import {
  STALE_REVIEW_HOURS, STALE_BLOCKED_HOURS, STALE_CARD_NOTICE_PREFIX,
  staleCardHit, staleCardNoticeBody,
} from '../src/services/notify.js'

const H = 3_600_000
const isoFromNow = (hours: number) => new Date(Date.now() - hours * H).toISOString()

test('阈值常量在场：STALE_REVIEW_HOURS=24 / STALE_BLOCKED_HOURS=48', () => {
  assert.equal(STALE_REVIEW_HOURS, 24, 'in_review 滞留阈值应为 24 小时')
  assert.equal(STALE_BLOCKED_HOURS, 48, 'blocked 滞留阈值应为 48 小时')
})

test('两状态判定纯逻辑：阈值内/外两向，非目标状态与坏时间戳不判', () => {
  // in_review 两向：23h（内）不命中，25h（外）命中且带阈值。
  assert.equal(staleCardHit({ status: 'in_review', updated_at: isoFromNow(23) }), null, 'in_review 23h 未过 24h 阈值')
  const review = staleCardHit({ status: 'in_review', updated_at: isoFromNow(25) })
  assert.ok(review, 'in_review 25h 应命中')
  assert.equal(review.status, 'in_review')
  assert.equal(review.threshold, STALE_REVIEW_HOURS)
  assert.ok(review.hours > 24 && review.hours < 26, '滞留时长应落在 24–26h 区间')
  // blocked 两向：47h（内）不命中，49h（外）命中。
  assert.equal(staleCardHit({ status: 'blocked', updated_at: isoFromNow(47) }), null, 'blocked 47h 未过 48h 阈值')
  const blocked = staleCardHit({ status: 'blocked', updated_at: isoFromNow(49) })
  assert.ok(blocked, 'blocked 49h 应命中')
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.threshold, STALE_BLOCKED_HOURS)
  // 非目标状态（施工/终态）与不可解析时间戳一律不判。
  assert.equal(staleCardHit({ status: 'in_progress', updated_at: isoFromNow(100) }), null, '施工状态不在滞留兜底范围')
  assert.equal(staleCardHit({ status: 'done', updated_at: isoFromNow(100) }), null, '终态不判滞留')
  assert.equal(staleCardHit({ status: 'in_review', updated_at: 'not-a-date' }), null, '坏时间戳不判')
  assert.equal(staleCardHit({ status: 'in_review' }), null, '缺时间戳不判')
})

test('D-269 口径文案：原因（滞留时长+阈值）+ 替代命令', () => {
  const review = staleCardNoticeBody({ identifier: 'DSHBOTS-9', status: 'in_review', hours: 30 })
  assert.ok(review.startsWith(STALE_CARD_NOTICE_PREFIX), '文案应带滞留提醒前缀（防重锚点）')
  assert.match(review, /30 小时/, '文案应含滞留时长')
  assert.match(review, /24h/, '文案应含阈值')
  assert.match(review, /team_review_task/, 'in_review 文案应含替代命令 team_review_task')
  const blocked = staleCardNoticeBody({ identifier: 'DSHBOTS-9', status: 'blocked', hours: 55 })
  assert.match(blocked, /55 小时/, 'blocked 文案应含滞留时长')
  assert.match(blocked, /48h/, 'blocked 文案应含阈值')
  assert.match(blocked, /time_budget_minutes/, 'blocked 文案应含替代动作 time_budget_minutes')
  assert.match(blocked, /updateTask/, 'blocked 文案应含替代动作 updateTask')
})

// ── 运行态用例（EPERM 容忍 skip）───────────────────────────────────────────
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stale-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const logger = { info() {}, warn() {}, error() {} }
  const service = new TeamService({ store, config, logger })
  service.attachRuntime({ setCompletionHandler() {}, setMask() {}, async catalog() { return [] }, async validateBotConfig() {}, sessionBusy() { return false } })
  await service.initialize()
  service.started = true
  // 抑制后台 tick（core.js 启动 300ms 首拍 + 各路径按需 void this.tick()）：夹具中途的
  // 后台 tick 会先把滞留提醒发掉，与下面的显式扫描断言竞态。扫描点接线（tick →
  // scanStaleCards）由文末源码锚点例钉住，不依赖本夹具的后台拍。
  service.tick = async () => {}
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Stale', key: 'STL', ownerBotId: director.id, memberIds: [builder.id] })
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, logger, director, builder, project, close }
}

// 建卡后 SQL 直写目标状态 + 龄化的 updated_at（终态/状态口径走库内真值，避免状态机绕行）。
async function staleTask(t, { status, idleHours }) {
  const task = await t.service.createTask({
    projectId: t.project.id,
    title: `滞留卡 ${status}`,
    description: 'DSHBOTS-280 守门夹具',
    assigneeBotId: t.builder.id,
    writeScopes: ['src/services/'],
    autoStart: false,
    postCard: false,
  }, { type: 'user', id: 'user_local' })
  t.store.run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', status, isoFromNow(idleHours), task.id)
  return task
}

const staleMessages = (t, taskId) => t.store.all(
  "SELECT * FROM messages WHERE task_id = ? AND sender_type = 'system' AND body LIKE ? ORDER BY created_at, rowid",
  taskId, `${STALE_CARD_NOTICE_PREFIX}%`,
)

test('运行态：in_review/blocked 超阈值提醒 owner + 同日二次静默 + 只提醒不自动处置', async t => {
  let env
  try { env = await setup() } catch (error: any) {
    if (error?.code === 'EPERM') return t.skip(`mkdtemp EPERM：${error.message}`)
    throw error
  }
  try {
    const reviewTask = await staleTask(env, { status: 'in_review', idleHours: 25 })
    const blockedTask = await staleTask(env, { status: 'blocked', idleHours: 49 })
    const freshTask = await staleTask(env, { status: 'blocked', idleHours: 47 }) // 阈值内，不提醒
    const first = env.service.scanStaleCards()
    assert.deepEqual([...first].sort(), [reviewTask.id, blockedTask.id].sort(), '首轮应只提醒两张超阈值卡')
    // 留痕：进任务线程 + mentions 点名项目 owner；文案含替代命令。
    for (const [task, re] of [[reviewTask, /team_review_task/], [blockedTask, /time_budget_minutes|updateTask/]] as const) {
      const rows = staleMessages(env, task.id)
      assert.equal(rows.length, 1, '每卡首轮恰一条滞留提醒')
      assert.equal(rows[0].project_id, env.project.id, '留痕应落项目群聊流')
      assert.ok(JSON.parse(rows[0].mentions_json).includes(env.director.id), '留痕应 @ 项目 owner')
      assert.match(rows[0].body, re, '文案应含对应替代命令')
    }
    assert.equal(staleMessages(env, freshTask.id).length, 0, '阈值内卡不得提醒')
    // 同日二次扫描：同卡每日 ≤1 条，超限静默（留痕不新增、返回空）。
    const second = env.service.scanStaleCards()
    assert.equal(second.length, 0, '同日二次扫描应全部静默')
    assert.equal(staleMessages(env, reviewTask.id).length, 1, 'in_review 卡留痕不得翻倍')
    assert.equal(staleMessages(env, blockedTask.id).length, 1, 'blocked 卡留痕不得翻倍')
    // 只提醒不自动处置：卡状态原样不变（不关单/不转状态/不重派）。
    const statuses = env.store.all(`SELECT id, status FROM tasks WHERE id IN ('${reviewTask.id}', '${blockedTask.id}')`)
    assert.ok(statuses.every(row => ['in_review', 'blocked'].includes(row.status)), '扫描不得改变卡状态')
    assert.equal(statuses.find(row => row.id === reviewTask.id).status, 'in_review', 'in_review 卡保持原状态')
    assert.equal(statuses.find(row => row.id === blockedTask.id).status, 'blocked', 'blocked 卡保持原状态')
    // 不重派：扫描后不得为滞留卡新建任何运行。
    const runs = env.store.all('SELECT id FROM runs WHERE task_id IN (?, ?)', reviewTask.id, blockedTask.id)
    assert.equal(runs.length, 0, '滞留提醒不得触发任何新运行（不重派）')
  } finally { await env.close() }
})

test('源码锚点：扫描点复用 scheduler 周期 tick（不新增常驻进程）', async () => {
  const { readFileSync } = await import('node:fs')
  const schedulerSrc = readFileSync(new URL('../src/services/scheduler.ts', import.meta.url), 'utf8')
  assert.match(schedulerSrc, /runReviewWatchdog\(this\)\s*\n\s*\/\/ 滞留阈值兜底（DSHBOTS-280）[\s\S]*?this\.scanStaleCards\(\)/,
    'tick 应在 D-194 守门同拍调用 scanStaleCards')
  const notifySrc = readFileSync(new URL('../src/services/notify.ts', import.meta.url), 'utf8')
  assert.match(notifySrc, /date\(created_at\) = date\('now'\)/, '同卡每日 ≤1 防重应以当日留痕为口径')
})
