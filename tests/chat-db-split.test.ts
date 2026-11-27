import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { StubRuntime } from './helpers/runtime-stub.js'

// 聊天分库（docs/plans/chat-db-split.md）：正文四表出顶库，
// 每群聊（项目）/单聊（bot）一个库文件；顶库只留控制面与全局数据。

async function setup(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({
    workspace,
    dataDir,
    skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0,
    schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const makeProject = (key: string) => service.createProject({ name: `分库${key}`, key, ownerBotId: director.id })
  return {
    root, store, service, config, director, makeProject,
    close: async () => { service.stop(); store.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test('聊天分库：新消息落对应聊天库文件，顶库正文表保持空', async () => {
  const t = await setup('dsh-chatdb-layout-')
  try {
    const project = await t.makeProject('LAYOUT')
    const projectId = project.id
    await t.service.sendMessage(projectId, '第一条群消息', { type: 'user', id: 'u1' })
    const dev = await t.service.createBot({ name: 'Soloer', role: '开发', instructions: 'X.', provider: 'fake', model: 'm' })
    await t.service.sendSoloMessage(dev.id, '单聊第一条', { type: 'user', id: 'u1' })

    const groupFile = join(t.config.dataDir, 'chats', `p-${projectId}.sqlite`)
    const soloFile = join(t.config.dataDir, 'chats', `solo-${dev.id}.sqlite`)
    assert.ok(existsSync(groupFile), '群聊库文件已建')
    assert.ok(existsSync(soloFile), '单聊库文件已建')
    assert.ok(t.service.groupChatStore(projectId).get("SELECT id FROM messages WHERE body = '第一条群消息'"))
    assert.ok(t.service.soloChatStore(dev.id).get("SELECT id FROM solo_messages WHERE body = '单聊第一条'"))
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM messages')?.n, 0, '顶库 messages 已清空且不再写入')
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM solo_messages')?.n, 0, '顶库 solo_messages 已清空且不再写入')
  } finally { await t.close() }
})

test('聊天分库：Phase 1 迁移把存量正文搬进聊天库，重跑幂等', async () => {
  const t = await setup('dsh-chatdb-migrate-')
  try {
    const project = await t.makeProject('MIGRATE')
    const now = new Date().toISOString()
    // 在顶库直接预埋存量正文（模拟旧版本数据），再手动触发一次迁移逻辑的拷贝路径：
    // 正常路径由 initialize 的账本闸只跑一次，这里验证的是「拷贝幂等 + 顶库清空」的语义。
    const group = t.store.get('SELECT * FROM group_chats WHERE project_id = ?', project.id)
    t.store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, created_at)
       VALUES ('msg-old', ?, ?, 'user', 'u1', '旧版正文', ?)`,
      project.id, group.id, now,
    )
    t.store.run('DELETE FROM schema_migrations WHERE name LIKE ?', 'chat_split_p1%')
    t.service.migrateChatSplitP1()
    const chat = t.service.groupChatStore(project.id)
    assert.ok(chat.get("SELECT id FROM messages WHERE id = 'msg-old'"), '存量消息已进聊天库')
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM messages')?.n, 0, '顶库已清空')
    // 幂等：再跑一次不炸、不重复。
    t.store.run('DELETE FROM schema_migrations WHERE name = ?', 'chat_split_p1')
    t.service.migrateChatSplitP1()
    assert.equal(chat.get('SELECT COUNT(*) AS n FROM messages')?.n, 1)
  } finally { await t.close() }
})

test('聊天分库：运行轨迹写进运行归属的聊天库', async () => {
  const t = await setup('dsh-chatdb-traj-')
  try {
    const project = await t.makeProject('TRAJ')
    const bot = t.director
    const now = new Date().toISOString()
    const runId = 'run_traj_1'
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, 'chat', 'read', 'chat_message', 'running', 1, ?, ?)`,
      runId, project.id, bot.id, `key-${runId}`, now,
    )
    const run = t.store.get('SELECT * FROM runs WHERE id = ?', runId)
    t.service.runChatStore(run).run(
      `INSERT INTO run_trajectory(id, run_id, seq, kind, title, detail, created_at)
       VALUES ('traj1', ?, 1, 'thinking', '思考', '细节', ?)`,
      runId, now,
    )
    const view = t.service.runTrajectory(runId)
    assert.equal(view.entries.length, 1)
    assert.equal(view.entries[0].detail, '细节')
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM run_trajectory')?.n, 0, '顶库轨迹表保持空')
  } finally { await t.close() }
})

test('聊天分库：聊天库写入推进 state 版本，轮询短路口径保持', async () => {
  const t = await setup('dsh-chatdb-version-')
  try {
    const project = await t.makeProject('VERSION')
    const first = await t.service.state(project.id)
    await t.service.sendMessage(project.id, '版本推进消息', { type: 'user', id: 'u1' })
    const second = await t.service.state(project.id, null, { since: first.version })
    assert.ok(!second.unchanged, '聊天库新写入必须让轮询回全量')
    const third = await t.service.state(project.id, null, { since: second.version })
    assert.equal(third.unchanged, true, '无写入时短路命中')
  } finally { await t.close() }
})

test('聊天分库：未读计数按聊天库统计', async () => {
  const t = await setup('dsh-chatdb-unread-')
  try {
    const project = await t.makeProject('UNREAD')
    const bot = t.director
    assert.equal(t.service.unreadChatCounts().get(project.id) ?? 0, 0, '初始无未读')
    t.service.insertMessage({ projectId: project.id, senderType: 'bot', senderId: bot.id, body: 'bot 回复' })
    assert.equal(t.service.unreadChatCounts().get(project.id) ?? 0, 1, 'bot 新消息计未读')
  } finally { await t.close() }
})

test('聊天分库：移除追踪删除整个聊天库文件', async () => {
  const t = await setup('dsh-chatdb-drop-')
  try {
    const project = await t.makeProject('DROP')
    await t.service.sendMessage(project.id, '待删消息', { type: 'user', id: 'u1' })
    const groupFile = join(t.config.dataDir, 'chats', `p-${project.id}.sqlite`)
    assert.ok(existsSync(groupFile))
    await t.service.updateProject(project.id, { status: 'archived' })
    await t.service.removeProjectTracking(project.id, { confirmName: project.name })
    assert.ok(!existsSync(groupFile), '聊天库文件随移除追踪删除')
    assert.ok(!existsSync(`${groupFile}-wal`), 'WAL 一并删除')
    assert.equal(readdirSync(join(t.config.dataDir, 'chats')).includes(`p-${project.id}.sqlite`), false)
  } finally { await t.close() }
})

test('聊天分库：memory_review 引用单聊源运行读对库，不再产生 solo-undefined', async () => {
  // memory_review 的源运行查询若漏选路由列（project_id/bot_id），chatStoreForRun 会把
  // undefined 当单聊 bot id，凭空造出 solo-undefined.sqlite，且单聊源消息永远读不到。
  const t = await setup('dsh-chatdb-mrev-')
  try {
    const bot = await t.service.createBot({ name: '记忆审阅', role: '开发', instructions: 'X.', provider: 'fake', model: 'm' })
    await t.service.sendSoloMessage(bot.id, '请记住我喜欢简短的回复', { type: 'user', id: 'u1' })
    const message = t.service.soloChatStore(bot.id).get("SELECT * FROM solo_messages WHERE body = '请记住我喜欢简短的回复'")
    assert.ok(message, '源消息已落单聊库')
    const now = new Date().toISOString()
    const columns = 'id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at, trigger_ref'
    t.store.run(
      `INSERT INTO runs(${columns}) VALUES ('run_src_solo', NULL, ?, 'solo_chat', 'read', 'chat_message', 'succeeded', 1, 'k-src', ?, ?)`,
      bot.id, now, message.id,
    )
    t.store.run(
      `INSERT INTO runs(${columns}) VALUES ('run_review_1', NULL, ?, 'memory_review', 'read', 'schedule', 'succeeded', 1, 'k-rev', ?, 'run_src_solo')`,
      bot.id, now,
    )
    const run = t.store.get('SELECT * FROM runs WHERE id = ?', 'run_review_1')
    const { DshRuntime } = await import('../src/runtime.js')
    const runtime = new DshRuntime({
      ctx: null, config: t.config, store: t.store,
      logger: { info() {}, warn() {}, error() {} },
      chatStores: { forRun: (source: any) => t.service.runChatStore(source) },
    })
    const prompt = runtime.promptFor({
      run, bot: { name: bot.name },
      project: { id: 'p-solo', key: 'SOLO', name: '单聊', slug: 'solo' } as any,
    })
    assert.ok(String(prompt).includes('请记住我喜欢简短的回复'), '单聊源消息正文进得了 memory review 提示词')
    const files = readdirSync(join(t.config.dataDir, 'chats'))
    assert.equal(files.some(f => f.startsWith('solo-undefined') || f.startsWith('solo-null')), false,
      '不得产生路由列缺失导致的垃圾库文件')
  } finally { await t.close() }
})

test('聊天分库 Phase 2：recordUsage 明细落聊天库、顶库汇总同步累加', async () => {
  const t = await setup('dsh-chatdb-p2w-')
  try {
    const project = await t.makeProject('P2W')
    const chatStore = t.service.groupChatStore(project.id)
    const { recordUsage } = await import('../src/usage.js')
    recordUsage(t.store, {
      chatStore, sourceKey: 'p2-a',
      run: { id: 'r1', project_id: project.id, bot_id: t.director.id, task_id: null },
      provider: 'fake', model: 'm1', usage: { input: 100, output: 40 },
      occurredAt: '2026-11-18T09:30:00.000Z',
    })
    recordUsage(t.store, {
      chatStore, sourceKey: 'p2-b',
      run: { id: 'r2', project_id: project.id, bot_id: t.director.id, task_id: null },
      provider: 'fake', model: 'm1', usage: { input: 50, output: 10 },
      occurredAt: '2026-11-18T09:45:00.000Z',
    })
    assert.equal(chatStore.get('SELECT COUNT(*) AS n FROM usage_events')?.n, 2, '明细住聊天库')
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM usage_events')?.n, 0, '顶库不落明细')
    const rollup = t.store.get('SELECT * FROM usage_rollup')
    assert.equal(rollup.calls, 2, '同小时桶累加为一条汇总')
    assert.equal(rollup.input_tokens, 150)
    assert.equal(rollup.project_key, project.key, 'project_key 冗余存档')
    // 幂等：同 sourceKey 重放只记一次
    recordUsage(t.store, {
      chatStore, sourceKey: 'p2-a',
      run: { id: 'r1', project_id: project.id, bot_id: t.director.id, task_id: null },
      provider: 'fake', model: 'm1', usage: { input: 100, output: 40 },
      occurredAt: '2026-11-18T09:30:00.000Z',
    })
    assert.equal(rollup.calls, 2)
  } finally { await t.close() }
})

test('聊天分库 Phase 2：迁移搬明细建汇总、task_id 回填、幂等可重跑', async () => {
  const t = await setup('dsh-chatdb-p2m-')
  try {
    const project = await t.makeProject('P2M')
    const now = new Date().toISOString()
    const runId = 'run_p2_hist'
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at, task_id)
       VALUES (?, ?, ?, 'chat', 'read', 'chat_message', 'succeeded', 1, 'k-p2', ?, NULL)`,
      runId, project.id, t.director.id, now,
    )
    // 历史行：task_id 为 NULL，归属靠 run（迁移应回填）。
    t.store.run(
      `INSERT INTO usage_events(id, source_key, source_event_id, run_id, project_id, bot_id, task_id, provider, model, purpose, currency,
         input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, input_cost, output_cost, total_cost, occurred_at, created_at)
       VALUES ('use_p2_1', 'sk-p2-1', NULL, ?, ?, ?, NULL, 'fake', 'm1', 'run', 'CNY', 300, 0, 0, 100, 0, NULL, NULL, NULL, ?, ?)`,
      runId, project.id, t.director.id, now, now,
    )
    // initialize() 在空库上已跑过一轮迁移并记账；清账本后手动重跑验证拷贝路径。
    t.store.run('DELETE FROM schema_migrations WHERE name LIKE ?', 'chat_split_p2%')
    t.service.migrateChatSplitP2()
    const chat = t.service.groupChatStore(project.id)
    const row = chat.get("SELECT * FROM usage_events WHERE id = 'use_p2_1'")
    assert.ok(row, '明细已迁入聊天库')
    const rollup = t.store.get('SELECT * FROM usage_rollup')
    assert.equal(rollup?.calls ?? 0, 1, '汇总已按明细建桶')
    assert.equal(rollup.input_tokens + rollup.output_tokens, 400)
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM usage_events')?.n, 0, '顶库明细清空')
    // 幂等重跑：不炸、不重复。
    t.store.run('DELETE FROM schema_migrations WHERE name = ?', 'chat_split_p2')
    t.service.migrateChatSplitP2()
    assert.equal(chat.get('SELECT COUNT(*) AS n FROM usage_events')?.n, 1)
    assert.equal(t.store.get("SELECT SUM(calls) AS c FROM usage_rollup")?.c, 1, '汇总不重复累加')
  } finally { await t.close() }
})

test('聊天分库 Phase 3：事件/评论/终端迁入聊天库、runs 瘦身、幂等可重跑', async () => {
  const t = await setup('dsh-chatdb-p3m-')
  try {
    const project = await t.makeProject('P3M')
    const now = new Date().toISOString()
    const runId = 'run_p3_hist'
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at, task_id, output, artifacts)
       VALUES (?, ?, ?, 'task', 'write', 'dispatch', 'succeeded', 1, 'k-p3', ?, NULL, '历史交付正文', '["a.png"]')`,
      runId, project.id, t.director.id, now,
    )
    t.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      'evt_p3_1', runId, 'succeeded', '完成', now,
    )
    const taskId = 'task_p3_hist'
    t.store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, creator_type, creator_id, created_at, updated_at)
       VALUES (?, ?, 1, 'P3 历史任务', 'done', 'user', 'u1', ?, ?)`,
      taskId, project.id, now, now,
    )
    t.store.run(
      'INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      'cmt_p3_1', taskId, 'user', 'u1', '历史评论', now,
    )
    t.store.run(
      'INSERT INTO task_events(id, task_id, type, actor_type, actor_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'te_p3_1', taskId, 'commented', 'user', 'u1', '{}', now,
    )
    t.store.run(
      'INSERT INTO terminal_commands(id, project_id, command, status, created_at) VALUES (?, ?, ?, ?, ?)',
      'tc_p3_1', project.id, 'ls', 'done', now,
    )
    // initialize() 空库已记账；清账本后手动重跑验证拷贝路径。
    t.store.run('DELETE FROM schema_migrations WHERE name LIKE ?', 'chat_split_p3%')
    t.service.migrateChatSplitP3()
    const chat = t.service.groupChatStore(project.id)
    assert.ok(chat.get("SELECT * FROM run_events WHERE id = 'evt_p3_1'"), '事件已迁入聊天库')
    assert.ok(chat.get("SELECT * FROM task_comments WHERE id = 'cmt_p3_1'"), '评论已迁入聊天库')
    assert.ok(chat.get("SELECT * FROM task_events WHERE id = 'te_p3_1'"), '任务事件已迁入聊天库')
    assert.ok(chat.get("SELECT * FROM terminal_commands WHERE id = 'tc_p3_1'"), '终端命令已迁入聊天库')
    assert.equal(chat.get('SELECT output FROM run_payload WHERE run_id = ?', runId)?.output, '历史交付正文', '胖载荷已入聊天库')
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM run_events')?.n, 0, '顶库事件清空')
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM task_comments')?.n, 0, '顶库评论清空')
    const runRow = t.store.get('SELECT * FROM runs WHERE id = ?', runId)
    assert.equal(runRow.output, null, 'runs 已瘦身（output 清空）')
    assert.equal(t.service.runOutputOf(runRow), '历史交付正文', '读取经载荷并回')
    // 幂等重跑：不炸、不重复。
    t.store.run('DELETE FROM schema_migrations WHERE name = ?', 'chat_split_p3')
    t.service.migrateChatSplitP3()
    assert.equal(chat.get('SELECT COUNT(*) AS n FROM run_events')?.n, 1)
  } finally { await t.close() }
})

test('聊天分库 Phase 3：insertRunEvent 统一收口按运行归属落库', async () => {
  const t = await setup('dsh-chatdb-p3w-')
  try {
    const project = await t.makeProject('P3W')
    const now = new Date().toISOString()
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
       VALUES ('run_p3_w', ?, ?, 'chat', 'read', 'chat_message', 'succeeded', 1, 'k-p3w', ?)`,
      project.id, t.director.id, now,
    )
    t.service.insertRunEvent('run_p3_w', 'succeeded', '完成')
    const chat = t.service.groupChatStore(project.id)
    assert.ok(chat.get("SELECT * FROM run_events WHERE run_id = 'run_p3_w' AND type = 'succeeded'"), '事件落在项目聊天库')
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM run_events')?.n, 0, '顶库不落')
  } finally { await t.close() }
})

