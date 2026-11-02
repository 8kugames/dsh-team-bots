import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { effectiveRunLimits, RUN_LIMIT_RANGES, RUN_TIMEOUT_KEY, STALL_WATCHDOG_KEY } from './config.js'
import { AppError, badRequest, conflict, forbidden, hotUpgradeUnsupported, notFound } from './errors.js'
import { assertInside, botWorkspaceDir, botsHome, ensureDirResilient, ensureExternalDir, ensureProjectWorkspace, ensureSkillRoot, projectDir, SLUG_MAX } from './paths.js'
import { applyRetention, exportUsageCsv, monthUsageForProject, monthUsageGlobal, reconcileUsage, runUsageTotals, setPrice, usageSnapshot } from './usage.js'
import { latestDshVersion, compareVersions, validTargetVersion } from './updater.js'
import { priceKey, seedModelPrices } from './pricing.js'
import { publishSkill, rollbackSkill, skillSnapshot, stageSkill, syncSkills } from './skills.js'
import { projectSkillRoots, scanProjectSkills } from './project-skills.js'
import { deliveryPlan, replyDeliveryPrompt, summarizeForUi, upsertBotMessage } from './botmsg.js'
import { ENV_PREFIX, SecretBox, maskSecrets, materializeEnvFile, normalizeSecretName, secretFingerprint, secretKeyFingerprint } from './secrets.js'
import { clampNumber, id, jsonParse, nowIso, parseDisabledSkills, parseMentions, projectKey, redactSecrets, sha256, slugify, TASK_ID_PATTERN, sanitizeFilename, writeIfChanged } from './util.js'
import { parseWriteScopes, readWriteScopes, writeScopesOverlap } from './services/write-scopes.js'
import { normalizeFilePolicy } from './services/file-policy.js'
import { defineMethods } from './services/mixin.js'
import { botsMethods } from './services/bots.js'
import { projectsMethods } from './services/projects.js'
import { chatMethods } from './services/chat.js'
import { tasksMethods } from './services/tasks.js'
import { runsMethods } from './services/runs.js'
import { schedulerMethods } from './services/scheduler.js'
import { memoryMethods } from './services/memory.js'
import { secretsMethods } from './services/secrets.js'
import { proposalsMethods } from './services/proposals.js'
import { terminalMethods } from './services/terminal.js'
import { usageMethods } from './services/usage.js'

export { WRITE_SCOPE_MAX, WRITE_SCOPE_MAX_LEN, parseWriteScopes, readWriteScopes, writeScopePathsOverlap, writeScopesOverlap } from './services/write-scopes.js'
export { FILE_POLICIES, FILE_POLICY_LABELS } from './services/file-policy.js'
// 微信登录二维码：服务端直接出 SVG，UI 注入即可，无需前端 QR 库（vendor/qrcode，MIT）。
// 依赖按需加载：二维码库缺失只影响扫码，不应让整个插件加载失败。
function wechatQrSvg(url) {
  const makeQr = createRequire(import.meta.url)('../vendor/qrcode/qrcode.js')
  const qr = makeQr(0, 'M')
  qr.addData(url)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2 })
}

export class TeamService {
  constructor({ store, config, logger = console }) {
    this.store = store
    this.config = config
    this.logger = logger
    this.runtime = null
    this.localUserId = 'user_local'
    this.timer = null
    this.ticking = false
    this.started = false
    this.ready = null
    this.rate = {}
    // 只读运行开始时的项目工作区指纹，用于事后发现“只读会话改了文件”。
    this.fingerprints = new Map()
    this.lastMaintenanceAt = 0
    this.wechat = null
    // 运行中的终端命令：commandId → { child, buffer, startedAtMs, timedOut, cancelRequested, timer }。
    // 进程引用与实时 tail 只放内存；结束即释放，历史落 terminal_commands 表。
    this.terminalActive = new Map()
  }

