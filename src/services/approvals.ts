// DSHBOTS-32 群聊审批：宿主 approval/request waterfall 的插件侧应答器。
// 认领 session_bindings 命中的 bot 会话：绑定到项目的走群聊卡片；绑定为单聊（kind='solo'、
// project_id 为空）的走单聊卡片（DSHBOTS-218）；其余 next() 透传（人类会话审批继续走 Web UI）。
// 决策权仅用户（type=user）持有，bot 一律 forbidden 不能自批；pending 之外拒绝重复应答，动作写审计。
// 注意：本域自管迁移（db.js 已贴 800 行上限，一行不加），手法与 db.js 的 addColumn/recordMigration 一致。
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { id, nowIso } from '../util.js'
import { botInActiveProject } from './questions.js'
import { columnNotNull, rebuildTable } from '../db-migrations.js'

// project_id 可空：单聊会话没有项目归属（DSHBOTS-218），卡片锚点改落 solo_messages。
const APPROVALS_TABLE_DDL = `
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  bot_id TEXT NOT NULL,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  call_id TEXT,
  reason TEXT,
  display_reason TEXT,
  tool_target TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
`
const APPROVALS_DDL = `
CREATE TABLE IF NOT EXISTS approvals (${APPROVALS_TABLE_DDL});
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS approvals_project_idx ON approvals(project_id, created_at);
`

// 迁移体全在本文件：建表、messages 加 kind/approval_id 两列、幂等登记迁移名。
// 重启清理也在此——宿主侧请求随进程消失，不可能再被应答，库里残留的 pending 一律置 timeout。
export function ensureApprovalSchema(store) {
  store.exec(APPROVALS_DDL)
  // 旧库 approvals.project_id 是 NOT NULL（群聊专用时期），单聊会话无处归属：重建放宽为可空。
  if (columnNotNull(store.db, 'approvals', 'project_id')) {
    rebuildTable(store.db, 'approvals', `CREATE TABLE approvals (${APPROVALS_TABLE_DDL})`)
    store.exec('CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at)')
    store.exec('CREATE INDEX IF NOT EXISTS approvals_project_idx ON approvals(project_id, created_at)')
  }
  const messageColumns = store.all('PRAGMA table_info(messages)').map(column => column.name)
  if (!messageColumns.includes('kind')) {
    store.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'")
  }
  if (!messageColumns.includes('approval_id')) {
    store.exec('ALTER TABLE messages ADD COLUMN approval_id TEXT')
  }
  // 旧库的 approvals 表没有 tool_target 列（新库建表 DDL 已带）。
  const approvalColumns = store.all('PRAGMA table_info(approvals)').map(column => column.name)
  if (!approvalColumns.includes('tool_target')) {
    store.exec('ALTER TABLE approvals ADD COLUMN tool_target TEXT')
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
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    'approvals_tool_target', nowIso(),
  )
  store.run(
    "UPDATE approvals SET status = 'timeout' WHERE status = 'pending'",
  )
}

// 目标提取（纯函数）：按参数形状判别，不按工具名——宿主工具族会扩展，形状更稳。
// bash 类取 command 首行（超长截 120 字符，chip 只需要可辨认的意图）；
// edit/write/read 类取 file_path 原样（绝对路径入库，展示层再收成工作区相对形）。
export function toolTargetOf(arguments_) {
  if (!arguments_ || typeof arguments_ !== 'object') return null
  if (typeof arguments_.command === 'string') {
    const firstLine = arguments_.command.trim().split('\n')[0].trim()
    return firstLine ? firstLine.slice(0, 120) : null
  }
  if (typeof arguments_.file_path === 'string' && arguments_.file_path.trim()) {
    return arguments_.file_path.trim()
  }
  return null
}

// pre-execute 目标缓存上限：只记最近若干次调用的目标，防长会话里无界增长。
const APPROVAL_TARGET_CACHE_LIMIT = 200

// 来源定位字段（DSHBOTS-240）：审批行 → 来源群聊（项目名/KEY）+ 任务 ID/标识/标题。
// 列表查询用 JOIN 一次取齐（approvalsPending / approvalsForProject / approvalsForBot 共用），
// 避免逐行 N+1；缺任务时任务字段留空，不猜。
function approvalSourceFields(row) {
  const key = row.project_key ?? ''
  return {
    projectName: row.project_name ?? '',
    projectKey: key,
    taskId: row.task_id ?? null,
    taskIdentifier: row.task_id ? `${row.task_project_key ?? key ?? 'T'}-${row.task_number}` : null,
    taskTitle: row.task_title ?? null,
  }
}