test('聊天分库：领取定档按聊天库 sender_type 实测（bot 派发降机器档）', async () => {
  // 分库后顶库 messages 恒空，定档须按聊天库里的 sender_type 实测，
  // bot @mention 派发的群聊运行才会被降到机器流量档。
  const t = await setup('dsh-chatdb-tier-')
  try {
    const project = await t.makeProject('TIER')
    const userMsg = t.service.insertMessage({ projectId: project.id, senderType: 'user', senderId: 'u1', body: '用户提问' })
    const botMsg = t.service.insertMessage({ projectId: project.id, senderType: 'bot', senderId: t.director.id, body: 'bot 回复并 @同伴' })
    assert.equal(t.service.claimTierOf({ kind: 'chat', project_id: project.id, trigger_ref: userMsg }), 1, '用户触发的群聊是 tier 1')
    assert.equal(t.service.claimTierOf({ kind: 'chat', project_id: project.id, trigger_ref: botMsg }), 2, 'bot 触发的群聊降到机器流量档')
    assert.equal(t.service.claimTierOf({ kind: 'chat', project_id: project.id, trigger_ref: 'msg_missing' }), 1, '触发消息缺失按用户档不降级')
    assert.equal(t.service.claimTierOf({ kind: 'task', task_priority: 'urgent' }), 0, 'urgent 任务最先')
    assert.equal(t.service.claimTierOf({ kind: 'task', task_priority: 'low' }), 3)
    assert.equal(t.service.claimTierOf({ kind: 'solo_chat' }), 1, '非群聊运行视同 high')
  } finally { await t.close() }
})

