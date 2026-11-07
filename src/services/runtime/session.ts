// src/services/runtime/session.js —— 会话派发域
// 模型目录、模型选择、子会话派发与运行启动。
// 本文件只放方法体，方法挂到 DshRuntime 原型上（见 src/runtime.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { randomUUID } from 'node:crypto'
import { AppError } from '../../errors.js'
import { id } from '../../util.js'
import { attachSessionToWorkspace, resolveSessionCwd, workspaceGroupTitle } from '../workspace-groups.js'
import { effectiveRunLimits, effectiveSessionCompactTurns, effectiveSessionRolloverTurns, rolloverPendingKey, rolloverSummaryKey, sessionCompactMarkerKey } from '../../config.js'
import { imageContentPartsForMessage } from '../message-images.js'
import { restoreDefaultModel } from './model-restore.js'
import { applyBotToolPolicy } from '../../tools.js'

export const EFFORT_FALLBACK = (bot) => bot.effort || undefined

// 备用模型覆盖：派生运行在 runs 行里带 model_* 三列，指明这条运行改用备用模型下发。
// 没有这三列的运行照旧走 Bot 主模型——「运行结束自动回退」就靠这条默认路径实现。
export const modelOverrideFor = (run) => (run?.model_provider && run?.model_model
  ? { provider: run.model_provider, model: run.model_model, effort: run.model_effort || undefined }
  : null)

// 运行时效上限（DSHBOTS-131）：任务派生运行（runs.task_id 非空）若任务声明了时效要求，
// 其超时上限取 min(全局 runTimeoutMs, 时效分钟数)；无时效、非任务运行沿用全局值。
// DSHBOTS-302 预算分档：review/handle（owner_task 运行族）在全局上限内再收紧到 review
// 分档——director 单车道（one_active_run_per_bot）上验收长尾会堵住同 bot 的 chat 消息
// 运行，验收类运行不需要全局跑满；chat/dm/solo 沿用全局，task 时效取 min 逻辑不变。
export const runTimeoutMsForTaskRun = ({ run, task, globalRunTimeoutMs, reviewTimeoutMs = null }) => {
  if ((run?.kind === 'review' || run?.kind === 'handle') && Number(reviewTimeoutMs) > 0) {
    return Math.min(globalRunTimeoutMs, reviewTimeoutMs)
  }
  const minutes = Number(task?.timeBudgetMinutes ?? task?.time_budget_minutes)
  if (!run?.task_id || !Number.isFinite(minutes) || minutes <= 0) return globalRunTimeoutMs
  return Math.min(globalRunTimeoutMs, minutes * 60_000)
}

// review 分档分钟（DSHBOTS-302）：env 显式 > settings 保存整数（[3,60]）> 默认 10，
// 与 effectiveRunLimits 同款生效链；env 值同样钳到范围，防误配。消费点在 startRun
// 启动瞬间参与定格，改值只影响之后启动的运行，进行中不追溯。
export const REVIEW_TIMEOUT_KEY = 'review_timeout_minutes'
export const REVIEW_TIMEOUT_MINUTES_DEFAULT = 10
export const REVIEW_TIMEOUT_MINUTES_RANGE = [3, 60]

export function effectiveReviewTimeoutMinutes(getSetting: (key: string) => unknown = () => null) {
  const env = process.env.DSH_TEAM_REVIEW_TIMEOUT_MINUTES
  if (env !== undefined && String(env).trim() !== '') {
    const envMinutes = Number(env)
    if (Number.isFinite(envMinutes) && envMinutes > 0) {
      const [min, max] = REVIEW_TIMEOUT_MINUTES_RANGE
      return Math.min(max, Math.max(min, Math.round(envMinutes)))
    }
  }
  const [min, max] = REVIEW_TIMEOUT_MINUTES_RANGE
  const raw = String(getSetting?.(REVIEW_TIMEOUT_KEY) ?? '')
  const saved = Number(raw)
  if (raw !== '' && Number.isInteger(saved) && saved >= min && saved <= max) return saved
  return REVIEW_TIMEOUT_MINUTES_DEFAULT
}

