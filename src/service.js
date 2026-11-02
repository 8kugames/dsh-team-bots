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
import { projectsMethods } from './services/projects.js'
import { chatMethods } from './services/chat.js'
import { tasksMethods } from './services/tasks.js'
import { runsMethods } from './services/runs.js'
import { schedulerMethods } from './services/scheduler.js'
import { memoryMethods } from './services/memory.js'

export { WRITE_SCOPE_MAX, WRITE_SCOPE_MAX_LEN, parseWriteScopes, readWriteScopes, writeScopePathsOverlap, writeScopesOverlap } from './services/write-scopes.js'
export { FILE_POLICIES, FILE_POLICY_LABELS } from './services/file-policy.js'
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
  projectsMethods,
  chatMethods,
  tasksMethods,
  runsMethods,
  schedulerMethods,
  memoryMethods,
])
