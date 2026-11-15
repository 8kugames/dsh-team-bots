// DSHBOTS-218：工作台单聊（kind='solo'、project_id 为空）承接 ask_user 提问卡与 approval 审批卡。
// 覆盖：单聊认领落卡片锚点（solo_messages）、不转发微信、不进群消息、state 视图合并单聊条目、
// 用户作答/决策闭环、非单聊绑定仍透传、群聊口径不回归、旧库 NOT NULL project_id 迁移重建。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { columnNotNull } from '../src/db-migrations.js'

class StubRuntime { declare ctx: any;
  constructor(ctx = null) { this.ctx = ctx }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

const now = () => new Date().toISOString()

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-solo-cards-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  // 压短等待窗口：失败路径遗留的定时器不至于吊住测试进程。
  service.config.questionTimeoutMs = 60
  service.config.approvalTimeoutMs = 60
  return { root, store, service, config }
}

function bindSession(store, { sessionId, botId, projectId, kind = 'project', taskId = null }) {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId, botId, projectId, kind, taskId, now(),
  )
}

function makeQuestionReq(sessionId) {
  const controller = new AbortController()
  return {
    req: {
      agent: { session: { id: sessionId } },
      questions: [{ id: 'q1', question: '选哪个分支？', options: [{ label: 'main' }, { label: 'dev' }] }],
      signal: controller.signal,
    },
    controller,
  }
}

function makeApprovalReq(sessionId) {
  const controller = new AbortController()
  return {
    req: { agent: { session: { id: sessionId } }, toolName: 'bash', reason: 'run elevated command', signal: controller.signal },
    controller,
  }
}

