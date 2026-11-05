// cards.js —— 消息卡片域：审批卡片（DSHBOTS-32/102/108）、提问卡片（DSHBOTS-116）、
// 桌面通知（DSHBOTS-86）、Bot 私信折叠面板与 renderMessage。
// 标记块（approval-card / approval-ux / approval-v2 / question-card / desktop-notify）随本文件迁移，
// 块内容原样保留；tests/desktop-notify.test.js 等按标记块抽取断言。
import { state } from './state.js'
import { attr, avatar, botById, esc, formatTime } from './util.js'
import { icon } from './icons.js'
import { mdChatScope, mdPlainSummary, richText } from './markdown.js'
import { t } from './i18n.js'
import { renderMessageImages } from './composer.js'
import { refresh, panelAttrs, render } from '../app.js'

// ===== approval-card:start 审批卡片（DSHBOTS-32 UI）=====
// ===== approval-ux:start 审批交互（DSHBOTS-102）=====
// 超时可见：秒级倒计时 + 临期危险色。剩余时间从 expires_at 反推，
// 1s 定时器只改 .approval-clock 文本，不整卡重绘（2.8s 轮询整卡重绘会打断跳动感）。
const APPROVAL_URGENT_MS = 15_000
// 徽标口径：只计 pending，≥99 显示 99+（与侧栏未读胶囊同形态）。
const approvalBadgeText = (count) => (Number(count) > 99 ? '99+' : String(Number(count) || 0))
function formatApprovalRemaining(remainingMs) {
  const total = Math.max(0, Math.ceil((Number(remainingMs) || 0) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes <= 0) return `${seconds} 秒后自动拒绝`
  return seconds === 0 ? `${minutes} 分后自动拒绝` : `${minutes} 分 ${seconds} 秒后自动拒绝`
}
function approvalUrgent(remainingMs) {
  return (Number(remainingMs) || 0) <= APPROVAL_URGENT_MS
}
// 从 epoch ms 反推剩余毫秒，供 1s 局部刷新复用（与后端 approvalView 同口径）。
function approvalRemainingFrom(expiresMs, fallbackMs?) {
  const expires = Number(expiresMs)
  return Number.isFinite(expires) ? Math.max(0, expires - Date.now()) : (Number(fallbackMs) || 0)
}
// 后端 expires_at 是 ISO 串；转成 epoch ms 挂到 data-expires，避免 1s 刷新时重复解析。
function approvalExpiresMs(expiresAt) {
  const parsed = Date.parse(expiresAt)
  return Number.isFinite(parsed) ? parsed : 0
}
// ===== approval-ux:end =====

// ===== approval-v2:start 审批卡片视觉规格 V2（DSHBOTS-108）=====
// 五态：pending（唯一强调态）/ allowed / rejected / timeout / cancelled。
// pending 之外四态统一走「已决」排版：无倒计时无按钮、正文降 --ink-2、卡片回中性底；
// 红色只出现在 rejected 的左侧条与 pill 小点，其余中性。
const APPROVAL_STATUS = { pending: '等待审批', allowed: '已允许一次', rejected: '已拒绝', timeout: '已超时', cancelled: '已取消' }
// 各态图标：盾牌（待批）/ 对勾（已放行）/ 叉（已拒绝）/ 时钟（超时）/ 禁止（取消）。
// ui/modules/icons.js 不在本卡写范围，shield 与 ban 两枚路径在此内联；check/close/clock 走既有图标表。
const APPROVAL_ICON_PATHS = {
  shield: '<path d="M12 3l7 3v5c0 4.4-3 8.2-7 9.9-4-1.7-7-5.5-7-9.9V6z"/>',
  ban: '<circle cx="12" cy="12" r="8"/><path d="m6.7 6.7 10.6 10.6"/>',
}
const APPROVAL_STATE_ICON = { pending: 'shield', allowed: 'check', rejected: 'close', timeout: 'clock', cancelled: 'ban' }
function approvalIcon(name) {
  const path = APPROVAL_ICON_PATHS[name]
  if (!path) return icon(name)
  return `<svg class="approval-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
}
// 卡片倒计时文案：⏱ 剩余 X 分 Y 秒（顶部窄条另用「X 分后自动拒绝」，两处口径各自保留）。
function formatApprovalCountdown(remainingMs) {
  const total = Math.max(0, Math.ceil((Number(remainingMs) || 0) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes <= 0 ? `剩余 ${seconds} 秒` : `剩余 ${minutes} 分 ${seconds} 秒`
}
// 进度条比例：剩余时间 ÷ 授权窗口总长，夹在 0–1（剩余越多条越长，临期变短）。
function approvalProgressRatio(remainingMs, windowMs) {
  const total = Number(windowMs) || 0
  if (total <= 0) return 0
  return Math.max(0, Math.min(1, (Number(remainingMs) || 0) / total))
}
// 旧数据兜底：approvals 表落 tool_target 列之前的历史卡片没有目标，从摘要里取第一个路径片段
// （绝对路径，或带扩展名的相对路径）；取不到不出 chip。新数据不走这里。
function approvalPath(text) {
  const match = String(text ?? '').match(/(?:^|[\s"'`(（])((?:~|\.{1,2})?\/[\w.\-@]+(?:\/[\w.\-@]*)+|[\w.\-@]+\/[\w.\-@]+\.[A-Za-z0-9]+)/)
  return match ? match[1] : ''
}
// 目标 chip 取数：优先落库 tool_target（后端从工具参数直取：bash 命令首行 / 文件路径），
// text 用工作区相对形 tool_target_display、title 留原始值；列为空（旧数据）才回退 approvalPath 猜摘要。
function approvalTargetChip(approval, summary) {
  const raw = String(approval?.tool_target ?? '').trim()
  if (raw) {
    const display = String(approval?.tool_target_display ?? '').trim() || raw
    return { text: display, title: raw }
  }
  const guessed = approvalPath(summary)
  return guessed ? { text: guessed, title: guessed } : null
}
// 卡片 HTML：头部（图标 + 角色 + 工具/路径 chip）、正文、页脚三段；五态共用同一骨架。
// pending 页脚是倒计时 + 进度条 + 双按钮；已决四态页脚只有状态 pill。
function approvalCardMarkup(approval, deciding = false) {
  const status = String(approval.status ?? '')
  const pending = status === 'pending'
  const summary = approval.display_reason || approval.reason || '（无说明）'
  const expiresAt = approvalExpiresMs(approval.expires_at)
  const createdAt = Date.parse(approval.created_at)
  const windowMs = Number.isFinite(createdAt) ? Math.max(1, expiresAt - createdAt) : 0
  const percent = pending ? Math.round(approvalProgressRatio(approval.remainingMs, windowMs) * 100) : 0
  const urgent = approvalUrgent(approval.remainingMs)
  const target = approvalTargetChip(approval, summary)
  const pillTone = status === 'allowed' ? 'is-allowed' : status === 'rejected' ? 'is-rejected' : 'is-muted'
  const pillText = status === 'allowed' && approval.decided_at
    ? `${APPROVAL_STATUS.allowed} ${formatTime(approval.decided_at)}`
    : (APPROVAL_STATUS[status] ?? status)
  return `<div class="message-row">
    <div class="message-body-wrap approval-card" data-approval-status="${attr(approval.status)}" data-approval-id="${attr(approval.id)}">
      <div class="approval-head">
        <span class="approval-icon is-${attr(status)}">${approvalIcon(APPROVAL_STATE_ICON[status] ?? 'clock')}</span>
        <div class="approval-head-main">
          <div class="message-meta approval-meta"><strong>${esc(approval.botName)}</strong><span class="approval-ask">请求提权</span><span>${esc(formatTime(approval.created_at))}</span></div>
          <div class="approval-tools"><span class="approval-chip mono">${esc(approval.tool_name)}</span>${target ? `<span class="approval-chip mono approval-chip-path" title="${attr(target.title)}">${esc(target.text)}</span>` : ''}</div>
        </div>
      </div>
      <div class="approval-summary">${esc(summary)}</div>
      ${pending
        ? `<div class="approval-countdown${urgent ? ' urgent' : ''}" data-expires="${expiresAt}">${icon('clock')}<span class="approval-clock${approvalUrgent(approval.remainingMs) ? ' urgent' : ''}" data-expires="${expiresAt}">${esc(formatApprovalCountdown(approval.remainingMs))}</span></div>
      <div class="approval-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" data-expires="${expiresAt}" data-window="${windowMs}"><i class="approval-progress-fill" style="width:${percent}%"></i></div>
      <div class="approval-actions">
        <button class="btn small primary" data-action="approval-decide" data-approval-id="${attr(approval.id)}" data-decision="allow"${deciding ? ' disabled' : ''}>允许一次</button>
        <button class="btn small danger" data-action="approval-decide" data-approval-id="${attr(approval.id)}" data-decision="reject"${deciding ? ' disabled' : ''}>拒绝</button>
      </div>`
        : `<div class="approval-foot"><span class="approval-pill ${pillTone}"${approval.decided_at ? ` title="${attr(formatTime(approval.decided_at))}"` : ''}>${esc(pillText)}</span></div>`}
    </div>
  </div>`
}
// ===== approval-v2:end =====

