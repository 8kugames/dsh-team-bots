// src/services/session-view.js —— 会话查看域（只读）
// 在团队工作台里直接查看插件托管会话（任务会话 / 控制面会话 / 审查会话）的对话内容，
// 不必跳回宿主原生界面。宿主读取走 ctx.sessionQuery.observeSession：活会话与已落盘
// 会话同一条只读通道（live / prepared 两种来源），不激活、不写入、不改宿主状态。
//
// 口径：
// - 只读：本域绝不向宿主会话 append；查看器没有输入面，对话输入仍走群聊/单聊指令链。
// - 可见面：只展示 append-origin 的 user/assistant/tool 消息事件（宿主 surface 层语义，
//   与原生 transcript 同源）；system/developer 是管线事件不展示；替换（compaction 折叠）
//   的影子事件不展示。
// - 脱敏：所有出库文本过 maskSecretValues，与轨迹域同款。
// - 增量：事件 seq 即数组下标（宿主契约），游标 afterSeq/beforeSeq 皆为事件 seq；
//   轮询只拉新增，翻旧只拉更早，每页默认 200 条。

import { AppError, badRequest, notFound } from '../errors.js'

// 每条消息的文本/推理/工具结果上限：查看是抽查场景，超长截断足够。
const TEXT_LIMIT = 8_000
const REASONING_LIMIT = 4_000
const TOOL_TEXT_LIMIT = 4_000
const ENTRY_LIMIT_DEFAULT = 200
const ENTRY_LIMIT_MAX = 500
const OBSERVE_TIMEOUT_MS = 15_000

// 消息事件 → 查看器角色。system/developer 是管线事件（系统提示词、工具面变更），
// 对「看对话」没有价值且体积巨大，不进查看面。
const SURFACE_ROLES = new Map([
  ['user/message', 'user'],
  ['assistant/message', 'assistant'],
  ['tool/result', 'tool'],
])

