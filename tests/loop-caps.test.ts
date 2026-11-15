// tests/loop-caps.test.ts —— DSHBOTS-267 守门：防循环三上限 + 失败终态白名单分类。
// 三上限（配置默认值常量，写死在 notify.ts / run-finish.ts）：
//  ① 单 run 伙伴提醒（去重目标计条）≤3：第 4 条静默丢弃并记日志（notify 与 chat 两条路径）；
//  ② 同 run+同目标 bot 每日 ≤5：第 6 次静默丢弃并记日志；
//  ③ 每任务同时只允许一个跟进提醒在途：重复跟进幂等吸收，不计新不投递。
// 失败白名单分类：失败终态进群聊/微信前分类为有限类别，只透「类别+一句话摘要」，
// 原始错误串/文件路径不透传（完整信息仍落 runs.error_message 与 run_events）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { RUN_PARTNER_NOTICE_CAP, PARTNER_NOTICE_DAILY_CAP } from '../src/services/notify.js'
import { classifyFailure } from '../src/services/run-finish.js'

class StubRuntime {
  sent: Array<{ sessionId: string; body: string }> = []
  steer?: (sessionId: string, body: string) => Promise<void> = async (sessionId, body) => {
    this.sent.push({ sessionId, body })
  }
  setCompletionHandler() {}
  setMask() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  sessionBusy() { return false }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loopcaps-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const warnings: string[] = []
  const logger = { info() {}, warn: (...args: unknown[]) => warnings.push(args.join(' ')), error() {} }
  const service = new TeamService({ store, config, logger })
  const runtime = new StubRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const caller = await service.createBot({ name: 'Caller', role: '开发', instructions: 'Call.', provider: 'fake', model: 'model-a' })
  const targets = [] as Array<{ id: string; name: string }>
  for (let i = 1; i <= 4; i++) {
    targets.push(await service.createBot({ name: `Builder${i}`, role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' }))
  }
  const project = await service.createProject({
    name: 'LoopCaps', key: 'LCP', ownerBotId: director.id, memberIds: [caller.id, ...targets.map(t => t.id)],
  })
  const wechatPushes: string[] = []
  ;(service as any).wechat = { notify(text: string) { wechatPushes.push(text) } }
  // DSHBOTS-293：绑定夹具随四车道收敛改为 kind='bot' 控制面（与生产库一致，
  // 原旧车道夹具会掩盖 notifyMemberFromBot 的控制面绑定解析）。
  const bindSession = ({ sessionId, botId }: { sessionId: string; botId: string }) => store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, 'bot', NULL, ?)`,
    sessionId, botId, project.id, new Date().toISOString(),
  )
  const insertRunningRun = (id: string, botId: string, kind = 'task', triggerType = 'manual') => {
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, attempt, idempotency_key, session_id, queued_at, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', 1, ?, ?, ?, ?)`,
      id, project.id, botId, kind, triggerType, `idem-${id}`, `sess-${id}`, now, now,
    )
  }
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, runtime, logger, warnings, director, caller, targets, project, bindSession, insertRunningRun, wechatPushes, close }
}

// ① 单 run 上限：第 4 条（去重后第 4 个目标）静默 ──────────────────────────
test('单 run 伙伴提醒上限：前 3 个目标放行，第 4 条静默丢弃并记日志', async () => {
  const t = await setup()
  try {
    assert.equal(RUN_PARTNER_NOTICE_CAP, 3, '默认上限应为 3')
    t.bindSession({ sessionId: 'sess-caller', botId: t.caller.id })
    for (let i = 0; i < 4; i++) t.bindSession({ sessionId: `sess-b${i + 1}`, botId: t.targets[i].id })
    t.insertRunningRun('run-cap-a', t.caller.id)
    for (let i = 0; i < 3; i++) {
      const result = await t.service.notifyFromBot('sess-caller', { target: 'member', member: t.targets[i].name, message: `第 ${i + 1} 条` })
      assert.match(result, /已通知/, `第 ${i + 1} 条应放行`)
    }
    const fourth = await t.service.notifyFromBot('sess-caller', { target: 'member', member: t.targets[3].name, message: '第 4 条' })
    assert.match(fourth, /防循环上限/, '第 4 条应被静默丢弃')
    const noticeCount = t.store.get(
      "SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND body LIKE '【通知】%'", t.project.id,
    ).n
    assert.equal(noticeCount, 3, '第 4 条不得落任何留痕')
    assert.equal(t.runtime.sent.length, 3, '第 4 条不得投递')
    assert.ok(t.warnings.some(line => line.includes('超单 run 上限')), '丢弃应记 warn 日志')
  } finally { await t.close() }
})

