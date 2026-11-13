// tests/reply-mode-tiering.test.ts —— 分级通知（吸收 dsh-agent-team 关注/直接信号理念，
// 落在本项目形态）。两个面：
// 投递面：群聊回复模式真实生效（此前 reply_mode 存而不用）——
//   owner_first 无目标时总监兜底（原行为）；everyone 无目标时全员响应；
//   mentioned_only 无目标时不唤醒任何 bot（消息留群给人看），@ 与引用 bot 照旧直达。
// 注入面：尾窗分级——@本 bot 的消息保持 240 全文并加 [→你] 标记，其他 bot 闲聊折叠
//   成 80 字 (背景) 摘要；人发的消息不折叠。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

class ManualRuntime {
  declare handler: (result: { runId: string; status: string; output: string; error: unknown }) => void
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-x' }
  async steer() { return true }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reply-mode-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Reply', key: 'REPLY', ownerBotId: director.id, memberIds: [dev.id] })
  const runtime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const botRow = store.get('SELECT * FROM bots WHERE id = ?', dev.id)
  const projectRow = store.get('SELECT * FROM projects WHERE id = ?', project.id)
  const chatRun = { kind: 'chat', mode: 'read' }
  return {
    root, store, service, runtime, chatRun, director, dev, botRow, projectRow,
    close: async () => {
      for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
        try { await service.cancelRunInternal(run.id, false) } catch {}
      }
      try { store.close() } catch {}
      await rm(root, { recursive: true, force: true })
    },
  }
}

const say = (t, body) => t.service.sendMessage(t.projectRow.id, body, { type: 'user', id: 'u1' })

test('投递面：owner_first（默认）无目标时总监兜底——原行为不变', async () => {
  const t = await setup()
  try {
    const sent = await say(t, '没人点名的普通消息')
    assert.deepEqual(sent.runBots, [t.director.id])
  } finally { await t.close() }
})

test('投递面：everyone 无目标时全员响应', async () => {
  const t = await setup()
  try {
    t.service.updateProject(t.projectRow.id, { replyMode: 'everyone' }, { type: 'user', id: 'u1' })
    const sent = await say(t, '大家听我说')
    assert.deepEqual([...sent.runBots].sort(), [t.director.id, t.dev.id].sort())
  } finally { await t.close() }
})

test('投递面：mentioned_only 环境消息延迟接单——立即回传总监气泡锚点，1 秒后自动入列', async () => {
  const t = await setup()
  try {
    t.service.updateProject(t.projectRow.id, { replyMode: 'mentioned_only' }, { type: 'user', id: 'u1' })
    const ambient = await say(t, '环境消息：总监一秒后默认接单')
    // 立即：不产生 chat_run 投递，但回传带总监（UI 思考气泡锚点）。
    assert.equal(
      t.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'chat_run'")?.n ?? 0, 0,
      '环境消息不立即产生 chat_run 投递',
    )
    assert.deepEqual(ambient.runBots, [t.director.id], '回传总监供 UI 立思考气泡')
    // 1 秒后：自动接单入列（outbox 即投即领，终态断言落在 runs 表上）。
    await new Promise(resolve => setTimeout(resolve, 1_150))
    const deadline = Date.now() + 3_000
    let claimed = null
    while (Date.now() < deadline) {
      claimed = t.store.get(
        "SELECT id FROM runs WHERE kind = 'chat' AND trigger_ref = ? AND bot_id = ?",
        ambient.messageId, t.director.id,
      ) ?? t.store.get(
        "SELECT id FROM outbox WHERE kind = 'chat_run' AND json_extract(payload_json, '$.messageId') = ?",
        ambient.messageId,
      )
      if (claimed) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(claimed, '1 秒后总监自动接单（chat 运行入列）')
    const mentioned = await say(t, '@Builder 这条你必须看')
    assert.deepEqual(mentioned.runBots, [t.dev.id], '直接信号（@）照旧必达且不惊动总监')
  } finally { await t.close() }
})

test('注入面：@本 bot 全文加 [→你] 标记，其他 bot 闲聊折叠 80 字 (背景)，人消息不折叠', async () => {
  const t = await setup()
  try {
    // 其他 bot 的长闲聊：应折叠到 80 字并标 (背景)。
    const chatter = 'B'.repeat(200)
    t.store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, created_at)
       SELECT ?, g.project_id, g.id, 'bot', ?, ?, '[]', ? FROM group_chats g WHERE g.project_id = ?`,
      'msg_chatter', t.director.id, chatter, new Date().toISOString(), t.projectRow.id,
    )
    // @本 bot 的长消息：应保持 240 全文并标 [→你]。
    const directed = 'D'.repeat(200)
    t.store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, created_at)
       SELECT ?, g.project_id, g.id, 'user', 'u1', ?, ?, ? FROM group_chats g WHERE g.project_id = ?`,
      'msg_directed', directed, JSON.stringify([t.dev.id]), new Date().toISOString(), t.projectRow.id,
    )
    const prompt = t.runtime.promptFor({
      run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: null, sessionId: 's-tier',
    })
    const chatterLine = prompt.split('\n').find(line => line.includes('msg_chatter'.slice(-6)) || line.includes('director'))
    assert.ok(chatterLine?.includes('(背景)'), 'bot 闲聊标 (背景)')
    assert.ok(!chatterLine?.includes('B'.repeat(100)), 'bot 闲聊折叠（200 字不得全文出现）')
    const directedLine = prompt.split('\n').find(line => line.includes('D'.repeat(100)))
    assert.ok(directedLine?.includes('[→你]'), '@本 bot 的消息加 [→你] 标记')
    assert.ok(prompt.includes('D'.repeat(200)), '直接信号保持全文（240 上限内）')
  } finally { await t.close() }
})
