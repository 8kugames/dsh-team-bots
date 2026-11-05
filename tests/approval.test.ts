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

class StubRuntime { declare ctx: unknown;
  constructor(ctx = null) {
    this.ctx = ctx
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

// 宿主 cordis 瀑布流语义复刻（cordis/lib/index.js 的 EventsService.on / dispatch / waterfall）：
// 监听器按注册先后排队（prepend 插到队首）；waterfall 逐个 shift 监听器，
// 先到的监听器不调用 next() 就截断后续链路（含最内层兜底）。
// scope 过滤：宿主 dsh-scope 的 carrier filter 对「未打 scope 标」的 ctx 一律放行，插件 ctx 即属此列。
class FakeCordisCtx { declare hooks: Map<unknown, Array<{ listener: (...args: unknown[]) => unknown }>>;
  constructor() {
    this.hooks = new Map()
  }
  on(name, listener, options: { prepend?: boolean } = {}) {
    const list = this.hooks.get(name) ?? []
    this.hooks.set(name, list)
    const record = { listener }
    if (options.prepend === true) list.unshift(record)
    else list.push(record)
    return () => {
      const index = list.indexOf(record)
      if (index >= 0) list.splice(index, 1)
    }
  }
  effect() { return () => {} }
  waterfall(carrier, name, req, inner) {
    const cbs = (this.hooks.get(name) ?? []).map(record => record.listener)
    const next = () => {
      const cb = cbs.shift() ?? inner
      return cb.call(carrier, req, () => next())
    }
    return next()
  }
}

const now = () => new Date().toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function setup({ ctx = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-approval-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime(ctx))
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

function bindSession(store, { sessionId, botId, projectId, kind = 'project', taskId = null }) {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId, botId, projectId, kind, taskId, now(),
  )
}

function makeReq({ sessionId, toolName = 'bash', reason = 'run elevated command', zh = null, signal }: { sessionId?: string; toolName?: string; reason?: string; zh?: string | null; signal?: AbortSignal } = {}) {
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
    await service.upsertSecret({ scope: 'team', name: 'DEPLOY_TOKEN', purpose: 'test', value: 'sk-live-abc123' } as any)
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
  // 断言前要 await state()（会让出事件循环）；setup 的 60ms 审批超时在并行跑满时会先触发，
  // 让 pending 变 timeout。这是计时口径问题，单独放宽本用例的等待窗口。
  service.config.approvalTimeoutMs = 5_000
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
    const context = runtime.promptFor({ run: { kind: 'task' }, bot: director, project, task: null } as any)
    assert.ok(!context.includes('【审批请求】'), '审批卡片不得进入 bot 提示词上下文')
    service.settleApproval(view.approvals[0].id, 'cancelled', null, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// DSHBOTS-61：审批认领必须抢在宿主原生审批面板之前。宿主 dsh-api-remotes（web bundle 比插件先加载）
// 注册的 approval/request 监听器拿到原生面板的答案后直接 resolve、不调 next()——按 cordis 的注册序
// 瀑布流语义，先到的监听器即截断后续链路，插件若排在其后就永远收不到请求（卡片不出现，全落原生界面）。
test('任务运行会话的审批被插件认领：插件先于原生面板应答，卡片进群聊', async () => {
  const ctx = new FakeCordisCtx()
  const native = []
  ctx.on('approval/request', request => {
    native.push(request)
    return Promise.resolve('allowed-once')
  })
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Approval Task')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const taskId = 'task-approval-run'
    store.run(
      `INSERT INTO tasks(id, project_id, number, title, description, status, priority, creator_type, creator_id, review_target, position, write_scopes, version, created_at, updated_at)
       VALUES (?, ?, 1, '提权执行', '', 'todo', 'medium', 'user', ?, 'user', 0, '[]', 1, ?, ?)`,
      taskId, project.id, director.id, now(), now(),
    )
    bindSession(store, { sessionId: 'sess-task-run', botId: director.id, projectId: project.id, kind: 'task', taskId })
    const { req } = makeReq({ sessionId: 'sess-task-run', zh: '需要执行一次提权 bash 命令' })
    const outcome = ctx.waterfall({ agent: req.agent }, 'approval/request', req, () => Promise.resolve('unavailable'))
    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.ok(row, '任务运行会话的审批应被插件认领')
    assert.equal(row.session_id, 'sess-task-run')
    assert.equal(row.tool_name, 'bash')
    assert.equal(native.length, 0, '插件认领后原生审批面板不应再参与')
    assert.equal(messageOf(store, row.id).kind, 'approval')
    const view = await service.decideApproval(row.id, 'allow')
    assert.equal(view.status, 'allowed')
    assert.equal(await outcome, 'allowed-once')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('未绑定会话仍透传：原生面板照常接管，不落审批', async () => {
  const ctx = new FakeCordisCtx()
  const native = []
  ctx.on('approval/request', request => {
    native.push(request)
    return Promise.resolve('allowed-once')
  })
  const { root, store, service } = await setup({ ctx })
  try {
    const { req } = makeReq({ sessionId: 'sess-not-bound' })
    const outcome = await ctx.waterfall({ agent: req.agent }, 'approval/request', req, () => Promise.resolve('unavailable'))
    assert.equal(native.length, 1, '未绑定会话应透传给宿主原生界面')
    assert.equal(outcome, 'allowed-once')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM approvals').n, 0)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'approval'").n, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
