import { state } from './state.js'
import { toast } from './util.js'

export async function api(action, payload = {}, { quiet = false } = {}) {
  state.busy += 1
  try {
    const response = await fetch('/api/dsh-team/api', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    })
    let body
    try { body = await response.json() } catch { body = null }
    if (!response.ok || !body?.ok) {
      const message = body?.error?.message ?? (response.status === 401 || response.status === 403
        ? '登录状态已失效，请回到 DSH Web 登录后重新打开。'
        : '请求失败，请稍后重试。')
      throw new Error(message)
    }
    return body.data
  } catch (error) {
    if (!quiet) toast(error.message || String(error), 'error')
    throw error
  } finally {
    state.busy -= 1
  }
}

// IM 式已读：群聊可见时把水位推到最后一条消息，服务端据此算未读数。
// 只在群聊视图上报；切到任务/设置等 tab 不算数。
export async function markVisibleChatRead(data) {
  if (state.view !== 'chat' || state.chatMode === 'solo') return
  const projectId = state.projectId
  if (!projectId) return
  const messages = data?.messages ?? []
  let newest = ''
  for (const message of messages) {
    if (String(message.created_at ?? '') > newest) newest = String(message.created_at)
  }
  if (!newest) return
  const key = `${projectId}:${newest}`
  if (state.markedRead === key) return
  state.markedRead = key
  // 本地先清零，避免下一轮轮询前徽标还挂着。
  const target = data.projects?.find(item => item.id === projectId)
  if (target) target.unreadCount = 0
  try {
    await api('mark_chat_read', { projectId, readAt: newest }, { quiet: true })
  } catch {}
}

// 轮询竞态保护（DSHBOTS-102）：本地已决的审批不被早于决策的 pending 响应盖回。
// 根因是 2.8s 轮询的在途旧响应会在乐观回显之后到达，把 state.data 整体盖回 pending，
// 表现为点「允许一次」后卡片闪回。以本地 decided_at 为「已决」标记：同 id 的旧响应仍是
// pending 时保留本地终态；旧响应已是终态（如 timeout）则以服务端为准。
export function preserveDecidedApprovals(previous, next) {
  const decided = new Map()
  for (const item of previous?.approvals ?? []) {
    if (item?.id && item.decided_at) decided.set(item.id, item)
  }
  if (!decided.size || !next) return next
  if (Array.isArray(next.approvals)) {
    next.approvals = next.approvals.map(item => (item && decided.has(item.id) && !item.decided_at ? decided.get(item.id) : item))
  }
  const pending = next.pendingApprovals
  if (pending && Array.isArray(pending.items)) {
    const items = pending.items.filter(item => !(item && decided.has(item.id)))
    if (items.length !== pending.items.length) {
      next.pendingApprovals = { ...pending, items, count: Math.max(0, Number(pending.count ?? 0) - (pending.items.length - items.length)) }
    }
  }
  return next
}

export async function loadState(projectId = state.projectId, { quiet = false } = {}) {
  // 仅单聊场景携带 soloBotId，避免把单聊口径的 runs/memories 泄漏进群聊视图。
  const data = preserveDecidedApprovals(state.data, await api('state', { projectId: projectId || undefined, soloBotId: state.chatMode === 'solo' ? state.soloBotId : undefined }, { quiet }))
  state.data = data
  await markVisibleChatRead(data)
  if (!state.projectId || !data.projects.some(project => project.id === state.projectId)) {
    state.projectId = data.project?.id ?? data.projects.find(project => project.status === 'active')?.id ?? null
  }
  return data
}
