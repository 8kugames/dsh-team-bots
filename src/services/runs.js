// src/services/runs.js —— 运行生命周期域
// 运行的入队、取消、重试、执行、收尾与轨迹/产物读取。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { existsSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { assertInside } from '../paths.js'
import { runUsageTotals } from '../usage.js'
import { deliveryPlan, replyDeliveryPrompt } from '../botmsg.js'
import { id, jsonParse, nowIso, text } from '../util.js'
import { readWriteScopes } from './write-scopes.js'



export const runsMethods = {

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
  },

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
  },
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
  },
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
  },
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
  },
  async cancelRun(runId, actor = this.actor()) {
    const run = this.runRow(runId)
    await this.cancelRunInternal(runId, true)
    this.audit(actor, 'run.cancel', 'run', runId, {})
    return this.runRow(runId)
  },

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
  },
  async cancelRunsForTask(taskId) {
    const runs = this.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", taskId)
    for (const run of runs) await this.cancelRunInternal(run.id, false)
  },
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
  },
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
  },

  // 跨类别运行的目标会话类别：dm_reply 按来信来源的类别。
  sessionKindFor(run) {
    if (run.kind === 'dm_reply') {
      const message = run.trigger_ref
        ? this.store.get('SELECT origin_kind FROM bot_messages WHERE id = ?', run.trigger_ref)
        : null
      return message?.origin_kind === 'task' ? 'task' : message?.origin_kind === 'dm' ? 'dm' : 'project'
    }
    return undefined
  },

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
  },
  insertRunEvent(runId, type, message) {
    if (!runId) return
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, type, this.maskSecretValues(message), nowIso(),
    )
  },

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
  },

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
  },

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
  },
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
  },
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
  },

  // 产物清单视图：HTTP 端点与运行详情面板共用。
  listRunArtifacts(runId) {
    const run = this.runRow(runId)
    const list = jsonParse(run.artifacts, [])
    return { runId, artifacts: Array.isArray(list) ? list : [] }
  },

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
  },
}
