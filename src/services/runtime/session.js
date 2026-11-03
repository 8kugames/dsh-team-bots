// src/services/runtime/session.js —— 会话派发域
// 模型目录、模型选择、子会话派发与运行启动。
// 本文件只放方法体，方法挂到 DshRuntime 原型上（见 src/runtime.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { randomUUID } from 'node:crypto'
import { AppError } from '../../errors.js'
import { id } from '../../util.js'
import { attachSessionToWorkspace, resolveSessionCwd, workspaceGroupTitle } from '../workspace-groups.js'
import { effectiveRunLimits } from '../../config.js'
import { imageContentPartsForMessage } from '../message-images.js'

export const EFFORT_FALLBACK = (bot) => bot.effort || undefined

// 备用模型覆盖：派生运行在 runs 行里带 model_* 三列，指明这条运行改用备用模型下发。
// 没有这三列的运行照旧走 Bot 主模型——「运行结束自动回退」就靠这条默认路径实现。
export const modelOverrideFor = (run) => (run?.model_provider && run?.model_model
  ? { provider: run.model_provider, model: run.model_model, effort: run.model_effort || undefined }
  : null)

export const sessionMethods = {
  bindingOfSession(sessionId) {
    if (!sessionId) return undefined
    return this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
  },
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
  },
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
  },
  // override 用于备用模型：指定了就用备用的 provider/model/effort，否则用 Bot 的主模型。
  // 备用模型自带 effort，不继承主模型的推理强度（不同模型支持的强度不一致）。
  async selectModel(sessionId, bot, override = null) {
    const provider = override?.provider ?? bot.provider
    const model = override?.model ?? bot.model
    if (!provider || !model) {
      throw new AppError('MODEL_REQUIRED', `Bot ${bot.name} 尚未配置模型`)
    }
    const efforts = override ? (override.effort || undefined) : EFFORT_FALLBACK(bot)
    const run = this.selecting.then(async () => {
      const defaults = this.ctx.get?.('agentDefaultModel')
      const before = defaults?.currentSelection?.()
      const result = await this.ctx.sessionController.selectModel({
        sessionId,
        provider,
        model,
        ...(efforts ? { reasoningEffort: efforts } : {}),
      })
      const after = result?.selected ?? { provider, model, ...(efforts ? { reasoningEffort: efforts } : {}) }
      if (before?.provider && before?.model
        && (before.provider !== after.provider || before.model !== after.model || before.reasoningEffort !== after.reasoningEffort)) {
        await defaults?.saveSelection?.(before).catch?.(error => this.logger.warn?.('dsh-team: restore default model failed: %s', error))
      }
      return result
    })
    this.selecting = run.catch(() => {})
    return run
  },
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
  },
  async ensureSession(bot, project, { run, task, sessionKind, modelOverride } = {}) {
    // 任务运行使用独立会话，与该项目总监会话互不阻塞；dm 运行用独立私信会话；
    // 单聊运行（solo_chat）没有项目，落在 bot 自己的 _the_bots/<dir> 专属会话；其余运行共用项目会话。
    // sessionKind 由调用方显式指定（dm_reply 投递回任务会话等跨类别场景）。
    const kind0 = sessionKind
      ?? (run?.kind === 'task' && task ? 'task' : run?.kind === 'dm' ? 'dm' : run?.kind === 'solo_chat' ? 'solo' : 'project')
    // 任务会话的兜底：任务行已被删除时退回项目会话，
    // 避免 task.id 空引用把整条运行链路炸掉。
    const kind = kind0 === 'task' && !task ? 'project' : kind0
    const taskId = kind === 'task' ? task.id : null
    const solo = kind === 'solo'
    const existing = taskId
      ? this.store.get(
        "SELECT * FROM session_bindings WHERE bot_id = ? AND project_id = ? AND kind = 'task' AND task_id = ?",
        bot.id,
        project.id,
        taskId,
      )
      : solo
        ? this.store.get(
          "SELECT * FROM session_bindings WHERE bot_id = ? AND kind = 'solo' AND project_id IS NULL AND task_id IS NULL",
          bot.id,
        )
        : this.store.get(
          'SELECT * FROM session_bindings WHERE bot_id = ? AND project_id = ? AND kind = ?',
          bot.id,
          project.id,
          kind,
        )
    if (existing) {
      const resolved = await this.ctx.sessionController.resolveAgent(existing.session_id)
      if (!resolved?.error) {
        this.applyFilePolicy(resolved, bot, run)
        await this.selectModel(existing.session_id, bot, modelOverride)
        return existing.session_id
      }
      this.store.run('DELETE FROM session_bindings WHERE session_id = ?', existing.session_id)
    }
    const key = `${bot.id}:${solo ? 'solo' : project.id}:${kind}:${taskId ?? ''}`
    if (this.sessionCreates.has(key)) return this.sessionCreates.get(key)
    const creating = (async () => {
      const cwd = await resolveSessionCwd(this.config, { solo, bot, project })
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
          : kind === 'dm'
            ? `${bot.name} · ${project.name} · DM`
            : solo
              ? `${bot.name} · 单聊`
              : `${bot.name} · ${project.name}`
        // rename 只接受活动 agent 的 session 对象；没有就不改标题，
        // 不再传 sessionId 字符串兜底（宿主会抛 "not live in this store"）。
        // rename 是同步接口（返回标题快照而非 Promise），失败不得阻断会话创建。
        const liveSession = agent?.agent?.session ?? agent?.session
        if (liveSession) {
          try { this.ctx.sessionTitle.rename(liveSession, title) } catch {}
        }
      }
      this.applyFilePolicy(agent, bot, run)
      this.store.run(
        `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
        sessionId,
        bot.id,
        solo ? null : project.id,
        kind,
        taskId,
        new Date().toISOString(),
      )
      await this.selectModel(sessionId, bot, modelOverride)
      // 挂到 DSH 原生工作区分组（可选增强）：registry 经 ctx.get 读取，宿主未装就整体跳过；
      // 挂载失败只在 workspace-groups 内 warn，绝不影响会话返回与运行。
      const registry = this.ctx.get?.('workspaceRegistry')
      if (registry) {
        await attachSessionToWorkspace(registry, {
          cwd,
          title: workspaceGroupTitle({ kind, project, bot }),
          sessionId,
        }, this.logger)
      }
      return sessionId
    })()
    this.sessionCreates.set(key, creating)
    try {
      return await creating
    } finally {
      this.sessionCreates.delete(key)
    }
  },
  async startRun({ run, bot, project, task, chatMessage, sessionKind }) {
    if (!this.ctx?.sessionController) throw new AppError('DSH_UNAVAILABLE', 'DSH Session 服务不可用')
    // 备用模型覆盖：派生运行在 runs 行里带 model_* 三列，指明这条运行改用备用模型下发。
    // 不带 override 的运行照旧走 Bot 主模型——「运行结束自动回退」就靠这条默认路径实现。
    const modelOverride = modelOverrideFor(run)
    // 用量记账要记实际下发的模型，备用运行不能记到主模型头上。
    const effectiveBot = modelOverride
      ? { ...bot, provider: modelOverride.provider, model: modelOverride.model, effort: modelOverride.effort ?? null }
      : bot
    const sessionId = await this.ensureSession(bot, project, { run, task, sessionKind, modelOverride })
    let prompt = this.promptFor({ run, bot, project, task, chatMessage, sessionId })
    const pending = {
      runId: run.id,
      sessionId,
      bot: effectiveBot,
      projectId: project?.id ?? null,
      started: false,
      texts: [],
      lastText: '',
      usageCounter: 0,
      tokens: 0,
      aborting: false,
      timeout: null,
      // 轨迹记账：工具名按 callId 配对，recordedCalls 防止 tool/call 事件与
      // assistant/message 里的 tool-call 块重复入库。
      toolNames: new Map(),
      recordedCalls: new Set(),
      trajectorySeq: 0,
      trajectoryCount: 0,
    }
    this.pending.set(sessionId, pending)
    this.pendingByRun.set(run.id, pending)
    // 运行时效在启动瞬间定格：之后页面改值只影响后续启动的运行，进行中不追溯。
    pending.runTimeoutMs = effectiveRunLimits(this.config, key => this.store.setting(key)).runTimeoutMs
    pending.timer = setTimeout(() => {
      void this.timeoutRun(run.id)
    }, pending.runTimeoutMs)
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
      // 聊天附图：首条 prompt 一并带上 image 分片，模型这轮就能看到用户发的图。
      // 宿主会把不能吃图片的模型降级成占位文本，插件不判模型能力。
      const imageParts = chatMessage?.id ? imageContentPartsForMessage(this.store, chatMessage.id) : []
      await this.ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }, ...imageParts],
      }, AbortSignal.timeout(30_000))
    } catch (error) {
      clearTimeout(pending.timer)
      this.pending.delete(sessionId)
      this.pendingByRun.delete(run.id)
      throw error
    }
    return sessionId
  },
}
