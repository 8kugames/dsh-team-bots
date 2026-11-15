// tests/bots-pool-dispatch.test.ts —— DSHBOTS-229 ③ 守门：director 的 bots 池调度能力。
// 锁定四件事：
//  ① 池查询含未入群的 bot，仅总监可用，且不泄露其他项目数据；
//  ② 加人申请复用 addProjectMember（校验、审计、入群通知与失败语义不变）；
//  ③ 建 bot 申请复用 createBot（名称/唯一/模型校验不绕过，审计记总监为请求人，新 bot 不自动入群）；
//  ④ 三个新工具均为总监专权（服务层 ownerContextFor 权威闸门 + 工具层 deny 兜底）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { installTeamTools, DIRECTOR_ONLY_TOOLS } from '../src/tools.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bots-pool-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.' })
  const project = await service.createProject({ name: 'Pool Dispatch', key: 'POOL', ownerBotId: director.id, memberIds: [builder.id] })
  const outsider = await service.createBot({ name: 'Outsider', role: '候补', instructions: 'Not in a project.' })
  const exclusive = await service.createBot({ name: 'Exclusive', role: '独占', instructions: 'Other project only.' })
  const other = await service.createProject({ name: 'Other Project', key: 'OTHER', ownerBotId: director.id, memberIds: [exclusive.id] })
  const builderRow = store.get('SELECT * FROM bots WHERE id = ?', builder.id)
  const outsiderRow = store.get('SELECT * FROM bots WHERE id = ?', outsider.id)
  const exclusiveRow = store.get('SELECT * FROM bots WHERE id = ?', exclusive.id)
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return {
    store, service, director, builder: builderRow, outsider: outsiderRow, exclusive: exclusiveRow,
    project, other, workspace, close,
  }
}

