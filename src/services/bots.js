// src/services/bots.js —— Bot 管理域
// Bot 建档、档案更新、归档回滚与视图；单聊工作区目录的落位。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { join } from 'node:path'
import { badRequest, conflict, notFound } from '../errors.js'
import { botWorkspaceDir, botsHome, SLUG_MAX } from '../paths.js'
import { id, nowIso, slugify, text } from '../util.js'
import { normalizeFilePolicy } from './file-policy.js'

export const COLORS = ['blue', 'teal', 'violet', 'amber', 'coral', 'pink', 'green', 'gray']

export const botNamePattern = /^[\p{L}\p{N}_-]{1,24}$/u

export const botsMethods = {
  async createBot(input, actor = this.actor()) {
    const name = text(input.name, 40).replace(/\s+/g, '')
    if (!botNamePattern.test(name)) throw badRequest('Bot 名称只允许中文、字母、数字、下划线、连字符，最多 24 个字符')
    if (this.store.get('SELECT id FROM bots WHERE lower(name) = lower(?)', name)) throw conflict('Bot 名称已存在')
    const provider = input.provider ? text(input.provider, 80) : null
    const model = input.model ? text(input.model, 160) : null
    const effort = input.effort ? text(input.effort, 80) : null
    if ((provider && !model) || (!provider && model)) throw badRequest('provider 和 model 必须同时提供')
    if (provider && model) await this.runtime?.validateBotConfig({ provider, model, effort })
    const botId = id('bot')
    const createdAt = nowIso()
    const role = text(input.role, 24)
    const instructions = text(input.instructions, 12_000)
    const color = COLORS.includes(input.color) ? input.color : 'blue'
    const filePolicy = normalizeFilePolicy(input.filePolicy)
    const soloDir = this.soloDirFor(name, botId)
    // 先建目录再建号：目录建不出来就别留下一个单聊必然失败的 bot 行。
    try {
      await this.ensureBotDir(soloDir)
    } catch (error) {
      throw badRequest(`单聊工作区创建失败：${error.message}`)
    }
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO bots(id, name, role, instructions, color, provider, model, effort, file_policy, solo_dir,
          status, current_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        botId, name, role, instructions, color, provider, model, effort, filePolicy, soloDir, createdAt, createdAt,
      )
      this.store.run(
        `INSERT INTO bot_revisions(id, bot_id, version, role, instructions, provider, model, effort, created_by, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        id('rev'), botId, role, instructions, provider, model, effort, `${actor.type}:${actor.id}`, createdAt,
      )
      this.audit(actor, 'bot.create', 'bot', botId, { name, provider, model, effort, file_policy: filePolicy })
    })
    return this.botView(this.botRow(botId))
  },

  // 单聊目录名：优先用名字的 slug，纯中文名回退到 bot-<id 末 6 位>；冲突时追加序号。
  // 目录名要过 safeSlug（长度上限 48），追加序号时按后缀长度截断基础名。
  soloDirFor(name, botId) {
    const base = slugify(name) || `bot-${botId.slice(-6)}`
    let candidate = base
    let suffix = 1
    while (this.store.get('SELECT 1 AS ok FROM bots WHERE solo_dir = ?', candidate)) {
      suffix += 1
      const tail = `-${suffix}`
      candidate = `${base.slice(0, SLUG_MAX - tail.length)}${tail}`
    }
    return candidate
  },

  // 建 _the_bots/<dir> 专属目录。失败直接抛：目录建不出来时单聊必然起不来，
  // 与其留一个半残 bot 行，不如在建号当场报错。
  async ensureBotDir(soloDir) {
    return botWorkspaceDir(this.config.workspace, soloDir)
  },

  // 存量 bot 回填 solo_dir 并确保每个 bot 的专属目录存在。
  async ensureSoloWorkspaces() {
    const bots = this.store.all('SELECT id, name, solo_dir FROM bots')
    if (!bots.length) return
    await botsHome(this.config.workspace)
    for (const bot of bots) {
      const dir = bot.solo_dir || this.soloDirFor(bot.name, bot.id)
      if (dir !== bot.solo_dir) {
        this.store.run('UPDATE bots SET solo_dir = ? WHERE id = ? AND solo_dir IS NULL', dir, bot.id)
      }
      // 回填是启动期的兜底：单个 bot 目录建不出来只告警，不拖垮整个启动。
      try {
        await this.ensureBotDir(dir)
      } catch (error) {
        this.logger.warn?.(`单聊目录 ${dir} 创建失败：${error.message}`)
      }
    }
  },
  async updateBot(botId, patch, actor = this.actor()) {
    const bot = this.botRow(botId)
    const changes = {}
    if (patch.name !== undefined) {
      const name = text(patch.name, 40).replace(/\s+/g, '')
      if (!botNamePattern.test(name)) throw badRequest('Bot 名称格式无效')
      const duplicate = this.store.get('SELECT id FROM bots WHERE lower(name) = lower(?) AND id <> ?', name, botId)
      if (duplicate) throw conflict('Bot 名称已存在')
      changes.name = name
    }
    if (patch.role !== undefined) changes.role = text(patch.role, 24)
    if (patch.instructions !== undefined) changes.instructions = text(patch.instructions, 12_000)
    if (patch.color !== undefined && COLORS.includes(patch.color)) changes.color = patch.color
    if (patch.filePolicy !== undefined) {
      const filePolicy = normalizeFilePolicy(patch.filePolicy)
      if (filePolicy !== bot.file_policy) changes.file_policy = filePolicy
    }
    if (patch.status !== undefined) {
      if (!['active', 'paused', 'archived'].includes(patch.status)) throw badRequest('Bot 状态无效')
      changes.status = patch.status
    }
    let provider = bot.provider
    let model = bot.model
    let effort = bot.effort
    if (patch.provider !== undefined) provider = patch.provider ? text(patch.provider, 80) : null
    if (patch.model !== undefined) model = patch.model ? text(patch.model, 160) : null
    if (patch.effort !== undefined) effort = patch.effort ? text(patch.effort, 80) : null
    if ((provider && !model) || (!provider && model)) throw badRequest('provider 和 model 必须同时提供')
    if (provider && model) await this.runtime?.validateBotConfig({ provider, model, effort })
    if (!provider) effort = null
    const configChanged = provider !== bot.provider || model !== bot.model || effort !== bot.effort
      || (changes.role !== undefined && changes.role !== bot.role)
      || (changes.instructions !== undefined && changes.instructions !== bot.instructions)
    if (changes.status === 'archived') {
      const owned = this.store.get("SELECT id FROM projects WHERE owner_bot_id = ? AND status = 'active'", botId)
      if (owned) throw conflict('该 Bot 仍是活动项目总监，请先更换总监')
    }
    this.store.transaction(() => {
      const fields = []
      const values = []
      for (const [key, value] of Object.entries(changes)) {
        fields.push(`${key} = ?`)
        values.push(value)
      }
      fields.push('provider = ?', 'model = ?', 'effort = ?', 'updated_at = ?')
      values.push(provider, model, effort, nowIso())
      this.store.run(`UPDATE bots SET ${fields.join(', ')} WHERE id = ?`, ...values, botId)
      if (configChanged) {
        const version = (Number(bot.current_revision) || 0) + 1
        this.store.run(
          `INSERT INTO bot_revisions(id, bot_id, version, role, instructions, provider, model, effort, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id('rev'), botId, version,
          changes.role ?? bot.role,
          changes.instructions ?? bot.instructions,
          provider, model, effort,
          `${actor.type}:${actor.id}`, nowIso(),
        )
        this.store.run('UPDATE bots SET current_revision = ? WHERE id = ?', version, botId)
      }
      this.audit(actor, 'bot.update', 'bot', botId, changes)
    })
    return this.botView(this.botRow(botId))
  },
  async archiveBot(botId, actor = this.actor()) {
    return this.updateBot(botId, { status: 'archived' }, actor)
  },
  async rollbackBot(botId, revisionId, actor = this.actor()) {
    const revision = this.store.get('SELECT * FROM bot_revisions WHERE id = ? AND bot_id = ?', revisionId, botId)
    if (!revision) throw notFound('Bot 版本不存在')
    return this.updateBot(botId, {
      role: revision.role,
      instructions: revision.instructions,
      provider: revision.provider,
      model: revision.model,
      effort: revision.effort,
    }, actor)
  },
  botView(bot) {
    const memoryCount = this.store.get(
      "SELECT COUNT(*) AS count FROM memories WHERE scope_type = 'bot' AND scope_id = ? AND status = 'active'",
      bot.id,
    )?.count ?? 0
    const openTasks = this.store.get(
      "SELECT COUNT(*) AS count FROM tasks WHERE assignee_bot_id = ? AND status NOT IN ('done', 'canceled')",
      bot.id,
    )?.count ?? 0
    const runs = this.store.get(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         MAX(ended_at) AS last_run_at
       FROM runs WHERE bot_id = ?`,
      bot.id,
    )
    return {
      ...bot,
      modelRef: bot.provider && bot.model ? `${bot.provider}/${bot.model}` : null,
      soloDir: bot.solo_dir ?? null,
      soloWorkspace: bot.solo_dir ? join(this.config.workspace, '_the_bots', bot.solo_dir) : null,
      memoryCount: Number(memoryCount),
      openTasks: Number(openTasks),
      stats: {
        runs: Number(runs?.total ?? 0),
        succeeded: Number(runs?.succeeded ?? 0),
        failed: Number(runs?.failed ?? 0),
        lastRunAt: runs?.last_run_at ?? null,
      },
    }
  },
  async botDetail(botId) {
    const bot = this.botRow(botId)
    return {
      bot: this.botView(bot),
      revisions: this.store.all('SELECT * FROM bot_revisions WHERE bot_id = ? ORDER BY version DESC', botId),
      memories: this.store.all("SELECT * FROM memories WHERE scope_type = 'bot' AND scope_id = ? AND status = 'active' ORDER BY updated_at DESC", botId),
      projects: this.store.all('SELECT id, key, name FROM projects WHERE owner_bot_id = ?', botId),
    }
  },
}
