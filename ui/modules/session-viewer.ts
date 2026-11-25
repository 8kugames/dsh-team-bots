// ui/modules/session-viewer.ts —— 会话查看器（只读）：在团队工作台直接看插件托管会话的
// 对话内容（任务会话 / 控制面会话 / 审查会话），不必跳回宿主原生界面。
//
// 面板语义：两个弹窗——目录（session-catalog，绑定家谱 + 运行态）与查看器（session，
// 消息流 + 游标增量）。查看器在会话 running 时每 2.5s 轮询 afterSeq 增量；弹窗关闭或
// 切换即停。渲染复用 .traj-* 家族样式 + 少量 .sess-* 补充（styles/wide.css）。
import { state } from './state.js'
import { api } from './api.js'
import { t } from './i18n.js'
import { attr, esc, timeAgo, toast } from './util.js'
import { icon } from './icons.js'
import { openModal, closeModal } from './modal-forms.js'
import { modalShell, renderModalLayer } from './modal-layer.js'
import { panelAttrs } from '../app.js'

// 会话查看器轮询：单例定时器（同一时刻至多一个查看器在跟随）。
let sessionPollTimer = null
const SESSION_POLL_MS = 2_500

function stopSessionPoll() {
  if (sessionPollTimer) clearInterval(sessionPollTimer)
  sessionPollTimer = null
}

function lastSeqOf(modal) {
  const entries = modal?.entries
  return entries && entries.length > 0 ? Number(entries[entries.length - 1]?.seq ?? -1) : -1
}

function startSessionPoll(sessionId) {
  stopSessionPoll()
  sessionPollTimer = setInterval(async () => {
    const modal = state.modal
    // 弹窗已关闭或切到别的弹窗：停止跟随（下次打开重新起表）。
    if (!modal || modal.type !== 'session' || modal.sessionId !== sessionId) {
      stopSessionPoll()
      return
    }
    try {
      const data = await api('session_messages', { sessionId, afterSeq: lastSeqOf(modal) }, { quiet: true })
      const current = state.modal
      if (!current || current.type !== 'session' || current.sessionId !== sessionId) return
      if (Array.isArray(data?.entries) && data.entries.length > 0) {
        current.entries.push(...data.entries)
        current.hasMore = data.hasMore === true
        current.cursor = data.cursor
        renderModalLayer()
      }
      // 运行收尾：停表并定格终态标记（内容保留）。
      if (data?.running !== true) {
        current.running = false
        current.live = data.live === true
        stopSessionPoll()
        renderModalLayer()
      }
    } catch {
      // 网络抖动静默跳过；下一轮再试，连续失败不弹 toast（查看器是被动观察面）。
    }
  }, SESSION_POLL_MS)
}

// 查看器入口：sessionId 直达或 runId 归属解析（聊天流的运行 chip）。
export async function openSessionViewer({ sessionId = null, runId = null } = {}) {
  if (!sessionId && !runId) return
  stopSessionPoll()
  openModal({ type: 'session', loading: true, title: t('session.viewerTitle') })
  try {
    const data = await api('session_messages', { sessionId, runId }, { quiet: true })
    if (state.modal?.type !== 'session') return
    state.modal = { type: 'session', ...data }
    renderModalLayer()
    if (data?.running === true) startSessionPoll(data.sessionId)
  } catch (error: any) {
    closeModal()
    toast(error?.message || t('session.loadFailed'), 'error')
  }
}

// 目录入口：projectId 给定时只列该域（项目页 topbar），全局目录含 solo 会话。
export async function openSessionCatalog(projectId = null) {
  stopSessionPoll()
  openModal({ type: 'session-catalog', loading: true, title: t('session.catalogTitle') })
  try {
    const data = await api('session_catalog', { projectId }, { quiet: true })
    if (state.modal?.type !== 'session-catalog') return
    state.modal = { type: 'session-catalog', sessions: data?.sessions ?? [], projectId }
    renderModalLayer()
  } catch (error: any) {
    closeModal()
    toast(error?.message || t('session.loadFailed'), 'error')
  }
}

// 翻旧：把更早的一页前插到当前条目之前。
async function loadOlderSession() {
  const modal = state.modal
  if (modal?.type !== 'session' || !Array.isArray(modal.entries) || modal.entries.length === 0) return
  const beforeSeq = Number(modal.entries[0]?.seq ?? 0)
  if (!(beforeSeq > 0)) return
  try {
    const data = await api('session_messages', { sessionId: modal.sessionId, beforeSeq }, { quiet: true })
    const current = state.modal
    if (current?.type !== 'session' || current !== modal) return
    if (Array.isArray(data?.entries) && data.entries.length > 0) {
      current.entries = [...data.entries, ...current.entries]
    }
    current.hasOlder = data?.hasOlder === true
    renderModalLayer()
  } catch (error: any) {
    toast(error?.message || t('session.loadFailed'), 'error')
  }
}

export async function handleSessionAction(action, target) {
  switch (action) {
    case 'open-session':
      await openSessionViewer({ sessionId: target.dataset.sessionId ?? null, runId: target.dataset.runId ?? null })
      return true
    case 'open-session-catalog':
      await openSessionCatalog(state.projectId ?? null)
      return true
    case 'session-load-older':
      await loadOlderSession()
      return true
    default:
      return false
  }
}

