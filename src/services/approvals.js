// DSHBOTS-32 群聊审批：宿主 approval/request waterfall 的插件侧应答器。
// 只认领 session_bindings 命中且绑定到项目的 bot 会话；其余 next() 透传（人类会话审批继续走 Web UI）。
// 决策模型沿用 decide_proposal 惯例：默认 this.actor()、pending 之外拒绝重复应答、动作写审计。
// 注意：本域自管迁移（db.js 已贴 800 行上限，一行不加），手法与 db.js 的 addColumn/recordMigration 一致。
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { id, nowIso } from '../util.js'

const APPROVALS_DDL = `
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
);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS approvals_project_idx ON approvals(project_id, created_at);
`

// 迁移体全在本文件：建表、messages 加 kind/approval_id 两列、幂等登记迁移名。
// 重启清理也在此——宿主侧请求随进程消失，不可能再被应答，库里残留的 pending 一律置 timeout。
export function ensureApprovalSchema(store) {
  store.exec(APPROVALS_DDL)
  const messageColumns = store.all('PRAGMA table_info(messages)').map(column => column.name)
  if (!messageColumns.includes('kind')) {
    store.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'")
  }
  if (!messageColumns.includes('approval_id')) {
    store.exec('ALTER TABLE messages ADD COLUMN approval_id TEXT')
  }
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    'approvals_table', nowIso(),
  )
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    'messages_approval_link', nowIso(),
  )
  store.run(
    "UPDATE approvals SET status = 'timeout' WHERE status = 'pending'",
  )
}

export const approvalsMethods = {
  // 由 core.attachRuntime 调用：注册宿主事件。runtime.ctx 不存在（测试桩）时跳过注册，
  // 但 pending Map 无条件初始化——handleApprovalRequest 直调（测试）也依赖它。
  approvalsAttach(runtime) {
    this.approvalPending = new Map()
    if (this.approvalsAttached || !runtime?.ctx?.on) return
    this.approvalsAttached = true
    const off = runtime.ctx.on('approval/request', (req, next) => this.handleApprovalRequest(req, next))
    runtime.ctx.effect?.(() => () => {
      off?.()
      for (const pending of this.approvalPending.values()) clearTimeout(pending.timer)
      this.approvalPending.clear()
    }, 'dsh-team: approval request binding')
  },

  // waterfall 监听器：命中 bot 会话且绑定到项目才认领；单聊会话（project_id 为空）没有群聊可发卡片，透传。
  async handleApprovalRequest(req, next) {
    const sessionId = req?.agent?.session?.id
    // bindingOfSession 在 DshRuntime 原型上，服务层拿不到 this 绑定，这里直查同款 SQL。
    const binding = sessionId
      ? this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
      : undefined
    if (!binding || !binding.project_id) return next()

    const store = this.store
    const bot = store.get('SELECT * FROM bots WHERE id = ?', binding.bot_id)
    const project = store.get('SELECT * FROM projects WHERE id = ?', binding.project_id)
    if (!bot || !project) return next()

    const run = store.get('SELECT id FROM runs WHERE session_id = ? ORDER BY queued_at DESC LIMIT 1', sessionId)
    const timeoutMs = this.config.approvalTimeoutMs
    const createdAt = nowIso()
    const approvalId = id('apr')
    const toolName = String(req.toolName ?? 'tool').slice(0, 100)
    // 摘要优先展示中文文案；reason 是英文机读串，落库前统一过密钥掩码。
    const displayReason = req.displayReason?.zh ? this.maskSecretValues(String(req.displayReason.zh).slice(0, 2_000)) : null
    const reason = this.maskSecretValues(String(req.reason ?? '').slice(0, 2_000))

    store.run(
      `INSERT INTO approvals(id, project_id, run_id, bot_id, session_id, tool_name, call_id, reason, display_reason, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      approvalId, project.id, run?.id ?? null, bot.id, sessionId,
      toolName, req.callId ? String(req.callId) : null, reason, displayReason,
      createdAt, new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
    )

    // 群聊里写一条审批卡片消息：状态渲染时查 approvals 表，消息体只是纯文本兜底，不承载状态。
    const group = this.groupOf(project.id)
    const summary = displayReason || reason || '请求执行需要授权的操作'
    store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, kind, approval_id, created_at)
       VALUES (?, ?, ?, 'system', ?, ?, '[]', 'approval', ?, ?)`,
      id('msg'), project.id, group?.id ?? null, bot.id,
      `【审批请求】${bot.name} 请求使用 ${toolName}：${summary}`, approvalId, createdAt,
    )

    return new Promise(resolve => {
      this.approvalPending ??= new Map()
      const timer = setTimeout(() => {
        // 超时按 reject 结算当次（宿主约束：应答不能跨轮次持久化后补答）。
        this.settleApproval(approvalId, 'timeout', 'rejected', null)
      }, timeoutMs)
      this.approvalPending.set(approvalId, { resolve, timer })
      // 轮次中止：宿主自行结算 cancelled，这里只清条目，不重复应答；迟到应答宿主会丢弃。
      req.signal?.addEventListener('abort', () => {
        this.settleApproval(approvalId, 'cancelled', null, null)
      }, { once: true })
    })
  },

  // 统一结算：清定时器、出 pending 表、写终态。hostAnswer 非空才向宿主应答（abort 分支不答）。
  settleApproval(approvalId, status, hostAnswer, decidedBy) {
    const pending = this.approvalPending?.get(approvalId)
    if (pending) {
      clearTimeout(pending.timer)
      this.approvalPending.delete(approvalId)
    }
    this.store.run(
      'UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = ?',
      status, decidedBy, nowIso(), approvalId, 'pending',
    )
    if (pending && hostAnswer) pending.resolve(hostAnswer)
  },

  // 群聊按钮入口（api action approval_decide）。鉴权：仅项目负责人（本地工作台用户）可作答，
  // bot 一律拒绝——审批是人对 bot 的授权，bot 不能自批（配合上下文隔离双保险）。动作写审计。
  async decideApproval(approvalId, decision, actor = this.actor()) {
    if (actor?.type !== 'user') throw forbidden('仅项目负责人可操作审批，bot 不能自批')
    if (!['allow', 'reject'].includes(decision)) throw badRequest('审批结果无效')
    const approval = this.store.get('SELECT * FROM approvals WHERE id = ?', approvalId)
    if (!approval) throw notFound('审批不存在')
    if (approval.status !== 'pending') throw conflict('审批已处理')
    const decidedBy = `${actor.type}:${actor.id}`
    this.settleApproval(approvalId, decision === 'allow' ? 'allowed' : 'rejected', decision === 'allow' ? 'allowed-once' : 'rejected', decidedBy)
    this.audit(actor, `approval.${decision}`, 'approval', approvalId, { toolName: approval.tool_name, botId: approval.bot_id })
    return this.approvalView(this.store.get('SELECT * FROM approvals WHERE id = ?', approvalId))
  },

  approvalView(row) {
    const bot = this.store.get('SELECT name FROM bots WHERE id = ?', row.bot_id)
    const expiresAt = Date.parse(row.expires_at)
    return {
      ...row,
      botName: bot?.name ?? 'Bot',
      remainingMs: row.status === 'pending' ? Math.max(0, expiresAt - Date.now()) : 0,
    }
  },

  // state 视图的待审批条目：pending 在前（按创建时间倒序），已决的跟在后面供卡片回显结果。
  approvalsForProject(projectId) {
    const rows = this.store.all(
      `SELECT * FROM approvals WHERE project_id = ?
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 30`,
      projectId,
    )
    return rows.map(row => this.approvalView(row))
  },
}