export const sessionViewMethods = {
  // 会话目录：插件绑定表（session_bindings，含 alias 行——结转后的旧会话仍可查历史）
  // 为家谱，逐行补 bot/项目/任务标识与运行态。projectId 给定时只列该域
  //（项目控制面 + 任务会话 + 审查会话）；solo 域（project_id IS NULL）只在全局目录出现。
  sessionCatalog(projectId = null) {
    const scoped = projectId != null
    const rows = this.store.all(
      `SELECT sb.session_id, sb.kind, sb.alias, sb.bot_id, sb.project_id, sb.task_id,
              b.name AS bot_name, b.status AS bot_status,
              p.key AS project_key, p.name AS project_name,
              tk.number AS task_number, tk.title AS task_title
         FROM session_bindings sb
         JOIN bots b ON b.id = sb.bot_id
         LEFT JOIN projects p ON p.id = sb.project_id
         LEFT JOIN tasks tk ON tk.id = sb.task_id
        ${scoped ? 'WHERE sb.project_id = ?' : ''}
        ORDER BY sb.alias ASC, sb.created_at DESC, sb.rowid DESC`,
      ...(scoped ? [projectId] : []),
    )
    return {
      sessions: rows.map(row => {
        const last = this.store.get(
          'SELECT status, kind, started_at, ended_at, queued_at FROM runs WHERE session_id = ? ORDER BY COALESCE(ended_at, queued_at) DESC, rowid DESC LIMIT 1',
          row.session_id,
        )
        const running = Boolean(this.store.get(
          "SELECT 1 AS ok FROM runs WHERE session_id = ? AND status IN ('queued', 'running')",
          row.session_id,
        )?.ok,
        )
        return {
          sessionId: row.session_id,
          kind: row.kind,
          alias: Boolean(row.alias),
          botId: row.bot_id,
          botName: row.bot_name ?? 'Bot',
          projectId: row.project_id,
          projectKey: row.project_key ?? null,
          projectName: row.project_name ?? null,
          taskId: row.task_id,
          taskIdentifier: row.project_key && row.task_number ? `${row.project_key}-${row.task_number}` : null,
          taskTitle: row.task_title ?? null,
          running,
          lastRunStatus: last?.status ?? null,
          lastRunKind: last?.kind ?? null,
          lastRunAt: last?.ended_at ?? last?.started_at ?? last?.queued_at ?? null,
        }
      }),
    }
  },

  // 会话消息读取。三选一入口：sessionId 直达 / runId 归属解析；无 afterSeq 时取尾部
  //（查看正在进行的对话），有 afterSeq 时向前增量（轮询），有 beforeSeq 时向旧翻页。
  async sessionMessages({ sessionId = null, runId = null, afterSeq, beforeSeq, limit }: {
    sessionId?: string | null
    runId?: string | null
    afterSeq?: number
    beforeSeq?: number
    limit?: number
  } = {}) {
    if (!sessionId && !runId) throw badRequest('缺少参数 sessionId 或 runId')
    if (sessionId && runId) throw badRequest('sessionId 与 runId 只能提供一个')
    if (sessionId && typeof sessionId !== 'string') throw badRequest('sessionId 必须是字符串')
    if (runId) {
      const run = this.store.get('SELECT session_id FROM runs WHERE id = ?', runId)
      if (!run?.session_id) throw notFound('该运行没有归属会话（或尚未启动）')
      sessionId = run.session_id
    }
    // 授权闸：只读插件绑定表里登记过的会话——宿主可能有用户自己的私人会话，
    // 插件 API 不做任意会话的读取代理。
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw notFound('不是本插件管理的会话')
    const query = this.runtime?.ctx?.sessionQuery ?? this.runtime?.ctx?.get?.('sessionQuery')
    if (!query?.observeSession) {
      throw new AppError('DSH_UNAVAILABLE', '宿主未提供会话读取服务（sessionQuery）', 503)
    }

    const maxEntries = Math.min(Math.max(Number(limit) || ENTRY_LIMIT_DEFAULT, 1), ENTRY_LIMIT_MAX)
    const after = afterSeq === undefined || afterSeq === null ? null
      : (Number.isInteger(Number(afterSeq)) ? Number(afterSeq) : null)
    const before = beforeSeq === undefined || beforeSeq === null ? null
      : (Number.isInteger(Number(beforeSeq)) ? Number(beforeSeq) : null)

    let observation
    try {
      observation = await query.observeSession(sessionId, {
        projectionMode: 'none',
        signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS),
      })
    } catch (error) {
      const code = (error as { code?: string } | null | undefined)?.code
      if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'session/not-found') {
        throw notFound('宿主查不到该会话（已删除或从未落盘）')
      }
      if (code === 'SESSION_QUERY_ABORTED') throw new AppError('DSH_UNAVAILABLE', '会话读取超时', 504)
      throw error
    }
    try {
      const events = observation.events ?? []
      const cursor = Number(observation.cursor ?? events.length - 1)
      // pass 1：tool/call → 工具名配对表（callId → name）。工具结果消息只带 toolCallId，
      // 名字在更早的 tool/call 事件里；从 0 全量扫一遍，O(n) 纯遍历。
      const callNames = new Map()
      for (let i = 0; i < events.length; i++) {
        const event = events[i]
        if (event?.type === 'tool/call' && event.data?.callId) {
          callNames.set(event.data.callId, event.data.name)
        }
      }
      // pass 2：按模式取条目。
      const entries = []
      let hasOlder = false
      let hasMore = false
      const entryOf = (event) => this.sessionEntryOf(event, callNames)
      if (after !== null) {
        // 增量：afterSeq 之后的事件，顺序输出，到 limit 截断。
        for (let i = after + 1; i < events.length; i++) {
          const entry = entryOf(events[i])
          if (!entry) continue
          if (entries.length >= maxEntries) { hasMore = true; break }
          entries.push(entry)
        }
      } else {
        // 尾部/翻旧：从 before（默认日志末尾）向前收 maxEntries 条，再正序返回。
        const end = before === null ? events.length : Math.min(before, events.length)
        const collected = []
        for (let i = end - 1; i >= 0; i--) {
          const entry = entryOf(events[i])
          if (!entry) continue
          if (collected.length >= maxEntries) break
          collected.push(entry)
        }
        collected.reverse()
        entries.push(...collected)
        // 旧方向还有内容：收满且最早一条不是日志头（近似口径，翻页由 beforeSeq 兜底）。
        hasOlder = entries.length > 0 && entries[0].seq > 0
      }
      return {
        sessionId,
        live: observation.source === 'live',
        running: Boolean(this.store.get(
          "SELECT 1 AS ok FROM runs WHERE session_id = ? AND status IN ('queued', 'running')",
          sessionId,
        )?.ok),
        cursor,
        entries,
        hasOlder,
        hasMore,
        context: this.sessionViewContext(binding),
      }
    } finally {
      try { observation?.[Symbol.dispose]?.() } catch {}
    }
  },

  // 查看器头部上下文：绑定行 → 人类可读标识（bot 名 / 域 / 任务号）。
  sessionViewContext(binding) {
    const bot = this.store.get('SELECT name FROM bots WHERE id = ?', binding.bot_id)
    const project = binding.project_id
      ? this.store.get('SELECT key, name FROM projects WHERE id = ?', binding.project_id)
      : null
    const task = binding.task_id
      ? this.store.get('SELECT number, title FROM tasks WHERE id = ?', binding.task_id)
      : null
    return {
      botName: bot?.name ?? 'Bot',
      kind: binding.kind,
      alias: Boolean(binding.alias),
      projectKey: project?.key ?? null,
      projectName: project?.name ?? null,
      taskIdentifier: project?.key && task?.number ? `${project.key}-${task.number}` : null,
      taskTitle: task?.title ?? null,
    }
  },

  // 单事件 → 查看器条目。非 append 消息事件返回 null（跳过）。
  sessionEntryOf(event, callNames) {
    const role = SURFACE_ROLES.get(event?.type)
    if (!role || event.surfaceOp !== 'append') return null
    const message = role === 'user' ? event.data : event.data?.message
    if (!message) return null
    const entry = {
      seq: event.seq,
      mid: message.id ?? null,
      time: Number.isFinite(event.time) ? new Date(event.time).toISOString() : null,
      role,
      turn: event.data?.turn ?? null,
      text: null,
      reasoning: null,
      toolName: null,
      toolCallId: null,
      isError: false,
      interrupted: false,
    }
    if (role === 'assistant') {
      entry.interrupted = event.data?.interrupted === true
    }
    if (role === 'tool') {
      entry.toolCallId = message.toolCallId ?? null
      entry.toolName = entry.toolCallId ? callNames.get(entry.toolCallId) ?? null : null
      entry.isError = message.isError === true
    }
    const blocks = Array.isArray(message.content) ? message.content : []
    const texts = []
    const reasons = []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(entry.role === 'tool' ? truncate(block.text, TOOL_TEXT_LIMIT) : truncate(block.text, TEXT_LIMIT))
      } else if (block.type === 'reasoning' && typeof block.text === 'string') {
        reasons.push(truncate(block.text, REASONING_LIMIT))
      } else if (block.type === 'image') {
        texts.push('[图片]')
      } else if (block.type === 'file') {
        texts.push(`[文件 ${block.attachment?.name ?? block.attachment?.attachmentId ?? ''}]`)
      }
      // tool-call 块不单独展示：工具调用由配对的 tool/result 条目代表（名字/参数/结果一体）。
    }
    if (entry.role === 'tool' && event.data?.error?.reason) {
      texts.push(truncate(String(event.data.error.reason), TOOL_TEXT_LIMIT))
    }
    if (texts.length > 0) entry.text = this.maskSecretValues(texts.join('\n'))
    if (reasons.length > 0) entry.reasoning = this.maskSecretValues(reasons.join('\n'))
    return entry
  },
}

function truncate(value, limit) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}
