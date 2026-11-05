// src/services/runs.js —— 运行生命周期域
// 运行的入队、取消、重试、执行、轨迹/产物读取与只读工作区审计。
// 运行结束后的收尾与交付派发见 ./run-finish.js。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { existsSync, realpathSync, statSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { assertInside } from '../paths.js'
import { deliveryPlan, replyDeliveryPrompt } from '../botmsg.js'
import { id, jsonParse, nowIso, sha256, text } from '../util.js'
import { readWriteScopes, writeScopePathsOverlap } from './write-scopes.js'
import { isProviderUnavailableCode } from './model-fallback.js'
import { effectiveSandbox } from './runtime/prompt.js'
import { ensureAttentionSchema, parseAttention } from './attention-schema.js'

// ── 只读运行工作区审计归因（DSHBOTS-94）─────────────────────────────────
// 指纹行形如 " M dir/file"（前两字符状态位 + 空格 + 路径）；重命名 "R  old -> new"
// 的新旧路径都算被触碰。带引号的 quoted 路径不解析（与产物清单同一口径，跳过）。
export function porcelainTouchedPaths(output) {
  const paths = new Set()
  for (const line of String(output ?? '').split('\n')) {
    if (line.length < 4) continue
    const path = line.slice(3).trim()
    if (!path || path.startsWith('"')) continue
    const arrow = path.indexOf(' -> ')
    if (arrow === -1) {
      paths.add(path)
      continue
    }
    const left = path.slice(0, arrow).trim()
    const right = path.slice(arrow + 4).trim()
    if (left) paths.add(left)
    if (right) paths.add(right)
  }
  return paths
}

