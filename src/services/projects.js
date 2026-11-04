// src/services/projects.js —— 项目与成员域
// 项目建档、档案更新、归档、成员增删与成员视图。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { ensureExternalDir, ensureProjectWorkspace } from '../paths.js'
import { clampNumber, id, nowIso, parseDisabledSkills, projectKey, slugify, text } from '../util.js'



export const projectsMethods = {
  groupOf(projectId) {
    return this.store.get('SELECT * FROM group_chats WHERE project_id = ?', projectId)
  },
  membersOf(projectId) {
    return this.store.all(
      `SELECT pm.*, pm.member_id AS id, b.name, b.role AS bot_role, b.provider, b.model, b.effort, b.status
       FROM project_members pm JOIN bots b ON b.id = pm.member_id
       WHERE pm.project_id = ? AND pm.member_type = 'bot'
       ORDER BY CASE pm.member_role WHEN 'owner' THEN 0 ELSE 1 END, b.name`,
      projectId,
    )
  },

  // 群聊未读计数（IM 式）：以该读者对各项目的已读水位为界，统计其后到达的 bot 群聊消息。
  // 没有水位的项目以项目创建时间为基线，历史消息不会一上来就全红。
  unreadChatCounts() {
    const rows = this.store.all(
      `SELECT m.project_id AS project_id, COUNT(*) AS unread
         FROM messages m
         JOIN projects p ON p.id = m.project_id
         LEFT JOIN chat_reads cr ON cr.project_id = m.project_id AND cr.reader_id = ?
         WHERE m.sender_type = 'bot'
           AND m.created_at > COALESCE(cr.read_at, p.created_at)
         GROUP BY m.project_id`,
      this.localUserId,
    )
    return new Map(rows.map(row => [row.project_id, Number(row.unread ?? 0)]))
  },

  // 标记群聊已读：水位只推到用户真正看到的那条消息，之后新到的消息仍算未读。
  markChatRead(projectId, readAt) {
    const stamp = String(readAt ?? '').trim()
    if (!projectId || !stamp) return { ok: false, readAt: '' }
    const latest = this.store.get(
      "SELECT MAX(created_at) AS ts FROM messages WHERE project_id = ? AND sender_type = 'bot'",
      projectId,
    )
    const serverMax = latest?.ts ?? ''
    // 客户端水位不得越过服务端最新消息，否则会吞掉尚未到达的消息。
    const target = serverMax && serverMax < stamp ? serverMax : stamp
    this.store.run(
      `INSERT INTO chat_reads (project_id, reader_id, read_at) VALUES (?, ?, ?)
       ON CONFLICT(project_id, reader_id) DO UPDATE SET read_at = excluded.read_at`,
      projectId,
      this.localUserId,
      target,
    )
    return { ok: true, readAt: target }
  },

  // 成员列表带本项目聚合口径：busy=本项目有排队/运行中的 run，usage 四项与 cost 为本项目全部 run 的累计。
  // run_status 用 bot 全局口径（不限本项目）：failed 根因（模型/AUTH）是 bot 级，单聊 run 的 project_id 为 NULL，
  // 按项目口径会把「单聊跑着/刚挂」错显 idle——busy 维持项目口径不动。
  // taskStats（DSHBOTS-65）按本项目任务聚合：done=已完成，open=未完成且未取消（canceled 不算待办），无任务兜底 0/0。
  membersWithUsage(projectId) {
    return this.store.all(
      `SELECT pm.*, pm.member_id AS id, pm.member_role, b.name, b.role AS bot_role, b.provider, b.model, b.effort, b.status,
         EXISTS(
           SELECT 1 FROM runs r
           WHERE r.project_id = pm.project_id AND r.bot_id = pm.member_id AND r.status IN ('queued', 'running')
         ) AS busy,
         CASE
           WHEN EXISTS(
             SELECT 1 FROM runs r
             WHERE r.bot_id = pm.member_id AND r.status IN ('queued', 'running')
           ) THEN 'running'
           WHEN lst.status = 'failed'
                AND lst.error_code IN ('RATE_LIMIT', 'QUOTA')
                AND lst.retry_after_ms IS NOT NULL
                AND lst.retry_expires_epoch > CAST(strftime('%s', 'now') AS REAL) THEN 'plan_wait'
           WHEN lst.status = 'failed' THEN 'failed'
           ELSE 'idle'
         END AS run_status,
         CASE
            WHEN EXISTS(
              SELECT 1 FROM runs r
              WHERE r.bot_id = pm.member_id AND r.status = 'running'
            ) THEN 'running'
            WHEN EXISTS(
              SELECT 1 FROM runs r
              WHERE r.bot_id = pm.member_id AND r.status = 'queued'
            ) THEN 'queued'
          END AS run_phase,
         CASE
           WHEN lst.status = 'failed'
                AND lst.error_code IN ('RATE_LIMIT', 'QUOTA')
                AND lst.retry_after_ms IS NOT NULL
                AND lst.retry_expires_epoch > CAST(strftime('%s', 'now') AS REAL)
           THEN lst.retry_expires_epoch - CAST(strftime('%s', 'now') AS REAL)
         END AS retry_wait_seconds,
         COALESCE(u.usage_input, 0) AS usage_input,
         COALESCE(u.usage_cache_read, 0) AS usage_cache_read,
         COALESCE(u.usage_cache_write, 0) AS usage_cache_write,
         COALESCE(u.usage_output, 0) AS usage_output,
         COALESCE(u.usage_cost, 0) AS usage_cost,
         COALESCE(ts.task_done, 0) AS task_done,
         COALESCE(ts.task_open, 0) AS task_open
       FROM project_members pm JOIN bots b ON b.id = pm.member_id
       LEFT JOIN (
         SELECT bot_id, status, error_code, retry_after_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY bot_id ORDER BY COALESCE(ended_at, queued_at) DESC
                ) AS rn,
                strftime('%s', COALESCE(ended_at, queued_at)) + retry_after_ms / 1000.0 AS retry_expires_epoch
         FROM runs
       ) lst ON lst.bot_id = pm.member_id AND lst.rn = 1
       LEFT JOIN (
         SELECT bot_id,
                SUM(usage_input) AS usage_input,
                SUM(usage_cache_read) AS usage_cache_read,
                SUM(usage_cache_write) AS usage_cache_write,
                SUM(usage_output) AS usage_output,
                SUM(usage_cost) AS usage_cost
         FROM runs WHERE project_id = ? GROUP BY bot_id
       ) u ON u.bot_id = pm.member_id
       LEFT JOIN (
         SELECT assignee_bot_id,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS task_done,
                SUM(CASE WHEN status NOT IN ('done', 'canceled') THEN 1 ELSE 0 END) AS task_open
         FROM tasks WHERE project_id = ? GROUP BY assignee_bot_id
       ) ts ON ts.assignee_bot_id = pm.member_id
       WHERE pm.project_id = ? AND pm.member_type = 'bot'
       ORDER BY CASE pm.member_role WHEN 'owner' THEN 0 ELSE 1 END, b.name`,
      projectId,
      projectId,
      projectId,
    ).map(row => ({
      ...row,
      busy: Boolean(row.busy),
      modelRef: row.provider && row.model ? `${row.provider}/${row.model}` : null,
      taskStats: { done: Number(row.task_done ?? 0), open: Number(row.task_open ?? 0) },
    }))
  },
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
  },

  // 项目生产目录：显式指定的外部目录优先（Bot 的 cwd、密钥物化、产物清单），
  // 未指定时与 <工作区>/{slug} 管理目录一致。
  projectWorkDir(project) {
    return project.production_dir || join(this.config.workspace, project.slug)
  },

  // 解析用户指定的生产目录：空串/null 表示回退默认；必须是可用的绝对路径目录。
  async resolveProductionDir(value) {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return null
    try {
      return await ensureExternalDir(raw)
    } catch (error) {
      throw badRequest(error.message || '生产目录无效')
    }
  },

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
  },
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
  },
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
    // 团队级密钥已存在时，新项目只做旧架构 .team/secrets.env 残留清理（DSHBOTS-106 起不物化明文）。
    const teamSecrets = this.store.get("SELECT COUNT(*) AS n FROM secrets WHERE scope = 'team'")
    if (Number(teamSecrets?.n) > 0) {
      try {
        await this.materializeProjectSecrets(this.projectRow(projectId))
      } catch (error) {
        this.logger.warn?.(`dsh-team: 新项目 ${projectId} 清理旧 .team/secrets.env 残留失败：${error?.message ?? error}`)
      }
    }
    return this.projectView(this.projectRow(projectId))
  },
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
    // 单文件行数约定（DSHBOTS-172）：NULL = 默认 800，0 = 关闭；读取口径见 services/hygiene.js。
    if (patch.codeHygieneLimitLines !== undefined) updates.code_hygiene_limit_lines = clampNumber(patch.codeHygieneLimitLines, 0, 100_000, null)
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
    } else if (updates.owner_bot_id) {
      // 不带 memberIds 的增量更新（设置页已不再全量提交成员）：换总监时补齐成员表，
      // 维持「总监恒为成员」不变量；角色同步为 owner，原总监降为普通成员。
      this.botRow(updates.owner_bot_id)
      this.store.run(
        "UPDATE project_members SET member_role = 'member' WHERE project_id = ? AND member_role = 'owner'",
        projectId,
      )
      this.store.run(
        'INSERT INTO project_members(project_id, member_type, member_id, member_role, joined_at) VALUES (?, ?, ?, ?, ?) '
          + 'ON CONFLICT(project_id, member_type, member_id) DO UPDATE SET member_role = ?',
        projectId, 'bot', updates.owner_bot_id, 'owner', nowIso(), 'owner',
      )
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
      // 再开与归档对称：归档时冻结的项目记忆解回 active，逐条留 memory_events 审计。
      // 已知不对称（接受）：冻结前 active/pending 一并冻为 frozen，再开统一解回 active，pending 记忆直接生效。
      if (updates.status === 'active' && project.status === 'archived') {
        const frozen = this.store.all(
          "SELECT id FROM memories WHERE scope_type = 'project' AND scope_id = ? AND status = 'frozen'",
          projectId,
        )
        for (const memory of frozen) {
          this.store.run("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?", nowIso(), memory.id)
          this.store.run(
            `INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at)
             VALUES (?, ?, 'unfrozen', ?, ?, 'frozen', 'active', ?)`,
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
    // 生产目录切换后：旧目录的明文 secrets.env 不许留下（新目录不再物化，DSHBOTS-106 起明文走数据目录一次性文件）。
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
          this.logger.warn?.(`dsh-team: 切换生产目录后清理旧密钥残留失败：${error?.message ?? error}`)
        }
      }
    }
    return this.projectView(this.projectRow(projectId))
  },
  archiveProject(projectId, actor = this.actor()) {
    return this.updateProject(projectId, { status: 'archived' }, actor)
  },

  // 归档项目的再开：与 archiveProject 对称的薄封装；记忆解冻在 updateProject 事务内对称补齐。
  reopenProject(projectId, actor = this.actor()) {
    const project = this.projectRow(projectId)
    if (project.status !== 'archived') throw badRequest('项目未归档，无需再开')
    const view = this.updateProject(projectId, { status: 'active' }, actor)
    // 再开成功后补一条显式审计（updateProject 事务内已有 project.update 行）。
    this.audit(actor, 'project.reopen', 'project', projectId, { key: project.key, name: project.name })
    return view
  },

  // 移除已归档项目的全部管理数据（含项目行本身）。全局口径不动的三张表：usage_events（FK 置空，
  // 用量是全局历史）、audit_log（append-only，本次移除本身要可审计）、solo_messages（Bot 域，与项目无关）。
  // 逐表显式删除（子表先于父表），不依赖隐式级联；proposals 的 FK 是 SET NULL，必须在项目行删除前清掉。
  removeProjectTracking(projectId, input = {}, actor = this.actor()) {
    const project = this.projectRow(projectId)
    if (project.status !== 'archived') throw badRequest('项目未归档，先归档再移除追踪')
    const confirmName = typeof input.confirmName === 'string' ? input.confirmName.trim() : ''
    if (confirmName !== project.name) throw badRequest('确认名称与项目名不一致，已拒绝移除')
    const active = this.store.get(
      "SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status IN ('queued', 'running')",
      projectId,
    )
    if (Number(active?.n) > 0) throw badRequest('项目仍有排队或运行中的 run，不能移除追踪')
    const dir = this.projectWorkDir(project)
    this.store.transaction(() => {
      const runIds = 'SELECT id FROM runs WHERE project_id = ?'
      const taskIds = 'SELECT id FROM tasks WHERE project_id = ?'
      // 聊天附图随消息一起清（FK 级联是主路径，这里再显式删一次防孤儿行）。
      this.store.run('DELETE FROM message_images WHERE project_id = ?', projectId)
      this.store.run('DELETE FROM messages WHERE project_id = ?', projectId)
      this.store.run('DELETE FROM bot_messages WHERE project_id = ?', projectId)
      this.store.run(`DELETE FROM run_trajectory WHERE run_id IN (${runIds})`, projectId)
      this.store.run(`DELETE FROM run_events WHERE run_id IN (${runIds})`, projectId)
      this.store.run(`DELETE FROM usage_reconciliation WHERE run_id IN (${runIds})`, projectId)
      this.store.run('DELETE FROM runs WHERE project_id = ?', projectId)
      this.store.run(`DELETE FROM task_labels WHERE task_id IN (${taskIds})`, projectId)
      this.store.run(`DELETE FROM task_dependencies WHERE task_id IN (${taskIds}) OR depends_on_task_id IN (${taskIds})`, projectId, projectId)
      this.store.run(`DELETE FROM task_comments WHERE task_id IN (${taskIds})`, projectId)
      this.store.run(`DELETE FROM task_events WHERE task_id IN (${taskIds})`, projectId)
      this.store.run('DELETE FROM tasks WHERE project_id = ?', projectId)
      this.store.run('DELETE FROM session_bindings WHERE project_id = ?', projectId)
      this.store.run('DELETE FROM terminal_commands WHERE project_id = ?', projectId)
      this.store.run('DELETE FROM outbox WHERE project_id = ?', projectId)
      this.store.run('DELETE FROM group_chats WHERE project_id = ?', projectId)
      this.store.run('DELETE FROM secret_requests WHERE project_id = ?', projectId)
      this.store.run("DELETE FROM secrets WHERE scope = 'project' AND project_id = ?", projectId)
      this.store.run("DELETE FROM skill_bindings WHERE scope_type = 'project' AND scope_id = ?", projectId)
      // memories 无 FK 到 projects；memory_events 走 FK 级联、memories_fts 走删除触发器。
      this.store.run("DELETE FROM memories WHERE scope_type = 'project' AND scope_id = ?", projectId)
      this.store.run('DELETE FROM project_members WHERE project_id = ?', projectId)
      this.store.run('DELETE FROM proposals WHERE project_id = ?', projectId)
      this.store.run('DELETE FROM projects WHERE id = ?', projectId)
      this.audit(actor, 'project.remove_tracking', 'project', projectId, {
        key: project.key, name: project.name,
        deleteProductionDir: input.deleteProductionDir === true, dir,
      })
    })
    // 生产目录默认保留；仅显式要求且确认名已匹配时，删解析出的这一个精确路径，不做任何路径推导。
    // 失败只 warn 不回滚（管理数据已按口径清完），并补审计行如实记录。
    if (input.deleteProductionDir === true) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        this.logger.warn?.(`dsh-team: 移除项目 ${project.key} 生产目录失败：${error?.message ?? error}`)
        this.audit(actor, 'project.remove_tracking_dir', 'project', projectId, { dir, deleted: false })
      }
    }
    return { removed: true, key: project.key }
  },

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
  },

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
  },
}
