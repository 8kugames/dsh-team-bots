// DSHBOTS-32：宿主 approval/request 瀑布 → 群聊审批条目 → 按钮作答。
// 认领/透传、owner 鉴权、作答映射、超时/abort/重启清理、密钥掩码、上下文隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

const now = () => new Date().toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-approval-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  // 全局压短审批等待：失败路径遗留的定时器不至于吊住测试进程；需要具体时长的用例自行覆盖。
  service.config.approvalTimeoutMs = 60
  return { root, store, service, config }
}

// 造一个绑定到项目 bot 会话的审批请求；binding.projectId 为 null 表示单聊绑定。
function primeProject(store, service, name) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  return service.createProject({ name, key: name.replace(/[^A-Za-z]/g, '').slice(0, 8).toUpperCase(), ownerBotId: director.id })
}

function bindSession(store, { sessionId, botId, projectId }) {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, 'project', ?)`,
    sessionId, botId, projectId, now(),
  )
}

function makeReq({ sessionId, toolName = 'bash', reason = 'run elevated command', zh = null, signal } = {}) {
  const controller = signal === undefined ? new AbortController() : null
  return { req: { agent: { session: { id: sessionId } }, toolName, reason, displayReason: zh ? { zh } : undefined, signal: signal ?? controller?.signal }, controller }
}

const approvalsOf = (store, id) => store.get('SELECT * FROM approvals WHERE id = ?', id)
const messageOf = (store, approvalId) => store.get('SELECT * FROM messages WHERE approval_id = ?', approvalId)

test('命中 bot 会话：落 pending 审批与 kind=approval 消息，allow 返回 allowed-once 并写审计', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Approval Claim')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-claim', botId: director.id, projectId: project.id })
    let nexted = false
    const { req } = makeReq({ sessionId: 'sess-claim', zh: '需要执行一次提权 bash 命令' })
    const outcome = service.handleApprovalRequest(req, () => { nexted = true })
    assert.equal(nexted, false)
    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.ok(row && row.tool_name === 'bash' && row.display_reason === '需要执行一次提权 bash 命令')
    const msg = messageOf(store, row.id)
    assert.equal(msg.kind, 'approval')
    assert.ok(msg.body.includes('bash'))
    const view = await service.decideApproval(row.id, 'allow')
    assert.equal(view.status, 'allowed')
    assert.equal(await outcome, 'allowed-once')
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'approval.allow' AND target_id = ?", row.id))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('未绑定会话与单聊绑定都透传：next() 接管，不落审批', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Approval Pass')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-solo', botId: director.id, projectId: null })
    for (const sessionId of ['sess-unknown', 'sess-solo']) {
      let nexted = false
      const { req } = makeReq({ sessionId })
      const result = await service.handleApprovalRequest(req, () => { nexted = true; return 'unavailable' })
      assert.equal(nexted, true)
      assert.equal(result, 'unavailable')
    }
    assert.equal(store.get('SELECT COUNT(*) AS n FROM approvals').n, 0)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'approval'").n, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reject 返回 rejected，状态与审计齐备；重复应答 conflict', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Approval Reject')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-reject', botId: director.id, projectId: project.id })
    const { req } = makeReq({ sessionId: 'sess-reject' })
    const outcome = service.handleApprovalRequest(req, () => {})
    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    await service.decideApproval(row.id, 'reject')
    assert.equal(await outcome, 'rejected')
    assert.equal(approvalsOf(store, row.id).status, 'rejected')
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'approval.reject'"))
    await assert.rejects(() => service.decideApproval(row.id, 'allow'), /已处理/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('bot actor 不能自批：forbidden，条目保持 pending', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Approval Owner')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-owner', botId: director.id, projectId: project.id })
    const { req } = makeReq({ sessionId: 'sess-owner' })
    service.handleApprovalRequest(req, () => {})
    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    await assert.rejects(
      () => service.decideApproval(row.id, 'allow', { type: 'bot', id: director.id }),
      /仅项目负责人/,
    )
    assert.equal(approvalsOf(store, row.id).status, 'pending')
    // 清掉遗留 pending 定时器，别让 120s 计时吊住测试进程。
    service.settleApproval(row.id, 'cancelled', null, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('超时到点：向宿主回 rejected，条目置 timeout，迟到应答 conflict', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Approval Timeout')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-timeout', botId: director.id, projectId: project.id })
    service.config.approvalTimeoutMs = 30
    const { req } = makeReq({ sessionId: 'sess-timeout' })
    const outcome = service.handleApprovalRequest(req, () => {})
    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.equal(await outcome, 'rejected')
    assert.equal(approvalsOf(store, row.id).status, 'timeout')
    await assert.rejects(() => service.decideApproval(row.id, 'allow'), /已处理/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('abort：条目置 cancelled 不向宿主重复应答，迟到应答丢弃', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Approval Abort')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-abort', botId: director.id, projectId: project.id })
    const { req, controller } = makeReq({ sessionId: 'sess-abort' })
    let settled = false
    const outcome = service.handleApprovalRequest(req, () => {})
    outcome.then(() => { settled = true })
    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    controller.abort()
    await sleep(20)
    assert.equal(approvalsOf(store, row.id).status, 'cancelled')
    assert.equal(settled, false)
    await assert.rejects(() => service.decideApproval(row.id, 'allow'), /已处理/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('进程重启：残留 pending 一律置 timeout（宿主侧请求已消失）', async () => {
  const { root, store, service, config } = await setup()
  try {
    const project = await primeProject(store, service, 'Approval Restart')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    store.run(
      `INSERT INTO approvals(id, project_id, bot_id, tool_name, status, created_at, expires_at)
       VALUES ('apr_stale', ?, ?, 'bash', 'pending', ?, ?)`,
      project.id, director.id, now(), now(),
    )
    const reborn = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
    reborn.attachRuntime(new StubRuntime())
    await reborn.initialize()
    assert.equal(approvalsOf(store, 'apr_stale').status, 'timeout')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reason 与 displayReason 落库前过密钥掩码', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Approval Mask')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.upsertSecret({ scope: 'team', name: 'DEPLOY_TOKEN', purpose: 'test', value: 'sk-live-abc123' })
    bindSession(store, { sessionId: 'sess-mask', botId: director.id, projectId: project.id })
    const { req } = makeReq({ sessionId: 'sess-mask', reason: 'echo sk-live-abc123', zh: '读取 sk-live-abc123' })
    service.handleApprovalRequest(req, () => {})
    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.ok(!row.reason.includes('sk-live-abc123'))
    assert.ok(!row.display_reason.includes('sk-live-abc123'))
    assert.ok(row.reason.includes('DEPLOY_TOKEN'))
    const msg = messageOf(store, row.id)
    assert.ok(!msg.body.includes('sk-live-abc123'))
    service.settleApproval(row.id, 'cancelled', null, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('state 视图带 approvals，审批消息不进 bot 上下文', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Approval View')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-view', botId: director.id, projectId: project.id })
    const { req } = makeReq({ sessionId: 'sess-view' })
    service.handleApprovalRequest(req, () => {})
    const view = await service.state(project.id)
    assert.ok(Array.isArray(view.approvals) && view.approvals.length === 1)
    assert.equal(view.approvals[0].status, 'pending')
    assert.equal(view.messages.filter(m => m.kind === 'approval').length, 1)
    // 上下文隔离：bot 提示词只取 kind='text' 的消息，审批卡片绝不进上下文（防 bot 自批）。
    const runtime = new DshRuntime({ ctx: { on() {} }, config: service.config, store, logger: { info() {}, warn() {}, error() {} } })
    const context = runtime.promptFor({ run: { kind: 'task' }, bot: director, project, task: null })
    assert.ok(!context.includes('【审批请求】'), '审批卡片不得进入 bot 提示词上下文')
    service.settleApproval(view.approvals[0].id, 'cancelled', null, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
