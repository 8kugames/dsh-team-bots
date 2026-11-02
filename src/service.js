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
import {
  clampNumber, id, jsonParse, nowIso, parseDisabledSkills, parseMentions, projectKey, redactSecrets,
  sha256, slugify, TASK_ID_PATTERN, text, sanitizeFilename, writeIfChanged,
} from './util.js'
import { parseWriteScopes, readWriteScopes, writeScopesOverlap } from './services/write-scopes.js'
import { normalizeFilePolicy } from './services/file-policy.js'
import { defineMethods } from './services/mixin.js'
import { botsMethods } from './services/bots.js'

export { WRITE_SCOPE_MAX, WRITE_SCOPE_MAX_LEN, parseWriteScopes, readWriteScopes, writeScopePathsOverlap, writeScopesOverlap } from './services/write-scopes.js'
export { FILE_POLICIES, FILE_POLICY_LABELS } from './services/file-policy.js'
const TASK_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled'])
const TASK_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low', 'none'])
const TRANSITIONS = {
  backlog: new Set(['todo', 'canceled']),
  todo: new Set(['backlog', 'in_progress', 'blocked', 'canceled']),
  in_progress: new Set(['todo', 'blocked', 'in_review', 'canceled']),
  blocked: new Set(['todo', 'in_progress', 'canceled']),
  in_review: new Set(['in_progress', 'done', 'canceled']),
  done: new Set(['todo']),
  canceled: new Set(['todo']),
}

// 工作台「终端」的硬限制：命令长度、输出封顶（只留末尾）、每项目历史条数。
// 硬超时走 config.terminalTimeoutMs（默认 120s，测试可注入短值）。
const TERMINAL_COMMAND_MAX = 4000
const TERMINAL_OUTPUT_CAP = 200 * 1024
const TERMINAL_HISTORY_LIMIT = 20

// 微信登录二维码：服务端直接出 SVG，UI 注入即可，无需前端 QR 库（vendor/qrcode，MIT）。
// 依赖按需加载：二维码库缺失只影响扫码，不应让整个插件加载失败。
function wechatQrSvg(url) {
  const makeQr = createRequire(import.meta.url)('../vendor/qrcode/qrcode.js')
  const qr = makeQr(0, 'M')
  qr.addData(url)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2 })
}
const commandTaskPattern = /^\/task\s+@([\p{L}\p{N}_-]+)\s+([\s\S]+)$/u
const commandRememberPattern = /^\/remember\s+([\s\S]+)$/u
const commandClearPattern = /^\/clear$/u

// 记忆审查输出：模型返回 JSON 数组，形如 [{scope, topic, content, confidence}]。
function parseMemoryReview(output) {
  const raw = String(output ?? '').trim()
  if (!raw) return []
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(item => item && typeof item === 'object' && item.content).slice(0, 10)
  } catch {
    return []
  }
}

// 追加终端输出并保持缓冲区有界：超过 2 倍封顶时裁到只留末尾一倍，均摊裁剪成本。
function appendTerminalChunk(buffer, chunk) {
  const next = buffer + chunk
  return next.length > TERMINAL_OUTPUT_CAP * 2 ? next.slice(-TERMINAL_OUTPUT_CAP) : next
}

