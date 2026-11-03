// src/services/runs.js —— 运行生命周期域
// 运行的入队、取消、重试、执行、收尾与轨迹/产物读取。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { existsSync, realpathSync, statSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { assertInside } from '../paths.js'
import { runUsageTotals } from '../usage.js'
import { deliveryPlan, replyDeliveryPrompt } from '../botmsg.js'
import { id, jsonParse, nowIso, sha256, text } from '../util.js'
import { readWriteScopes, writeScopePathsOverlap } from './write-scopes.js'
import { isProviderUnavailableCode } from './model-fallback.js'
import { completeVisionRun, maybeSpawnVisionAfterFailure } from './vision-proxy.js'
import {
  isQuotaExhausted,
  isRateLimitError,
  MAX_RATE_LIMIT_RETRIES,
  needsSynthesizedBackoff,
  rateLimitBackoffMs,
} from './backoff.js'
import { ensureAttentionSchema, normalizeAttention, parseAttention } from './attention-schema.js'

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
  // 自动核验委派（DSHBOTS-113）：交付迁移 in_review 的同一事务内调用。开关关闭或
  // 迁移未生效（任务已终态）时静默跳过；项目无可用总监属结构性前提缺失，审计留痕后
  // 跳过（不进重试队列）。满足条件则排 review_delegate_auto outbox（立即投递一次），
  // 后续守卫冲突的退避重试与耗尽可见性由 outbox 侧统一负责。返回是否已排队。
  queueAutoReviewDelegate(task, project, run, attentionPending) {
    if (!this.autoReviewDelegateEnabled()) return false
    // 交付带提问（attention）时先让 owner 答话：核验结论会因方向未定而过时，
    // 且派生运行会顶掉 taskView 的「等待你回答」阶段；退位手动委派。
    // attentionPending 是本次完成时新落库的提问标记（run 行是完成前取的，已过期）。
    if (attentionPending) return false
    const current = this.taskRow(task.id)
    if (current.status !== 'in_review') return false
    const owner = project.owner_bot_id
      ? this.store.get("SELECT id FROM bots WHERE id = ? AND status = 'active'", project.owner_bot_id)
      : null
    if (!owner) {
      this.audit({ type: 'system', id: 'system' }, 'review.auto_delegate', 'task', task.id, { skipped: 'no_owner' })
      return false
    }
    this.enqueueOutbox({
      kind: 'review_delegate_auto',
      payload: { taskId: task.id },
      projectId: project.id,
      taskId: task.id,
      sourceId: run.id,
      idempotencyKey: `review_auto:${task.id}:${run.id}`,
    })
    return true
  },
  async finishRun({ runId, status, output, error, attention }) {
    const run = this.runRow(runId)
    if (!['running', 'queued'].includes(run.status)) return
    ensureAttentionSchema(this.store)
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
    const project = this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id)
    this.auditReadRunWrites(run, project)
    const usage = runUsageTotals(this.store, runId, this.budgetCurrency())
    const cleanOutput = this.maskSecretValues(text(output, 120_000))
    const artifactsJson = status === 'succeeded' && run.mode === 'write' && project
      ? this.captureRunArtifacts(run, project)
      : null
    const endedAt = nowIso()
    // DSHBOTS-38：限流失败且 provider 未给 Retry-After 时合成指数退避，写进 retry_after_ms，
    // plan_wait 状态与到期派生随之自动生效。真 Retry-After 永远优先，不被合成值覆盖。
    // DSHBOTS-99：额度耗尽（已达到限额）不合成指数退避——额度窗口用尽，退避重打撞同一堵墙。
    const attemptNo = Math.max(1, Number(run.attempt) || 1)
    const quotaExhausted = isQuotaExhausted(error)
    const synthesizedMs = needsSynthesizedBackoff(error) ? rateLimitBackoffMs(attemptNo) : null
    // 额度耗尽时 provider 真给的重置时间照样保留（信息不丢，供 UI 显示额度恢复时间），
    // 但它不再触发对主模型的自动重试（见下方失败分支与 scheduler.retryExpiredPlanWaits）。
    const retryAfterMs = Number(error?.retryAfterMs) > 0 ? Number(error.retryAfterMs) : synthesizedMs
    this.store.run(
      `UPDATE runs SET status = ?, output = ?, artifacts = ?, error_code = ?, error_message = ?, retry_after_ms = ?, ended_at = ?,
       usage_input = ?, usage_cache_read = ?, usage_cache_write = ?, usage_output = ?, usage_cost = ?
       WHERE id = ? AND status IN ('running', 'queued')`,
      status, cleanOutput, artifactsJson, error?.code ?? null, error?.message ?? null, retryAfterMs, endedAt,
      usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens, usage.cost,
      runId,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, status, error?.message ?? (status === 'succeeded' ? '完成' : ''), endedAt,
    )
    // DSHBOTS-106 一次性密钥：项目内 task 运行一结束（成功/失败都算）即焚该项目的运行时
    // 密钥文件。放在分派主体之前，不受下方任何提前 return 影响。
    if (run.kind === 'task' && run.project_id) {
      this.burnProjectSecretsRuntime(run.project_id, 'run_finish')
    }
    if (synthesizedMs) {
      const suffix = attemptNo < MAX_RATE_LIMIT_RETRIES ? '后重试' : '后转总监处理'
      this.insertRunEvent(
        runId,
        'rate_limit_backoff',
        `上游限流（${error?.code}）未返回 Retry-After，第 ${attemptNo} 次退避，约 ${Math.round(synthesizedMs / 1000)} 秒${suffix}`,
      )
    }
    // 结构化提问（attention）：只在 bot 显式给出时落库，规范超长/超量后写入；
    // 不从 output 自由文本做任何推断（正则猜问号被明确禁止）。
    const attentionJson = JSON.stringify(normalizeAttention(attention) ?? null) === 'null'
      ? null
      : JSON.stringify(normalizeAttention(attention))
    if (attentionJson) {
      this.store.run('UPDATE runs SET attention_json = ? WHERE id = ?', attentionJson, runId)
    }
    const refreshed = this.runRow(runId)
    // DSHBOTS-112 读图代理收尾：转写成功 →「[图片转写] …」system 消息写回原消息
    // 所在会话并审计 vision.transcribe；失败/空产出 → 只审计 vision.fallback（原
    // 对话已按现状报过模型无视觉，不插消息不重试）。写回后即结束，不走下方分支。
    if (run.kind === 'vision') {
      await completeVisionRun(this, { run: refreshed, bot, status, output: cleanOutput, error })
      if (run.project_id && this.rate[run.project_id]) delete this.rate[run.project_id]
      return
    }
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
        // 委派核验运行（DSHBOTS-107）成功时，结论以任务评论写回（复用 addComment 通道：
        // 评论+事件+审计一次落全）。不改任务状态、不代为裁决——accept/return 仍归 owner。
        if (run.trigger_type === 'review_delegate' && status === 'succeeded' && cleanOutput) {
          await this.addComment(run.task_id, cleanOutput, { type: 'bot', id: bot.id })
        }
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
        // 串联两跳（DSHBOTS-113）：委派核验运行结束后，owner_bot 卡的裁决运行在此触发——
        // 总监在尾窗读到上面写回的核验结论后 team_review_task 裁决。核验运行失败也照常触发：
        // 总监的验收运行自带子代理核验，核验跳失败不丢裁决。user 卡不裁决，维持人工验收。
        // 核验运行自身带提问时同样不排：先答话，避免裁决运行顶掉「等待你回答」阶段。
        if (run.trigger_type === 'review_delegate' && task.status === 'in_review'
          && !attentionJson
          && (task.review_target ?? 'user') === 'owner_bot') {
          this.enqueueOutbox({
            kind: 'owner_task_run',
            payload: { taskId: task.id, reviewKind: 'review' },
            projectId: task.project_id,
            taskId: task.id,
            idempotencyKey: `owner_review:${task.id}:${run.id}`,
          })
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
        let autoReviewQueued = false
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
          // 自动核验委派（DSHBOTS-113）：与 in_review 迁移同一事务触发留痕；实际派生由
          // review_delegate_auto outbox 承接（幂等键绑定本次交付运行），守卫冲突的退避重试
          // 与耗尽可见性都在 outbox 侧，任何失败都不回滚本次迁移。
          autoReviewQueued = this.queueAutoReviewDelegate(task, project, run, Boolean(attentionJson))
        })
        const summary = this.chatSummary(cleanOutput)
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: ownerReview
            ? `任务 ${project.key}-${task.number} 已交付，待总监验收。\n\n${summary}\n\n（完整记录见任务评论）`
            : `任务 ${project.key}-${task.number} 已交付，待验收。\n\n${summary}\n\n（完整记录见任务评论）`,
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
        if (ownerReview && !autoReviewQueued && !attentionJson) {
          // 自动委派未接管时维持原链路（开关关 / 无可用总监）：交付后直接触发总监验收。
          // 带提问的交付同样不排——派生运行会顶掉「等待你回答」阶段，先答话再验收。
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
      // DSHBOTS-112：无视觉模型收图失败的兜底信号——错误表明模型无视觉且消息带图时补派生
      // 读图代理（幂等，与主动派生不重复）；代理未配置只审计 vision.fallback，错误按现状已报。
      if (run.kind === 'chat' || run.kind === 'solo_chat') {
        maybeSpawnVisionAfterFailure(this, { run: refreshed, bot, error })
      }
      // DSHBOTS-38：限流失败（provider 真发 Retry-After 或 finishRun 合成的指数退避）在等待期内
      // 禁止立刻重打上游——不切备用模型（备用可能走同一网关），也不立刻排总监处理运行。
      // DSHBOTS-99：额度耗尽（已达到限额）不走这条路径——不指数退避、无条件先试备用模型；
      // 瞬时限流的等待语义原样保留。
      const backoffWaitMs = isRateLimitError(error) && retryAfterMs > 0 ? retryAfterMs : 0
      // 额度耗尽不做自动重试：重置时间只当信息留着，不据此重打主模型。
      const willRetry = !quotaExhausted && backoffWaitMs > 0 && attemptNo < MAX_RATE_LIMIT_RETRIES
      // 主 provider 不可用：临时切备用模型继续跑这条任务。派生成功后任务不置 blocked、
      // 也不转总监处理——备用运行接手的是同一条任务链。
      // 瞬时限流等待中不切，等 plan_retry 到期重试；额度耗尽无条件先切备用。
      const fallback = quotaExhausted || backoffWaitMs === 0
        ? this.spawnModelFallback({ run: refreshed, bot, error })
        : null
      // provider 给的额度重置时间（仅额度耗尽时可能带）。
      const quotaResetNote = quotaExhausted && retryAfterMs > 0
        ? `（额度预计 ${Math.max(1, Math.round(retryAfterMs / 60_000))} 分钟后恢复）`
        : ''
      if (fallback) {
        this.addTaskEvent(run.task_id, 'model_fallback', { type: 'bot', id: bot.id }, {
          runId,
          fallbackRunId: fallback.runId,
          errorCode: error?.code ?? null,
          fallbackRef: fallback.fallback.ref,
        })
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: quotaExhausted
            ? `已达限额（${error?.code ?? '未知错误'}），已切换备用模型 ${fallback.fallback.ref} 继续执行。${quotaResetNote}`
            : `主模型不可用（${error?.code ?? '未知错误'}），已临时切换到备用模型 ${fallback.fallback.ref} 继续执行。`,
          taskId: run.task_id,
          runId,
        })
      } else if (run.task_id) {
        this.store.run(
          "UPDATE tasks SET status = 'blocked', version = version + 1, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'canceled')",
          endedAt, run.task_id,
        )
        this.addTaskEvent(run.task_id, 'run_failed', { type: 'bot', id: bot.id }, { runId, error })
        // 额度耗尽没有「退避后自动重试」这回事：主备都限额就是终点，任务转受阻。
        const quotaNote = quotaExhausted
          ? `\n已达限额（${error?.code ?? '未知错误'}），主备模型均不可用，任务转为受阻${quotaResetNote}。`
          : ''
        const backoffNote = backoffWaitMs > 0
          ? (willRetry
              ? `\n上游限流，第 ${attemptNo} 次指数退避，约 ${Math.round(backoffWaitMs / 1000)} 秒后自动重试。`
              : `\n上游限流，已达自动重试上限，约 ${Math.round(backoffWaitMs / 1000)} 秒后转总监处理。`)
          : ''
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `任务执行失败：${error?.message ?? '未知错误'}\n运行 ID：${runId}${quotaNote}${backoffNote}`,
          taskId: run.task_id,
          runId,
        })
        // attempt<MAX：不排 owner handle——plan_retry 到期派生接管重试，handle 运行会占住任务把派生挤掉。
        // 链耗尽（attempt>=MAX）转总监处理，但仍按退避延迟投递，到点才打上游；非限流失败照旧立即投递。
        // 额度耗尽不排 handle：主备都限额时再派总监运行只会再撞一次额度，任务留受阻等人工介入。
        if (!willRetry && !quotaExhausted) {
          this.enqueueOutbox({
            kind: 'owner_task_run',
            payload: { taskId: run.task_id, reviewKind: 'handle' },
            projectId: run.project_id,
            taskId: run.task_id,
            idempotencyKey: `owner_handle:${run.task_id}:${run.id}`,
            availableAt: backoffWaitMs > 0 ? new Date(Date.now() + backoffWaitMs) : null,
          })
        }
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
    const bot = this.store.get('SELECT name, provider, model, fallback_provider, fallback_model FROM bots WHERE id = ?', run.bot_id)
    const task = run.task_id ? this.store.get('SELECT number, title FROM tasks WHERE id = ?', run.task_id) : undefined
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