test('单聊提问卡：落项目外提问 + solo_messages 卡片锚点，不转发微信、不进群消息', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-solo-q', botId: director.id, projectId: null, kind: 'solo' })
    let forwarded = 0
    service.wechatQuestion = () => { forwarded += 1; return true }
    let nexted = false
    const { req } = makeQuestionReq('sess-solo-q')
    const pending = service.handleQuestionRequest(req, () => { nexted = true })
    pending.catch(() => {})
    assert.equal(nexted, false)

    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    assert.ok(row, '单聊会话的提问应被插件认领')
    assert.equal(row.project_id, null, '单聊提问不归属任何项目')
    assert.equal(row.bot_id, director.id)

    const anchor = store.get('SELECT * FROM solo_messages WHERE question_id = ?', row.id)
    assert.ok(anchor, '单聊卡片锚点必须落 solo_messages')
    assert.equal(anchor.kind, 'question')
    assert.equal(anchor.bot_id, director.id)
    assert.equal(anchor.sender_type, 'system')
    assert.ok(anchor.body.includes('发起提问'))

    assert.equal(store.get('SELECT COUNT(*) AS n FROM messages WHERE question_id IS NOT NULL').n, 0, '单聊提问不进群消息')
    assert.equal(forwarded, 0, '单聊没有项目语境，不得转发微信')

    // state 视图：单聊条目既在 solo 子树，也并进 questions 供卡片渲染/点击查状态。
    const view = await service.state(null, director.id)
    assert.equal(view.solo.questions.length, 1)
    assert.equal(view.solo.questions[0].id, row.id)
    assert.equal(view.questions.length, 1)
    assert.equal(view.questions[0].id, row.id)
    assert.equal(view.questions[0].scope, 'solo')
    assert.equal(view.pendingQuestions.items[0].scope, 'solo')

    // 用户作答闭环：作答后视图仍带该条（终态回显），审计动作落库。
    const answered = await service.answerQuestion(row.id, { answers: [{ id: 'q1', selected: ['dev'] }] })
    assert.equal(answered.status, 'answered')
    const after = await service.state(null, director.id)
    assert.equal(after.questions[0].status, 'answered')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'question.answer'").n, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('单聊审批卡：落项目外审批 + solo_messages 卡片锚点，不转发微信、不进群消息', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-solo-a', botId: director.id, projectId: null, kind: 'solo' })
    let forwarded = 0
    service.wechatApproval = () => { forwarded += 1; return true }
    let nexted = false
    const { req } = makeApprovalReq('sess-solo-a')
    const pending = service.handleApprovalRequest(req, () => { nexted = true })
    pending.catch(() => {})
    assert.equal(nexted, false)

    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.ok(row, '单聊会话的审批应被插件认领')
    assert.equal(row.project_id, null)
    assert.equal(row.tool_name, 'bash')

    const anchor = store.get('SELECT * FROM solo_messages WHERE approval_id = ?', row.id)
    assert.ok(anchor, '单聊卡片锚点必须落 solo_messages')
    assert.equal(anchor.kind, 'approval')
    assert.ok(anchor.body.includes('bash'))
    assert.equal(store.get('SELECT COUNT(*) AS n FROM messages WHERE approval_id IS NOT NULL').n, 0)
    assert.equal(forwarded, 0)

    const view = await service.state(null, director.id)
    assert.equal(view.solo.approvals.length, 1)
    assert.equal(view.approvals.length, 1)
    assert.equal(view.approvals[0].scope, 'solo')

    const decided = await service.decideApproval(row.id, 'allow')
    assert.equal(decided.status, 'allowed')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'approval.allow'").n, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('非单聊绑定仍透传：未绑定、kind=project 无项目、kind=dm 都不认领', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-proj-null', botId: director.id, projectId: null, kind: 'project' })
    bindSession(store, { sessionId: 'sess-dm', botId: director.id, projectId: null, kind: 'dm' })
    for (const sessionId of ['sess-unknown', 'sess-proj-null', 'sess-dm']) {
      let nexted = false
      const q = makeQuestionReq(sessionId)
      const qResult = await service.handleQuestionRequest(q.req, () => { nexted = true; return 'unavailable' })
      assert.equal(nexted, true)
      assert.equal(qResult, 'unavailable')
      let aNexted = false
      const a = makeApprovalReq(sessionId)
      const aResult = await service.handleApprovalRequest(a.req, () => { aNexted = true; return 'unavailable' })
      assert.equal(aNexted, true)
      assert.equal(aResult, 'unavailable')
    }
    assert.equal(store.get('SELECT COUNT(*) AS n FROM questions').n, 0)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM approvals').n, 0)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM solo_messages WHERE kind <> 'text'").n, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('群聊卡片口径不回归：项目会话仍落群消息、仍转发微信', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Solo Cards Group', key: 'SOLCARDS', ownerBotId: director.id })
    bindSession(store, { sessionId: 'sess-group-q', botId: director.id, projectId: project.id })
    let forwarded = 0
    service.wechatQuestion = () => { forwarded += 1; return true }
    const { req } = makeQuestionReq('sess-group-q')
    service.handleQuestionRequest(req, () => {})
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    assert.equal(row.project_id, project.id)
    assert.ok(store.get('SELECT * FROM messages WHERE question_id = ?', row.id), '群聊提问必须落群消息')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM solo_messages WHERE question_id IS NOT NULL').n, 0)
    assert.equal(forwarded, 1, '群聊提问仍按 DSHBOTS-215 转发微信')
    service.settleQuestion(row.id, 'cancelled', null, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('旧库迁移：questions 的 NOT NULL project_id 重建为可空并保留既有行', async () => {
  const { root, store, service, config } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Legacy Rebuild', key: 'LEGACY1', ownerBotId: director.id })
    // 手工还原群聊专用时期的旧 DDL（project_id NOT NULL），并塞一条既有群聊提问。
    store.exec('PRAGMA foreign_keys = OFF')
    store.exec('DROP TABLE questions')
    store.exec(`CREATE TABLE questions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id TEXT,
      bot_id TEXT NOT NULL,
      session_id TEXT,
      questions TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`)
    store.run(
      `INSERT INTO questions(id, project_id, bot_id, questions, status, created_at, expires_at)
       VALUES ('q_legacy', ?, ?, '[]', 'pending', ?, ?)`,
      project.id, director.id, now(), now(),
    )
    assert.equal(columnNotNull(store.db, 'questions', 'project_id'), true)

    // 重新初始化触发 ensureQuestionSchema 的重建分支。
    const reborn = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
    reborn.attachRuntime(new StubRuntime())
    await reborn.initialize()
    assert.equal(columnNotNull(store.db, 'questions', 'project_id'), false)
    const kept = store.get('SELECT * FROM questions WHERE id = ?', 'q_legacy')
    assert.equal(kept.project_id, project.id, '重建不得丢既有行')
    assert.ok(store.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'questions_status_idx'"))
  } finally { await rm(root, { recursive: true, force: true }) }
})
