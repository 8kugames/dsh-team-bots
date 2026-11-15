// DSHBOTS-294 子代理账本（ADR §4.2.1）：宿主事件缝 → 所属 task 运行的 run_events。
// 双缝互补：tools 瀑布带 caller agent（父归属权威源，任务号标签在参数里）；
// subagent/start|end 带 stopReason+lastAssistantMessage（终态摘要源，载荷无父身份，
// 靠 tools/result 配对或唯一 running task 运行兜底归属）。子代理不占 runs 行（§4.2）。
import { id, nowIso } from './util.js'

const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork'])
const SUMMARY_LIMIT = 400
const STASH_LIMIT = 64

// 任务号标签（DSHBOTS-292 约定标签=任务号，如 DSHBOTS-294）：优先 description，其次 prompt。
export function taskLabelOf(args) {
  const source = typeof args?.description === 'string' ? args.description
    : typeof args?.prompt === 'string' ? args.prompt : ''
  const match = source.match(/\b[A-Z][A-Z0-9]{1,10}-\d{1,6}\b/)
  if (match) return match[0]
  const trimmed = source.trim()
  return trimmed ? trimmed.slice(0, 60) : null
}

const truncate = (text) => {
  const value = typeof text === 'string' ? text : text == null ? '' : JSON.stringify(text)
  return value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT)}…` : value
}

// 在插件根 ctx 注册事件监听（根级注册面实测见 tests/subagent-ledger.test.ts）。
export function installSubagentLedger(ctx, store, logger) {
  // callId → 派发时快照（tools/result 按 callId 配对父归属）
  const byCall = new Map()
  // botId → 未消费的标签栈（subagent/end 兜底归属时取最近一次派发的标签）
  const labelsByBot = new Map()
  // 暂存 subagent/end 载荷：childId → info，tools/result 到达时按 id 出现在结果 JSON 里配对
  const endsByChild = new Map()

  // DSHBOTS-353 落账放宽：owner bot 的派单账优先记 kind='task' running（D-294 施工账语义），
  // 无施工运行时回退该 bot 任意 kind 的 running 运行（review/chat）——总监验收链的核验
  // 子代理（review_delegate 运行）此前永远查不中而不落账。域串行（D-308 one_active_run_per_bot）
  // 保证该 bot 当前 running 即派单所在运行。
  const ownerRunOf = (agentSessionId) => {
    const binding = agentSessionId
      ? store.get('SELECT * FROM session_bindings WHERE session_id = ?', agentSessionId)
      : undefined
    if (!binding?.bot_id) return null
    const run = store.get(
      "SELECT id FROM runs WHERE bot_id = ? AND kind = 'task' AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      binding.bot_id,
    ) ?? store.get(
      "SELECT id FROM runs WHERE bot_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      binding.bot_id,
    )
    return run ? { botId: binding.bot_id, runId: run.id } : null
  }

  const record = (runId, type, message) => store.run(
    'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
    id('rev'), runId, type, message, nowIso(),
  )

  const stashLabel = (botId, label) => {
    const list = labelsByBot.get(botId) ?? []
    list.push(label)
    if (list.length > STASH_LIMIT) list.shift()
    labelsByBot.set(botId, list)
  }

  const takeLabel = (botId) => {
    const list = labelsByBot.get(botId)
    const label = list?.shift()
    if (list && list.length === 0) labelsByBot.delete(botId)
    return label ?? null
  }

  const endsAt = (childId, info) => {
    if (endsByChild.size >= STASH_LIMIT) endsByChild.delete(endsByChild.keys().next().value)
    endsByChild.set(childId, info)
  }

  // subagent/end 的兜底归属：事件时刻全库恰好一个 bot 有 running task 运行、且该 bot
  // 无待配对的工具瀑布调用（tools/result 会按 callId 精确落账，优先于兜底）才落账。
  const soleRunningTaskRun = () => {
    const rows = store.all("SELECT bot_id, id FROM runs WHERE kind = 'task' AND status = 'running'")
    return rows.length === 1 ? rows[0] : null
  }

  const resultSummary = (result) => {
    if (result == null) return '-'
    if (typeof result === 'string') return truncate(result)
    const parts = []
    for (const key of ['stopReason', 'status', 'error', 'code', 'message']) {
      if (result[key] != null) parts.push(`${key}=${truncate(String(result[key]))}`)
    }
    return parts.length > 0 ? parts.join(' ') : truncate(result)
  }

  const offs = []
  const on = (name, listener) => {
    const off = ctx.on?.(name, listener)
    if (off) offs.push(off)
    return off
  }

  on('tools/pre-execute', async (exec, next) => {
    try {
      if (SUBAGENT_TOOLS.has(exec?.name)) {
        const owner = ownerRunOf(exec?.agent?.session?.id)
        if (owner) {
          const label = taskLabelOf(exec?.arguments)
          record(owner.runId, 'subagent_spawned', `${exec.name} label=${label ?? '-'} bot=${owner.botId}`)
          byCall.set(exec.callId, { ...owner, label })
          stashLabel(owner.botId, label)
        }
      }
    } catch (error) {
      logger?.warn?.('dsh-team: subagent ledger pre-execute: %s', (error as { message?: string })?.message ?? error)
    }
    return next()
  })

  on('subagent/start', (info) => {
    try {
      if (info?.id) endsAt(info.id, { started: true })
    } catch {}
  })

  on('subagent/end', (info) => {
    try {
      if (!info?.id) return
      endsAt(info.id, info)
      const sole = soleRunningTaskRun()
      const pendingCall = sole ? [...byCall.values()].some(entry => entry.botId === sole.bot_id) : false
      if (!sole || pendingCall) return
      endsByChild.delete(info.id)
      const label = takeLabel(sole.bot_id)
      record(sole.id, 'subagent_result',
        `label=${label ?? '-'} stop=${info.stopReason ?? '-'} summary=${truncate(info.lastAssistantMessage ?? '')}`)
    } catch (error) {
      logger?.warn?.('dsh-team: subagent ledger end: %s', (error as { message?: string })?.message ?? error)
    }
  })

  on('tools/result', (exec, result) => {
    try {
      if (!SUBAGENT_TOOLS.has(exec?.name)) return
      const entry = byCall.get(exec?.callId)
      if (!entry) return
      byCall.delete(exec?.callId)
      // 配对暂存的 subagent/end：child id 出现在结果 JSON 里即认领其终态摘要
      let matched = null
      const haystack = JSON.stringify(result ?? {})
      for (const [childId, info] of endsByChild) {
        if (haystack.includes(childId)) {
          matched = info
          endsByChild.delete(childId)
          break
        }
      }
      const stop = matched?.stopReason
      const summary = matched?.lastAssistantMessage ?? resultSummary(result?.value ?? result)
      record(entry.runId, 'subagent_result',
        `label=${entry.label ?? '-'} stop=${stop ?? '-'} summary=${truncate(summary ?? '')}`)
    } catch (error) {
      logger?.warn?.('dsh-team: subagent ledger result: %s', (error as { message?: string })?.message ?? error)
    }
  })

  return () => {
    for (const off of offs) off()
    byCall.clear()
    labelsByBot.clear()
    endsByChild.clear()
  }
}
