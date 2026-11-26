// inbox.ts —— 收件箱：跨项目的统一待办面板，入口在侧栏群聊列表上方。
// 四类事项：提权审批 / 待回答提问 / 进化审批直接就地处理（与群聊、进化页同一套卡片）；
// 总监 @owner 事项点开回群聊查看，只有手动标已读才移出。
import { state, CHAT_PAGE_SIZE } from './state.js'
import { icon } from './icons.js'
import { t } from './i18n.js'
import { api } from './api.js'
import { attr, esc, formatTime, toast } from './util.js'
import { mdPlainSummary } from './markdown.js'
import { pageHead, pageSection, refreshAction } from './page-shell.js'
import { approvalBadgeText, approvalCardMarkup, questionCardMarkup } from './cards.js'
import { proposalCardMarkup } from './proposal-card.js'
import { beginChatPending, chatContextPending, endChatPending, refresh, render } from '../app.js'

// ===== inbox-count:start =====
// 收件箱计数（纯逻辑，tests/inbox-ui.test.ts 抽取本块断言）：侧栏徽标是四类待办之和。
// 审批/提问/提案只计待处理态，@owner 计未读；归档项目的事项后端已不下发。
export function inboxCounts(data) {
  return {
    approvals: Number(data?.pendingApprovals?.count ?? 0),
    questions: Number(data?.pendingQuestions?.count ?? 0),
    proposals: (data?.proposals ?? []).filter(item => item?.status === 'pending').length,
    mentions: Number(data?.pendingOwnerMentions?.count ?? 0),
  }
}

export function inboxTotal(data) {
  const counts = inboxCounts(data)
  return counts.approvals + counts.questions + counts.proposals + counts.mentions
}

// 徽标 99+ 封顶与审批徽标同一函数；没有待办就不出徽标。
export function inboxBadge(count) {
  return Number(count) > 0 ? `<span class="unread-badge inbox-badge">${approvalBadgeText(count)}</span>` : ''
}
// ===== inbox-count:end =====

// 侧栏入口常驻：收件箱是可以主动打开的面板，没有待办也留在群聊列表上方。
export function inboxEntryView() {
  const active = state.view === 'inbox'
  const total = inboxTotal(state.data)
  const title = total > 0 ? ` title="${attr(t('inbox.badgeTitle', { count: total }))}"` : ''
  return `<button class="inbox-entry${active ? ' active' : ''}" data-action="nav" data-view="inbox" aria-current="${active ? 'page' : 'false'}"${title}>
    ${icon('inbox')}<span>${t('sidebar.inbox')}</span>${inboxBadge(total)}
  </button>`
}

// 分组顺序即处理顺序：先就地可办的，最后是需要回群聊看的。
const INBOX_KINDS = ['approvals', 'questions', 'proposals', 'mentions']

const INBOX_TITLE = {
  get approvals() { return t('inbox.kind.approvals') },
  get questions() { return t('inbox.kind.questions') },
  get proposals() { return t('inbox.kind.proposals') },
  get mentions() { return t('inbox.kind.mentions') },
}

const INBOX_DESC = {
  get approvals() { return t('inbox.kindDesc.approvals') },
  get questions() { return t('inbox.kindDesc.questions') },
  get proposals() { return t('inbox.kindDesc.proposals') },
  get mentions() { return t('inbox.kindDesc.mentions') },
}

// 提问卡自身不带来源：卡上方补一行项目名/单聊与「查看来源」。
function questionSourceLine(item) {
  const source = item.scope === 'solo' ? t("单聊") : (item.projectName || t("（未命名项目）"))
  return `<div class="inbox-item-source"><span>${esc(source)}</span><button class="btn small" data-action="focus-question" data-question-id="${attr(item.id)}">${icon('arrow')}${t('inbox.viewSource')}</button></div>`
}

