// 收件箱 @owner 事项：总监在群聊里写出 @owner 即进收件箱，只有手动标已读才移出；
// 锚点取数让已经不在最近窗口里的消息也能跳转到位。真实建库验证，前端断言见 tests/inbox-ui.test.ts。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { handleAction } from '../src/api.js'
import { hasOwnerMention } from '../src/util.js'

class StubRuntime {
  declare ctx: any
  constructor(ctx = null) {
    this.ctx = ctx
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }: any) { return `session-${run.id}` }
  async cancelRun() { return true }
}

const user = { type: 'user', id: 'user_local' } as const

async function setup() {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-inbox-'))
  const workspace = join(rootDir, 'workspace')
  const dataDir = join(rootDir, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const programmer = store.get("SELECT * FROM bots WHERE name = 'programmer'")
  return { root: rootDir, store, service, director, programmer }
}

async function withSetup(run: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<void> | void) {
  const ctx = await setup()
  try {
    await run(ctx)
  } finally {
    await rm(ctx.root, { recursive: true, force: true })
  }
}

const post = (service, project, senderType, senderId, body, createdAt) =>
  service.insertMessage({ projectId: project.id, senderType, senderId, body, createdAt })

const errorCode = async (run: () => unknown) => {
  try {
    await run()
  } catch (error: any) {
    return error.code
  }
  return null
}

test('@owner 匹配：行首、空白、标点后都算；更长写法、邮箱式引用不算', () => {
  for (const body of ['@owner 请验收', '任务完成，@owner 请决策', '致 @owner：', '@Owner 看这里', '@owner\n第二行']) {
    assert.equal(hasOwnerMention(body), true, body)
  }
  for (const body of ['', 'owner', '@owners', '@owner2', '@owner_x', 'mail me x@owner.com', '@@owner', '聊天里没有标记']) {
    assert.equal(hasOwnerMention(body), false, body)
  }
})

test('只有总监的群消息写出 @owner 才进收件箱；成员 Bot、用户、单聊里的 @owner 只是普通文本', () => withSetup(async ({ service, director, programmer }) => {
  const project = await service.createProject({ name: '收件箱项目', key: 'INBOX', ownerBotId: director.id })
  const at = minute => `2026-11-26T00:${String(minute).padStart(2, '0')}:00.000Z`
  const hit = post(service, project, 'bot', director.id, '@owner 任务 A 已完成，请验收。', at(1))
  post(service, project, 'bot', programmer.id, '@owner 成员也写了标记', at(2))
  post(service, project, 'user', user.id, '@owner 我自己写的', at(3))
  post(service, project, 'bot', director.id, '总监的普通回复，没有标记', at(4))
  service.insertSoloMessage({ botId: director.id, senderType: 'bot', senderId: director.id, body: '@owner 单聊里的标记' })

  const pending = service.ownerMentionsPending()
  assert.equal(pending.count, 1)
  assert.equal(pending.items.length, 1)
  const item = pending.items[0]
  assert.equal(item.id, hit)
  assert.equal(item.project_id, project.id)
  assert.equal(item.projectName, '收件箱项目')
  assert.equal(item.projectKey, 'INBOX')
  assert.equal(item.senderName, 'director')
  assert.equal(item.snippet, '@owner 任务 A 已完成，请验收。')
  assert.equal(item.created_at, at(1))
  assert.equal(item.taskIdentifier, null)

  const view = await service.state(project.id)
  assert.equal(view.pendingOwnerMentions.count, 1, 'state 顶层下发收件箱聚合')
}))

test('跨项目聚合按时间倒序；归档项目的事项隐藏；跳转查看与群聊已读水位都不改变事项', () => withSetup(async ({ service, director }) => {
  const at = minute => `2026-11-26T00:${String(minute).padStart(2, '0')}:00.000Z`
  const projectA = await service.createProject({ name: '项目甲', key: 'JIA', ownerBotId: director.id })
  const projectB = await service.createProject({ name: '项目乙', key: 'YI', ownerBotId: director.id })
  post(service, projectA, 'bot', director.id, '@owner 甲的第一条', at(1))
  const later = post(service, projectB, 'bot', director.id, '@owner 乙的一条', at(5))
  const newest = post(service, projectA, 'bot', director.id, '@owner 甲的第二条', at(9))

  let pending = service.ownerMentionsPending()
  assert.deepEqual(pending.items.map(item => item.id).slice(0, 2), [newest, later], '跨项目按消息时间倒序')
  assert.equal(pending.count, 3)

  service.markChatRead(projectA.id, at(9))
  const firstPage = await service.state(projectA.id)
  assert.equal(firstPage.pendingOwnerMentions.count, 3, '进群查看不等于已处理')

  await service.archiveProject(projectB.id, user)
  pending = service.ownerMentionsPending()
  assert.equal(pending.count, 2, '归档项目的事项不再展示')
  assert.ok(pending.items.every(item => item.project_id === projectA.id))
}))

test('标已读：仅工作台用户可操作，重复标记按不存在处理；全部标已读连归档项目一并清掉', () => withSetup(async ({ service, director, programmer }) => {
  const projectA = await service.createProject({ name: '项目甲', key: 'JIA', ownerBotId: director.id })
  const projectB = await service.createProject({ name: '项目乙', key: 'YI', ownerBotId: director.id })
  const hit = post(service, projectA, 'bot', director.id, '@owner 请决策', '2026-11-26T00:01:00.000Z')
  post(service, projectB, 'bot', director.id, '@owner 乙的事项', '2026-11-26T00:02:00.000Z')

  assert.equal(await errorCode(() => handleAction(service, 'inbox_mark_read', { projectId: projectA.id, messageId: hit }, { type: 'bot', id: programmer.id })), 'FORBIDDEN')
  assert.equal(await errorCode(() => handleAction(service, 'inbox_mark_all_read', {}, { type: 'bot', id: programmer.id })), 'FORBIDDEN')

  const marked = await handleAction(service, 'inbox_mark_read', { projectId: projectA.id, messageId: hit }, user)
  assert.equal(marked.read, true)
  assert.equal(service.ownerMentionsPending().count, 1)
  assert.equal(await errorCode(() => handleAction(service, 'inbox_mark_read', { projectId: projectA.id, messageId: hit }, user)), 'NOT_FOUND', '已读的不再重复标记')

  await service.archiveProject(projectB.id, user)
  const all = await handleAction(service, 'inbox_mark_all_read', {}, user)
  assert.equal(all.count, 1, '归档项目的未读事项一并清掉')
  assert.equal(service.ownerMentionsPending().count, 0)
}))

test('/clear 清群后，对应项目的 @owner 事项随之消失', () => withSetup(async ({ service, director }) => {
  const project = await service.createProject({ name: '清群项目', key: 'CLEAR', ownerBotId: director.id })
  post(service, project, 'bot', director.id, '@owner 清群前的事项', '2026-11-26T00:01:00.000Z')
  assert.equal(service.ownerMentionsPending().count, 1)
  service.clearChatHistory(project.id, user)
  assert.equal(service.ownerMentionsPending().count, 0)
}))

test('锚点取数：返回截至锚点的一页，锚点是最后一条，并告知之前是否还有、之后还有多少条', () => withSetup(async ({ service, director }) => {
  const project = await service.createProject({ name: '锚点项目', key: 'ANCHOR', ownerBotId: director.id })
  const at = second => `2026-11-26T00:00:${String(second).padStart(2, '0')}.000Z`
  const ids = [0, 1, 2, 3, 4].map(second => post(service, project, 'bot', director.id, `第 ${second} 条`, at(second)))

  const middle = await service.messagesPage({ projectId: project.id, anchorId: ids[1] })
  assert.deepEqual(middle.messages.map(message => message.id), [ids[0], ids[1]])
  assert.equal(middle.hasMore, false)
  assert.equal(middle.newerCount, 3)

  const newest = await service.messagesPage({ projectId: project.id, anchorId: ids[4] })
  assert.equal(newest.messages.length, 5)
  assert.equal(newest.newerCount, 0)

  const paged = await service.messagesPage({ projectId: project.id, anchorId: ids[2], limit: 2 })
  assert.deepEqual(paged.messages.map(message => message.id), [ids[1], ids[2]])
  assert.equal(paged.hasMore, true, '锚点之前还有更早消息')
  assert.equal(paged.newerCount, 2)

  assert.equal(await errorCode(() => service.messagesPage({ projectId: project.id, anchorId: 'msg_missing' })), 'NOT_FOUND')
  assert.equal(await errorCode(() => service.messagesPage({ soloBotId: director.id, anchorId: ids[0] })), 'BAD_REQUEST', '锚点取数仅支持群聊')
}))

test('owner 是 @owner 标记的保留名：新建与改名都拒绝，大小写不敏感', () => withSetup(async ({ service }) => {
  assert.equal(await errorCode(() => service.createBot({ name: 'Owner' }, user)), 'CONFLICT')
  const bot = await service.createBot({ name: 'owner2' }, user)
  assert.equal(await errorCode(() => service.updateBot(bot.id, { name: 'owner' }, user)), 'CONFLICT')
}))
