// src/services/memory.js —— 记忆域
// 记忆写入与检索、记忆审查、记忆回灌与权限口径。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { maskSecrets } from '../secrets.js'
import { id, jsonParse, nowIso, redactSecrets, text, sanitizeFilename } from '../util.js'

// 记忆上限（DSHBOTS-339）：bot/project 作用域 active 记忆硬顶 MEMORY_CAP 条；触顶后新增被拒，
// 须先整理到 MEMORY_COMPACT_TO 条以内才恢复放行（滞回，避免在阈值附近反复开关）。team 作用域不限。
export const MEMORY_CAP = 64
export const MEMORY_COMPACT_TO = 33
// 单条记忆篇幅上限（owner 补充）：content 不得超过 256 字。
export const MEMORY_MAX_CHARS = 256

// 记忆审查专用模型（可选）：provider 与 model 都非空才启用，否则 null（沿用 Bot
// 主模型）。手法同读图代理的 visionProxyTarget——配置对见 config.js 的
// memoryReviewProvider/memoryReviewModel（DSH_TEAM_MEMORY_REVIEW_PROVIDER/_MODEL）。
export function memoryReviewModelTarget(config) {
  const provider = String(config?.memoryReviewProvider ?? '').trim()
  const model = String(config?.memoryReviewModel ?? '').trim()
  return provider && model ? { provider, model } : null
}

// 记忆审查输出：模型返回 JSON 数组，形如 [{scope, topic, content, confidence}]。
export function parseMemoryReview(output) {
  const raw = String(output ?? '').trim()
  if (!raw) return []
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(item => item && typeof item === 'object' && item.content).slice(0, 10)
  } catch {
    return []
  }
}