// 绑定行 kind → 展示标签。kind='bot' 按域分控制面/单聊；review 是记忆审查会话。
export function sessionKindLabel(session) {
  if (session.kind === 'task') return t('session.kindTask')
  if (session.kind === 'review') return t('session.kindReview')
  return session.projectId ? t('session.kindControl') : t('session.kindSolo')
}

function runBadge(session) {
  if (session.running) return `<span class="pill amber">${t('session.running')}</span>`
  return ''
}

function sessionCatalogRow(session) {
  const label = sessionKindLabel(session)
  const task = session.taskIdentifier
    ? `<strong>${esc(session.taskIdentifier)}</strong> <span class="faint">${esc(session.taskTitle ?? '')}</span>`
    : ''
  const meta = [session.lastRunStatus, session.lastRunAt ? timeAgo(session.lastRunAt) : null]
    .filter(Boolean).map(item => esc(item)).join(' · ')
  return `<button type="button" class="session-catalog-row" data-action="open-session" data-session-id="${attr(session.sessionId)}">
    ${icon('bot')}
    <span class="session-catalog-main">
      <strong>${esc(session.botName)}</strong>
      <span class="session-catalog-desc"><span class="faint">${esc(label)}</span>${task ? `<span class="sep"></span>${task}` : ''}</span>
      ${meta ? `<span class="session-catalog-meta">${meta}</span>` : ''}
    </span>
    ${runBadge(session)}
    ${session.alias ? `<span class="pill gray">${t('session.alias')}</span>` : ''}
  </button>`
}

export function modalSessionCatalog(modal) {
  const sessions = Array.isArray(modal?.sessions) ? modal.sessions : []
  const rows = [...sessions].sort((a, b) => Number(b.running) - Number(a.running))
  const body = rows.length === 0
    ? `<div class="faint">${t('session.catalogEmpty')}</div>`
    : `<div class="session-catalog-list">${rows.map(sessionCatalogRow).join('')}</div>`
  return modalShell({
    title: t('session.catalogTitle'),
    subtitle: `${sessions.length} ${t('session.catalogCount')}`,
    body,
    footer: `<button class="btn" data-action="close-modal">${t('关闭')}</button>`,
    size: '',
  })
}

// 单条消息：user 平铺正文；assistant 正文 + 思考折叠；tool 整条折叠（结果走等宽块）。
function sessionEntryView(entry) {
  const time = entry.time ? `<span class="faint">${esc(timeAgo(entry.time))}</span>` : ''
  if (entry.role === 'user') {
    return `<div class="sess-entry sess-user">
      <div class="traj-entry-head">${t('session.roleUser')}${time}</div>
      ${entry.text ? `<div class="traj-detail">${esc(entry.text)}</div>` : ''}
    </div>`
  }
  if (entry.role === 'assistant') {
    const reasoning = entry.reasoning
      ? `<details class="traj-entry traj-fold"${panelAttrs(state, `sess:${entry.seq}:reasoning`)}><summary class="traj-entry-head">${t('session.reasoning')}</summary><div class="traj-detail">${esc(entry.reasoning)}</div></details>`
      : ''
    const interrupted = entry.interrupted ? `<span class="pill amber">${t('session.interrupted')}</span>` : ''
    return `<div class="sess-entry sess-assistant">
      <div class="traj-entry-head">${t('session.roleAssistant')}${time}${interrupted}</div>
      ${reasoning}
      ${entry.text ? `<div class="traj-detail">${esc(entry.text)}</div>` : ''}
    </div>`
  }
  const name = entry.toolName ? entry.toolName : t('session.toolUnknown')
  const label = entry.isError ? t('session.toolFailed', { name }) : t('session.toolOk', { name })
  return `<details class="sess-entry sess-tool traj-entry traj-fold"${panelAttrs(state, `sess:${entry.seq}:tool`)}>
    <summary class="traj-entry-head">${esc(label)}${time}${entry.isError ? `<span class="pill red">${t('session.error')}</span>` : ''}</summary>
    ${entry.text ? `<div class="traj-detail traj-json">${esc(entry.text)}</div>` : ''}
  </details>`
}

export function modalSession(modal) {
  const entries = Array.isArray(modal?.entries) ? modal.entries : []
  const context = modal?.context ?? {}
  const kindLabel = sessionKindLabel({ kind: context.kind, projectId: context.projectKey ? 1 : null })
  const titleParts = [context.botName, context.taskIdentifier ?? kindLabel].filter(Boolean)
  const badges = [
    modal?.running ? `<span class="pill amber">${t('session.running')}</span>` : '',
    modal?.live ? `<span class="pill green">${t('session.live')}</span>` : `<span class="pill gray">${t('session.cold')}</span>`,
  ].filter(Boolean).join(' ')
  const olderBtn = modal?.hasOlder
    ? `<button type="button" class="btn small" data-action="session-load-older">${icon('clock')}${t('session.loadOlder')}</button>`
    : ''
  const body = entries.length === 0
    ? `<div class="faint">${t('session.empty')}</div>`
    : `<div class="sess-stream">${olderBtn}${entries.map(entry => sessionEntryView(entry)).join('')}</div>`
  const subtitle = [
    context.taskTitle,
    `${entries.length} ${t('session.entryCount')}`,
  ].filter(Boolean).join(' · ')
  return modalShell({
    title: titleParts.join(' · '),
    subtitle,
    badge: badges,
    body,
    footer: `<button class="btn" data-action="close-modal">${t('关闭')}</button>`,
    size: 'wide',
  })
}
