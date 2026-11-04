// src/services/system.js —— 系统视图与运维域
// 工作台总视图、模型列表、DSH 自更新与健康检查。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { createRequire } from 'node:module'
import { AppError, badRequest, conflict, hotUpgradeUnsupported } from '../errors.js'
import { usageSnapshot } from '../usage.js'
import { latestDshVersion, latestTeamBotsVersion, compareVersions, validTargetVersion } from '../updater.js'
import { skillSnapshot } from '../skills.js'
import { projectSkillRoots } from '../project-skills.js'
import { resolveDshUiLanguage } from './locale.js'
import { nowIso } from '../util.js'

// 插件自身版本：进程启动时从部署副本 package.json 定格，即当前生效版本。
// health() 与「DSH 服务」卡展示同源（DSHBOTS-143）。
const PLUGIN_VERSION = String(createRequire(import.meta.url)('../../package.json').version ?? 'unknown')



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
    const unreadCounts = this.unreadChatCounts()
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
        unreadCount: unreadCounts.get(item.id) ?? 0,
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
      // 用量快照默认按 30 日窗口（DSHBOTS-121）：与页面默认档一致，其余三档按需单独取。
      usage: usageSnapshot(this.store, project?.id, 30, { currency: this.budgetCurrency(), soloBotId: soloBotId ?? null, window: '30d' }),
      settings: this.settingsView(),
      runLimits: this.runLimitsView(),
      // 侧栏状态行全局口径（DSHBOTS-77）：全库活跃运行（含 queued），不随群聊/单聊上下文收敛。
      activeRuns: Number(this.store.get("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'running')")?.count ?? 0),
      // 侧栏状态行任务口径（DSHBOTS-105）：全库任务 in_progress 计数；activeRuns 保留给其余消费方。
      activeTasks: Number(this.store.get("SELECT COUNT(*) AS count FROM tasks WHERE status = 'in_progress'")?.count ?? 0),
      // 跨项目待审聚合（DSHBOTS-102）：与项目解耦，用户不在该项目的群聊页也能看到待处理审批。
      pendingApprovals: this.approvalsPending(),
      // 跨项目待答聚合（DSHBOTS-116）：同口径，提问卡片出现在群聊，顶部入口给全局可见性。
      pendingQuestions: this.questionsPending(),
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
      // 本插件（dsh-team-bots）部署生效版：与 health().version 同源。
      pluginVersion: PLUGIN_VERSION,
      // UI 语言（DSHBOTS-120）：与 http.js page() 的 {{language}} 注入同源
      // （loader 直读 → patch 文件 → 'auto' 交浏览器），state 轮询据此热切换字典包。
      language: await resolveDshUiLanguage({
        loader: this.runtime?.ctx?.get?.('loader'),
        dshHome: this.config.dshHome,
        profile: process.env.DSH_PROFILE || 'team-bots',
      }),
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
      // 提问条目同理（DSHBOTS-116）：消息行只带 question_id，卡片状态以这张表为准。
      view.questions = this.questionsForProject(project.id)
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
      // 记忆随上下文收敛（DSHBOTS-5）：群聊只看当前项目 scope，不再并集成员 bot 与团队记忆。
      view.memories = this.store.all(
        `SELECT * FROM memories WHERE status = 'active' AND scope_type = 'project' AND scope_id = ?
         ORDER BY updated_at DESC LIMIT 100`,
        project.id,
      ).map(item => this.memoryView(item))
      view.pendingMemories = this.store.all(
        `SELECT * FROM memories WHERE status = 'pending' AND scope_type = 'project' AND scope_id = ?
         ORDER BY updated_at DESC LIMIT 100`,
        project.id,
      ).map(item => this.memoryView(item))
      // 提案全量口径（与单聊对齐）：审批入口收敛到「总览bots」批量与单聊逐个，项目不再按 bot 并集过滤。
      view.proposals = this.store.all('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100')
        .map(item => this.proposalView(item))
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
        // 单聊上下文口径（DSHBOTS-5 收敛）：记忆只看该 bot 自己的（不含团队）；运行只看该 bot 的项目外运行；
        // 提案保持全量（渲染层按 bot 过滤，逐个审批）。
        view.proposals = this.store.all('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100').map(item => this.proposalView(item))
        view.memories = this.store.all(
          `SELECT * FROM memories WHERE status = 'active' AND scope_type = 'bot' AND scope_id = ?
           ORDER BY updated_at DESC LIMIT 100`,
          soloBot.id,
        ).map(item => this.memoryView(item))
        view.pendingMemories = this.store.all(
          `SELECT * FROM memories WHERE status = 'pending' AND scope_type = 'bot' AND scope_id = ?
           ORDER BY updated_at DESC LIMIT 100`,
          soloBot.id,
        ).map(item => this.memoryView(item))
        view.runs = this.store.all(
          'SELECT * FROM runs WHERE bot_id = ? AND project_id IS NULL ORDER BY queued_at DESC LIMIT 60',
          soloBot.id,
        ).map(run => this.runView(run))
        // 单聊页升级「调度页」的数据源：这个 bot 在各项目里的在办/待办任务与当前活跃运行。
        view.dispatch = this.botDispatchView(soloBot.id)
      }
    }
    return view
  },

  /**
   * 用量时间窗快照（DSHBOTS-121）：今日 / 7 日 / 30 日 / 至今 四档按需取数。
   * 不把四档都塞进 state——state 每次轮询都要带，四份快照会把响应体积翻四倍。
   */
  async usageWindow(projectId = null, soloBotId = null, window = '30d') {
    await this.initialize()
    let project = projectId
      ? this.store.get('SELECT id FROM projects WHERE id = ?', projectId)
      : undefined
    if (!project) project = this.store.get("SELECT id FROM projects WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1")
    return usageSnapshot(this.store, project?.id, 30, {
      currency: this.budgetCurrency(),
      soloBotId: soloBotId ?? null,
      window: window ?? '30d',
    })
  },

  /**
   * bot 调度视图（DSHBOTS-28）：该 bot 名下任务与活跃运行的跨项目汇总。
   * 只统计 active 项目（已归档项目的任务不再出现在调度页）。
   * 在办 = in_progress/blocked/in_review，按最近更新排序；待办 = todo/backlog，按优先级权重再按位置排序。
   */
  botDispatchView(botId) {
    const taskRows = (statuses, order) => this.store.all(
      `SELECT t.*, p.key AS project_key, p.name AS project_name
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.assignee_bot_id = ? AND p.status = 'active' AND t.status IN (${statuses.map(() => '?').join(',')})
       ORDER BY ${order} LIMIT 50`,
      botId, ...statuses,
    )
    const activeRows = taskRows(
      ['in_progress', 'blocked', 'in_review'],
      't.updated_at DESC',
    )
    const pendingRows = taskRows(
      ['todo', 'backlog'],
      `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
       t.position, t.number`,
    )
    const withProject = (row) => {
      // JOIN 出来的 project_key/project_name 只是拼装用，不混进 taskView 的原始字段。
      const { project_key: projectKey, project_name: projectName, ...task } = row
      return { ...this.taskView(task), projectKey, projectName }
    }
    const runRows = this.store.all(
      `SELECT r.*, p.key AS project_key
       FROM runs r LEFT JOIN projects p ON p.id = r.project_id
       WHERE r.bot_id = ? AND r.status IN ('queued','running')
       ORDER BY r.queued_at DESC LIMIT 50`,
      botId,
    )
    return {
      botId,
      tasks: {
        active: activeRows.map(withProject),
        pending: pendingRows.map(withProject),
      },
      // 项目外（单聊）运行没有项目 key，标「单聊」以便前端区分。
      runs: runRows.map(row => {
        const { project_key: joinedKey, ...run } = row
        return {
          ...this.runView(run),
          projectKey: run.project_id ? joinedKey : '单聊',
        }
      }),
    }
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
    let pluginLatest
    try {
      ;[latest, pluginLatest] = await Promise.all([
        latestDshVersion({ force: true }),
        latestTeamBotsVersion({ force: true }),
      ])
    } catch (error) {
      throw new AppError('DSH_REGISTRY_UNAVAILABLE', `无法查询最新版本：${error.message}`, 502)
    }
    return {
      current,
      latest,
      pluginCurrent: PLUGIN_VERSION,
      pluginLatest,
      profile: process.env.DSH_PROFILE || 'team-bots',
      updateAvailable: current !== 'unknown' && compareVersions(latest, current) > 0,
      pluginUpdateAvailable: compareVersions(pluginLatest, PLUGIN_VERSION) > 0,
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
      version: PLUGIN_VERSION,
      ready: true,
      bots: this.store.get('SELECT COUNT(*) AS count FROM bots')?.count ?? 0,
      projects: this.store.get('SELECT COUNT(*) AS count FROM projects')?.count ?? 0,
      queued: this.store.get("SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'")?.count ?? 0,
      running: this.store.get("SELECT COUNT(*) AS count FROM runs WHERE status = 'running'")?.count ?? 0,
    }
  },
}
