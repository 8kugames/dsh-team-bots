// tests/join-notify.test.ts —— DSHBOTS-229 ② 守门：入群通知。
// 锁定三件事：
//  ① addProjectMember 入群后向其他成员发群系统消息（纯文本、无 emoji，@其他成员）；
//  ② 通知失败只告警，不阻塞入群主流程（成员仍入群、临时目录仍创建）；
//  ③ D-225 临时目录钩子仍随入群创建（通知是同一链路的顺带动作，不替换原钩子）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-join-notify-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const warnings = []
  const service = new TeamService({
    store,
    config,
    logger: { info() {}, warn: (...args) => warnings.push(args), error() {} },
  })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const newcomer = await service.createBot({ name: 'Newcomer', role: '测试', instructions: 'Test.' })
  const project = await service.createProject({ name: 'Join Notify', key: 'JN', ownerBotId: director.id })
  const newcomerRow = store.get('SELECT * FROM bots WHERE id = ?', newcomer.id)
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, warnings, director, newcomer: newcomerRow, project, workspace, close }
}

const systemMessages = (store, projectId) =>
  store.all(
    "SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' ORDER BY created_at DESC",
    projectId,
  )

test('入群通知：addProjectMember 向其他成员发群系统消息，@其他成员', async () => {
  const t = await setup()
  try {
    const view = await t.service.addProjectMember(t.project.id, t.newcomer.id, { type: 'user', id: 'u1' })
    assert.ok(view.members.find(row => row.id === t.newcomer.id), '新成员应出现在项目视图')

    const rows = systemMessages(t.store, t.project.id)
    const notice = rows.find(row => row.body.includes('已加入项目群'))
    assert.ok(notice, '应发出入群通知系统消息')
    assert.equal(notice.body, '成员 Newcomer 已加入项目群。')
    const mentions = JSON.parse(notice.mentions_json)
    assert.ok(mentions.includes(t.director.id), '应 @ 其他成员（总监）')
    assert.ok(!mentions.includes(t.newcomer.id), '不应 @ 新成员自己')
  } finally { await t.close() }
})

test('入群通知失败不阻塞入群：只告警，成员仍入群、临时目录仍创建', async () => {
  const t = await setup()
  try {
    t.service.insertMessage = () => { throw new Error('boom') }
    const view = await t.service.addProjectMember(t.project.id, t.newcomer.id, { type: 'user', id: 'u1' })
    assert.ok(view.members.find(row => row.id === t.newcomer.id), '通知失败仍应入群')
    assert.ok(
      t.warnings.some(args => String(args[0]).includes('入群通知')),
      '应留下告警（降级不静默）',
    )
    assert.ok(
      existsSync(join(t.service.projectWorkDir(t.project), '.tmp', 'bots', 'Newcomer')),
      'D-225 临时目录钩子仍应创建',
    )
  } finally { await t.close() }
})

test('项目初建不触发入群通知（初建无「其他成员」语义）', async () => {
  const t = await setup()
  try {
    // 初建项目时 owner 与成员一并落库，不应产生入群通知。
    assert.equal(systemMessages(t.store, t.project.id).length, 0, '初建项目不应有入群通知')
  } finally { await t.close() }
})
