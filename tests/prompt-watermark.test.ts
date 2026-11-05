// tests/prompt-watermark.test.js —— DSHBOTS-96 P1-1：尾窗增量水位
// 覆盖四条水位语义（前进/新会话全量/并发共用 session/不回退）、触发消息去双份、
// 无 sessionId 的旧固定尾窗兼容路径，以及 solo 单聊同款水位。
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-wm-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const project = await service.createProject({ name: 'Watermark', key: 'WM', ownerBotId: director.id, memberIds: [dev.id] })
  const runtime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const botRow = store.get('SELECT * FROM bots WHERE id = ?', dev.id)
  const projectRow = store.get('SELECT * FROM projects WHERE id = ?', project.id)
  const chatRun = { kind: 'chat', mode: 'read' }
  return {
    root, store, service, close: async () => {
      try { store.close() } catch {}
      await rm(root, { recursive: true, force: true })
    },
    director, dev, botRow, projectRow, runtime, chatRun,
    say: body => {
      const id = service.insertMessage({ projectId: project.id, senderType: 'user', senderId: 'u1', body })
      return store.get('SELECT * FROM messages WHERE id = ?', id)
    },
    msgRow: id => store.get('SELECT * FROM messages WHERE id = ?', id),
  }
}

const windowSection = prompt => {
  const start = prompt.indexOf('Recent project messages') >= 0
    ? prompt.indexOf('Recent project messages')
    : prompt.indexOf('New project messages')
  const end = prompt.indexOf('\nOpen tasks:')
  return start >= 0 ? prompt.slice(start, end) : prompt
}

test('新会话首次注入：无水位回退尾 12 条全量窗，并落水位', async () => {
  const t = await setup()
  try {
    for (let i = 1; i <= 15; i++) await t.say(`历史消息 ${i}：内容`)
    const prompt = t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: null, sessionId: 's1' })
    assert.match(prompt, /Recent project messages \(truncated, ids are for team_recall\):/)
    assert.ok(prompt.includes('历史消息 4'), '尾窗应含第 4 条（尾 12 起点）')
    assert.ok(!prompt.includes('历史消息 3'), '尾 12 之外的第 3 条不注入')
    const maxRow = t.store.get("SELECT MAX(rowid) AS m FROM messages WHERE project_id = ? AND kind = 'text'", t.projectRow.id).m
    assert.equal(t.runtime.messageWatermarks.get('s1'), maxRow, '水位应推进到当前最大 rowid')
  } finally { await t.close() }
})

test('水位前进：第二轮只注入新消息，旧消息不再回烧，触发消息不再双份', async () => {
  const t = await setup()
  try {
    for (let i = 1; i <= 5; i++) await t.say(`旧消息 ${i}：占位内容`)
    t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: null, sessionId: 's1' })
    const fresh = t.say('中途插入的新消息：应该在增量窗里')
    const trigger = t.say('本轮触发消息：正文已在 Group message 区')
    const prompt = t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: trigger, sessionId: 's1' })
    assert.match(prompt, /New project messages since your last turn \(ids are for team_recall\):/)
    assert.ok(prompt.includes('中途插入的新消息'), '增量窗应含水位后的新消息')
    assert.ok(!prompt.includes('旧消息 5'), '旧消息不再每轮回烧')
    const short = `m_${fresh.id.slice(-6)}`
    assert.equal(prompt.split(short).length - 1, 1, '新消息短 id 只出现一次')
    const triggerShort = `m_${trigger.id.slice(-6)}`
    assert.ok(!windowSection(prompt).includes(triggerShort), '触发消息不进尾窗（正文已在 # Group message 完整呈现）')
    assert.ok(prompt.includes('# Group message\n本轮触发消息'), '触发正文仍完整呈现')
    assert.equal(prompt.split(trigger.body).length - 1, 1, '触发正文只出现一份')
  } finally { await t.close() }
})

test('并发共用 session：先取窗者带走积压并前移水位，后取窗者空窗不丢不重', async () => {
  const t = await setup()
  try {
    for (let i = 1; i <= 4; i++) await t.say(`底料 ${i}`)
    t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: null, sessionId: 'shared' })
    const m5 = t.say('并发触发 A')
    const m6 = t.say('并发触发 B')
    // 两条运行先后取窗：A 先建 prompt（触发 m5），此时 m6 已落库
    const promptA = t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: m5, sessionId: 'shared' })
    const promptB = t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: m6, sessionId: 'shared' })
    assert.ok(promptA.includes('并发触发 B'), '先取窗者应把积压的 m6 一次带走（进同一 session 历史）')
    assert.ok(!promptA.includes(`m_${m5.id.slice(-6)}`), 'A 的触发消息不重复进自己的窗')
    assert.match(promptB, /No new project messages since your last turn\./, '后取窗者窗口为空（m5 已由 A 的 prompt 带入 session 历史）')
    assert.ok(!promptB.includes('底料 4'), '历史消息不再回烧')
    const maxRow = t.store.get("SELECT MAX(rowid) AS m FROM messages WHERE project_id = ? AND kind = 'text'", t.projectRow.id).m
    assert.equal(t.runtime.messageWatermarks.get('shared'), maxRow, '水位推进到全局最大，两条 prompt 合计不丢不重')
  } finally { await t.close() }
})