// 审批卡片：消息行只是锚点，状态以 state.data.approvals 为准（渲染时查表，轮询自然刷新）。
// 查不到该条（超出 30 条窗口）时退化为 system 纯文本，不留假状态。
function renderApprovalCard(message) {
  const approval = (state.data?.approvals ?? []).find(item => item.id === message.approval_id)
  if (!approval) return `<div class="message-system"><span>${esc(message.body)}</span></div>`
  // 决策中禁用按钮：重复点击不重复发请求（后端也有 pending 校验，前端先挡一层）。
  const deciding = state.approvalDeciding?.has(approval.id) ?? false
  return approvalCardMarkup(approval, deciding)
}
// ===== approval-card:end =====

// ===== question-card:start 提问卡片（DSHBOTS-116 UI）=====
// 四态：pending（唯一强调态，可作答）/ answered / expired / timeout。
// 与审批卡片同骨架：pending 有倒计时 + 进度条 + 作答区，已决态只留状态 pill 与答案摘要。
const QUESTION_STATUS = { pending: '等待回答', answered: '已回答', expired: '已取消', timeout: '已超时' }
const QUESTION_STATE_ICON = { pending: 'message', answered: 'check', expired: 'close', timeout: 'clock' }
const QUESTION_URGENT_MS = 15_000
const questionBadgeText = (count) => (Number(count) > 99 ? '99+' : String(Number(count) || 0))
function questionExpiresMs(expiresAt) {
  const parsed = Date.parse(expiresAt)
  return Number.isFinite(parsed) ? parsed : 0
}
function questionRemainingFrom(expiresMs, fallbackMs?) {
  const expires = Number(expiresMs)
  return Number.isFinite(expires) ? Math.max(0, expires - Date.now()) : (Number(fallbackMs) || 0)
}
function questionUrgent(remainingMs) {
  return (Number(remainingMs) || 0) <= QUESTION_URGENT_MS
}
function formatQuestionCountdown(remainingMs) {
  const total = Math.max(0, Math.ceil((Number(remainingMs) || 0) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes <= 0 ? `剩余 ${seconds} 秒` : `剩余 ${minutes} 分 ${seconds} 秒`
}
function questionProgressRatio(remainingMs, windowMs) {
  const total = Number(windowMs) || 0
  if (total <= 0) return 0
  return Math.max(0, Math.min(1, (Number(remainingMs) || 0) / total))
}
// 作答草稿：questionId → { selected: Map<itemId, Set<label>>, custom: { [itemId]: string } }。
// 选择态按问题条目分桶——同卡多问时各问选项互不覆盖（共享一个 Set 会让后问的单选把前问清掉）；
// 只存前端选择态，提交时映射成宿主 {answers:[{id,selected,custom}]}；整页重渲染不丢选择。
function questionDraftOf(questionId) {
  let draft = state.questionDraft.get(questionId)
  if (!draft) {
    draft = { selected: new Map(), custom: {} }
    state.questionDraft.set(questionId, draft)
  }
  return draft
}
function questionDraftSelection(draft, itemId) {
  const key = String(itemId)
  let selected = draft.selected.get(key)
  if (!selected) {
    selected = new Set()
    draft.selected.set(key, selected)
  }
  return selected
}
// 一次点击折算成选择态：单选互斥（再点已选项=取消），多选可叠加。
// 抽成纯函数便于 UI 用例直接执行，切换只动本条目自己的桶。
function questionSelectOption(draft, item, label, multi) {
  const selected = questionDraftSelection(draft, item.id)
  if (multi) {
    if (selected.has(label)) selected.delete(label)
    else selected.add(label)
  } else if (selected.has(label) && selected.size === 1) {
    selected.clear()
  } else {
    selected.clear()
    selected.add(label)
  }
  return selected
}
function questionAnswerMap(question) {
  const answers = question?.answer?.answers
  if (!Array.isArray(answers)) return new Map()
  return new Map(answers.filter(item => item && item.id).map(item => [item.id, item]))
}
function questionOptionButton(question, item, option) {
  const draft = questionDraftOf(question.id)
  const selected = questionDraftSelection(draft, item.id).has(String(option.label))
  return `<button class="question-option${selected ? ' is-selected' : ''}" type="button"
    data-action="question-option" data-question-id="${attr(question.id)}" data-item-id="${attr(item.id)}"
    data-label="${attr(option.label)}" data-multi="${item.multiSelect ? '1' : '0'}"
    aria-pressed="${selected ? 'true' : 'false'}">${esc(option.label)}${option.description ? `<span class="question-option-desc">${esc(option.description)}</span>` : ''}</button>`
}
function questionItemMarkup(question, item, answerMap) {
  const options = Array.isArray(item.options) ? item.options : []
  const answer = answerMap.get(item.id)
  const custom = answer?.custom ? String(answer.custom) : ''
  const selectedText = Array.isArray(answer?.selected) ? answer.selected.map(label => String(label)).join('、') : ''
  const draft = questionDraftOf(question.id)
  const intent = item.intent?.kind === 'plan-review' ? item.intent : null
  const answerLine = answer
    ? `<div class="question-answer-line"><span class="question-answer-tag">回答</span>${selectedText ? `<strong>${esc(selectedText)}</strong>` : '<span class="question-answer-skip">（未选择）</span>'}${custom ? `<span class="question-answer-custom">${esc(custom)}</span>` : ''}</div>`
    : ''
  return `<div class="question-item" data-question-item="${attr(item.id)}">
    <div class="question-item-title">${item.header ? `<span class="question-item-header">${esc(item.header)}</span>` : ''}${esc(item.question)}</div>
    ${item.detail ? `<div class="question-item-detail">${esc(item.detail)}</div>` : ''}
    ${intent ? `<div class="question-item-intent">${icon('branch')}<span>计划评审</span>${intent.approve ? `<span class="question-item-intent-approve">${esc(intent.approve)}</span>` : ''}</div>` : ''}
    ${question.status === 'pending'
      ? `<div class="question-options">${options.map(option => questionOptionButton(question, item, option)).join('')}</div>
         <input class="input question-custom" type="text" data-question-custom data-question-id="${attr(question.id)}" data-item-id="${attr(item.id)}" maxlength="2000" placeholder="补充说明（可选）" value="${attr(draft.custom[item.id] ?? '')}">`
      : answerLine}
  </div>`
}
function questionCardMarkup(question, answering = false) {
  const status = String(question.status ?? '')
  const pending = status === 'pending'
  const items = Array.isArray(question.questions) ? question.questions : []
  const answerMap = questionAnswerMap(question)
  const expiresAt = questionExpiresMs(question.expires_at)
  const createdAt = Date.parse(question.created_at)
  const windowMs = Number.isFinite(createdAt) ? Math.max(1, expiresAt - createdAt) : 0
  const remaining = pending ? questionRemainingFrom(expiresAt, question.remainingMs) : 0
  const percent = pending ? Math.round(questionProgressRatio(remaining, windowMs) * 100) : 0
  const urgent = questionUrgent(remaining)
  const pillTone = status === 'answered' ? 'is-answered' : 'is-muted'
  const pillText = status === 'answered' && question.answered_at
    ? `${QUESTION_STATUS.answered} ${formatTime(question.answered_at)}`
    : (QUESTION_STATUS[status] ?? status)
  return `<div class="message-row">
    <div class="message-body-wrap question-card" data-question-status="${attr(question.status)}" data-question-id="${attr(question.id)}">
      <div class="question-head">
        <span class="question-icon is-${attr(status)}">${icon(QUESTION_STATE_ICON[status] ?? 'clock')}</span>
        <div class="question-head-main">
          <div class="message-meta question-meta"><strong>${esc(question.botName)}</strong><span class="question-ask">发起提问</span><span>${esc(formatTime(question.created_at))}</span></div>
          <div class="question-count">${items.length} 个问题</div>
        </div>
      </div>
      ${items.map(item => questionItemMarkup(question, item, answerMap)).join('')}
      ${pending
        ? `<div class="question-countdown${urgent ? ' urgent' : ''}" data-expires="${expiresAt}">${icon('clock')}<span class="question-clock${urgent ? ' urgent' : ''}" data-expires="${expiresAt}">${esc(formatQuestionCountdown(remaining))}</span></div>
      <div class="question-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" data-expires="${expiresAt}" data-window="${windowMs}"><i class="question-progress-fill" style="width:${percent}%"></i></div>
      <div class="question-actions">
        <button class="btn small primary" type="button" data-action="question-submit" data-question-id="${attr(question.id)}"${answering ? ' disabled' : ''}>提交回答</button>
      </div>`
        : `<div class="question-foot"><span class="question-pill ${pillTone}"${question.answered_at ? ` title="${attr(formatTime(question.answered_at))}"` : ''}>${esc(pillText)}</span></div>`}
    </div>
  </div>`
}
// 提问卡片：消息行只是锚点，状态以 state.data.questions 为准（渲染时查表，轮询自然刷新）。
// 查不到该条（超出 30 条窗口）时退化为 system 纯文本，不留假状态。
function renderQuestionCard(message) {
  const question = (state.data?.questions ?? []).find(item => item.id === message.question_id)
  if (!question) return `<div class="message-system"><span>${esc(message.body)}</span></div>`
  // 提交中禁用按钮：重复点击不重复发请求（后端也有 pending 校验，前端先挡一层）。
  const answering = state.questionAnswering?.has(question.id) ?? false
  return questionCardMarkup(question, answering)
}
// ===== question-card:end =====

// 跨项目待答入口（DSHBOTS-116）：与审批窄条同构，只计 pending，99+ 封顶。
function questionBannerSummary(item) {
  const items = Array.isArray(item.questions) ? item.questions : []
  const first = items[0]?.question
  if (!first) return ''
  return items.length > 1 ? `${first}（共 ${items.length} 问）` : first
}
function questionBannerView(pendingQuestions) {
  const count = Number(pendingQuestions?.count ?? 0)
  if (count <= 0) return ''
  const items = pendingQuestions?.items ?? []
  return `<div class="question-banner">
          <button class="question-banner-btn" data-action="toggle-questions" aria-expanded="${state.questionPanelOpen ? 'true' : 'false'}">
            ${icon('message')}<span class="question-banner-text">待回答提问</span>
            <span class="unread-badge">${questionBadgeText(count)}</span>
            ${icon('chevron', `chev${state.questionPanelOpen ? ' open' : ''}`)}
          </button>
          ${state.questionPanelOpen ? `<div class="question-menu" role="menu">
            ${items.length === 0 ? '<div class="question-menu-empty">暂无明细</div>' : items.map(item => `
              <button class="question-menu-item" role="menuitem" data-action="focus-question" data-question-id="${attr(item.id)}">
                <span class="question-menu-project">${esc(cardScopeLabel(item))}</span>
                <span class="question-menu-line">${esc(item.botName || 'Bot')}</span>
                <span class="question-menu-summary">${esc(questionBannerSummary(item))}</span>
                <span class="question-menu-time" data-expires="${questionExpiresMs(item.expires_at)}">${esc(formatQuestionCountdown(questionRemainingFrom(questionExpiresMs(item.expires_at), item.remainingMs)))}</span>
              </button>`).join('')}
          </div>` : ''}
        </div>`
}

// 顶部窄条的来源标签（DSHBOTS-218）：单聊会话没有项目归属，来源列显示「单聊」，不显示项目名。
function cardScopeLabel(item) {
  return item.scope === 'solo' ? '单聊' : (item.projectName || '（未命名项目）')
}

// 点通知：聚焦窗口，跳到对应会话（项目群聊或单聊，DSHBOTS-218）并把提问卡滚动到可视区。
function focusQuestionCard(question) {
  if (!question) return
  if (question.project_id) {
    state.projectId = question.project_id
    state.chatMode = 'group'
  } else {
    // 单聊卡片没有项目归属：跳到该 bot 的 1V1 会话，卡片锚点就在单聊消息流里。
    if (!question.bot_id) return
    state.soloBotId = question.bot_id
    state.chatMode = 'solo'
  }
  state.view = 'chat'
  refresh()
    .then(() => {
      const card = document.querySelector(`.question-card[data-question-id="${question.id}"]`)
      card?.scrollIntoView({ block: 'center' })
    })
    .catch(() => {})
}

// 跨项目待审入口（DSHBOTS-102）：工作台顶部一条窄条，只计 pending，99+ 封顶；
// 展开后列明细（项目 / bot / 工具 / 摘要 / 剩余时间），点条目跳到对应项目并滚动到该卡片。
// 不在顶部重复渲染完整卡片：卡片带理由/作用域/按钮，多项目并发会把窄条撑高、挤走工作区。
function approvalBannerView(pendingApprovals) {
  const count = Number(pendingApprovals?.count ?? 0)
  if (count <= 0) return ''
  const items = pendingApprovals?.items ?? []
  return `<div class="approval-banner">
          <button class="approval-banner-btn" data-action="toggle-approvals" aria-expanded="${state.approvalPanelOpen ? 'true' : 'false'}">
            ${icon('alert')}<span class="approval-banner-text">待处理审批</span>
            <span class="unread-badge">${approvalBadgeText(count)}</span>
            ${icon('chevron', `chev${state.approvalPanelOpen ? ' open' : ''}`)}
          </button>
          ${state.approvalPanelOpen ? `<div class="approval-menu" role="menu">
            ${items.length === 0 ? '<div class="approval-menu-empty">暂无明细</div>' : items.map(item => `
              <button class="approval-menu-item" role="menuitem" data-action="focus-approval" data-approval-id="${attr(item.id)}">
                <span class="approval-menu-project">${esc(cardScopeLabel(item))}</span>
                <span class="approval-menu-line">${esc(item.botName || 'Bot')} · ${esc(item.tool_name || '工具')}</span>
                <span class="approval-menu-summary">${esc(item.display_reason || item.reason || '')}</span>
                <span class="approval-menu-time" data-expires="${approvalExpiresMs(item.expires_at)}">${esc(formatApprovalRemaining(item.remainingMs))}</span>
              </button>`).join('')}
          </div>` : ''}
        </div>`
}


// desktop-notify:start 审批请求桌面通知（DSHBOTS-86，tests/desktop-notify.test.js 抽取此块断言）
const NOTIFY_KEY = 'dshb:desktop-notify'
// 会话级基线：上一轮见过的 pending 审批 id（判增量）与已弹过通知的审批 id（每条只弹一次）。
let notifyScope = null
const knownPendingIds = new Set()
const notifiedApprovals = new Set()

// file:// 与非 localhost 的 http 页面拿不到 Notification（非安全上下文），统一按不支持降级。
function notifySupported() {
  return typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function'
}

function notifyPermission() {
  return notifySupported() ? Notification.permission : 'unsupported'
}

function notifyStoredPref() {
  try { return localStorage.getItem(NOTIFY_KEY) } catch { return null }
}

function notifyStorePref(value) {
  try { localStorage.setItem(NOTIFY_KEY, value) } catch {}
}

function notifyOn() {
  return notifyPermission() === 'granted' && notifyStoredPref() === 'granted'
}

// 开关（用户点击手势内）：开 = requestPermission 并把结果持久到 localStorage；关 = 只写 'denied' 记忆，不动浏览器权限。
async function toggleDesktopNotify() {
  if (!notifySupported()) return
  if (notifyOn()) {
    notifyStorePref('denied')
  } else {
    const permission = await Notification.requestPermission()
    notifyStorePref(permission === 'granted' ? 'granted' : 'denied')
  }
  render()
}

// 开关显示态（全局配置页「界面」卡）：不支持或被浏览器拒绝时置灰，并附一句原因。
function notifyToggleView() {
  const permission = notifyPermission()
  if (permission === 'unsupported') return { on: false, disabled: true, label: '不可用', hint: '当前环境不支持桌面通知（需 HTTPS 或 localhost）。' }
  if (permission === 'denied') return { on: false, disabled: true, label: '已被浏览器拒绝', hint: '在浏览器站点设置中允许通知后刷新页面。' }
  if (notifyOn()) return { on: true, disabled: false, label: '已开启', hint: '新审批到达且页面不可见或失焦时弹系统通知，需保持本页开启。' }
  return { on: false, disabled: false, label: permission === 'granted' ? '已关闭' : '未开启', hint: '开启后新审批到达时弹系统桌面通知。' }
}

// 通知正文与群聊审批卡片同一口径：<bot 名> 请求使用 <工具>：<说明>；超长截断。
function approvalNotifyBody(approval) {
  const head = `${approval.botName ?? 'Bot'} 请求使用 ${approval.tool_name ?? '工具'}`
  const summary = approval.display_reason || approval.reason || ''
  const text = summary ? `${head}：${summary}` : head
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

// 点通知：聚焦窗口，跳到对应会话（项目群聊或单聊，DSHBOTS-218）并把审批卡滚动到可视区。
function focusApprovalCard(approval) {
  if (!approval) return
  if (approval.project_id) {
    state.projectId = approval.project_id
    state.chatMode = 'group'
  } else {
    // 单聊卡片没有项目归属：跳到该 bot 的 1V1 会话，卡片锚点就在单聊消息流里。
    if (!approval.bot_id) return
    state.soloBotId = approval.bot_id
    state.chatMode = 'solo'
  }
  state.view = 'chat'
  refresh()
    .then(() => {
      const card = document.querySelector(`.approval-card[data-approval-id="${approval.id}"]`)
      card?.scrollIntoView({ block: 'center' })
    })
    .catch(() => {})
}

// 轮询后比较 pending 增量：通知开启且页面不可见或失焦时，对新增 pending 审批各弹一次
// （tag=approval-<id> 防同卡重复弹；换项目时基线重置，新项目从未见过的存量 pending 作为新审批弹出，
// notifiedApprovals 会话级去重保证每条只弹一次）。页面可见且聚焦时同样记录基线——用户当场看到卡片，不再补弹。
function notifyNewApprovals(approvals, { enabled = notifyOn(), hidden = document.hidden, focused = document.hasFocus() } = {}) {
  const pending = (approvals ?? []).filter(item => item?.status === 'pending')
  const scope = pending.length > 0 ? String(pending[0].project_id ?? '') : null
  if (scope !== notifyScope) {
    notifyScope = scope
    knownPendingIds.clear()
  }
  const fresh = pending.filter(item => !knownPendingIds.has(item.id)).map(item => item.id)
  for (const item of pending) knownPendingIds.add(item.id)
  if (!enabled || (!hidden && focused)) return
  for (const approval of pending) {
    if (!fresh.includes(approval.id) || notifiedApprovals.has(approval.id)) continue
    notifiedApprovals.add(approval.id)
    try {
      const notification = new Notification('DSH 审批请求', { body: approvalNotifyBody(approval), tag: `approval-${approval.id}` })
      notification.onclick = () => { window.focus(); focusApprovalCard(approval); notification.close() }
    } catch {}
  }
}
// desktop-notify:end

function renderMessage(message) {
  if (message.kind === 'approval') return renderApprovalCard(message)
  if (message.kind === 'question') return renderQuestionCard(message)
  if (message.sender_type === 'system') {
    return `<div class="message-system">
      <span>${esc(message.body)}</span>
      ${message.taskIdentifier ? `<div class="task-chip-line center"><button class="task-chip" data-action="open-task" data-task-id="${attr(message.task_id)}" title="${attr(message.taskTitle ?? '')}"><strong>${esc(message.taskIdentifier)}</strong></button></div>` : ''}
    </div>`
  }
  const isUser = message.sender_type === 'user'
  const bot = isUser ? null : botById(message.sender_id)
  // 引用块：气泡顶部一行「❝ 名字：摘要」，纯展示。摘要走 mdPlainSummary 去掉 markdown 记号，
  // 否则原文里的 **、-、` 会原样露出，还会让整条摘要挤成一行、撑破气泡宽度。
  const quoteBlock = message.reply_to ? `<div class="msg-quote" title="${attr(t('message.quoteFrom', { name: message.reply_to.sender_name }))}">${icon('quote')}<span>${esc(message.reply_to.sender_name)}：${esc(mdPlainSummary(message.reply_to.excerpt, 120))}</span></div>` : ''
  // hover 引用按钮：仅群聊；点击进入引用回复（选中该消息作为回复目标）。摘要同样去 markdown 记号。
  const quoteBtn = state.chatMode === 'group' ? `<button class="msg-quote-btn" data-action="quote-message" data-message-id="${attr(message.id)}" data-sender-name="${attr(message.senderName)}" data-excerpt="${attr(mdPlainSummary(message.body, 120))}" title="${t('message.quoteTitle')}" aria-label="${t('message.quoteLabel')}">${icon('quote')}</button>` : ''
  // hover 复制按钮：群聊/单聊都有，紧邻引用按钮右侧；复制消息原文 message.body（非渲染后 HTML），走统一 copy handler。
  const copyBtn = `<button class="msg-copy-btn" data-action="copy" data-copy="${attr(message.body)}" title="${t('message.copyTitle')}" aria-label="${t('message.copyLabel')}">${icon('copy')}</button>`
  // 任务/思考过程 chip 合并同一行：固定顺序「思考过程 → 任务」，缺哪个不留空位。
  const trajChip = message.run_id && !isUser ? `<button class="task-chip" data-action="open-trajectory" data-run-id="${attr(message.run_id)}">${t('message.thinking')}</button>` : ''
  const taskChip = message.taskIdentifier ? `<button class="task-chip" data-action="open-task" data-task-id="${attr(message.task_id)}" title="${attr(message.taskTitle ?? '')}"><strong>${esc(message.taskIdentifier)}</strong></button>` : ''
  const chipsLine = trajChip || taskChip ? `<div class="task-chip-line">${trajChip}${taskChip}</div>` : ''
  // 纯图片消息没有正文：气泡留空不渲染，只留附图块（避免出现一个空框）。
  const bubbleHtml = message.body || quoteBlock ? `<div class="message-bubble">${quoteBlock}${richText(message.body, mdChatScope())}</div>` : ''
  return `<div class="message-row ${isUser ? 'user' : ''}">
    ${isUser ? '' : avatar(bot ?? { name: message.senderName, color: 'gray' })}
    <div class="message-body-wrap">
      <div class="message-meta"><strong>${esc(message.senderName)}</strong><span>${esc(formatTime(message.created_at))}</span>${quoteBtn}${copyBtn}</div>
      ${bubbleHtml}
      ${renderMessageImages(message.images)}
      ${chipsLine}
    </div>
  </div>`
}

// ===== Bot 私信（项目群聊视图的折叠面板，数据来自 state.directMessages）=====

const DM_STATUS = { pending: '待回复', delivered: '已送达', replied: '已回复', failed: '失败' }
const DM_STATUS_TONE = { pending: '', delivered: 'violet', replied: 'green', failed: 'red' }

function renderDirectMessagesCard() {
  const items = state.data?.directMessages ?? []
  if (items.length === 0) return ''
  return `<details class="chat-subpanel"${panelAttrs(state, 'dm')}>
    <summary title="${t('dm.toggle')}">${icon('chevron', 'chev')}<span>${t('dm.title')}</span><span class="subpanel-count">${items.length}</span></summary>
    <div class="subpanel-body">
      ${items.length === 0 ? `<div class="subpanel-empty">${t('dm.empty')}</div>` : items.map(dm => `
        <div class="subpanel-row">
          <div class="subpanel-row-head">
            <strong>${esc(dm.fromName)} → ${esc(dm.toName)}</strong>
            <span class="pill ${DM_STATUS_TONE[dm.status] ?? ''}">${esc(dm.status in DM_STATUS ? t('dm.' + dm.status) : dm.status)}</span>
            <span class="faint">${esc(formatTime(dm.createdAt))}</span>
            ${dm.repliedAt ? `<span class="faint">${t('dm.repliedAt', { time: formatTime(dm.repliedAt) })}</span>` : ''}
            <span class="subpanel-tag">#${esc(dm.id)}</span>
          </div>
          ${dm.textSnippet ? `<div class="subpanel-row-text">${esc(dm.textSnippet)}</div>` : ''}
          ${dm.replySnippet ? `<div class="subpanel-row-sub">↩ ${esc(dm.replySnippet)}</div>` : ''}
        </div>`).join('')}
    </div>
  </details>`
}


export { renderMessage, renderDirectMessagesCard, questionBannerView, approvalBannerView, toggleDesktopNotify, focusQuestionCard, focusApprovalCard, notifyNewApprovals, questionDraftOf, questionDraftSelection, questionSelectOption, notifyToggleView, notifyOn, formatApprovalRemaining, approvalUrgent, approvalRemainingFrom, formatApprovalCountdown, approvalProgressRatio, questionRemainingFrom, questionUrgent, formatQuestionCountdown, questionProgressRatio }