test('聊天分库：批量快照不返回 LRU 淘汰关闭的句柄', async () => {
  // 聊天库数超过 LRU 上限时，allChatStores() 若边开边淘汰，淘汰会当场关闭本轮
  // 已收集进数组的句柄，applyRetention 随后的扇出清理打到已关闭的库报
  // "database is not open"。批量快照期间必须不做淘汰。
  const t = await setup('dsh-chatdb-batch-')
  try {
    // 建出超过 LRU 上限（32）的聊天库数，逐个落一条消息让文件真实存在。
    const projectIds: string[] = []
    for (let i = 0; i < 34; i++) {
      const project = await t.makeProject(`BATCH${i}`)
      projectIds.push(project.id)
      await t.service.sendMessage(project.id, `批量消息${i}`, { type: 'user', id: 'u1' })
    }
    assert.equal(readdirSync(join(t.config.dataDir, 'chats')).filter(f => f.endsWith('.sqlite')).length >= 34, true)
    // 批量快照里每个句柄都必须仍可用：任何一个被淘汰关闭都会在这里抛错。
    const snapshot = t.service.allChatStores()
    assert.equal(snapshot.length >= 34, true)
    for (const chatStore of snapshot) {
      assert.equal(chatStore.get('SELECT COUNT(*) AS n FROM messages') !== undefined, true)
    }
    // 紧接扇出清理（生产路径 runMaintenance → applyRetention 同口径）不得再报库已关。
    const { applyRetention } = await import('../src/usage-reconcile.js')
    applyRetention(t.store, { usageDays: 0, runEventDays: 0, messageDays: 7, reconciliationDays: 30 }, t.service.allChatStores())
    assert.equal(t.service.groupChatStore(projectIds[0]).get('SELECT 1 AS ok')?.ok, 1, '首开的库在扇出后仍可用')
  } finally { await t.close() }
})
