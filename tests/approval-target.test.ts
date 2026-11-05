// DSHBOTS-128：审批卡显示操作目标——bash 命令首行 / 文件路径落 tool_target 列，UI chip 直读落库值。
// 后端用例真实建库 + FakeCordisCtx 复刻 tools/pre-execute 瀑布（宿主 approval/request 不带工具参数，
// 目标取数只能挂在 pre-execute）；前端用例读源断言 + 标记块执行（先例：tests/approval-ux.test.js）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { ensureApprovalSchema, toolTargetOf } from '../src/services/approvals.js'
import { readUiSource } from './helpers/ui-sources.js'
import './helpers/eval-shim.js'

const here = dirname(fileURLToPath(import.meta.url))

// ===== 后端：真实建库 + cordis 瀑布桩 =====

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

// 与 tests/approval.test.js 同款：按注册序瀑布流，prepend 插队首，未调 next() 截断链路。
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

async function setup({ ctx = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-approval-target-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime(ctx))
  await service.initialize()
  service.started = true
  service.config.approvalTimeoutMs = 60
  return { root, store, service, config }
}

function primeProject(store, service, name) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  return service.createProject({ name, key: name.replace(/[^A-Za-z]/g, '').slice(0, 8).toUpperCase(), ownerBotId: director.id })
}

function bindSession(store, { sessionId, botId, projectId }) {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, 'project', NULL, ?)`,
    sessionId, botId, projectId, now(),
  )
}

function makeReq({ sessionId, toolName = 'bash', callId = null, zh = null }) {
  return { agent: { session: { id: sessionId } }, toolName, callId, reason: 'run elevated command', displayReason: zh ? { zh } : undefined }
}

// ===== 前端：标记块执行 =====

const ui = (() => {
  const uiSource = readUiSource()
  const extract = marker => {
    const match = uiSource.match(new RegExp(`// ===== ${marker}:start[\\s\\S]*?// ===== ${marker}:end =====`))
    assert.ok(match, `${marker} 标记块必须存在`)
    return match[0]
  }
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const attr = value => esc(value).replace(/"/g, '&quot;')
  // approval-v2 块依赖 approval-ux 块的 approvalUrgent/approvalExpiresMs 与块外 icon/esc/attr/formatTime。
  return new Function('icon', 'esc', 'attr', 'formatTime', `${extract('approval-ux')}\n${extract('approval-v2')}
    return { approvalCardMarkup, approvalTargetChip, approvalPath }`)(
    () => '<svg></svg>', esc, attr, () => '12:00',
  )
})()

// ===== 用例 =====

test('toolTargetOf 纯函数：command 取首行截 120，file_path 原样，其余形状为 null', () => {
  assert.equal(toolTargetOf({ command: 'git push origin dev\necho done' }), 'git push origin dev')
  assert.equal(toolTargetOf({ command: `echo ${'a'.repeat(200)}` }), `echo ${'a'.repeat(115)}`.slice(0, 120))
  assert.equal(toolTargetOf({ command: '   \n  ls' }), 'ls')
  assert.equal(toolTargetOf({ command: '   ' }), null)
  assert.equal(toolTargetOf({ file_path: ' /a/b/c.js ' }), '/a/b/c.js')
  assert.equal(toolTargetOf({ file_path: '' }), null)
  assert.equal(toolTargetOf({ query: 'search terms' }), null)
  assert.equal(toolTargetOf(null), null)
  assert.equal(toolTargetOf('bash'), null)
})