// ② 每日上限：同 run 同目标第 6 次静默 ────────────────────────────────────
test('同 run+同目标每日上限：前 5 次放行，第 6 次静默丢弃并记日志', async () => {
  const t = await setup()
  try {
    assert.equal(PARTNER_NOTICE_DAILY_CAP, 5, '每日默认上限应为 5')
    t.bindSession({ sessionId: 'sess-caller', botId: t.caller.id })
    t.bindSession({ sessionId: 'sess-b1', botId: t.targets[0].id })
    t.insertRunningRun('run-cap-b', t.caller.id)
    for (let i = 1; i <= 5; i++) {
      const result = await t.service.notifyFromBot('sess-caller', { target: 'member', member: t.targets[0].name, message: `第 ${i} 次` })
      assert.match(result, /已通知/, `当日第 ${i} 次应放行`)
    }
    const sixth = await t.service.notifyFromBot('sess-caller', { target: 'member', member: t.targets[0].name, message: '第 6 次' })
    assert.match(sixth, /防循环上限/, '当日第 6 次应被静默丢弃')
    const noticeCount = t.store.get(
      "SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND body LIKE '【通知】%'", t.project.id,
    ).n
    assert.equal(noticeCount, 5, '第 6 次不得落任何留痕')
    assert.ok(t.warnings.some(line => line.includes('超每日上限')), '丢弃应记 warn 日志')
  } finally { await t.close() }
})

// ① chat 路径同闸：唤醒配额耗尽后 @ 派发静默清零 ──────────────────────────
test('chat @ 唤醒同用配额闸：同 run 已满 3 目标后，再 @ 不再派发', async () => {
  const t = await setup()
  try {
    const projectRow = t.service.projectRow(t.project.id)
    const botRow = t.store.get('SELECT * FROM bots WHERE id = ?', t.caller.id)
    t.insertRunningRun('run-cap-chat', t.caller.id, 'chat', 'chat')
    const run = t.store.get('SELECT * FROM runs WHERE id = ?', 'run-cap-chat')
    const first = t.service.insertMessage({
      projectId: t.project.id, senderType: 'bot', senderId: t.caller.id,
      body: `@${t.targets[0].name} @${t.targets[1].name} @${t.targets[2].name} 三位请跟进`,
    })
    const woken = t.service.dispatchBotMentionRuns(projectRow, run, botRow, first)
    assert.equal(woken.length, 3, '配额内三个目标都应唤醒')
    const second = t.service.insertMessage({
      projectId: t.project.id, senderType: 'bot', senderId: t.caller.id,
      body: `@${t.targets[3].name} 也请跟进`,
    })
    assert.equal(t.service.dispatchBotMentionRuns(projectRow, run, botRow, second).length, 0, '第 4 个目标应静默丢弃')
    assert.ok(t.warnings.some(line => line.includes('超单 run 上限')), 'chat 路径丢弃同样记 warn')
  } finally { await t.close() }
})