export const sessionMethods = {
  bindingOfSession(sessionId) {
    if (!sessionId) return undefined
    return this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
  },
  // 会话绑定退役（DSHBOTS-256）：旧绑定不删，降级为 alias=1 授权别名。
  // 结转（DSHBOTS-145）或宿主失效替换后，仍以旧 session id 运行的宿主 agent
  // 调用 team_* 工具时，ownerContextFor/memberContextFor 仍按同 bot/项目解析到授权；
  // 别名行不参与活跃绑定唯一约束，新会话绑定照常建立。
  retireBinding(sessionId) {
    if (!sessionId) return
    this.store.run('UPDATE session_bindings SET alias = 1 WHERE session_id = ? AND alias = 0', sessionId)
  },
  async catalog(force = false) {
    const age = Date.now() - this.modelsCache.at
    if (!force) {
      if (age < this.config.modelCacheMs) return this.modelsCache.value
      // stale-while-revalidate：目录已过期但仍在 stale 窗口内时，先用旧值应答、后台刷新。
      // 否则每次 state() 轮询撞上过期都会去逐 provider 串行 listModels（真实网络调用），
      // 那是点击路径上秒级波动的主因。
      const staleMs = this.config.catalogStaleMs
      if (staleMs > 0 && age < this.config.modelCacheMs + staleMs) {
        void this.refreshCatalog()
        return this.modelsCache.value
      }
    }
    return this.refreshCatalog()
  },
  async refreshCatalog() {
    // 并发去重：多个 state() 同时撞上过期时只跑一次刷新。
    if (this.modelsRefreshing) return this.modelsRefreshing
    this.modelsRefreshing = (async () => {
      const value = []
      let okProviders = 0
      try {
        const providers = this.ctx.llm?.listProviders?.() ?? []
        for (const provider of providers) {
          let models = []
          try {
            models = await this.ctx.llm.listModels(provider.id)
            okProviders += 1
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
      // 刷新失败（或全部 provider 都没取到）时保留旧目录：一次网络抖动就把模型列表清成 []
      // 会让整页模型选择器空掉。
      const failed = okProviders === 0
      if (failed && this.modelsCache.value.length > 0) {
        this.logger.warn?.('dsh-team: model catalog refresh failed, keeping the previous list')
      } else {
        this.modelsCache = { at: Date.now(), value }
      }
      this.modelsRefreshing = null
      return this.modelsCache.value
    })()
    return this.modelsRefreshing
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
        // 恢复动作必须在事务之外的干净上下文执行，否则 configEditor.edit 里的
        // hmr.runExclusive 会以「嵌套事务」直接 reject。restoreDefaultModel 用宿主
        // HMR 服务的 executing.exit 逃逸出事务上下文；失败由它有界重试并落审计
        // model_restore_failed，不再只 warn 吞掉。
        await restoreDefaultModel(defaults, before, {
          logger: this.logger,
          hmr: this.ctx.get?.('hmr'),
          audit: (error, meta = {} as any) => this.store?.audit?.(
            'system',
            'system',
            'model_restore_failed',
            'session',
            sessionId,
            {
              provider: before.provider,
              model: before.model,
              ...(before.reasoningEffort === undefined ? {} : { reasoningEffort: before.reasoningEffort }),
              error: error instanceof Error ? error.message : String(error),
              ...(meta.escape ? { escape: meta.escape } : {}),
              ...(meta.timedOut ? { timedOut: true } : {}),
              ...(meta.budgetExhausted ? { budgetExhausted: true } : {}),
              ...(meta.cause ? { cause: meta.cause } : {}),
            },
          ),
        })
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
  // 结转判定（DSHBOTS-145 / DSHBOTS-286）：旧会话是否该让位。返回 true 表示旧绑定已
  // alias 化、调用方走新建路径；false 表示继续复用旧会话。
  // - 阈值 0 = 关闭（配置见 config.js 的 sessionRolloverTurns，默认 512）；
  // - 「轮次」口径 = runs 表按 session_id 的 COUNT(*)，不限 status——失败运行的提示词同样
  //   已进会话历史，count-all 才与真实增长一致；
  // - 幂等（DSHBOTS-286）：alias 行永不触发结转——本判定只在活跃绑定上被调用
  //   （唯一调用点 ensureSession 以 !existing.alias 前置短路保证）；已结转的旧会话
  //   即使轮数继续增长（承接未终态任务流量），也只参与闲时压缩，不再二次结转；
  // - 摘要就绪（settings 有值）→ 立即结转；
  // - 摘要未就绪 → 幂等补排一条摘要运行（不阻塞对话，摘要就绪后下一次复用自然结转）。
  shouldRolloverSession({ bot, project, existing }) {
    const turns = effectiveSessionRolloverTurns(this.config, key => this.store.setting(key))
    if (turns <= 0) return false
    const count = this.store.get('SELECT COUNT(*) AS n FROM runs WHERE session_id = ?', existing.session_id)?.n ?? 0
    if (count < turns) return false
    if (this.store.setting(rolloverSummaryKey(bot.id, project?.id))) return true
    const active = this.store.get(
      "SELECT id FROM runs WHERE kind = 'rollover_summary' AND trigger_ref = ? AND status IN ('queued', 'running')",
      existing.session_id,
    )
    if (!active) this.enqueueRolloverSummary({ bot, project, sessionId: existing.session_id })
    return false
  },
  // 补排结转摘要运行（DSHBOTS-145）：只读运行，复用旧会话（runs.session_id 指明），
  // 让 bot 在旧上下文里自写交接摘要（进行中任务 / 关键决定 / 未决问题）。
  // 幂等双保险：调用前查 trigger_ref 上的 active 运行；INSERT OR IGNORE 兜住同一
  // idempotency_key 的并发插入，避免唯一约束抛错把当前这条对话运行带崩。
  enqueueRolloverSummary({ bot, project, sessionId }) {
    const runId = id('run')
    const queuedAt = new Date().toISOString()
    const inserted = this.store.run(
      `INSERT OR IGNORE INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, session_id, queued_at)
       VALUES (?, ?, ?, 'rollover_summary', 'read', 'rollover_summary', ?, 'queued', 1, ?, ?, ?)`,
      runId,
      project?.id ?? null,
      bot.id,
      sessionId,
      `rollover_summary:${sessionId}`,
      sessionId,
      queuedAt,
    )
    if (!inserted.changes) return runId
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'),
      runId,
      'queued',
      '会话达到轮次阈值，排队生成交接摘要',
      queuedAt,
    )
    return runId
  },
  // 任务亲和绑定解析（DSHBOTS-286，ADR「结转后的任务亲和路由」）：按 task_id 从 runs 表
  // 显式解析其原会话——结转只把绑定行 alias 化，runs.task_id→session_id 的历史归属不动。
  // 未终态任务的后续消息据此回到原会话（即使该绑定已是 alias 行，如结转后的旧控制面会话）；
  // 新任务（无 runs 归属）与终态任务不享亲和，落活跃绑定/新建路径。
  // 与 D-285 单绑定模型共存：kind='bot' 唯一活跃绑定只决定「新流量」的家，任务亲和优先于它。
  taskAffinityBinding(task) {
    if (!task?.id) return undefined
    // 终态任务的会话不再需要亲和：done/canceled 与调度器候选过滤同口径。
    if (task.status === 'done' || task.status === 'canceled') return undefined
    const row = this.store.get(
      `SELECT session_id AS sid FROM runs
        WHERE task_id = ? AND session_id IS NOT NULL
        ORDER BY COALESCE(started_at, queued_at) DESC, rowid DESC LIMIT 1`,
      task.id,
    )
    if (!row?.sid) return undefined
    return this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', row.sid)
  },
  // 入队闲时总结压缩运行（DSHBOTS-286）：复用旧会话（runs.session_id 指明）的只读运行，
  // 让 bot 在原上下文里自写连续性总结。压缩 ≠ 结转：不 alias 化绑定、不写 rollover_pending，
  // 总结完成后留原会话。幂等键带窗口号：同窗口并发/重复触发由唯一约束兜住。
  enqueueSessionCompact({ bot, project, sessionId, window }) {
    const runId = id('run')
    const queuedAt = new Date().toISOString()
    const inserted = this.store.run(
      `INSERT OR IGNORE INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, session_id, queued_at)
       VALUES (?, ?, ?, 'session_compact', 'read', 'session_compact', ?, 'queued', 1, ?, ?, ?)`,
      runId,
      project?.id ?? null,
      bot.id,
      sessionId,
      `session_compact:${sessionId}:${window}`,
      sessionId,
      queuedAt,
    )
    if (!inserted.changes) return runId
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'),
      runId,
      'queued',
      `会话轮次跨过 ${window * effectiveSessionCompactTurns(this.config, key => this.store.setting(key))} 边界，闲时排队总结压缩`,
      queuedAt,
    )
    return runId
  },
  // 闲时压缩判定（DSHBOTS-286）：会话复用时检查轮次是否跨过新的压缩窗口。
  // - 窗口 N 轮（session_compact_turns，0 = 关闭），轮次口径与结转一致；
  // - 闲 = 该会话除当前运行外无 queued/running 运行；忙时推后（标记不动，下次复用再判，
  //   跨多个窗口合批为一次）；
  // - 对仍在承接流量的会话生效：含 alias 旧会话（未终态任务流量）与 task/dm 短生命周期会话。
  maybeCompactSession({ bot, project, existing, currentRunId }) {
    const every = effectiveSessionCompactTurns(this.config, key => this.store.setting(key))
    if (every <= 0 || !existing?.session_id) return
    const sessionId = existing.session_id
    const turns = this.store.get('SELECT COUNT(*) AS n FROM runs WHERE session_id = ?', sessionId)?.n ?? 0
    const marker = Number(this.store.setting(sessionCompactMarkerKey(sessionId)) ?? 0)
    const window = Math.floor(turns / every)
    if (window <= Math.floor(marker / every)) return
    const busy = this.store.get(
      "SELECT id FROM runs WHERE session_id = ? AND status IN ('queued', 'running') AND id != ?",
      sessionId,
      currentRunId ?? '',
    )
    if (busy) return
    this.enqueueSessionCompact({ bot, project, sessionId, window })
    // 标记推进到窗口下界：即使压缩运行后续失败也不回退，失败留痕由下一窗口再补。
    this.store.setSetting(sessionCompactMarkerKey(sessionId), String(window * every))
  },
  async ensureSession(bot, project, { run, task, modelOverride } = {} as any) {
    // DSHBOTS-238：成员 bot 工具层兜底——隐藏总监专权工具（子代理生成工具由 preset 全局
    // 注册，成员默认可见）。仅作用于项目绑定会话；solo 无项目上下文，本策略自然不触发。
    const isOwner = Boolean(project && bot && project.owner_bot_id === bot.id)
    // 结转摘要运行（DSHBOTS-145）与闲时压缩运行（DSHBOTS-286）：必须回到原会话执行，
    // 且不能参与阈值判定——否则这两类运行自己又会触发结转/压缩；solo 摘要运行也没有
    // 项目上下文，不查项目。
    if ((run?.kind === 'rollover_summary' || run?.kind === 'session_compact') && run.session_id) {
      const resolved = await this.ctx.sessionController.resolveAgent(run.session_id)
      if (!resolved?.error) {
        this.applyFilePolicy(resolved, bot, run, task)
        applyBotToolPolicy(resolved, { isOwner, logger: this.logger })
        await this.selectModel(run.session_id, bot, modelOverride)
        return run.session_id
      }
      this.retireBinding(run.session_id)
    }
    // ② 任务亲和（DSHBOTS-286/289，ADR §5.2-3）：未终态任务按 runs 归属回原会话——含
    // dm_reply 经 sessionTaskFor 解析出的任务（executeRun 已把任务行透传进来）与结转后
    // alias 行上的旧任务流量；终态任务不享亲和，落下方控制面单绑定。
    const affinity = this.taskAffinityBinding(task)
    if (affinity) {
      const resolved = await this.ctx.sessionController.resolveAgent(affinity.session_id)
      if (!resolved?.error) {
        this.applyFilePolicy(resolved, bot, run, task)
        applyBotToolPolicy(resolved, { isOwner, logger: this.logger })
        await this.selectModel(affinity.session_id, bot, modelOverride)
        // 任务会话同样在承接流量：跨过压缩窗口且闲时排队总结压缩
        // （结转仍豁免——任务会话生命周期短，DSHBOTS-286 口径不变）。
        this.maybeCompactSession({ bot, project, existing: affinity, currentRunId: run?.id })
        return affinity.session_id
      }
      this.retireBinding(affinity.session_id)
    }
    // ③ 控制面会话收敛（DSHBOTS-289/299，ADR §5.2-3）：其余运行（chat/dm/dm_reply/
    // review/handle/vision 及无任务上下文的派生运行）一律落该 bot 在所属域的 kind='bot'
    // 控制面会话——项目运行落 (bot, project) 绑定（每项目每 bot 一条，DSHBOTS-299 三分域），
    // solo_chat/项目外流量落 (bot, NULL) 绑定即该 bot 专属工作区 solo 会话；ensureBotBinding
    // 是唯一建行点。
    return this.ensureBotBinding(bot, project, { run, task, modelOverride })
  },
  // 控制面会话兜底与唯一建行点（DSHBOTS-285 落机制，289 生产接线，299 会话域三分，
  // ADR §4.1/§5.2-3）：ensureSession 收敛顺序的终点——rollover/compact 复用、任务亲和
  // 之外的运行一律解析到该 bot 在 (bot, project) 维度的 kind='bot' 控制面绑定；已有则复用
  // （宿主失效或结转时退役重建）。project 为 NULL 即 solo 域：绑定行 project_id 亦为 NULL，
  // 会话 cwd 落该 bot 专属工作区（resolveSessionCwd 的 solo 分支），与项目控制面双域分离。
  // 复用分支补齐与旧 ensureSession 同款的策略面：applyFilePolicy / applyBotToolPolicy /
  // selectModel / maybeCompactSession / rolloverPending 消费闸。
  async ensureBotBinding(bot, project, { run, task, modelOverride } = {} as any) {
    const isOwner = Boolean(project && bot && project.owner_bot_id === bot.id)
    // DSHBOTS-299：查询带 project 维度（IS 比 = 多兼容 NULL——solo 域按 (bot, NULL) 命中），
    // 同一 bot 跨项目各自独立成会话，项目流量不再被单条全局绑定吸走。
    const existing = this.store.get(
      "SELECT * FROM session_bindings WHERE bot_id = ? AND kind = 'bot' AND alias = 0 AND project_id IS ?",
      bot.id,
      project?.id ?? null,
    )
    let rolledOver = false
    if (existing) {
      const resolved = await this.ctx.sessionController.resolveAgent(existing.session_id)
      if (!resolved?.error) {
        // 结转（DSHBOTS-145）：控制面会话长期承接全量流量，照旧阈值判定——摘要就绪即
        // alias 化落到下方重建路径，摘要由新会话首轮提示词注入；未就绪补排摘要运行，
        // 本轮继续复用。alias 行不可能走到这里（查询条件 alias=0），幂等由查询保证。
        rolledOver = this.shouldRolloverSession({ bot, project, existing })
        if (!rolledOver) {
          this.applyFilePolicy(resolved, bot, run, task)
          applyBotToolPolicy(resolved, { isOwner, logger: this.logger })
          await this.selectModel(existing.session_id, bot, modelOverride)
          // 闲时压缩（DSHBOTS-286）：复用即「仍在承接流量」，跨过窗口且闲时排队总结压缩。
          this.maybeCompactSession({ bot, project, existing, currentRunId: run?.id })
          return existing.session_id
        }
      }
      // 会话已失效（宿主查不到）或结转判定要求开新会话：旧绑定降级为授权别名（DSHBOTS-256）。
      this.retireBinding(existing.session_id)
    }
    // DSHBOTS-299：建行去重键同样带 project 维度——同 bot 在 A 项目与 solo 域并发首建
    // 互不挤兑，也不共用同一条 in-flight Promise（solo 会话 cwd 与项目会话不同）。
    const key = `${bot.id}:${project?.id ?? 'solo'}:bot`
    if (this.sessionCreates.has(key)) return this.sessionCreates.get(key)
    const creating = (async () => {
      const solo = !project
      const cwd = await resolveSessionCwd(this.config, { solo, bot, project })
      const created = await this.ctx.sessionController.create({
        cwd,
        ...(await this.defaultAgentPreset('project')),
      })
      const sessionId = created.sessionId
      const agent = await this.ctx.sessionController.resolveAgent(sessionId)
      if (agent?.error) throw new AppError('SESSION_FAILED', `创建 DSH Session 失败：${agent.error.message ?? '未知错误'}`)
      if (this.ctx.sessionTitle?.rename) {
        const liveSession = agent?.agent?.session ?? agent?.session
        if (liveSession) {
          try { this.ctx.sessionTitle.rename(liveSession, `${bot.name} · 控制面`) } catch {}
        }
      }
      this.applyFilePolicy(agent, bot, run, task)
      applyBotToolPolicy(agent, { isOwner, logger: this.logger })
      this.store.run(
        `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias)
         VALUES (?, ?, ?, 'bot', NULL, ?, 0)
         ON CONFLICT(session_id) DO NOTHING`,
        sessionId,
        bot.id,
        project?.id ?? null,
        new Date().toISOString(),
      )
      // 结转消费闸（DSHBOTS-213）：新会话成为摘要的唯一注入目标——否则旧会话在摘要就绪
      // 前后被非结转路径顶替（如宿主重启失效）时，替身会话的普通轮次会把摘要提前消费掉。
      if (rolledOver) this.store.setSetting(rolloverPendingKey(bot.id, project?.id ?? null), sessionId)
      await this.selectModel(sessionId, bot, modelOverride)
      // 挂到 DSH 原生工作区分组（可选增强）：控制面会话落在项目工作区时归项目组
      // （solo 无项目上下文，cwd 已是 bot 专属目录，天然一组，无需挂载）。
      // registry 经 ctx.get 读取，宿主未装就整体跳过；挂载失败只在 workspace-groups 内 warn。
      const registry = this.ctx.get?.('workspaceRegistry')
      if (registry && project) {
        await attachSessionToWorkspace(registry, {
          cwd,
          title: workspaceGroupTitle({ kind: 'bot', project, bot }),
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
  async startRun({ run, bot, project, task, chatMessage, extraMessages, sessionKind }: { run: { id: string; kind: string; mode?: string; bot_id?: string; project_id?: string; task_id?: string; trigger_ref?: string; trigger_type?: string; recovery?: number; model_provider?: string; model_model?: string; model_effort?: string }; bot: { name: string }; project?: { id: string; key: string; name: string; slug: string; production_dir?: string }; task?: { id: string; number: number; title: string; status: string; priority: string; description?: string; write_scopes?: string; timeBudgetMinutes?: number; time_budget_minutes?: number }; chatMessage?: { id?: string; body?: string; sender_type?: string; sender_id?: string; reply_to_id?: string }; extraMessages?: { id?: string; body?: string; sender_type?: string; sender_id?: string; reply_to_id?: string }[]; sessionKind: string }) {
    if (!this.ctx?.sessionController) throw new AppError('DSH_UNAVAILABLE', 'DSH Session 服务不可用')
    // 备用模型覆盖：派生运行在 runs 行里带 model_* 三列，指明这条运行改用备用模型下发。
    // 不带 override 的运行照旧走 Bot 主模型——「运行结束自动回退」就靠这条默认路径实现。
    const modelOverride = modelOverrideFor(run)
    // 用量记账要记实际下发的模型，备用运行不能记到主模型头上。
    const effectiveBot = modelOverride
      ? { ...bot, provider: modelOverride.provider, model: modelOverride.model, effort: modelOverride.effort ?? null }
      : bot
    // sessionKind 入参保留兼容（调用方仍传），控制面收敛后不再参与会话解析。
    const sessionId = await this.ensureSession(bot, project, { run, task, modelOverride })
    let prompt = this.promptFor({ run, bot, project, task, chatMessage, extraMessages, sessionId })
    // recovery note（DSHBOTS-135）：恢复标记已被上面的首条提示词消费，即刻清零——
    // 恢复提醒只对「重排队后的第一次执行」注入一次，后续运行回到标准提示词。
    if (Number(run.recovery) === 1) {
      this.store.run('UPDATE runs SET recovery = 0 WHERE id = ?', run.id)
    }
    const pending: any = {
      runId: run.id,
      sessionId,
      bot: effectiveBot,
      projectId: project?.id ?? null,
      // 任务归因（DSHBOTS-212）：记账时透传到 usage_events.task_id；
      // 非任务运行为 null，沿用既有「无任务归因」口径。
      taskId: run.task_id ?? null,
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
    // 任务时效要求（DSHBOTS-131）在全局上限内再收紧：到期未完成即超时中止。
    // review/handle 再走分档收紧（DSHBOTS-302）：min(全局, review_timeout_minutes)。
    const limits = effectiveRunLimits(this.config, key => this.store.setting(key))
    pending.runTimeoutMs = runTimeoutMsForTaskRun({
      run,
      task,
      globalRunTimeoutMs: limits.runTimeoutMs,
      reviewTimeoutMs: effectiveReviewTimeoutMinutes(key => this.store.setting(key)) * 60_000,
    })
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