export const approvalsMethods = {
  // 由 core.attachRuntime 调用：注册宿主事件。runtime.ctx 不存在（测试桩）时跳过注册，
  // 但 pending Map 无条件初始化——handleApprovalRequest 直调（测试）也依赖它。
  approvalsAttach(runtime) {
    this.approvalPending = new Map()
    this.approvalTargets = new Map()
    if (this.approvalsAttached || !runtime?.ctx?.on) return
    this.approvalsAttached = true
    // prepend：宿主 approval/request 是「按注册序」的瀑布流——先执行的监听器若不调用 next()，
    // 就截断后面整条链路。web bundle 的 dsh-api-remotes 比本插件先加载，它把请求转给 DSH 原生审批面板，
    // 面板给出答案后直接 resolve 且不调 next()；插件若排在其后就永远收不到请求，审批请求全落到原生界面
    // （approvals 表零记录、工作台审批卡片不出现）。插到队首后：命中项目绑定的 bot 会话由插件自己应答，
    // 未命中的照旧 next() 透传给原生界面。
    const off = runtime.ctx.on('approval/request', (req, next) => this.handleApprovalRequest(req, next), { prepend: true })
    // approval/request 事件不带工具参数，目标取数只能从 tools/pre-execute 透传监听来：
    // 宿主先过 pre-execute 网关、gate 返回 ask 才发起审批，此刻 exec 里带着 callId/name/arguments。
    // 按 callId 记已提取目标（先提短串再掩码，只存小字符串），审批发起时一次性取走；超量 FIFO 驱逐。
    const offPreExecute = runtime.ctx.on('tools/pre-execute', (exec, next) => {
      const callId = exec?.callId ? String(exec.callId) : ''
      const target = callId ? toolTargetOf(exec.arguments) : null
      if (callId && target) {
        this.approvalTargets.set(callId, this.maskSecretValues(target))
        if (this.approvalTargets.size > APPROVAL_TARGET_CACHE_LIMIT) {
          this.approvalTargets.delete(this.approvalTargets.keys().next().value)
        }
      }
      return next()
    })
    runtime.ctx.effect?.(() => () => {
      off?.()
      offPreExecute?.()
      for (const pending of this.approvalPending.values()) clearTimeout(pending.timer)
      this.approvalPending.clear()
      this.approvalTargets.clear()
    }, 'dsh-team: approval request binding')
  },

  // waterfall 监听器：命中 bot 会话且绑定到项目才认领走群聊卡片；单聊会话（kind='solo'、
  // project_id 为空）由工作台单聊卡片承接（DSHBOTS-218）；其余（未绑定、bot 间私信）透传。
  async handleApprovalRequest(req, next) {
    const sessionId = req?.agent?.session?.id
    // bindingOfSession 在 DshRuntime 原型上，服务层拿不到 this 绑定，这里直查同款 SQL。
    const binding = sessionId
      ? this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
      : undefined
    if (!binding) return next()

    const store = this.store
    // DSHBOTS-294：与 questions.ts 同款——solo 判定按「无 project 上下文的控制面会话」。
    const isSolo = !binding.project_id && (binding.kind === 'solo' || (binding.kind === 'bot' && !botInActiveProject(store, binding.bot_id)))
    if (!binding.project_id && !isSolo) return next()
    const bot = store.get('SELECT * FROM bots WHERE id = ?', binding.bot_id)
    const project = isSolo ? null : store.get('SELECT * FROM projects WHERE id = ?', binding.project_id)
    if (!bot || (!isSolo && !project)) return next()

    const run = store.get('SELECT id FROM runs WHERE session_id = ? ORDER BY queued_at DESC LIMIT 1', sessionId)
    const timeoutMs = this.config.approvalTimeoutMs
    const createdAt = nowIso()
    const approvalId = id('apr')
    const toolName = String(req.toolName ?? 'tool').slice(0, 100)
    // 摘要优先展示中文文案；reason 是英文机读串，落库前统一过密钥掩码。
    const displayReason = req.displayReason?.zh ? this.maskSecretValues(String(req.displayReason.zh).slice(0, 2_000)) : null
    const reason = this.maskSecretValues(String(req.reason ?? '').slice(0, 2_000))
    // 本次调用的操作目标：pre-execute 阶段按 callId 记下，这里一次性取走（不留残页）；没有则为 NULL，
    // UI 回退到从摘要正则猜测的旧口径。
    const callId = req.callId ? String(req.callId) : null
    const toolTarget = callId ? (this.approvalTargets.get(callId) ?? null) : null
    if (callId) this.approvalTargets.delete(callId)

    store.run(
      `INSERT INTO approvals(id, project_id, run_id, bot_id, session_id, tool_name, call_id, reason, display_reason, tool_target, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      approvalId, project?.id ?? null, run?.id ?? null, bot.id, sessionId,
      toolName, callId, reason, displayReason, toolTarget,
      createdAt, new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
    )

    // 卡片锚点：群聊落 messages（kind=approval），单聊落 solo_messages（DSHBOTS-218）。
    // 状态渲染时查 approvals 表，消息体只是纯文本兜底，不承载状态。
    const summary = displayReason || reason || '请求执行需要授权的操作'
    const anchorBody = `【审批请求】${bot.name} 请求使用 ${toolName}：${summary}`
    if (isSolo) {
      this.insertSoloMessage?.({
        botId: bot.id, senderType: 'system', senderId: 'system',
        body: anchorBody, runId: run?.id ?? null, createdAt, kind: 'approval', approvalId,
      })
    } else {
      const group = this.groupOf(project.id)
      store.run(
        `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, kind, approval_id, created_at)
         VALUES (?, ?, ?, 'system', ?, ?, '[]', 'approval', ?, ?)`,
        id('msg'), project.id, group?.id ?? null, bot.id, anchorBody, approvalId, createdAt,
      )
    }

    // DSHBOTS-215 问答回路：审批转发微信管理员（通道可用时）。只推纯文本镜像，
    // 状态仍由群卡片/工作台承载；管理员决定经「批 <token> 允许|拒绝」路由回本条目。
    // 单聊没有项目语境，不转发（微信侧只服务项目管理者）。
    if (project) {
      try {
        this.wechatApproval?.(project, { id: approvalId, bot_name: bot.name, tool_name: toolName, reason: summary })
      } catch (error: any) {
        this.logger?.warn?.('dsh-team: 微信审批转发失败: %s', error?.message ?? error)
      }
    }

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

  // 目标展示形：绝对路径落在项目工作区内且剩余段非空、不含空白时收成相对路径（chip 少占宽）；
  // 命令、带空白的路径或库外路径原样返回。title 层恒用原始值，鼠标悬停可见全貌。
  toolTargetDisplay(target) {
    const prefix = `${this.config.workspace}/`
    if (typeof target === 'string' && target.startsWith(prefix)) {
      const rest = target.slice(prefix.length)
      if (rest && !/\s/.test(rest)) return rest
    }
    return target
  },

  approvalView(row) {
    const bot = this.store.get('SELECT name FROM bots WHERE id = ?', row.bot_id)
    const expiresAt = Date.parse(row.expires_at)
    return {
      ...row,
      botName: bot?.name ?? 'Bot',
      tool_target_display: row.tool_target ? this.toolTargetDisplay(row.tool_target) : null,
      // 会话归属（DSHBOTS-218）：单聊审批没有项目，UI 据此显示来源列并决定跳转目标。
      scope: row.project_id ? 'project' : 'solo',
      remainingMs: row.status === 'pending' ? Math.max(0, expiresAt - Date.now()) : 0,
    }
  },

  // state 视图的待审批条目：pending 在前（按创建时间倒序），已决的跟在后面供卡片回显结果。
  // 来源定位字段同 approvalsPending（DSHBOTS-240）：桌面通知与顶部通知共用同一套取数口径。
  approvalsForProject(projectId) {
    const rows = this.store.all(
      `SELECT a.*, p.name AS project_name, p.key AS project_key,
              t.id AS task_id, t.number AS task_number, t.title AS task_title, tp.key AS task_project_key
       FROM approvals a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN runs r ON r.id = a.run_id
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN projects tp ON tp.id = t.project_id
       WHERE a.project_id = ?
       ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 30`,
      projectId,
    )
    return rows.map(row => ({ ...this.approvalView(row), ...approvalSourceFields(row) }))
  },

  // 单聊视图的待审批条目（DSHBOTS-218）：口径与 approvalsForProject 一致，按 bot 取项目外条目。
  approvalsForBot(botId) {
    const rows = this.store.all(
      `SELECT a.*, p.name AS project_name, p.key AS project_key,
              t.id AS task_id, t.number AS task_number, t.title AS task_title, tp.key AS task_project_key
       FROM approvals a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN runs r ON r.id = a.run_id
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN projects tp ON tp.id = t.project_id
       WHERE a.project_id IS NULL AND a.bot_id = ?
       ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 30`,
      botId,
    )
    return rows.map(row => ({ ...this.approvalView(row), ...approvalSourceFields(row) }))
  },

  // 全局待审视图（DSHBOTS-102）：跨项目聚合 status='pending'，按创建时间倒序。
  // count 是全库 pending 总数（徽标口径，已决一律不计），items 最多 50 条供顶部入口列明细。
  // 明细带项目名，用户不在该项目群聊页也能看到「谁、在哪个项目、要什么、还剩多久」。
  // scope 区分项目群聊 / 单聊（DSHBOTS-218）：顶部入口据此决定点击后跳哪个会话。
  // 来源定位（DSHBOTS-240）：额外带项目 key 与任务标识/标题——顶部跨会话审批通知要让
  // owner 不跳转就能判断「该批谁」。run_id → runs.task_id → tasks 两次主键连接，缺任务留空。
  approvalsPending(limit = 50) {
    const rows = this.store.all(
      `SELECT a.*, p.name AS project_name, p.key AS project_key,
              t.id AS task_id, t.number AS task_number, t.title AS task_title, tp.key AS task_project_key
       FROM approvals a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN runs r ON r.id = a.run_id
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN projects tp ON tp.id = t.project_id
       WHERE a.status = 'pending' ORDER BY a.created_at DESC LIMIT ?`,
      limit,
    )
    const count = Number(this.store.get("SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'")?.count ?? 0)
    return {
      count,
      items: rows.map(row => ({
        ...this.approvalView(row),
        ...approvalSourceFields(row),
      })),
    }
  },
}
