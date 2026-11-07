// src/services/core.js —— 服务核心域
// 服务生命周期、全局配置、审计写入与行读取。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { effectiveReviewIdleMinutes, effectiveRunLimits, RUN_LIMIT_RANGES, RUN_TIMEOUT_KEY, STALL_WATCHDOG_KEY, APPROVAL_TIMEOUT_KEY, QUESTION_TIMEOUT_KEY, UI_LANGUAGE_KEY, UI_LANGUAGE_VALUES, REVIEW_AUTO_CLOSE_KEY, REVIEW_ESCALATE_KEY, REVIEW_ESCALATE_RANGE, REVIEW_IDLE_MINUTES_KEY, REVIEW_IDLE_MINUTES_RANGE } from '../config.js'
import { badRequest, conflict, notFound } from '../errors.js'
import { ensureDirResilient, ensureSkillRoot } from '../paths.js'
import { seedModelPrices } from '../pricing.js'
import { syncSkills } from '../skills.js'
import { backfillWorkspaceGroupBindings } from './workspace-groups.js'
import { ensureApprovalSchema } from './approvals.js'
import { ensureQuestionSchema } from './questions.js'
import { ensureMessageImagesSchema } from './message-images.js'
import { ensureTaskTimesSchema, ensureTaskTerminalTimeBackfill } from './tasks.js'
import { ensureRecoverySchema } from './recovery-schema.js'
import { ensureRolloverSchema } from './rollover-schema.js'
import { ensureTaskSandboxSchema } from './task-sandbox-schema.js'
import { ensureWechatTriggerSchema } from './wechat-trigger-schema.js'
import { PROMPT_SEGMENT_DEFAULTS, PROMPT_SEGMENT_MAX_CHARS, PROMPT_TRIO_BUDGET, parsePromptOverrides, promptOverridesHash, taskGuidanceTrioLength } from './runtime/prompt.js'
import { id, jsonParse, nowIso } from '../util.js'