test('bash 提权：pre-execute 记 command 首行 → 审批落库 tool_target → 卡片渲染 chip（title=原文）', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Target Bash')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-target-bash', botId: director.id, projectId: project.id })
    // 宿主时序：先 tools/pre-execute 透传监听（不截断链路），gate 返回 ask 后才发起 approval/request。
    const passed = await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-bash-1', arguments: { command: 'git push origin dev\necho done' } }, () => Promise.resolve('inner-result'))
    assert.equal(passed, 'inner-result', 'pre-execute 监听必须透传不截断工具链路')
    const outcome = service.handleApprovalRequest(makeReq({ sessionId: 'sess-target-bash', callId: 'call-bash-1', zh: '需要推送开发分支' }), () => {})

    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.ok(row, '审批应被认领')
    assert.equal(row.tool_target, 'git push origin dev')
    assert.equal(row.call_id, 'call-bash-1')
    assert.equal((service as any).approvalTargets.size, 0, '目标取出后一次性消费，不留残页')

    const view = service.approvalsForProject(project.id)[0]
    assert.equal(view.tool_target, 'git push origin dev')
    assert.equal(view.tool_target_display, 'git push origin dev', '命令不是工作区路径，展示形原样')

    const markup = ui.approvalCardMarkup(view)
    assert.ok(markup.includes('title="git push origin dev"'), 'chip title 用原始目标')
    assert.ok(markup.includes('>git push origin dev</span>'), 'chip 文本展示目标')
    assert.ok(markup.includes('>需要推送开发分支</div>'), '摘要不受影响')

    service.settleApproval(row.id, 'cancelled', 'rejected', null)
    await outcome
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('edit/write 提权：file_path 绝对路径落库，展示形收成工作区相对路径，title 留全路径', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service, config } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Target Edit')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-target-edit', botId: director.id, projectId: project.id })
    const filePath = join(config.workspace, 'src/services/approvals.js')
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'edit', callId: 'call-edit-1', arguments: { file_path: filePath } }, () => Promise.resolve('ok'))
    const outcome = service.handleApprovalRequest(makeReq({ sessionId: 'sess-target-edit', toolName: 'edit', callId: 'call-edit-1', zh: '需要修改审批服务' }), () => {})

    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.equal(row.tool_target, filePath, '库内存原始绝对路径')
    const view = service.approvalsForProject(project.id)[0]
    assert.equal(view.tool_target_display, 'src/services/approvals.js', '展示形收成工作区相对路径')

    const markup = ui.approvalCardMarkup(view)
    assert.ok(markup.includes(`title="${filePath}"`), 'chip title 悬停可见完整绝对路径')
    assert.ok(markup.includes('>src/services/approvals.js</span>'), 'chip 文本用相对路径省宽')

    service.settleApproval(row.id, 'cancelled', 'rejected', null)
    await outcome
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('无 callId / 未命中缓存：tool_target 落 NULL，UI 回退 approvalPath 从摘要猜路径的旧口径', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Target Fallback')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-target-none', botId: director.id, projectId: project.id })
    const outcome = service.handleApprovalRequest(makeReq({ sessionId: 'sess-target-none', zh: '需要改动 /tmp/x/src/app.js 后继续' }), () => {})

    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.equal(row.tool_target, null)
    const view = service.approvalsForProject(project.id)[0]
    assert.equal(view.tool_target_display, null)

    const markup = ui.approvalCardMarkup(view)
    assert.ok(markup.includes('title="/tmp/x/src/app.js"'), '回退口径：从摘要正则取路径做 title')
    assert.ok(markup.includes('>/tmp/x/src/app.js</span>'), '回退口径：chip 文本同值')

    service.settleApproval(row.id, 'cancelled', 'rejected', null)
    await outcome
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('同一 callId 第二次审批不再带目标（一次性消费）', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Target Once')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-target-once', botId: director.id, projectId: project.id })
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-once', arguments: { command: 'echo first' } }, () => Promise.resolve('ok'))
    const first = service.handleApprovalRequest(makeReq({ sessionId: 'sess-target-once', callId: 'call-once' }), () => {})
    service.settleApproval(store.get("SELECT id FROM approvals WHERE status = 'pending'").id, 'cancelled', 'rejected', null)
    await first

    const second = service.handleApprovalRequest(makeReq({ sessionId: 'sess-target-once', callId: 'call-once' }), () => {})
    const rows = store.all('SELECT * FROM approvals ORDER BY created_at')
    assert.equal(rows[0].tool_target, 'echo first')
    assert.equal(rows[1].tool_target, null, '目标已被第一次审批消费')
    service.settleApproval(rows[1].id, 'cancelled', 'rejected', null)
    await second
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('目标缓存有界：超 200 条 FIFO 驱逐最旧', async () => {
  const ctx = new FakeCordisCtx()
  const { root, service } = await setup({ ctx })
  try {
    for (let i = 0; i < 230; i += 1) {
      await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: `call-bulk-${i}`, arguments: { command: `echo ${i}` } }, () => Promise.resolve('ok'))
    }
    assert.equal((service as any).approvalTargets.size, 200)
    assert.equal((service as any).approvalTargets.has('call-bulk-0'), false, '最旧条目被驱逐')
    assert.equal((service as any).approvalTargets.has('call-bulk-229'), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('旧库迁移：approvals 表无 tool_target 列时 ALTER 补列并登记迁移名，可重复执行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-approval-migrate-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  try {
    const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents') })
    const store = openDatabase(config.dbPath)
    // 旧版建表 DDL（无 tool_target 列），模拟 DSHBOTS-128 之前的存量库。
    store.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id TEXT,
        bot_id TEXT NOT NULL,
        session_id TEXT,
        tool_name TEXT NOT NULL,
        call_id TEXT,
        reason TEXT,
        display_reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`)
    ensureApprovalSchema(store)
    ensureApprovalSchema(store) // 幂等
    const columns = store.all('PRAGMA table_info(approvals)').map(column => column.name)
    assert.ok(columns.includes('tool_target'), 'ALTER 必须补出 tool_target 列')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = 'approvals_tool_target'").n, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ===== 前端：读源断言 =====

test('approvalCardMarkup 有落库目标时不走正则猜测：chip 取 tool_target / tool_target_display', () => {
  const fallbackSpy = []
  const origPath = ui.approvalPath
  const target = { tool_target: 'git push origin dev', tool_target_display: 'git push origin dev', display_reason: '需要改动 /tmp/guess/path.js 后继续' }
  assert.equal(ui.approvalTargetChip(target, target.display_reason).text, 'git push origin dev')
  assert.deepEqual(ui.approvalTargetChip({ tool_target: null, display_reason: 'see /tmp/a/b.js' }, 'see /tmp/a/b.js'), { text: '/tmp/a/b.js', title: '/tmp/a/b.js' })
  assert.equal(ui.approvalTargetChip({ tool_target: '  ', display_reason: 'no path here' }, 'no path here'), null)
  assert.equal(fallbackSpy.length, 0)
  assert.equal(typeof origPath, 'function')
})

test('读源断言：迁移在 approvals.js 本文件（不动 db.js），INSERT 带 tool_target 列', async () => {
  const { readFile } = await import('node:fs/promises')
  const approvalsSource = await readFile(join(here, '..', 'src', 'services', 'approvals.js'), 'utf8')
  const dbSource = await readFile(join(here, '..', 'src', 'db.js'), 'utf8')
  assert.match(approvalsSource, /ALTER TABLE approvals ADD COLUMN tool_target TEXT/)
  assert.match(approvalsSource, /tool_target, status, created_at, expires_at/)
  assert.doesNotMatch(dbSource, /tool_target/, '迁移不得扩散到 db.js')
})
