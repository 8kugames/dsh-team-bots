// src/services/system.js —— 系统视图与运维域
// 工作台总视图、模型列表、DSH 自更新与健康检查。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { AppError, badRequest, conflict, hotUpgradeUnsupported } from '../errors.js'
import { usageSnapshot } from '../usage.js'
import { latestDshVersion, compareVersions, validTargetVersion } from '../updater.js'
import { skillSnapshot } from '../skills.js'
import { projectSkillRoots } from '../project-skills.js'
import { nowIso } from '../util.js'



export const systemMethods = {
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
      // 待审批条目随群聊数据下发：卡片状态渲染时以这张表为准，消息行只是锚点。
      view.approvals = this.approvalsForProject(project.id)
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
  },

  /**
   * 聊天历史游标分页（DSHBOTS-33）：state 只回最后 200 条，更早的历史用本接口手动加载。
   * 游标 = 当前最旧一条消息的 created_at + id（id 兜底同毫秒排序，避免漏/重）。
   * 群聊按 project_id、单聊按 bot_id 两路；limit 默认与上限均为 200。
   * 返回 { messages: 升序数组, hasMore: 是否还有更早一页 }。
   */
  messagesPage({ projectId = null, soloBotId = null, beforeCreatedAt = null, beforeId = null, limit = null }) {
    const isGroup = Boolean(projectId)
    const isSolo = Boolean(soloBotId)
    if (isGroup === isSolo) throw badRequest('projectId 与 soloBotId 必须二选一')
    if (!beforeCreatedAt || !beforeId) throw badRequest('缺少游标：beforeCreatedAt 与 beforeId 必须同时提供')
    const pageSize = Math.max(1, Math.min(200, Number.isFinite(Number(limit)) && limit ? Math.trunc(Number(limit)) : 200))
    const table = isGroup ? 'messages' : 'solo_messages'
    const scopeSql = isGroup ? 'project_id = ?' : 'bot_id = ?'
    const scopeArg = isGroup ? projectId : soloBotId
    // 游标口径：取「严格早于游标」的最近 pageSize 条（第 pageSize+1 条仅作 hasMore 探位，不进结果）。
    // 先按 DESC 取回、slice 掉探位行、再翻回 ASC——顺序不能反，否则会丢掉紧邻游标的那条。
    const rows = this.store.all(
      `SELECT * FROM ${table}
       WHERE ${scopeSql} AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      scopeArg, beforeCreatedAt, beforeCreatedAt, beforeId, pageSize + 1,
    )
    const hasMore = rows.length > pageSize
    const page = rows.slice(0, pageSize).reverse()
    return {
      messages: page.map(row => (isGroup ? this.messageView(row) : this.soloMessageView(row))),
      hasMore,
    }
  },

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
  },
  async models(force = false) {
    return this.runtime?.catalog(force) ?? []
  },
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
  },
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
  },
  async rebootDsh() {
    await this.initialize()
    const active = this.store.get(
      "SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'running')",
    )?.count ?? 0
    if (Number(active) > 0) {
      throw conflict(`当前还有 ${active} 个排队或运行中的任务，请先停止后再重启 DSH`)
    }
    throw hotUpgradeUnsupported()
  },
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
  },
}
