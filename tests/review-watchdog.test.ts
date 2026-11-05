// DSHBOTS-194 验收滞留守门：in_review 卡滞留检测 + owner 系统提醒。
// 覆盖：effectiveReviewIdleMinutes 优先级（env > settings > 默认 30）、0 关闭、
// 阈值边界（29m 不报 / 31m 报）、评论与 run 活动重置锚点、非 in_review 不扫、
// 单卡去重与离开 in_review 重置、系统消息文案与 task_id 关联、scheduler/UI 接线锁。
// DSHBOTS-235 扩展：三档规则（A 自动 accept 双证据链 / B 自动 return / C 仅提醒）、
// H1 滞留排总监验收运行、H2 分级升级、H3 taskView 同源锚点、H4 settings 白名单、
// H5 逐卡容错与索引、自动收口开关关闭行为不变。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDatabase } from '../src/db.js'
import { resolveConfig, effectiveReviewIdleMinutes } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { REVIEW_IDLE_ALERTED_KEY, latestAnchorMs, runReviewWatchdog } from '../src/services/review-watchdog.js'

class HoldingRuntime {
  declare started: string[]
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

// 系统告警消息按前缀取回（DSHBOTS-228 后前缀随 locale：缺省英文 / 中文【系统指令】）。
const systemAlerts = (store, projectId) =>
  store.all("SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' AND (body LIKE '[SYSTEM ALERT]%' OR body LIKE '【系统指令】%') ORDER BY rowid", projectId)

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
  assert.match(alerts[0].body, /\[SYSTEM ALERT\] RVW-\d+ 验收已滞留 \d+ 分钟/)
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

test('i18n 前缀（DSHBOTS-228）：缺省 [SYSTEM ALERT]，ui_language=zh 时为【系统指令】', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project } = await seedProject(service, 'I18N')
  await seedReviewTask(service, project, 45, { title: '缺省英文' })
  primeThreshold(service, '')
  runReviewWatchdog(service)
  assert.match(systemAlerts(store, project.id)[0].body, /\[SYSTEM ALERT\] I18N-\d+ 验收已滞留/)