test('水位只前进不回退：人工调高后空窗推进不得把水位拉低', async () => {
  const t = await setup()
  try {
    for (let i = 1; i <= 3; i++) await t.say(`消息 ${i}`)
    t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: null, sessionId: 's1' })
    t.runtime.messageWatermarks.set('s1', 999_999)
    await t.say('更高的新消息')
    const prompt = t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: null, sessionId: 's1' })
    assert.match(prompt, /No new project messages since your last turn\./)
    assert.equal(t.runtime.messageWatermarks.get('s1'), 999_999, '水位不得回退到实际最大 rowid')
  } finally { await t.close() }
})

test('删除水位模拟进程重启：回退一次全量尾窗重新给足上下文', async () => {
  const t = await setup()
  try {
    for (let i = 1; i <= 13; i++) await t.say(`消息 ${i}`)
    t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: null, sessionId: 's1' })
    t.runtime.messageWatermarks.delete('s1')
    const prompt = t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: null, sessionId: 's1' })
    assert.match(prompt, /Recent project messages \(truncated, ids are for team_recall\):/)
    assert.ok(prompt.includes('消息 2'), '重启后重新注入尾 12 全量窗')
  } finally { await t.close() }
})

test('无 sessionId（直接调用）：固定尾窗兼容行为且不写水位，触发消息同样去双份', async () => {
  const t = await setup()
  try {
    await t.say('垫底的旧消息')
    const trigger = t.say('直接调用的触发消息')
    const prompt = t.runtime.promptFor({ run: t.chatRun, bot: t.botRow, project: t.projectRow, task: null, chatMessage: trigger })
    assert.match(prompt, /Recent project messages \(truncated, ids are for team_recall\):/, '无会话上下文时恒走全量尾窗')
    assert.ok(prompt.includes('垫底的旧消息'), '尾窗照常携带历史消息')
    assert.ok(!prompt.includes(`m_${trigger.id.slice(-6)}`), '触发消息不进窗（正文已在 # Group message 完整呈现，不双份）')
    assert.ok(prompt.includes('# Group message\n直接调用的触发消息'), '触发正文完整呈现')
    assert.equal(t.runtime.messageWatermarks.size, 0, '无 sessionId 不读不写水位')
  } finally { await t.close() }
})

test('solo 单聊同款水位：首次全量、次轮增量、触发消息排除', async () => {
  const t = await setup()
  try {
    for (let i = 1; i <= 3; i++) {
      t.service.insertSoloMessage({ botId: t.dev.id, senderType: 'user', senderId: 'u1', body: `单聊历史 ${i}` })
    }
    const soloRun = { kind: 'solo_chat', mode: 'read' }
    const first = t.runtime.promptFor({ run: soloRun, bot: t.botRow, project: null, task: null, chatMessage: null, sessionId: 'ss1' })
    assert.match(first, /Recent conversation \(truncated, ids are for team_recall\):/)
    assert.ok(first.includes('单聊历史 3'))
    const freshId = t.service.insertSoloMessage({ botId: t.dev.id, senderType: 'user', senderId: 'u1', body: '单聊新消息' })
    const triggerId = t.service.insertSoloMessage({ botId: t.dev.id, senderType: 'user', senderId: 'u1', body: '单聊触发消息' })
    const trigger = t.store.get('SELECT * FROM solo_messages WHERE id = ?', triggerId)
    const second = t.runtime.promptFor({ run: soloRun, bot: t.botRow, project: null, task: null, chatMessage: trigger, sessionId: 'ss1' })
    assert.match(second, /New messages since your last turn \(ids are for team_recall\):/)
    assert.ok(second.includes('单聊新消息'), '增量窗只含水位后新消息')
    assert.ok(!second.includes('单聊历史 3'), '旧单聊消息不再回烧')
    assert.ok(!second.includes(`m_${triggerId.slice(-6)}`), '触发消息不进增量窗')
    assert.ok(second.includes('# Solo message\n单聊触发消息'), '触发正文完整呈现')
    assert.equal(t.runtime.messageWatermarks.get('ss1'), t.store.get('SELECT MAX(rowid) AS m FROM solo_messages WHERE bot_id = ?', t.dev.id).m)
    assert.ok(freshId, '占位断言：新消息 id 存在')
  } finally { await t.close() }
})
