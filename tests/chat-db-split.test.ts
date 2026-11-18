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

// 聊天分库 Phase 1（docs/plans/chat-db-split.md）：正文四表出顶库，
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