// 杀掉终端命令的整个进程组（detached spawn 使子进程自成组长）；组杀失败时回退杀直接子进程。
function killTerminalGroup(child) {
  if (!child) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
  }
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

  groupOf(projectId) {
    return this.store.get('SELECT * FROM group_chats WHERE project_id = ?', projectId)
  }

  membersOf(projectId) {
    return this.store.all(
      `SELECT pm.*, pm.member_id AS id, b.name, b.role AS bot_role, b.provider, b.model, b.effort, b.status
       FROM project_members pm JOIN bots b ON b.id = pm.member_id
       WHERE pm.project_id = ? AND pm.member_type = 'bot'
       ORDER BY CASE pm.member_role WHEN 'owner' THEN 0 ELSE 1 END, b.name`,
      projectId,
    )
  }

  // 成员列表带本项目聚合口径：busy=本项目有排队/运行中的 run，usage 四项与 cost 为本项目全部 run 的累计。
  membersWithUsage(projectId) {
    return this.store.all(
      `SELECT pm.*, pm.member_id AS id, pm.member_role, b.name, b.role AS bot_role, b.provider, b.model, b.effort, b.status,
         EXISTS(
           SELECT 1 FROM runs r
           WHERE r.project_id = pm.project_id AND r.bot_id = pm.member_id AND r.status IN ('queued', 'running')
         ) AS busy,
         COALESCE(u.usage_input, 0) AS usage_input,
         COALESCE(u.usage_cache_read, 0) AS usage_cache_read,
         COALESCE(u.usage_cache_write, 0) AS usage_cache_write,
         COALESCE(u.usage_output, 0) AS usage_output,
         COALESCE(u.usage_cost, 0) AS usage_cost
       FROM project_members pm JOIN bots b ON b.id = pm.member_id
       LEFT JOIN (
         SELECT bot_id,
                SUM(usage_input) AS usage_input,
                SUM(usage_cache_read) AS usage_cache_read,
                SUM(usage_cache_write) AS usage_cache_write,
                SUM(usage_output) AS usage_output,
                SUM(usage_cost) AS usage_cost
         FROM runs WHERE project_id = ? GROUP BY bot_id
       ) u ON u.bot_id = pm.member_id
       WHERE pm.project_id = ? AND pm.member_type = 'bot'
       ORDER BY CASE pm.member_role WHEN 'owner' THEN 0 ELSE 1 END, b.name`,
      projectId,
      projectId,
    ).map(row => ({ ...row, busy: Boolean(row.busy) }))
  }

  assertMember(projectId, botId) {
    const member = this.store.get(
      "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND member_type = 'bot' AND member_id = ?",
      projectId,
      botId,
    )
    if (!member) throw forbidden('Bot 不是该项目成员')
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', botId)
    if (!bot || bot.status !== 'active') throw forbidden('Bot 当前不可用')
    return bot
  }

  // 项目生产目录：显式指定的外部目录优先（Bot 的 cwd、密钥物化、产物清单），
  // 未指定时与 <工作区>/{slug} 管理目录一致。
  projectWorkDir(project) {
    return project.production_dir || join(this.config.workspace, project.slug)
  }

  // 解析用户指定的生产目录：空串/null 表示回退默认；必须是可用的绝对路径目录。
  async resolveProductionDir(value) {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return null
    try {
      return await ensureExternalDir(raw)
    } catch (error) {
      throw badRequest(error.message || '生产目录无效')
    }
  }

  // 生产目录路径选择：列出本机某目录下的子目录（只列目录名，不含文件），供 UI 逐级浏览。
  // 插件本机运行、UI 与 bots 同属已声明的无沙箱模型，目录名不构成额外暴露面。
  browseDirectories(input) {
    const raw = typeof input.path === 'string' ? input.path.trim() : ''
    const target = resolve(raw || homedir())
    let entries
    try {
      entries = readdirSync(target, { withFileTypes: true })
    } catch (error) {
      throw badRequest(`无法读取目录 ${target}：${error?.message ?? error}`)
    }
    const dirs = []
    for (const entry of entries) {
      if (entry.isDirectory()) { dirs.push(entry.name); continue }
      // 指向目录的符号链接也列出（外置卷、修复过的备份等常见形态）
      if (entry.isSymbolicLink()) {
        try {
          if (statSync(join(target, entry.name)).isDirectory()) dirs.push(entry.name)
        } catch {}
      }
    }
    dirs.sort((a, b) => a.localeCompare(b))
    const parent = dirname(target)
    return { path: target, parent: parent === target ? null : parent, home: homedir(), dirs }
  }

  projectView(project) {
    const group = this.groupOf(project.id)
    const members = this.membersWithUsage(project.id)
    const taskCounts = this.store.all(
      'SELECT status, COUNT(*) AS count FROM tasks WHERE project_id = ? GROUP BY status',
      project.id,
    )
    const counts = Object.fromEntries(taskCounts.map(row => [row.status, Number(row.count)]))
    const reviewRows = this.store.all(
      "SELECT review_target, COUNT(*) AS count FROM tasks WHERE project_id = ? AND status = 'in_review' GROUP BY review_target",
      project.id,
    )
    const reviewBy = Object.fromEntries(reviewRows.map(row => [row.review_target ?? 'user', Number(row.count)]))
    const runs = this.store.get(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running FROM runs WHERE project_id = ?",
      project.id,
    )
    const messages = this.store.get('SELECT COUNT(*) AS count FROM messages WHERE project_id = ?', project.id)
    return {
      ...project,
      workspace_path: this.projectWorkDir(project),
      data_path: join(this.config.workspace, project.slug),
      workspace_relative: `/${project.slug}`,
      disabledSkills: parseDisabledSkills(project.disabled_skills),
      group,
      members,
      stats: {
        tasks: Object.values(counts).reduce((sum, value) => sum + value, 0),
        openTasks: Object.entries(counts).filter(([status]) => !['done', 'canceled'].includes(status)).reduce((sum, [, count]) => sum + count, 0),
        inReview: reviewBy.user ?? 0,
        ownerReview: reviewBy.owner_bot ?? 0,
        running: Number(runs?.running ?? 0),
        runs: Number(runs?.total ?? 0),
        messages: Number(messages?.count ?? 0),
      },
    }
  }

  async createProject(input, actor = this.actor()) {
    const name = text(input.name, 80)
    if (!name) throw badRequest('项目名称不能为空')
    let key = projectKey(input.key)
    if (!key) key = `P${Math.floor(Math.random() * 900 + 100)}`
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(key)) throw badRequest('项目 Key 必须以字母开头，只能包含大写字母和数字，最多 10 位')
    if (this.store.get('SELECT id FROM projects WHERE key = ?', key)) throw conflict('项目 Key 已存在')
    const slug = slugify(key)
    if (!slug) throw badRequest('无法从项目 Key 生成工作区目录')
    if (this.store.get('SELECT id FROM projects WHERE slug = ?', slug)) throw conflict('项目工作区目录已存在')
    let owner = input.ownerBotId ? this.botRow(input.ownerBotId) : this.store.get("SELECT * FROM bots WHERE status = 'active' ORDER BY created_at LIMIT 1")
    if (!owner) throw badRequest('请先创建至少一个 Bot')
    if (owner.status !== 'active') throw badRequest('总监 Bot 不可用')
    const projectId = id('prj')
    const groupId = id('grp')
    const createdAt = nowIso()
    const memberIds = [...new Set([owner.id, ...(Array.isArray(input.memberIds) ? input.memberIds : [])])]
    for (const botId of memberIds) this.botRow(botId)
    await ensureProjectWorkspace(this.config.workspace, slug)
    const productionDir = await this.resolveProductionDir(input.productionDir)
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO projects(id, key, name, slug, description, owner_bot_id, status, token_budget, cost_budget, production_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        projectId, key, name, slug, text(input.description, 20_000), owner.id,
        clampNumber(input.tokenBudget, 0, 1e15, null), clampNumber(input.costBudget, 0, 1e12, null),
        productionDir, createdAt, createdAt,
      )
      this.store.run(
        'INSERT INTO group_chats(id, project_id, title, owner_bot_id, reply_mode, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        groupId, projectId, name, owner.id, input.replyMode === 'everyone' ? 'everyone' : 'owner_first', createdAt,
      )
      for (const botId of memberIds) {
        this.store.run(
          'INSERT INTO project_members(project_id, member_type, member_id, member_role, joined_at) VALUES (?, ?, ?, ?, ?)',
          projectId, 'bot', botId, botId === owner.id ? 'owner' : 'member', createdAt,
        )
      }
      this.audit(actor, 'project.create', 'project', projectId, { name, key, owner: owner.id })
    })
    // 团队级密钥已存在时，新项目立即物化 .team/secrets.env，成员 Bot 开箱可用。
    const teamSecrets = this.store.get("SELECT COUNT(*) AS n FROM secrets WHERE scope = 'team'")
    if (Number(teamSecrets?.n) > 0) {
      try {
        await this.materializeProjectSecrets(this.projectRow(projectId))
      } catch (error) {
        this.logger.warn?.(`dsh-team: 新项目 ${projectId} 物化 .team/secrets.env 失败：${error?.message ?? error}`)
      }
    }
    return this.projectView(this.projectRow(projectId))
  }

  async updateProject(projectId, patch, actor = this.actor()) {
    const project = this.projectRow(projectId)
    const updates = {}
    if (patch.name !== undefined) {
      const name = text(patch.name, 80)
      if (!name) throw badRequest('项目名称不能为空')
      updates.name = name
    }
    if (patch.description !== undefined) updates.description = text(patch.description, 20_000)
    if (patch.ownerBotId !== undefined) {
      const owner = this.botRow(patch.ownerBotId)
      if (owner.status !== 'active') throw badRequest('总监 Bot 不可用')
      updates.owner_bot_id = owner.id
    }
    if (patch.tokenBudget !== undefined) updates.token_budget = clampNumber(patch.tokenBudget, 0, 1e15, null)
    if (patch.costBudget !== undefined) updates.cost_budget = clampNumber(patch.costBudget, 0, 1e12, null)
    let productionDirChanged = false
    if (patch.productionDir !== undefined) {
      updates.production_dir = await this.resolveProductionDir(patch.productionDir)
      productionDirChanged = (updates.production_dir ?? null) !== (project.production_dir ?? null)
    }
    if (patch.status !== undefined) {
      if (!['active', 'archived'].includes(patch.status)) throw badRequest('项目状态无效')
      updates.status = patch.status
    }
    if (patch.replyMode !== undefined) {
      if (!['owner_first', 'everyone'].includes(patch.replyMode)) throw badRequest('群聊回复模式无效')
    }
    const ownerId = updates.owner_bot_id ?? project.owner_bot_id
    const memberIds = patch.memberIds === undefined
      ? null
      : [...new Set([ownerId, ...(Array.isArray(patch.memberIds) ? patch.memberIds : [])])]
    if (memberIds) {
      for (const botId of memberIds) this.botRow(botId)
    }
    if (updates.status === 'archived') {
      const active = this.store.all("SELECT id FROM runs WHERE project_id = ? AND status IN ('queued', 'running')", projectId)
      for (const run of active) await this.cancelRunInternal(run.id, false)
    }
    this.store.transaction(() => {
      const fields = []
      const values = []
      for (const [key, value] of Object.entries(updates)) {
        fields.push(`${key} = ?`)
        values.push(value)
      }
      fields.push('updated_at = ?')
      values.push(nowIso())
      this.store.run(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, ...values, projectId)
      if (updates.status === 'archived') {
        const frozen = this.store.all(
          "SELECT id FROM memories WHERE scope_type = 'project' AND scope_id = ? AND status IN ('active', 'pending')",
          projectId,
        )
        for (const memory of frozen) {
          this.store.run("UPDATE memories SET status = 'frozen', updated_at = ? WHERE id = ?", nowIso(), memory.id)
          this.store.run(
            `INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at)
             VALUES (?, ?, 'frozen', ?, ?, 'active', 'frozen', ?)`,
            id('mev'), memory.id, actor.type, actor.id, nowIso(),
          )
        }
      }
      if (updates.name) this.store.run('UPDATE group_chats SET title = ? WHERE project_id = ?', updates.name, projectId)
      if (updates.owner_bot_id) {
        this.store.run('UPDATE group_chats SET owner_bot_id = ? WHERE project_id = ?', updates.owner_bot_id, projectId)
        this.store.run(
          "INSERT INTO project_members(project_id, member_type, member_id, member_role, joined_at) VALUES (?, 'bot', ?, 'owner', ?) ON CONFLICT(project_id, member_type, member_id) DO UPDATE SET member_role = 'owner'",
          projectId, updates.owner_bot_id, nowIso(),
        )
        this.store.run(
          "UPDATE project_members SET member_role = 'member' WHERE project_id = ? AND member_type = 'bot' AND member_id <> ?",
          projectId, updates.owner_bot_id,
        )
      }
      if (patch.replyMode) {
        this.store.run('UPDATE group_chats SET reply_mode = ? WHERE project_id = ?', patch.replyMode, projectId)
      }
      if (memberIds) {
        const keep = memberIds.map(() => '?').join(',')
        this.store.run(
          `DELETE FROM project_members WHERE project_id = ? AND member_type = 'bot' AND member_id NOT IN (${keep})`,
          projectId, ...memberIds,
        )
        for (const botId of memberIds) {
          this.store.run(
            `INSERT INTO project_members(project_id, member_type, member_id, member_role, joined_at)
             VALUES (?, 'bot', ?, ?, ?)
             ON CONFLICT(project_id, member_type, member_id) DO NOTHING`,
            projectId, botId, botId === ownerId ? 'owner' : 'member', nowIso(),
          )
        }
      }
      this.audit(actor, 'project.update', 'project', projectId, updates)
    })
    // 生产目录切换后：旧目录的明文 secrets.env 不许留下；新目录立即物化已有密钥。
    if (productionDirChanged && project.production_dir) {
      try {
        rmSync(join(project.production_dir, '.team', 'secrets.env'), { force: true })
      } catch (error) {
        this.logger.warn?.(`dsh-team: 切换生产目录后清理旧目录密钥失败：${error?.message ?? error}`)
      }
    }
    if (productionDirChanged) {
      const teamSecrets = this.store.get("SELECT COUNT(*) AS n FROM secrets WHERE scope = 'team' OR (scope = 'project' AND project_id = ?)", projectId)
      if (Number(teamSecrets?.n) > 0) {
        try {
          await this.materializeProjectSecrets(this.projectRow(projectId))
        } catch (error) {
          this.logger.warn?.(`dsh-team: 切换生产目录后重新物化密钥失败：${error?.message ?? error}`)
        }
      }
    }
    return this.projectView(this.projectRow(projectId))
  }

  archiveProject(projectId, actor = this.actor()) {
    return this.updateProject(projectId, { status: 'archived' }, actor)
  }

  // 邀请已有 bot 加入项目。与 updateProject 的 memberIds 全量替换不同，这里做增量并给出精确错误语义。
  addProjectMember(projectId, botId, actor = this.actor()) {
    const project = this.projectRow(projectId)
    if (project.status !== 'active') throw badRequest('项目已归档，不能添加成员')
    const bot = this.botRow(botId)
    if (bot.status !== 'active') throw badRequest('Bot 已归档，不能加入项目')
    const existing = this.store.get(
      "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND member_type = 'bot' AND member_id = ?",
      projectId, botId,
    )
    if (existing) throw conflict('该 Bot 已是项目成员')
    this.store.transaction(() => {
      this.store.run(
        "INSERT INTO project_members(project_id, member_type, member_id, member_role, joined_at) VALUES (?, 'bot', ?, 'member', ?)",
        projectId, botId, nowIso(),
      )
      this.audit(actor, 'project.add_member', 'project', projectId, { botId, botName: bot.name })
    })
    return this.projectView(this.projectRow(projectId))
  }

  // 移除项目成员；总监不可移除。移除后 membersOf 不再包含该 bot，本项目 mention 定向随之失效。
  removeProjectMember(projectId, botId, actor = this.actor()) {
    const project = this.projectRow(projectId)
    if (project.status !== 'active') throw badRequest('项目已归档，不能移除成员')
    const bot = this.botRow(botId)
    const member = this.store.get(
      "SELECT * FROM project_members WHERE project_id = ? AND member_type = 'bot' AND member_id = ?",
      projectId, botId,
    )
    if (!member) throw notFound('该 Bot 不是项目成员')
    if (member.member_role === 'owner') throw forbidden('总监不可移除')
    this.store.transaction(() => {
      this.store.run(
        "DELETE FROM project_members WHERE project_id = ? AND member_type = 'bot' AND member_id = ?",
        projectId, botId,
      )
      this.audit(actor, 'project.remove_member', 'project', projectId, { botId, botName: bot.name })
    })
    return this.projectView(this.projectRow(projectId))
  }

  insertMessage({ projectId, senderType, senderId, body, mentions = [], taskId = null, runId = null, replyToId = null, createdAt = nowIso() }) {
    const group = this.groupOf(projectId)
    if (!group) throw notFound('项目群聊不存在')
    const messageId = id('msg')
    // 群消息持久化前过密钥掩码：密文值不进转录，模型下一轮只会看到 $<NAME> 标签（NAME 与 .team/secrets.env 里的变量名一致）。
    const maskedBody = this.maskSecretValues(body)
    this.store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, task_id, run_id, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      messageId, projectId, group.id, senderType, senderId, maskedBody, JSON.stringify(mentions), taskId, runId, replyToId, createdAt,
    )
    return messageId
  }

  // 消息发送者显示名：bot 查名字，system 固定「系统」，其余按用户 actor 取名。
  senderNameOf(senderType, senderId) {
    if (senderType === 'bot') return this.store.get('SELECT name FROM bots WHERE id = ?', senderId)?.name ?? 'Bot'
    if (senderType === 'system') return '系统'
    return this.actorName({ type: 'user', id: senderId })
  }

  // 引用视图：excerpt 取原消息正文前 120 字。入库正文已过 maskSecretValues，这里不再掩码；
  // 目标行已被删（/clear 或级联）时 reply_to 置 null，引用悬空不炸视图。
  replyView(replyToId) {
    if (!replyToId) return null
    const row = this.store.get('SELECT id, sender_type, sender_id, body FROM messages WHERE id = ?', replyToId)
    if (!row) return null
    return { id: row.id, sender_name: this.senderNameOf(row.sender_type, row.sender_id), excerpt: row.body.slice(0, 120) }
  }

  messageView(row) {
    const senderName = this.senderNameOf(row.sender_type, row.sender_id)
    const task = row.task_id ? this.store.get('SELECT number, title, project_id FROM tasks WHERE id = ?', row.task_id) : undefined
    const project = task ? this.store.get('SELECT key FROM projects WHERE id = ?', task.project_id) : undefined
    return {
      ...row,
      mentions: jsonParse(row.mentions_json, []),
      senderName,
      reply_to: this.replyView(row.reply_to_id),
      taskIdentifier: task && project ? `${project.key}-${task.number}` : null,
      taskTitle: task?.title ?? null,
    }
  }

  async sendMessage(projectId, bodyInput, actor = this.actor(), replyTo = null) {
    const project = this.projectRow(projectId)
    if (project.status !== 'active') throw conflict('项目已归档')
    const body = text(bodyInput, 20_000)
    if (!body) throw badRequest('消息不能为空')
    const members = this.membersOf(projectId).filter(bot => bot.status === 'active')
    if (commandClearPattern.test(body)) {
      const cleared = this.clearChatHistory(projectId, actor)
      return { cleared }
    }
    if (commandRememberPattern.test(body)) {
      const messageId = this.insertMessage({
        projectId,
        senderType: actor.type,
        senderId: actor.id,
        body,
      })
      await this.rememberCommand(projectId, body, actor)
      return { messageId, memory: true }
    }
    const command = commandTaskPattern.exec(body)
    if (command) {
      const assigneeName = command[1]
      const title = text(command[2].split('\n')[0], 200)
      if (!title) throw badRequest('任务标题不能为空')
      const assignee = members.find(bot => bot.name === assigneeName)
      if (!assignee) throw badRequest(`@${assigneeName} 不是该项目成员`)
      const messageId = this.insertMessage({
        projectId,
        senderType: actor.type,
        senderId: actor.id,
        body,
        mentions: [assignee.id],
      })
      const task = await this.createTask({
        projectId,
        title,
        description: command[2],
        assigneeBotId: assignee.id,
        priority: 'medium',
        autoStart: true,
        sourceMessageId: messageId,
        postCard: true,
      }, actor)
      this.store.run('UPDATE messages SET task_id = ? WHERE id = ?', task.id, messageId)
      return { messageId, taskId: task.id }
    }
    // 引用回复：目标消息必须存在于同项目，否则 400。命令路径（/clear、/remember、/task）不走到这里，按规格忽略引用。
    const replyMessage = replyTo
      ? this.store.get('SELECT id, sender_type, sender_id FROM messages WHERE id = ? AND project_id = ?', String(replyTo), projectId)
      : null
    if (replyTo && !replyMessage) throw badRequest('引用的消息不存在')
    const mentions = parseMentions(body, members)
    // 目标解析：显式 @mention 优先（引用只作上下文）；无显式 @ 时引用 bot 消息则定向该 bot（替换 owner 兜底）；最后落 owner。
    const targets = (mentions.length > 0
      ? mentions
      : members.filter(bot => bot.id === (replyMessage?.sender_type === 'bot' ? replyMessage.sender_id : project.owner_bot_id))
    ).slice(0, 3)
    const messageId = this.insertMessage({
      projectId,
      senderType: actor.type,
      senderId: actor.id,
      body,
      mentions: mentions.map(bot => bot.id),
      replyToId: replyMessage?.id ?? null,
    })
    for (const bot of targets) {
      this.enqueueOutbox({
        kind: 'chat_run',
        payload: { projectId: project.id, botId: bot.id, messageId },
        projectId: project.id,
        sourceId: messageId,
        idempotencyKey: `chat:${messageId}:${bot.id}`,
      })
    }
    void this.tick()
    return { messageId, runBots: targets.map(bot => bot.id) }
  }

  // /clear：清空本群全部聊天记录。任务、记忆等不受影响；操作进审计。
  clearChatHistory(projectId, actor = this.actor()) {
    const project = this.projectRow(projectId)
    const count = Number(this.store.get('SELECT COUNT(*) AS count FROM messages WHERE project_id = ?', project.id)?.count ?? 0)
    this.store.run('DELETE FROM messages WHERE project_id = ?', project.id)
    this.audit(actor, 'chat.clear', 'project', project.id, { cleared: count })
    return count
  }

  async rememberCommand(projectId, body, actor) {
    const matched = commandRememberPattern.exec(body)
    if (!matched) return false
    const project = this.projectRow(projectId)
    this.createMemory({
      scopeType: 'project',
      scopeId: project.id,
      topic: body.slice(10, 60),
      content: matched[1],
      source: 'chat-command',
      createdBy: `${actor.type}:${actor.id}`,
    })
    this.insertMessage({
      projectId,
      senderType: 'system',
      senderId: 'system',
      body: '已写入项目记忆。',
    })
    return true
  }

  // ===== 单聊：项目外与单个 Bot 的一对一会话，工作目录 _the_bots/<solo_dir> =====

  insertSoloMessage({ botId, senderType, senderId, body, runId = null, createdAt = nowIso() }) {
    const messageId = id('msg')
    // 单聊同样过密钥掩码：单聊正文会进模型上下文，明文密钥不该落库。
    const maskedBody = this.maskSecretValues(body)
    this.store.run(
      `INSERT INTO solo_messages(id, bot_id, sender_type, sender_id, body, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      messageId, botId, senderType, senderId, maskedBody, runId, createdAt,
    )
    return messageId
  }

  soloMessageView(row) {
    const senderName = row.sender_type === 'bot'
      ? this.store.get('SELECT name FROM bots WHERE id = ?', row.sender_id)?.name ?? 'Bot'
      : row.sender_type === 'system' ? '系统' : this.actorName({ type: 'user', id: row.sender_id })
    return { ...row, senderName }
  }

  clearSoloHistory(botId, actor = this.actor()) {
    const bot = this.botRow(botId)
    const count = Number(this.store.get('SELECT COUNT(*) AS count FROM solo_messages WHERE bot_id = ?', bot.id)?.count ?? 0)
    this.store.run('DELETE FROM solo_messages WHERE bot_id = ?', bot.id)
    this.audit(actor, 'chat.solo_clear', 'bot', bot.id, { cleared: count })
    return count
  }

  async sendSoloMessage(botId, bodyInput, actor = this.actor()) {
    const bot = this.botRow(botId)
    if (bot.status !== 'active') throw conflict('Bot 已归档或暂停')
    const body = text(bodyInput, 20_000)
    if (!body) throw badRequest('消息不能为空')
    if (commandClearPattern.test(body)) {
      const cleared = this.clearSoloHistory(bot.id, actor)
      return { cleared }
    }
    if (commandRememberPattern.test(body)) {
      const matched = commandRememberPattern.exec(body)
      const messageId = this.insertSoloMessage({
        botId: bot.id,
        senderType: actor.type,
        senderId: actor.id,
        body,
      })
      this.createMemory({
        scopeType: 'bot',
        scopeId: bot.id,
        topic: body.slice(10, 60),
        content: matched[1],
        source: 'chat-command',
        createdBy: `${actor.type}:${actor.id}`,
      })
      this.insertSoloMessage({
        botId: bot.id,
        senderType: 'system',
        senderId: 'system',
        body: `已写入 ${bot.name} 的记忆。`,
      })
      return { messageId, memory: true }
    }
    const messageId = this.insertSoloMessage({
      botId: bot.id,
      senderType: actor.type,
      senderId: actor.id,
      body,
    })
    this.enqueueOutbox({
      kind: 'solo_chat_run',
      payload: { botId: bot.id, messageId },
      projectId: null,
      sourceId: messageId,
      idempotencyKey: `solo_chat:${messageId}`,
    })
    void this.tick()
    return { messageId, runBot: bot.id }
  }

  async createTask(input, actor = this.actor()) {
    const project = this.projectRow(input.projectId)
    if (project.status !== 'active') throw conflict('项目已归档')
    const title = text(input.title, 240)
    if (!title) throw badRequest('任务标题不能为空')
    const assigneeId = input.assigneeBotId || null
    if (assigneeId) this.assertMember(project.id, assigneeId)
    const status = input.status && TASK_STATUSES.has(input.status) ? input.status : (assigneeId ? 'todo' : 'backlog')
    const priority = TASK_PRIORITIES.has(input.priority) ? input.priority : 'medium'
    const writeScopes = parseWriteScopes(input.writeScopes)
    const taskId = id('task')
    const createdAt = nowIso()
    let number
    this.store.transaction(() => {
      number = Number(this.store.get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE project_id = ?', project.id)?.n ?? 1)
      this.store.run(
        `INSERT INTO tasks(id, project_id, number, title, description, status, priority, assignee_bot_id,
          creator_type, creator_id, review_target, source_message_id, parent_id, position, due_at, estimate,
          write_scopes, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        taskId, project.id, number, title, text(input.description, 40_000), status, priority,
        assigneeId, actor.type, actor.id, actor.type === 'bot' ? 'owner_bot' : 'user',
        input.sourceMessageId ?? null, input.parentId ?? null,
        Number.isFinite(Number(input.position)) ? Number(input.position) : number,
        input.dueAt ? new Date(input.dueAt).toISOString() : null,
        clampNumber(input.estimate, 0, 1000, null), JSON.stringify(writeScopes), createdAt, createdAt,
      )
      for (const label of Array.isArray(input.labels) ? input.labels.slice(0, 12) : []) {
        const clean = text(label, 40).toLowerCase()
        if (clean) this.store.run('INSERT OR IGNORE INTO task_labels(task_id, label) VALUES (?, ?)', taskId, clean)
      }
      for (const dependency of Array.isArray(input.dependsOn) ? input.dependsOn.slice(0, 20) : []) {
        if (dependency !== taskId && this.store.get('SELECT id FROM tasks WHERE id = ? AND project_id = ?', dependency, project.id)) {
          this.store.run('INSERT OR IGNORE INTO task_dependencies(task_id, depends_on_task_id) VALUES (?, ?)', taskId, dependency)
        }
      }
      this.addTaskEvent(taskId, 'created', actor, { status, assigneeBotId: assigneeId })
      this.audit(actor, 'task.create', 'task', taskId, { title, assigneeId, status })
    })
    if (input.postCard !== false) {
      this.insertMessage({
        projectId: project.id,
        senderType: 'system',
        senderId: 'system',
        body: `任务 ${project.key}-${number}：${title}${assigneeId ? ` → @${this.botRow(assigneeId).name}` : ''}`,
        taskId,
      })
    }
    if (input.autoStart && assigneeId) {
      this.enqueueOutbox({
        kind: 'task_run',
        payload: { taskId, triggerType: 'task_created' },
        projectId: project.id,
        taskId,
        idempotencyKey: `task:${taskId}:task_created`,
      })
    }
    void this.tick()
    return this.taskView(this.taskRow(taskId))
  }

  addTaskEvent(taskId, type, actor, data = {}) {
    this.store.run(
      'INSERT INTO task_events(id, task_id, type, actor_type, actor_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id('tevt'), taskId, type, actor.type, actor.id, JSON.stringify(data), nowIso(),
    )
  }

  taskView(task) {
    const labels = this.store.all('SELECT label FROM task_labels WHERE task_id = ? ORDER BY label', task.id).map(row => row.label)
    const runs = this.store.all(
      'SELECT id, status, attempt, started_at, ended_at, error_code, error_message FROM runs WHERE task_id = ? ORDER BY queued_at DESC LIMIT 10',
      task.id,
    )
    const project = this.store.get('SELECT key FROM projects WHERE id = ?', task.project_id)
    const { write_scopes: rawScopes, ...rest } = task
    return {
      ...rest,
      identifier: `${project?.key ?? 'T'}-${task.number}`,
      labels,
      writeScopes: readWriteScopes(rawScopes),
      comments: Number(this.store.get('SELECT COUNT(*) AS count FROM task_comments WHERE task_id = ?', task.id)?.count ?? 0),
      latestRun: runs[0] ?? null,
      runs,
    }
  }

  async updateTask(taskId, patch, actor = this.actor()) {
    const task = this.taskRow(taskId)
    if (patch.version !== undefined && Number(patch.version) !== Number(task.version)) {
      throw conflict('任务已被其他人更新，请刷新后重试')
    }
    const updates = {}
    if (patch.title !== undefined) {
      const title = text(patch.title, 240)
      if (!title) throw badRequest('任务标题不能为空')
      updates.title = title
    }
    if (patch.description !== undefined) updates.description = text(patch.description, 40_000)
    if (patch.priority !== undefined) {
      if (!TASK_PRIORITIES.has(patch.priority)) throw badRequest('优先级无效')
      updates.priority = patch.priority
    }
    if (patch.assigneeBotId !== undefined) {
      if (patch.assigneeBotId) this.assertMember(task.project_id, patch.assigneeBotId)
      updates.assignee_bot_id = patch.assigneeBotId || null
    }
    if (patch.position !== undefined) updates.position = Number(patch.position) || 0
    if (patch.dueAt !== undefined) updates.due_at = patch.dueAt ? new Date(patch.dueAt).toISOString() : null
    if (patch.estimate !== undefined) updates.estimate = clampNumber(patch.estimate, 0, 1000, null)
    if (patch.writeScopes !== undefined) {
      updates.write_scopes = JSON.stringify(parseWriteScopes(patch.writeScopes))
    }
    if (patch.status !== undefined) {
      if (!TASK_STATUSES.has(patch.status)) throw badRequest('任务状态无效')
      this.assertTransition(task.status, patch.status)
      updates.status = patch.status
      updates.completed_at = patch.status === 'done' ? nowIso() : null
    }
    if (Object.keys(updates).length === 0) return this.taskView(task)
    this.store.transaction(() => {
      const fields = Object.entries(updates).map(([key]) => `${key} = ?`)
      this.store.run(
        `UPDATE tasks SET ${fields.join(', ')}, version = version + 1, updated_at = ? WHERE id = ?`,
        ...Object.values(updates), nowIso(), taskId,
      )
      for (const field of Object.keys(updates)) {
        const type = field === 'status' ? 'status' : field === 'assignee_bot_id' ? 'assigned' : 'updated'
        this.addTaskEvent(taskId, type, actor, { field, from: task[field] ?? null, to: updates[field] })
      }
      if (patch.labels !== undefined && Array.isArray(patch.labels)) {
        this.store.run('DELETE FROM task_labels WHERE task_id = ?', taskId)
        for (const label of patch.labels.slice(0, 12)) {
          const clean = text(label, 40).toLowerCase()
          if (clean) this.store.run('INSERT OR IGNORE INTO task_labels(task_id, label) VALUES (?, ?)', taskId, clean)
        }
      }
      this.audit(actor, 'task.update', 'task', taskId, updates)
    })
    if (updates.status === 'canceled') await this.cancelRunsForTask(taskId)
    return this.taskView(this.taskRow(taskId))
  }

  assertTransition(from, to) {
    if (from === to) return
    if (!TRANSITIONS[from]?.has(to)) throw conflict(`任务不能从 ${from} 变为 ${to}`)
  }

  async assignTask(taskId, botId, actor = this.actor(), { autoStart = true } = {}) {
    const task = this.taskRow(taskId)
    const project = this.projectRow(task.project_id)
    this.assertMember(project.id, botId)
    const active = this.store.get(
      "SELECT id, kind FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      taskId,
    )
    if (active && active.kind === 'task' && task.assignee_bot_id !== botId) throw conflict('任务有正在执行的运行，不能更换负责人')
    this.store.transaction(() => {
      this.store.run(
        `UPDATE tasks SET assignee_bot_id = ?, review_target = ?,
          status = CASE WHEN status IN ('backlog', 'blocked') THEN 'todo' ELSE status END,
          version = version + 1, updated_at = ? WHERE id = ?`,
        botId, actor.type === 'bot' ? 'owner_bot' : 'user', nowIso(), taskId,
      )
      this.addTaskEvent(taskId, 'assigned', actor, { botId })
      this.audit(actor, 'task.assign', 'task', taskId, { botId })
    })
    // 总监bot的验收/受阻处理运行本身占用任务的唯一活动运行名额，
    // 此时由 finishRun 的收尾逻辑负责重新排队执行，这里跳过。
    if (!active) {
      this.enqueueOutbox({
        kind: 'task_run',
        payload: { taskId, triggerType: 'assigned' },
        projectId: task.project_id,
        taskId,
        idempotencyKey: `task:${taskId}:assigned`,
      })
    }
    if (autoStart) void this.tick()
    return this.taskView(this.taskRow(taskId))
  }

  async transitionTask(taskId, status, actor = this.actor()) {
    return this.updateTask(taskId, { status }, actor)
  }

  async addComment(taskId, bodyInput, actor = this.actor()) {
    const task = this.taskRow(taskId)
    const body = text(bodyInput, 20_000)
    if (!body) throw badRequest('评论不能为空')
    const commentId = id('cmt')
    this.store.transaction(() => {
      this.store.run(
        'INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        commentId, taskId, actor.type, actor.id, body, nowIso(),
      )
      this.addTaskEvent(taskId, 'commented', actor, { commentId })
      this.audit(actor, 'task.comment', 'task', taskId, { commentId })
    })
    const comment = this.store.get('SELECT * FROM task_comments WHERE id = ?', commentId)
    const steered = await this.steerRunningTaskRun(task, comment, actor)
    return { ...comment, steered }
  }

  // 任务运行期间的评论直接投递给正在执行的会话，避免只能等下一次运行才被读到。
  async steerRunningTaskRun(task, comment, actor) {
    if (!this.runtime?.steer || actor.type === 'bot') return false
    const run = this.store.get(
      "SELECT * FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      task.id,
    )
    if (!run?.session_id) return false
    const project = this.store.get('SELECT key FROM projects WHERE id = ?', task.project_id)
    const author = this.actorName(actor)
    try {
      await this.runtime.steer(
        run.session_id,
        `New comment on ${project?.key ?? 'TASK'}-${task.number} from ${author}:\n${comment.body}\n\nIf this changes the plan, adjust the work in progress; otherwise keep going and mention it in the delivery report.`,
      )
      this.store.run(
        'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
        id('evt'), run.id, 'steered', `评论直通（${author}）`, nowIso(),
      )
      return true
    } catch (error) {
      this.logger.warn?.('dsh-team: steer run %s failed: %s', run.id, error)
      return false
    }
  }

  enqueueTaskRun(task, triggerType, actor) {
    if (!task.assignee_bot_id) throw badRequest('任务没有负责人')
    if (task.status === 'done' || task.status === 'canceled') throw conflict('已完成或取消的任务不能运行')
    const active = this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      task.id,
    )
    if (active) return active.id
    const runId = id('run')
    const createdAt = nowIso()
    // 写范围在入队时快照：任务后续改声明不影响已排队的运行。
    const writeScopes = JSON.stringify(readWriteScopes(task.write_scopes))
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, write_scopes, queued_at)
       VALUES (?, ?, ?, ?, 'task', 'write', ?, ?, 'queued', 1, ?, ?, ?)`,
      runId, task.project_id, task.assignee_bot_id, task.id, triggerType, task.id, `task:${task.id}:${Date.now()}:${runId}`, writeScopes, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued', `由 ${actor.type}:${actor.id} 触发`, createdAt,
    )
    return runId
  }

  enqueueOwnerTaskRun(task, kind) {
    const project = this.projectRow(task.project_id)
    const owner = project.owner_bot_id
      ? this.store.get("SELECT * FROM bots WHERE id = ? AND status = 'active'", project.owner_bot_id)
      : null
    if (!owner) return null
    const active = this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      task.id,
    )
    if (active) return active.id
    const runId = id('run')
    const createdAt = nowIso()
    const triggerType = kind === 'review' ? 'review_requested' : 'blocked_handoff'
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, ?, ?, 'read', ?, ?, 'queued', 1, ?, ?)`,
      runId, project.id, owner.id, task.id, kind, triggerType, task.id,
      `${kind}:${task.id}:${Date.now()}:${runId}`, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued',
      kind === 'review' ? '任务交付，转总监验收' : '任务受阻，转总监处理',
      createdAt,
    )
    void this.tick()
    return runId
  }

  resolveBotTask(project, ref) {
    const raw = String(ref ?? '').trim()
    if (!raw) throw badRequest('缺少任务编号')
    let task
    if (raw.startsWith('task_')) {
      task = this.store.get('SELECT * FROM tasks WHERE id = ? AND project_id = ?', raw, project.id)
    } else {
      const match = raw.match(/^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d+)$/)
      if (match && (!match[1] || match[1].toLowerCase() === project.key.toLowerCase())) {
        task = this.store.get('SELECT * FROM tasks WHERE project_id = ? AND number = ?', project.id, Number(match[2]))
      }
    }
    if (!task) throw notFound(`找不到任务 ${raw}`)
    return task
  }

  ownerContextFor(sessionId) {
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw forbidden('只有项目群中的 Bot 可以执行该操作')
    if (!binding.project_id) throw forbidden('单聊会话不在项目中，无法管理任务')
    const project = this.projectRow(binding.project_id)
    if (project.owner_bot_id !== binding.bot_id) throw forbidden('只有项目总监 Bot 可以执行该操作')
    return { binding, project, actor: { type: 'bot', id: binding.bot_id } }
  }

  // 按需展开一条被截断的上下文：m_/c_/run_ 短 id 或任务编号 KEY-N。
  recall(sessionId, ref) {
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw forbidden('当前会话不属于任何项目')
    const raw = String(ref ?? '').trim()
    if (!raw) throw badRequest('缺少要展开的引用 id')
    if (!binding.project_id) {
      // 单聊会话：没有项目上下文，只能展开本会话的消息引用。
      if (!raw.startsWith('m_')) throw notFound('单聊会话中只支持展开 m_ 消息引用')
      const message = this.store.get(
        'SELECT * FROM solo_messages WHERE bot_id = ? AND substr(id, -6) = ?',
        binding.bot_id, raw.slice(2),
      )
      if (!message) throw notFound('消息不存在')
      return `[${raw}] ${message.sender_type}:${message.sender_id} at ${message.created_at}\n\n${message.body}`
    }
    const project = this.projectRow(binding.project_id)

    if (raw.startsWith('m_')) {
      const message = this.store.get(
        'SELECT * FROM messages WHERE project_id = ? AND substr(id, -6) = ?',
        project.id, raw.slice(2),
      )
      if (!message) throw notFound('消息不存在')
      return `[${raw}] ${message.sender_type}:${message.sender_id} at ${message.created_at}\n\n${message.body}`
    }
    if (raw.startsWith('c_')) {
      const comment = this.store.get(
        `SELECT tc.*, t.number FROM task_comments tc JOIN tasks t ON t.id = tc.task_id
         WHERE t.project_id = ? AND substr(tc.id, -6) = ?`,
        project.id, raw.slice(2),
      )
      if (!comment) throw notFound('评论不存在')
      return `[${raw}] ${project.key}-${comment.number} ${comment.author_type}:${comment.author_id} at ${comment.created_at}\n\n${comment.body}`
    }
    if (raw.startsWith('run_')) {
      const run = this.store.get(
        'SELECT * FROM runs WHERE project_id = ? AND substr(id, -6) = ?',
        project.id, raw.slice(4),
      )
      if (!run) throw notFound('运行不存在')
      return [
        `[${raw}] kind=${run.kind} status=${run.status} bot=${run.bot_id}`,
        run.error_code ? `error=${run.error_code}: ${run.error_message}` : '',
        '',
        run.output ?? '(no output)',
      ].filter(Boolean).join('\n')
    }
    const task = this.resolveBotTask(project, raw)
    const comments = this.store.all(
      'SELECT author_type, author_id, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 10',
      task.id,
    ).reverse()
    return [
      `${project.key}-${task.number} [${task.status}] ${task.title}`,
      `assignee: ${task.assignee_bot_id ?? 'unassigned'} | priority: ${task.priority} | review: ${task.review_target}`,
      '',
      task.description || '(no description)',
      comments.length === 0 ? '' : `\nComments:\n${comments.map(item => `- ${item.author_type}:${item.author_id} (${item.created_at}): ${item.body}`).join('\n')}`,
    ].filter(Boolean).join('\n')
  }

  // outbox：把「状态变更 → 建运行」这一跳变成可重放的持久交接。
  // 写事件时立刻落库，调度器按顺序领取投递，失败退避重试，超过上限转 failed。
  enqueueOutbox({ kind, payload = {}, projectId = null, taskId = null, sourceId = null, idempotencyKey = null }) {
    const now = nowIso()
    const outboxId = id('out')
    this.store.run(
      `INSERT INTO outbox(id, kind, project_id, task_id, source_id, idempotency_key, payload_json,
        status, attempts, available_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      outboxId, kind, projectId, taskId, sourceId, idempotencyKey,
      JSON.stringify(payload), now, now,
    )
    if (idempotencyKey) {
      const existing = this.store.get('SELECT id FROM outbox WHERE idempotency_key = ?', idempotencyKey)
      if (existing && existing.id !== outboxId) return existing.id
    }
    // 事务性 outbox：记录先落库，再立即投递；投递失败留 pending，由调度器重试。
    this.applyOutboxRow(this.store.get('SELECT * FROM outbox WHERE id = ?', outboxId))
    return outboxId
  }

  // 单条投递：成功标记 delivered，失败按退避重试，超过上限转 failed。
  applyOutboxRow(row) {
    if (!row) return null
    try {
      const result = this.applyOutbox(row)
      this.store.run(
        "UPDATE outbox SET status = 'delivered', delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?",
        nowIso(), row.id,
      )
      return result
    } catch (error) {
      const attempts = Number(row.attempts ?? 0) + 1
      const permanent = error?.permanent === true
      const exhausted = permanent || attempts >= 5
      this.store.run(
        `UPDATE outbox SET status = ?, attempts = ?, last_error = ?, available_at = ? WHERE id = ?`,
        exhausted ? 'failed' : 'pending',
        attempts,
        text(error?.message ?? String(error), 500),
        exhausted ? row.available_at : new Date(Date.now() + Math.min(60_000, 1000 * 2 ** attempts)).toISOString(),
        row.id,
      )
      this.logger.warn?.('dsh-team: outbox %s (%s) failed: %s', row.id, row.kind, error?.message ?? error)
      return null
    }
  }

  // outbox 可见性：投递概况与失败明细（运维排查用）。
  outboxView() {
    const failed = this.store.all(
      "SELECT id, kind, task_id, source_id, attempts, last_error, created_at FROM outbox WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20",
    )
    return { ...this.outboxCounts(), failed }
  }

  outboxCounts() {
    const row = this.store.get(
      `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered
         FROM outbox`,
    )
    return {
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      delivered: Number(row?.delivered ?? 0),
    }
  }

  // 领取并投递 outbox 记录；投递成功标记 delivered，失败按指数退避重试。
  dispatchOutbox() {
    const rows = this.store.all(
      "SELECT * FROM outbox WHERE status = 'pending' AND available_at <= ? ORDER BY created_at LIMIT 50",
      nowIso(),
    )
    for (const row of rows) this.applyOutboxRow(row)
  }

  applyOutbox(row) {
    const payload = jsonParse(row.payload_json, {})
    if (row.kind === 'chat_run') {
      const project = this.store.get('SELECT * FROM projects WHERE id = ?', payload.projectId)
      const bot = this.store.get('SELECT * FROM bots WHERE id = ?', payload.botId)
      if (!project || !bot || project.status !== 'active' || bot.status !== 'active') return null
      return this.enqueueChatRun(project, bot, payload.messageId)
    }
    if (row.kind === 'task_run') {
      const task = this.store.get('SELECT * FROM tasks WHERE id = ?', payload.taskId)
      if (!task) return null
      if (['done', 'canceled'].includes(task.status)) return null
      if (!task.assignee_bot_id) {
        const error = badRequest('任务没有负责人')
        error.permanent = true
        throw error
      }
      return this.enqueueTaskRun(task, payload.triggerType ?? 'task_created', { type: 'system', id: 'system' })
    }
    if (row.kind === 'owner_task_run') {
      const task = this.store.get('SELECT * FROM tasks WHERE id = ?', payload.taskId)
      if (!task || ['done', 'canceled'].includes(task.status)) return null
      return this.enqueueOwnerTaskRun(task, payload.reviewKind ?? 'review')
    }
    if (row.kind === 'memory_review') {
      const sourceRun = this.store.get('SELECT * FROM runs WHERE id = ?', payload.sourceRunId)
      if (!sourceRun) return null
      const task = sourceRun.task_id ? this.store.get('SELECT * FROM tasks WHERE id = ?', sourceRun.task_id) : null
      if (!task) return null
      const project = this.projectRow(sourceRun.project_id)
      const bot = this.botRow(sourceRun.bot_id)
      const reviewRunId = this.enqueueMemoryReview(project, bot, task, sourceRun.id)
      if (!reviewRunId) {
        // 记忆审查未启用：按规则沉淀兜底，保证任务交付有沉淀。
        this.learnFromTask(project, bot, task, sourceRun.output ?? '', sourceRun.id)
      }
      return reviewRunId
    }
    if (row.kind === 'solo_chat_run') {
      const bot = this.store.get('SELECT * FROM bots WHERE id = ?', payload.botId)
      if (!bot || bot.status !== 'active') return null
      return this.enqueueSoloChatRun(bot, payload.messageId)
    }
    if (row.kind === 'dm_run') {
      const message = this.store.get('SELECT * FROM bot_messages WHERE id = ?', payload.messageId)
      if (!message || message.status !== 'pending') return null
      const target = this.store.get('SELECT * FROM bots WHERE id = ?', message.to_bot_id)
      if (!target || target.status !== 'active') {
        this.store.run(
          "UPDATE bot_messages SET status = 'failed', reply = '目标 Bot 不可用，私信未投递', replied_at = ? WHERE id = ?",
          nowIso(), message.id,
        )
        return null
      }
      return this.enqueueDmRun(message, target)
    }
    if (row.kind === 'dm_reply') {
      const message = this.store.get('SELECT * FROM bot_messages WHERE id = ?', payload.messageId)
      if (!message || message.status !== 'replied') return null
      return this.deliverBotReply(message)
    }
    const error = badRequest(`未知的 outbox 类型 ${row.kind}`)
    error.permanent = true
    throw error
  }

  // 建私信执行运行：目标 Bot 的 dm 会话收到来信，产出回信写入 bot_messages.reply。
  enqueueDmRun(message, target) {
    const existing = this.store.get(
      "SELECT id FROM runs WHERE kind = 'dm' AND trigger_ref = ?",
      message.id,
    )
    if (existing) return existing.id
    const runId = id('run')
    const createdAt = nowIso()
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, 'dm', 'read', 'dm', ?, 'queued', 1, ?, ?)`,
      runId, message.project_id, target.id, message.id, `dm:${message.id}`, createdAt,
    )
    this.store.run(
      "UPDATE bot_messages SET status = 'delivered', run_id = ? WHERE id = ?",
      runId, message.id,
    )
    this.insertRunEvent(runId, 'queued', '收到 team_message_bot 私信，开始处理')
    return runId
  }

  // 回信投递回发送方会话：忙时 steer 注入，闲时排 dm_reply 运行。
  deliverBotReply(message) {
    const caller = this.store.get('SELECT * FROM bots WHERE id = ?', message.from_bot_id)
    if (!caller || caller.status !== 'active') return null
    const kind = message.origin_kind === 'task' ? 'task' : message.origin_kind === 'dm' ? 'dm' : 'project'
    const binding = message.origin_kind === 'task' && message.origin_task_id
      ? this.store.get(
        "SELECT * FROM session_bindings WHERE bot_id = ? AND project_id = ? AND kind = 'task' AND task_id = ?",
        caller.id, message.project_id, message.origin_task_id,
      )
      : this.store.get(
        'SELECT * FROM session_bindings WHERE bot_id = ? AND project_id = ? AND kind = ?',
        caller.id, message.project_id, kind,
      )
    // 无绑定（会话被轮换清理或首次私信）：走 dm_reply 运行，由 startRun 重建会话。
    let plan
    if (!binding) {
      plan = 'run'
    } else {
      try {
        plan = deliveryPlan({ row: message, callerSessionBusy: this.runtime.sessionBusy(binding.session_id) })
      } catch (error) {
        this.logger.warn?.('dsh-team: 私信 %s 投递计划失败：%s', message.id, error?.message ?? error)
        return null
      }
    }
    if (plan === 'steer') {
      const fromBot = this.store.get('SELECT name FROM bots WHERE id = ?', message.to_bot_id)
      void this.runtime.steer(binding.session_id, replyDeliveryPrompt({
        fromBotName: fromBot?.name ?? 'teammate',
        reply: message.reply ?? '',
        originKind: message.origin_kind ?? 'project',
      }))
      this.insertRunEvent(message.run_id, 'reply_delivered', `回信已 steer 注入发送方会话（${message.id.slice(-6)}）`)
      return null
    }
    const runId = id('run')
    const createdAt = nowIso()
    // task_id 留空（one_active_run_per_task 不限 kind，任务排队中投回信会撞索引）；
    // 任务会话定位由 sessionKindFor→bot_messages.origin_kind 完成，不依赖 run.task_id。
    // 幂等：outbox 重投时不能重复建运行，否则唯一索引会直接把重试打成失败。
    const existingRun = this.store.get('SELECT id FROM runs WHERE idempotency_key = ?', `dm_reply:${message.id}`)
    if (existingRun) return existingRun.id
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, NULL, 'dm_reply', 'read', 'dm_reply', ?, 'queued', 1, ?, ?)`,
      runId, message.project_id, caller.id,
      message.id, `dm_reply:${message.id}`, createdAt,
    )
    this.insertRunEvent(runId, 'queued', '私信回信排队投递给发送方会话')
    return runId
  }

  enqueueSoloChatRun(bot, messageId) {
    const existing = this.store.get(
      "SELECT id FROM runs WHERE trigger_ref = ? AND bot_id = ? AND kind = 'solo_chat'",
      messageId,
      bot.id,
    )
    if (existing) return existing.id
    const runId = id('run')
    const createdAt = nowIso()
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, NULL, ?, 'solo_chat', 'write', 'mention', ?, 'queued', 1, ?, ?)`,
      runId, bot.id, messageId, `solo_chat:${messageId}`, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued', '单聊消息触发', createdAt,
    )
    return runId
  }

  enqueueChatRun(project, bot, messageId) {
    if (bot.status !== 'active') return null
    const existing = this.store.get(
      "SELECT id FROM runs WHERE trigger_ref = ? AND bot_id = ? AND kind = 'chat'",
      messageId,
      bot.id,
    )
    if (existing) return existing.id
    const runId = id('run')
    const createdAt = nowIso()
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, 'chat', 'read', 'mention', ?, 'queued', 1, ?, ?)`,
      runId, project.id, bot.id, messageId, `chat:${messageId}:${bot.id}`, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued', '群聊消息触发', createdAt,
    )
    return runId
  }

  async cancelRunInternal(runId, updateTask = true) {
    const run = this.runRow(runId)
    if (!['queued', 'running'].includes(run.status)) return run
    await this.runtime?.cancelRun(runId)
    this.store.run(
      "UPDATE runs SET status = 'canceled', ended_at = ?, cancel_requested = 1 WHERE id = ?",
      nowIso(),
      runId,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'canceled', '运行已取消', nowIso(),
    )
    if (updateTask && run.task_id) {
      this.store.run(
        "UPDATE tasks SET status = 'todo', version = version + 1, updated_at = ? WHERE id = ? AND status = 'in_progress'",
        nowIso(), run.task_id,
      )
      this.addTaskEvent(run.task_id, 'run_canceled', { type: 'system', id: 'system' }, { runId })
    }
    return this.runRow(runId)
  }

  async cancelRun(runId, actor = this.actor()) {
    const run = this.runRow(runId)
    await this.cancelRunInternal(runId, true)
    this.audit(actor, 'run.cancel', 'run', runId, {})
    return this.runRow(runId)
  }

  // 运行轨迹：模型回合、思考文本、助手文本、工具调用与工具结果的展示账本。
  runTrajectory(runId) {
    const run = this.runRow(runId)
    const rows = this.store.all(
      'SELECT seq, kind, title, detail, turn, step, created_at FROM run_trajectory WHERE run_id = ? ORDER BY seq ASC',
      run.id,
    )
    return {
      runId: run.id,
      entries: rows.map(row => ({
        seq: row.seq,
        kind: row.kind,
        title: row.title,
        detail: row.detail,
        turn: row.turn ?? null,
        step: row.step ?? null,
        at: row.created_at,
      })),
    }
  }

  async cancelRunsForTask(taskId) {
    const runs = this.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", taskId)
    for (const run of runs) await this.cancelRunInternal(run.id, false)
  }

  async retryRun(runId, actor = this.actor()) {
    const run = this.runRow(runId)
    if (!['failed', 'canceled'].includes(run.status)) throw conflict('只有失败或已取消的运行可以重试')
    if (!run.task_id) throw badRequest('群聊运行不自动重试，请重新发送消息')
    const task = this.taskRow(run.task_id)
    const active = this.store.get("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)
    if (active) throw conflict('该任务已有活动运行')
    if (!task.assignee_bot_id) throw badRequest('任务没有负责人')
    const newRunId = id('run')
    const createdAt = nowIso()
    // 重试同样按任务当前的写范围声明快照。
    const writeScopes = JSON.stringify(readWriteScopes(task.write_scopes))
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, write_scopes, queued_at)
       VALUES (?, ?, ?, ?, 'task', 'write', 'retry', ?, 'queued', ?, ?, ?, ?)`,
      newRunId, task.project_id, task.assignee_bot_id, task.id, task.id,
      Number(run.attempt) + 1, `retry:${task.id}:${Date.now()}:${newRunId}`, writeScopes, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), newRunId, 'queued', `重试 ${run.attempt}`, createdAt,
    )
    this.addTaskEvent(task.id, 'retried', actor, { runId: newRunId, previousRunId: runId })
    void this.tick()
    return this.store.get('SELECT * FROM runs WHERE id = ?', newRunId)
  }

  // 同一条会话上的运行必须串行；任务运行独占自己的会话，可与群聊回复并行。
  claimKey(run) {
    return run.kind === 'task' && run.task_id ? `task:${run.task_id}` : `bot:${run.bot_id}`
  }

  // 运行超时由 runtime 的定时器负责；这里补充“还活着但没有任何进展”的判定。
  async reapStalledRuns() {
    // 每次现算：全局配置页改值后无需重启，下一次巡检即用新看门狗时效。
    const stallMs = effectiveRunLimits(this.config, key => this.store.setting(key)).stallTimeoutMs
    if (!stallMs) return
    const cutoff = new Date(Date.now() - stallMs).toISOString()
    const stalled = this.store.all(
      `SELECT id, kind, started_at, last_progress_at FROM runs
       WHERE status = 'running' AND COALESCE(last_progress_at, started_at) < ?`,
      cutoff,
    )
    for (const run of stalled) {
      this.logger.warn?.('dsh-team: run %s made no progress since %s', run.id, run.last_progress_at ?? run.started_at)
      try {
        await this.runtime?.cancelRun?.(run.id)
      } catch (error) {
        this.logger.warn?.('dsh-team: cancel stalled run %s failed: %s', run.id, error)
      }
      await this.finishRun({
        runId: run.id,
        status: 'failed',
        output: '',
        error: {
          code: 'RUN_STALLED',
          message: `超过 ${Math.round(stallMs / 60_000)} 分钟没有任何进展，已中止`,
        },
      })
    }
  }

  // 群聊只放结论：压缩空白、取首段、按上限截断。
  chatSummary(output, maxChars = this.config.chatReplyMaxChars) {
    const clean = String(output ?? '').replace(/\s+/g, ' ').trim()
    if (!clean) return '模型未返回文本。'
    if (clean.length <= maxChars) return clean
    return `${clean.slice(0, maxChars).trimEnd()}…`
  }

  async tick() {
    if (this.ticking || !this.started) return
    this.ticking = true
    try {
      this.runMaintenance()
      this.dispatchOutbox()
      await this.reapStalledRuns()
      const activeRows = this.store.all(
        "SELECT bot_id, kind, task_id, project_id, mode, write_scopes FROM runs WHERE status = 'running'",
      )
      const activeKeys = new Set(activeRows.map(row => this.claimKey(row)))
      // 同项目在跑的写运行：按写范围判定能否并行。写范围为空 = 未声明 = 保守串行。
      const activeWriteScopes = new Map()
      for (const row of activeRows) {
        if (row.mode !== 'write' || !row.project_id) continue
        const list = activeWriteScopes.get(row.project_id) ?? []
        list.push(readWriteScopes(row.write_scopes))
        activeWriteScopes.set(row.project_id, list)
      }
      let activeTotal = activeRows.length
      if (activeTotal >= this.config.maxConcurrentRuns) return
      // 出队顺序：任务运行按任务优先级（urgent 先），其余运行视同 high——用户交互不能被任务积压拖死；
      // 同优先级按入队时间，保证 FIFO 不饿死老运行。
      const candidates = this.store.all(
        `SELECT r.* FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
         WHERE r.status = 'queued'
         ORDER BY CASE
           WHEN r.kind <> 'task' OR t.priority IS NULL THEN 1
           WHEN t.priority = 'urgent' THEN 0
           WHEN t.priority = 'high' THEN 1
           WHEN t.priority = 'medium' THEN 2
           WHEN t.priority = 'low' THEN 3
           ELSE 4
         END, r.queued_at
         LIMIT 50`,
      )
      for (const run of candidates) {
        if (activeTotal >= this.config.maxConcurrentRuns) break
        const claimKey = this.claimKey(run)
        if (activeKeys.has(claimKey)) continue
        // 同一项目共享一个工作目录：写运行之间按「声明的写范围」判定能否并行——
        // 两侧都声明了写范围且路径前缀互不重叠才放行；任一未声明（空集合）按保守串行，
        // 不降低既有安全边界。只读运行不受影响。
        // 单聊运行 project_id 为空，写锁落在各自独立的 _the_bots/<dir>，不占项目锁。
        const writeScopes = run.mode === 'write' ? readWriteScopes(run.write_scopes) : []
        if (run.mode === 'write' && run.project_id) {
          const runningScopes = activeWriteScopes.get(run.project_id) ?? []
          if (runningScopes.some(other => writeScopesOverlap(writeScopes, other))) continue
        }
        const needsProject = run.kind !== 'solo_chat'
        const project = run.project_id ? this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id) : null
        const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
        if (!bot || (needsProject && !project)) {
          await this.finishRun({ runId: run.id, status: 'failed', output: '', error: { code: 'MISSING_CONTEXT', message: '项目或 Bot 已删除' } })
          continue
        }
        if (bot.status !== 'active' || (needsProject && project.status !== 'active')) {
          await this.finishRun({ runId: run.id, status: 'failed', output: '', error: { code: 'UNAVAILABLE', message: '项目或 Bot 不可用' } })
          continue
        }
        const budgetError = this.budgetError(needsProject ? project : null)
        if (budgetError) {
          await this.finishRun({ runId: run.id, status: 'failed', output: '', error: { code: 'BUDGET_EXCEEDED', message: budgetError } })
          continue
        }
        const claimed = this.store.run(
          "UPDATE runs SET status = 'running', started_at = ?, last_progress_at = ? WHERE id = ? AND status = 'queued'",
          nowIso(), nowIso(), run.id,
        )
        if (Number(claimed.changes) !== 1) continue
        activeTotal += 1
        activeKeys.add(claimKey)
        if (run.mode === 'write' && run.project_id) {
          const list = activeWriteScopes.get(run.project_id) ?? []
          // 与同项目在跑的写运行写范围不重叠：记一条并行放行事件，便于事后排查。
          const parallel = list.length > 0 && writeScopes.length > 0
          list.push(writeScopes)
          activeWriteScopes.set(run.project_id, list)
          if (parallel) {
            this.store.run(
              'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
              id('evt'), run.id, 'run_parallel', '写范围与同项目在跑的写运行不重叠，并行放行', nowIso(),
            )
          }
        }
        if (run.task_id && run.kind === 'task') {
          this.store.run(
            "UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'canceled')",
            nowIso(), run.task_id,
          )
          this.addTaskEvent(run.task_id, 'run_started', { type: 'system', id: 'system' }, { runId: run.id })
        }
        void this.executeRun(run.id)
      }
    } catch (error) {
      this.logger.error?.('dsh-team: scheduler tick failed: %s', error)
    } finally {
      this.ticking = false
    }
  }

  globalBudget() {
    const token = Number(this.store.setting('global_token_budget', '') || 0)
    const cost = Number(this.store.setting('global_cost_budget', '') || 0)
    return {
      tokenBudget: Number.isFinite(token) && token > 0 ? token : 0,
      costBudget: Number.isFinite(cost) && cost > 0 ? cost : 0,
    }
  }

  // 成本不完整时（部分调用没有命中价格表）按 token 占比折算，
  // 否则未计价调用会被当成 0 成本，预算就会低估真实花销。
  estimatedCost(usage) {
    if (usage.cost === null) return null
    if (usage.costComplete) return usage.cost
    const pricedTokens = usage.totalTokens - Number(usage.unpricedTokens ?? 0)
    if (pricedTokens <= 0) return usage.cost
    return usage.cost * (usage.totalTokens / pricedTokens)
  }

  // budgetError(project 传 null 表示项目外运行，只受全局预算约束)
  budgetError(project) {
    const currency = this.budgetCurrency()
    const global = this.globalBudget()
    if (global.tokenBudget || global.costBudget) {
      const usage = monthUsageGlobal(this.store, currency)
      if (global.tokenBudget && usage.totalTokens >= global.tokenBudget) {
        return `全局本月 token 预算已用尽（${usage.totalTokens}/${Math.round(global.tokenBudget)}）`
      }
      const cost = this.estimatedCost(usage)
      if (global.costBudget && cost !== null && cost >= global.costBudget) {
        const hint = usage.costComplete ? '' : '（含未计价调用的估算值）'
        return `全局本月成本预算已用尽（${cost.toFixed(4)}/${global.costBudget} ${currency}${hint}）`
      }
    }
    if (!project || (!project.token_budget && !project.cost_budget)) return null
    const usage = monthUsageForProject(this.store, project.id, currency)
    if (project.token_budget && usage.totalTokens >= project.token_budget) {
      return `项目本月 token 预算已用尽（${usage.totalTokens}/${Math.round(project.token_budget)}）`
    }
    const cost = this.estimatedCost(usage)
    if (project.cost_budget && cost !== null && cost >= project.cost_budget) {
      const hint = usage.costComplete ? '' : '（含未计价调用的估算值）'
      return `项目本月成本预算已用尽（${cost.toFixed(4)}/${project.cost_budget} ${currency}${hint}）`
    }
    return null
  }

  // 定期维护：用量对账 + 数据保留清理。
  runMaintenance({ force = false } = {}) {
    const now = Date.now()
    if (!force && now - this.lastMaintenanceAt < 10 * 60 * 1000) return null
    this.lastMaintenanceAt = now
    // 先清理再对账：被保留期清掉的明细不该再被算成「用量丢失」。
    const retention = applyRetention(this.store, {
      usageDays: Number(this.store.setting('retention_usage_days', '0') || 0),
      runEventDays: Number(this.store.setting('retention_run_event_days', '0') || 0),
      messageDays: Number(this.store.setting('retention_message_days', '0') || 0),
      reconciliationDays: Number(this.store.setting('retention_reconciliation_days', '30') || 0),
    })
    const reconciliation = reconcileUsage(this.store, { days: 30, expiredBefore: retention.usage.before })
    const reapedMessages = this.reapStuckMessages()
    return { reconciliation, retention, reapedMessages }
  }

  // 私信卡死回收：消息停在 pending 说明入队或投递链路断了。
  // 没有 outbox 行的补一条，终态 failed 的行重置后重排，
  // 免得一条私信永远停在「已入库但没人投递」的状态。
  reapStuckMessages({ minAgeMs = 60_000, limit = 50 } = {}) {
    const cutoff = new Date(Date.now() - minAgeMs).toISOString()
    const rows = this.store.all(
      "SELECT id, project_id FROM bot_messages WHERE status = 'pending' AND created_at <= ? LIMIT ?",
      cutoff, limit,
    )
    let recovered = 0
    for (const row of rows) {
      const outboxRow = this.store.get('SELECT * FROM outbox WHERE idempotency_key = ?', `dm_run:${row.id}`)
      if (!outboxRow) {
        this.enqueueOutbox({
          kind: 'dm_run',
          payload: { messageId: row.id },
          projectId: row.project_id,
          sourceId: row.id,
          idempotencyKey: `dm_run:${row.id}`,
        })
        recovered += 1
        continue
      }
      if (outboxRow.status === 'failed') {
        this.store.run(
          "UPDATE outbox SET status = 'pending', attempts = 0, available_at = ?, last_error = NULL WHERE id = ?",
          nowIso(), outboxRow.id,
        )
        recovered += 1
      }
    }
    if (recovered) this.logger.warn?.('dsh-team: 回收卡住的私信 %s 条', recovered)
    return recovered
  }

  async executeRun(runId) {
    const run = this.runRow(runId)
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
    const project = run.project_id ? this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id) : null
    try {
      const task = run.task_id ? this.taskRow(run.task_id) : null
      const chatMessage = run.kind === 'chat' && run.trigger_ref
        ? this.store.get('SELECT * FROM messages WHERE id = ?', run.trigger_ref)
        : run.kind === 'solo_chat' && run.trigger_ref
          ? this.store.get('SELECT * FROM solo_messages WHERE id = ?', run.trigger_ref)
          : null
      if (run.mode === 'read') this.fingerprints.set(runId, this.workspaceFingerprint(project))
      const sessionKind = this.sessionKindFor(run)
      await this.runtime.startRun({
        run,
        bot,
        project,
        task: task ?? this.sessionTaskFor(run, sessionKind),
        chatMessage,
        sessionKind,
      })
    } catch (error) {
      this.logger.warn?.('dsh-team: run %s failed to start: %s', runId, error)
      this.fingerprints.delete(runId)
      await this.finishRun({
        runId,
        status: 'failed',
        output: '',
        error: {
          code: error?.code ?? 'START_FAILED',
          message: error?.message ?? String(error),
        },
      })
    }
  }

  // 跨类别运行的目标会话类别：dm_reply 按来信来源的类别。
  sessionKindFor(run) {
    if (run.kind === 'dm_reply') {
      const message = run.trigger_ref
        ? this.store.get('SELECT origin_kind FROM bot_messages WHERE id = ?', run.trigger_ref)
        : null
      return message?.origin_kind === 'task' ? 'task' : message?.origin_kind === 'dm' ? 'dm' : 'project'
    }
    return undefined
  }

  // dm_reply 的 runs.task_id 留空（避开 one_active_run_per_task 索引），
  // 但它要落进来源的那个任务会话：这里把任务行解析出来交给 runtime，
  // runtime 才能按 task 类别找回同一条会话绑定，而不是退化成项目会话。
  sessionTaskFor(run, sessionKind) {
    if (sessionKind !== 'task') return null
    let taskId = null
if (run.kind === 'dm_reply') {
      const message = run.trigger_ref
        ? this.store.get('SELECT origin_task_id FROM bot_messages WHERE id = ?', run.trigger_ref)
        : null
      taskId = message?.origin_task_id ?? null
    }
    if (!taskId) return null
    return this.store.get('SELECT * FROM tasks WHERE id = ?', taskId) ?? null
  }

  insertRunEvent(runId, type, message) {
    if (!runId) return
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, type, this.maskSecretValues(message), nowIso(),
    )
  }

  // 成功写运行的交付产物清单：项目目录 git status 的相对路径快照（M/A/?? 状态）。
  // 非 git 仓库或 git 不可用时跳过并记 run_event；清单上限 200 条，不复制文件内容。
  captureRunArtifacts(run, project) {
    const dir = this.projectWorkDir(project)
    if (!existsSync(join(dir, '.git'))) {
      this.insertRunEvent(run.id, 'artifacts_skipped', '项目工作区不是 git 仓库，跳过产物记录')
      return null
    }
    let raw
    try {
      raw = execFileSync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall'], {
        cwd: dir,
        timeout: 5_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      this.insertRunEvent(run.id, 'artifacts_skipped', 'git 不可用，跳过产物记录')
      return null
    }
    const list = []
    for (const line of String(raw).split('\n')) {
      if (line.length < 4) continue
      // porcelain 的两字状态位是「索引位 + 工作区位」：' M' 是改了工作区，'AM' 是先加后改，
      // 两处都脏就都写出来。删除（' D'）不算产物，其余状态不收。
      const statusField = line.slice(0, 2)
      let path = line.slice(3).trim()
      if (!path || path.startsWith('"')) continue
      let status
      if (statusField === '??') {
        status = '??'
      } else if (statusField.includes('R')) {
        // 重命名：porcelain 形如 "R  old -> new"，只认新路径。
        const arrow = path.indexOf(' -> ')
        if (arrow === -1) continue
        path = path.slice(arrow + 4).trim()
        if (!path) continue
        status = 'R'
      } else if (statusField.includes('A')) {
        status = 'A'
      } else if (statusField.includes('M')) {
        status = 'M'
      } else {
        continue
      }
      list.push({ path, status })
      if (list.length >= 200) break
    }
    return list.length ? JSON.stringify(list) : null
  }

  // 项目目录的 git 指纹；不是 git 仓库时返回 null，跳过审计。
  workspaceFingerprint(project) {
    if (!project?.slug) return null
    const dir = this.projectWorkDir(project)
    if (!existsSync(join(dir, '.git'))) return null
    try {
      return execFileSync('git', ['status', '--porcelain'], {
        cwd: dir,
        timeout: 5_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return null
    }
  }

  // 只读运行（群聊、验收、受阻处理）不应该改文件；改了就在群里点名。
  auditReadRunWrites(run, project) {
    if (run.mode !== 'read' || !this.fingerprints.has(run.id)) {
      this.fingerprints.delete(run.id)
      return
    }
    const before = this.fingerprints.get(run.id)
    this.fingerprints.delete(run.id)
    if (before === null || !project) return
    const after = this.workspaceFingerprint(project)
    if (after === null || after === before) return
    this.insertMessage({
      projectId: project.id,
      senderType: 'system',
      senderId: 'system',
      body: `只读运行（${run.kind}）修改了项目工作区，请确认是否应该由任务运行来做：\n${after.slice(0, 800)}`,
      taskId: run.task_id ?? undefined,
      runId: run.id,
    })
    this.logger.warn?.('dsh-team: read-only run %s changed the workspace', run.id)
  }

  async finishRun({ runId, status, output, error }) {
    const run = this.runRow(runId)
    if (!['running', 'queued'].includes(run.status)) return
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
    const project = this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id)
    this.auditReadRunWrites(run, project)
    const usage = runUsageTotals(this.store, runId, this.budgetCurrency())
    const cleanOutput = this.maskSecretValues(text(output, 120_000))
    const artifactsJson = status === 'succeeded' && run.mode === 'write' && project
      ? this.captureRunArtifacts(run, project)
      : null
    const endedAt = nowIso()
    this.store.run(
      `UPDATE runs SET status = ?, output = ?, artifacts = ?, error_code = ?, error_message = ?, ended_at = ?,
       usage_input = ?, usage_cache_read = ?, usage_cache_write = ?, usage_output = ?, usage_cost = ?
       WHERE id = ? AND status IN ('running', 'queued')`,
      status, cleanOutput, artifactsJson, error?.code ?? null, error?.message ?? null, endedAt,
      usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens, usage.cost,
      runId,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, status, error?.message ?? (status === 'succeeded' ? '完成' : ''), endedAt,
    )
    const refreshed = this.runRow(runId)
    if (run.kind === 'dm') {
      const message = run.trigger_ref
        ? this.store.get('SELECT * FROM bot_messages WHERE id = ?', run.trigger_ref)
        : null
      if (message) {
        if (status === 'succeeded') {
          this.store.run(
            "UPDATE bot_messages SET status = 'replied', reply = ?, replied_at = ? WHERE id = ?",
            cleanOutput || '（对方未返回文本）',
            endedAt,
            message.id,
          )
        } else {
          this.store.run(
            "UPDATE bot_messages SET status = 'failed', reply = ?, replied_at = ? WHERE id = ?",
            `私信运行失败：${error?.message ?? '未知错误'}`,
            endedAt,
            message.id,
          )
        }
        this.enqueueOutbox({
          kind: 'dm_reply',
          payload: { messageId: message.id },
          projectId: message.project_id,
          idempotencyKey: `dm_reply:${message.id}`,
        })
        void this.tick()
      }
      if (this.rate[run.project_id]) delete this.rate[run.project_id]
      return
    }
    if (run.kind === 'dm_reply') {
      // 投递运行本身无后续动作；回信内容已由 dm 运行写入 bot_messages，投递提示词在 runtime.promptFor。
      if (this.rate[run.project_id]) delete this.rate[run.project_id]
      return
    }
    if (run.kind === 'memory_review') {
      await this.completeMemoryReview(run, status === 'succeeded' ? cleanOutput : '', error)
      if (this.rate[run.project_id]) delete this.rate[run.project_id]
      return
    }
    if (run.kind === 'review' || run.kind === 'handle') {
      const label = run.kind === 'review' ? '验收' : '受阻处理'
      if (run.task_id) {
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: status === 'succeeded'
            ? (cleanOutput || `总监已完成${label}。`)
            : `总监${label}运行失败：${error?.message ?? '未知错误'}`,
          taskId: run.task_id,
          runId,
        })
        // 验收退回或受阻重派会把任务置回 todo/in_progress；
        // 此时任务的唯一活动运行名额刚被本次运行释放，这里负责补排执行运行。
        const task = this.taskRow(run.task_id)
        if (['todo', 'in_progress'].includes(task.status) && task.assignee_bot_id) {
          this.enqueueOutbox({
            kind: 'task_run',
            payload: { taskId: task.id, triggerType: run.kind === 'review' ? 'returned' : 'redispatched' },
            projectId: task.project_id,
            taskId: task.id,
            idempotencyKey: `task:${task.id}:${run.kind === 'review' ? 'returned' : 'redispatched'}:${run.id}`,
          })
          void this.tick()
        }
      } else if (status !== 'succeeded') {
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `总监${label}运行失败：${error?.message ?? '未知错误'}`,
          runId,
        })
      }
    } else if (status === 'succeeded') {
      if (run.task_id) {
        const task = this.taskRow(run.task_id)
        const ownerReview = (task.review_target ?? 'user') === 'owner_bot'
        this.store.transaction(() => {
          this.store.run(
            `UPDATE tasks SET status = 'in_review', version = version + 1, updated_at = ?
             WHERE id = ? AND status NOT IN ('done', 'canceled')`,
            endedAt, task.id,
          )
          this.store.run(
            'INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            id('cmt'), task.id, 'bot', bot.id, cleanOutput || '运行完成，但模型未返回文本。', endedAt,
          )
          this.addTaskEvent(task.id, 'run_succeeded', { type: 'bot', id: bot.id }, { runId, identifier: `${project.key}-${task.number}` })
        })
        const summary = this.chatSummary(cleanOutput)
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: ownerReview
            ? `任务 ${project.key}-${task.number} 已交付，等待总监验收。\n\n${summary}\n\n完整交付与验证记录见该任务评论。`
            : `任务 ${project.key}-${task.number} 已完成，待您验收。\n\n${summary}\n\n完整交付与验证记录见该任务评论。`,
          taskId: task.id,
          runId,
        })
        this.wechat?.notify(`任务 ${project.key}-${task.number}《${task.title}》${ownerReview ? '已交付，等待总监验收' : '已完成，待您验收'}。回复「详情 ${project.key}-${task.number}」查看，回复「验收 ${project.key}-${task.number}」通过。`)
        this.enqueueOutbox({
          kind: 'memory_review',
          payload: { taskId: task.id, sourceRunId: runId },
          projectId: project.id,
          taskId: task.id,
          sourceId: runId,
          idempotencyKey: `memory_review:${runId}`,
        })
        if (ownerReview) {
          const ownerBot = project.owner_bot_id
            ? this.store.get("SELECT id FROM bots WHERE id = ? AND status = 'active'", project.owner_bot_id)
            : null
          if (ownerBot) {
            this.enqueueOutbox({
              kind: 'owner_task_run',
              payload: { taskId: task.id, reviewKind: 'review' },
              projectId: project.id,
              taskId: task.id,
              idempotencyKey: `owner_review:${task.id}:${runId}`,
            })
          } else {
            this.insertMessage({
              projectId: project.id,
              senderType: 'system',
              senderId: 'system',
              body: `项目未配置可用的总监 Bot，任务 ${project.key}-${task.number} 请用户直接验收。`,
              taskId: task.id,
            })
          }
        }
      } else if (run.kind === 'chat') {
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: cleanOutput || '模型未返回文本。',
          runId,
        })
        // 群聊回复后的自动记忆审查（可在设置关闭；与任务交付审查同一队列同一幂等键规则）。
        if (this.chatMemoryReviewEnabled()) {
          this.enqueueMemoryReview(project, bot, null, runId)
        }
      } else if (run.kind === 'solo_chat') {
        this.insertSoloMessage({
          botId: bot.id,
          senderType: 'bot',
          senderId: bot.id,
          body: cleanOutput || '模型未返回文本。',
          runId,
        })
      }
    } else {
      if (run.task_id) {
        this.store.run(
          "UPDATE tasks SET status = 'blocked', version = version + 1, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'canceled')",
          endedAt, run.task_id,
        )
        this.addTaskEvent(run.task_id, 'run_failed', { type: 'bot', id: bot.id }, { runId, error })
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `任务执行失败：${error?.message ?? '未知错误'}\n运行 ID：${runId}`,
          taskId: run.task_id,
          runId,
        })
        this.enqueueOutbox({
          kind: 'owner_task_run',
          payload: { taskId: run.task_id, reviewKind: 'handle' },
          projectId: run.project_id,
          taskId: run.task_id,
          idempotencyKey: `owner_handle:${run.task_id}:${run.id}`,
        })
      } else if (run.kind === 'chat') {
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `运行失败：${error?.message ?? '未知错误'}`,
          runId,
        })
      } else if (run.kind === 'solo_chat') {
        this.insertSoloMessage({
          botId: bot.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `运行失败：${error?.message ?? '未知错误'}`,
          runId,
        })
      }
    }
    if (run.project_id && this.rate[run.project_id]) delete this.rate[run.project_id]
  }

  learnFromTask(project, bot, task, output, runId) {
    if (!output || output.trim().length < 40) return
    const content = maskSecrets(redactSecrets(`${task.title}：${output.trim().slice(0, 900)}`), this.secretEntries())
    const source = `run:${runId}`
    const existing = this.store.get("SELECT id FROM memories WHERE source = ? AND scope_type = 'bot' AND scope_id = ?", source, bot.id)
    if (existing) return
    this.createMemory({
      scopeType: 'bot',
      scopeId: bot.id,
      topic: `任务 ${project.key}-${task.number}`,
      content,
      source,
      confidence: 0.7,
      createdBy: `bot:${bot.id}`,
      actor: { type: 'bot', id: bot.id },
    })
    if (project.owner_bot_id === bot.id) {
      this.createMemory({
        scopeType: 'project',
        scopeId: project.id,
        topic: `${project.key}-${task.number} 交付记录`,
        content,
        source,
        confidence: 0.6,
        createdBy: `bot:${bot.id}`,
        actor: { type: 'bot', id: bot.id },
      })
    }
  }

  // 记忆审查：任务交付后由模型抽取可复用事实，置信度不足的进入待审队列。
  memoryReviewEnabled() {
    if (this.config.memoryReview === false) return false
    return this.store.setting('memory_review', '1') !== '0'
  }

  // 群聊回复的记忆审查独立开关：闲聊占比高，默认开但可单关。
  chatMemoryReviewEnabled() {
    return this.memoryReviewEnabled() && this.store.setting('chat_memory_review', '1') !== '0'
  }

  enqueueMemoryReview(project, bot, task, sourceRunId) {
    if (!this.memoryReviewEnabled()) return null
    const active = this.store.get(
      "SELECT id FROM runs WHERE kind = 'memory_review' AND trigger_ref = ? AND status IN ('queued', 'running')",
      sourceRunId,
    )
    if (active) return active.id
    const reviewRunId = id('run')
    const createdAt = nowIso()
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, NULL, 'memory_review', 'read', 'memory_review', ?, 'queued', 1, ?, ?)`,
      reviewRunId, project.id, bot.id, sourceRunId, `memory_review:${sourceRunId}`, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), reviewRunId, 'queued', '任务交付完成，触发记忆审查', createdAt,
    )
    void this.tick()
    return reviewRunId
  }

  async completeMemoryReview(reviewRun, output, error) {
    const sourceRunId = reviewRun.trigger_ref
    const sourceRun = sourceRunId ? this.store.get('SELECT * FROM runs WHERE id = ?', sourceRunId) : null
    const items = error ? [] : parseMemoryReview(output)
    if (!items.length) {
      // 审查失败或模型没给出可用结论时，回退到规则沉淀，保证任务交付不会颗粒无收。
      if (sourceRun?.task_id) {
        this.store.run(
          'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
          id('evt'), reviewRun.id, 'review_fallback', `记忆审查未产出可用结论，回退规则沉淀：${error?.message ?? '无有效条目'}`, nowIso(),
        )
        const project = this.projectRow(reviewRun.project_id)
        const bot = this.botRow(reviewRun.bot_id)
        const task = this.taskRow(sourceRun.task_id)
        this.learnFromTask(project, bot, task, sourceRun.output ?? '', sourceRun.id)
      }
      return { applied: 0 }
    }
    const project = this.projectRow(reviewRun.project_id)
    const bot = this.botRow(reviewRun.bot_id)
    const source = `run:${sourceRunId}`
    let applied = 0
    let deduped = 0
    // 同一次审查里重复的条目、以及同一来源重复触发的审查，写入前都按来源+内容去重。
    const seen = new Set()
    for (const item of items) {
      const scopeType = ['bot', 'project', 'team'].includes(item.scope) ? item.scope : 'bot'
      const scopeId = scopeType === 'bot' ? bot.id : scopeType === 'project' ? project.id : 'team'
      const content = maskSecrets(redactSecrets(text(item.content, 8000)), this.secretEntries())
      if (!content) continue
      const dedupeKey = `${scopeType}|${scopeId}|${source}|${content}`
      if (seen.has(dedupeKey)) {
        deduped += 1
        continue
      }
      seen.add(dedupeKey)
      const exists = this.store.get(
        'SELECT id FROM memories WHERE scope_type = ? AND scope_id = ? AND source = ? AND content = ?',
        scopeType, scopeId, source, content,
      )
      if (exists) {
        deduped += 1
        continue
      }
      const confidence = Math.min(1, Math.max(0, Number(item.confidence) || 0.5))
      try {
        this.createMemory({
          scopeType,
          scopeId,
          topic: text(item.topic, 120) || `任务 ${project.key} 记忆`,
          content,
          source,
          confidence,
          createdBy: `bot:${bot.id}`,
          actor: { type: 'bot', id: bot.id },
          status: confidence >= 0.8 ? 'active' : 'pending',
          sourceRefs: sourceRunId ? [sourceRunId] : [],
        })
        applied += 1
      } catch (writeError) {
        this.logger.warn?.('dsh-team: 记忆审查写入失败：%s', writeError?.message ?? writeError)
      }
    }
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), reviewRun.id, 'reviewed', `记忆审查完成，写入 ${applied} 条${deduped ? `，去重 ${deduped} 条` : ''}`, nowIso(),
    )
    return { applied, deduped }
  }

  // ===== Bot 间私信（team_message_bot）=====

  // 工具入口：同项目成员间具名幂等私信。发信人由会话绑定推出；返回给调用 Bot 的结果里带状态，重发同名请求不产生新工作。
  messageFromBot({ sessionId, toName, requestId, textBody }) {
    const origin = sessionId
      ? this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
      : null
    if (!origin) throw badRequest('找不到发起会话的项目绑定')
    const fromBotId = origin.bot_id
    const from = this.store.get('SELECT * FROM bots WHERE id = ?', fromBotId)
    if (!from || from.status !== 'active') throw forbidden('发信 Bot 不存在或不可用')
    if (!toName || typeof toName !== 'string') throw badRequest('缺少收信 Bot 名称')
    if (!requestId || typeof requestId !== 'string') throw badRequest('缺少 request_id（每次逻辑请求一个稳定名字，重发同名不重复执行）')
    const project = this.projectRow(origin.project_id)
    const target = (this.membersOf(project.id) ?? []).find(bot => bot.name === toName.trim())
    if (!target) throw notFound(`项目 ${project.name} 里没有叫 ${toName} 的成员 Bot`)
    if (target.id === fromBotId) throw badRequest('不能给自己发私信')
    // 私信正文过密钥掩码：私信会进对方模型上下文，明文密钥不该落库。
    const maskedText = this.maskSecretValues(text(textBody, 50_000))
    let row = null
    let created = false
    // 落库与入队同一事务：消息不会停在「已入库但没人投递」的悬空状态。
    this.store.transaction(() => {
      const result = upsertBotMessage(this.store, {
        projectId: project.id,
        fromBotId,
        toBotId: target.id,
        requestId,
        text: maskedText,
        originSessionId: sessionId,
        originKind: origin.kind,
        originTaskId: origin.task_id ?? null,
      })
      // request_id 是幂等键：同名但内容不同说明调用方复用了名字，必须报错而不是悄悄丢弃新内容。
      if (result.conflict) {
        throw conflict(`request_id「${requestId}」已被内容不同的私信占用，请换一个 request_id 再发`)
      }
      row = result.row
      created = result.created
      if (created) {
        this.enqueueOutbox({
          kind: 'dm_run',
          payload: { messageId: row.id },
          projectId: project.id,
          sourceId: row.id,
          idempotencyKey: `dm_run:${row.id}`,
        })
      }
    })
    if (created) void this.tick()
    // enqueueOutbox 同步投递会推进状态（pending→delivered），返回前重读最新行。
    const fresh = this.store.get('SELECT * FROM bot_messages WHERE id = ?', row.id) ?? row
    return {
      messageId: fresh.id.slice(-6),
      status: fresh.status,
      created,
      hint: fresh.status === 'replied' ? '该请求此前已有回信，回信会重新投递' : '私信已入队，回信将送回你的当前会话',
    }
  }

  botMessagesView(projectId) {
    const rows = this.store.all(
      'SELECT * FROM bot_messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 50',
      projectId,
    )
    const bots = new Map(this.store.all('SELECT id, name FROM bots').map(bot => [bot.id, bot.name]))
    return summarizeForUi(rows).map(item => ({
      ...item,
      fromName: bots.get(item.from) ?? item.from,
      toName: bots.get(item.to) ?? item.to,
    }))
  }

  // ===== 密钥管道 =====

  ensureSecretBox() {
    if (this._secretBox) return this._secretBox
    const keyFile = this.config.secretKeyPath
    const keyHex = String(process.env.DSH_TEAM_SECRET_KEY ?? '').trim()
    // 库里已有密文时不允许悄悄换密钥：缺文件直接报错，指纹不符也报错。
    const hasCiphertext = Number(this.store.get('SELECT COUNT(*) AS n FROM secrets')?.n ?? 0) > 0
    this._secretBox = keyHex
      ? new SecretBox({ keyHex })
      : new SecretBox({ keyFile, requireExisting: hasCiphertext })
    this.verifySecretKeyFingerprint()
    return this._secretBox
  }

  // 主密钥指纹：首次用到密钥时登记到 settings。
  // 换机恢复最常见的事故是密钥文件没跟着数据库一起备份，指纹不匹配当场暴露，
  // 好过等密文解不开时才发现既有密钥已经读不出来。
  verifySecretKeyFingerprint() {
    const keyFile = this.config.secretKeyPath
    const envKey = String(process.env.DSH_TEAM_SECRET_KEY ?? '').trim()
    const material = envKey || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '')
    if (!material) return null
    const fingerprint = secretKeyFingerprint(material)
    const known = this.store.setting('secret_key_fingerprint')
    if (!known) {
      this.store.setSetting('secret_key_fingerprint', fingerprint)
      return fingerprint
    }
    if (known === fingerprint) return fingerprint
    const secretCount = Number(this.store.get('SELECT COUNT(*) AS n FROM secrets')?.n ?? 0)
    if (secretCount > 0) {
      throw new AppError(
        'SECRET_KEY_MISMATCH',
        '密钥与数据库登记的指纹不一致：已拒绝继续，避免用错密钥写坏既有密文（请恢复备份中的密钥文件）',
      )
    }
    // 库里还没有密文，指纹不一致没有数据风险：直接改登记。
    this.store.setSetting('secret_key_fingerprint', fingerprint)
    return fingerprint
  }

  // 解密后的 {name, value} 全集（掩码用），写入时失效缓存。
  secretEntries() {
    if (this._secretEntries) return this._secretEntries
    const rows = this.store.all('SELECT * FROM secrets')
    const box = rows.length ? this.ensureSecretBox() : null
    this._secretEntries = rows.map(row => ({
      name: row.name,
      value: box.decrypt({ valueEnc: row.value_enc, valueIv: row.value_iv, valueTag: row.value_tag }),
      scope: row.scope,
      projectId: row.project_id,
    }))
    return this._secretEntries
  }

  // 掩码必须 fail-closed：解密失败就显式报错，绝不放行原文——
  // 放行原文等于把密钥明文写进转录、记忆和模型上下文。
  maskSecretValues(body) {
    if (typeof body !== 'string' || !body) return body
    const entries = this.secretEntries()
    if (!entries.length) return body
    return maskSecrets(body, entries)
  }

  listSecrets() {
    const rows = this.store.all('SELECT * FROM secrets ORDER BY scope, name')
    return rows.map((row) => {
      const project = row.project_id ? this.store.get('SELECT key, name FROM projects WHERE id = ?', row.project_id) : null
      return {
        id: row.id,
        scope: row.scope,
        projectName: project?.name ?? null,
        name: row.name,
        purpose: row.purpose,
        fingerprint: row.fingerprint,
        updatedBy: row.created_by,
        updatedAt: row.updated_at,
      }
    })
  }

  // 写入后物化：团队级写所有活动项目，项目级写该项目。bot 的 shell 里 `set -a; . .team/secrets.env` 生效。
  async materializeProjectSecrets(project) {
    const rows = this.store.all(
      "SELECT * FROM secrets WHERE scope = 'team' OR (scope = 'project' AND project_id = ?)",
      project.id,
    )
    const entries = rows.map((row) => {
      const box = this.ensureSecretBox()
      return { name: row.name, value: box.decrypt({ valueEnc: row.value_enc, valueIv: row.value_iv, valueTag: row.value_tag }) }
    })
    if (!entries.length) return null
    const dir = this.projectWorkDir(project)
    return materializeEnvFile(entries, dir)
  }

  async upsertSecret({ scope, projectId, name, purpose, value }, actor = this.actor()) {
    if (!['team', 'project'].includes(scope)) throw badRequest('密钥作用域必须是 team 或 project')
    if (scope === 'project' && !projectId) throw badRequest('项目级密钥必须指定项目')
    if (scope === 'project') this.projectRow(projectId)
    const normalized = normalizeSecretName(name)
    const trimmed = String(value ?? '')
    if (trimmed.length < 8) throw badRequest('密钥值至少 8 个字符（太短的值不参与掩码，也不允许存）')
    const box = this.ensureSecretBox()
    const { valueEnc, valueIv, valueTag } = box.encrypt(trimmed)
    const fingerprint = secretFingerprint(trimmed)
    const now = nowIso()
    const existing = this.store.get(
      "SELECT id FROM secrets WHERE scope = ? AND IFNULL(project_id, '') = ? AND name = ?",
      scope, scope === 'project' ? projectId : '', normalized,
    )
    let secretId
    this.store.transaction(() => {
      if (existing) {
        secretId = existing.id
        this.store.run(
          'UPDATE secrets SET purpose = ?, value_enc = ?, value_iv = ?, value_tag = ?, fingerprint = ?, created_by = ?, updated_at = ? WHERE id = ?',
          text(purpose, 200) ?? '', valueEnc, valueIv, valueTag, fingerprint, `${actor.type}:${actor.id}`, now, secretId,
        )
      } else {
        secretId = id('sec')
        this.store.run(
          `INSERT INTO secrets(id, scope, project_id, name, purpose, value_enc, value_iv, value_tag, fingerprint, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          secretId, scope, scope === 'project' ? projectId : null, normalized,
          text(purpose, 200) ?? '', valueEnc, valueIv, valueTag, fingerprint,
          `${actor.type}:${actor.id}`, now, now,
        )
      }
      this.audit(actor, existing ? 'secret.update' : 'secret.create', 'secret', secretId, { scope, name: normalized })
    })
    this._secretEntries = null
    const targets = scope === 'team'
      ? this.store.all("SELECT * FROM projects WHERE status = 'active'")
      : [this.projectRow(projectId)]
    for (const project of targets) await this.materializeProjectSecrets(project)
    return { id: secretId, name: normalized, fingerprint }
  }

  async deleteSecret(secretId, actor = this.actor()) {
    const row = this.store.get('SELECT * FROM secrets WHERE id = ?', secretId)
    if (!row) throw notFound('密钥不存在')
    this.store.transaction(() => {
      this.store.run('DELETE FROM secrets WHERE id = ?', secretId)
      this.audit(actor, 'secret.delete', 'secret', secretId, { scope: row.scope, name: row.name })
    })
    this._secretEntries = null
    // 删除后剩余条目重新物化；没有剩余条目时保留旧文件会误导，删除之。
    const targets = row.scope === 'team'
      ? this.store.all("SELECT * FROM projects WHERE status = 'active'")
      : [this.projectRow(row.project_id)]
    for (const project of targets) {
      const path = await this.materializeProjectSecrets(project)
      if (!path) {
        // 删掉密钥后必须把工作区里的明文 env 一并清掉；清不掉要留痕，不能默默留着明文文件。
        try {
          rmSync(join(this.projectWorkDir(project), '.team', 'secrets.env'), { force: true })
        } catch (error) {
          this.logger.warn?.('dsh-team: 删除密钥后清理 %s 失败：%s', project.slug, error?.message ?? error)
        }
      }
    }
    return { deleted: true }
  }

  // Bot 发起的密钥请求：进待审队列 + 群里一张系统卡片，用户在设置页批准（写值）或拒绝。
  requestSecretFromBot({ sessionId, name, reason }) {
    const binding = sessionId
      ? this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
      : null
    if (!binding?.project_id) throw badRequest('密钥请求必须在项目会话内发起')
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', binding.bot_id)
    if (!bot || bot.status !== 'active') throw forbidden('发起请求的 Bot 不存在或不可用')
    const normalized = normalizeSecretName(name)
    const requestId = id('secreq')
    this.store.run(
      `INSERT INTO secret_requests(id, project_id, bot_id, name, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      requestId, binding.project_id, binding.bot_id, normalized, text(reason, 500) ?? '', nowIso(),
    )
    const project = this.projectRow(binding.project_id)
    this.insertMessage({
      projectId: binding.project_id,
      senderType: 'system',
      senderId: 'system',
      body: `${bot.name} 请求密钥 ${normalized}（项目 ${project.name}）。\n理由：${text(reason, 300) ?? '（未说明）'}\n请在设置页「密钥」中批准或拒绝。`,
    })
    return { requestId, name: normalized, status: 'pending' }
  }

  listSecretRequests() {
    const rows = this.store.all(
      "SELECT * FROM secret_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50",
    )
    return rows.map((row) => {
      const bot = this.store.get('SELECT name FROM bots WHERE id = ?', row.bot_id)
      const project = row.project_id ? this.store.get('SELECT name FROM projects WHERE id = ?', row.project_id) : null
      return {
        id: row.id,
        projectName: project?.name ?? null,
        botName: bot?.name ?? 'Bot',
        name: row.name,
        reason: row.reason,
        createdAt: row.created_at,
      }
    })
  }

  async approveSecretRequest(requestId, { value }, actor = this.actor()) {
    const request = this.store.get("SELECT * FROM secret_requests WHERE id = ? AND status = 'pending'", requestId)
    if (!request) throw notFound('密钥请求不存在或已处理')
    const created = await this.upsertSecret({
      scope: 'project',
      projectId: request.project_id,
      name: request.name,
      purpose: `bot 请求（${request.reason?.slice(0, 120) ?? '未说明'}）`,
      value,
    }, actor)
    this.store.run(
      "UPDATE secret_requests SET status = 'approved', handled_at = ? WHERE id = ?",
      nowIso(), requestId,
    )
    if (request.project_id) {
      this.insertMessage({
        projectId: request.project_id,
        senderType: 'system',
        senderId: 'system',
        body: `密钥 ${request.name} 已批准并物化到项目 .team/secrets.env，Bot 下次 shell 里 set -a; . .team/secrets.env 即可使用。`,
      })
    }
    return created
  }

  async denySecretRequest(requestId, actor = this.actor()) {
    const request = this.store.get("SELECT * FROM secret_requests WHERE id = ? AND status = 'pending'", requestId)
    if (!request) throw notFound('密钥请求不存在或已处理')
    this.store.run(
      "UPDATE secret_requests SET status = 'denied', handled_at = ? WHERE id = ?",
      nowIso(), requestId,
    )
    this.audit(actor, 'secret_request.deny', 'secret_request', requestId, { name: request.name })
    if (request.project_id) {
      this.insertMessage({
        projectId: request.project_id,
        senderType: 'system',
        senderId: 'system',
        body: `密钥 ${request.name} 的请求被拒绝。`,
      })
    }
    return { denied: true }
  }

  // 记忆写入权限：用户可写任意作用域；Bot 只能写自己的记忆、是成员的项目记忆，
  // 团队级记忆仅团队总监（任一项目 owner Bot）可写。
  assertMemoryWriteScope(scopeType, scopeId, actor) {
    if (actor?.type === 'user') return
    if (actor?.type !== 'bot') throw forbidden('当前身份不能写入记忆')
    if (scopeType === 'bot') {
      if (actor.id === scopeId) return
      throw forbidden('Bot 只能写入自己的记忆')
    }
    if (scopeType === 'project') {
      const project = this.projectRow(scopeId)
      if (project.owner_bot_id === actor.id) return
      if (this.membersOf(project.id).some(member => member.id === actor.id)) return
      throw forbidden('Bot 不是该项目成员，不能写入项目记忆')
    }
    if (scopeType === 'team') {
      if (this.isTeamOwner(actor.id)) return
      throw forbidden('仅团队总监可以写入团队级记忆')
    }
    throw badRequest('记忆作用域无效')
  }

  isTeamOwner(botId) {
    const row = this.store.get("SELECT id FROM projects WHERE owner_bot_id = ? LIMIT 1", botId)
    return Boolean(row)
  }

  createMemory({ scopeType, scopeId, topic, content, source = '', confidence = 1, createdBy = 'system', actor = null, status = 'active', sourceRefs = [] }) {
    const cleanScope = ['bot', 'project', 'team'].includes(scopeType) ? scopeType : null
    if (!cleanScope) throw badRequest('记忆作用域无效')
    const cleanContent = redactSecrets(text(content, 8000))
    if (!cleanContent) throw badRequest('记忆内容不能为空')
    const writeActor = actor ?? { type: createdBy.split(':')[0] || 'system', id: createdBy.split(':').slice(1).join(':') || 'system' }
    this.assertMemoryWriteScope(cleanScope, scopeId, writeActor)
    if (cleanScope === 'bot') {
      const bot = this.botRow(scopeId)
      if (bot.status !== 'active') throw conflict('Bot 已归档，不能写入记忆')
    }
    if (cleanScope === 'project') {
      const project = this.projectRow(scopeId)
      if (project.status !== 'active') throw conflict('项目已归档，记忆已冻结')
    }
    const memoryId = id('mem')
    const createdAt = nowIso()
    const cleanStatus = status === 'pending' ? 'pending' : 'active'
    const refs = JSON.stringify(Array.isArray(sourceRefs) ? sourceRefs.slice(0, 50) : [])
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO memories(id, scope_type, scope_id, topic, content, source, confidence, status, created_by, created_at, updated_at,
          approved_by, revision, summary, source_refs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        memoryId, cleanScope, scopeId, text(topic, 120) || '未命名记忆', cleanContent, text(source, 500),
        Math.min(1, Math.max(0, Number(confidence) || 0)), cleanStatus, createdBy, createdAt, createdAt,
        cleanStatus === 'active' ? `${writeActor.type}:${writeActor.id}` : null,
        text(cleanContent, 300), refs,
      )
      this.store.run(
        'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        id('mevt'), memoryId, 'created', writeActor.type, writeActor.id, cleanContent, createdAt,
      )
      this.audit(writeActor, 'memory.create', 'memory', memoryId, { scopeType: cleanScope, scopeId, status: cleanStatus })
    })
    this.writeMemoryMirror(memoryId)
    return this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
  }

  // 待审记忆的审批与驳回。
  async approveMemory(memoryId, actor = this.actor()) {
    const memory = this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
    if (!memory) throw notFound('记忆不存在')
    if (memory.status !== 'pending') throw conflict('只有待审记忆可以批准')
    const now = nowIso()
    this.store.run(
      "UPDATE memories SET status = 'active', approved_by = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      `${actor.type}:${actor.id}`, now, memoryId,
    )
    this.store.run(
      'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id('mevt'), memoryId, 'approved', actor.type, actor.id, memory.content, memory.content, now,
    )
    this.audit(actor, 'memory.approve', 'memory', memoryId, {})
    this.writeMemoryMirror(memoryId)
    return this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
  }

  async rejectMemory(memoryId, actor = this.actor()) {
    const memory = this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
    if (!memory) throw notFound('记忆不存在')
    if (memory.status !== 'pending') throw conflict('只有待审记忆可以驳回')
    const now = nowIso()
    this.store.run(
      "UPDATE memories SET status = 'rejected', approved_by = ?, updated_at = ? WHERE id = ?",
      `${actor.type}:${actor.id}`, now, memoryId,
    )
    this.store.run(
      'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      id('mevt'), memoryId, 'rejected', actor.type, actor.id, memory.content, now,
    )
    this.audit(actor, 'memory.reject', 'memory', memoryId, {})
    return this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
  }

  // 记忆检索：项目/成员 Bot/团队三级作用域，优先走 FTS5 全文索引，索引不可用时回退 LIKE。
  searchMemories({ projectId = null, botId = null, query = '', limit = 20 } = {}) {
    const scopes = []
    if (projectId) {
      const project = this.projectRow(projectId)
      scopes.push({ type: 'project', id: project.id })
      for (const member of this.membersOf(project.id)) scopes.push({ type: 'bot', id: member.id })
      scopes.push({ type: 'team', id: 'team' })
    } else if (botId) {
      scopes.push({ type: 'bot', id: botId })
    } else {
      scopes.push({ type: 'team', id: 'team' })
    }
    const clause = scopes.map(() => '(m.scope_type = ? AND m.scope_id = ?)').join(' OR ')
    const params = scopes.flatMap(scope => [scope.type, scope.id])
    const keyword = text(query, 200).trim()
    const limitN = Math.min(100, Math.max(1, Number(limit) || 20))
    let rows
    if (keyword && this.store.ftsEnabled) {
      const match = `"${keyword.replace(/"/g, '""')}"`
      rows = this.store.all(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.memory_id
         WHERE memories_fts MATCH ? AND m.status = 'active' AND (${clause})
         ORDER BY m.updated_at DESC LIMIT ?`,
        match, ...params, limitN,
      )
    } else {
      const like = `%${keyword}%`
      rows = this.store.all(
        `SELECT m.* FROM memories m
         WHERE m.status = 'active' AND (${clause})
           ${keyword ? 'AND (m.topic LIKE ? OR m.content LIKE ?)' : ''}
         ORDER BY m.updated_at DESC LIMIT ?`,
        ...params, ...(keyword ? [like, like] : []), limitN,
      )
    }
    return rows.map(row => this.memoryView(row))
  }

  memoryView(memory) {
    return {
      ...memory,
      sourceRefs: jsonParse(memory.source_refs_json, []),
      scopeLabel: memory.scope_type === 'team'
        ? '团队'
        : memory.scope_type === 'project'
          ? (this.store.get('SELECT name FROM projects WHERE id = ?', memory.scope_id)?.name ?? memory.scope_id)
          : (this.store.get('SELECT name FROM bots WHERE id = ?', memory.scope_id)?.name ?? memory.scope_id),
    }
  }

  writeMemoryMirror(memoryId) {
    const memory = this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
    if (!memory) return
    const directory = join(this.config.memoryDir, memory.scope_type, memory.scope_id)
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `${sanitizeFilename(memory.topic)}-${memoryId.slice(-6)}.md`)
    const body = [
      '---',
      `topic: ${JSON.stringify(memory.topic)}`,
      `scope: ${memory.scope_type}/${memory.scope_id}`,
      `source: ${JSON.stringify(memory.source)}`,
      `updated: ${memory.updated_at}`,
      '---',
      '',
      memory.content,
      '',
    ].join('\n')
    writeFileSync(path, body, 'utf8')
    this.store.run('UPDATE memories SET path = ? WHERE id = ?', path, memoryId)
  }

  async updateMemory(memoryId, patch) {
    const memory = this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
    if (!memory) throw notFound('记忆不存在')
    const content = redactSecrets(text(patch.content ?? memory.content, 8000))
    const topic = text(patch.topic ?? memory.topic, 120)
    this.store.run(
      'UPDATE memories SET topic = ?, content = ?, updated_at = ? WHERE id = ?',
      topic, content, nowIso(), memoryId,
    )
    this.store.run(
      'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id('mevt'), memoryId, 'updated', 'user', this.localUserId, memory.content, content, nowIso(),
    )
    this.writeMemoryMirror(memoryId)
    return this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
  }

  async deleteMemory(memoryId, actor = this.actor()) {
    const memory = this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
    if (!memory) throw notFound('记忆不存在')
    this.store.run("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?", nowIso(), memoryId)
    this.store.run(
      'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      id('mevt'), memoryId, 'archived', actor.type, actor.id, memory.content, nowIso(),
    )
    this.audit(actor, 'memory.archive', 'memory', memoryId, {})
    return true
  }

  async createProposal(input, actor = this.actor()) {
    const kind = input.kind
    if (!['bot_update', 'skill'].includes(kind)) throw badRequest('当前版本仅支持 bot_update 与 skill 提案')
    const title = text(input.title, 200)
    if (!title) throw badRequest('提案标题不能为空')
    if (kind === 'bot_update') {
      if (!input.botId) throw badRequest('Bot 提案必须指定 Bot')
      this.botRow(input.botId)
    }
    if (kind === 'skill' && !input.payload?.content) throw badRequest('技能提案必须包含内容')
    const payload = input.payload ?? {}
    const canary = this.proposalCanary(input, kind)
    const diff = kind === 'bot_update' ? this.botProposalDiff(input.botId, payload) : this.skillProposalDiff(payload)
    const proposalId = id('prop')
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO proposals(id, kind, bot_id, project_id, title, rationale, payload_json, evaluation,
          evaluation_json, diff_json, canary_json, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        proposalId, kind, input.botId ?? null, input.projectId ?? null, title,
        text(input.rationale, 10_000), JSON.stringify(payload), text(input.evaluation, 6000),
        JSON.stringify({ verdict: 'pending', notes: text(input.evaluation, 6000), evaluatedBy: null, evaluatedAt: null }),
        JSON.stringify(diff), JSON.stringify(canary),
        `${actor.type}:${actor.id}`, nowIso(),
      )
      this.audit(actor, 'proposal.create', 'proposal', proposalId, { kind, title })
    })
    return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
  }

  // 差异统一成 {字段: {from, to}}，前端与审计日志用同一形状。
  botProposalDiff(botId, payload) {
    const bot = this.botRow(botId)
    const diff = {}
    for (const field of ['role', 'instructions', 'provider', 'model', 'effort']) {
      if (payload[field] === undefined) continue
      const before = bot[field] ?? null
      if (String(before ?? '') === String(payload[field] ?? '')) continue
      diff[field] = { from: before, to: payload[field] }
    }
    return diff
  }

  skillProposalDiff(payload) {
    const slug = slugify(payload.slug ?? '')
    const current = slug ? this.store.get('SELECT slug, version, checksum FROM skills WHERE slug = ?', slug) : null
    return {
      slug: { from: current?.slug ?? null, to: slug || null },
      version: { from: current?.version ?? null, to: text(payload.version, 40) || '1.0.0' },
      checksum: { from: current?.checksum ?? null, to: sha256(String(payload.content ?? '')) },
      bytes: { from: current ? String(payload.content ?? '').length : 0, to: String(payload.content ?? '').length },
    }
  }

  proposalCanary(input, kind) {
    const raw = input.canary ?? null
    if (!raw) return null
    const projectIds = (Array.isArray(raw.projectIds) ? raw.projectIds : []).filter(Boolean)
    const botIds = (Array.isArray(raw.botIds) ? raw.botIds : []).filter(Boolean)
    if (kind === 'bot_update' && (projectIds.length || botIds.length)) {
      throw badRequest('Bot 配置提案暂不支持灰度')
    }
    if (kind === 'skill' && !projectIds.length) {
      throw badRequest('技能灰度必须指定至少一个项目')
    }
    for (const projectId of projectIds) this.projectRow(projectId)
    return projectIds.length ? { projectIds } : null
  }

  proposalView(proposal) {
    return {
      ...proposal,
      payload: jsonParse(proposal.payload_json, {}),
      diff: jsonParse(proposal.diff_json, null),
      evaluation: jsonParse(proposal.evaluation_json, null),
      canary: jsonParse(proposal.canary_json, null),
      botName: proposal.bot_id ? this.store.get('SELECT name FROM bots WHERE id = ?', proposal.bot_id)?.name ?? null : null,
      approvedBy: proposal.approved_by ?? null,
      appliedAt: proposal.applied_at ?? null,
    }
  }

  // 评估：提案必须先有评估结论，结论为 pass 才允许批准。
  async evaluateProposal(proposalId, evaluation, actor = this.actor()) {
    const proposal = this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId)
    if (!proposal) throw notFound('提案不存在')
    if (!['pending', 'canary'].includes(proposal.status)) throw conflict('提案已处理')
    const verdict = ['pass', 'fail', 'pending'].includes(evaluation?.verdict) ? evaluation.verdict : 'pending'
    const payload = {
      verdict,
      notes: text(evaluation?.notes, 6000),
      evaluatedBy: `${actor.type}:${actor.id}`,
      evaluatedAt: nowIso(),
    }
    this.store.run('UPDATE proposals SET evaluation_json = ? WHERE id = ?', JSON.stringify(payload), proposalId)
    this.audit(actor, 'proposal.evaluate', 'proposal', proposalId, { verdict })
    return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
  }

  async decideProposal(proposalId, decision, actor = this.actor()) {
    if (!['approved', 'rejected'].includes(decision)) throw badRequest('审批结果无效')
    const proposal = this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId)
    if (!proposal) throw notFound('提案不存在')
    if (proposal.status !== 'pending') throw conflict('提案已处理')
    const payload = jsonParse(proposal.payload_json, {})
    const evaluation = jsonParse(proposal.evaluation_json, {})
    const canary = jsonParse(proposal.canary_json, null)
    if (decision === 'approved') {
      if (evaluation?.verdict !== 'pass') throw conflict('提案缺少通过的评估结果，请先完成评估')
      const applied = await this.applyProposal(proposal, payload, canary, actor)
      const nextStatus = applied.canary ? 'canary' : 'approved'
      this.store.run(
        'UPDATE proposals SET status = ?, decided_by = ?, decided_at = ?, approved_by = ?, applied_at = ? WHERE id = ?',
        nextStatus, `${actor.type}:${actor.id}`, nowIso(), `${actor.type}:${actor.id}`, nowIso(), proposalId,
      )
      this.audit(actor, `proposal.${decision}`, 'proposal', proposalId, { canary: applied.canary, detail: applied.detail })
      return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
    }
    this.store.run(
      'UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?',
      decision, `${actor.type}:${actor.id}`, nowIso(), proposalId,
    )
    this.audit(actor, `proposal.${decision}`, 'proposal', proposalId, {})
    return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
  }

  async applyProposal(proposal, payload, canary, actor) {
    if (proposal.kind === 'bot_update') {
      await this.updateBot(proposal.bot_id, {
        ...(payload.role !== undefined ? { role: payload.role } : {}),
        ...(payload.instructions !== undefined ? { instructions: payload.instructions } : {}),
        ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
      }, actor)
      return { canary: false, detail: { botId: proposal.bot_id } }
    }
    if (proposal.kind === 'skill') {
      if (canary?.projectIds?.length) {
        const staged = await stageSkill(this.config, payload)
        for (const projectId of canary.projectIds) {
          this.setSkillBinding({ scopeType: 'project', scopeId: projectId, slug: staged.slug, version: staged.version, status: 'canary' }, actor)
        }
        syncSkills(this.store, this.config.skillRoot)
        return { canary: true, detail: { slug: staged.slug, version: staged.version, projectIds: canary.projectIds } }
      }
      const published = await publishSkill(this.config, payload)
      syncSkills(this.store, this.config.skillRoot)
      this.setSkillBinding({
        scopeType: 'global', scopeId: 'global', slug: published.slug, version: published.version, status: 'active',
      }, actor)
      return { canary: false, detail: { slug: published.slug, version: published.version } }
    }
    throw badRequest('提案类型无效')
  }

  // 灰度提案转正：技能版本全量生效，灰度项目的绑定升级为 active。
  async promoteProposal(proposalId, actor = this.actor()) {
    const proposal = this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId)
    if (!proposal) throw notFound('提案不存在')
    if (proposal.status !== 'canary') throw conflict('只有灰度中的提案可以转正')
    const payload = jsonParse(proposal.payload_json, {})
    const canary = jsonParse(proposal.canary_json, null)
    const published = await publishSkill(this.config, payload)
    syncSkills(this.store, this.config.skillRoot)
    for (const projectId of canary?.projectIds ?? []) {
      this.setSkillBinding({ scopeType: 'project', scopeId: projectId, slug: published.slug, version: published.version, status: 'active' }, actor)
    }
    this.setSkillBinding({
      scopeType: 'global', scopeId: 'global', slug: published.slug, version: published.version, status: 'active',
    }, actor)
    this.store.run(
      "UPDATE proposals SET status = 'approved', applied_at = ? WHERE id = ?",
      nowIso(), proposalId,
    )
    this.audit(actor, 'proposal.promote', 'proposal', proposalId, { slug: published.slug, version: published.version })
    return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
  }

  // 技能绑定：项目/全局维度把某个技能钉在指定版本，取代只能禁用的旧能力。
  setSkillBinding({ scopeType, scopeId, slug, version, status = 'active' }, actor = this.actor()) {
    const scope = scopeType === 'project' ? 'project' : scopeType === 'global' ? 'global' : null
    if (!scope) throw badRequest('绑定作用域无效')
    const cleanSlug = slugify(slug ?? '')
    if (!cleanSlug) throw badRequest('技能 slug 无效')
    if (scope === 'project') this.projectRow(scopeId)
    const bindingId = id('bind')
    const now = nowIso()
    this.store.run(
      `INSERT INTO skill_bindings(id, scope_type, scope_id, slug, version, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_type, scope_id, slug) DO UPDATE SET
         version = excluded.version, status = excluded.status, updated_at = excluded.updated_at`,
      bindingId, scope, scopeId ?? 'global', cleanSlug, text(version, 40) || null,
      status === 'canary' ? 'canary' : 'active', `${actor.type}:${actor.id}`, now, now,
    )
    this.audit(actor, 'skill.bind', 'skill', cleanSlug, { scope, scopeId, version, status })
    return this.store.get('SELECT * FROM skill_bindings WHERE scope_type = ? AND scope_id = ? AND slug = ?', scope, scopeId ?? 'global', cleanSlug)
  }

  skillBindings(projectId = null) {
    const rows = projectId
      ? this.store.all("SELECT * FROM skill_bindings WHERE scope_type = 'global' OR (scope_type = 'project' AND scope_id = ?)", projectId)
      : this.store.all('SELECT * FROM skill_bindings')
    return rows.map(row => ({
      ...row,
      projectName: row.scope_type === 'project'
        ? this.store.get('SELECT name FROM projects WHERE id = ?', row.scope_id)?.name ?? row.scope_id
        : '全局',
    }))
  }

  async rollbackSkillVersion(slug, version, actor = this.actor()) {
    const cleanSlug = slugify(slug ?? '')
    const result = rollbackSkill(this.config, { slug: cleanSlug, version: text(version, 40) })
    syncSkills(this.store, this.config.skillRoot)
    this.audit(actor, 'skill.rollback', 'skill', cleanSlug, { version: result.version })
    return result
  }

  async assignFromBot(sessionId, input) {
    const { project, actor } = this.ownerContextFor(sessionId)
    const member = this.membersOf(project.id).find(bot => bot.name.toLowerCase() === String(input.assignee ?? '').toLowerCase())
    if (!member) throw badRequest(`项目中没有 Bot ${input.assignee}`)
    if (input.taskId || input.task) {
      const task = this.resolveBotTask(project, input.taskId ?? input.task)
      if (['done', 'canceled'].includes(task.status)) throw conflict(`任务 ${project.key}-${task.number} 已结束，不能重派`)
      const updated = await this.assignTask(task.id, member.id, actor, { autoStart: false })
      void this.tick()
      return updated
    }
    const task = await this.createTask({
      projectId: project.id,
      title: input.title,
      description: input.description,
      assigneeBotId: member.id,
      priority: input.priority,
      autoStart: true,
      postCard: true,
    }, actor)
    return task
  }

  async reviewFromBot(sessionId, input) {
    const { project, actor } = this.ownerContextFor(sessionId)
    if (!['accept', 'return'].includes(input.decision)) throw badRequest('验收结果只能是 accept 或 return')
    const task = this.resolveBotTask(project, input.task)
    return this.applyReview(task, project, input.decision, input.comment, actor)
  }

  /** 验收/退回的共用流程：owner Bot 会话与微信管理员共用。 */
  async applyReview(task, project, decision, comment, actor) {
    const identifier = `${project.key}-${task.number}`
    if (task.status !== 'in_review') throw conflict(`任务 ${identifier} 不在待验收状态`)
    if (decision === 'accept') {
      await this.updateTask(task.id, { status: 'done' }, actor)
      if (comment) await this.addComment(task.id, comment, actor)
      this.insertMessage({
        projectId: project.id,
        senderType: 'system',
        senderId: 'system',
        body: `任务 ${identifier} 验收通过。`,
        taskId: task.id,
      })
    } else {
      const reason = text(comment, 20_000)
      if (!reason) throw badRequest('退回任务必须说明原因')
      if (!task.assignee_bot_id) throw conflict(`任务 ${identifier} 没有负责人，无法退回重做`)
      await this.updateTask(task.id, { status: 'in_progress' }, actor)
      await this.addComment(task.id, `退回重做：${reason}`, actor)
      // 若总监验收运行仍在进行，由其结束时的收尾逻辑补排；否则立即重排执行。
      const active = this.store.get(
        "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
        task.id,
      )
      if (!active) {
        this.enqueueOutbox({
          kind: 'task_run',
          payload: { taskId: task.id, triggerType: 'returned' },
          projectId: task.project_id,
          taskId: task.id,
          idempotencyKey: `task:${task.id}:returned:${Date.now()}`,
        })
      }
      void this.tick()
      this.insertMessage({
        projectId: project.id,
        senderType: 'system',
        senderId: 'system',
        body: `任务 ${identifier} 被总监退回重做。`,
        taskId: task.id,
      })
    }
    return this.taskView(this.taskRow(task.id))
  }

  resolveTaskByIdentifier(identifier) {
    const match = TASK_ID_PATTERN.exec(String(identifier ?? '').trim())
    if (!match) throw badRequest('任务号格式应为 <项目key>-<序号>，如 web-3')
    const project = this.store.get('SELECT * FROM projects WHERE key = ? COLLATE NOCASE', match[1])
    if (!project) throw notFound(`没有 key 为 ${match[1]} 的项目`)
    const task = this.store.get(
      'SELECT * FROM tasks WHERE project_id = ? AND number = ?',
      project.id, Number(match[2]),
    )
    if (!task) throw notFound(`项目 ${project.key} 没有任务 ${match[2]}`)
    return { project, task }
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

  /** 微信管理员指令：按 <key-N> 取任务卡片（含最近评论）。 */
  taskViewByIdentifier(identifier) {
    const { task } = this.resolveTaskByIdentifier(identifier)
    return {
      ...this.taskView(task),
      comments: this.store.all(
        'SELECT author_type, author_id, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 3',
        task.id,
      ).reverse(),
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

  rememberFromBot(sessionId, input) {
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw forbidden('只有项目群中的 Bot 可以写记忆')
    const scopeType = ['bot', 'project', 'team'].includes(input.scope) ? input.scope : 'bot'
    if (scopeType === 'project' && !binding.project_id) throw badRequest('单聊会话不在项目中，只能写 bot 或 team 记忆')
    const scopeId = scopeType === 'project' ? binding.project_id : scopeType === 'team' ? 'team' : binding.bot_id
    return this.createMemory({
      scopeType,
      scopeId,
      topic: input.topic,
      content: input.content,
      source: `session:${sessionId}`,
      confidence: 0.9,
      createdBy: `bot:${binding.bot_id}`,
      actor: { type: 'bot', id: binding.bot_id },
    })
  }

  proposeFromBot(sessionId, input) {
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw forbidden('只有项目群中的 Bot 可以提交进化提案')
    const kind = input.kind === 'skill' ? 'skill' : 'bot_update'
    return this.createProposal({
      kind,
      botId: binding.bot_id,
      projectId: binding.project_id,
      title: input.title,
      rationale: input.rationale,
      payload: input.payload ?? {},
      evaluation: input.evaluation,
    }, { type: 'bot', id: binding.bot_id })
  }

  async taskDetail(taskId) {
    const task = this.taskRow(taskId)
    const project = this.projectRow(task.project_id)
    const comments = this.store.all('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at', taskId)
    const events = this.store.all('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at', taskId)
    const runs = this.store.all('SELECT * FROM runs WHERE task_id = ? ORDER BY queued_at DESC', taskId)
    const dependencies = this.store.all(
      'SELECT t.id, t.number, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id WHERE d.task_id = ?',
      taskId,
    )
    return {
      ...this.taskView(task),
      projectKey: project.key,
      comments: comments.map(comment => ({
        ...comment,
        authorName: comment.author_type === 'bot'
          ? this.store.get('SELECT name FROM bots WHERE id = ?', comment.author_id)?.name ?? 'Bot'
          : this.actorName({ type: 'user', id: comment.author_id }),
      })),
      events,
      runs: runs.map(run => this.runView(run)),
      dependencies,
    }
  }

  runView(run) {
    const bot = this.store.get('SELECT name FROM bots WHERE id = ?', run.bot_id)
    const task = run.task_id ? this.store.get('SELECT number, title FROM tasks WHERE id = ?', run.task_id) : undefined
    const project = run.project_id ? this.store.get('SELECT key FROM projects WHERE id = ?', run.project_id) : undefined
    const { write_scopes: rawScopes, ...rest } = run
    return {
      ...rest,
      artifacts: jsonParse(run.artifacts, []),
      botName: bot?.name ?? 'Bot',
      taskIdentifier: task ? `${project?.key ?? 'T'}-${task.number}` : null,
      taskTitle: task?.title ?? null,
      writeScopes: readWriteScopes(rawScopes),
    }
  }

  // 产物清单视图：HTTP 端点与运行详情面板共用。
  listRunArtifacts(runId) {
    const run = this.runRow(runId)
    const list = jsonParse(run.artifacts, [])
    return { runId, artifacts: Array.isArray(list) ? list : [] }
  }

  // 产物文件定位：仅允许读取该运行清单里的相对路径，且必须落在项目工作区内（含符号链接校验）。
  artifactFile(runId, relPath) {
    const run = this.runRow(runId)
    const project = run.project_id
      ? this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id)
      : null
    if (!project?.slug) throw notFound('运行没有关联的项目工作区')
    const list = jsonParse(run.artifacts, [])
    if (!Array.isArray(list) || !list.some(item => item?.path === relPath)) {
      throw forbidden('文件不在该运行的产物清单中')
    }
    const dir = this.projectWorkDir(project)
    let absolutePath
    try {
      absolutePath = assertInside(dir, join(dir, relPath))
    } catch {
      throw forbidden('产物路径越界')
    }
    let info
    try {
      info = statSync(absolutePath)
    } catch {
      throw notFound('产物文件不存在')
    }
    if (!info.isFile()) throw notFound('产物不是常规文件')
    const realFile = realpathSync(absolutePath)
    const realDir = realpathSync(dir)
    if (realFile === realDir || !realFile.startsWith(realDir + sep)) throw forbidden('产物路径越界')
    return { absolutePath, size: info.size }
  }

  // ── 聊天图片通道（GET /api/dsh-team/file）──────────────────────────────
  // 定位聊天消息里 markdown 图片引用的工作区文件：只认项目工作目录或单聊 Bot
  // 工作区内的白名单图片，路径解析 + realpath 双重防穿越（与 artifactFile 同口径）。
  // SVG 可执行脚本，永不放行；尺寸上限由 HTTP 层把关（MAX_CHAT_IMAGE_BYTES）。
  chatFile({ projectId, soloBotId, path } = {}) {
    const CHAT_IMAGE_TYPES = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    }
    const relPath = String(path ?? '').trim()
    if (!relPath) throw badRequest('缺少参数 path')
    let dir
    if (projectId) {
      dir = this.projectWorkDir(this.projectRow(String(projectId)))
    } else if (soloBotId) {
      const bot = this.botRow(String(soloBotId))
      if (!bot?.solo_dir) throw notFound('该 Bot 没有单聊工作区')
      dir = join(this.config.workspace, '_the_bots', bot.solo_dir)
    } else {
      throw badRequest('缺少参数 projectId 或 soloBotId')
    }
    const contentType = CHAT_IMAGE_TYPES[extname(relPath).toLowerCase()]
    if (!contentType) throw badRequest('仅支持 png / jpg / jpeg / gif / webp 图片')
    let absolutePath
    try {
      absolutePath = assertInside(dir, join(dir, relPath))
    } catch {
      throw forbidden('图片路径越界')
    }
    let info
    try {
      info = statSync(absolutePath)
    } catch {
      throw notFound('图片文件不存在')
    }
    if (!info.isFile()) throw notFound('图片不是常规文件')
    const realFile = realpathSync(absolutePath)
    const realDir = realpathSync(dir)
    if (realFile === realDir || !realFile.startsWith(realDir + sep)) throw forbidden('图片路径越界')
    return { absolutePath, size: info.size, contentType }
  }

  // ── 工作台终端（非交互式命令台）───────────────────────────────────────────
  // 安全口径与 Bot 相同：命令以当前用户执行、权限与服务进程一致；
  // HTTP 入口由宿主 owner 路由鉴权（见 src/api.js），此处不再重复校验。
  // 不做 PTY/xterm：无法承载 vim 等交互式程序，定位是快速执行命令行命令。

  runTerminalCommand(projectId, command, actor = this.actor()) {
    const project = this.projectRow(projectId)
    if (project.status !== 'active') throw badRequest('项目已归档，不能执行终端命令')
    const clean = String(command ?? '').trim()
    if (!clean) throw badRequest('命令不能为空')
    if (clean.length > TERMINAL_COMMAND_MAX) throw badRequest(`命令过长（最多 ${TERMINAL_COMMAND_MAX} 字符）`)
    // 同项目同时只允许一条运行：检查与插入之间无 await，单线程内不会交错。
    if (this.store.get("SELECT id FROM terminal_commands WHERE project_id = ? AND status = 'running'", project.id)) {
      throw conflict('该项目已有终端命令在运行，请先停止或等待它结束')
    }
    const commandId = id('term')
    const createdAt = nowIso()
    // 命令与聊天消息同一姿势：可能拼进密钥值，入库（行、审计）前先过掩码，密钥原文不落库。
    const storableCommand = this.maskSecretValues(clean)
    this.store.run(
      `INSERT INTO terminal_commands(id, project_id, command, status, created_at) VALUES (?, ?, ?, 'running', ?)`,
      commandId, project.id, storableCommand, createdAt,
    )
    const entry = { child: null, buffer: '', startedAtMs: Date.now(), timedOut: false, cancelRequested: false, timer: null }
    this.terminalActive.set(commandId, entry)
    try {
      entry.child = spawn('/bin/sh', ['-c', clean], {
        cwd: this.projectWorkDir(project),
        env: process.env,
        detached: true, // 独立进程组：kill(-pid) 能带走整条命令管线
      })
    } catch (error) {
      this.finishTerminalCommand(commandId, 'failed', null, `无法启动命令：${error?.message ?? error}`)
      throw badRequest(`无法启动命令：${error?.message ?? error}`)
    }
    entry.child.stdout?.setEncoding('utf8')
    entry.child.stderr?.setEncoding('utf8')
    entry.child.stdout?.on('data', chunk => { entry.buffer = appendTerminalChunk(entry.buffer, chunk) })
    entry.child.stderr?.on('data', chunk => { entry.buffer = appendTerminalChunk(entry.buffer, chunk) })
    entry.timer = setTimeout(() => {
      entry.timedOut = true
      killTerminalGroup(entry.child)
    }, this.config.terminalTimeoutMs ?? 120_000)
    entry.timer.unref?.()
    entry.child.on('close', () => {
      const code = entry.child.exitCode
      if (entry.timedOut) this.finishTerminalCommand(commandId, 'timeout', code, '命令超时，进程组已被终止')
      else if (entry.cancelRequested) this.finishTerminalCommand(commandId, 'canceled', code, '手动停止')
      else if (code === 0) this.finishTerminalCommand(commandId, 'succeeded', 0, null)
      else this.finishTerminalCommand(commandId, 'failed', code, code === null ? '命令被信号终止' : null)
    })
    entry.child.on('error', error => {
      this.finishTerminalCommand(commandId, 'failed', null, `命令执行失败：${error?.message ?? error}`)
    })
    this.audit(actor, 'terminal.run', 'project', project.id, { command: storableCommand })
    return this.terminalCommandView(this.store.get('SELECT * FROM terminal_commands WHERE id = ?', commandId))
  }

  cancelTerminalCommand(commandId, actor = this.actor()) {
    const row = this.store.get('SELECT * FROM terminal_commands WHERE id = ?', commandId)
    if (!row) throw notFound('终端命令不存在')
    if (row.status !== 'running') throw conflict('命令已结束，无需停止')
    const entry = this.terminalActive.get(commandId)
    if (!entry) {
      // 理论上重启即置 interrupted，这里兜底清理无进程可控的 running 行。
      this.finishTerminalCommand(commandId, 'canceled', null, '服务重启后手动清理')
    } else {
      entry.cancelRequested = true
      killTerminalGroup(entry.child)
    }
    this.audit(actor, 'terminal.cancel', 'terminal_command', commandId, {})
    return this.terminalCommandView(this.store.get('SELECT * FROM terminal_commands WHERE id = ?', commandId))
  }

  terminalState(projectId) {
    // 顺手清理：每项目只保留最近 TERMINAL_HISTORY_LIMIT 条，不新增定时器。
    this.store.run(
      `DELETE FROM terminal_commands WHERE project_id = ? AND id NOT IN (
         SELECT id FROM terminal_commands WHERE project_id = ? ORDER BY created_at DESC LIMIT ?)`,
      projectId, projectId, TERMINAL_HISTORY_LIMIT,
    )
    const history = this.store.all(
      'SELECT * FROM terminal_commands WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
      projectId, TERMINAL_HISTORY_LIMIT,
    ).map(row => this.terminalCommandView(row))
    const running = history.find(row => row.status === 'running') ?? null
    let active = null
    if (running) {
      const entry = this.terminalActive.get(running.id)
      active = {
        ...running,
        // 实时 tail 同样先过掩码：密钥值不得进 UI。
        output: entry ? this.maskSecretValues(entry.buffer.slice(-TERMINAL_OUTPUT_CAP)) : running.output,
        elapsedMs: entry ? Date.now() - entry.startedAtMs : null,
      }
    }
    return { active, history }
  }

  // 收尾是幂等的：'error' 与 'close' 可能先后触发，Map 里的 entry 释放即视为已收尾。
  finishTerminalCommand(commandId, status, exitCode, errorMessage) {
    const entry = this.terminalActive.get(commandId)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      this.terminalActive.delete(commandId)
    }
    // 输出先过密钥掩码再落库：密钥值不得进库（也就不会进 UI 与历史）。
    const output = this.maskSecretValues(String(entry?.buffer ?? '').slice(-TERMINAL_OUTPUT_CAP))
    // 服务停机竞态：子进程在 store 关闭后才退出时，收尾写库失败只告警，不再炸进程。
    try {
      const row = this.store.get('SELECT project_id FROM terminal_commands WHERE id = ?', commandId)
      this.store.run(
        `UPDATE terminal_commands SET status = ?, exit_code = ?, output = ?, error_message = ?, ended_at = ? WHERE id = ?`,
        status, exitCode, output, errorMessage, nowIso(), commandId,
      )
      if (row) this.trimTerminalHistory(row.project_id)
    } catch (error) {
      this.logger.warn?.(`dsh-team: terminal command ${commandId} 收尾落库失败：${error?.message ?? error}`)
    }
  }

  trimTerminalHistory(projectId) {
    this.store.run(
      `DELETE FROM terminal_commands WHERE project_id = ? AND id NOT IN (
         SELECT id FROM terminal_commands WHERE project_id = ? ORDER BY created_at DESC LIMIT ?)`,
      projectId, projectId, TERMINAL_HISTORY_LIMIT,
    )
  }

  terminalCommandView(row) {
    return {
      id: row.id,
      // 命令本身也可能拼了密钥值（如 echo $TOKEN 的展开结果），出视图前同样过掩码。
      command: this.maskSecretValues(row.command),
      status: row.status,
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
      output: row.output ?? '',
      errorMessage: row.error_message ?? null,
      createdAt: row.created_at,
      endedAt: row.ended_at ?? null,
      durationMs: row.ended_at && row.created_at
        ? Math.max(0, new Date(row.ended_at).getTime() - new Date(row.created_at).getTime())
        : null,
    }
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

  latestPrices() {
    const rows = this.store.all('SELECT * FROM model_prices ORDER BY effective_at DESC')
    const latest = new Map()
    for (const row of rows) {
      const key = priceKey(row.provider, row.model)
      if (!latest.has(key)) latest.set(key, row)
    }
    return [...latest.values()].sort((a, b) => {
      const left = `${a.provider} ${a.model}`.toLowerCase()
      const right = `${b.provider} ${b.model}`.toLowerCase()
      return left.localeCompare(right)
    })
  }

  async models(force = false) {
    return this.runtime?.catalog(force) ?? []
  }

  // 当前项目的技能池：扫描项目目录（生产目录优先，见 projectWorkDir）的
  // .agents / .claude / .codex 三个根，同名技能按根优先级去重；只做发现，不写入共享技能池。
  projectSkillView(project) {
    const dir = this.projectWorkDir(project)
    const { skills } = scanProjectSkills(dir)
    return skills.map(skill => ({
      name: skill.name,
      slug: skill.slug,
      description: skill.description,
      version: skill.version,
      path: skill.path,
      root: skill.root,
      roots: skill.roots,
      duplicates: skill.duplicates,
      relativePath: skill.relativePath,
    }))
  }

  async syncSkillsNow(actor = this.actor()) {
    const entries = syncSkills(this.store, this.config.skillRoot)
    this.audit(actor, 'skills.sync', 'skill', '*', { count: entries.length })
    return {
      count: entries.length,
      skills: skillSnapshot(this.store, this.config),
    }
  }

  // 项目内关闭/恢复技能：仅影响该项目（补全过滤 + Bot 系统提示禁用清单），技能池本身不变。
  async setProjectSkillDisabled(projectId, slug, disabled, actor = this.actor()) {
    await this.initialize()
    const project = this.projectRow(projectId)
    const cleanSlug = String(slug ?? '').trim()
    const skill = this.store.get('SELECT slug FROM skills WHERE slug = ?', cleanSlug)
    if (!skill) throw notFound(`技能 ${cleanSlug || '(空)'} 不存在`)
    const current = parseDisabledSkills(project.disabled_skills)
    const next = disabled === true
      ? [...new Set([...current, cleanSlug])]
      : current.filter(item => item !== cleanSlug)
    this.store.run('UPDATE projects SET disabled_skills = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), nowIso(), project.id)
    this.audit(actor, 'project.skill_toggle', 'project', project.id, { slug: cleanSlug, disabled: disabled === true })
    return this.projectView(this.projectRow(project.id))
  }

  // 技能详情：按需读盘返回 SKILL.md 全文与版本历史（不进 state 载荷）。
  async skillDetail(slug) {
    await this.initialize()
    const cleanSlug = String(slug ?? '').trim()
    const row = this.store.get('SELECT * FROM skills WHERE slug = ?', cleanSlug)
    if (!row) throw notFound(`技能 ${cleanSlug || '(空)'} 不存在`)
    const fallbackPath = join(this.config.skillRoot, 'skills', cleanSlug, 'SKILL.md')
    let content = ''
    let readable = false
    for (const locator of [row.path, fallbackPath]) {
      if (!locator) continue
      try {
        content = readFileSync(locator, 'utf8')
        readable = true
        break
      } catch {}
    }
    const versions = this.store.all(
      'SELECT version, checksum, status, created_at FROM skill_versions WHERE slug = ? ORDER BY created_at DESC',
      cleanSlug,
    )
    return { ...row, content, readable, sharedPath: fallbackPath, versions }
  }

  async savePrice(input, actor = this.actor()) {
    const priceId = setPrice(this.store, input)
    this.audit(actor, 'price.save', 'model_price', priceId, input)
    return this.store.get('SELECT * FROM model_prices WHERE id = ?', priceId)
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

  // 把某条价格恢复为配置里的默认值：写一条新版本，保留历史。
  async resetPrice(input, actor = this.actor()) {
    const provider = String(input.provider ?? '').trim()
    const model = String(input.model ?? '').trim()
    if (!model) throw badRequest('缺少参数 model')
    const defaults = this.config.modelPrices ?? []
    const fallback = defaults.find(item => item.model.toLowerCase() === model.toLowerCase()
      && item.provider.toLowerCase() === provider.toLowerCase())
      ?? defaults.find(item => item.model.toLowerCase() === model.toLowerCase())
    if (!fallback) throw notFound(`模型 ${model} 没有配置默认价格`)
    const priceId = setPrice(this.store, {
      provider,
      model,
      inputPerMtok: fallback.inputPerMtok,
      cacheReadPerMtok: fallback.cacheReadPerMtok,
      cacheWritePerMtok: fallback.cacheWritePerMtok,
      outputPerMtok: fallback.outputPerMtok,
      currency: fallback.currency,
    })
    this.audit(actor, 'price.reset', 'model_price', priceId, { provider, model })
    return this.store.get('SELECT * FROM model_prices WHERE id = ?', priceId)
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
])