export const coreMethods = {
  attachRuntime(runtime) {
    this.runtime = runtime
    runtime.setCompletionHandler(result => this.finishRun(result))
    // 轨迹等落库内容先过密钥掩码再写，掩码函数由 service 提供。
    runtime.setMask?.(value => this.maskSecretValues(value))
    // 审批域监听宿主 approval/request waterfall；测试桩无 ctx.on 时静默跳过。
    this.approvalsAttach?.(runtime)
    // 提问域监听宿主 user-questions/request waterfall；同样允许测试桩无 ctx.on 时跳过。
    this.questionsAttach?.(runtime)
  },
  async initialize() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      await ensureDirResilient(this.config.dataDir)
      await ensureDirResilient(this.config.memoryDir)
      await ensureDirResilient(this.config.messageDir)
      await ensureSkillRoot(this.config.skillRoot)
      // 密钥与数据库对不上就在启动时暴露，别等到第一次写密文才炸。
      this.ensureSecretBox()
      await this.ensureSoloWorkspaces()
      this.store.run(
        `INSERT INTO users(id, name, role, created_at) VALUES (?, ?, 'admin', ?)
         ON CONFLICT(id) DO NOTHING`,
        this.localUserId, 'You', nowIso(),
      )
      if (!this.store.get('SELECT id FROM bots LIMIT 1')) {
        let model
        try {
          const catalog = await this.runtime?.catalog(true) ?? []
          model = catalog[0]
        } catch (error: any) {
          // 取不到模型目录也要留痕：否则种子 Bot 带着空模型上线，问题会被埋掉。
          this.logger.warn?.(`dsh-team: 取模型目录失败，种子 Bot 将不带模型：${error?.message ?? error}`)
        }
        await this.createBot({
          name: this.config.seedOwnerName,
          role: this.config.seedOwnerRole,
          instructions: this.config.seedOwnerInstructions,
          provider: model?.provider,
          model: model?.model,
          effort: model?.defaultEffort,
          color: 'teal',
        }, { type: 'system', id: 'system' })
        for (const seed of this.config.seedBots ?? []) {
          await this.createBot({
            name: seed.name,
            role: seed.role,
            instructions: seed.instructions,
            provider: model?.provider,
            model: model?.model,
            effort: model?.defaultEffort,
            color: seed.color,
          }, { type: 'system', id: 'system' })
        }
      }
      syncSkills(this.store, this.config.skillRoot)
      seedModelPrices(this.store, this.config.modelPrices ?? [])
      this.ensureSettings()
      // 恢复标记列由恢复域自管迁移（db.js 不加行）；列必须先在，下面的置位 UPDATE 才能写。
      ensureRecoverySchema(this.store)
      // 结转支撑索引（DSHBOTS-145）由结转域自管迁移（db.js 不加索引）。
      ensureRolloverSchema(this.store)
      const interrupted = this.store.all("SELECT id FROM runs WHERE status = 'running'")
      this.store.run(
        `UPDATE runs SET status = 'queued', recovery = 1, started_at = NULL, last_progress_at = NULL, session_id = NULL
         WHERE status = 'running'`,
      )
      for (const run of interrupted) {
        this.store.run(
          `INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, 'recovered', ?, ?)`,
          id('evt'), run.id, '宿主重启，运行重新排队', nowIso(),
        )
      }
      // 审批表与 messages 审批列的迁移由审批域自管（db.js 保持不超 800 行）；
      // 同一步顺手把残留 pending 置 timeout——宿主侧请求随进程消失，不可能再被应答。
      ensureApprovalSchema(this.store)
      // 提问表与 messages 提问列的迁移由提问域自管（db.js 保持不超 800 行）；
      // 同一步把残留 pending 置 timeout，理由与审批一致。
      ensureQuestionSchema(this.store)
      // 聊天附图表同样由消息域自管迁移（db.js 不加行）。
      ensureMessageImagesSchema(this.store)
      // 任务取消时间列由任务域自管迁移：加 canceled_at 并回填老数据（db.js 不加行）。
      ensureTaskTimesSchema(this.store)
      // 终态时间历史空行回填（DSHBOTS-69）：done/canceled 存量行缺终态列的补 updated_at。
      ensureTaskTerminalTimeBackfill(this.store)
      // 派发沙箱覆盖列（DSHBOTS-156）：tasks.sandbox_override，缺省 NULL=跟随 bot 配置档。
      ensureTaskSandboxSchema(this.store)
      // 微信入站 Trigger 留痕表（B4-①/DSHBOTS-328）：幂等迁移，通道未启用也不碍事。
      ensureWechatTriggerSchema(this.store)
      // 终端命令随服务进程生死：重启后 running 行已无进程可停，统一置 interrupted，不留僵尸。
      this.store.run(
        `UPDATE terminal_commands SET status = 'interrupted', error_message = '服务重启中断', ended_at = ? WHERE status = 'running'`,
        nowIso(),
      )
      if (this.config.wechat?.enabled) {
        // 微信通道是可选集成，其 vendor 依赖按需加载：缺失或损坏时只降级该通道，
        // 不应让整个插件加载失败、工作台路由全部不可用。
        try {
          const { WechatStore } = await import('../wechat/store.js')
          const { WechatChannel } = await import('../wechat/channel.js')
          const wechatStore = await new WechatStore(this.config.wechatDbPath).open()
          this.wechat = new WechatChannel({ store: wechatStore, config: this.config, log: this.logger })
          this.wechat.setService(this)
          await this.wechat.start().catch(error => {
            this.logger.warn?.(`[wechat] 通道启动失败: ${error?.message ?? error}`)
          })
        } catch (error: any) {
          this.logger.warn?.(`[wechat] 通道加载失败，已跳过: ${error?.message ?? error}`)
        }
      }
      // 历史会话挂工作区分组：后台一次性回填，不阻塞启动（void 不 await）。
      // 宿主上下文在 runtime 上（TeamService 自身无 ctx），测试桩无 ctx 时静默跳过；
      // registry 缺失时跳过且不写标记，下次启动再试。
      void backfillWorkspaceGroupBindings({
        store: this.store,
        config: this.config,
        logger: this.logger,
        ctx: this.runtime?.ctx,
      }).catch(error => {
        this.logger.warn?.(`dsh-team: 工作区分组回填失败（不影响启动）: ${error?.message ?? error}`)
      })
    })()
    return this.ready
  },
  ensureSettings() {
    const defaults = {
      budget_currency: 'CNY',
      global_token_budget: '',
      global_cost_budget: '',
      retention_usage_days: '0',
      retention_run_event_days: '0',
      retention_message_days: '0',
      memory_review: '1',
      chat_memory_review: '1',
    }
    for (const [key, value] of Object.entries(defaults)) {
      if (this.store.setting(key) === null) this.store.setSetting(key, value)
    }
  },
  budgetCurrency() {
    return String(this.store.setting('budget_currency', 'CNY') || 'CNY').toUpperCase()
  },
  // 设置页乐观并发令牌（B2/DSHBOTS-325）：updateSettings 每次成功保存 +1，
  // UI 保存时携带读取时的值，不匹配即 conflict 409（多标签/多人同时改不静默互覆）。
  // 只覆盖 settingsView 键域；prompt_overrides 是独立编辑面，不混入本令牌。
  settingsRevision() {
    return Number(this.store.setting('settings_revision', '0')) || 0
  },
  // 设置变更历史（A4/DSHBOTS-330）：audit_log 本就是 append-only 的不可变账本（B2 起
  // updateSettings/prompt_segment 每次保存都审计 values），本方法只做只读视图——回答
  // 「谁在什么时候改了什么」。只记 DB/页面值（审计 data 即 patch），进程级环境变量不混入。
  // 不做一键恢复：审计行是增量 patch 非全量快照，恢复语义 = 用户按历史行手动重存
  // （B2 的 revision 闸会拦下并发覆盖）。
  settingsHistoryView(limit = 30) {
    const rows = this.store.all(
      `SELECT actor_type, actor_id, action, target_id, data_json, created_at FROM audit_log
       WHERE action IN ('settings.update', 'prompt_segment.update', 'prompt_segment.reset')
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      Math.max(1, Math.min(100, Number(limit) || 30)),
    )
    return rows.map(row => {
      const data = jsonParse(row.data_json, {})
      // prompt_segment 行的 data 只记字符数（不重复存正文），变更键用段键（target_id）呈现。
      const keys = row.action.startsWith('prompt_segment.')
        ? [row.target_id]
        : Object.keys(data ?? {})
      return {
        at: row.created_at,
        actor: `${row.actor_type}:${row.actor_id}`,
        action: row.action,
        target: row.target_id,
        keys,
        data,
      }
    })
  },
  settingsView() {
    const keys = [
      'budget_currency', 'global_token_budget', 'global_cost_budget',
      'retention_usage_days', 'retention_run_event_days', 'retention_message_days',
      'memory_review', 'chat_memory_review',
      RUN_TIMEOUT_KEY, STALL_WATCHDOG_KEY,
      APPROVAL_TIMEOUT_KEY, QUESTION_TIMEOUT_KEY,
      UI_LANGUAGE_KEY,
      REVIEW_IDLE_MINUTES_KEY, REVIEW_AUTO_CLOSE_KEY, REVIEW_ESCALATE_KEY,
    ]
    const values: any = {}
    for (const key of keys) values[key] = this.store.setting(key, '')
    return values
  },

  // 当前生效的运行时效（分钟）与 env 覆盖标志，供全局配置页回显；
  // 生效值与保存值分开：inputs 回填保存值，卡头显示生效值。
  runLimitsView() {
    const limits = effectiveRunLimits(this.config, key => this.store.setting(key))
    // 验收滞留阈值（DSHBOTS-194）随行透出：任务卡滞留 badge 据此着色，与后端守门同源。
    const { minutes: reviewIdleMinutes } = effectiveReviewIdleMinutes(this.config, key => this.store.setting(key))
    return {
      runTimeoutMinutes: Math.round(limits.runTimeoutMs / 60_000),
      stallTimeoutMinutes: Math.round(limits.stallTimeoutMs / 60_000),
      runTimeoutEnv: limits.runTimeoutEnv,
      stallTimeoutEnv: limits.stallTimeoutEnv,
      reviewIdleMinutes,
    }
  },
  updateSettings(patch, actor = this.actor(), expectedRevision = undefined) {
    // 乐观并发（B2/DSHBOTS-325）：UI 带上读取时的 revision，不一致即 409——后保存者
    // 不静默覆盖先保存者的改动。不带 revision 的旧调用形态保持原行为（兼容脚本/旧 UI）。
    if (expectedRevision !== undefined && expectedRevision !== null && String(expectedRevision) !== '') {
      if (Number(expectedRevision) !== this.settingsRevision()) {
        throw conflict('配置已被其他人或窗口修改，本次保存被拒绝；请刷新后基于最新值重新编辑')
      }
    }
    const values: any = {}
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!Object.keys(this.settingsView()).includes(key)) throw badRequest(`不支持的设置项：${key}`)
      values[key] = String(value ?? '').trim()
    }
    if (values.budget_currency !== undefined) {
      const currency = values.budget_currency.toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('预算币种必须是三位货币代码')
      values.budget_currency = currency
    }
    for (const key of ['global_token_budget', 'global_cost_budget']) {
      if (values[key] === undefined || values[key] === '') continue
      const num = Number(values[key])
      if (!Number.isFinite(num) || num < 0) throw badRequest(`${key} 必须是非负数`)
      values[key] = String(num)
    }
    for (const key of ['retention_usage_days', 'retention_run_event_days', 'retention_message_days']) {
      if (values[key] === undefined || values[key] === '') continue
      const num = Number(values[key])
      if (!Number.isInteger(num) || num < 0) throw badRequest(`${key} 必须是天数的整数`)
      values[key] = String(num)
    }
    // 运行时效（分钟）：超时 1–360、看门狗 0–360（0 = 关闭）；空串 = 清除保存值回退默认。
    for (const [key, [min, max]] of Object.entries(RUN_LIMIT_RANGES)) {
      if (values[key] === undefined || values[key] === '') continue
      const num = Number(values[key])
      if (!Number.isInteger(num) || num < min || num > max) {
        throw badRequest(`${key} 必须是 ${min}–${max} 的整数分钟`)
      }
      values[key] = String(num)
    }
    // 验收滞留守门三键（DSHBOTS-194/235）：阈值 0–1440（0 = 关闭）；自动收口 0/1；
    // 二次催办倍数 2–10。空串 = 清除保存值回退默认，与运行时效同口径。
    {
      const [idleMin, idleMax] = REVIEW_IDLE_MINUTES_RANGE
      const key = REVIEW_IDLE_MINUTES_KEY
      if (values[key] !== undefined && values[key] !== '') {
        const num = Number(values[key])
        if (!Number.isInteger(num) || num < idleMin || num > idleMax) {
          throw badRequest(`${key} 必须是 ${idleMin}–${idleMax} 的整数分钟`)
        }
        values[key] = String(num)
      }
    }
    if (values[REVIEW_AUTO_CLOSE_KEY] !== undefined && values[REVIEW_AUTO_CLOSE_KEY] !== '') {
      // 三态（B3/DSHBOTS-326）：0 关闭 / observe 干跑（判定留痕不收口）/ 1 开启。
      if (!['0', '1', 'observe'].includes(values[REVIEW_AUTO_CLOSE_KEY])) {
        throw badRequest(`${REVIEW_AUTO_CLOSE_KEY} 必须是 0、observe 或 1`)
      }
    }
    {
      const [escMin, escMax] = REVIEW_ESCALATE_RANGE
      const key = REVIEW_ESCALATE_KEY
      if (values[key] !== undefined && values[key] !== '') {
        const num = Number(values[key])
        if (!Number.isInteger(num) || num < escMin || num > escMax) {
          throw badRequest(`${key} 必须是 ${escMin}–${escMax} 的整数`)
        }
        values[key] = String(num)
      }
    }
    // UI 语言（DSHBOTS-162）：auto = 跟随 DSH 宿主（缺省），zh/en = 显式覆盖。
    // 非法输入 badRequest，不静默钳制（与运行时效同口径）；外部写入的非法值由
    // effectiveUiLanguage 收敛回 'auto'。
    if (values[UI_LANGUAGE_KEY] !== undefined) {
      const raw = values[UI_LANGUAGE_KEY].toLowerCase()
      if (!UI_LANGUAGE_VALUES.includes(raw)) throw badRequest(`${UI_LANGUAGE_KEY} 必须是 ${UI_LANGUAGE_VALUES.join('/')}`)
      values[UI_LANGUAGE_KEY] = raw
    }
    this.store.transaction(() => {
      for (const [key, value] of Object.entries(values)) this.store.setSetting(key, value)
      // 乐观并发令牌随保存推进（B2/DSHBOTS-325）：settings_revision 不是 settingsView 键，
      // 不可经 patch 直接写，只在这里单调递增。
      this.store.setSetting('settings_revision', String(this.settingsRevision() + 1))
      // A4/DSHBOTS-330 修复：此前本行是六参误用（audit 只收五参），values 被静默丢弃、
      // 审计行只剩 data='global'——变更历史的「改了什么」从此处起才有值。
      this.audit(actor, 'settings.update', 'settings', 'global', values)
      // 运行时效单列一条 global.run_limits 审计，便于按目标检索改值历史。
      const limitKeys = Object.keys(RUN_LIMIT_RANGES)
      if (limitKeys.some(key => values[key] !== undefined)) {
        this.audit(actor, 'settings.update', 'settings', 'global.run_limits',
          Object.fromEntries(limitKeys.map(key => [key, values[key] ?? ''])))
      }
    })
    return this.settingsView()
  },

  // 可编辑提示词段（B1/DSHBOTS-324）：只读视图。defaultChanged = 覆盖保存时的内置默认  // 指纹与当前默认不一致（升级改了默认文本），UI 据此给「保留我的文本 / 恢复新默认」取舍。
  promptSegmentsView() {
    const overrides = parsePromptOverrides(this.store.setting('prompt_overrides', ''))
    return Object.entries(PROMPT_SEGMENT_DEFAULTS).map(([key, defaultText]) => {
      const override = overrides?.[key] ?? null
      return {
        key,
        defaultText,
        override: override ? {
          text: String(override.text ?? ''),
          baseHash: String(override.base_hash ?? ''),
          updatedAt: String(override.updated_at ?? ''),
          updatedBy: String(override.updated_by ?? ''),
        } : null,
        defaultChanged: Boolean(override && override.base_hash !== promptOverridesHash(defaultText)),
        effectiveText: override?.text ?? defaultText,
      }
    })
  },

  // 保存/恢复一个提示词段：空文本或与默认一致 = 恢复默认（删覆盖）；有覆盖走预算校验
  // （拆卡三段 ≤1200 与 tests/prompt-budget 同口径）+ 2000 字上限。保存即审计。
  // 不唤醒任何会话：identity 段随会话冻结（D-91），改动只对新会话生效。
  updatePromptSegment(segment, text, actor = this.actor()) {
    if (!Object.hasOwn(PROMPT_SEGMENT_DEFAULTS, segment)) throw badRequest(`未知提示词段：${segment}`)
    const clean = String(text ?? '').replace(/\r\n/g, '\n').trim()
    const overrides = parsePromptOverrides(this.store.setting('prompt_overrides', ''))
    if (!clean || clean === PROMPT_SEGMENT_DEFAULTS[segment]) {
      if (overrides?.[segment]) {
        delete overrides[segment]
        this.store.setSetting('prompt_overrides', JSON.stringify(overrides))
        this.audit(actor, 'prompt_segment.reset', 'settings', segment, {})
      }
      return this.promptSegmentsView()
    }
    if (clean.length > PROMPT_SEGMENT_MAX_CHARS) {
      throw badRequest(`提示词段正文上限 ${PROMPT_SEGMENT_MAX_CHARS} 字符（实测 ${clean.length}）`)
    }
    if (segment === 'subtask' || segment === 'splitting') {
      const trio = taskGuidanceTrioLength({ ...overrides, [segment]: { text: clean } }, this.config)
      if (trio > PROMPT_TRIO_BUDGET) {
        throw badRequest(`拆卡指引三段合计超预算（实测 ${trio} > ${PROMPT_TRIO_BUDGET} 字符），请缩短文本`)
      }
    }
    overrides[segment] = {
      text: clean,
      base_hash: promptOverridesHash(PROMPT_SEGMENT_DEFAULTS[segment]),
      updated_at: nowIso(),
      updated_by: `${actor?.type ?? 'user'}:${actor?.id ?? 'local'}`,
    }
    this.store.setSetting('prompt_overrides', JSON.stringify(overrides))
    this.audit(actor, 'prompt_segment.update', 'settings', segment, { chars: clean.length })
    return this.promptSegmentsView()
  },

  start() {
    if (this.started) return
    this.started = true
    this.timer = setInterval(() => void this.tick(), this.config.schedulerIntervalMs)
    this.timer.unref?.()
    setTimeout(() => void this.tick(), 300).unref?.()
  },
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.started = false
    void this.wechat?.stop()
  },
  actor(actor = { type: 'user', id: this.localUserId }) {
    return actor
  },
  actorName(actor) {
    if (actor.type === 'user') return this.store.get('SELECT name FROM users WHERE id = ?', actor.id)?.name ?? 'You'
    return this.store.get('SELECT name FROM bots WHERE id = ?', actor.id)?.name ?? actor.id
  },
  audit(actor, action, targetType, targetId, data = {}) {
    this.store.audit(actor.type, actor.id, action, targetType, targetId, data)
  },
  botRow(botId) {
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', botId)
    if (!bot) throw notFound('Bot 不存在')
    return bot
  },
  projectRow(projectId) {
    const project = this.store.get('SELECT * FROM projects WHERE id = ?', projectId)
    if (!project) throw notFound('项目不存在')
    return project
  },
  taskRow(taskId) {
    const task = this.store.get(`SELECT t.*, b.name AS assignee_name
      FROM tasks t LEFT JOIN bots b ON b.id = t.assignee_bot_id WHERE t.id = ?`, taskId)
    if (!task) throw notFound('任务不存在')
    return task
  },
  runRow(runId) {
    const run = this.store.get('SELECT * FROM runs WHERE id = ?', runId)
    if (!run) throw notFound('运行不存在')
    return run
  },
}