// 归因判定（纯函数，供测试直接锚定）：before/after 为 read 运行起止两次
// `git status --porcelain` 指纹；concurrentWrites 为窗口内并发的写运行
// [{ id, label, scopes }]，scopes 是归一化写范围数组（空数组 = 未声明，
// 视为可能写任何路径）。返回 { silent, suspects, unattributedPaths }：
// - 无并发写运行，或有路径不落在任何并发写范围 → 不静默，suspects 供告警点名；
// - 变化全部可归因（含并发写未声明范围的保守情形）→ 静默不打扰用户。
export function attributeWorkspaceChange({ before, after, concurrentWrites = [] }) {
  const beforeLines = new Set(String(before ?? '').split('\n'))
  const afterLines = new Set(String(after ?? '').split('\n'))
  const changedLines = []
  for (const line of beforeLines) if (!afterLines.has(line)) changedLines.push(line)
  for (const line of afterLines) if (!beforeLines.has(line)) changedLines.push(line)
  const writes = concurrentWrites.filter(item => item && item.id)
  const unattributedPaths = []
  for (const path of porcelainTouchedPaths(changedLines.join('\n'))) {
    const covered = writes.some(write =>
      !write.scopes?.length || write.scopes.some(scope => writeScopePathsOverlap(path, scope)))
    if (!covered) unattributedPaths.push(path)
  }
  if (!writes.length || unattributedPaths.length) {
    return { silent: false, suspects: writes.map(write => write.label ?? write.id), unattributedPaths }
  }
  return { silent: true, attributedTo: writes.map(write => write.label ?? write.id) }
}


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
      } catch (error     ) {
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
  // 看板拖出执行中（todo/blocked）：任务主动暂停而非终局取消，
  // error_code='PAUSED_BY_BOARD' 让它与 SUPERSEDED（清理冗余，不进执行历史）区分开，保留可重试的执行历史。
  async pauseRunsForBoard(taskId) {
    const runs = this.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", taskId)
    let paused = 0
    for (const run of runs) {
      await this.runtime?.cancelRun(run.id)
      const changed = this.store.run(
        "UPDATE runs SET status = 'canceled', ended_at = ?, cancel_requested = 1, error_code = 'PAUSED_BY_BOARD', error_message = ? WHERE id = ? AND status IN ('queued', 'running')",
        nowIso(), '任务被移出执行中，运行暂停', run.id,
      )
      if (Number(changed?.changes ?? 0) === 1) {
        this.insertRunEvent(run.id, 'board_pause', '任务被移出执行中，看板暂停')
        paused += 1
      }
    }
    return paused
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
      // DSHBOTS-112：vision 派生运行按 project_id 归位原消息（群聊 messages / 单聊
      // solo_messages），trigger_ref 即原消息 id——startRun 据此把附图随首条 prompt
      // 带给代理模型（与 chat/solo_chat 同一链路）。
      const chatMessage = (run.kind === 'chat' || (run.kind === 'vision' && run.project_id)) && run.trigger_ref
        ? this.store.get('SELECT * FROM messages WHERE id = ?', run.trigger_ref)
        : (run.kind === 'solo_chat' || (run.kind === 'vision' && !run.project_id)) && run.trigger_ref
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
    } catch (error     ) {
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
    // DSHBOTS-112：单聊读图代理运行落 bot 的 solo 会话（与 solo_chat 同一绑定）。
    if (run.kind === 'vision' && !run.project_id) return 'solo'
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

  // 成功写运行的交付产物清单：项目目录 git status 的相对路径快照（M/A/?? 状态），
  // 再用 git check-ignore 剔除 .gitignore 排除的路径。非 git 仓库或 git 不可用时跳过并记
  // run_event；清单上限 200 条，不复制文件内容。
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
    if (!list.length) return null
    // 清单是给人看「这次改了什么」的，不收 .gitignore 排除的文件。git status 本身不列
    // ignored 的未跟踪文件，但「ignore 规则补上之前就已存在」的路径与「已跟踪但后被
    // ignore」的脏文件仍会混进来，这里对全部候选路径统一二次过滤（含已跟踪文件）。
    // 必须带 --no-index：check-ignore 默认查索引，已跟踪文件一律不判为 ignored，
    // --no-index 才会纯按 ignore 规则匹配出这类脏文件。
    // check-ignore 退出码 0=有命中、1=无命中都算正常；其余退出码视为过滤失败，
    // 保留原清单并记 run_event，不静默吞掉。
    try {
      const check = spawnSync('git', ['-c', 'core.quotePath=false', 'check-ignore', '--no-index', '--stdin'], {
        cwd: dir,
        timeout: 5_000,
        encoding: 'utf8',
        input: list.map(item => item.path).join('\n'),
      })
      if (check.status === 0 || check.status === 1) {
        const ignored = new Set(String(check.stdout ?? '').split('\n').filter(Boolean))
        const filtered = list.filter(item => !ignored.has(item.path))
        return filtered.length ? JSON.stringify(filtered) : null
      }
      this.insertRunEvent(run.id, 'artifacts_ignore_failed', `git check-ignore 异常退出（${check.signal ?? check.status}），清单未做忽略过滤`)
    } catch {
      this.insertRunEvent(run.id, 'artifacts_ignore_failed', 'git check-ignore 不可用，清单未做忽略过滤')
    }
    return JSON.stringify(list)
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
  // DSHBOTS-94：指纹变化先归因——窗口内（started_at→结束时刻）存在并发写运行且变化
  // 落在其写范围内（或其未声明范围）时不点名，改记 run_event 留痕；只有无人认领的
  // 变化才维持点名告警，告警里带上对不上号的并发写运行号。
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
    // finishRun 在更新 runs 行之前调用本方法，此时 run.ended_at 还没落库，用当前时刻收口。
    const windowEnd = run.ended_at ?? nowIso()
    const windowStart = run.started_at ?? run.queued_at ?? windowEnd
    const concurrentWrites = (this.store.all(
      `SELECT r.id, r.write_scopes, t.number AS task_number
       FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
       WHERE r.project_id = ? AND r.mode = 'write' AND r.id != ?
         AND r.started_at IS NOT NULL AND r.started_at <= ?
         AND (r.ended_at IS NULL OR r.ended_at >= ?)`,
      project.id, run.id, windowEnd, windowStart,
    ) ?? []).map(row => ({
      id: row.id,
      label: row.task_number ? `${project.key}-${row.task_number}` : row.id,
      scopes: readWriteScopes(row.write_scopes),
    }))
    const decision = attributeWorkspaceChange({ before, after, concurrentWrites })
    if (decision.silent) {
      this.insertRunEvent(
        run.id,
        'read_audit_attributed',
        `工作区变化已归因到并发写运行（${decision.attributedTo.join('、')}），不点名只读运行`,
      )
      return
    }
    const suspectNote = decision.suspects.length
      ? `（存在并发写运行 ${decision.suspects.join('、')}，但变化不在其写范围内）`
      : ''
    // 同指纹去重（DSHBOTS-96 P1-2）：after 内容 hash 相同说明是同一工作区状态再次被扫到，
    // 已点名过就不再重复插群消息，只留 run_event 供追溯。
    const dedupKey = `${project.id}:${sha256(after)}`
    if (this.readAuditAlerted.has(dedupKey)) {
      this.insertRunEvent(run.id, 'read_audit_dup', '工作区指纹与已告警记录相同，本次不重复点名')
      this.logger.warn?.('dsh-team: read-only run %s changed the workspace (duplicate fingerprint, alert suppressed)', run.id)
      return
    }
    this.readAuditAlerted.set(dedupKey, run.id)
    this.insertMessage({
      projectId: project.id,
      senderType: 'system',
      senderId: 'system',
      body: `⚠️ 工作区在只读运行（${run.kind}，运行 ${run.id}）期间被修改，未归因到并发写运行${suspectNote}：\n\`\`\`\n${after.slice(0, 400)}\n\`\`\`\n若此变更应由任务产出，请立卡跟进。`,
      taskId: run.task_id ?? undefined,
      runId: run.id,
    })
    this.logger.warn?.('dsh-team: read-only run %s changed the workspace', run.id)
  },
  runView(run) {
    const bot = this.store.get('SELECT name, provider, model, fallback_provider, fallback_model, file_policy FROM bots WHERE id = ?', run.bot_id)
    const task = run.task_id ? this.store.get('SELECT number, title, sandbox_override FROM tasks WHERE id = ?', run.task_id) : undefined
    const project = run.project_id ? this.store.get('SELECT key FROM projects WHERE id = ?', run.project_id) : undefined
    // recovery 是重启恢复的内部瞬态标记（置位→注入→清零），不属于 API 视图，随 attention_json 一并剥出。
    const { write_scopes: rawScopes, attention_json: attentionJson, recovery: _recovery, ...rest } = run
    const fallbackRef = bot?.fallback_provider && bot?.fallback_model ? `${bot.fallback_provider}/${bot.fallback_model}` : null
    const usedRef = run.model_provider && run.model_model ? `${run.model_provider}/${run.model_model}` : null
    return {
      ...rest,
      artifacts: jsonParse(run.artifacts, []),
      attention: parseAttention(attentionJson),
      botName: bot?.name ?? 'Bot',
      taskIdentifier: task ? `${project?.key ?? 'T'}-${task.number}` : null,
      taskTitle: task?.title ?? null,
      writeScopes: readWriteScopes(rawScopes),
      // 生效沙箱档（DSHBOTS-156）：非 write 运行恒 read-only，任务写运行取派发覆盖（只收紧）或 bot 配置档。
      // 口径唯一来源 effectiveSandbox，与起会话落 run_events 的档位一致。
      sandboxMode: effectiveSandbox(run, bot, task).mode ?? null,
      // 备用模型标记：configured=配了备用，applied=这条运行走了备用，
      // degraded=主模型不可用且配了备用但这条没走（自动切换只对任务运行生效）。
      modelFallback: {
        configured: Boolean(fallbackRef),
        ref: fallbackRef,
        applied: Boolean(usedRef),
        usedModel: usedRef ?? (bot?.provider && bot?.model ? `${bot.provider}/${bot.model}` : null),
        degraded: Boolean(fallbackRef) && !usedRef && isProviderUnavailableCode(run.error_code),
      },
    }
  },

  // 回答结构化提问（DSHBOTS-43）：仅负责人（owner）可调。
  // 回答作为一条 @该 bot 的群聊消息投回原会话（复用既有 chat 投递通道，触发 chat_run），
  // 单聊运行走 solo 通道；同时清空 attention_json 并记 run_events 'attention_answered'。
  async answerAttention(runId, answer, actor = this.actor()) {
    if (actor?.type !== 'user') throw forbidden('只有项目负责人可以回答结构化提问')
    const cleanAnswer = text(answer, 20_000)
    if (!cleanAnswer) throw badRequest('回答不能为空')
    ensureAttentionSchema(this.store)
    const run = this.runRow(runId)
    const attention = parseAttention(run.attention_json)
    if (!attention) throw conflict('该运行没有待回答的结构化提问')
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
    if (!bot) throw notFound('运行的 Bot 已不存在')
    if (run.project_id) {
      const messageId = this.insertMessage({
        projectId: run.project_id,
        senderType: 'user',
        senderId: actor?.id ?? this.localUserId,
        body: `回复提问「${attention.question}」：${cleanAnswer}`,
        mentions: [bot.id],
        runId,
      })
      if (messageId) {
        this.enqueueOutbox({
          kind: 'chat_run',
          payload: { projectId: run.project_id, botId: bot.id, messageId },
          projectId: run.project_id,
          sourceId: messageId,
          idempotencyKey: `chat:${messageId}:${bot.id}`,
        })
      }
    } else {
      const messageId = this.insertSoloMessage({
        botId: bot.id,
        senderType: 'user',
        senderId: actor?.id ?? this.localUserId,
        body: `回复提问「${attention.question}」：${cleanAnswer}`,
        runId,
      })
      if (messageId) {
        this.enqueueOutbox({
          kind: 'solo_chat_run',
          payload: { botId: bot.id, messageId },
          projectId: null,
          sourceId: messageId,
          idempotencyKey: `solo:${messageId}`,
        })
      }
    }
    this.store.run('UPDATE runs SET attention_json = NULL WHERE id = ?', runId)
    this.insertRunEvent(runId, 'attention_answered', `负责人已回答提问：${attention.question}`)
    this.audit(actor, 'attention.answer', 'run', runId, { question: attention.question })
    void this.tick()
    return this.runView(this.runRow(runId))
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
