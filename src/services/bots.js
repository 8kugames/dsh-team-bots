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

// solo_dir 唯一冲突时事务内重生成候选的 INSERT 尝试上限。
const SOLO_DIR_INSERT_ATTEMPTS = 5

// node:sqlite 的唯一约束错误只能按 message 判列（code 恒为 ERR_SQLITE_ERROR）：
// 'UNIQUE constraint failed: bots.solo_dir'。返回冲突列名；非唯一约束错误返回 null。
const uniqueColumn = (error) => {
  const prefix = 'UNIQUE constraint failed: '
  const message = String(error?.message ?? '')
  return message.startsWith(prefix) ? message.slice(prefix.length).trim() : null
}

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
    // 备用模型：主 provider 不可用时临时接手；provider 与 model 成对，effort 可空（走模型默认）。
    const fallbackProvider = input.fallbackProvider ? text(input.fallbackProvider, 80) : null
    const fallbackModel = input.fallbackModel ? text(input.fallbackModel, 160) : null
    const fallbackEffort = input.fallbackEffort ? text(input.fallbackEffort, 80) : null
    if ((fallbackProvider && !fallbackModel) || (!fallbackProvider && fallbackModel)) {
      throw badRequest('备用模型的 provider 和 model 必须同时提供')
    }
    if (fallbackProvider && fallbackModel) {
      await this.runtime?.validateBotConfig({ provider: fallbackProvider, model: fallbackModel, effort: fallbackEffort })
    }
    const botId = id('bot')
    const createdAt = nowIso()
    const role = text(input.role, 24)
    const instructions = text(input.instructions, 12_000)
    const color = COLORS.includes(input.color) ? input.color : 'blue'
    const filePolicy = normalizeFilePolicy(input.filePolicy)
    // 先建目录再建号：目录建不出来就别留下一个单聊必然失败的 bot 行。
    // 这里预建的是占位候选；并发同名时权威 solo_dir 在事务内重算，输家目录提交后补建。
    const placeholder = this.soloDirFor(name, botId)
    try {
      await this.ensureBotDir(placeholder)
    } catch (error) {
      throw badRequest(`单聊工作区创建失败：${error.message}`)
    }
    let soloDir = placeholder
    this.store.transaction(() => {
      // 权威候选在 BEGIN IMMEDIATE 之后才生成，且与 INSERT 之间无 await：
      // 同名并发不会双双通过查重再对撞 bots.solo_dir 唯一索引。
      soloDir = this.soloDirFor(name, botId)
      for (let attempt = 1; ; attempt++) {
        try {
          this.store.run(
            `INSERT INTO bots(id, name, role, instructions, color, provider, model, effort,
              fallback_provider, fallback_model, fallback_effort, file_policy, solo_dir,
              status, current_revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
            botId, name, role, instructions, color, provider, model, effort,
            fallbackProvider, fallbackModel, fallbackEffort, filePolicy, soloDir, createdAt, createdAt,
          )
          break
        } catch (error) {
          const column = uniqueColumn(error)
          // 并发输掉名称查重的请求在这里拿到与名称预检一致的 conflict，而非裸 SQLITE 错误。
          if (column === 'bots.name') throw conflict('Bot 名称已存在')
          if (column !== 'bots.solo_dir') throw error
          if (attempt >= SOLO_DIR_INSERT_ATTEMPTS) {
            throw badRequest(`单聊目录分配冲突，请重试或更换 Bot 名称：${name}`)
          }
          soloDir = this.soloDirFor(name, botId)
        }
      }
      this.store.run(
        `INSERT INTO bot_revisions(id, bot_id, version, role, instructions, created_by, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?)`,
        id('rev'), botId, role, instructions, `${actor.type}:${actor.id}`, createdAt,
      )
      this.audit(actor, 'bot.create', 'bot', botId, {
        name, provider, model, effort,
        fallback_provider: fallbackProvider, fallback_model: fallbackModel, fallback_effort: fallbackEffort,
        file_policy: filePolicy,
      })
    })
    // 输家目录提交后补建；失败只告警，启动期 ensureSoloWorkspaces 兜底回补。
    if (soloDir !== placeholder) {
      try {
        await this.ensureBotDir(soloDir)
      } catch (error) {
        this.logger.warn?.(`单聊目录 ${soloDir} 补建失败：${error.message}`)
      }
    }
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
    // removed 是移除追踪的终态：档案与历史仍可读，但不再接受任何修改（含 status 复活）。
    if (bot.status === 'removed') throw badRequest('该 Bot 已移除追踪，不能再修改')
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
    // 备用模型：留空即关闭（三个字段一起清）。
    let fallbackProvider = bot.fallback_provider
    let fallbackModel = bot.fallback_model
    let fallbackEffort = bot.fallback_effort
    if (patch.fallbackProvider !== undefined) fallbackProvider = patch.fallbackProvider ? text(patch.fallbackProvider, 80) : null
    if (patch.fallbackModel !== undefined) fallbackModel = patch.fallbackModel ? text(patch.fallbackModel, 160) : null
    if (patch.fallbackEffort !== undefined) fallbackEffort = patch.fallbackEffort ? text(patch.fallbackEffort, 80) : null
    if ((fallbackProvider && !fallbackModel) || (!fallbackProvider && fallbackModel)) {
      throw badRequest('备用模型的 provider 和 model 必须同时提供')
    }
    if (fallbackProvider && fallbackModel) {
      await this.runtime?.validateBotConfig({ provider: fallbackProvider, model: fallbackModel, effort: fallbackEffort })
    }
    if (!fallbackModel) fallbackEffort = null
    if (fallbackProvider !== bot.fallback_provider) changes.fallback_provider = fallbackProvider
    if (fallbackModel !== bot.fallback_model) changes.fallback_model = fallbackModel
    if (fallbackEffort !== bot.fallback_effort) changes.fallback_effort = fallbackEffort
    // 版本快照只覆盖角色+指令（DSHBOTS-51）：模型类字段（主/备 provider·model·effort）修改即生效，
    // 仅落库+审计、不进版本历史；表里的 provider/model/effort 列只为存量行保留，新行不再写入。
    // 快照与最新版本行逐字段比对（无版本行的存量 bot 以当前 bot 行为基线）；
    const effectiveRole = changes.role !== undefined ? changes.role : bot.role
    const effectiveInstructions = changes.instructions !== undefined ? changes.instructions : bot.instructions
    const latestRevision = this.store.get(
      'SELECT role, instructions FROM bot_revisions WHERE bot_id = ? ORDER BY version DESC LIMIT 1',
      botId,
    )
    const snapshotBaseline = latestRevision ?? { role: bot.role, instructions: bot.instructions }
    const snapshotUnchanged = effectiveRole === snapshotBaseline.role && effectiveInstructions === snapshotBaseline.instructions
    const snapshotTouched = changes.role !== undefined || changes.instructions !== undefined
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
      if (!snapshotUnchanged) {
        const version = (Number(bot.current_revision) || 0) + 1
        this.store.run(
          `INSERT INTO bot_revisions(id, bot_id, version, role, instructions, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id('rev'), botId, version,
          effectiveRole, effectiveInstructions,
          `${actor.type}:${actor.id}`, nowIso(),
        )
        this.store.run('UPDATE bots SET current_revision = ? WHERE id = ?', version, botId)
      }
      // 同内容重复保存（含回滚到当前内容）是 no-op：不插版本行、不 bump，审计带 unchanged 标记留痕。
      this.audit(actor, 'bot.update', 'bot', botId, snapshotTouched && snapshotUnchanged ? { ...changes, unchanged: true } : changes)
    })
    return this.botView(this.botRow(botId))
  },
  async archiveBot(botId, actor = this.actor()) {
    return this.updateBot(botId, { status: 'archived' }, actor)
  },
  // 移除追踪（DSHBOTS-193）：已归档 Bot 的软移除——bots.status 落 removed 终态，
  // 工作台列表不再展示；运行记录、单聊消息、版本、记忆与单聊工作区目录全部保留。
  async removeBotTracking(botId, input = {}, actor = this.actor()) {
    const bot = this.botRow(botId)
    if (bot.status !== 'archived') throw badRequest('Bot 未归档，先归档再移除追踪')
    if (String(input.confirmName ?? '').trim() !== bot.name) throw badRequest('确认名称与 Bot 名称不一致，已拒绝移除')
    const activeRuns = this.store.get(
      "SELECT COUNT(*) AS count FROM runs WHERE bot_id = ? AND status IN ('queued', 'running')",
      botId,
    )?.count ?? 0
    if (activeRuns > 0) throw badRequest('该 Bot 仍有排队或运行中的运行，稍后再移除')
    this.store.transaction(() => {
      this.store.run("UPDATE bots SET status = 'removed', updated_at = ? WHERE id = ?", nowIso(), botId)
      this.audit(actor, 'bot.remove_tracking', 'bot', botId, { name: bot.name, soloDir: bot.solo_dir })
    })
    return { removed: true, name: bot.name }
  },
  async rollbackBot(botId, revisionId, actor = this.actor()) {
    const revision = this.store.get('SELECT * FROM bot_revisions WHERE id = ? AND bot_id = ?', revisionId, botId)
    if (!revision) throw notFound('Bot 版本不存在')
    // 只还原角色/指令（DSHBOTS-51）：revision 行里的模型字段是快照当时的配置，不随版本回滚。
    return this.updateBot(botId, {
      role: revision.role,
      instructions: revision.instructions,
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
      fallbackModelRef: bot.fallback_provider && bot.fallback_model ? `${bot.fallback_provider}/${bot.fallback_model}` : null,
      fallbackConfigured: Boolean(bot.fallback_provider && bot.fallback_model),
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