// @owner 事项行：点正文跳回群聊里的那条消息，右侧按钮标已读（提交中禁用防重复）。
function ownerMentionRow(item) {
  const reading = state.ownerMentionReading.has(item.id)
  const source = [item.projectName, item.projectKey].filter(Boolean).join(' · ')
  const task = item.taskIdentifier ? `${item.taskIdentifier}${item.taskTitle ? ` ${item.taskTitle}` : ''}` : ''
  return `<div class="inbox-mention" data-message-id="${attr(item.id)}">
    <button class="inbox-mention-main" data-action="focus-owner-mention" data-message-id="${attr(item.id)}" data-project-id="${attr(item.project_id)}">
      <span class="inbox-mention-source">${esc(source)}${task ? ` · ${esc(task)}` : ''}</span>
      <span class="inbox-mention-snippet">${esc(mdPlainSummary(item.snippet, 280))}</span>
      <span class="inbox-mention-meta">${esc(item.senderName)} · ${esc(formatTime(item.created_at))}</span>
    </button>
    <button class="btn small" data-action="inbox-mark-read" data-message-id="${attr(item.id)}" data-project-id="${attr(item.project_id)}"${reading ? ' disabled' : ''}>${t('inbox.markRead')}</button>
  </div>`
}

export function renderInbox() {
  const data = state.data
  const counts = inboxCounts(data)
  const proposals = (data?.proposals ?? []).filter(item => item.status === 'pending')
  const bodies = {
    // 审批卡自带来源行，整卡可点跳回会话，与卡内「允许一次/拒绝」并存（按钮经内层 data-action 命中）。
    approvals: counts.approvals > 0 ? (data?.pendingApprovals?.items ?? []).map(item => `<div class="approval-menu-card" data-action="focus-approval" data-approval-id="${attr(item.id)}">${approvalCardMarkup(item, state.approvalDeciding?.has(item.id) ?? false, true)}</div>`) : [],
    questions: counts.questions > 0 ? (data?.pendingQuestions?.items ?? []).map(item => `<div class="inbox-item">${questionSourceLine(item)}${questionCardMarkup(item, state.questionAnswering?.has(item.id) ?? false)}</div>`) : [],
    proposals: proposals.map(item => proposalCardMarkup(item, { primary: item.id === proposals[0]?.id })),
    mentions: counts.mentions > 0 ? (data?.pendingOwnerMentions?.items ?? []).map(ownerMentionRow) : [],
  }
  let index = 0
  const sections = INBOX_KINDS.filter(kind => counts[kind] > 0).map(kind => {
    index += 1
    const shown = bodies[kind].length
    return pageSection({
      index: String(index).padStart(2, '0'),
      id: `inbox-${kind}`,
      title: INBOX_TITLE[kind],
      // 明细有条数上限：超出时说明总数，避免「徽标 60、列表 50」看着对不上。
      desc: counts[kind] > shown ? t('inbox.listCapped', { count: counts[kind], shown }) : INBOX_DESC[kind],
      headExtra: `<span class="pill">${counts[kind]}</span>`,
      body: bodies[kind].join(''),
    })
  })
  const actions = `${counts.mentions > 0 ? `<button class="btn" data-action="inbox-mark-all-read">${icon('check')}${t('inbox.markAllRead')}</button>` : ''}${refreshAction()}`
  return `<div class="global-page inbox-page">
    ${pageHead(t('inbox.eyebrow'), t('viewTitle.inbox'), t('inbox.desc'), actions)}
    ${sections.length === 0 ? `<div class="empty-state inbox-empty"><div class="empty-symbol">${icon('inbox')}</div><h3>${t('inbox.emptyTitle')}</h3><p>${t('inbox.emptyBody')}</p></div>` : sections.join('')}
  </div>`
}

// 标已读：乐观移出，失败回滚并提示。只有手动标记会让 @owner 事项离开收件箱。
export async function markOwnerMentionRead(item) {
  const pending = state.data?.pendingOwnerMentions
  if (!pending || state.ownerMentionReading.has(item.id)) return
  const index = pending.items.findIndex(entry => entry.id === item.id)
  const previous = index >= 0 ? pending.items[index] : null
  state.ownerMentionReading.add(item.id)
  state.ownerMentionReadIds.add(item.id)
  pending.items = pending.items.filter(entry => entry.id !== item.id)
  pending.count = Math.max(0, Number(pending.count ?? 0) - (previous ? 1 : 0))
  render()
  try {
    await api('inbox_mark_read', { projectId: item.project_id, messageId: item.id }, { quiet: true })
  } catch (error: any) {
    // 服务端回「不存在或已读」说明它本来就不该在收件箱里，不回滚；其余失败放回原位。
    if (previous && error?.code !== 'NOT_FOUND') {
      pending.items.splice(Math.min(index, pending.items.length), 0, previous)
      pending.count = Number(pending.count ?? 0) + 1
    }
    toast(error?.message || t('inbox.markReadFailed'), 'error')
  } finally {
    state.ownerMentionReading.delete(item.id)
    render()
  }
}

