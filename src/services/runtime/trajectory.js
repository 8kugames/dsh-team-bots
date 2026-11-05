// src/services/runtime/trajectory.js —— 轨迹与掩码域
// 运行轨迹条目的构造、密钥脱敏与条目数上限。
// 本文件只放方法体，方法挂到 DshRuntime 原型上（见 src/runtime.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { id, nowIso } from '../../util.js'

export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

// 思考内容与可见文本分块存放，只取 reasoning 块即模型的推理/思考文本。
export function contentReasoning(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'reasoning' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

// 模型请求的工具调用块：id 与工具名用于把 tool/result 事件对回调用。
export function contentToolCalls(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter(block => block?.type === 'tool-call')
    .map(block => ({ id: block.id, name: block.name, arguments: block.arguments }))
}

export function reasonOf(event) {
  const reason = event?.data?.reason
  if (!reason || typeof reason !== 'object') return { kind: 'completed' }
  return reason
}

// 轨迹条目的正文上限与每次运行的条目上限：思考与工具输出可能极长，
// 展示侧只需要可读的一段，超出部分截断并保留条数上限。
export const TRAJECTORY_MAX_DETAIL = 4_000

export const TRAJECTORY_MAX_ENTRIES = 300

export const TRAJECTORY_END_LABELS = { completed: '完成', error: '失败', aborted: '中止' }

export function truncateDetail(value, limit = TRAJECTORY_MAX_DETAIL) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…（已截断）`
}

export const trajectoryMethods = {

  // 落库前的掩码：脱敏失败就不落原文，改为占位说明，避免把明文密钥写进轨迹。
  maskForStorage(value) {
    const raw = String(value ?? '')
    if (!raw || !this.mask) return raw
    try {
      return this.mask(raw)
    } catch (error     ) {
      this.logger.warn?.('dsh-team: 轨迹掩码失败，本次内容不落库：%s', error?.message ?? error)
      return '（密钥掩码失败，内容未记录）'
    }
  },

  // 把一次会话事件翻译成轨迹条目：回合边界、思考文本、助手文本、工具调用与工具结果。
  // 数据源与 DSH 客户端轨迹视图同源，都是宿主的 session 事件流。
  trajectoryEntries(pending, event, { root = true } = {}) {
    const type = event?.type
    const data = event?.data ?? {}
    if (type === 'turn/start') {
      return root ? [{ kind: 'turn', title: `第 ${data.turn ?? '?'} 轮开始`, detail: '' }] : []
    }
    if (type === 'turn/end') {
      if (!root) return []
      const reason = reasonOf(event)
      const label = TRAJECTORY_END_LABELS[reason.kind] ?? reason.kind
      return [{ kind: 'end', title: `运行结束（${label}）`, detail: reason.error?.message ?? '' }]
    }
    if (type === 'assistant/message') {
      const content = data.message?.content
      const entries = []
      const reasoning = contentReasoning(content)
      if (reasoning.trim()) entries.push({ kind: 'thinking', title: '思考', detail: reasoning })
      const text = contentText(content)
      if (text.trim()) entries.push({ kind: 'text', title: '回复', detail: text })
      for (const call of contentToolCalls(content)) {
        if (call.id && pending.recordedCalls.has(call.id)) continue
        if (call.id) pending.recordedCalls.add(call.id)
        if (call.id) pending.toolNames.set(call.id, call.name)
        entries.push({ kind: 'tool_call', title: `调用工具 ${call.name ?? '未知'}`, detail: call.arguments ?? '' })
      }
      return entries
    }
    if (type === 'tool/call') {
      const callId = data.callId ?? data.id
      if (callId && pending.recordedCalls.has(callId)) return []
      if (callId) {
        pending.recordedCalls.add(callId)
        pending.toolNames.set(callId, data.name)
      }
      return [{ kind: 'tool_call', title: `调用工具 ${data.name ?? '未知'}`, detail: data.arguments ?? '' }]
    }
    if (type === 'tool/result') {
      const callId = data.message?.toolCallId
      const name = callId ? pending.toolNames.get(callId) : undefined
      if (callId) pending.toolNames.delete(callId)
      const failed = data.message?.isError ? '（失败）' : ''
      const detail = [contentText(data.message?.content), data.error?.reason ?? ''].filter(Boolean).join('\n')
      return [{ kind: 'tool_result', title: `工具 ${name ?? '未知'} 返回${failed}`, detail }]
    }
    return []
  },
  recordTrajectory(pending, event, options = {}) {
    // 轨迹记账状态挂在 pending 上；外部构造的 pending 也要能安全记账。
    if (!pending.recordedCalls) pending.recordedCalls = new Set()
    if (!pending.toolNames) pending.toolNames = new Map()
    const entries = this.trajectoryEntries(pending, event, options)
    if (!entries.length) return
    const createdAt = Number.isFinite(event?.time) ? new Date(event.time).toISOString() : nowIso()
    for (const entry of entries) {
      if ((pending.trajectoryCount ?? 0) >= TRAJECTORY_MAX_ENTRIES) return
      pending.trajectoryCount = (pending.trajectoryCount ?? 0) + 1
      pending.trajectorySeq = (pending.trajectorySeq ?? 0) + 1
      this.store.run(
        'INSERT INTO run_trajectory(id, run_id, seq, kind, title, detail, turn, step, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id('traj'), pending.runId, pending.trajectorySeq, entry.kind, entry.title,
        truncateDetail(this.maskForStorage(entry.detail)),
        event?.data?.turn ?? null, event?.data?.step ?? null, createdAt,
      )
    }
  },
}
