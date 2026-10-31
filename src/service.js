import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError, badRequest, conflict, forbidden, notFound } from './errors.js'
import { ensureProjectWorkspace, projectDir } from './paths.js'
import { monthUsageForProject, runUsageTotals, setPrice, usageSnapshot } from './usage.js'
import { latestDshVersion, compareVersions, validTargetVersion } from './updater.js'
import { priceKey, seedModelPrices } from './pricing.js'
import { publishSkill, skillSnapshot, syncSkills } from './skills.js'
import {
  clampNumber, id, jsonParse, nowIso, parseMentions, projectKey, redactSecrets,
  slugify, text, sanitizeFilename, writeIfChanged,
} from './util.js'

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
const COLORS = ['blue', 'teal', 'violet', 'amber', 'coral', 'pink', 'green', 'gray']

const botNamePattern = /^[\p{L}\p{N}_-]{1,24}$/u
const commandTaskPattern = /^\/task\s+@([\p{L}\p{N}_-]+)\s+([\s\S]+)$/u
const commandRememberPattern = /^\/remember\s+([\s\S]+)$/u

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
  }

  attachRuntime(runtime) {
    this.runtime = runtime
    runtime.setCompletionHandler(result => this.finishRun(result))
  }

  async initialize() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      mkdirSync(this.config.dataDir, { recursive: true })
      mkdirSync(this.config.memoryDir, { recursive: true })
      mkdirSync(this.config.messageDir, { recursive: true })
      mkdirSync(join(this.config.workspace, '.agents', 'skills'), { recursive: true })
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
        } catch {}
        await this.createBot({
          name: this.config.seedOwnerName,
          role: this.config.seedOwnerRole,
          instructions: this.config.seedOwnerInstructions,
          provider: model?.provider,
          model: model?.model,
          effort: model?.defaultEffort,
          color: 'teal',
        }, { type: 'system', id: 'system' })
      }
      syncSkills(this.store, this.config.skillRoot)
      seedModelPrices(this.store, this.config.modelPrices ?? [])
      const interrupted = this.store.all("SELECT id FROM runs WHERE status = 'running'")
      this.store.run(
        `UPDATE runs SET status = 'queued', started_at = NULL, session_id = NULL
         WHERE status = 'running'`,
      )
      for (const run of interrupted) {
        this.store.run(
          `INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, 'recovered', ?, ?)`,
          id('evt'), run.id, '宿主重启，运行重新排队', nowIso(),
        )
      }
    })()
    return this.ready
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
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO bots(id, name, role, instructions, color, provider, model, effort,
          status, current_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        botId, name, role, instructions, color, provider, model, effort, createdAt, createdAt,
      )
      this.store.run(
        `INSERT INTO bot_revisions(id, bot_id, version, role, instructions, provider, model, effort, created_by, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        id('rev'), botId, role, instructions, provider, model, effort, `${actor.type}:${actor.id}`, createdAt,
      )
      this.audit(actor, 'bot.create', 'bot', botId, { name, provider, model, effort })
    })
    return this.botView(this.botRow(botId))
  }

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
      if (owned) throw conflict('该 Bot 仍是活动项目负责人，请先更换负责人')
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
  }

  async archiveBot(botId, actor = this.actor()) {
    return this.updateBot(botId, { status: 'archived' }, actor)
  }

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
  }

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
      memoryCount: Number(memoryCount),
      openTasks: Number(openTasks),
      stats: {
        runs: Number(runs?.total ?? 0),
        succeeded: Number(runs?.succeeded ?? 0),
        failed: Number(runs?.failed ?? 0),
        lastRunAt: runs?.last_run_at ?? null,
      },
    }
  }

  projectView(project) {
    const group = this.groupOf(project.id)
    const members = this.membersOf(project.id)
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
      workspace_path: join(this.config.workspace, project.slug),
      workspace_relative: `/${project.slug}`,
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
    if (owner.status !== 'active') throw badRequest('负责人 Bot 不可用')
    const projectId = id('prj')
    const groupId = id('grp')
    const createdAt = nowIso()
    const memberIds = [...new Set([owner.id, ...(Array.isArray(input.memberIds) ? input.memberIds : [])])]
    for (const botId of memberIds) this.botRow(botId)
    await ensureProjectWorkspace(this.config.workspace, slug)
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO projects(id, key, name, slug, description, owner_bot_id, status, token_budget, cost_budget, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        projectId, key, name, slug, text(input.description, 20_000), owner.id,
        clampNumber(input.tokenBudget, 0, 1e15, null), clampNumber(input.costBudget, 0, 1e12, null),
        createdAt, createdAt,
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
      if (owner.status !== 'active') throw badRequest('负责人 Bot 不可用')
      updates.owner_bot_id = owner.id
    }
    if (patch.tokenBudget !== undefined) updates.token_budget = clampNumber(patch.tokenBudget, 0, 1e15, null)
    if (patch.costBudget !== undefined) updates.cost_budget = clampNumber(patch.costBudget, 0, 1e12, null)
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
    return this.projectView(this.projectRow(projectId))
  }

  archiveProject(projectId, actor = this.actor()) {
    return this.updateProject(projectId, { status: 'archived' }, actor)
  }

  insertMessage({ projectId, senderType, senderId, body, mentions = [], taskId = null, runId = null, createdAt = nowIso() }) {
    const group = this.groupOf(projectId)
    if (!group) throw notFound('项目群聊不存在')
    const messageId = id('msg')
    this.store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, task_id, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      messageId, projectId, group.id, senderType, senderId, body, JSON.stringify(mentions), taskId, runId, createdAt,
    )
    return messageId
  }

  messageView(row) {
    const senderName = row.sender_type === 'bot'
      ? this.store.get('SELECT name FROM bots WHERE id = ?', row.sender_id)?.name ?? 'Bot'
      : row.sender_type === 'system' ? '系统' : this.actorName({ type: 'user', id: row.sender_id })
    const task = row.task_id ? this.store.get('SELECT number, title, project_id FROM tasks WHERE id = ?', row.task_id) : undefined
    const project = task ? this.store.get('SELECT key FROM projects WHERE id = ?', task.project_id) : undefined
    return {
      ...row,
      mentions: jsonParse(row.mentions_json, []),
      senderName,
      taskIdentifier: task && project ? `${project.key}-${task.number}` : null,
      taskTitle: task?.title ?? null,
    }
  }

  async sendMessage(projectId, bodyInput, actor = this.actor()) {
    const project = this.projectRow(projectId)
    if (project.status !== 'active') throw conflict('项目已归档')
    const body = text(bodyInput, 20_000)
    if (!body) throw badRequest('消息不能为空')
    const members = this.membersOf(projectId).filter(bot => bot.status === 'active')
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
    const mentions = parseMentions(body, members)
    const targets = (mentions.length > 0 ? mentions : members.filter(bot => bot.id === project.owner_bot_id)).slice(0, 3)
    const messageId = this.insertMessage({
      projectId,
      senderType: actor.type,
      senderId: actor.id,
      body,
      mentions: mentions.map(bot => bot.id),
    })
    for (const bot of targets) this.enqueueChatRun(project, bot, messageId)
    void this.tick()
    return { messageId, runBots: targets.map(bot => bot.id) }
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

  async createTask(input, actor = this.actor()) {
    const project = this.projectRow(input.projectId)
    if (project.status !== 'active') throw conflict('项目已归档')
    const title = text(input.title, 240)
    if (!title) throw badRequest('任务标题不能为空')
    const assigneeId = input.assigneeBotId || null
    if (assigneeId) this.assertMember(project.id, assigneeId)
    const status = input.status && TASK_STATUSES.has(input.status) ? input.status : (assigneeId ? 'todo' : 'backlog')
    const priority = TASK_PRIORITIES.has(input.priority) ? input.priority : 'medium'
    const taskId = id('task')
    const createdAt = nowIso()
    let number
    this.store.transaction(() => {
      number = Number(this.store.get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE project_id = ?', project.id)?.n ?? 1)
      this.store.run(
        `INSERT INTO tasks(id, project_id, number, title, description, status, priority, assignee_bot_id,
          creator_type, creator_id, review_target, source_message_id, parent_id, position, due_at, estimate,
          version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        taskId, project.id, number, title, text(input.description, 40_000), status, priority,
        assigneeId, actor.type, actor.id, actor.type === 'bot' ? 'owner_bot' : 'user',
        input.sourceMessageId ?? null, input.parentId ?? null,
        Number.isFinite(Number(input.position)) ? Number(input.position) : number,
        input.dueAt ? new Date(input.dueAt).toISOString() : null,
        clampNumber(input.estimate, 0, 1000, null), createdAt, createdAt,
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
    if (input.autoStart && assigneeId) this.enqueueTaskRun(this.taskRow(taskId), 'task_created', actor)
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
    return {
      ...task,
      identifier: `${project?.key ?? 'T'}-${task.number}`,
      labels,
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
    // 负责人bot的验收/受阻处理运行本身占用任务的唯一活动运行名额，
    // 此时由 finishRun 的收尾逻辑负责重新排队执行，这里跳过。
    if (!active) this.enqueueTaskRun(this.taskRow(taskId), 'assigned', actor)
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
    return this.store.get('SELECT * FROM task_comments WHERE id = ?', commentId)
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
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, ?, 'task', ?, ?, 'queued', 1, ?, ?)`,
      runId, task.project_id, task.assignee_bot_id, task.id, triggerType, task.id, `task:${task.id}:${Date.now()}:${runId}`, createdAt,
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
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)`,
      runId, project.id, owner.id, task.id, kind, triggerType, task.id,
      `${kind}:${task.id}:${Date.now()}:${runId}`, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued',
      kind === 'review' ? '任务交付，转负责人验收' : '任务受阻，转负责人处理',
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
    const project = this.projectRow(binding.project_id)
    if (project.owner_bot_id !== binding.bot_id) throw forbidden('只有项目负责人 Bot 可以执行该操作')
    return { binding, project, actor: { type: 'bot', id: binding.bot_id } }
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
      `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, 'chat', 'mention', ?, 'queued', 1, ?, ?)`,
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
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, ?, 'task', 'retry', ?, 'queued', ?, ?, ?)`,
      newRunId, task.project_id, task.assignee_bot_id, task.id, task.id,
      Number(run.attempt) + 1, `retry:${task.id}:${Date.now()}:${newRunId}`, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), newRunId, 'queued', `重试 ${run.attempt}`, createdAt,
    )
    this.addTaskEvent(task.id, 'retried', actor, { runId: newRunId, previousRunId: runId })
    void this.tick()
    return this.store.get('SELECT * FROM runs WHERE id = ?', newRunId)
  }

  async tick() {
    if (this.ticking || !this.started) return
    this.ticking = true
    try {
      const activeRows = this.store.all("SELECT bot_id, COUNT(*) AS count FROM runs WHERE status = 'running' GROUP BY bot_id")
      const activeByBot = new Map(activeRows.map(row => [row.bot_id, Number(row.count)]))
      let activeTotal = activeRows.reduce((sum, row) => sum + Number(row.count), 0)
      if (activeTotal >= this.config.maxConcurrentRuns) return
      const candidates = this.store.all("SELECT * FROM runs WHERE status = 'queued' ORDER BY queued_at LIMIT 50")
      for (const run of candidates) {
        if (activeTotal >= this.config.maxConcurrentRuns) break
        if ((activeByBot.get(run.bot_id) ?? 0) > 0) continue
        const project = this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id)
        const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
        if (!project || !bot) {
          await this.finishRun({ runId: run.id, status: 'failed', output: '', error: { code: 'MISSING_CONTEXT', message: '项目或 Bot 已删除' } })
          continue
        }
        if (project.status !== 'active' || bot.status !== 'active') {
          await this.finishRun({ runId: run.id, status: 'failed', output: '', error: { code: 'UNAVAILABLE', message: '项目或 Bot 不可用' } })
          continue
        }
        const budgetError = this.budgetError(project)
        if (budgetError) {
          await this.finishRun({ runId: run.id, status: 'failed', output: '', error: { code: 'BUDGET_EXCEEDED', message: budgetError } })
          continue
        }
        const claimed = this.store.run(
          "UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
          nowIso(), run.id,
        )
        if (Number(claimed.changes) !== 1) continue
        activeTotal += 1
        activeByBot.set(run.bot_id, 1)
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

  budgetError(project) {
    if (!project.token_budget && !project.cost_budget) return null
    const usage = monthUsageForProject(this.store, project.id)
    if (project.token_budget && usage.totalTokens >= project.token_budget) {
      return `项目本月 token 预算已用尽（${usage.totalTokens}/${Math.round(project.token_budget)}）`
    }
    if (project.cost_budget && usage.cost !== null && usage.cost >= project.cost_budget) {
      return `项目本月成本预算已用尽（${usage.cost.toFixed(4)}/${project.cost_budget}）`
    }
    return null
  }

  async executeRun(runId) {
    const run = this.runRow(runId)
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
    const project = this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id)
    try {
      const task = run.task_id ? this.taskRow(run.task_id) : null
      const chatMessage = run.kind === 'chat' && run.trigger_ref
        ? this.store.get('SELECT * FROM messages WHERE id = ?', run.trigger_ref)
        : null
      await this.runtime.startRun({ run, bot, project, task, chatMessage })
    } catch (error) {
      this.logger.warn?.('dsh-team: run %s failed to start: %s', runId, error)
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

  async finishRun({ runId, status, output, error }) {
    const run = this.runRow(runId)
    if (!['running', 'queued'].includes(run.status)) return
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
    const project = this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id)
    const usage = runUsageTotals(this.store, runId)
    const cleanOutput = text(output, 120_000)
    const endedAt = nowIso()
    this.store.run(
      `UPDATE runs SET status = ?, output = ?, error_code = ?, error_message = ?, ended_at = ?,
       usage_input = ?, usage_cache_read = ?, usage_cache_write = ?, usage_output = ?, usage_cost = ?
       WHERE id = ? AND status IN ('running', 'queued')`,
      status, cleanOutput, error?.code ?? null, error?.message ?? null, endedAt,
      usage.input, usage.cacheRead, usage.cacheWrite, usage.output, usage.cost,
      runId,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, status, error?.message ?? (status === 'succeeded' ? '完成' : ''), endedAt,
    )
    const refreshed = this.runRow(runId)
    if (run.kind === 'review' || run.kind === 'handle') {
      const label = run.kind === 'review' ? '验收' : '受阻处理'
      if (run.task_id) {
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: status === 'succeeded'
            ? (cleanOutput || `负责人已完成${label}。`)
            : `负责人${label}运行失败：${error?.message ?? '未知错误'}`,
          taskId: run.task_id,
          runId,
        })
        // 验收退回或受阻重派会把任务置回 todo/in_progress；
        // 此时任务的唯一活动运行名额刚被本次运行释放，这里负责补排执行运行。
        const task = this.taskRow(run.task_id)
        if (['todo', 'in_progress'].includes(task.status) && task.assignee_bot_id) {
          this.enqueueTaskRun(task, run.kind === 'review' ? 'returned' : 'redispatched', { type: 'bot', id: bot.id })
          void this.tick()
        }
      } else if (status !== 'succeeded') {
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `负责人${label}运行失败：${error?.message ?? '未知错误'}`,
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
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: ownerReview
            ? `任务 ${project.key}-${task.number} 已交付，等待负责人验收。\n\n${truncate(cleanOutput || '模型未返回文本。', 16_000)}`
            : `任务 ${project.key}-${task.number} 已完成，待您验收。\n\n${truncate(cleanOutput || '模型未返回文本。', 16_000)}`,
          taskId: task.id,
          runId,
        })
        this.learnFromTask(project, bot, task, cleanOutput, runId)
        if (ownerReview) {
          const reviewRunId = this.enqueueOwnerTaskRun(this.taskRow(task.id), 'review')
          if (!reviewRunId) {
            this.insertMessage({
              projectId: project.id,
              senderType: 'system',
              senderId: 'system',
              body: `项目未配置可用的负责人 Bot，任务 ${project.key}-${task.number} 请用户直接验收。`,
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
        this.enqueueOwnerTaskRun(this.taskRow(run.task_id), 'handle')
      } else if (run.kind === 'chat') {
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `运行失败：${error?.message ?? '未知错误'}`,
          runId,
        })
      }
    }
    if (this.rate[run.project_id]) delete this.rate[run.project_id]
  }

  learnFromTask(project, bot, task, output, runId) {
    if (!output || output.trim().length < 40) return
    const content = redactSecrets(`${task.title}：${output.trim().slice(0, 900)}`)
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
    })
    this.createMemory({
      scopeType: 'project',
      scopeId: project.id,
      topic: `${project.key}-${task.number} 交付记录`,
      content,
      source,
      confidence: 0.6,
      createdBy: `bot:${bot.id}`,
    })
  }

  createMemory({ scopeType, scopeId, topic, content, source = '', confidence = 1, createdBy = 'system' }) {
    const cleanScope = ['bot', 'project'].includes(scopeType) ? scopeType : null
    if (!cleanScope) throw badRequest('记忆作用域无效')
    const cleanContent = redactSecrets(text(content, 8000))
    if (!cleanContent) throw badRequest('记忆内容不能为空')
    if (cleanScope === 'bot') this.botRow(scopeId)
    else this.projectRow(scopeId)
    const memoryId = id('mem')
    const createdAt = nowIso()
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO memories(id, scope_type, scope_id, topic, content, source, confidence, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        memoryId, cleanScope, scopeId, text(topic, 120) || '未命名记忆', cleanContent, text(source, 500),
        Math.min(1, Math.max(0, Number(confidence) || 0)), createdBy, createdAt, createdAt,
      )
      this.store.run(
        'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        id('mevt'), memoryId, 'created', createdBy.split(':')[0] || 'system', createdBy, cleanContent, createdAt,
      )
      this.audit({ type: createdBy.split(':')[0] || 'system', id: createdBy.split(':').slice(1).join(':') || 'system' },
        'memory.create', 'memory', memoryId, { scopeType: cleanScope, scopeId })
    })
    this.writeMemoryMirror(memoryId)
    return this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
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
    if (!['bot_update', 'skill', 'workflow'].includes(kind)) throw badRequest('提案类型无效')
    const title = text(input.title, 200)
    if (!title) throw badRequest('提案标题不能为空')
    if (kind === 'bot_update') {
      if (!input.botId) throw badRequest('Bot 提案必须指定 Bot')
      this.botRow(input.botId)
    }
    if (kind === 'skill' && !input.payload?.content) throw badRequest('技能提案必须包含内容')
    const proposalId = id('prop')
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO proposals(id, kind, bot_id, project_id, title, rationale, payload_json, evaluation,
          status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        proposalId, kind, input.botId ?? null, input.projectId ?? null, title,
        text(input.rationale, 10_000), JSON.stringify(input.payload ?? {}), text(input.evaluation, 6000),
        `${actor.type}:${actor.id}`, nowIso(),
      )
      this.audit(actor, 'proposal.create', 'proposal', proposalId, { kind, title })
    })
    return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
  }

  proposalView(proposal) {
    return {
      ...proposal,
      payload: jsonParse(proposal.payload_json, {}),
      botName: proposal.bot_id ? this.store.get('SELECT name FROM bots WHERE id = ?', proposal.bot_id)?.name ?? null : null,
    }
  }

  async decideProposal(proposalId, decision, actor = this.actor()) {
    if (!['approved', 'rejected'].includes(decision)) throw badRequest('审批结果无效')
    const proposal = this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId)
    if (!proposal) throw notFound('提案不存在')
    if (proposal.status !== 'pending') throw conflict('提案已处理')
    const payload = jsonParse(proposal.payload_json, {})
    if (decision === 'approved') {
      if (proposal.kind === 'bot_update') {
        await this.updateBot(proposal.bot_id, {
          ...(payload.role !== undefined ? { role: payload.role } : {}),
          ...(payload.instructions !== undefined ? { instructions: payload.instructions } : {}),
          ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
          ...(payload.model !== undefined ? { model: payload.model } : {}),
          ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
        }, actor)
      } else if (proposal.kind === 'skill') {
        await publishSkill(this.config, payload)
        syncSkills(this.store, this.config.skillRoot)
      }
    }
    this.store.run(
      'UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?',
      decision, `${actor.type}:${actor.id}`, nowIso(), proposalId,
    )
    this.audit(actor, `proposal.${decision}`, 'proposal', proposalId, {})
    return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
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
    const identifier = `${project.key}-${task.number}`
    if (task.status !== 'in_review') throw conflict(`任务 ${identifier} 不在待验收状态`)
    if (input.decision === 'accept') {
      await this.updateTask(task.id, { status: 'done' }, actor)
      if (input.comment) await this.addComment(task.id, input.comment, actor)
      this.insertMessage({
        projectId: project.id,
        senderType: 'system',
        senderId: 'system',
        body: `任务 ${identifier} 验收通过。`,
        taskId: task.id,
      })
    } else {
      const comment = text(input.comment, 20_000)
      if (!comment) throw badRequest('退回任务必须说明原因')
      if (!task.assignee_bot_id) throw conflict(`任务 ${identifier} 没有负责人，无法退回重做`)
      await this.updateTask(task.id, { status: 'in_progress' }, actor)
      await this.addComment(task.id, `退回重做：${comment}`, actor)
      // 若负责人验收运行仍在进行，由其结束时的收尾逻辑补排；否则立即重排执行。
      const active = this.store.get(
        "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
        task.id,
      )
      if (!active) this.enqueueTaskRun(this.taskRow(task.id), 'returned', actor)
      void this.tick()
      this.insertMessage({
        projectId: project.id,
        senderType: 'system',
        senderId: 'system',
        body: `任务 ${identifier} 被负责人退回重做。`,
        taskId: task.id,
      })
    }
    return this.taskView(this.taskRow(task.id))
  }

  rememberFromBot(sessionId, input) {
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw forbidden('只有项目群中的 Bot 可以写记忆')
    const scopeType = input.scope === 'project' ? 'project' : 'bot'
    const scopeId = scopeType === 'project' ? binding.project_id : binding.bot_id
    return this.createMemory({
      scopeType,
      scopeId,
      topic: input.topic,
      content: input.content,
      source: `session:${sessionId}`,
      confidence: 0.9,
      createdBy: `bot:${binding.bot_id}`,
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
    const project = this.store.get('SELECT key FROM projects WHERE id = ?', run.project_id)
    return {
      ...run,
      botName: bot?.name ?? 'Bot',
      taskIdentifier: task ? `${project?.key ?? 'T'}-${task.number}` : null,
      taskTitle: task?.title ?? null,
    }
  }

  async state(projectId) {
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
      proposals: this.store.all('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100').map(item => this.proposalView(item)),
      revisions: {},
      usage: usageSnapshot(this.store, project?.id, 30),
      paths: {
        dshHome: this.config.dshHome,
        workspace: this.config.workspace,
        skillRoot: this.config.skillRoot,
        dataDir: this.config.dataDir,
      },
      dsh: {
        native: true,
        profile: this.runtime?.capabilityInfo?.().profile ?? process.env.DSH_PROFILE ?? 'bots',
        home: this.config.dshHome,
        ...this.runtime?.capabilityInfo?.() ?? {},
      },
      // 每个 provider+model 只保留最新一条生效价格；历史版本不在这里展开。
      prices: this.latestPrices(),
      // 配置里的默认价格，Web 中可据此一键恢复。
      priceDefaults: this.config.modelPrices ?? [],
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
        `SELECT * FROM memories WHERE status = 'active' AND ((scope_type = 'project' AND scope_id = ?) ${botFilter})
         ORDER BY updated_at DESC LIMIT 100`,
        project.id, ...botIds,
      )
      view.proposals = this.store.all(
        'SELECT * FROM proposals WHERE project_id = ? OR bot_id IN (SELECT id FROM bots) ORDER BY created_at DESC LIMIT 100',
        project.id,
      ).map(item => this.proposalView(item))
      view.prices = this.latestPrices()
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

  async botDetail(botId) {
    const bot = this.botRow(botId)
    return {
      bot: this.botView(bot),
      revisions: this.store.all('SELECT * FROM bot_revisions WHERE bot_id = ? ORDER BY version DESC', botId),
      memories: this.store.all("SELECT * FROM memories WHERE scope_type = 'bot' AND scope_id = ? AND status = 'active' ORDER BY updated_at DESC", botId),
      projects: this.store.all('SELECT id, key, name FROM projects WHERE owner_bot_id = ?', botId),
    }
  }

  async models(force = false) {
    return this.runtime?.catalog(force) ?? []
  }

  async syncSkillsNow(actor = this.actor()) {
    const entries = syncSkills(this.store, this.config.skillRoot)
    this.audit(actor, 'skills.sync', 'skill', '*', { count: entries.length })
    return {
      count: entries.length,
      skills: skillSnapshot(this.store, this.config),
    }
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
      profile: process.env.DSH_PROFILE || 'bots',
      updateAvailable: current !== 'unknown' && compareVersions(latest, current) > 0,
      checkedAt: nowIso(),
    }
  }

  async upgradeDsh(targetVersion, actor = this.actor()) {
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
      return { current, target, restarted: false, upToDate: true }
    }
    if (current !== 'unknown' && compareVersions(target, current) <= 0) {
      return { current, target, restarted: false, upToDate: true }
    }
    mkdirSync(this.config.dataDir, { recursive: true })
    const requestPath = join(this.config.dataDir, 'dsh-upgrade.json')
    writeFileSync(requestPath, JSON.stringify({
      version: target,
      current,
      requestedAt: nowIso(),
      requestedBy: `${actor.type}:${actor.id}`,
    }, null, 2), 'utf8')
    this.audit(actor, 'dsh.upgrade.request', 'dsh', target, { current, target })
    setTimeout(() => {
      // The container entrypoint sees 75, installs the requested version as root,
      // and relaunches DSH in place. Other exit codes are not retried.
      process.exit(75)
    }, 900)
    return { current, target, restarted: true, upToDate: false, latest }
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
      version: '0.1.0',
      ready: true,
      bots: this.store.get('SELECT COUNT(*) AS count FROM bots')?.count ?? 0,
      projects: this.store.get('SELECT COUNT(*) AS count FROM projects')?.count ?? 0,
      queued: this.store.get("SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'")?.count ?? 0,
      running: this.store.get("SELECT COUNT(*) AS count FROM runs WHERE status = 'running'")?.count ?? 0,
    }
  }
}

function truncate(value, max) {
  const textValue = String(value ?? '')
  return textValue.length <= max ? textValue : `${textValue.slice(0, max)}\n\n[已截断，完整结果见运行记录]`
}