export async function markAllOwnerMentionsRead() {
  const pending = state.data?.pendingOwnerMentions
  if (!pending || pending.count <= 0) return
  const previousItems = pending.items
  const previousCount = Number(pending.count ?? 0)
  for (const item of pending.items) state.ownerMentionReadIds.add(item.id)
  pending.items = []
  pending.count = 0
  render()
  try {
    await api('inbox_mark_all_read', {}, { quiet: true })
  } catch (error: any) {
    pending.items = previousItems
    pending.count = previousCount
    toast(error?.message || t('inbox.markReadFailed'), 'error')
    render()
  }
}

// 跳到 @owner 消息所在的群聊并高亮那一条。消息还在最近一页里就直接定位；
// 已经更早的话按锚点载入一页（chatAnchor 替代最新窗口展示），列表底部给「回到最新」。
export async function focusOwnerMention(item) {
  if (!item) return
  const key = `group:${item.project_id}`
  if (state.chatAnchor?.key !== key) state.chatAnchor = null
  state.projectId = item.project_id
  state.chatMode = 'group'
  state.view = 'chat'
  state.replyTo = null // 跨上下文跳转，引用条不能带到新会话（与 select-project 同口径）
  const pendingSeq = beginChatPending({ projectId: state.projectId, chatMode: 'group', soloBotId: null })
  render()
  try {
    await refresh()
    const stuckOnSkeleton = chatContextPending()
    endChatPending(pendingSeq)
    if (stuckOnSkeleton) render()
    // 项目已归档或被移除时 state 会回退到别的项目，这时无处可跳。
    if (state.data?.project?.id !== item.project_id) return
    if (!(state.chatAnchor?.anchorId === item.id) && !document.querySelector(`.message-row[data-message-id="${item.id}"]`)) {
      const page = await api('messages_page', { projectId: item.project_id, anchorId: item.id, limit: CHAT_PAGE_SIZE }, { quiet: true })
      const messages = page.messages ?? []
      // 载入时刻最新窗口的最后一条：之后到达的消息按它判定为「锚点之后新到的」。
      const loadedNewest = (state.data.messages ?? []).at(-1)
      state.chatAnchor = {
        key,
        anchorId: item.id,
        items: messages,
        newerCount: Number(page.newerCount ?? 0),
        loadedNewest: loadedNewest ? { createdAt: loadedNewest.created_at, id: loadedNewest.id } : null,
      }
      // 锚点窗口之前的历史从零翻起：旧分片桶与最新窗口之间的间隔不再拼接。
      state.chatOlder = { key, items: [], hasMore: Boolean(page.hasMore), loading: false }
    }
    state.chatFocusId = item.id
    state.chatAtBottom = false // 定位到消息即离开底部视角，防 render 尾帧把消息再滚出视野
    render()
    document.querySelector(`.message-row[data-message-id="${item.id}"]`)?.scrollIntoView({ block: 'center' })
    scheduleChatFocusClear(item.id)
  } catch (error: any) {
    endChatPending(pendingSeq)
    if (!state.chatAnchor) render()
    toast(error?.message || t('inbox.jumpFailed'), 'error')
  }
}

// 高亮只停留片刻：到点清标志并直接摘类名，不整页重渲染（不打断输入中的草稿）。
const CHAT_FOCUS_MS = 6000
let chatFocusTimer = null

export function scheduleChatFocusClear(messageId) {
  if (chatFocusTimer) clearTimeout(chatFocusTimer)
  chatFocusTimer = setTimeout(() => {
    chatFocusTimer = null
    if (state.chatFocusId === messageId) state.chatFocusId = null
    for (const el of document.querySelectorAll('.message-row.message-focus')) el.classList.remove('message-focus')
  }, CHAT_FOCUS_MS)
}
