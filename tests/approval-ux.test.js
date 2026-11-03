// DSHBOTS-102：审批交互优化——跨项目待审可见 + 决策即时回显 + 超时倒计时。
// 后端用例真实建库验证「只计 pending、跨项目聚合、state 顶层与项目解耦」；
// 前端用例沿用读源断言先例（tests/helpers/ui-sources.js）+ 标记块执行（tests/desktop-notify.test.js）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { readUiSource } from './helpers/ui-sources.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const readSource = (...segments) => readFileSync(join(root, ...segments), 'utf8')

const uiSource = readUiSource()
const approvalsSource = readSource('src', 'services', 'approvals.js')
const systemSource = readSource('src', 'services', 'system.js')
const apiSource = readSource('src', 'api.js')

// ===== 后端：真实建库 =====

class StubRuntime {
  constructor(ctx = null) {
    this.ctx = ctx
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

const now = () => new Date().toISOString()

async function setup() {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-approval-ux-'))
  const workspace = join(rootDir, 'workspace')
  const dataDir = join(rootDir, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  service.config.approvalTimeoutMs = 60
  return { root: rootDir, store, service }
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

function makeReq({ sessionId, toolName = 'bash', zh = null }) {
  return { agent: { session: { id: sessionId } }, toolName, reason: 'run elevated command', displayReason: zh ? { zh } : undefined }
}

test('approvalsPending：跨项目聚合、只计 pending，明细带项目名与剩余时间', async () => {
  const { root, store, service } = await setup()
  try {
    const projectA = await primeProject(store, service, 'Project Alpha')
    const projectB = await primeProject(store, service, 'Project Beta')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-ux-a', botId: director.id, projectId: projectA.id })
    bindSession(store, { sessionId: 'sess-ux-b', botId: director.id, projectId: projectB.id })
    const outcomeA = service.handleApprovalRequest(makeReq({ sessionId: 'sess-ux-a', zh: 'A 项目提权' }), () => {})
    const outcomeB = service.handleApprovalRequest(makeReq({ sessionId: 'sess-ux-b', toolName: 'write', zh: 'B 项目写入' }), () => {})

    let pending = service.approvalsPending()
    assert.equal(pending.count, 2, '两个项目的 pending 都要计入')
    assert.equal(pending.items.length, 2)
    assert.deepEqual(pending.items.map(item => item.projectName).sort(), ['Project Alpha', 'Project Beta'])
    assert.ok(pending.items.every(item => item.status === 'pending' && item.remainingMs > 0))
    assert.ok(pending.items.every(item => item.botName && item.tool_name))

    // 决策其中一条后，计数与明细同步收敛到仍 pending 的那条（已决不进徽标）。
    const target = pending.items.find(item => item.projectName === 'Project Alpha')
    await service.decideApproval(target.id, 'allow')
    pending = service.approvalsPending()
    assert.equal(pending.count, 1)
    assert.equal(pending.items.length, 1)
    assert.equal(pending.items[0].projectName, 'Project Beta')
    assert.equal(pending.items[0].status, 'pending')

    await outcomeA
    await outcomeB
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('state 顶层 pendingApprovals 与项目解耦：A 项目视图也能看到 B 项目待审', async () => {
  const { root, store, service } = await setup()
  try {
    const projectA = await primeProject(store, service, 'State Alpha')
    const projectB = await primeProject(store, service, 'State Beta')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-ux-sa', botId: director.id, projectId: projectA.id })
    bindSession(store, { sessionId: 'sess-ux-sb', botId: director.id, projectId: projectB.id })
    const outcomeB = service.handleApprovalRequest(makeReq({ sessionId: 'sess-ux-sb', zh: 'B 项目待审' }), () => {})

    // 站在 A 项目：项目内 approvals 仍只含 A（语义不变），但顶层待审聚合能看到 B。
    const viewA = await service.state(projectA.id)
    assert.equal(viewA.pendingApprovals.count, 1)
    assert.equal(viewA.pendingApprovals.items[0].projectName, 'State Beta')
    assert.equal(viewA.approvals.length, 0, '项目内 approvals 口径不变，不因全局聚合而放大')

    const viewB = await service.state(projectB.id)
    assert.equal(viewB.pendingApprovals.count, 1)
    assert.equal(viewB.approvals.length, 1)

    await outcomeB
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('api 层暴露 approvals_pending，供顶部入口跨项目拉取', () => {
  assert.match(apiSource, /'approvals_pending'/, 'ACTIONS 必须登记新 action')
  assert.match(apiSource, /case 'approvals_pending':\s*return service\.approvalsPending\(\)/)
})

// ===== 前端：读源断言 =====

const approvalUxBlock = (() => {
  const match = uiSource.match(/\/\/ ===== approval-ux:start[\s\S]*?\/\/ ===== approval-ux:end =====/)
  assert.ok(match, 'approval-ux 标记块必须存在')
  return match[0]
})()

const ux = new Function(`${approvalUxBlock}
return { APPROVAL_URGENT_MS, approvalBadgeText, formatApprovalRemaining, approvalUrgent, approvalRemainingFrom, approvalExpiresMs }`)()

test('全局待审计数只计 pending：后端 SQL 与前端徽标口径一致', () => {
  assert.match(approvalsSource, /approvalsPending\(limit = 50\)/)
  assert.match(approvalsSource, /WHERE a\.status = 'pending'/, '聚合明细只取 pending')
  assert.match(approvalsSource, /COUNT\(\*\) AS count FROM approvals WHERE status = 'pending'/, '计数也只取 pending')
  assert.match(systemSource, /pendingApprovals:\s*this\.approvalsPending\(\)/, 'state 顶层挂全局聚合')
  assert.match(uiSource, /const pendingApprovals = data\?\.pendingApprovals \?\? \{ count: 0, items: \[\] \}/)
  assert.match(uiSource, /approvalBadgeText\(count\)/, '徽标用 count 而非 items 长度')
})

test('顶部入口：0 待办不渲染，计数 99+ 封顶', () => {
  assert.match(uiSource, /function approvalBannerView\(pendingApprovals\)/)
  assert.match(uiSource, /if \(count <= 0\) return ''/, '0 待办时整条不渲染')
  assert.equal(ux.approvalBadgeText(0), '0')
  assert.equal(ux.approvalBadgeText(3), '3')
  assert.equal(ux.approvalBadgeText(99), '99')
  assert.equal(ux.approvalBadgeText(100), '99+')
  assert.equal(ux.approvalBadgeText(1234), '99+')
})

test('决策后立即渲染：不等待轮询，失败回滚并提示', () => {
  const start = uiSource.indexOf("case 'approval-decide': {")
  assert.ok(start >= 0, 'approval-decide case 必须存在')
  let depth = 0
  let end = -1
  for (let i = start; i < uiSource.length; i += 1) {
    if (uiSource[i] === '{') depth += 1
    else if (uiSource[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  assert.ok(end > start, 'case 块必须闭合')
  const block = uiSource.slice(start, end)
  // 立即回显：render() 必须在 await api(...) 之前，且不再依赖 loadState 的下一轮轮询。
  const renderAt = block.indexOf('render()')
  const apiAt = block.indexOf('await api(')
  assert.ok(renderAt >= 0, '决策后必须立即 render()')
  assert.ok(apiAt > renderAt, '先本地回显，再发请求')
  assert.doesNotMatch(block, /loadState/, '不得依赖 loadState 的 2.8s 轮询才回显')
  assert.match(block, /state\.data\?\.approvals/, '乐观更新项目内审批状态')
  assert.match(block, /state\.data\?\.pendingApprovals/, '乐观更新顶部徽标')
  assert.match(block, /toast\(/, '请求失败必须有明确错误提示')
  assert.match(block, /rollback/, '失败必须回滚到决策前状态')
})

test('重复点击幂等：决策中禁用按钮 + 请求前拦截', () => {
  assert.match(uiSource, /state\.approvalDeciding\.has\(approvalId\)/, '请求前拦截正在决策的审批')
  assert.match(uiSource, /state\.approvalDeciding\.add\(approvalId\)/)
  assert.match(uiSource, /state\.approvalDeciding\.delete\(approvalId\)/)
  assert.match(uiSource, /deciding \? ' disabled' : ''/, '决策中按钮置 disabled')
})

test('超时可见：秒级倒计时文案与临期阈值', () => {
  assert.equal(ux.formatApprovalRemaining(84_000), '1 分 24 秒后自动拒绝')
  assert.equal(ux.formatApprovalRemaining(60_000), '1 分后自动拒绝')
  assert.equal(ux.formatApprovalRemaining(42_000), '42 秒后自动拒绝')
  assert.equal(ux.formatApprovalRemaining(1_000), '1 秒后自动拒绝')
  assert.equal(ux.formatApprovalRemaining(0), '0 秒后自动拒绝')
  assert.equal(ux.formatApprovalRemaining(-5), '0 秒后自动拒绝')
  assert.equal(ux.APPROVAL_URGENT_MS, 15_000)
  assert.equal(ux.approvalUrgent(15_000), true)
  assert.equal(ux.approvalUrgent(15_001), false)
  assert.equal(ux.approvalUrgent(0), true)
  // 卡片挂 data-expires，1s 定时器只改文本不整卡重绘。
  assert.match(uiSource, /class="approval-clock\$\{approvalUrgent\(approval\.remainingMs\) \? ' urgent' : ''\}" data-expires="\$\{expiresAt\}"/)
  assert.match(uiSource, /querySelectorAll\('\.approval-clock\[data-expires\], \.approval-menu-time\[data-expires\]'\)/)
  assert.match(uiSource, /el\.classList\.toggle\('urgent', approvalUrgent\(remaining\)\)/)
})
