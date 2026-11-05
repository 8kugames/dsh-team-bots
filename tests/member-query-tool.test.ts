// tests/member-query-tool.test.ts —— DSHBOTS-229 ① 守门：成员查询工具。
// 锁定三件事：
//  ① 项目群内任意成员 bot 可查本项目名单/角色/状态（服务入口 + 工具注册执行同一链路）；
//  ② 查询范围限本项目成员，不泄露其他项目数据（其他项目的独占 bot、项目 key/名均不出现）；
//  ③ 非项目成员与单聊会话被 memberContextFor 拒绝；成员/总监提示词含使用指引。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { installTeamTools } from '../src/tools.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-member-query-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  config.agentTeam = true
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.' })
  const project = await service.createProject({ name: 'Member Query', key: 'MQ', ownerBotId: director.id, memberIds: [builder.id] })
  const builderRow = store.get('SELECT * FROM bots WHERE id = ?', builder.id)
  // 另一个项目与独占 bot：验证查询不泄露其他项目数据。
  const exclusive = await service.createBot({ name: 'Exclusive', role: '独占', instructions: 'Other project only.' })
  const other = await service.createProject({ name: 'Other Project', key: 'OTHER', ownerBotId: director.id, memberIds: [exclusive.id] })
  const exclusiveRow = store.get('SELECT * FROM bots WHERE id = ?', exclusive.id)
  const runtime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, runtime, director, builder: builderRow, project, exclusive: exclusiveRow, other, workspace, close }
}

const bindSession = (store, { sessionId, botId, projectId, kind = 'project' }) => {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
    sessionId, botId, projectId, kind, new Date().toISOString(),
  )
}

test('成员查询：项目成员可查本项目名单/角色/状态，不泄露其他项目数据', async () => {
  const t = await setup()
  try {
    bindSession(t.store, { sessionId: 'sess-builder', botId: t.builder.id, projectId: t.project.id })
    const text = t.service.listMembersFromBot('sess-builder')
    assert.match(text, /Builder/, '应列出自己')
    assert.match(text, /director/, '应列出总监')
    assert.match(text, /项目角色 owner/, '应给出项目角色')
    assert.match(text, /职责 开发/, '应给出 bot 职责')
    assert.match(text, /状态 active/, '应给出状态')
    assert.ok(!text.includes('Exclusive'), '不得出现其他项目的独占 bot')
    assert.ok(!text.includes('OTHER'), '不得出现其他项目 key')
    assert.ok(!text.includes('Other Project'), '不得出现其他项目名')
  } finally { await t.close() }
})

test('成员查询工具：注册进 tools 聚合，执行走会话绑定解析', async () => {
  const t = await setup()
  try {
    const tools = []
    installTeamTools({ tools: { register: (tool) => tools.push(tool) } }, t.service)
    const tool = tools.find(item => item.name === 'team_list_members')
    assert.ok(tool, 'team_list_members 未注册')
    bindSession(t.store, { sessionId: 'sess-builder-tool', botId: t.builder.id, projectId: t.project.id })
    const output = await tool.execute({}, { agent: { id: 'sess-builder-tool' } })
    assert.match(output, /Builder/, '工具执行应返回成员名单')
    assert.match(output, /director/, '工具执行应返回总监')
    assert.ok(!output.includes('Exclusive'), '工具执行不得泄露其他项目数据')
    // 工具描述风格：说明可用范围与项目限定。
    assert.match(tool.description, /Any bot in the project group may use this/)
    assert.match(tool.description, /never exposes other projects/)
  } finally { await t.close() }
})

test('成员查询鉴权：非项目成员与单聊会话被拒', async () => {
  const t = await setup()
  try {
    // Exclusive 是 OTHER 项目成员，但不是 MQ 成员：绑定到 MQ 会话即被成员闸门拒绝。
    bindSession(t.store, { sessionId: 'sess-exclusive', botId: t.exclusive.id, projectId: t.project.id })
    assert.throws(() => t.service.listMembersFromBot('sess-exclusive'), /不是该项目成员/)
    bindSession(t.store, { sessionId: 'sess-solo', botId: t.builder.id, projectId: null, kind: 'solo' })
    assert.throws(() => t.service.listMembersFromBot('sess-solo'), /只有项目群中的 Bot/)
    assert.throws(() => t.service.listMembersFromBot('sess-missing'), /只有项目群中的 Bot/)
  } finally { await t.close() }
})

test('提示词：成员与总监都获得成员查询指引，成员被告知编制入口为总监专权', async () => {
  const t = await setup()
  try {
    bindSession(t.store, { sessionId: 'sess-builder-prompt', botId: t.builder.id, projectId: t.project.id })
    const memberPrompt = t.runtime.systemPromptFor({ agent: { id: 'sess-builder-prompt' } })
    assert.match(memberPrompt, /`team_list_members`/, '成员提示词应含成员查询指引')
    assert.match(memberPrompt, /Team staffing is director-only/, '成员应被告知编制入口为总监专权')
    assert.match(memberPrompt, /`team_list_bots`, `team_add_member` and `team_create_bot`/, '成员应被告知三个编制工具不可用')

    bindSession(t.store, { sessionId: 'sess-director-prompt', botId: t.director.id, projectId: t.project.id })
    const ownerPrompt = t.runtime.systemPromptFor({ agent: { id: 'sess-director-prompt' } })
    assert.match(ownerPrompt, /`team_list_members`/, '总监提示词应含成员查询指引')
    assert.match(ownerPrompt, /`team_list_bots`/, '总监提示词应含 bots 池指引')
    assert.match(ownerPrompt, /`team_add_member`/, '总监提示词应含加人指引')
    assert.match(ownerPrompt, /`team_create_bot`/, '总监提示词应含建 bot 指引')
  } finally { await t.close() }
})
