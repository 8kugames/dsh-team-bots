import { randomUUID } from 'node:crypto'
import { AppError } from './errors.js'
import { ensureProjectWorkspace } from './paths.js'
import { recordUsage } from './usage.js'
import { id } from './util.js'

const EFFORT_FALLBACK = (bot) => bot.effort || undefined

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
    const memoryText = memories.length === 0
      ? 'No saved memories yet.'
      : memories.map(item => `- ${item.topic}: ${item.content}`).join('\n')
    const teamRules = [
      '## How this team works',
      '- You are a long-lived teammate. Your replies in the project group are visible to the user and other bots.',
      '- The shared skill library is mounted at `/workspace/.agents/skills`; use installed skills when relevant.',
      '- Work only inside this project workspace unless the user explicitly authorizes another mounted path.',
      '- Use `team_assign_task` to hand concrete work to another project bot, or to re-dispatch a blocked task by its KEY-N number. Do not claim work is assigned unless the tool succeeds.',
      '- Tasks you dispatch are reviewed by you: when a delivery arrives, `team_review_task` accepts it or returns it with a rework reason.',
      '- Use `team_remember` for durable facts, preferences, decisions or lessons worth keeping. Never store secrets or credentials.',
      '- Use `team_propose_evolution` to suggest a durable instruction or skill change. You cannot approve your own proposal.',
      '- When executing a task, do the work, verify it, then return a concise result with changed paths and any risks.',
      '- Never invent file changes or tool results. Report blockers precisely.',
      '- Reply in the user’s language.',
    ].join('\n')
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
      `- You are ${owner ? 'the owner of this project group. Triage requests, split work and assign tasks; review deliveries with team_review_task and handle blocked tasks yourself instead of waiting for the user.' : 'a project member. Focus on work assigned to you.'}`,
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
          try {
            const info = await this.ctx.llm.resolveModelInfo?.(provider.id, model.id)
            efforts = (info?.reasoning?.efforts ?? []).map(effort => ({
              id: effort.id,
              name: effort.name ?? effort.id,
              description: effort.description,
            }))
            defaultEffort = info?.reasoning?.defaultEffort
          } catch {}
          value.push({
            ref: `${provider.id}/${model.id}`,
            provider: provider.id,
            providerName: provider.name ?? provider.id,
            model: model.id,
            name: model.name ?? model.id,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
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

  async ensureSession(bot, project) {
    const existing = this.store.get(
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
    const key = `${bot.id}:${project.id}`
    if (this.sessionCreates.has(key)) return this.sessionCreates.get(key)
    const creating = (async () => {
      const cwd = await ensureProjectWorkspace(this.config.workspace, project.slug)
      const created = await this.ctx.sessionController.create({ cwd })
      const sessionId = created.sessionId
      const agent = await this.ctx.sessionController.resolveAgent(sessionId)
      if (agent?.error) throw new AppError('SESSION_FAILED', `创建 DSH Session 失败：${agent.error.message ?? '未知错误'}`)
      if (this.ctx.sessionTitle?.rename) {
        await this.ctx.sessionTitle.rename(agent.agent?.session ?? agent.session ?? sessionId, `${bot.name} · ${project.name}`).catch(() => {})
      }
      this.store.run(
        `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at)
         VALUES (?, ?, ?, 'project', ?)
         ON CONFLICT(session_id) DO NOTHING`,
        sessionId,
        bot.id,
        project.id,
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
    if ((run.kind === 'review' || run.kind === 'handle') && task) {
      const comments = this.store.all(
        'SELECT author_type, author_id, body FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 5',
        task.id,
      ).reverse()
      const threads = comments.length === 0 ? '' : `\nRecent task comments:\n${comments.map(item => `- ${item.author_type}:${item.author_id}: ${item.body.slice(0, 1000)}`).join('\n')}`
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
Do not redo the task yourself. Reply concisely in the user's language explaining your decision.`
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
Avoid re-dispatching more than once without progress. Reply concisely in the user's language.`
    }
    if (task) {
      const comments = this.store.all(
        'SELECT author_type, author_id, body FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 5',
        task.id,
      ).reverse()
      const threads = comments.length === 0 ? '' : `\nRecent task comments:\n${comments.map(item => `- ${item.author_type}:${item.author_id}: ${item.body.slice(0, 1000)}`).join('\n')}`
      return `${header}

# Assigned task ${project.key}-${task.number}
Title: ${task.title}
Priority: ${task.priority}
Status: ${task.status}
Description:
${task.description || '(no description)'}${threads}

Do the task in the project workspace. Use tools as needed. End with a concise delivery report containing what changed, verification performed, and blockers or risks. Do not just describe what you would do.`
    }
    const recent = this.store.all(
      'SELECT sender_type, sender_id, body FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 9',
      project.id,
    ).reverse()
    const context = recent.map(item => `- ${item.sender_type}:${item.sender_id}: ${item.body.slice(0, 1200)}`).join('\n')
    return `${header}

# Group message
${chatMessage?.body || '(no message)'}

Recent project messages:
${context}

Reply as ${bot.name} in the project group. Be concise and concrete. If the message requires another bot to do work, use team_assign_task instead of pretending to assign it.`
  }

  async startRun({ run, bot, project, task, chatMessage }) {
    if (!this.ctx?.sessionController) throw new AppError('DSH_UNAVAILABLE', 'DSH Session 服务不可用')
    const sessionId = await this.ensureSession(bot, project)
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
      timeout: null,
    }
    this.pending.set(sessionId, pending)
    this.pendingByRun.set(run.id, pending)
    pending.timer = setTimeout(() => {
      void this.timeoutRun(run.id)
    }, this.config.runTimeoutMs)
    pending.timer.unref?.()
    this.store.run('UPDATE runs SET session_id = ?, started_at = ? WHERE id = ?', sessionId, new Date().toISOString(), run.id)
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

  async handleEvent(session, event) {
    const sessionId = session?.id
    if (!sessionId) return
    const pending = this.pending.get(sessionId)
    if (!pending) return
    if (event?.type === 'turn/start') {
      pending.started = true
      pending.turn = event.data?.turn
      return
    }
    if (event?.type === 'assistant/message') {
      if (!pending.started) return
      const textValue = contentText(event.data?.message?.content)
      if (textValue.trim()) {
        pending.lastText = textValue
        pending.texts.push(textValue)
      }
      const usage = event.data?.usage
      if (usage) {
        pending.usageCounter += 1
        const occurredAt = Number.isFinite(event.time) ? new Date(event.time).toISOString() : new Date().toISOString()
        const sourceKey = `run:${pending.runId}:msg:${pending.turn ?? 0}:${pending.usageCounter}:${event.time ?? Date.now()}`
        recordUsage(this.store, {
          sourceKey,
          run: { id: pending.runId, project_id: pending.projectId, bot_id: pending.bot.id },
          provider: pending.bot.provider ?? '',
          model: pending.bot.model ?? '',
          usage,
          occurredAt,
        })
      }
      return
    }
    if (event?.type !== 'turn/end' || !pending.started) return
    clearTimeout(pending.timer)
    this.pending.delete(sessionId)
    this.pendingByRun.delete(pending.runId)
    const reason = reasonOf(event)
    const failed = reason.kind === 'error' || reason.kind === 'aborted'
    const output = pending.lastText || [...pending.texts].reverse().find(value => value.trim()) || ''
    const error = failed
      ? {
          code: reason.kind === 'aborted' ? 'ABORTED' : (reason.error?.code ?? 'MODEL_ERROR'),
          message: reason.error?.message ?? (reason.kind === 'aborted' ? '运行被中止' : '模型调用失败'),
        }
      : null
    await this.completionHandler?.({
      runId: pending.runId,
      status: error ? 'failed' : 'succeeded',
      output,
      error,
    })
  }

  async timeoutRun(runId) {
    const pending = this.pendingByRun.get(runId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(pending.sessionId)
    this.pendingByRun.delete(runId)
    await this.cancelSession(pending.sessionId).catch(() => {})
    await this.completionHandler?.({
      runId,
      status: 'failed',
      output: pending.lastText ?? '',
      error: { code: 'RUN_TIMEOUT', message: `运行超过 ${Math.round(this.config.runTimeoutMs / 60000)} 分钟，已中止` },
    })
  }

  async cancelSession(sessionId) {
    if (!sessionId) return
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      if (!resolved?.error) resolved.agent?.cancel?.({ kind: 'user', reason: 'dsh-team/cancelled' })
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
    await this.cancelSession(pending.sessionId)
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
      profile: process.env.DSH_PROFILE || 'bots',
      version: process.env.DSH_RUNTIME_VERSION || 'unknown',
      toolCount: tools.length,
      toolNames: tools,
      modelProviderCount: new Set((this.modelsCache.value ?? []).map(item => item.provider)).size,
    }
  }
}