// ③ 单跟进者在途幂等：重复跟进不计数 ──────────────────────────────────────
test('任务跟进提醒幂等：在途提醒未消费前，重复提醒静默吸收不计新', async () => {
  const t = await setup()
  try {
    t.bindSession({ sessionId: 'sess-caller', botId: t.caller.id })
    const task = await t.service.createTask({
      projectId: t.project.id, title: '跟进幂等', description: '验三上限之三',
      assigneeBotId: t.targets[0].id, writeScopes: ['src/x/'], autoStart: false, postCard: false,
    }, { type: 'user', id: 'user_local' })
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, status, attempt, idempotency_key, session_id, queued_at, started_at)
       VALUES ('run-task-follow', ?, ?, ?, 'task', 'manual', 'running', 1, 'idem-follow', 'sess-task-follow', ?, ?)`,
      t.project.id, t.targets[0].id, task.id, new Date().toISOString(), new Date().toISOString(),
    )
    const first = await t.service.notifyFromBot('sess-caller', { target: 'task', task: `LCP-${task.number}`, message: '请跟进范围确认' })
    assert.match(first, /活跃运行注入提醒/, '首条跟进提醒应注入')
    const second = await t.service.notifyFromBot('sess-caller', { target: 'task', task: `LCP-${task.number}`, message: '再说一遍' })
    assert.match(second, /已有在途跟进提醒，本次重复未投递/, '重复跟进应幂等吸收')
    const reminders = t.store.get(
      "SELECT COUNT(*) AS n FROM messages WHERE task_id = ? AND body LIKE '【任务提醒】%'", task.id,
    ).n
    assert.equal(reminders, 1, '重复跟进不得落新留痕（不计新）')
    assert.equal(t.runtime.sent.length, 1, '重复跟进不得二次注入')
  } finally { await t.close() }
})

// ② 失败白名单分类：纯函数映射 ────────────────────────────────────────────
test('classifyFailure：限流/网络/未知样例映射到白名单类别', () => {
  assert.equal(classifyFailure({ code: 'RATE_LIMIT', message: '429 too many requests' }).label, '限流')
  assert.equal(classifyFailure({ code: 'ECONNRESET', message: 'read ECONNRESET' }).label, '网络')
  assert.equal(classifyFailure({ code: null, message: 'fetch failed' }).label, '网络')
  assert.equal(classifyFailure({ code: 'AUTH', message: 'bad api key' }).label, '未知')
  assert.equal(classifyFailure({ message: '模型超时' }).label, '超时')
  assert.equal(classifyFailure({ code: 'EPERM', message: 'file access denied under sandbox' }).label, '沙箱拒绝')
  assert.equal(classifyFailure({ code: 'ACCOUNT_QUOTA', message: '已达上限' }).label, '配额')
})

// ② 失败白名单分类：群聊/微信载荷不含原始错误串与路径 ─────────────────────
test('chat 运行失败：群聊与微信只透类别+摘要，原始错误串与路径不透传，完整信息仍进库', async () => {
  const t = await setup()
  try {
    const raw = 'Cannot read /Users/x/secret/plan-body.txt ENOENT 请求正文片段'
    const now = new Date().toISOString()
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, attempt, idempotency_key, session_id, queued_at, started_at)
       VALUES ('run-chat-fail', ?, ?, 'chat', 'wechat', 'running', 1, 'idem-chatfail', 'sess-x', ?, ?)`,
      t.project.id, t.caller.id, now, now,
    )
    await t.service.finishRun({ runId: 'run-chat-fail', status: 'failed', output: '', error: { code: 'AUTH', message: raw } })
    const msg = t.store.get("SELECT * FROM messages WHERE run_id = 'run-chat-fail'")
    assert.ok(msg, '失败仍应落群聊可见消息')
    assert.match(msg.body, /运行失败（未知）：/, '群聊载荷应含类别词')
    assert.ok(!msg.body.includes(raw), '群聊载荷不得含原始错误串')
    assert.ok(!msg.body.includes('/Users/x/secret/plan-body.txt'), '群聊载荷不得含文件路径')
    assert.equal(t.wechatPushes.length, 1, '微信应推一次')
    assert.match(t.wechatPushes[0], /运行失败（未知）：/, '微信载荷应含类别词')
    assert.ok(!t.wechatPushes[0].includes(raw) && !t.wechatPushes[0].includes('/Users/x/secret/plan-body.txt'), '微信载荷不得透传原始错误串与路径')
    // 完整信息仍进库（owner 可查），分类不吞错。
    const runRow = t.store.get('SELECT error_message FROM runs WHERE id = ?', 'run-chat-fail')
    assert.equal(runRow.error_message, raw, 'runs.error_message 应保留原始错误串')
  } finally { await t.close() }
})

// 既有失败路径回归：成功回复不受分类影响 ──────────────────────────────────
test('成功回复不受影响：chat 运行成功照常落原文并推微信', async () => {
  const t = await setup()
  try {
    const now = new Date().toISOString()
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, attempt, idempotency_key, session_id, queued_at, started_at)
       VALUES ('run-chat-ok', ?, ?, 'chat', 'wechat', 'running', 1, 'idem-chatok', 'sess-y', ?, ?)`,
      t.project.id, t.caller.id, now, now,
    )
    await t.service.finishRun({ runId: 'run-chat-ok', status: 'succeeded', output: '正常回复正文。' })
    const msg = t.store.get("SELECT * FROM messages WHERE run_id = 'run-chat-ok'")
    assert.equal(msg.body, '正常回复正文。', '成功回复原样落库')
    assert.ok(t.wechatPushes.at(-1)!.includes('正常回复正文。'), '成功回复照常推微信')
  } finally { await t.close() }
})
