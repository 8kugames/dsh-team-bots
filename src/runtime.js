import { randomUUID } from 'node:crypto'
import { AppError } from './errors.js'
import { ensureProjectWorkspace } from './paths.js'
import { recordUsage } from './usage.js'
import { id, nowIso } from './util.js'

const EFFORT_FALLBACK = (bot) => bot.effort || undefined

// teammate 等子会话的父指向在不同 DSH 版本里字段不一，逐个探测。
const PARENT_ACCESSORS = [
  session => session?.parentSessionId,
  session => session?.parentId,
  session => session?.parent?.sessionId,
  session => session?.parent?.id,
  session => session?.parent,
  session => session?.subagent?.parentSessionId,
  session => session?.subagent?.parent?.sessionId,
  session => session?.meta?.parentSessionId,
  session => session?.meta?.parent,
  session => session?.descriptor?.parentSessionId,
  session => session?.address?.parent,
]

function sessionParentId(session) {
  for (const accessor of PARENT_ACCESSORS) {
    let value
    try {
      value = accessor(session)
    } catch {
      continue
    }
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function isSubagentLike(session) {
  return Boolean(session?.subagent) || session?.mode === 'subagent' || sessionParentId(session) !== undefined
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

function reasonOf(event) {
  const reason = event?.data?.reason
  if (!reason || typeof reason !== 'object') return { kind: 'completed' }
  return reason
}

export class DshRuntime {
  constructor({ ctx, config, store, logger = console }) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.logger = logger
    this.pending = new Map()
    this.pendingByRun = new Map()
    this.childOwner = new Map()
    this.parentHints = new Map()
    this.sessionCreates = new Map()
    this.modelsCache = { at: 0, value: [] }
    this.selecting = Promise.resolve()
    this.completionHandler = null
    this.attached = false
  }

  setCompletionHandler(handler) {
    this.completionHandler = handler
  }

  attach() {
    if (this.attached) return
    this.attached = true
    const off = this.ctx.on?.('session/event', (session, event) => this.handleEvent(session, event))
    this.ctx.effect?.(() => () => {
      off?.()
      for (const pending of this.pending.values()) clearTimeout(pending.timer)
      this.pending.clear()
      this.pendingByRun.clear()
      this.childOwner.clear()
      this.parentHints.clear()
    }, 'dsh-team: runtime event binding')
    const offModels = this.ctx.on?.('llm/adapters-updated', () => {
      this.modelsCache = { at: 0, value: [] }
    })
    this.ctx.effect?.(() => () => offModels?.(), 'dsh-team: model cache invalidation')
    this.installPrompt()
  }

  installPrompt() {
    if (!this.ctx.systemPrompt?.section) return
    this.ctx.effect?.(() => this.ctx.systemPrompt.section({
      name: 'dsh-team-bot-identity',
      order: 620,
      interpolate: false,
      text: context => this.systemPromptFor(context),
    }), 'dsh-team: bot identity')
  }

  bindingOfSession(sessionId) {
    if (!sessionId) return undefined
    return this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
  }

  systemPromptFor(context) {
    const sessionId = context?.agent?.id ?? context?.session?.id ?? context?.sessionId
    const binding = this.bindingOfSession(sessionId)
    if (!binding) return ''
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', binding.bot_id)
    const project = this.store.get('SELECT * FROM projects WHERE id = ?', binding.project_id)
    if (!bot || !project) return ''
    const memories = this.store.all(
      `SELECT topic, content FROM memories
       WHERE status = 'active' AND (
         (scope_type = 'bot' AND scope_id = ?) OR (scope_type = 'project' AND scope_id = ?)
       ) ORDER BY updated_at DESC LIMIT 16`,
      bot.id,
      project.id,
    )
    const owner = project.owner_bot_id === bot.id
    const taskSession = binding.kind === 'task' && binding.task_id
    const assignedTask = taskSession
      ? this.store.get(
        'SELECT number, title FROM tasks WHERE id = ? AND project_id = ?',
        binding.task_id,
        project.id,
      )
      : undefined
    const memoryText = memories.length === 0
      ? 'No saved memories yet.'
      : memories.map(item => `- ${item.topic}: ${item.content}`).join('\n')
    const roleLine = taskSession
      ? `- You are executing one assigned task in ${project.name}${assignedTask ? ` (${project.key}-${assignedTask.number}: ${assignedTask.title})` : ''}. This session is not the group chat: do the work, verify it, and report back. Do not triage other requests here.`
      : `- You are ${owner ? 'the owner of this project group. Triage requests, split work and assign tasks; review deliveries with team_review_task and handle blocked tasks yourself instead of waiting for the user.' : 'a project member. Focus on work assigned to you.'}`
    const sharedRules = [
      '- The shared skill library is mounted at `/workspace/.agents/skills`; use installed skills when relevant.',
      '- Work only inside this project workspace unless the user explicitly authorizes another mounted path.',
      '- Never invent file changes or tool results. Report blockers precisely.',
      '- Reply in the user’s language.',
    ]
    const collaborationRules = taskSession
      ? [
          '- Do the work yourself unless the task genuinely splits into independent parts; do not assign work to other project bots.',
          '- Commits, deploys and anything irreversible wait for the owner bot or the user.',
          '- Use `team_remember` only for durable lessons from this task. Never store secrets or credentials.',
        ]
      : [
          '- You are a long-lived teammate. Your replies in the project group are visible to the user and other bots.',
          '- Use `team_assign_task` to hand concrete work to another project bot, or to re-dispatch a blocked task by its KEY-N number. Do not claim work is assigned unless the tool succeeds.',
          '- Tasks you dispatch are reviewed by you: when a delivery arrives, `team_review_task` accepts it or returns it with a rework reason.',
          '- Use `team_remember` for durable facts, preferences, decisions or lessons worth keeping. Never store secrets or credentials.',
          '- Use `team_propose_evolution` to suggest a durable instruction or skill change. You cannot approve your own proposal.',
          '- When executing a task, do the work, verify it, then return a concise result with changed paths and any risks.',
        ]
    const teamRules = ['## How this team works', ...collaborationRules, ...sharedRules].join('\n')
    return [
      '# Team bot identity',
      `You are ${bot.name}, a project bot on the user's team.`,
      bot.role ? `Role: ${bot.role}` : '',
      bot.instructions ? `\n${bot.instructions}` : '',
      '',
      '## Current project',
      `- Name: ${project.name}`,
      `- Key: ${project.key}`,
      `- Workspace: ${project.workspace_path || `/workspace/${project.slug}`}`,
      roleLine,
      '',
      teamRules,
      '',
      '## Long-term memory',
      memoryText.slice(0, 7000),
    ].filter(Boolean).join('\n')
  }

  async catalog(force = false) {
    if (!force && Date.now() - this.modelsCache.at < this.config.modelCacheMs) return this.modelsCache.value
    const value = []
    try {
      const providers = this.ctx.llm?.listProviders?.() ?? []
      for (const provider of providers) {
        let models = []
        try {
          models = await this.ctx.llm.listModels(provider.id)
        } catch {
          continue
        }
        for (const model of models ?? []) {
          let efforts = []
          let defaultEffort
          let contextWindow
          let maxTokens
          try {
            const info = await this.ctx.llm.resolveModelInfo?.(provider.id, model.id)
            efforts = (info?.reasoning?.efforts ?? []).map(effort => ({
              id: effort.id,
              name: effort.name ?? effort.id,
              description: effort.description,
            }))
            defaultEffort = info?.reasoning?.defaultEffort
            // listModels 条目不含窗口/输出上限；resolveModelInfo 才是这两个字段的来源。
            contextWindow = info?.context?.contextWindow
            maxTokens = info?.defaultMaxTokens
          } catch {}
          value.push({
            ref: `${provider.id}/${model.id}`,
            provider: provider.id,
            providerName: provider.name ?? provider.id,
            model: model.id,
            name: model.name ?? model.id,
            contextWindow,
            maxTokens,
            efforts,
            defaultEffort,
          })
        }
      }
    } catch (error) {
      this.logger.warn?.('dsh-team: model catalog unavailable: %s', error)
    }
    this.modelsCache = { at: Date.now(), value }
    return value
  }

  async validateBotConfig({ provider, model, effort }) {
    if (!provider && !model) return
    if (!provider || !model) throw new AppError('INVALID_MODEL', '模型必须同时指定 provider 和 model')
    const entries = await this.catalog(true)
    if (entries.length === 0) return
    const entry = entries.find(item => item.provider === provider && item.model === model)
    if (!entry) throw new AppError('INVALID_MODEL', `DSH 未提供模型 ${provider}/${model}`)
    if (effort && !(entry.efforts ?? []).some(item => item.id === effort)) {
      const available = (entry.efforts ?? []).map(item => item.id).join(', ') || '无'
      throw new AppError('INVALID_EFFORT', `模型 ${entry.ref} 不支持强度 ${effort}；可用强度：${available}`)
    }
  }

  async selectModel(sessionId, bot) {
    if (!bot.provider || !bot.model) {
      throw new AppError('MODEL_REQUIRED', `Bot ${bot.name} 尚未配置模型`)
    }
    const efforts = EFFORT_FALLBACK(bot)
    const run = this.selecting.then(async () => {
      const defaults = this.ctx.get?.('agentDefaultModel')
      const before = defaults?.currentSelection?.()
      const result = await this.ctx.sessionController.selectModel({
        sessionId,
        provider: bot.provider,
        model: bot.model,
        ...(efforts ? { reasoningEffort: efforts } : {}),
      })
      const after = result?.selected ?? { provider: bot.provider, model: bot.model, ...(efforts ? { reasoningEffort: efforts } : {}) }
      if (before?.provider && before?.model
        && (before.provider !== after.provider || before.model !== after.model || before.reasoningEffort !== after.reasoningEffort)) {
        await defaults?.saveSelection?.(before).catch?.(error => this.logger.warn?.('dsh-team: restore default model failed: %s', error))
      }
      return result
    })
    this.selecting = run.catch(() => {})
    return run
  }

  async defaultAgentPreset(kind) {
    const wanted = kind === 'task'
      ? (this.config.workerPreset ?? '')
      : (this.config.routerPreset ?? '')
    try {
      const presets = this.ctx.get?.('agentPresets')
      if (!presets) return {}
      const list = await presets.list()
      const available = (list ?? []).filter(preset => preset.broken === undefined).map(preset => preset.id)
      // 只有确认存在的 preset 才会被选中；Router 缺省沿用 standard，避免装错配置直接起不来。
      const pick = [wanted, 'standard'].find(id => id && available.includes(id))
      return pick ? { agentPreset: pick } : {}
    } catch {
      return {}
    }
  }

  async ensureSession(bot, project, { run, task } = {}) {
    // 任务运行使用独立会话，与该项目负责人会话互不阻塞；其余运行共用项目会话。
    const kind = run?.kind === 'task' && task ? 'task' : 'project'
    const taskId = kind === 'task' ? task.id : null
    const existing = taskId
      ? this.store.get(
        "SELECT * FROM session_bindings WHERE bot_id = ? AND project_id = ? AND kind = 'task' AND task_id = ?",
        bot.id,
        project.id,
        taskId,
      )
      : this.store.get(
        "SELECT * FROM session_bindings WHERE bot_id = ? AND project_id = ? AND kind = 'project'",
        bot.id,
        project.id,
      )
    if (existing) {
      const resolved = await this.ctx.sessionController.resolveAgent(existing.session_id)
      if (!resolved?.error) {
        await this.selectModel(existing.session_id, bot)
        return existing.session_id
      }
      this.store.run('DELETE FROM session_bindings WHERE session_id = ?', existing.session_id)
    }
    const key = `${bot.id}:${project.id}:${kind}:${taskId ?? ''}`
    if (this.sessionCreates.has(key)) return this.sessionCreates.get(key)
    const creating = (async () => {
      const cwd = await ensureProjectWorkspace(this.config.workspace, project.slug)
      const created = await this.ctx.sessionController.create({
        cwd,
        ...(await this.defaultAgentPreset(kind)),
      })
      const sessionId = created.sessionId
      const agent = await this.ctx.sessionController.resolveAgent(sessionId)
      if (agent?.error) throw new AppError('SESSION_FAILED', `创建 DSH Session 失败：${agent.error.message ?? '未知错误'}`)
      if (this.ctx.sessionTitle?.rename) {
        const title = kind === 'task'
          ? `${bot.name} · ${project.key}-${task.number}`
          : `${bot.name} · ${project.name}`
        // rename 只接受活动 agent 的 session 对象；没有就不改标题，
        // 不再传 sessionId 字符串兜底（宿主会抛 "not live in this store"）。
        // rename 是同步接口（返回标题快照而非 Promise），失败不得阻断会话创建。
        const liveSession = agent?.agent?.session ?? agent?.session
        if (liveSession) {
          try { this.ctx.sessionTitle.rename(liveSession, title) } catch {}
        }
      }
      this.store.run(
        `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
        sessionId,
        bot.id,
        project.id,
        kind,
        taskId,
        new Date().toISOString(),
      )
      await this.selectModel(sessionId, bot)
      return sessionId
    })()
    this.sessionCreates.set(key, creating)
    try {
      return await creating
    } finally {
      this.sessionCreates.delete(key)
    }
  }

  promptFor({ run, bot, project, task, chatMessage }) {
    const header = [
      `Project: ${project.name} (${project.key})`,
      `Workspace: /workspace/${project.slug}`,
      `You are: ${bot.name}`,
    ].join('\n')
    const taskComments = task
      ? this.store.all(
        'SELECT id, author_type, author_id, body FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 5',
        task.id,
      ).reverse()
      : []
    const threads = taskComments.length === 0
      ? ''
      : `\nRecent task comments:\n${taskComments
        .map(item => `- [c_${item.id.slice(-6)}] ${item.author_type}:${item.author_id}: ${item.body.length > 800 ? `${item.body.slice(0, 800)}…` : item.body}`)
        .join('\n')}`
    if ((run.kind === 'review' || run.kind === 'handle') && task) {
      if (run.kind === 'review') {
        return `${header}

# Review delivery for task ${project.key}-${task.number}
Title: ${task.title}
Status: ${task.status}
Description:
${task.description || '(no description)'}${threads}

As the project owner, review the delivered result above against the task description. Check the delivery report claims when needed (files exist, tests pass). Then decide:
- If the work is acceptable, call team_review_task with decision "accept".
- If it needs rework, call team_review_task with decision "return" and a concrete rework reason in comment.
Do not redo the task yourself, and do not start parallel work here. Reply in the user's language with a short verdict.`
      }
      const failure = this.store.get(
        "SELECT error_code, error_message FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'failed' ORDER BY ended_at DESC LIMIT 1",
        task.id,
      )
      return `${header}

# Blocked task ${project.key}-${task.number} needs your handling
Title: ${task.title}
Status: ${task.status}
Description:
${task.description || '(no description)'}${threads}
Last failure: ${failure?.error_message ?? 'unknown'}

As the project owner, handle this blocked task:
- If it is worth retrying, call team_assign_task with task "${project.key}-${task.number}" and assignee (the same bot to retry, or a different bot).
- If it needs the user's decision (scope change, missing access, repeated failures), do not re-dispatch; reply in the group explaining what you need from the user.
Avoid re-dispatching more than once without progress. Reply in the user's language with a short verdict.`
    }
    if (task) {
      const parallel = this.config.agentTeam ? `

# Parallel work inside this task
- Split into teammates only when the task has two or more independent parts (separate modules, separate docs, an independent review). Small or single-file work: do it yourself.
- At most ${this.config.maxTeammates} teammates, lower-kebab-case names, each with a one-paragraph brief.
- Record every part on the shared task board with team_task_create and a disjoint write_scope. Never let two members edit the same path.
- Before delivering: list_agents, then wait_agent until nothing is running, then merge their results into your report.
- The checkout is shared and unlocked. If a teammate reports a conflicting edit, resolve it yourself instead of retrying blindly.` : ''
      return `${header}

# Assigned task ${project.key}-${task.number}
Title: ${task.title}
Priority: ${task.priority}
Status: ${task.status}
Description:
${task.description || '(no description)'}${threads}${parallel}

Do the task in the project workspace. Use tools as needed. End with a concise delivery report containing what changed, verification performed, and blockers or risks. Do not just describe what you would do.`
    }
    const recent = this.store.all(
      'SELECT id, sender_type, sender_id, body, task_id FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 12',
      project.id,
    ).reverse()
    const context = recent.map((item) => {
      const body = item.body.length > 240 ? `${item.body.slice(0, 240)}…` : item.body
      return `- [m_${item.id.slice(-6)}] ${item.sender_type}:${item.sender_id}${item.task_id ? ' (task thread)' : ''}: ${body}`
    }).join('\n')
    const openTasks = this.store.all(
      `SELECT number, title, status FROM tasks
       WHERE project_id = ? AND status NOT IN ('done', 'canceled')
       ORDER BY updated_at DESC LIMIT 10`,
      project.id,
    )
    const taskList = openTasks.length === 0
      ? 'none'
      : openTasks.map(item => `- ${project.key}-${item.number} [${item.status}] ${item.title}`).join('\n')
    return `${header}

# Group message
${(chatMessage?.body ?? '(no message)').slice(0, 4_000)}

Recent project messages (truncated, ids are for team_recall):
${context}

Open tasks:
${taskList}

Reply as ${bot.name} in the project group. Keep it under ${this.config.chatReplyMaxChars} characters unless the user asked for a full write-up. If the message requires another bot to do work, use team_assign_task instead of pretending to assign it. Use team_recall with a m_/c_/run id when you need the full text of a truncated item.`
  }

  async startRun({ run, bot, project, task, chatMessage }) {
    if (!this.ctx?.sessionController) throw new AppError('DSH_UNAVAILABLE', 'DSH Session 服务不可用')
    const sessionId = await this.ensureSession(bot, project, { run, task })
    const prompt = this.promptFor({ run, bot, project, task, chatMessage })
    const pending = {
      runId: run.id,
      sessionId,
      bot,
      projectId: project.id,
      started: false,
      texts: [],
      lastText: '',
      usageCounter: 0,
      tokens: 0,
      aborting: false,
      timeout: null,
    }
    this.pending.set(sessionId, pending)
    this.pendingByRun.set(run.id, pending)
    pending.timer = setTimeout(() => {
      void this.timeoutRun(run.id)
    }, this.config.runTimeoutMs)
    pending.timer.unref?.()
    const startedAt = new Date().toISOString()
    this.store.run(
      'UPDATE runs SET session_id = ?, started_at = ?, last_progress_at = ? WHERE id = ?',
      sessionId, startedAt, startedAt, run.id,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), run.id, 'started', `Session ${sessionId}`, new Date().toISOString(),
    )
    try {
      await this.ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, AbortSignal.timeout(30_000))
    } catch (error) {
      clearTimeout(pending.timer)
      this.pending.delete(sessionId)
      this.pendingByRun.delete(run.id)
      throw error
    }
    return sessionId
  }

  // teammate 子会话只贡献用量，不参与根运行的 turn 生命周期。
  ownerForChild(session) {
    const sessionId = session?.id
    if (!sessionId) return undefined
    const cachedRun = this.childOwner.get(sessionId)
    if (cachedRun) return this.pendingByRun.get(cachedRun)
    let cursor = sessionId
    const seen = new Set([sessionId])
    while (cursor) {
      const parentId = this.parentHints.get(cursor)
      if (!parentId || seen.has(parentId)) break
      seen.add(parentId)
      const root = this.pending.get(parentId)
      if (root) {
        this.childOwner.set(sessionId, root.runId)
        return root
      }
      cursor = parentId
    }
    // 兜底：只有一个运行在飞行中时，可确认是子代理来源的会话归给它。
    if (this.pending.size === 1 && isSubagentLike(session)) {
      const only = [...this.pending.values()][0]
      this.childOwner.set(sessionId, only.runId)
      return only
    }
    return undefined
  }

  noteParent(session) {
    const sessionId = session?.id
    if (!sessionId || this.parentHints.has(sessionId)) return
    const parentId = sessionParentId(session)
    if (parentId) this.parentHints.set(sessionId, parentId)
  }

  releaseAttribution(runId) {
    for (const [sessionId, ownerRunId] of this.childOwner) {
      if (ownerRunId !== runId) continue
      this.childOwner.delete(sessionId)
      this.parentHints.delete(sessionId)
    }
  }

  async recordUsageEvent(pending, event, sessionId) {
    const usage = event.data?.usage
    if (!usage) return
    pending.usageCounter += 1
    const occurredAt = Number.isFinite(event.time) ? new Date(event.time).toISOString() : nowIso()
    const sourceKey = `run:${pending.runId}:sess:${sessionId}:msg:${pending.turn ?? 0}:${pending.usageCounter}:${event.time ?? Date.now()}`
    const row = recordUsage(this.store, {
      sourceKey,
      run: { id: pending.runId, project_id: pending.projectId, bot_id: pending.bot.id },
      provider: pending.bot.provider ?? '',
      model: pending.bot.model ?? '',
      usage,
      occurredAt,
    })
    if (!row) return
    pending.tokens = (pending.tokens ?? 0)
      + row.input_tokens + row.cache_read_tokens + row.cache_write_tokens + row.output_tokens + row.reasoning_tokens
    const cap = this.config.maxRunTokens
    if (cap && pending.tokens > cap && !pending.aborting) {
      pending.aborting = true
      await this.abortRun(pending, {
        code: 'RUN_BUDGET_EXCEEDED',
        message: `运行累计 ${pending.tokens} token，超过单运行上限 ${cap}，已中止`,
      })
    }
  }

  async abortRun(pending, error) {
    clearTimeout(pending.timer)
    this.pending.delete(pending.sessionId)
    this.pendingByRun.delete(pending.runId)
    this.releaseAttribution(pending.runId)
    await this.cancelSession(pending.sessionId).catch(() => {})
    await this.completionHandler?.({
      runId: pending.runId,
      status: 'failed',
      output: pending.lastText ?? '',
      error,
    })
  }

  touchProgress(runId) {
    this.store.run('UPDATE runs SET last_progress_at = ? WHERE id = ?', nowIso(), runId)
  }

  async handleEvent(session, event) {
    const sessionId = session?.id
    if (!sessionId) return
    this.noteParent(session)
    const root = this.pending.get(sessionId)
    if (!root) {
      const owner = this.ownerForChild(session)
      if (!owner) return
      const type = event?.type
      if (type === 'assistant/message') {
        this.touchProgress(owner.runId)
        await this.recordUsageEvent(owner, event, sessionId)
      }
      return
    }
    if (event?.type === 'turn/start') {
      root.started = true
      root.turn = event.data?.turn
      return
    }
    if (event?.type === 'assistant/message') {
      if (!root.started) return
      const textValue = contentText(event.data?.message?.content)
      if (textValue.trim()) {
        root.lastText = textValue
        root.texts.push(textValue)
      }
      this.touchProgress(root.runId)
      await this.recordUsageEvent(root, event, sessionId)
      return
    }
    if (event?.type !== 'turn/end' || !root.started) return
    clearTimeout(root.timer)
    this.pending.delete(sessionId)
    this.pendingByRun.delete(root.runId)
    const reason = reasonOf(event)
    const failed = reason.kind === 'error' || reason.kind === 'aborted'
    const output = root.lastText || [...root.texts].reverse().find(value => value.trim()) || ''
    const error = failed
      ? {
          code: reason.kind === 'aborted' ? 'ABORTED' : (reason.error?.code ?? 'MODEL_ERROR'),
          message: reason.error?.message ?? (reason.kind === 'aborted' ? '运行被中止' : '模型调用失败'),
        }
      : null
    this.releaseAttribution(root.runId)
    await this.completionHandler?.({
      runId: root.runId,
      status: error ? 'failed' : 'succeeded',
      output,
      error,
    })
  }

  async timeoutRun(runId) {
    const pending = this.pendingByRun.get(runId)
    if (!pending) return
    await this.abortRun(pending, {
      code: 'RUN_TIMEOUT',
      message: `运行超过 ${Math.round(this.config.runTimeoutMs / 60000)} 分钟，已中止`,
    })
  }

  async cancelSession(sessionId) {
    if (!sessionId) return
    try {
      // 公开 Remote 契约：内部走 agent.cancel({kind:'user'},{keepInbox:true})，
      // 不再直持内部 agent 对象，也不会清空待处理收件箱。
      await this.ctx.sessionController.cancel({ sessionId })
    } catch (error) {
      this.logger.warn?.('dsh-team: cancel session %s failed: %s', sessionId, error)
    }
  }

  async cancelRun(runId) {
    const pending = this.pendingByRun.get(runId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pending.delete(pending.sessionId)
    this.pendingByRun.delete(runId)
    this.releaseAttribution(runId)
    await this.cancelSession(pending.sessionId)
    return true
  }

  // 向运行中的会话追加一条人类输入：优先中途 steer，失败则退回排队投递。
  async steer(sessionId, body) {
    if (!sessionId || !this.ctx?.sessionController) return false
    const content = [{ type: 'text', text: body }]
    try {
      // 公开 Remote 契约：宿主内部会构造完整用户消息（id/role/source）再 agent.steer，
      // 避免裸 content 在并发投递时撞 message.id 去重键。
      await this.ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'steer',
        content,
      }, AbortSignal.timeout(30_000))
      return true
    } catch (error) {
      this.logger.warn?.('dsh-team: steer session %s failed, falling back to queue: %s', sessionId, error)
    }
    await this.ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content,
    }, AbortSignal.timeout(30_000))
    return true
  }

  runPending(runId) {
    return this.pendingByRun.has(runId)
  }

  capabilityInfo() {
    let tools = []
    try {
      tools = (this.ctx.tools?.schemas?.() ?? []).map(schema => schema.name).filter(Boolean)
    } catch {
      tools = []
    }
    return {
      native: true,
      profile: process.env.DSH_PROFILE || 'team-bots',
      version: process.env.DSH_RUNTIME_VERSION || 'unknown',
      toolCount: tools.length,
      toolNames: tools,
      modelProviderCount: new Set((this.modelsCache.value ?? []).map(item => item.provider)).size,
    }
  }
}
