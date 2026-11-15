// tests/recall-boundary.test.ts —— B5/DSHBOTS-333：有界上下文 + 资源指针读边界守门。
// 报告 B5 的两项价值核对结论：①有界上下文（尾窗 240 摘录 + m_/c_ 指针展开、任务分支 8k
// 截断、评论 ≤1.5k）已由 D-96/113/254 等价实现（prompt-budget/prompt-segments 在守）；
// ②「读权限与绑定隔离」——team 的隔离单元是项目（群聊共享上下文）+ 单聊私有（bot 维度），
// per-Ticket 读 ACL 与项目共享模型相悖不引入。本测试钉隔离不变量：
// ①项目会话只能展开本项目的 m_/c_/run_ 引用（跨项目 notFound）；
// ②单聊会话只能展开本 bot 的 solo_messages（其他 bot 的 m_ 引用不可达）；
// ③recall 无 bot_messages（bot 间私信）路径——私信上下文不进任何会话的按需展开面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recall-boundary-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const pA = store.get('SELECT * FROM projects WHERE id = ?', (await service.createProject({ name: 'A', key: 'AAA', ownerBotId: director.id })).id)
  const pB = store.get('SELECT * FROM projects WHERE id = ?', (await service.createProject({ name: 'B', key: 'BBB', ownerBotId: director.id })).id)
  const now = new Date().toISOString()
  const other = await service.createBot({ name: 'Other', role: '成员', instructions: '', provider: 'fake', model: 'model-a' })
  store.run(
    `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, kind, created_at)
     VALUES ('msg_aaaaaa', ?, (SELECT id FROM group_chats WHERE project_id = ?), 'user', 'u1', 'A 项目的机密上下文', 'text', ?)`, pA.id, pA.id, now,
  )
  store.run(
    `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, kind, created_at)
     VALUES ('msg_bbbbbb', ?, (SELECT id FROM group_chats WHERE project_id = ?), 'user', 'u1', 'B 项目的机密上下文', 'text', ?)`, pB.id, pB.id, now,
  )
  store.run(
    `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id, created_at, updated_at)
     VALUES ('t-b1', ?, 1, 'B 任务', 'in_progress', 'medium', 'user', 'u1', ?, ?)`, pB.id, now, now,
  )
  store.run(
    `INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at)
     VALUES ('cmt_bbbbbb', 't-b1', 'user', 'u1', 'B 项目的评论内容', ?)`, now,
  )
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, idempotency_key, queued_at)
     VALUES ('run_bbbbbb', ?, ?, 'chat', 'read', 'chat', 'succeeded', 'ik-runb', ?)`, pB.id, director.id, now,
  )
  store.run(
    `INSERT INTO solo_messages(id, bot_id, sender_type, sender_id, body, created_at)
     VALUES ('solo_aaaaaa', ?, 'user', 'u1', '总监单聊的私有内容', ?)`, director.id, now,
  )
  store.run(
    `INSERT INTO solo_messages(id, bot_id, sender_type, sender_id, body, created_at)
     VALUES ('solo_bbbbbb', ?, 'user', 'u1', '别的 bot 单聊的私有内容', ?)`, other.id, now,
  )
  const bind = (sessionId, projectId) => store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES (?, ?, ?, 'bot', NULL, ?)`, sessionId, director.id, projectId, now,
  )
  bind('sess-a', pA.id)    // 项目 A 控制面
  bind('sess-b', pB.id)    // 项目 B 控制面
  bind('sess-solo', null)  // 总监单聊
  return { root, store, service }
}

const teardown = async (root, store) => {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

test('项目会话：本项目引用可展开，跨项目 m_/c_/run_ 一律不可达', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  assert.match(service.recall('sess-a', 'm_aaaaaa'), /A 项目的机密上下文/, '本项目 m_ 可展开（正向控制）')
  assert.throws(() => service.recall('sess-a', 'm_bbbbbb'), /消息不存在/, '跨项目 m_ 不可达')
  assert.throws(() => service.recall('sess-a', 'c_bbbbbb'), /评论不存在/, '跨项目 c_ 不可达')
  assert.throws(() => service.recall('sess-a', 'run_bbbbbb'), /运行不存在/, '跨项目 run_ 不可达')
  assert.throws(() => service.recall('sess-a', 'BBB-1'), /找不到任务/, '跨项目任务编号不可达')
})

test('单聊会话：只展开本 bot 的 solo_messages，且不接受项目面引用', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  assert.match(service.recall('sess-solo', 'm_aaaaaa'), /总监单聊的私有内容/, '本 bot 单聊消息可展开')
  assert.throws(() => service.recall('sess-solo', 'm_bbbbbb'), /消息不存在/, '其他 bot 的单聊消息不可达')
  assert.throws(() => service.recall('sess-solo', 'c_bbbbbb'), /只支持展开 m_/, '单聊不接受评论引用')
  assert.throws(() => service.recall('sess-solo', 'run_bbbbbb'), /只支持展开 m_/, '单聊不接受运行引用')
})

test('recall 无 bot 间私信路径；未绑定会话 forbidden', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  store.run(
    `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, status, text, created_at)
     VALUES ('dm_secret', (SELECT id FROM projects WHERE key = 'AAA'), (SELECT id FROM bots WHERE name = 'director'), (SELECT id FROM bots WHERE name = 'Other'), 'req-1', 'delivered', 'bot 间私信正文', ?)`, new Date().toISOString(),
  )
  // m_/c_/run_/KEY-N 四类引用之外没有第五类：dm_secret 无法经任何前缀展开。
  for (const ref of ['m_secret', 'c_secret', 'run_secret']) {
    assert.throws(() => service.recall('sess-a', ref), /不存在/, `dm 内容经 ${ref} 不可达`)
  }
  assert.throws(() => service.recall('sess-none', 'm_aaaaaa'), /不属于任何项目/, '未绑定会话拒绝')
})
