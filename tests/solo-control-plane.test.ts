// DSHBOTS-294 守门②：isSolo 按「无 project 上下文的控制面会话」判定（kind='bot' 且无
// project、该 bot 无活跃项目关系）——项目外 solo bot 的提问/审批由工作台单聊卡片承接
// （D-218 语义不回退）；有项目语境（含绑定无 project 但仍有活跃项目关系的成员/总监）
// 照旧走项目流或透传，owner 闸门不回退。历史 kind='solo' alias 行保持命中。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

class StubRuntime { declare ctx: any
  constructor(ctx = null) { this.ctx = ctx }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

const now = () => new Date().toISOString()

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-isolo-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime(null))
  await service.initialize()
  service.started = true
  service.config.questionTimeoutMs = 60
  return { root, store, service }
}

const teardown = async (service, store, root) => {
  try { service.stop?.() } catch {}
  try { store.close?.() } catch {}
  await rm(root, { recursive: true, force: true })
}

const mkBot = (store, name) => {
  store.run(
    `INSERT INTO bots(id, name, role, instructions, color, file_policy, status, current_revision, created_at, updated_at)
     VALUES (?, ?, '', '', 'blue', 'workspace-write', 'active', 0, ?, ?)`,
    `bot-${name}`, name, now(), now(),
  )
  return store.get('SELECT * FROM bots WHERE name = ?', name)
}

const bindSession = (store, { sessionId, botId, projectId = null, kind = 'bot' }) => store.run(
  `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)`,
  sessionId, botId, projectId, kind, now(),
)

const mkProject = (store, { key, ownerBotId, status = 'active' }) => {
  store.run(
    `INSERT INTO projects(id, key, name, slug, description, owner_bot_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
    `prj-${key}`, key.toUpperCase(), key, key, ownerBotId, status, now(), now(),
  )
  return store.get('SELECT * FROM projects WHERE key = ?', key.toUpperCase())
}

const questionReq = sessionId => ({
  agent: { session: { id: sessionId } },
  questions: [{ id: 'q1', question: '选哪条路径？', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
  signal: new AbortController().signal,
})

const approvalReq = sessionId => ({
  agent: { session: { id: sessionId } },
  toolName: 'bash',
  reason: 'run elevated command',
  displayReason: { zh: '需要执行一次提权 bash 命令' },
  signal: new AbortController().signal,
})

// 未 await 的认领 Promise 超时后会 reject；不接住就变成 unhandled rejection。
const caught = pending => { if (pending?.catch) pending.catch(() => {}); return pending }

test('项目外 solo bot（kind=bot 控制面绑定、无项目关系）提问由单聊卡片承接，不透传', async () => {
  const { root, store, service } = await setup()
  try {
    const loner = mkBot(store, 'loner')
    bindSession(store, { sessionId: 'ctrl-loner', botId: loner.id })
    let nexted = false
    const outcome = caught(service.handleQuestionRequest(questionReq('ctrl-loner'), () => { nexted = true }))
    assert.equal(nexted, false, '无项目语境的控制面会话不得透传原生界面')
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    assert.ok(row, '提问必须被认领落库')
    assert.equal(row.project_id, null)
    const anchor = store.get('SELECT * FROM solo_messages WHERE question_id = ?', row.id)
    assert.ok(anchor && anchor.kind === 'question', '单聊卡片锚点必须落 solo_messages')
    const view = await service.answerQuestion(row.id, { answers: [{ id: 'q1', selected: ['a'] }] })
    assert.equal(view.status, 'answered')
    await outcome
  } finally { await teardown(service, store, root) }
})

test('同款 isSolo 审批：项目外 solo bot 提权由单聊卡片承接', async () => {
  const { root, store, service } = await setup()
  try {
    const loner = mkBot(store, 'loner2')
    bindSession(store, { sessionId: 'ctrl-loner2', botId: loner.id })
    let nexted = false
    const outcome = caught(service.handleApprovalRequest(approvalReq('ctrl-loner2'), () => { nexted = true }))
    assert.equal(nexted, false)
    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.ok(row && row.project_id === null, '审批必须被认领且无项目归属')
    const anchor = store.get('SELECT * FROM solo_messages WHERE approval_id = ?', row.id)
    assert.ok(anchor && anchor.kind === 'approval', '审批卡片锚点必须落 solo_messages')
    const view = await service.decideApproval(row.id, 'allow')
    assert.equal(view.status, 'allowed')
    assert.equal(await outcome, 'allowed-once')
  } finally { await teardown(service, store, root) }
})

test('仍处活跃项目的成员 bot（绑定无 project）提问走透传，不冒充单聊', async () => {
  const { root, store, service } = await setup()
  try {
    const owner = mkBot(store, 'chief')
    const member = mkBot(store, 'mate')
    const project = mkProject(store, { key: 'alpha', ownerBotId: owner.id })
    store.run('INSERT INTO project_members(project_id, member_type, member_id, member_role, joined_at) VALUES (?, ?, ?, ?, ?)', project.id, 'bot', member.id, 'member', now())
    bindSession(store, { sessionId: 'ctrl-mate', botId: member.id })
    let nexted = false
    const outcome = service.handleQuestionRequest(questionReq('ctrl-mate'), () => { nexted = true; return { answers: [] } })
    assert.equal(nexted, true, '有活跃项目语境的成员 bot 控制面绑定不得按单聊承接')
    assert.deepEqual(await outcome, { answers: [] })
    assert.equal(store.get('SELECT COUNT(*) AS n FROM questions').n, 0)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM solo_messages').n, 0)
  } finally { await teardown(service, store, root) }
})

test('项目归档后成员关系不再构成项目语境，提问回退单聊承接（活跃限定）', async () => {
  const { root, store, service } = await setup()
  try {
    const owner = mkBot(store, 'chief2')
    const member = mkBot(store, 'mate2')
    const project = mkProject(store, { key: 'beta', ownerBotId: owner.id, status: 'archived' })
    store.run('INSERT INTO project_members(project_id, member_type, member_id, member_role, joined_at) VALUES (?, ?, ?, ?, ?)', project.id, 'bot', member.id, 'member', now())
    bindSession(store, { sessionId: 'ctrl-mate2', botId: member.id })
    let nexted = false
    const outcome = caught(service.handleQuestionRequest(questionReq('ctrl-mate2'), () => { nexted = true }))
    assert.equal(nexted, false, '归档项目成员关系不算活跃语境，应按单聊承接')
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    assert.ok(row)
    assert.ok(store.get("SELECT * FROM solo_messages WHERE kind = 'question'"))
    await service.answerQuestion(row.id, { answers: [{ id: 'q1', selected: ['a'] }] })
    await outcome
  } finally { await teardown(service, store, root) }
})

test('历史 kind=solo alias 行保持承接（迁移回归）', async () => {
  const { root, store, service } = await setup()
  try {
    const veteran = mkBot(store, 'veteran')
    bindSession(store, { sessionId: 'sess-solo-legacy', botId: veteran.id, kind: 'solo' })
    let nexted = false
    const outcome = caught(service.handleQuestionRequest(questionReq('sess-solo-legacy'), () => { nexted = true }))
    assert.equal(nexted, false)
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    assert.ok(row)
    await service.answerQuestion(row.id, { answers: [{ id: 'q1', selected: ['a'] }] })
    await outcome
  } finally { await teardown(service, store, root) }
})