  // 播种期回到静默（阈值 0，tick 不插队），显式 zh 后同步段再切阈值触发。
  silenceWatchdog(service)
  await seedReviewTask(service, project, 45, { title: '中文前缀' })
  store.setSetting('ui_language', 'zh')
  primeThreshold(service, '')
  runReviewWatchdog(service)
  const alerts = systemAlerts(store, project.id)
  assert.equal(alerts.length, 2)
  assert.match(alerts[1].body, /【系统指令】I18N-\d+ 验收已滞留/)
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

// ── DSHBOTS-235 三档规则引擎守门 ─────────────────────────────────────────────

// 播种交付方 task 运行：kind='task'，可带 output（交付报告）与终态。
const seedTaskRun = (service, task, minutesAgo, botId, { status = 'succeeded', output = null, kind = 'task', trigger = 'task_started', error_code = null } = {}) => {
  service.store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, error_code, output, idempotency_key, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, 'write', ?, ?, ?, ?, ?, ?, ?, ?)`,
    `trun-${task.id}-${minutesAgo}-${Math.floor(Math.random() * 1e6)}`, task.project_id, botId, task.id,
    kind, trigger, status, error_code, output,
    `tidem-${task.id}-${minutesAgo}-${Math.floor(Math.random() * 1e6)}`,
    minutesAgoIso(minutesAgo + 5), minutesAgoIso(minutesAgo + 4), minutesAgoIso(minutesAgo),
  )
}

// 播种核验委派运行（成功结论落 output；评论同步落一条以贴近 finishRun 真实链路）。
const seedReviewDelegate = (service, task, minutesAgo, botId, conclusion) => {
  seedTaskRun(service, task, minutesAgo, botId, { kind: 'review', trigger: 'review_delegate', output: conclusion })
}

// 自动收口走异步 applyReview，断言前放掉 pending 微任务。
const settle = () => new Promise(resolve => setTimeout(resolve, 25))

const autoCloseAudits = (store, taskId) =>
  store.all("SELECT * FROM audit_log WHERE action = 'review.auto_close' AND target_id = ?", taskId)

// 建临时 git 仓库：devOn 分支含 onDevSha；offDevSha 只在 main 上（不在 dev）。
async function makeGitRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-git-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'] })
  git('init', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  execFileSync('sh', ['-c', `echo a > ${dir}/a.txt && git -C ${dir} add a.txt`])
  git('commit', '-m', 'c1')
  const onDevSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  git('branch', 'dev')
  execFileSync('sh', ['-c', `echo b > ${dir}/b.txt && git -C ${dir} add b.txt`])
  git('commit', '-m', 'c2')
  const offDevSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  return { dir, onDevSha, offDevSha }
}

test('规则 A·交付证据链：报告 commit 在 dev + 测试绿 → 自动 accept + 审计程序化收口', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const repo = await makeGitRepo()
  const { project, director } = await seedProject(service)
  store.run('UPDATE projects SET production_dir = ? WHERE id = ?', repo.dir, project.id)
  const task = await seedReviewTask(service, project, 45, { title: 'A 档交付' })
  seedTaskRun(service, task, 40, director.id, { output: `交付完成：修复 X。commit ${repo.onDevSha} 已在 dev。全量测试 1314/1314 通过。` })
  primeThreshold(service, '')
  const result = runReviewWatchdog(service)
  assert.deepEqual(result.alerted, [task.id])
  await settle()
  assert.equal(service.taskRow(task.id).status, 'done', 'A 档自动 accept')
  const audits = autoCloseAudits(store, task.id)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].actor_type, 'system')
  assert.ok(audits[0].data_json.includes('accept'))
  assert.ok(audits[0].data_json.includes('依据=交付证据'), '审计标注依据来源')
  const comments = store.all('SELECT body FROM task_comments WHERE task_id = ?', task.id)
  assert.ok(comments.some(c => c.body.includes('程序化收口')), '收口评论留痕')
})

test('规则 A·核验证据链：子代理核验结论建议 accept → 自动 accept（依据=核验证据）', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project, director } = await seedProject(service)
  const task = await seedReviewTask(service, project, 45, { title: 'A 档核验' })
  seedReviewDelegate(service, task, 35, director.id, '子代理核验：守门测试全绿，红验证如预期，建议 accept。')
  primeThreshold(service, '')
  runReviewWatchdog(service)
  await settle()
  assert.equal(service.taskRow(task.id).status, 'done')
  const audits = autoCloseAudits(store, task.id)
  assert.equal(audits.length, 1)
  assert.ok(audits[0].data_json.includes('依据=核验证据'))
})

test('规则 A 证据不全不自动：commit 不在 dev → C 仅提醒，卡留在 in_review', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const repo = await makeGitRepo()
  const { project, director } = await seedProject(service)
  store.run('UPDATE projects SET production_dir = ? WHERE id = ?', repo.dir, project.id)
  const task = await seedReviewTask(service, project, 45, { title: '证据不全' })
  seedTaskRun(service, task, 40, director.id, { output: `交付：commit ${repo.offDevSha}（未合 dev）。全量测试 10/10 通过。` })
  primeThreshold(service, '')
  runReviewWatchdog(service)
  await settle()
  assert.equal(service.taskRow(task.id).status, 'in_review', '证据链不全一律不自动')
  assert.equal(autoCloseAudits(store, task.id).length, 0)
  assert.equal(systemAlerts(store, project.id).length, 1, '回落 C 档提醒')
  const verdict = alertedMap(store)[task.id]
  assert.equal(verdict.verdict, 'C')
  assert.ok(verdict.basis.includes('commit 未验证在 dev'))
})

test('规则 B：交付方 run 中止无进展 → 自动 return 附「交付方无响应」', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project, director } = await seedProject(service)
  const task = await service.createTask({ projectId: project.id, title: 'B 档无响应', status: 'in_review', assigneeBotId: director.id })
  store.run('UPDATE tasks SET updated_at = ? WHERE id = ?', minutesAgoIso(50), task.id)
  seedTaskRun(service, task, 45, director.id, { status: 'canceled', error_code: 'TASK_LEFT_IN_PROGRESS' })
  primeThreshold(service, '')
  runReviewWatchdog(service)
  await settle()
  assert.equal(service.taskRow(task.id).status, 'in_progress', 'B 档自动 return 回到进行中')
  const comments = store.all('SELECT body FROM task_comments WHERE task_id = ?', task.id)
  assert.ok(comments.some(c => c.body.includes('交付方无响应')), '退回评论附交付方无响应')
  assert.equal(autoCloseAudits(store, task.id).length, 1)
})

test('开关关闭：review_auto_close=0 时 A/B 证据齐全也只提醒不自动（行为回到 D-194）', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project, director } = await seedProject(service)
  const task = await service.createTask({ projectId: project.id, title: '开关关', status: 'in_review', assigneeBotId: director.id })
  store.run('UPDATE tasks SET updated_at = ? WHERE id = ?', minutesAgoIso(50), task.id)
  seedTaskRun(service, task, 45, director.id, { status: 'canceled' })
  service.store.setSetting('review_auto_close', '0')
  primeThreshold(service, '')
  runReviewWatchdog(service)
  await settle()
  assert.equal(service.taskRow(task.id).status, 'in_review', '关闭时不自动收口')
  assert.equal(autoCloseAudits(store, task.id).length, 0)
  assert.equal(systemAlerts(store, project.id).length, 1, '提醒照常')
  assert.equal(alertedMap(store)[task.id].verdict, 'B', '判定仍记录供面板展示')
})

test('H1 滞留排总监验收运行：owner_bot 卡排 owner_task_run；user 卡不排；同档幂等', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project } = await seedProject(service)
  const ownerCard = await seedReviewTask(service, project, 45, { title: '总监验收卡' })
  store.run("UPDATE tasks SET review_target = 'owner_bot' WHERE id = ?", ownerCard.id)
  const userCard = await seedReviewTask(service, project, 45, { title: '用户验收卡' })
  primeThreshold(service, '')
  runReviewWatchdog(service)
  runReviewWatchdog(service)
  const ownerRows = store.all("SELECT * FROM outbox WHERE kind = 'owner_task_run' AND task_id = ?", ownerCard.id)
  assert.equal(ownerRows.length, 1, 'owner_bot 卡排一次总监验收（幂等键+去重表双保险）')
  assert.ok(ownerRows[0].idempotency_key.endsWith(':watchdog:t1'))
  assert.equal(store.all("SELECT * FROM outbox WHERE kind = 'owner_task_run' AND task_id = ?", userCard.id).length, 0, 'user 卡只提醒不排运行')
  // 系统消息本身不触发任何 bot 会话运行（board-drag-directive 锁死的口径不破）。
  assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE kind IN ('chat', 'solo_chat', 'dm_reply')").n, 0)
})

test('H2 分级升级：45m 首报；静置到 65m 二次催办升级语气；此前只一条', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project } = await seedProject(service)
  const task = await seedReviewTask(service, project, 45)
  primeThreshold(service, '')
  const first = runReviewWatchdog(service)
  assert.deepEqual(first.alerted, [task.id])
  assert.equal(first.escalated.length, 0)
  store.run('UPDATE tasks SET updated_at = ? WHERE id = ?', minutesAgoIso(65), task.id)
  const second = runReviewWatchdog(service)
  assert.deepEqual(second.escalated, [task.id])
  assert.deepEqual(second.alerted, [])
  const alerts = systemAlerts(store, project.id)
  assert.equal(alerts.length, 2)
  assert.match(alerts[1].body, /二次催办/)
  assert.doesNotMatch(alerts[0].body, /二次催办/)
})

test('H3 同源锚点：taskView.reviewIdle 锚点含最新评论；判定与依据透出面板', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project } = await seedProject(service)
  const task = await seedReviewTask(service, project, 90)
  seedComment(service, task, 5)
  primeThreshold(service, '')
  const before = service.taskView(service.taskRow(task.id)).reviewIdle
  assert.ok(before.anchorMs > Date.now() - 10 * 60_000, '锚点取最新评论而非 90 分钟前的 updated_at')
  assert.equal(before.thresholdMinutes, 30)
  assert.equal(before.escalateMinutes, 60, '默认 2×阈值升级线')
  assert.equal(before.verdict, null, '未判定前无 verdict')
  const judged = await seedReviewTask(service, project, 45, { title: '判定卡' })
  runReviewWatchdog(service)
  const after = service.taskView(service.taskRow(judged.id)).reviewIdle
  assert.equal(after.verdict.verdict, 'C')
  assert.ok(after.verdict.basis.length > 0)
})

test('H4 settings 白名单：review_idle_minutes 可保存/校验；开关与倍数同白名单', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const saved = service.updateSettings({ review_idle_minutes: '45', review_auto_close: '0', review_idle_escalate_multiple: '3' })
  assert.equal(saved.review_idle_minutes, '45')
  assert.equal(saved.review_auto_close, '0')
  assert.equal(saved.review_idle_escalate_multiple, '3')
  assert.equal(store.setting('review_idle_minutes'), '45')
  assert.throws(() => service.updateSettings({ review_idle_minutes: '9999' }), /整数分钟/)
  assert.throws(() => service.updateSettings({ review_auto_close: '2' }), /0 或 1/)
  assert.throws(() => service.updateSettings({ review_idle_escalate_multiple: '1' }), /整数/)
})

test('H5 逐卡容错：单卡异常不拖垮整轮，其余卡照常提醒；去重已落库', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project, director } = await seedProject(service)
  const boom = await seedReviewTask(service, project, 45, { title: '会炸的卡' })
  const normal = await seedReviewTask(service, project, 45, { title: '正常卡' })
  boom.assignee_bot_id = director.id
  seedTaskRun(service, boom, 40, director.id, { output: '报告含 commit abcdef1234567' })
  const original = service.projectWorkDir.bind(service)
  service.projectWorkDir = () => { throw new Error('git probe boom') }
  primeThreshold(service, '')
  const result = runReviewWatchdog(service)
  service.projectWorkDir = original
  assert.deepEqual(result.alerted, [normal.id], '异常卡跳过，正常卡照常提醒')
  assert.equal(systemAlerts(store, project.id).length, 1)
  const map = alertedMap(store)
  assert.ok(map[normal.id], '正常卡去重已落库')
  assert.ok(!map[boom.id], '异常卡未写去重，下轮可重试')
})

test('H5 扫描过滤归档项目 + 索引迁移落库', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  silenceWatchdog(service)
  const { project } = await seedProject(service, 'ARC')
  const task = await seedReviewTask(service, project, 500, { title: '归档项目卡' })
  store.run("UPDATE projects SET status = 'archived' WHERE id = ?", project.id)
  primeThreshold(service, '')
  const result = runReviewWatchdog(service)
  assert.deepEqual(result.alerted, [], '归档项目不扫')
  assert.equal(systemAlerts(store, project.id).length, 0)
  const runIndexes = store.all('PRAGMA index_list(runs)').map(row => row.name)
  const commentIndexes = store.all('PRAGMA index_list(task_comments)').map(row => row.name)
  assert.ok(runIndexes.includes('runs_task_idx'), 'runs.task_id 索引存在')
  assert.ok(commentIndexes.includes('task_comments_task_idx'), 'task_comments.task_id 索引存在')
  assert.ok(Boolean(store.get("SELECT 1 AS ok FROM schema_migrations WHERE name = 'review_watchdog_indexes'").ok))
  assert.equal(task.status, 'in_review')
})
