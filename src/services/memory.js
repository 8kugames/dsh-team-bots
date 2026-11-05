// src/services/memory.js —— 记忆域
// 记忆写入与检索、记忆审查、记忆回灌与权限口径。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { maskSecrets } from '../secrets.js'
import { id, jsonParse, nowIso, redactSecrets, text, sanitizeFilename } from '../util.js'

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
    const content = maskSecrets(redactSecrets(`${task.title}：${output.trim().slice(0, 900)}`), this.secretEntries())
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
      actor: { type: 'bot', id: bot.id },
    })
    if (project.owner_bot_id === bot.id) {
      this.createMemory({
        scopeType: 'project',
        scopeId: project.id,
        topic: `${project.key}-${task.number} 交付记录`,
        content,
        source,
        confidence: 0.6,
        createdBy: `bot:${bot.id}`,
        actor: { type: 'bot', id: bot.id },
      })
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
    const reviewRunId = id('run')
    const createdAt = nowIso()
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, NULL, 'memory_review', 'read', 'memory_review', ?, 'queued', 1, ?, ?)`,
      reviewRunId, project.id, bot.id, sourceRunId, `memory_review:${sourceRunId}`, createdAt,
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
      const content = maskSecrets(redactSecrets(text(item.content, 8000)), this.secretEntries())
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
      } catch (writeError     ) {
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
  createMemory({ scopeType, scopeId, topic, content, source = '', confidence = 1, createdBy = 'system', actor = null, status = 'active', sourceRefs = [] }) {
    const cleanScope = ['bot', 'project', 'team'].includes(scopeType) ? scopeType : null
    if (!cleanScope) throw badRequest('记忆作用域无效')
    const cleanContent = redactSecrets(text(content, 8000))
    if (!cleanContent) throw badRequest('记忆内容不能为空')
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
}