  attachRuntime(runtime) {
    this.runtime = runtime
    runtime.setCompletionHandler(result => this.finishRun(result))
    // 轨迹等落库内容先过密钥掩码再写，掩码函数由 service 提供。
    runtime.setMask?.(value => this.maskSecretValues(value))
  }

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
      const interrupted = this.store.all("SELECT id FROM runs WHERE status = 'running'")
      this.store.run(
        `UPDATE runs SET status = 'queued', started_at = NULL, last_progress_at = NULL, session_id = NULL
         WHERE status = 'running'`,
      )
      for (const run of interrupted) {
        this.store.run(
          `INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, 'recovered', ?, ?)`,
          id('evt'), run.id, '宿主重启，运行重新排队', nowIso(),
        )
      }
      // 终端命令随服务进程生死：重启后 running 行已无进程可停，统一置 interrupted，不留僵尸。
      this.store.run(
        `UPDATE terminal_commands SET status = 'interrupted', error_message = '服务重启中断', ended_at = ? WHERE status = 'running'`,
        nowIso(),
      )
      if (this.config.wechat?.enabled) {
        // 微信通道是可选集成，其 vendor 依赖按需加载：缺失或损坏时只降级该通道，
        // 不应让整个插件加载失败、工作台路由全部不可用。
        try {
          const { WechatStore } = await import('./wechat/store.js')
          const { WechatChannel } = await import('./wechat/channel.js')
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
    })()
    return this.ready
  }

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
  }

  budgetCurrency() {
    return String(this.store.setting('budget_currency', 'CNY') || 'CNY').toUpperCase()
  }

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
  }

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
  }

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
  }

  start() {
    if (this.started) return
    this.started = true
    this.timer = setInterval(() => void this.tick(), this.config.schedulerIntervalMs)
    this.timer.unref?.()
    setTimeout(() => void this.tick(), 300).unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.started = false
    void this.wechat?.stop()
  }

  actor(actor = { type: 'user', id: this.localUserId }) {
    return actor
  }

  actorName(actor) {
    if (actor.type === 'user') return this.store.get('SELECT name FROM users WHERE id = ?', actor.id)?.name ?? 'You'
    return this.store.get('SELECT name FROM bots WHERE id = ?', actor.id)?.name ?? actor.id
  }

  audit(actor, action, targetType, targetId, data = {}) {
    this.store.audit(actor.type, actor.id, action, targetType, targetId, data)
  }

  botRow(botId) {
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', botId)
    if (!bot) throw notFound('Bot 不存在')
    return bot
  }

  projectRow(projectId) {
    const project = this.store.get('SELECT * FROM projects WHERE id = ?', projectId)
    if (!project) throw notFound('项目不存在')
    return project
  }

  taskRow(taskId) {
    const task = this.store.get(`SELECT t.*, b.name AS assignee_name
      FROM tasks t LEFT JOIN bots b ON b.id = t.assignee_bot_id WHERE t.id = ?`, taskId)
    if (!task) throw notFound('任务不存在')
    return task
  }

  runRow(runId) {
    const run = this.store.get('SELECT * FROM runs WHERE id = ?', runId)
    if (!run) throw notFound('运行不存在')
    return run
  }

  /** 微信管理员指令：按 <key-N> 定位并验收/退回任务。 */
  async wechatReview(identifier, { decision, comment }) {
    await this.initialize()
    if (!['accept', 'return'].includes(decision)) throw badRequest('验收结果只能是 accept 或 return')
    const { project, task } = this.resolveTaskByIdentifier(identifier)
    const view = await this.applyReview(task, project, decision, comment, { type: 'user', id: this.localUserId })
    return decision === 'accept'
      ? `任务 ${identifier}《${view.title}》已验收通过。`
      : `任务 ${identifier}《${view.title}》已退回重做。`
  }

  /** 微信管理员指令：各项目未完结任务概览。 */
  stateView() {
    const projects = this.store.all("SELECT * FROM projects WHERE status = 'active' ORDER BY updated_at DESC")
    return {
      projects: projects.map(project => ({
        key: project.key,
        name: project.name,
        tasks: this.store.all(
          "SELECT number, status, title FROM tasks WHERE project_id = ? AND status NOT IN ('done', 'canceled') ORDER BY number",
          project.id,
        ),
      })),
    }
  }

  // 微信状态会进 UI state：凭据类字段一律剥掉，只留 phase/是否登录/管理员等展示信息。
  wechatStatus() {
    const status = this.wechat?.status()
      ?? { phase: 'disabled', enabled: false, error: null, adminPeerId: null, auth: null }
    const auth = status?.auth && typeof status.auth === 'object'
      ? Object.fromEntries(Object.entries(status.auth).filter(([key]) => !/token|secret|cookie|credential/i.test(key)))
      : status?.auth ?? null
    return { ...status, auth }
  }

  async wechatBeginLogin() {
    await this.initialize()
    if (!this.wechat) throw conflict('微信通道未启用（DSH_TEAM_WECHAT=1）')
    const challenge = await this.wechat.beginLogin()
    return { qrCodeUrl: challenge.qrCodeUrl, qrSvg: wechatQrSvg(challenge.qrCodeUrl) }
  }

  wechatSubmitCode(code) {
    if (!this.wechat) throw conflict('微信通道未启用（DSH_TEAM_WECHAT=1）')
    return this.wechat.submitVerificationCode(code)
  }

  async wechatLogout() {
    if (!this.wechat) throw conflict('微信通道未启用（DSH_TEAM_WECHAT=1）')
    await this.wechat.logout()
    return { phase: this.wechat.status().phase }
  }

  async state(projectId, soloBotId = null) {
    await this.initialize()
    const projects = this.store.all(`
      SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','canceled')) AS open_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'in_review' AND t.review_target = 'user') AS review_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'in_review' AND t.review_target = 'owner_bot') AS owner_review_tasks
      FROM projects p ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END, p.updated_at DESC
    `)
    const bots = this.store.all("SELECT * FROM bots ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at")
    let project = projectId ? this.store.get('SELECT * FROM projects WHERE id = ?', projectId) : undefined
    if (!project) project = this.store.get("SELECT * FROM projects WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1")
    const view = {
      me: this.store.get('SELECT id, name FROM users WHERE id = ?', this.localUserId),
      models: await this.runtime?.catalog() ?? [],
      bots: bots.map(bot => this.botView(bot)),
      projects: projects.map(item => ({
        ...item,
        openTasks: Number(item.open_tasks ?? 0),
        reviewTasks: Number(item.review_tasks ?? 0),
        ownerReviewTasks: Number(item.owner_review_tasks ?? 0),
      })),
      project: null,
      messages: [],
      tasks: [],
      runs: [],
      memories: [],
      skills: skillSnapshot(this.store, this.config),
      projectSkills: project ? this.projectSkillView(project) : [],
      skillBindings: this.skillBindings(project?.id ?? null),
      outbox: this.outboxCounts(),
      proposals: this.store.all('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100').map(item => this.proposalView(item)),
      revisions: {},
      usage: usageSnapshot(this.store, project?.id, 30, { currency: this.budgetCurrency() }),
      settings: this.settingsView(),
      runLimits: this.runLimitsView(),
      paths: {
        dshHome: this.config.dshHome,
        workspace: this.config.workspace,
        skillRoot: this.config.skillRoot,
        projectSkillRoots: project
          ? projectSkillRoots(this.projectWorkDir(project)).map(item => ({ root: item.root, path: item.path }))
          : [],
        dataDir: this.config.dataDir,
      },
      dsh: {
        native: true,
        profile: this.runtime?.capabilityInfo?.().profile ?? process.env.DSH_PROFILE ?? 'team-bots',
        home: this.config.dshHome,
        ...this.runtime?.capabilityInfo?.() ?? {},
      },
      // 每个 provider+model 只保留最新一条生效价格；历史版本不在这里展开。
      prices: this.latestPrices(),
      // 配置里的默认价格，Web 中可据此一键恢复。
      priceDefaults: this.config.modelPrices ?? [],
      wechat: this.wechatStatus(),
      now: nowIso(),
    }
    if (project) {
      const group = this.groupOf(project.id)
      view.project = this.projectView(project)
      const messages = this.store.all(
        `SELECT * FROM (SELECT * FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 200) ORDER BY created_at ASC`,
        project.id,
      )
      view.messages = messages.map(message => this.messageView(message))
      view.tasks = this.store.all(
        `SELECT t.*, b.name AS assignee_name FROM tasks t LEFT JOIN bots b ON b.id = t.assignee_bot_id
         WHERE t.project_id = ? ORDER BY
           CASE t.status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'in_review' THEN 2 WHEN 'todo' THEN 3 WHEN 'backlog' THEN 4 ELSE 5 END,
           t.position, t.updated_at DESC LIMIT 300`,
        project.id,
      ).map(task => this.taskView(task))
      view.runs = this.store.all(
        'SELECT * FROM runs WHERE project_id = ? ORDER BY queued_at DESC LIMIT 60',
        project.id,
      ).map(run => this.runView(run))
      const botIds = this.membersOf(project.id).map(bot => bot.id)
      const botFilter = botIds.length > 0 ? `OR (scope_type = 'bot' AND scope_id IN (${botIds.map(() => '?').join(',')}))` : ''
      view.memories = this.store.all(
        `SELECT * FROM memories WHERE status = 'active' AND ((scope_type = 'project' AND scope_id = ?) ${botFilter}
          OR (scope_type = 'team' AND scope_id = 'team'))
         ORDER BY updated_at DESC LIMIT 100`,
        project.id, ...botIds,
      ).map(item => this.memoryView(item))
      view.pendingMemories = this.store.all(
        `SELECT * FROM memories WHERE status = 'pending' AND ((scope_type = 'project' AND scope_id = ?) ${botFilter}
          OR (scope_type = 'team' AND scope_id = 'team'))
         ORDER BY updated_at DESC LIMIT 100`,
        project.id, ...botIds,
      ).map(item => this.memoryView(item))
      view.proposals = this.store.all(
        'SELECT * FROM proposals WHERE project_id = ? OR bot_id IN (SELECT id FROM bots) ORDER BY created_at DESC LIMIT 100',
        project.id,
      ).map(item => this.proposalView(item))
      view.prices = this.latestPrices()
      view.skillBindings = this.skillBindings(project.id)
      view.directMessages = this.botMessagesView(project.id)
      view.terminal = this.terminalState(project.id)
    }
    view.secrets = this.listSecrets()
    view.secretRequests = this.listSecretRequests()
    if (soloBotId) {
      const soloBot = this.store.get('SELECT * FROM bots WHERE id = ?', soloBotId)
      if (soloBot) {
        view.solo = {
          bot: this.botView(soloBot),
          messages: this.store.all(
            `SELECT * FROM (SELECT * FROM solo_messages WHERE bot_id = ? ORDER BY created_at DESC LIMIT 200) ORDER BY created_at ASC`,
            soloBot.id,
          ).map(message => this.soloMessageView(message)),
          runs: this.store.all(
            "SELECT * FROM runs WHERE bot_id = ? AND project_id IS NULL ORDER BY queued_at DESC LIMIT 30",
            soloBot.id,
          ).map(run => this.runView(run)),
        }
        // 单聊上下文的团队页口径：记忆只看 团队 + 该 bot 自己的；运行只看该 bot 的项目外运行；
        // 提案保持全团队（提案本身不挂项目）。
        view.proposals = this.store.all('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100').map(item => this.proposalView(item))
        view.memories = this.store.all(
          `SELECT * FROM memories WHERE status = 'active' AND ((scope_type = 'bot' AND scope_id = ?) OR (scope_type = 'team' AND scope_id = 'team'))
           ORDER BY updated_at DESC LIMIT 100`,
          soloBot.id,
        ).map(item => this.memoryView(item))
        view.pendingMemories = this.store.all(
          `SELECT * FROM memories WHERE status = 'pending' AND ((scope_type = 'bot' AND scope_id = ?) OR (scope_type = 'team' AND scope_id = 'team'))
           ORDER BY updated_at DESC LIMIT 100`,
          soloBot.id,
        ).map(item => this.memoryView(item))
        view.runs = this.store.all(
          'SELECT * FROM runs WHERE bot_id = ? AND project_id IS NULL ORDER BY queued_at DESC LIMIT 60',
          soloBot.id,
        ).map(run => this.runView(run))
      }
    }
    return view
  }

  async models(force = false) {
    return this.runtime?.catalog(force) ?? []
  }

  async dshUpdateInfo() {
    const current = process.env.DSH_RUNTIME_VERSION || 'unknown'
    let latest
    try {
      latest = await latestDshVersion({ force: true })
    } catch (error) {
      throw new AppError('DSH_REGISTRY_UNAVAILABLE', `无法查询 DSH 最新版本：${error.message}`, 502)
    }
    return {
      current,
      latest,
      profile: process.env.DSH_PROFILE || 'team-bots',
      updateAvailable: current !== 'unknown' && compareVersions(latest, current) > 0,
      checkedAt: nowIso(),
    }
  }

  async upgradeDsh(targetVersion) {
    await this.initialize()
    const active = this.store.get(
      "SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'running')",
    )?.count ?? 0
    if (Number(active) > 0) {
      throw conflict(`当前还有 ${active} 个排队或运行中的任务，请先停止后再升级 DSH`)
    }
    const current = process.env.DSH_RUNTIME_VERSION || 'unknown'
    const latest = await latestDshVersion({ force: true }).catch(error => {
      throw new AppError('DSH_REGISTRY_UNAVAILABLE', `无法查询 DSH 最新版本：${error.message}`, 502)
    })
    const target = targetVersion || latest
    if (!validTargetVersion(target)) throw badRequest('DSH 版本号格式无效')
    if (current === target) {
      return { current, target, upToDate: true }
    }
    if (current !== 'unknown' && compareVersions(target, current) <= 0) {
      return { current, target, upToDate: true }
    }
    throw hotUpgradeUnsupported()
  }

  async rebootDsh() {
    await this.initialize()
    const active = this.store.get(
      "SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'running')",
    )?.count ?? 0
    if (Number(active) > 0) {
      throw conflict(`当前还有 ${active} 个排队或运行中的任务，请先停止后再重启 DSH`)
    }
    throw hotUpgradeUnsupported()
  }

  async health() {
    await this.initialize()
    return {
      ok: true,
      version: '0.2.0',
      ready: true,
      bots: this.store.get('SELECT COUNT(*) AS count FROM bots')?.count ?? 0,
      projects: this.store.get('SELECT COUNT(*) AS count FROM projects')?.count ?? 0,
      queued: this.store.get("SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'")?.count ?? 0,
      running: this.store.get("SELECT COUNT(*) AS count FROM runs WHERE status = 'running'")?.count ?? 0,
    }
  }
}

// 业务域方法按域拆到 src/services/*.js，这里挂回 TeamService 原型：
// 对外仍是 service.method(...) 的调用方式，方法体内的 this 语义与拆分前完全一致。
defineMethods(TeamService.prototype, [
  botsMethods,
  projectsMethods,
  chatMethods,
  tasksMethods,
  runsMethods,
  schedulerMethods,
  memoryMethods,
  secretsMethods,
  proposalsMethods,
  terminalMethods,
  usageMethods,
])
