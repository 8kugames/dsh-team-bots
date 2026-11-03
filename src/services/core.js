// src/services/core.js —— 服务核心域
// 服务生命周期、全局配置、审计写入与行读取。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { effectiveRunLimits, RUN_LIMIT_RANGES, RUN_TIMEOUT_KEY, STALL_WATCHDOG_KEY } from '../config.js'
import { badRequest, notFound } from '../errors.js'
import { ensureDirResilient, ensureSkillRoot } from '../paths.js'
import { seedModelPrices } from '../pricing.js'
import { syncSkills } from '../skills.js'
import { backfillWorkspaceGroupBindings } from './workspace-groups.js'
import { ensureApprovalSchema } from './approvals.js'
import { ensureQuestionSchema } from './questions.js'
import { ensureMessageImagesSchema } from './message-images.js'
import { ensureTaskTimesSchema, ensureTaskTerminalTimeBackfill } from './tasks.js'
import { ensureRecoverySchema } from './recovery-schema.js'
import { id, nowIso } from '../util.js'



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
        } catch (error) {
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
        } catch (error) {
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
  settingsView() {
    const keys = [
      'budget_currency', 'global_token_budget', 'global_cost_budget',
      'retention_usage_days', 'retention_run_event_days', 'retention_message_days',
      'memory_review', 'chat_memory_review',
      RUN_TIMEOUT_KEY, STALL_WATCHDOG_KEY,
    ]
    const values = {}
    for (const key of keys) values[key] = this.store.setting(key, '')
    return values
  },

  // 当前生效的运行时效（分钟）与 env 覆盖标志，供全局配置页回显；
  // 生效值与保存值分开：inputs 回填保存值，卡头显示生效值。
  runLimitsView() {
    const limits = effectiveRunLimits(this.config, key => this.store.setting(key))
    return {
      runTimeoutMinutes: Math.round(limits.runTimeoutMs / 60_000),
      stallTimeoutMinutes: Math.round(limits.stallTimeoutMs / 60_000),
      runTimeoutEnv: limits.runTimeoutEnv,
      stallTimeoutEnv: limits.stallTimeoutEnv,
    }
  },
  updateSettings(patch, actor = this.actor()) {
    const values = {}
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
    this.store.transaction(() => {
      for (const [key, value] of Object.entries(values)) this.store.setSetting(key, value)
      this.audit(actor, 'settings.update', 'settings', 'global', 'global', values)
      // 运行时效单列一条 global.run_limits 审计，便于按目标检索改值历史。
      const limitKeys = Object.keys(RUN_LIMIT_RANGES)
      if (limitKeys.some(key => values[key] !== undefined)) {
        this.audit(actor, 'settings.update', 'settings', 'global.run_limits',
          Object.fromEntries(limitKeys.map(key => [key, values[key] ?? ''])))
      }
    })
    return this.settingsView()
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
