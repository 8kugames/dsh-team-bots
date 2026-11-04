import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { handleAction } from '../src/api.js'
import { uiStylesSource } from './ui-styles-source.js'

class StubRuntime {
  constructor() {
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }
  setCompletionHandler() {}
  async catalog() { return this.models }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-unread-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

// 在项目创建时间之后落消息，保证越过「无水位时以项目创建时间为基线」的判定。
function insertMessage(store, { projectId, groupChatId, senderType, senderId, offsetMs, body = 'hi' }) {
  const project = store.get('SELECT created_at FROM projects WHERE id = ?', projectId)
  const base = Date.parse(project.created_at)
  const createdAt = new Date(base + offsetMs).toISOString()
  const id = `msg_${senderType}_${offsetMs}`
  store.run(
    `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?)`,
    id, projectId, groupChatId, senderType, senderId, body, createdAt,
  )
  return createdAt
}

test('未读计数：只算水位之后的 bot 消息，已读后清零', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Demo', key: 'DEMO', ownerBotId: director.id })
    const group = service.groupOf(project.id)

    insertMessage(store, { projectId: project.id, groupChatId: group.id, senderType: 'bot', senderId: director.id, offsetMs: 1000 })
    insertMessage(store, { projectId: project.id, groupChatId: group.id, senderType: 'bot', senderId: director.id, offsetMs: 2000 })
    insertMessage(store, { projectId: project.id, groupChatId: group.id, senderType: 'user', senderId: 'user_local', offsetMs: 3000 })

    let counts = service.unreadChatCounts()
    assert.equal(counts.get(project.id), 2, '用户自己发的消息不算未读')

    const stateView = await service.state(project.id)
    assert.equal(stateView.projects.find(item => item.id === project.id).unreadCount, 2, 'state 下发未读数')

    const first = store.get(
      "SELECT created_at FROM messages WHERE project_id = ? AND sender_type = 'bot' ORDER BY created_at LIMIT 1",
      project.id,
    ).created_at
    const marked = await handleAction(service, 'mark_chat_read', { projectId: project.id, readAt: first }, { type: 'user', id: 'user_local' })
    assert.equal(marked.ok, true, '已读上报成功')

    counts = service.unreadChatCounts()
    assert.equal(counts.get(project.id), 1, '已读水位之后仍算未读')

    const after = await service.state(project.id)
    assert.equal(after.projects.find(item => item.id === project.id).unreadCount, 1, 'state 未读数随之更新')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('已读水位不得越过服务端最新消息（否则会吞掉新消息）', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Demo2', key: 'DEMO2', ownerBotId: director.id })
    const group = service.groupOf(project.id)
    insertMessage(store, { projectId: project.id, groupChatId: group.id, senderType: 'bot', senderId: director.id, offsetMs: 1000 })

    const future = new Date(Date.now() + 3600_000).toISOString()
    const marked = await handleAction(service, 'mark_chat_read', { projectId: project.id, readAt: future }, { type: 'user', id: 'user_local' })
    const newest = store.get(
      "SELECT MAX(created_at) AS ts FROM messages WHERE project_id = ? AND sender_type = 'bot'",
      project.id,
    ).ts
    assert.equal(marked.readAt, newest, '水位被夹到服务端最新消息，不吞未读')
    assert.equal(service.unreadChatCounts().get(project.id) ?? 0, 0, '已读之后无未读')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('侧栏徽标：未读与待审红点互斥，计数封顶 99+', async () => {
  const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
  const css = await uiStylesSource()
  assert.match(source, /const unread = Number\(item\.unreadCount \?\? 0\)/, '侧栏读未读数')
  assert.match(source, /unread === 1[\s\S]*?<span class="red-dot" title="\$\{t\('tree\.unreadOne'\)\}">/, '1 条用红点')
  assert.match(source, /unread > 99 \? '99\+' : unread/, '计数封顶 99+')
  assert.match(source, /unread > 0[\s\S]*?item\.reviewTasks[\s\S]*?tree\.reviewPending/, '未读与待审红点互斥，未读优先')
  assert.match(css, /\.unread-badge \{[^}]*background: var\(--danger\)/, '徽标填充用危险色')
  assert.match(css, /\.unread-badge \{[^}]*color: var\(--surface\)/, '徽标文字用面板色，保证对比度')
  assert.match(css, /\.unread-badge \{[^}]*min-width: 16px[^}]*height: 16px/, '胶囊尺寸 16px')
  assert.match(css, /\.tree-item\.has-unread \{[^}]*font-weight: 400/, '未读时项目名不加粗')
})