const bindSession = (store, { sessionId, botId, projectId }) => {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES (?, ?, ?, 'project', NULL, ?)`,
    sessionId, botId, projectId, new Date().toISOString(),
  )
}

const registerTools = (service) => {
  const tools = []
  installTeamTools({ tools: { register: (tool) => tools.push(tool) } }, service)
  return tools
}

const auditOf = (store, action, targetId) =>
  store.get('SELECT * FROM audit_log WHERE action = ? AND target_id = ? ORDER BY created_at DESC LIMIT 1', action, targetId)

test('bots 池查询：总监可见含未入群的 bot，不泄露其他项目数据', async () => {
  const t = await setup()
  try {
    bindSession(t.store, { sessionId: 'sess-director', botId: t.director.id, projectId: t.project.id })
    const text = t.service.listBotsPoolFromBot('sess-director')
    assert.match(text, /Builder/, '应列出本项目成员')
    assert.match(text, /Outsider/, '应列出未入群的 bot')
    assert.match(text, /Exclusive/, '应列出其他项目的 bot（池含全部未移除 bot）')
    assert.match(text, /Builder.*本项目成员/, '本项目成员应标注成员身份')
    assert.match(text, /Outsider.*未入群/, '未入群 bot 应标注未入群')
    assert.ok(!text.includes('OTHER'), '不得出现其他项目 key')
    assert.ok(!text.includes('Other Project'), '不得出现其他项目名')
    // 池数据同样不含其他项目的成员关系字段。
    const pool = t.service.botsPoolFor(t.project.id)
    const exclusiveInPool = pool.bots.find(bot => bot.id === t.exclusive.id)
    assert.equal(exclusiveInPool.inProject, false, '其他项目成员在池里就是未入群')
    assert.equal(exclusiveInPool.memberRole, null, '不得带出其他项目的成员角色')
  } finally { await t.close() }
})

test('bots 池查询鉴权：成员 bot 被拒；工具注册与执行链路', async () => {
  const t = await setup()
  try {
    bindSession(t.store, { sessionId: 'sess-builder', botId: t.builder.id, projectId: t.project.id })
    assert.throws(() => t.service.listBotsPoolFromBot('sess-builder'), /只有项目总监 Bot 可以执行该操作/)

    const tools = registerTools(t.service)
    const tool = tools.find(item => item.name === 'team_list_bots')
    assert.ok(tool, 'team_list_bots 未注册')
    bindSession(t.store, { sessionId: 'sess-director-tool', botId: t.director.id, projectId: t.project.id })
    const output = await tool.execute({}, { agent: { id: 'sess-director-tool' } })
    assert.match(output, /Outsider.*未入群/, '工具执行应返回池名单')
    assert.match(tool.description, /Only the project owner bot may use this/)
    await assert.rejects(
      () => tool.execute({}, { agent: { id: 'sess-builder' } }),
      /只有项目总监 Bot 可以执行该操作/,
      '成员经工具执行同样被拒',
    )
  } finally { await t.close() }
})

test('加人申请链路：team_add_member 复用 addProjectMember（校验/审计/通知）', async () => {
  const t = await setup()
  try {
    const tools = registerTools(t.service)
    const tool = tools.find(item => item.name === 'team_add_member')
    assert.ok(tool, 'team_add_member 未注册')
    bindSession(t.store, { sessionId: 'sess-director', botId: t.director.id, projectId: t.project.id })

    const output = await tool.execute({ bot: 'Outsider' }, { agent: { id: 'sess-director' } })
    assert.match(output, /Added Outsider to POOL as member\./, '工具回执应说明加人结果')

    const member = t.store.get(
      "SELECT * FROM project_members WHERE project_id = ? AND member_id = ?",
      t.project.id, t.outsider.id,
    )
    assert.ok(member, '成员表应落行')
    const audit = auditOf(t.store, 'project.add_member', t.project.id)
    assert.equal(audit.actor_type, 'bot', '审计应为 bot  actor')
    assert.equal(audit.actor_id, t.director.id, '审计应记总监为请求人')
    const notice = t.store.get(
      "SELECT * FROM messages WHERE project_id = ? AND body LIKE '%已加入项目群%' ORDER BY created_at DESC LIMIT 1",
      t.project.id,
    )
    assert.ok(notice, '加人应顺带发出入群通知')

    // 校验语义与直接调用 addProjectMember 一致。
    await assert.rejects(() => tool.execute({ bot: 'Ghost' }, { agent: { id: 'sess-director' } }), /找不到 Bot/)
    await assert.rejects(() => tool.execute({ bot: 'Builder' }, { agent: { id: 'sess-director' } }), /已是项目成员/)
    await assert.rejects(() => tool.execute({}, { agent: { id: 'sess-director' } }), /缺少 Bot 名称/)

    await t.service.updateBot(t.outsider.id, { status: 'archived' }, { type: 'bot', id: t.director.id })
    await assert.rejects(
      () => tool.execute({ bot: 'Outsider' }, { agent: { id: 'sess-director' } }),
      /Bot 已归档/,
      '归档 bot 不可加人（addProjectMember 校验仍在）',
    )

    // 成员 bot 调加人工具被拒。
    bindSession(t.store, { sessionId: 'sess-builder', botId: t.builder.id, projectId: t.project.id })
    await assert.rejects(
      () => tool.execute({ bot: 'Outsider' }, { agent: { id: 'sess-builder' } }),
      /只有项目总监 Bot 可以执行该操作/,
    )
  } finally { await t.close() }
})

test('建 bot 申请链路：team_create_bot 复用 createBot 校验，不绕过', async () => {
  const t = await setup()
  try {
    const tools = registerTools(t.service)
    const tool = tools.find(item => item.name === 'team_create_bot')
    assert.ok(tool, 'team_create_bot 未注册')
    bindSession(t.store, { sessionId: 'sess-director', botId: t.director.id, projectId: t.project.id })

    const output = await tool.execute(
      { name: 'Newbie', role: '测试', instructions: 'Test the build.' },
      { agent: { id: 'sess-director' } },
    )
    assert.match(output, /Created bot Newbie \(status: active\)/, '工具回执应说明建 bot 结果')

    const created = t.store.get('SELECT * FROM bots WHERE name = ?', 'Newbie')
    assert.ok(created, '新 bot 应落库')
    assert.equal(created.status, 'active')
    assert.equal(created.role, '测试')
    const audit = auditOf(t.store, 'bot.create', created.id)
    assert.equal(audit.actor_type, 'bot', '审计应为 bot actor')
    assert.equal(audit.actor_id, t.director.id, '审计应记总监为请求人')
    const member = t.store.get(
      "SELECT * FROM project_members WHERE project_id = ? AND member_id = ?",
      t.project.id, created.id,
    )
    assert.ok(!member, '新 bot 不应自动入项目')

    // 名称/唯一/模型校验不绕过。
    await assert.rejects(
      () => tool.execute({ name: 'bad name!' }, { agent: { id: 'sess-director' } }),
      /Bot 名称只允许/,
    )
    await assert.rejects(
      () => tool.execute({ name: 'Newbie' }, { agent: { id: 'sess-director' } }),
      (error: any) => error.code === 'CONFLICT',
      '重名应冲突',
    )
    await assert.rejects(
      () => tool.execute({ name: 'NoModel', provider: 'fake' }, { agent: { id: 'sess-director' } }),
      /provider 和 model 必须同时提供/,
    )

    // 成员 bot 调建 bot 工具被拒。
    bindSession(t.store, { sessionId: 'sess-builder', botId: t.builder.id, projectId: t.project.id })
    await assert.rejects(
      () => tool.execute({ name: 'Sneaky' }, { agent: { id: 'sess-builder' } }),
      /只有项目总监 Bot 可以执行该操作/,
    )
  } finally { await t.close() }
})

test('专权清单：三个新工具均为总监专权（工具层 deny 兜底）', () => {
  const directorOnly: readonly string[] = DIRECTOR_ONLY_TOOLS
  for (const name of ['team_list_bots', 'team_add_member', 'team_create_bot']) {
    assert.ok(directorOnly.includes(name), `${name} 应是总监专权工具`)
  }
  assert.ok(!directorOnly.includes('team_list_members'), '成员查询工具不是总监专权')
})
