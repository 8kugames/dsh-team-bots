// DSHBOTS-240：越权审批（跨会话审批）通知增强守门。
// ① 通知明细带来源群聊（项目名/KEY）+ 任务 ID + 任务名（后端真实建库验证）；
// ② 顶部通知展开态渲染与群内审批卡同组件，含「允许一次/拒绝」按钮（前端执行真实源码块）；
// ③ 点击卡片非按钮区仍跳对应会话（data-action="focus-approval" 与内联按钮并存）。
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
import './helpers/eval-shim.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const readSource = (...segments) => readFileSync(join(root, ...segments), 'utf8')

const uiSource = readUiSource()
const approvalsSource = readSource('src', 'services', 'approvals.js')

// ===== 后端：真实建库 =====

class StubRuntime {
  ctx: any
  constructor(ctx = null) { this.ctx = ctx }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

const now = () => new Date().toISOString()

async function setup() {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-approval-source-'))
  const workspace = join(rootDir, 'workspace')
  const dataDir = join(rootDir, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  service.config.approvalTimeoutMs = 5_000
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

test('approvalsPending 明细带来源群聊 KEY 与任务 ID/任务名；无任务时留空不猜', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Notify Source')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const task = await service.createTask({ projectId: project.id, title: '越权审批通知增强' })
    bindSession(store, { sessionId: 'sess-src', botId: director.id, projectId: project.id })
    // 审批锚定一条带 task_id 的运行：run_id → runs.task_id → tasks 两次主键连接。
    store.run(
      `INSERT INTO runs(id, bot_id, task_id, kind, trigger_type, status, idempotency_key, session_id, queued_at)
       VALUES (?, ?, ?, 'task_run', 'task_created', 'running', ?, ?, ?)`,
      'run-src', director.id, task.id, 'idem-src', 'sess-src', '2026-01-01T00:00:01.000Z',
    )
    const outcome = service.handleApprovalRequest(makeReq({ sessionId: 'sess-src', zh: '改写 ui/app.js' }), () => {})

    const pending = service.approvalsPending()
    assert.equal(pending.count, 1)
    const item = pending.items[0]
    assert.equal(item.projectName, 'Notify Source', '来源群聊项目名')
    assert.equal(item.projectKey, project.key, '来源群聊项目 KEY')
    assert.equal(item.taskId, task.id, '任务 ID')
    assert.equal(item.taskIdentifier, `${project.key}-${task.number}`, '任务标识 KEY-N')
    assert.equal(item.taskTitle, '越权审批通知增强', '任务名')

    // 项目内审批列表（桌面通知气泡态数据源）带同一套来源字段，口径一致。
    const projectItems = service.approvalsForProject(project.id)
    assert.equal(projectItems.length, 1)
    assert.equal(projectItems[0].projectKey, project.key, '项目内条目带项目 KEY')
    assert.equal(projectItems[0].taskIdentifier, `${project.key}-${task.number}`, '项目内条目带任务标识')

    // 无任务锚定的审批（如纯群聊运行）不猜任务：字段留空，来源行只出群聊。
    // one_active_run_per_bot（DSHBOTS-291）：同 bot 第二条活跃运行播种前先置终态释放。
    store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = 'run-src'", '2026-01-01T00:00:01.500Z')
    store.run(
      `INSERT INTO runs(id, bot_id, task_id, kind, trigger_type, status, idempotency_key, session_id, queued_at)
       VALUES (?, ?, NULL, 'chat_run', 'chat', 'running', ?, ?, ?)`,
      'run-chat', director.id, 'idem-chat', 'sess-src', '2026-01-01T00:00:02.000Z',
    )
    const chatOutcome = service.handleApprovalRequest(makeReq({ sessionId: 'sess-src', toolName: 'write', zh: '群聊写入' }), () => {})
    const after = service.approvalsPending()
    const chatItem = after.items.find(entry => entry.tool_name === 'write')
    assert.equal(chatItem.taskId, null, '无任务锚定不留任务 ID')
    assert.equal(chatItem.taskIdentifier, null, '无任务锚定不拼任务标识')
    assert.equal(chatItem.taskTitle, null, '无任务锚定不留任务名')
    assert.equal(chatItem.projectKey, project.key, '群聊来源仍保留')

    await outcome
    await chatOutcome
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ===== 前端：读源断言 + 真实源码块执行 =====

const utilSource = readSource('ui', 'modules', 'util.js')
const formatTimeSource = utilSource.match(/export function formatTime\(value\) \{[\s\S]*?\n\}/)[0].replace(/^export /, '')
const formatTime = new Function(`${formatTimeSource}\nreturn formatTime`)()
const iconStub = (name, cls = '') => `<svg class="${cls}" data-icon="${name}"></svg>`
const escStub = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const markerBlock = (name) => {
  const match = uiSource.match(new RegExp(`// ===== ${name}:start[\\s\\S]*?// ===== ${name}:end =====`))
  assert.ok(match, `${name} 标记块必须存在`)
  return match[0]
}
const v2 = new Function('icon', 'esc', 'attr', 'formatTime', `${formatTimeSource}
${markerBlock('approval-ux')}
${markerBlock('approval-v2')}
return { approvalCardMarkup, approvalSourceLine }`)(iconStub, escStub, escStub, formatTime)

const baseApproval = {
  id: 'ap-1',
  botName: 'artist',
  tool_name: 'bash',
  status: 'pending',
  created_at: '2026-11-03T11:00:00.000Z',
  expires_at: '2026-11-03T11:10:00.000Z',
  remainingMs: 598_000,
  display_reason: '需要写入 ui/app.js 的审批卡片实现',
}

test('展开态通知渲染审批卡：含允许一次/拒绝按钮，且带来源群聊与任务定位', () => {
  const html = v2.approvalCardMarkup({
    ...baseApproval,
    projectName: 'Notify Source',
    projectKey: 'NOTIFY',
    taskIdentifier: 'NOTIFY-7',
    taskTitle: '越权审批通知增强',
  }, false, true)
  // ② 与群内审批卡同组件：pending 双按钮原样出现。
  assert.match(html, /data-action="approval-decide" data-approval-id="ap-1" data-decision="allow"/, '允许一次按钮')
  assert.match(html, /data-action="approval-decide" data-approval-id="ap-1" data-decision="reject"/, '拒绝按钮')
  assert.match(html, />允许一次</)
  assert.match(html, />拒绝</)
  // ① 来源定位行：项目名/KEY + 任务 ID + 任务名。
  assert.match(html, /class="approval-source"/, '来源定位行出现')
  assert.match(html, /class="approval-source-scope">Notify Source · NOTIFY</, '来源群聊项目名/KEY')
  assert.match(html, /class="approval-source-task">NOTIFY-7 越权审批通知增强</, '任务 ID + 任务名')
})

test('群聊卡片不带来源字段时渲染与原来逐字一致（来源行整段不出现）', () => {
  const html = v2.approvalCardMarkup(baseApproval)
  assert.doesNotMatch(html, /approval-source/, '无来源字段不出来源行')
  assert.match(html, /data-action="approval-decide"/, '群聊卡片按钮不受影响')
  // 群聊卡片即使数据带来源字段也不渲染来源行（只在顶部通知展开态显示，避免同会话冗余）。
  const withFields = v2.approvalCardMarkup({ ...baseApproval, projectKey: 'NOTIFY', taskIdentifier: 'NOTIFY-7' })
  assert.doesNotMatch(withFields, /approval-source/, '群聊卡片不渲染来源行')
})

test('顶部通知展开态复用审批卡组件，卡片整体可点击跳转（与内联按钮并存）', () => {
  // 展开态逐条走 approvalCardMarkup（复用群内审批卡组件，不新写一份），并显式打开来源定位行。
  assert.match(uiSource, /approvalCardMarkup\(item, state\.approvalDeciding\?\.has\(item\.id\) \?\? false, true\)/, '展开态复用审批卡组件并打开来源行')
  // ③ 卡片容器带 focus-approval：点非按钮区跳对应会话，按钮经内层 data-action 命中决策。
  assert.match(uiSource, /class="approval-menu-card" data-action="focus-approval" data-approval-id="\$\{attr\(item\.id\)\}"/, '卡片整体可跳转')
  assert.match(uiSource, /case 'focus-approval': \{/, '跳转 handler 保留')
})