export const memoryMethods = {

  // 按需展开一条被截断的上下文：m_/c_/run_ 短 id 或任务编号 KEY-N。
  recall(sessionId, ref) {
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw forbidden('当前会话不属于任何项目')
    const raw = String(ref ?? '').trim()
    if (!raw) throw badRequest('缺少要展开的引用 id')
    if (!binding.project_id) {
      // 单聊会话：没有项目上下文，只能展开本会话的消息引用。
      if (!raw.startsWith('m_')) throw notFound('单聊会话中只支持展开 m_ 消息引用')
      const message = this.store.get(
        'SELECT * FROM solo_messages WHERE bot_id = ? AND substr(id, -6) = ?',
        binding.bot_id, raw.slice(2),
      )
      if (!message) throw notFound('消息不存在')
      return `[${raw}] ${message.sender_type}:${message.sender_id} at ${message.created_at}\n\n${message.body}`
    }
    const project = this.projectRow(binding.project_id)

    if (raw.startsWith('m_')) {
      const message = this.store.get(
        'SELECT * FROM messages WHERE project_id = ? AND substr(id, -6) = ?',
        project.id, raw.slice(2),
      )
      if (!message) throw notFound('消息不存在')
      return `[${raw}] ${message.sender_type}:${message.sender_id} at ${message.created_at}\n\n${message.body}`
    }
    if (raw.startsWith('c_')) {
      const comment = this.store.get(
        `SELECT tc.*, t.number FROM task_comments tc JOIN tasks t ON t.id = tc.task_id
         WHERE t.project_id = ? AND substr(tc.id, -6) = ?`,
        project.id, raw.slice(2),
      )
      if (!comment) throw notFound('评论不存在')
      return `[${raw}] ${project.key}-${comment.number} ${comment.author_type}:${comment.author_id} at ${comment.created_at}\n\n${comment.body}`
    }
    if (raw.startsWith('run_')) {
      const run = this.store.get(
        'SELECT * FROM runs WHERE project_id = ? AND substr(id, -6) = ?',
        project.id, raw.slice(4),
      )
      if (!run) throw notFound('运行不存在')
      return [
        `[${raw}] kind=${run.kind} status=${run.status} bot=${run.bot_id}`,
        run.error_code ? `error=${run.error_code}: ${run.error_message}` : '',
        '',
        run.output ?? '(no output)',
      ].filter(Boolean).join('\n')
    }
    const task = this.resolveBotTask(project, raw)
    const comments = this.store.all(
      'SELECT author_type, author_id, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 10',
      task.id,
    ).reverse()
    return [
      `${project.key}-${task.number} [${task.status}] ${task.title}`,
      `assignee: ${task.assignee_bot_id ?? 'unassigned'} | priority: ${task.priority} | review: ${task.review_target}`,
      '',
      task.description || '(no description)',
      comments.length === 0 ? '' : `\nComments:\n${comments.map(item => `- ${item.author_type}:${item.author_id} (${item.created_at}): ${item.body}`).join('\n')}`,
    ].filter(Boolean).join('\n')
  },
  learnFromTask(project, bot, task, output, runId) {
    if (!output || output.trim().length < 40) return
    // 自动沉淀按篇幅预算截断，保证落库单条 ≤ MEMORY_MAX_CHARS 字。
    const content = maskSecrets(redactSecrets(`${task.title}：${output.trim().slice(0, 900)}`), this.secretEntries()).slice(0, MEMORY_MAX_CHARS)
    const source = `run:${runId}`
    const existing = this.store.get("SELECT id FROM memories WHERE source = ? AND scope_type = 'bot' AND scope_id = ?", source, bot.id)
    if (existing) return
    // 自动沉淀是尽力而为：触顶（或任何写入失败）只 warn 丢弃，不得炸任务交付 run。
    const settle = (scopeType, scopeId, topic, confidence) => {
      try {
        this.createMemory({
          scopeType,
          scopeId,
          topic,
          content,
          source,
          confidence,
          createdBy: `bot:${bot.id}`,
          actor: { type: 'bot', id: bot.id },
        })
      } catch (error: any) {
        this.logger.warn?.('dsh-team: 任务记忆沉淀被拒（%s/%s）：%s', scopeType, scopeId, error?.message ?? error)
      }
    }
    settle('bot', bot.id, `任务 ${project.key}-${task.number}`, 0.7)
    if (project.owner_bot_id === bot.id) {
      settle('project', project.id, `${project.key}-${task.number} 交付记录`, 0.6)
    }
  },

  // 记忆审查：任务交付后由模型抽取可复用事实，置信度不足的进入待审队列。
  memoryReviewEnabled() {
    if (this.config.memoryReview === false) return false
    return this.store.setting('memory_review', '1') !== '0'
  },

  // 群聊回复的记忆审查独立开关：闲聊占比高，默认开但可单关。
  chatMemoryReviewEnabled() {
    return this.memoryReviewEnabled() && this.store.setting('chat_memory_review', '1') !== '0'
  },
  enqueueMemoryReview(project, bot, task, sourceRunId) {
    if (!this.memoryReviewEnabled()) return null
    const active = this.store.get(
      "SELECT id FROM runs WHERE kind = 'memory_review' AND trigger_ref = ? AND status IN ('queued', 'running')",
      sourceRunId,
    )
    if (active) return active.id
    // 审查模型覆盖：配置了专用模型对时随运行下发（runs.model_* 三列既有通道，
    // startRun 的 modelOverrideFor 消费）；未配置为 NULL，沿用 Bot 主模型。
    const target = memoryReviewModelTarget(this.config)
    // DSHBOTS-358：记忆审查属内部运行，同样接额度路由——主 provider 耗尽时走备用模型；
    // 主备都耗尽则不带模型覆盖，留 queued 等恢复（调度器额度闸门兜底）。
    // 专用审查模型配在别的 provider 且该 provider 未耗尽时，专用模型优先。
    const routing = this.quotaRoutingForBot(bot)
    let reviewProvider = target?.provider ?? null
    let reviewModel = target?.model ?? null
    let reviewEffort = null
    if (routing.mode === 'fallback') {
      reviewProvider = routing.provider
      reviewModel = routing.model
      reviewEffort = routing.effort ?? null
    } else if (routing.mode === 'wait') {
      const dedicated = target ? this.botQuotaState(bot.id, target.provider) : null
      if (!target || dedicated?.exhausted) {
        reviewProvider = null
        reviewModel = null
      }
    }
    const reviewRunId = id('run')
    const createdAt = nowIso()
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, model_provider, model_model, model_effort, queued_at)
       VALUES (?, ?, ?, NULL, 'memory_review', 'read', 'memory_review', ?, 'queued', 1, ?, ?, ?, ?, ?)`,
      reviewRunId, project.id, bot.id, sourceRunId, `memory_review:${sourceRunId}`,
      reviewProvider, reviewModel, reviewEffort, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), reviewRunId, 'queued', '任务交付完成，触发记忆审查', createdAt,
    )
    void this.tick()
    return reviewRunId
  },
  async completeMemoryReview(reviewRun, output, error) {
    const sourceRunId = reviewRun.trigger_ref
    const sourceRun = sourceRunId ? this.store.get('SELECT * FROM runs WHERE id = ?', sourceRunId) : null
    const items = error ? [] : parseMemoryReview(output)
    if (!items.length) {
      // 审查失败或模型没给出可用结论时，回退到规则沉淀，保证任务交付不会颗粒无收。
      if (sourceRun?.task_id) {
        this.store.run(
          'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
          id('evt'), reviewRun.id, 'review_fallback', `记忆审查未产出可用结论，回退规则沉淀：${error?.message ?? '无有效条目'}`, nowIso(),
        )
        const project = this.projectRow(reviewRun.project_id)
        const bot = this.botRow(reviewRun.bot_id)
        const task = this.taskRow(sourceRun.task_id)
        this.learnFromTask(project, bot, task, sourceRun.output ?? '', sourceRun.id)
      }
      return { applied: 0 }
    }
    const project = this.projectRow(reviewRun.project_id)
    const bot = this.botRow(reviewRun.bot_id)
    const source = `run:${sourceRunId}`
    let applied = 0
    let deduped = 0
    // 同一次审查里重复的条目、以及同一来源重复触发的审查，写入前都按来源+内容去重。
    const seen = new Set()
    for (const item of items) {
      const scopeType = ['bot', 'project', 'team'].includes(item.scope) ? item.scope : 'bot'
      const scopeId = scopeType === 'bot' ? bot.id : scopeType === 'project' ? project.id : 'team'
      // 审查产出同样按篇幅预算截断，避免超长条目被写入咽喉拒绝而整条丢失。
      const content = maskSecrets(redactSecrets(text(item.content, 8000)), this.secretEntries()).slice(0, MEMORY_MAX_CHARS)
      if (!content) continue
      const dedupeKey = `${scopeType}|${scopeId}|${source}|${content}`
      if (seen.has(dedupeKey)) {
        deduped += 1
        continue
      }
      seen.add(dedupeKey)
      const exists = this.store.get(
        'SELECT id FROM memories WHERE scope_type = ? AND scope_id = ? AND source = ? AND content = ?',
        scopeType, scopeId, source, content,
      )
      if (exists) {
        deduped += 1
        continue
      }
      const confidence = Math.min(1, Math.max(0, Number(item.confidence) || 0.5))
      try {
        this.createMemory({
          scopeType,
          scopeId,
          topic: text(item.topic, 120) || `任务 ${project.key} 记忆`,
          content,
          source,
          confidence,
          createdBy: `bot:${bot.id}`,
          actor: { type: 'bot', id: bot.id },
          status: confidence >= 0.8 ? 'active' : 'pending',
          sourceRefs: sourceRunId ? [sourceRunId] : [],
        })
        applied += 1
      } catch (writeError: any) {
        this.logger.warn?.('dsh-team: 记忆审查写入失败：%s', writeError?.message ?? writeError)
      }
    }
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), reviewRun.id, 'reviewed', `记忆审查完成，写入 ${applied} 条${deduped ? `，去重 ${deduped} 条` : ''}`, nowIso(),
    )
    return { applied, deduped }
  },

  // 记忆写入权限：用户可写任意作用域；Bot 只能写自己的记忆、是成员的项目记忆，
  // 团队级记忆仅团队总监（任一项目 owner Bot）可写。
  assertMemoryWriteScope(scopeType, scopeId, actor) {
    if (actor?.type === 'user') return
    if (actor?.type !== 'bot') throw forbidden('当前身份不能写入记忆')
    if (scopeType === 'bot') {
      if (actor.id === scopeId) return
      throw forbidden('Bot 只能写入自己的记忆')
    }
    if (scopeType === 'project') {
      const project = this.projectRow(scopeId)
      if (project.owner_bot_id === actor.id) return
      if (this.membersOf(project.id).some(member => member.id === actor.id)) return
      throw forbidden('Bot 不是该项目成员，不能写入项目记忆')
    }
    if (scopeType === 'team') {
      if (this.isTeamOwner(actor.id)) return
      throw forbidden('仅团队总监可以写入团队级记忆')
    }
    throw badRequest('记忆作用域无效')
  },
  isTeamOwner(botId) {
    const row = this.store.get("SELECT id FROM projects WHERE owner_bot_id = ? LIMIT 1", botId)
    return Boolean(row)
  },

  // ── 记忆上限治理（DSHBOTS-339）──
  // bot/project 作用域 active 行硬顶 MEMORY_CAP；触顶后新增被拒并置滞回标志
  // memory_full:<scope_type>:<scope_id>，整理到 MEMORY_COMPACT_TO 条以内才清标志放行。
  // team 作用域不参与计数。计数走 memories_scope_idx(scope_type, scope_id, status)。
  memoryActiveCount(scopeType, scopeId) {
    return Number(this.store.get(
      'SELECT COUNT(*) AS count FROM memories WHERE scope_type = ? AND scope_id = ? AND status = ?',
      scopeType, scopeId, 'active',
    )?.count ?? 0)
  },
  memoryCapacityMessage(scopeType, scopeId, count, latched = false) {
    const label = scopeType === 'bot' ? `Bot(${scopeId})` : `项目(${scopeId})`
    // 锁定带（滞回标志在、34–63 条）：如实说明此前触顶、现处整理锁定期，不得谎称「已达 N/64」。
    if (latched) {
      return `${label}记忆此前触顶 ${MEMORY_CAP} 条上限，现处整理锁定期（当前 ${count} 条），新增被拒绝；需整理到 ≤${MEMORY_COMPACT_TO} 条恢复新增：去废弃（team_memory_cleanup 清理已闭环任务或过时主题）、去冗与融合（同主题 team_memory_write 覆盖写、合并相近条目）；同主题覆盖写不受影响。`
    }
    return `${label}记忆已达 ${count}/${MEMORY_CAP} 条上限，新增被拒绝；请先去废弃（team_memory_cleanup 清理已闭环任务或过时主题）、去冗（同主题用 team_memory_write 覆盖写）、融合（合并相近条目），整理到 ≤${MEMORY_COMPACT_TO} 条后再新增。`
  },
  assertMemoryCapacity(scopeType, scopeId) {
    if (scopeType !== 'bot' && scopeType !== 'project') return
    const count = this.memoryActiveCount(scopeType, scopeId)
    const flagKey = `memory_full:${scopeType}:${scopeId}`
    if (count >= MEMORY_CAP) {
      this.store.setSetting(flagKey, '1')
      throw conflict(this.memoryCapacityMessage(scopeType, scopeId, count))
    }
    if (this.store.setting(flagKey) === null) return
    if (count > MEMORY_COMPACT_TO) throw conflict(this.memoryCapacityMessage(scopeType, scopeId, count, true))
    this.store.run('DELETE FROM settings WHERE key = ?', flagKey)
  },

  // 项目再开容量闸（DSHBOTS-342）：归档把 active+pending 一并冻为 frozen，再开统一解回 active，
  // 冻结条数若已超 MEMORY_CAP，解回即破顶。此时整笔再开拒绝（项目保持归档），
  // 先按 memoryCapacityMessage 指引整理（归档态可逐条 deleteMemory）再重开。
  assertProjectReopenCapacity(scopeId, wouldBeActive) {
    if (wouldBeActive <= MEMORY_CAP) return
    throw conflict(this.memoryCapacityMessage('project', scopeId, wouldBeActive))
  },

  // 单条记忆篇幅上限：content 超过 MEMORY_MAX_CHARS 字即拒绝，防止单条挤占召回预算。
  assertMemoryLength(content) {
    if (content.length > MEMORY_MAX_CHARS) {
      throw badRequest(`记忆内容不能超过 ${MEMORY_MAX_CHARS} 字（当前 ${content.length} 字），请精简后重试`)
    }
  },

  createMemory({ scopeType, scopeId, topic, content, source = '', confidence = 1, createdBy = 'system', actor = null, status = 'active', sourceRefs = [] }) {
    const cleanScope = ['bot', 'project', 'team'].includes(scopeType) ? scopeType : null
    if (!cleanScope) throw badRequest('记忆作用域无效')
    const cleanContent = redactSecrets(text(content, 8000))
    if (!cleanContent) throw badRequest('记忆内容不能为空')
    this.assertMemoryLength(cleanContent)
    const writeActor = actor ?? { type: createdBy.split(':')[0] || 'system', id: createdBy.split(':').slice(1).join(':') || 'system' }
    this.assertMemoryWriteScope(cleanScope, scopeId, writeActor)
    if (cleanScope === 'bot') {
      const bot = this.botRow(scopeId)
      if (bot.status !== 'active') throw conflict('Bot 已归档，不能写入记忆')
    }
    if (cleanScope === 'project') {
      const project = this.projectRow(scopeId)
      if (project.status !== 'active') throw conflict('项目已归档，记忆已冻结')
    }
    this.assertMemoryCapacity(cleanScope, scopeId)
    const memoryId = id('mem')
    const createdAt = nowIso()
    const cleanStatus = status === 'pending' ? 'pending' : 'active'
    const refs = JSON.stringify(Array.isArray(sourceRefs) ? sourceRefs.slice(0, 50) : [])
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO memories(id, scope_type, scope_id, topic, content, source, confidence, status, created_by, created_at, updated_at,
          approved_by, revision, summary, source_refs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        memoryId, cleanScope, scopeId, text(topic, 120) || '未命名记忆', cleanContent, text(source, 500),
        Math.min(1, Math.max(0, Number(confidence) || 0)), cleanStatus, createdBy, createdAt, createdAt,
        cleanStatus === 'active' ? `${writeActor.type}:${writeActor.id}` : null,
        text(cleanContent, 300), refs,
      )
      this.store.run(
        'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        id('mevt'), memoryId, 'created', writeActor.type, writeActor.id, cleanContent, createdAt,
      )
      this.audit(writeActor, 'memory.create', 'memory', memoryId, { scopeType: cleanScope, scopeId, status: cleanStatus })
    })
    this.writeMemoryMirror(memoryId)
    return this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
  },

  // 待审记忆的审批与驳回。
  async approveMemory(memoryId, actor = this.actor()) {
    const memory = this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
    if (!memory) throw notFound('记忆不存在')
    if (memory.status !== 'pending') throw conflict('只有待审记忆可以批准')
    // 审批会把 pending 提成 active，同样受上限约束：active 已满时拒绝。
    this.assertMemoryCapacity(memory.scope_type, memory.scope_id)
    const now = nowIso()
    this.store.run(
      "UPDATE memories SET status = 'active', approved_by = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      `${actor.type}:${actor.id}`, now, memoryId,
    )
    this.store.run(
      'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id('mevt'), memoryId, 'approved', actor.type, actor.id, memory.content, memory.content, now,
    )
    this.audit(actor, 'memory.approve', 'memory', memoryId, {})
    this.writeMemoryMirror(memoryId)
    return this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
  },
  async rejectMemory(memoryId, actor = this.actor()) {
    const memory = this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
    if (!memory) throw notFound('记忆不存在')
    if (memory.status !== 'pending') throw conflict('只有待审记忆可以驳回')
    const now = nowIso()
    this.store.run(
      "UPDATE memories SET status = 'rejected', approved_by = ?, updated_at = ? WHERE id = ?",
      `${actor.type}:${actor.id}`, now, memoryId,
    )
    this.store.run(
      'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      id('mevt'), memoryId, 'rejected', actor.type, actor.id, memory.content, now,
    )
    this.audit(actor, 'memory.reject', 'memory', memoryId, {})
    return this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
  },

  // 记忆检索：项目/成员 Bot/团队三级作用域，优先走 FTS5 全文索引，索引不可用时回退 LIKE。
  searchMemories({ projectId = null, botId = null, query = '', limit = 20 } = {}) {
    const scopes = []
    if (projectId) {
      const project = this.projectRow(projectId)
      scopes.push({ type: 'project', id: project.id })
      for (const member of this.membersOf(project.id)) scopes.push({ type: 'bot', id: member.id })
      scopes.push({ type: 'team', id: 'team' })
    } else if (botId) {
      scopes.push({ type: 'bot', id: botId })
    } else {
      scopes.push({ type: 'team', id: 'team' })
    }
    const clause = scopes.map(() => '(m.scope_type = ? AND m.scope_id = ?)').join(' OR ')
    const params = scopes.flatMap(scope => [scope.type, scope.id])
    const keyword = text(query, 200).trim()
    const limitN = Math.min(100, Math.max(1, Number(limit) || 20))
    let rows
    if (keyword && this.store.ftsEnabled) {
      const match = `"${keyword.replace(/"/g, '""')}"`
      rows = this.store.all(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.memory_id
         WHERE memories_fts MATCH ? AND m.status = 'active' AND (${clause})
         ORDER BY m.updated_at DESC LIMIT ?`,
        match, ...params, limitN,
      )
    } else {
      const like = `%${keyword}%`
      rows = this.store.all(
        `SELECT m.* FROM memories m
         WHERE m.status = 'active' AND (${clause})
           ${keyword ? 'AND (m.topic LIKE ? OR m.content LIKE ?)' : ''}
         ORDER BY m.updated_at DESC LIMIT ?`,
        ...params, ...(keyword ? [like, like] : []), limitN,
      )
    }
    return rows.map(row => this.memoryView(row))
  },
  memoryView(memory) {
    return {
      ...memory,
      sourceRefs: jsonParse(memory.source_refs_json, []),
      scopeLabel: memory.scope_type === 'team'
        ? '团队'
        : memory.scope_type === 'project'
          ? (this.store.get('SELECT name FROM projects WHERE id = ?', memory.scope_id)?.name ?? memory.scope_id)
          : (this.store.get('SELECT name FROM bots WHERE id = ?', memory.scope_id)?.name ?? memory.scope_id),
    }
  },
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
    this.store.run('UPDATE memories SET path = ? WHERE id = ?', path, memoryId)
  },
  async updateMemory(memoryId, patch) {
    const memory = this.store.get('SELECT * FROM memories WHERE id = ?', memoryId)
    if (!memory) throw notFound('记忆不存在')
    // 篇幅闸只约束本次实际变更的 content：存量超长条目仅改 topic 时不得被误拦（DSHBOTS-342）。
    const contentChanged = patch.content != null
    const content = contentChanged ? redactSecrets(text(patch.content, 8000)) : memory.content
    if (contentChanged) this.assertMemoryLength(content)
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
  },
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
  },
  rememberFromBot(sessionId, input) {
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw forbidden('只有项目群中的 Bot 可以写记忆')
    const scopeType = ['bot', 'project', 'team'].includes(input.scope) ? input.scope : 'bot'
    if (scopeType === 'project' && !binding.project_id) throw badRequest('单聊会话不在项目中，只能写 bot 或 team 记忆')
    const scopeId = scopeType === 'project' ? binding.project_id : scopeType === 'team' ? 'team' : binding.bot_id
    return this.createMemory({
      scopeType,
      scopeId,
      topic: input.topic,
      content: input.content,
      source: `session:${sessionId}`,
      confidence: 0.9,
      createdBy: `bot:${binding.bot_id}`,
      actor: { type: 'bot', id: binding.bot_id },
    })
  },

  // ── 总监记忆管理（DSHBOTS-239）：list / 同名覆盖写 / 批量清理 ──
  // 三入口共用 ownerContextFor 权威鉴权（仅项目总监，单聊/成员拒绝）；
  // 不改宿主 team_remember 语义，插件层独立封装。

  // 把 scope 枚举解析到总监会话所在的具体作用域：bot=总监自己，project=会话项目，team=全团队。
  resolveOwnerMemoryScope(ownerCtx, scope) {
    const scopeType = ['bot', 'project', 'team'].includes(scope) ? scope : null
    if (!scopeType) throw badRequest('记忆作用域无效')
    const scopeId = scopeType === 'bot' ? ownerCtx.binding.bot_id : scopeType === 'project' ? ownerCtx.project.id : 'team'
    return { scopeType, scopeId }
  },

  memoryListFromBot(sessionId, input: { scope?: string, topic?: string, limit?: number } = {}) {
    const ownerCtx = this.ownerContextFor(sessionId)
    const { scopeType, scopeId } = this.resolveOwnerMemoryScope(ownerCtx, input.scope ?? 'project')
    const keyword = text(input.topic, 200).trim()
    const limitN = Math.min(200, Math.max(1, Number(input.limit) || 50))
    const like = `%${keyword}%`
    const rows = this.store.all(
      `SELECT * FROM memories
        WHERE scope_type = ? AND scope_id = ? AND status = 'active'
          ${keyword ? 'AND topic LIKE ?' : ''}
        ORDER BY updated_at DESC LIMIT ?`,
      scopeType, scopeId, ...(keyword ? [like] : []), limitN,
    )
    return rows.map(row => this.memoryView(row))
  },

  // 写入/同名覆盖：同 scope+topic 已有 active 记忆时原地更新（revision+1、事件留痕），
  // 不再叠新条；无同名时走 createMemory 正常创建。
  memoryWriteFromBot(sessionId, input) {
    const ownerCtx = this.ownerContextFor(sessionId)
    const { scopeType, scopeId } = this.resolveOwnerMemoryScope(ownerCtx, input.scope)
    const actor = ownerCtx.actor
    const topic = text(input.topic, 120)
    if (!topic) throw badRequest('缺少记忆主题')
    const existing = this.store.get(
      "SELECT * FROM memories WHERE scope_type = ? AND scope_id = ? AND topic = ? AND status = 'active'",
      scopeType, scopeId, topic,
    )
    if (!existing) {
      const memory = this.createMemory({
        scopeType,
        scopeId,
        topic,
        content: input.content,
        source: `session:${sessionId}`,
        confidence: 0.9,
        createdBy: `bot:${actor.id}`,
        actor,
      })
      return { memory: this.memoryView(memory), overwritten: false }
    }
    const content = redactSecrets(text(input.content, 8000))
    if (!content) throw badRequest('记忆内容不能为空')
    this.assertMemoryLength(content)
    const now = nowIso()
    this.store.run(
      'UPDATE memories SET content = ?, source = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      content, `session:${sessionId}`, now, existing.id,
    )
    this.store.run(
      'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id('mevt'), existing.id, 'updated', actor.type, actor.id, existing.content, content, now,
    )
    this.audit(actor, 'memory.overwrite', 'memory', existing.id, { scopeType, scopeId, topic })
    this.writeMemoryMirror(existing.id)
    return { memory: this.memoryView(this.store.get('SELECT * FROM memories WHERE id = ?', existing.id)), overwritten: true }
  },

  // 批量清理：按过期口径把 active 记忆终态化（archived，检索即不再回灌）。
  // 口径：task=已闭环卡（done/canceled）的过程记录主题，topics=点名主题，
  // before=updated_at 严格早于该 ISO 时间戳的全部 active 条目（存量收敛的批量判据）。
  // before 与 topics/task 可组合，按 AND 交集收窄；三者全缺即拒绝（不做「全清」缺省）。
  // 逐条 memory_events 留痕 + 一笔 memory.cleanup 审计列出被清条目。
  memoryCleanupFromBot(sessionId, input) {
    const ownerCtx = this.ownerContextFor(sessionId)
    const { project, actor } = ownerCtx
    const { scopeType, scopeId } = this.resolveOwnerMemoryScope(ownerCtx, input.scope)
    const topics = (Array.isArray(input.topics) ? input.topics : []).map(item => text(item, 120)).filter(Boolean)
    let taskLabel = null
    let taskTopics: string[] = []
    if (input.task) {
      const task = this.resolveBotTask(project, input.task)
      if (!['done', 'canceled'].includes(task.status)) {
        throw badRequest(`仅已闭环（done/canceled）任务的历史记录可清理，${project.key}-${task.number} 当前为 ${task.status}`)
      }
      taskLabel = `${project.key}-${task.number}`
      // learnFromTask 的两类过程记录主题形态：任务 KEY-N（bot 域）/ KEY-N 交付记录（项目域）。
      taskTopics = [`任务 ${taskLabel}`, `${taskLabel} 交付记录`]
    }
    const wanted = [...new Set([...topics, ...taskTopics])]
    let before = null
    if (input.before !== undefined && input.before !== null) {
      before = String(input.before).trim()
      if (!Number.isFinite(Date.parse(before))) {
        throw badRequest('before 必须是有效的 ISO 时间戳（例如 2026-01-01T00:00:00.000Z）')
      }
    }
    if (!wanted.length && !before) throw badRequest('cleanup 需要 topics、task 或 before 至少一项')
    const clauses = ['scope_type = ?', 'scope_id = ?', "status = 'active'"]
    const params: string[] = [scopeType, scopeId]
    if (before) {
      // julianday 归一化时间戳格式，避免字符串比较把等值瞬间误判为「早于」。
      clauses.push('julianday(updated_at) < julianday(?)')
      params.push(before)
    }
    if (wanted.length) {
      clauses.push(`topic IN (${wanted.map(() => '?').join(', ')})`)
      params.push(...wanted)
    }
    const rows = this.store.all(`SELECT * FROM memories WHERE ${clauses.join(' AND ')}`, ...params)
    const now = nowIso()
    const cleaned: Array<{ id: string, topic: string }> = []
    this.store.transaction(() => {
      for (const row of rows) {
        this.store.run("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?", now, row.id)
        this.store.run(
          'INSERT INTO memory_events(id, memory_id, action, actor_type, actor_id, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
          id('mevt'), row.id, 'archived', actor.type, actor.id, row.content, now,
        )
        cleaned.push({ id: row.id, topic: row.topic })
      }
      this.audit(actor, 'memory.cleanup', 'memory', `${scopeType}:${scopeId}`, { scope: scopeType, task: taskLabel, before, cleaned })
    })
    return { cleaned, archived: cleaned.length, missed: wanted.filter(topic => !cleaned.some(item => item.topic === topic)) }
  },
}
