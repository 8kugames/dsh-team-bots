import { state, STATUS, STATUS_ORDER, PRIORITY, PROPOSAL_STATUS, COLORS, COLOR_NAMES, BOT_STATUS, RUN_STATUS, RUN_KIND, CHAT_PAGE_SIZE, CHAT_ACTIVE_TASK_LIMIT, SKILL_STATUS, MEMORY_STATUS, PROPOSAL_KIND, TERMINAL_STATUS, CREATOR_TYPE, EFFORT, FILE_POLICY, DEFAULT_FILE_POLICY, VIEW_ACTION, NAV, SOLO_NAV } from './modules/state.js'
import { icon } from './modules/icons.js'
import { applyUiScale, applyUiTheme, esc, attr, pathCode, costValue, clamp, botById, shortRefId, actorLabel, taskById, activeProject, inSoloContext, pageProject, activeBots, formatNumber, CURRENCY_SYMBOL, formatCost, timeAgo, formatTime, duration, initials, avatar, statusPill, runDot, memberRunDot, runDotHtml, MEMBER_STATUS_TEXT, memorySource, toast, filePolicyOptions } from './modules/util.js'
import { richText, mdPlainSummary, mdChatScope } from './modules/markdown.js'
import { api, loadState, markVisibleChatRead } from './modules/api.js'
import { t, setLanguage } from './modules/i18n.js'
import { typingLingerRowsHtml, applyOptimisticTyping, pruneTypingLinger } from './modules/typing-linger.js'
import { renderMessage, renderDirectMessagesCard, questionBannerView, approvalBannerView, toggleDesktopNotify, focusQuestionCard, focusApprovalCard, notifyNewApprovals, questionDraftOf, questionDraftSelection, questionSelectOption, notifyToggleView, notifyOn, formatApprovalRemaining, approvalUrgent, approvalRemainingFrom, formatApprovalCountdown, approvalProgressRatio, questionRemainingFrom, questionUrgent, formatQuestionCountdown, questionProgressRatio } from './modules/cards.js'
import { renderUsage, usageMode, usageViewTitle, usageTotals, usageWindowText, usageDayTitle, usageSnapshot, usageCurrency, usageBotRow, usageProjectRow, usageListPanel, usageRunRow, usageModelPanel, usageMetricCards, usageDayPanel, usageSection, usagePageHead, exportUsageCsv, switchUsageWindow } from './modules/usage.js'
import { renderSettings, renderGlobal, renderUsageGlobal, renderUsageDomain, renderUsageSolo } from './modules/settings.js'
import { renderChannel, renderSecretsPage } from './modules/global-pages.js'
import { updateAutocomplete, moveAcSelection, closeAutocomplete, applyAutocomplete, currentDraft, pendingImagesFor, attachImageButton, composerImageStrip, resolveImageMediaType, addPendingImages, removePendingImage, thumbnailFallback, ensureComposerImageInput, parseFileUriList, insertTextAtCursor, hydrateMessageImageThumbs, ensureImageViewer, openMessageImage, closeImageViewer, openInlineImage, COMPOSER_AUTO_MAX_PX, composerPanelCap, applyComposerHeight, syncComposerBox, sendMessage, saveTaskFromForm } from './modules/composer.js'
import { renderTasks, renderTerminal, renderBotsOverview, renderMembers, renderSkills, renderMemory, renderEvolution, taskGroupKey, taskChildrenKey, terminalOutputText, searchMemories, currentSkillVersion, skillVersions } from './modules/tasks.js'
import { overlayOpen, markAppRenderPending, renderModalLayer, ensureModalRoot, noteModalScroll, flushAppRender } from './modules/modal-layer.js'
import { openModal, closeModal, openTask, openSkillDetail, openTrajectory, openBot, reloadTaskModal, bindProposalForm, updateEffortOptions, updateFallbackEffortOptions, trapModalFocus, renderDirPicker, closeDirPicker, parseFallbackFields, normalizeTimeBudgetMinutes, modelOptions, effortOptions, fallbackModelOptions, renderPriceCard } from './modules/modal-forms.js'
import { activeTypingRuns, typingRows, chatKey, mergedChatMessages, canLoadOlder, loadOlderButton, loadOlderMessages, renderChatMembersCard, renderChat, DISPATCH_LIST_LIMIT, dispatchListNote, dispatchTaskRow, dispatchRunRow, renderSoloChat, loadSoloDetail, renderSoloConfig } from './modules/chat.js'
import { handleBoardAction } from './modules/events-board.js'
import './modules/events-click.js'
import './modules/events-submit.js'
import './modules/events-misc.js'
// 全局一级视图集合：侧栏直达、无项目 tab（usage 的 global 模式另算，见 isGlobal）。
const GLOBAL_VIEWS = new Set(['global', 'bots-overview', 'channel', 'secrets'])
const app = document.getElementById('app') as unknown as Document & { className: string; innerHTML: string }
const UI_SCALE_KEY = 'dshb:ui-scale'
const UI_THEME_KEY = 'dshb:ui-theme'

// 任务分组默认全展开（DSHBOTS-58）：把各分组的展开态 key 预置进 state.openPanels，
// 与 <details data-panel> 同一套通道（key 形如 task-group:<status>），折叠即从集合里删掉。
for (const status of STATUS_ORDER) state.openPanels.add(taskGroupKey(status))

if (window.matchMedia?.('(max-width: 980px)').matches) state.tree = { chats: false, bots: false } as typeof state.tree
const savedScale = (() => {
  try { return Number(localStorage.getItem(UI_SCALE_KEY)) || null } catch { return null }
})()
if (savedScale) applyUiScale(savedScale)
state.theme = applyUiTheme((() => {
  try { return localStorage.getItem(UI_THEME_KEY) } catch { return null }
})())

// UI 语言跟随 DSH 宿主 Language 设定（DSHBOTS-120）：服务端把解析结果（zh/en/auto）
// 注入 <html data-dsh-language>，模块加载即设定语言并替换静态 boot 文案（CSP 禁内联
// 脚本，故在 JS 里替换而非 index.html 内联）。
setLanguage(document.documentElement.dataset.dshLanguage || 'auto')
{
  const bootCopy = document.querySelector('.boot-copy')
  if (bootCopy) bootCopy.textContent = t('boot.connecting')
  const skipLink = document.querySelector('.skip-link')
  if (skipLink) skipLink.textContent = t('a11y.skipToContent')
}

// state.language（服务端 state() 顶层同源透传）与上次不一致时热切换：换字典 + 轻提示，
// 下次 render 生效；首载只对齐不提示。render() 全量重建，滚动/弹窗由既有遮罩机制保持。
function syncLanguage() {
  const language = state.data?.language
  if (!language || language === (state as { uiLanguage?: string }).uiLanguage) return
  const first = (state as { uiLanguage?: string }).uiLanguage === undefined
  ;(state as { uiLanguage?: string }).uiLanguage = language
  setLanguage(language)
  if (!first) {
    toast(t('toast.languageSwitched'), 'success')
    render()
  }
}

async function refresh({ quiet = false } = {}) {
  try {
    await loadState(state.projectId, { quiet })
    syncLanguage()
    // 遮罩开着时 render() 内部跳过整页重建并记 pending（DSHBOTS-98），遮罩关闭后补渲染。
    render()
  } catch (error) {
    if (!state.data) bootError(error)
  }
}

// 微信扫码/验证码期间轮询通道状态，状态落地即停。
function startWechatPoll() {
  stopWechatPoll()
  state.wechatPollTimer = setInterval(async () => {
    try {
      const status = await api('wechat_status', {}, { quiet: true })
      const changed = JSON.stringify(status) !== JSON.stringify(state.data?.wechat)
      if (state.data) state.data.wechat = status
      if (['connected', 'needs_reauth', 'unbound'].includes(status.phase)) {
        stopWechatPoll()
        if (status.phase === 'connected') {
          state.wechatAuth = null
          toast(t('toast.wechatConnected'), 'success')
        }
        render()
      } else if (changed && state.view === 'channel') {
        render()
      }
    } catch {}
  }, 3000)
}

function stopWechatPoll() {
  if (state.wechatPollTimer) clearInterval(state.wechatPollTimer)
  state.wechatPollTimer = null
}

// 终端运行中把轮询提速到 1s：只直更输出区，不整页重渲染（避免打断正在输入的命令）。
// 命令结束（active 消失）即停，回落到常规 2.8s poll。
function startTerminalPoll() {
  stopTerminalPoll()
  state.terminalPollTimer = setInterval(async () => {
    if (!state.projectId || state.busy > 0 || state.modal || document.hidden) return
    try {
      const terminal = await api('terminal_state', { projectId: state.projectId }, { quiet: true })
      if (state.data) state.data.terminal = terminal
      if (state.view === 'terminal') updateTerminalDom(terminal)
      if (!terminal.active) {
        stopTerminalPoll()
        await refresh({ quiet: true })
      }
    } catch {}
  }, 1000)
}

function stopTerminalPoll() {
  if (state.terminalPollTimer) clearInterval(state.terminalPollTimer)
  state.terminalPollTimer = null
}

// 每次渲染后按「当前是否处于终端视图且有活跃命令」同步轮询启停。
function syncTerminalPoll() {
  if (state.view === 'terminal' && state.data?.terminal?.active) startTerminalPoll()
  else stopTerminalPoll()
}

// 轮询落地的轻量 DOM 更新：输出区滚动跟随新输出；状态徽标/历史等结构性变化交给整页渲染。
function updateTerminalDom(terminal) {
  const outputEl = document.getElementById('terminal-output')
  if (outputEl) {
    const text = terminalOutputText(terminal)
    if (outputEl.textContent !== text) {
      outputEl.textContent = text
      outputEl.scrollTop = outputEl.scrollHeight
      // 空态占位是 pre 之外的独立层，有输出时收起，避免遮住首屏内容。
      const emptyEl = document.querySelector('.terminal-output-empty') as HTMLElement
      if (emptyEl) emptyEl.hidden = Boolean(text)
    }
  }
}

function bootError(error) {
  app.className = 'boot-screen'
  app.innerHTML = `<div class="boot-mark">${icon('alert')}</div>
    <div style="text-align:center;max-width:440px">
      <div class="boot-error-title">${t('boot.errorTitle')}</div>
      <div class="boot-error-msg">${esc(error?.message ?? error)}</div>
      <div class="btn-row" style="justify-content:center;margin-top:18px">
        <button class="btn primary" data-action="retry-boot">${icon('refresh')}${t('boot.retry')}</button>
        <a class="btn" href="/">${t('boot.backToDsh')}</a>
      </div>
    </div>`
}

function isTyping() {
  const el = document.activeElement as HTMLElement
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

// poll-typing-gate:start —— 轮询渲染闸门的纯逻辑（tests/chat-typing-refresh.test.js 抽取此块断言）
// 「焦点在输入控件」≠「正在输入」：composer（聊天输入框）只在静默窗内有输入事件、或 IME 组词中时
// 才挡整页渲染（保住正在打的字与光标），静默即放行，让「正在思考与回复…」随轮询自动清出；
// 其余输入控件维持原「焦点即挡」语义（保护表单填写中途不被重建吞值）；无焦点/按钮不挡。
const COMPOSER_IDLE_MS = 2000

function pollRenderBlockedByFocus(activeElement, { composing, composerInputAt, now = Date.now() }) {
  const el = activeElement
  if (!el) return false
  if (el.id === 'composer-input') {
    if (composing) return true
    return now - (composerInputAt ?? 0) < COMPOSER_IDLE_MS
  }
  return Boolean(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
// poll-typing-gate:end

function pendingProposals(kind = null) {
  return (state.data?.proposals ?? []).filter(item => item.status === 'pending' && (!kind || item.kind === kind)).length
}

// 需要人工操作的事项才亮红点：待验收任务、待审提案、待审技能提案
function tabDot(view) {
  const project = activeProject()
  if (view === 'tasks') return (project?.stats?.inReview ?? 0) > 0
  if (view === 'evolution') return pendingProposals() > 0
  if (view === 'skills') return pendingProposals('skill') > 0
  return false
}

// STATUS/RUN_STATUS/RUN_KIND 的渲染标签：表内有键走 t()，表外原样回落（保持旧 ?? 兜底语义）。
function statusLabel(status) {
  return STATUS[status] ? t('status.' + status) : status
}

// 侧栏任务行的状态标签：status === 'in_progress' 时挂 .task-status-live，
// 摆动动效由 ui/styles.css 的 @keyframes task-status-swim 承担（等效复刻 DSH 原生
// 会话页鱼尾动画），并受 prefers-reduced-motion 闸门约束——本文件只负责挂类名，
// 不在 JS 里做逐帧动画。
function sideRowStatusHtml(status) {
  const live = status === 'in_progress' ? ' task-status-live' : ''
  return `<span class="side-row-status${live}">${esc(statusLabel(status))}</span>`
}

function runStatusLabel(status) {
  return RUN_STATUS[status] ? t('runStatus.' + status) : status
}

function runKindLabel(kind) {
  return RUN_KIND[kind] ? t('runKind.' + kind) : kind
}

function renderShell() {
  const data = state.data
  const solo = inSoloContext()
  // 场景分支：单聊上下文无项目域；群聊上下文 = 当前项目。
  const project = solo ? null : activeProject()
  const pending = pendingProposals()
  // 跨项目待审（DSHBOTS-102）：state 顶层全局口径，与当前项目解耦。
  const pendingApprovals = data?.pendingApprovals ?? { count: 0, items: [] }
  // 跨项目待答提问（DSHBOTS-116）：与审批同口径，顶层全局聚合。
  const pendingQuestions = data?.pendingQuestions ?? { count: 0, items: [] }
  // 侧栏状态行任务口径（DSHBOTS-105）：全库任务 in_progress 计数，不随群聊/单聊上下文跳变；topbar 仍按项目口径。
  const activeTasks = Number(data?.activeTasks ?? 0)
  const projectRunning = project?.stats?.running ?? 0
  const tokenTotal = usageTotals('project').totalTokens ?? 0
  // 全局一级视图（DSHBOTS-197 起含迁移落点页 通道/密钥）：无项目 tab 导航，侧栏直达。
  const isGlobal = GLOBAL_VIEWS.has(state.view) || (state.view === 'usage' && usageMode() === 'global')
  // 单聊是独立于项目的 1V1 上下文：对话/配置/技能/记忆/进化/用量共用一套导航。
  const isSolo = state.view === 'chat' && state.chatMode === 'solo'
  const inSolo = inSoloContext()
  const soloBot = inSolo ? botById(state.soloBotId) : null
  const viewTitle = isSolo
    ? (soloBot ? t('viewTitle.dispatch', { name: soloBot.name }) : t('viewTitle.dispatchPlain'))
    : state.view === 'solo-config' ? (soloBot ? t('viewTitle.config', { name: soloBot.name }) : t('viewTitle.botConfig'))
    : state.view === 'chat' ? (project?.name ?? t('viewTitle.workspace'))
    : state.view === 'tasks' ? t('viewTitle.tasks')
    : state.view === 'members' ? t('viewTitle.members')
    : state.view === 'bots-overview' ? t('viewTitle.botsOverview')
    : state.view === 'skills' ? t('viewTitle.skills')
    : state.view === 'memory' ? t('viewTitle.memory')
    : state.view === 'evolution' ? t('viewTitle.evolution')
    : state.view === 'usage' ? usageViewTitle()
    : state.view === 'terminal' ? (project ? t('viewTitle.terminal', { name: project.name }) : t('viewTitle.terminalDefault'))
    : state.view === 'global' ? t('viewTitle.global')
    : state.view === 'channel' ? t('viewTitle.channel')
    : state.view === 'secrets' ? t('viewTitle.secrets')
    : t('viewTitle.projectSettings')
  const title = viewTitle
  const spec = VIEW_ACTION[state.view]
  const cardOwnsPrimary = state.view === 'evolution' && pendingProposals() > 0
  const primary = (!project && !inSolo) || !spec ? '' : spec.submit
    ? `<button class="btn primary" type="submit" form="${spec.submit}">${icon(spec.icon)}<span class="btn-label">${t('viewAction.' + state.view)}</span></button>`
    : `<button class="btn ${cardOwnsPrimary ? '' : 'primary'}" data-action="${spec.action}"${spec.kind ? ` data-kind="${spec.kind}"` : ''}>${icon(spec.icon)}<span class="btn-label">${t('viewAction.' + state.view)}</span></button>`
  const eyebrow = isGlobal
    ? ''
    : inSolo
      ? `${t('eyebrow.botDispatch')}<span class="sep"></span>${t('eyebrow.outsideProject')}`
      : project
        ? `${project.key}<span class="sep"></span>${project.status === 'active' ? t('eyebrow.active') : t('eyebrow.archived')}`
        : t('eyebrow.noProject')
  const chats = data.projects
  // 已归档项目收进侧栏尾部的「已归档」抽屉（默认收起）；群聊组只列进行中的项目。
  const activeChats = chats.filter(item => item.status === 'active')
  const archivedChats = chats.filter(item => item.status !== 'active')
  const bots = data.bots ?? []
  const activeBots = bots.filter(bot => bot.status === 'active')
  const chevron = (open) => `<svg class="chev ${open ? 'open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`
  return `
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="/index.html" title="${t('brand.backToDsh')}">
          <div class="brand-mark">DSH</div>
          <div class="brand-copy"><strong>DSH Team Bots</strong></div>
        </a>
        <div class="tree">
          <div class="tree-group">
            <div class="side-label">
              <button class="tree-toggle" data-action="toggle-tree" data-tree="chats" title="${t('tree.chatsTitle')}">${chevron(state.tree.chats)}<span>${t('tree.chats')}</span></button>
              <span class="tree-count">${activeChats.length}</span>
              <button class="side-add" data-action="new-project" title="${t('tree.newChat')}">${icon('plus')}</button>
            </div>
            ${state.tree.chats ? `<div class="tree-list">
              ${activeChats.length === 0 ? `<div class="side-empty">${t('tree.chatsEmpty')}</div>` : activeChats.map(item => {
                // 未读与待审红点互斥：行尾最多一个红色信号，未读优先（会话流更即时）。
                const unread = Number(item.unreadCount ?? 0)
                const signal = unread > 0
                  ? (unread === 1
                    ? `<span class="red-dot" title="${t('tree.unreadOne')}"></span>`
                    : `<span class="unread-badge" title="${t('tree.unreadMany', { count: unread })}">${unread > 99 ? '99+' : unread}</span>`)
                  : (Number(item.reviewTasks ?? 0) > 0 ? `<span class="red-dot" title="${t('tree.reviewPending')}"></span>` : '')
                return `
                <button class="tree-item chat-item ${item.id === project?.id && !isGlobal && state.chatMode !== 'solo' ? 'active' : ''} ${unread > 0 ? 'has-unread' : ''}" data-action="select-project" data-project-id="${attr(item.id)}" title="${esc(item.name)}">
                  <span class="chat-hash">#</span>
                  <span class="tree-item-name">${esc(item.name)}</span>
                  ${signal}
                  ${Number(item.openTasks ?? 0) > 0 ? `<span class="tree-open-count">${Number(item.openTasks)}</span>` : ''}
                </button>`
              }).join('')}
            </div>` : ''}
          </div>
          <div class="tree-group">
            <div class="side-label">
              <button class="tree-toggle" data-action="toggle-tree" data-tree="bots" title="${t('tree.botsTitle')}">${chevron(state.tree.bots)}<span>Bots</span></button>
              <span class="tree-count">${activeBots.length}</span>
              <button class="side-add" data-action="new-bot" title="${t('tree.newBot')}">${icon('plus')}</button>
            </div>
            ${state.tree.bots ? `<div class="tree-list">
              ${bots.length === 0 ? `<div class="side-empty">${t('tree.botsEmpty')}</div>` : bots.map(bot => `
                <button class="tree-item bot-item ${state.view === 'chat' && state.chatMode === 'solo' && bot.id === state.soloBotId ? 'active' : ''}" data-action="${bot.status === 'active' ? 'solo-bot' : 'edit-bot'}" data-bot-id="${attr(bot.id)}" title="${esc(bot.name)} · ${esc(bot.role || t('common.member'))} · ${esc(bot.modelRef ?? t('common.modelUnset'))}">
                  <span class="avatar sm ${attr(bot.color ?? 'gray')}">${esc(initials(bot.name))}</span>
                  <span class="tree-item-name">${esc(bot.name)}</span>
                  ${bot.openTasks > 0 ? `<span class="tree-open-count">${bot.openTasks}</span>` : ''}
                  ${bot.status !== 'active' ? `<span class="tree-flag">${t('common.archived')}</span>` : ''}
                </button>
              `).join('')}
            </div>` : ''}
          </div>
          <div class="tree-group tree-archived">
            <div class="side-label">
              <button class="tree-toggle" data-action="toggle-tree" data-tree="archived" title="${t('tree.archivedTitle')}">${chevron(state.tree.archived)}<span>${t('tree.archived')}</span></button>
              <span class="tree-count">${archivedChats.length}</span>
            </div>
            ${state.tree.archived ? `<div class="tree-list">
              ${archivedChats.length === 0 ? `<div class="side-empty">${t('tree.archivedEmpty')}</div>` : archivedChats.map(item => `
                <button class="tree-item chat-item archived ${item.id === project?.id && !isGlobal && state.chatMode !== 'solo' ? 'active' : ''}" data-action="select-project" data-project-id="${attr(item.id)}" title="${esc(item.name)} · ${t('tree.archivedHint')}">
                  <span class="chat-hash">#</span>
                  <span class="tree-item-name">${esc(item.name)}</span>
                  <span class="tree-flag">${t('common.archived')}</span>
                </button>
              `).join('')}
            </div>` : ''}
          </div>
        </div>
        <div class="sidebar-bottom">
          <button class="global-config ${state.view === 'bots-overview' ? 'active' : ''}" data-action="nav" data-view="bots-overview">
            ${icon('bot')}<span>${t('sidebar.botsOverview')}</span>${pendingProposals() > 0 ? `<span class="red-dot" title="${t('sidebar.pendingProposals')}"></span>` : ''}
          </button>
          <button class="global-config ${state.view === 'usage' && state.usageMode === 'global' ? 'active' : ''}" data-action="nav" data-view="usage" data-usage-mode="global">
            ${icon('chart')}<span>${t('sidebar.usage')}</span>
          </button>
          <button class="global-config ${state.view === 'channel' ? 'active' : ''}" data-action="nav" data-view="channel">${icon('message')}<span>${t('sidebar.channel')}</span></button>
          <button class="global-config ${state.view === 'secrets' ? 'active' : ''}" data-action="nav" data-view="secrets">${icon('layers')}<span>${t('sidebar.secrets')}</span></button>
          <button class="global-config ${state.view === 'global' ? 'active' : ''}" data-action="nav" data-view="global">
            ${icon('settings')}<span>${t('sidebar.globalConfig')}</span>
          </button>
          <a class="global-config dsh-official-link" href="/index.html" title="${t('sidebar.switchToDsh')}">
            ${icon('external')}<span>${t('sidebar.dshNative')}</span>
          </a>
          <div class="sidebar-meta">
            <span class="dot ${activeTasks ? 'amber' : ''}"></span>
            <span>${activeTasks ? t('sidebar.tasksActive', { count: activeTasks }) : t('sidebar.idle')}</span>
            <span class="sidebar-meta-sep">·</span>
            <span>${t('sidebar.botsCount', { count: activeBots.length })}</span>
            <span class="sidebar-meta-sep">·</span>
            <span>${t('sidebar.pendingReviews', { count: pending })}</span>
          </div>
        </div>
      </aside>
      <main class="main">
        <div class="main-head">
        ${approvalBannerView(pendingApprovals)}
        ${questionBannerView(pendingQuestions)}
        <header class="topbar">
          <div class="topbar-title">
            ${eyebrow ? `<div class="topbar-eyebrow">${eyebrow}</div>` : ''}
            <h1>${esc(title)}</h1>
          </div>
          ${isGlobal || solo || !project ? '' : `<div class="topbar-meta">
            <span><b>${project?.stats?.openTasks ?? 0}</b> ${project?.stats?.openTasks === 1 ? t('topbar.taskOne') : t('topbar.taskMany')}</span>
            <span class="sep"></span>
            <span><b>${projectRunning}</b> ${projectRunning === 1 ? t('topbar.runningOne') : t('topbar.runningMany')}</span>
            <span class="sep"></span>
            <span><b>${formatNumber(tokenTotal)}</b> tokens</span>
          </div>`}
          <div class="topbar-actions">
            ${primary}
            <button class="btn icon" data-action="refresh" title="${t('topbar.refresh')}" aria-label="${t('topbar.refresh')}">${icon('refresh')}</button>
          </div>
        </header>
        ${isGlobal ? '' : `<div class="tabbar" role="tablist" aria-label="${t('topbar.mainNav')}">
          ${(inSolo ? SOLO_NAV : NAV).map(([key, label]) => {
            const dot = tabDot(key)
            // 用量 tab 有三态：群聊 tab=本群口径，单聊 tab=本 bot 口径，侧栏入口=全局视图。
            const tabMode = key === 'usage' ? (inSolo ? 'solo' : 'domain') : null
            const active = state.view === key && (tabMode ? state.usageMode === tabMode : true)
            return `<button class="tab ${active ? 'active' : ''}" role="tab" id="tab-${key}" aria-controls="main-content" aria-selected="${active}" tabindex="${active ? '0' : '-1'}" data-action="nav" data-view="${key}"${tabMode ? ` data-usage-mode="${tabMode}"` : ''}>${t(inSolo && key === 'chat' ? 'nav.soloChat' : 'nav.' + key)}${dot ? `<span class="red-dot" title="${t('topbar.attention')}"></span>` : ''}</button>`
          }).join('')}
        </div>`}
        </div>
        <section class="content" id="main-content" role="tabpanel" tabindex="-1"${isGlobal ? '' : ` aria-labelledby="tab-${state.view}"`}>
          ${renderView()}
        </section>
      </main>
    </div>`
}

function syncChromeHeight() {
  const head = document.querySelector('.main-head') as HTMLElement
  if (!head) return
  const chrome = head.offsetHeight + 48
  document.documentElement.style.setProperty('--chrome-h', `${chrome}px`)
}

// 引用交互专用重渲染：render() 自身已在非贴底时保持消息列表滚动位置（见 render 内 chat-scroll-restore），
// 这里只需在渲染后聚焦输入框，方便接着打字。
function renderKeepingChatScroll() {
  render()
  document.getElementById('composer-input')?.focus()
}

// panel-state:start —— 折叠面板（<details data-panel>）展开态纯逻辑，tests/panel-state.test.js 按本标记块抽取断言。
// key 约定：Bot 私信 dm；技能版本 skill-versions:<slug>；提案差异 proposal:<id>；轨迹条目 traj:<runId>:<index>；运行输出 run-output:<runId>；交付产物 run-artifacts:<runId>。
function panelKey(el) {
  return el?.getAttribute?.('data-panel') || null
}

function isPanelOpen(state, key) {
  return typeof key === 'string' && key.length > 0 && state?.openPanels instanceof Set && state.openPanels.has(key)
}

function panelOpenAttr(state, key) {
  return isPanelOpen(state, key) ? ' open' : ''
}

function applyPanelToggle(state, key, open) {
  if (typeof key !== 'string' || key.length === 0 || !(state?.openPanels instanceof Set)) return state
  if (open) state.openPanels.add(key)
  else state.openPanels.delete(key)
  return state
}
// panel-state:end

// details 开标签公共片段：稳定 key（data-panel，供 toggle 事件定位）+ 依展开态恢复的 open；依赖 attr()，故在纯逻辑标记块之外。
function panelAttrs(state, key) {
  return ` data-panel="${attr(key)}"${panelOpenAttr(state, key)}`
}

// board-scroll-restore —— render() 全量重建 DOM，聊天之外视图的滚动位随之归零：纵向滚动在
// window 层（.main 撑高页面、body 无 overflow），任务看板 .board 另有横向滚动（overflow-x:auto），
// 侧栏 .tree 自身纵向滚动且同样被重建。重建前记下三处、重建后原位恢复，2.8s 轮询不再把滚动中的
// 用户拽回原点。窗口滚动仅在前后两次 render 同视图时恢复，切 tab 不携带上一视图的滚动位；
// 聊天视图维持既有 savedChatScroll / chatAtBottom 逻辑不动。
let lastRenderedView = null

function captureViewScroll(sameView) {
  return {
    windowY: sameView ? window.scrollY : 0,
    boardX: document.querySelector('.board')?.scrollLeft ?? 0,
    treeY: document.querySelector('.tree')?.scrollTop ?? 0,
  }
}

function restoreViewScroll(saved) {
  if (!saved) return
  if (saved.windowY > 0) window.scrollTo(0, saved.windowY)
  if (saved.boardX > 0) {
    const board = document.querySelector('.board')
    if (board) board.scrollLeft = saved.boardX
  }
  if (saved.treeY > 0) {
    const tree = document.querySelector('.tree')
    if (tree) tree.scrollTop = saved.treeY
  }
}

// chat-scroll:start —— 聊天滚动位置的纯逻辑（tests/chat-scroll.test.js 抽取此块断言）
// 判定「当前是否贴在聊天底部」：渲染窗口内（rendering）与已脱离文档的节点（connected=false）一律保持原值，
// 避免把「DOM 重建」误判成「用户上翻」；内容不足一屏时无处可滚，视为贴底；其余按距底部距离与阈值比较。
const CHAT_BOTTOM_THRESHOLD = 80

function nextChatAtBottom({ rendering, connected, current, scrollHeight, scrollTop, clientHeight, threshold = CHAT_BOTTOM_THRESHOLD }) {
  if (rendering) return current
  if (!connected) return current
  if (scrollHeight <= clientHeight) return true
  return scrollHeight - scrollTop - clientHeight < threshold
}
// chat-scroll:end

function render() {
  if (!state.data) return
  // 遮罩闸门（DSHBOTS-98）：弹窗与图片查看器都是半透明遮罩，遮罩开着时整页重建会从
  // 遮罩下透出来（持续闪烁）。此处只记 pending 跳过重建，遮罩关闭时 flushAppRender
  // 补一次渲染，追平遮罩期间取到的新 state。
  if (overlayOpen()) {
    markAppRenderPending()
    return
  }
  state.ac = null
  app.className = ''
  // composer 持焦时的光标快照（DSHBOTS-123）：全量重建会拆走 #composer-input，先记选区与滚动，
  // rAF 收尾恢复焦点与光标，配合轮询渲染闸门静默放行后「边打字边轮询」不打断输入。
  const activeBeforeRebuild = document.activeElement as HTMLInputElement
  const composerCaret = activeBeforeRebuild?.id === 'composer-input' ? {
    start: activeBeforeRebuild.selectionStart ?? 0,
    end: activeBeforeRebuild.selectionEnd ?? 0,
    direction: activeBeforeRebuild.selectionDirection ?? 'forward',
    scrollTop: activeBeforeRebuild.scrollTop ?? 0,
  } : null
  // chat-scroll:view-enter —— 切进聊天视图时确定性贴底：不依赖历史残值。
  // 用户上翻历史后切到别的页面再切回来，一律回到最新一条（DSHBOTS-72）。
  if (state.view === 'chat' && lastRenderedView !== 'chat') state.chatAtBottom = true
  // chat-scroll:render-gate —— 重建 DOM 的窗口内忽略聊天滚动事件：旧 .chat-messages 被拆走时可能补发
  // 一次 scroll 事件，若在此窗口送达会把「重建」误判成「用户上翻」。窗口在 rAF 收尾复位。
  state.rendering = true
  // chat-scroll-restore:mark —— render() 全量重建 DOM，非贴底时先记下消息列表滚动位置，重建后原位恢复；
  // 2.8s 轮询重渲染因此不再把上翻历史的用户拽回顶部；贴底（chatAtBottom）仍走下方 rAF 自动落底。
  const savedChatScroll = document.querySelector('.chat-messages')?.scrollTop ?? null
  const savedViewScroll = captureViewScroll(lastRenderedView === state.view)
  app.innerHTML = renderShell()
  // 附图缩略图：模板嵌缓存命中者，未命中的在此异步补齐（会话级缓存去重，见 hydrateMessageImageThumbs）。
  hydrateMessageImageThumbs(app)
  if (!state.chatAtBottom && savedChatScroll !== null) {
    const fresh = document.querySelector('.chat-messages')
    if (fresh) fresh.scrollTop = savedChatScroll
  }
  restoreViewScroll(savedViewScroll)
  lastRenderedView = state.view
  // modal 层与 #app 解耦（DSHBOTS-90）：render() 只重建 #app，永不写 #modal-root；
  // 这里仅按需同步弹窗层（state.modal 被别处直改或置空时兜底，内容未变则零 DOM 操作）。
  renderModalLayer()
  requestAnimationFrame(() => {
    try {
      syncChromeHeight()
      if (state.view === 'chat') {
        // 全量重建会丢 composer 的内联高度与发送按钮态，先恢复，再处理贴底滚动。
        const composerInput = document.getElementById('composer-input')
        if (composerInput) syncComposerBox(composerInput)
        // 光标续接（DSHBOTS-123）：重建前持焦且已记快照时，把焦点与选区无损放回 composer。
        if (composerCaret && composerInput) {
          composerInput.focus()
          try { (composerInput as HTMLInputElement).setSelectionRange(composerCaret.start, composerCaret.end, composerCaret.direction) } catch {}
          composerInput.scrollTop = composerCaret.scrollTop
        }
        const messages = document.querySelector('.chat-messages')
        if (messages && state.chatAtBottom) messages.scrollTop = messages.scrollHeight
      }
      if (state.view === 'terminal') {
        const outputEl = document.getElementById('terminal-output')
        if (outputEl) outputEl.scrollTop = outputEl.scrollHeight
      }
    } finally {
      // 渲染窗口结束：之后到达的滚动事件才允许更新 chatAtBottom。
      state.rendering = false
    }
  })
  syncTerminalPoll()
}

// 乐观切换（DSHBOTS-167）：目标上下文与已加载数据是否还错开。错开 = 骨架还在等数据。
// 用数据本身判定而非定时器，所以中途到达的轮询响应也能把骨架顶掉，不会卡住。
function chatContextPending() {
  const pending = state.chatPending
  if (!pending) return false
  const dataProject = state.data?.project?.id ?? null
  const dataSolo = state.data?.solo?.bot?.id ?? null
  const wantSolo = pending.chatMode === 'solo' ? (pending.soloBotId ?? null) : null
  return pending.projectId !== dataProject || wantSolo !== dataSolo
}

// 开始一次乐观取数：登记目标上下文并领一个序号（DSHBOTS-167）。
function beginChatPending(pending) {
  const seq = (state.chatRequestSeq += 1)
  state.chatPending = { ...pending, seq }
  // 换上下文时确定性贴底：骨架渲染没有 .chat-messages，旧滚动位无处可落，
  // 不重置会让用户停在新会话顶部。同一上下文重复点击不动滚动。
  const dataProject = state.data?.project?.id ?? null
  const dataSolo = state.data?.solo?.bot?.id ?? null
  const wantSolo = pending.chatMode === 'solo' ? (pending.soloBotId ?? null) : null
  if (pending.projectId !== dataProject || wantSolo !== dataSolo) state.chatAtBottom = true
  return seq
}

// 结束一次乐观取数：只有仍是最新一次才清骨架。连续点击时先发的旧响应若把标志清掉，
// 界面会在新数据到达前闪回上一个上下文，所以必须按序号判定。
function endChatPending(seq) {
  if (state.chatPending?.seq === seq) state.chatPending = null
}

// 切换中的占位视图：不读消息列表、不做 markdown 解析，只给轻量骨架，
// 让点击立即有反馈（DSHBOTS-167）。
function chatPendingView() {
  return `<div class="empty-state">
    <div class="empty-symbol">${icon('message')}</div>
    <h3>${t('chat.loadingOlder')}</h3>
  </div>`
}

function renderView() {
  if (state.view === 'chat' && chatContextPending()) return chatPendingView()
  const body = (() => {
    switch (state.view) {
      case 'tasks': return renderTasks()
      case 'bots-overview': return renderBotsOverview()
      case 'members': return renderMembers()
      case 'skills': return renderSkills()
      case 'memory': return renderMemory()
      case 'evolution': return renderEvolution()
      case 'usage': return renderUsage()
      case 'terminal': return renderTerminal()
      case 'settings': return renderSettings()
      case 'global': return renderGlobal()
      case 'channel': return renderChannel()
      case 'secrets': return renderSecretsPage()
      case 'solo-config': return renderSoloConfig()
      case 'chat':
      default: return renderChat()
    }
  })()
  return body
}

function noProject() {
  return `<div class="empty-state">
    <div class="empty-symbol">${icon('layers')}</div>
    <h3>${t('empty.createProjectFirst')}</h3>
    <button class="btn primary" data-action="new-project">${icon('plus')}${t('empty.newProject')}</button>
  </div>`
}

function formPayload(form) {
  return Object.fromEntries(new FormData(form).entries())
}


async function poll() {
  // 遮罩打开时照常取数（数据不丢），整页重建由 render() 内部的遮罩闸门跳过（DSHBOTS-98）。
  // 焦点不再挡取数（DSHBOTS-123）：焦点常驻 composer 时若连 fetch 都跳过，运行结束后
  // 「正在思考与回复…」与新消息会一直冻结，直到点击页面令 composer 失焦。焦点只在下方渲染半边设闸。
  if (!state.data || state.busy > 0) return
  // 目录选择器开着或表单有未保存修改时暂停自动刷新：整页重渲染会吞掉选择器与已选/已填的值。
  if (document.querySelector('.dir-picker:not([hidden])') || document.querySelector('form[data-dirty]')) return
  try {
    // 页面隐藏时常规轮询照旧暂停；桌面通知开启则静默拉一份 state 专为审批增量，
    // 不写 state.data、不渲染（避免隐藏时误推已读水位、误重渲染）。
    if (document.hidden) {
      if (!notifyOn()) return
      const data = await api('state', { projectId: state.projectId || undefined }, { quiet: true })
      notifyNewApprovals(data?.approvals ?? [])
      return
    }
    await loadState(state.projectId, { quiet: true })
    // 渲染闸门（DSHBOTS-123）：composer 静默窗内有输入或 IME 组词中才挡整页重建，
    // 其余输入控件维持原「焦点即挡」；被挡周期的取数已生效，下一周期自动补渲染。
    if (!pollRenderBlockedByFocus(document.activeElement, { composing: state.composerComposing, composerInputAt: state.composerInputAt })) render()
    notifyNewApprovals(state.data?.approvals ?? [])
  } catch {}
}

async function init() {
  try {
    await loadState(state.projectId)
    syncLanguage()
    if (!state.projectId) state.projectId = state.data.project?.id ?? null
    render()
    if (state.view === 'solo-config') void loadSoloDetail()
    if (state.modal?.type === 'proposal') bindProposalForm()
  } catch (error) {
    state.data = null
    bootError(error)
  }
}

// 窗口尺寸变化会改变面板 61.8% 封顶，composer 高度需重夹取。
window.addEventListener('resize', () => {
  syncChromeHeight()
  const composerInput = document.getElementById('composer-input')
  if (composerInput) applyComposerHeight(composerInput)
})

// 遮罩打开时锁住底层滚动（DSHBOTS-98）：半透明+模糊的遮罩下，底层容器一旦滚动，底页整片
// 移动（backdrop-filter 每帧重算），视觉上就是「全屏闪烁」。落在遮罩上的滚轮一律吞掉；
// 弹窗/查看器面板自身的滚动区放行，配合 CSS 的 overscroll-behavior: contain 防滚动串联。
window.addEventListener('wheel', event => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (!target.closest?.('#modal-root, #image-viewer')) return
  if (target.closest?.('.modal-body, .image-viewer-body')) return
  event.preventDefault()
}, { passive: false })

// modal 滚动守卫信号源（DSHBOTS-154）：scroll 不冒泡但走捕获可及，window 捕获阶段记
// modal-body 滚动时间戳，renderModalLayer 据此在滚动进行中延后正文补丁（见 modal-layer 块）。
window.addEventListener('scroll', event => {
  const target = event.target
  if (!(target instanceof Element)) return
  if (!target.closest?.('.modal-body')) return
  noteModalScroll()
}, { capture: true, passive: true })

// 顶部待审明细菜单（DSHBOTS-102）：点击菜单外任意处收起；面板关着时直接返回，不额外渲染。
document.addEventListener('click', (event) => {
  if (!state.approvalPanelOpen) return
  if ((event.target as HTMLElement).closest?.('.approval-banner')) return
  state.approvalPanelOpen = false
  render()
})

// 聊天图片加载失败占位 chip：error 不冒泡，用捕获阶段全局监听；只处理消息气泡/评论里的
// markdown 图片。chip 只显示文件名（路径查参或 alt 兜底），不复制错误页内容进 DOM。
window.addEventListener('error', (event) => {
  const img = event.target
  if (!(img instanceof HTMLImageElement)) return
  if (!img.closest('.message-bubble, .comment-body')) return
  let name = ''
  try {
    const url = new URL(img.getAttribute('src') ?? '', location.href)
    name = url.searchParams.get('path')?.split('/').pop() ?? url.pathname.split('/').pop() ?? ''
  } catch { name = '' }
  if (!name) name = img.alt?.trim() || '图片'
  const chip = document.createElement('span')
  chip.className = 'md-img-missing'
  chip.textContent = `${name}（图片未能加载）`
  chip.title = '工作区里找不到该图片，或类型/大小不在白名单内'
  img.replaceWith(chip)
}, true)

// proposal 表单随弹窗层落进 #modal-root：改盯弹窗层的子树变化（含原位内容更新），
// #app 的全量重建不再牵动弹窗，也就不再需要靠 app 重建来重绑表单（DSHBOTS-90）。
const observer = new MutationObserver(() => {
  if (state.modal?.type === 'proposal') bindProposalForm()
})
observer.observe(ensureModalRoot(), { childList: true, subtree: true })

// 切回页面立即补一轮轮询（DSHBOTS-123）：隐藏期间常规轮询暂停、state.data 冻结，
// 返回前台不用干等下一个 2.8s 周期，typing 行与新消息即刻追平。
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void poll()
})

// 秒级时钟定点刷新（DSHBOTS-154 抽出共用）：消息流 typing 行、调度页运行行与任务弹窗
// 运行行（runClockSpan 产出的占位）同一通道——只改 textContent，不重建节点。renderModalLayer
// 挂载/补丁后同步调用一次，占位符不会等满 1s 才补上真实时长。
function updateRunClocks(root = document) {
  const overlay = overlayOpen() // 遮罩打开时底页在模糊后不可见：底页时钟跳过（DSHBOTS-210），只刷弹窗层
  for (const el of root.querySelectorAll('.run-clock[data-started]') as NodeListOf<HTMLElement>) {
    if (overlay && !el.closest('#modal-root')) continue
    el.textContent = duration(el.dataset.started)
  }
}

setInterval(() => { void poll() }, 2800)
setInterval(() => {
  updateRunClocks()
  // 遮罩打开时底页整体冻结（DSHBOTS-210）：下述刷新只写 #app，而 #app 是 backdrop-filter 的输入。
  if (overlayOpen()) return
  // 终态气泡到期摘除与淡出刷新（DSHBOTS-150）：只动气泡节点，不整页重建（不打断输入中的草稿）。
  pruneTypingLinger()
  // 审批倒计时局部刷新（DSHBOTS-102）：只改文本与危险色，不整卡重绘（2.8s 轮询会打断跳动感）。
  for (const el of document.querySelectorAll('.approval-clock[data-expires], .approval-menu-time[data-expires]') as NodeListOf<HTMLElement>) {
    const remaining = approvalRemainingFrom(el.dataset.expires)
    // 卡片内 .approval-clock 用 V2 倒计时文案（剩余 X 分 Y 秒），顶部窄条沿用「X 分后自动拒绝」。
    el.textContent = el.classList.contains('approval-menu-time') ? formatApprovalRemaining(remaining) : formatApprovalCountdown(remaining)
    el.classList.toggle('urgent', approvalUrgent(remaining))
  }
  // 卡片倒计时外层：图标随临期转黄（DSHBOTS-108）。
  for (const el of document.querySelectorAll('.approval-countdown[data-expires]') as NodeListOf<HTMLElement>) {
    el.classList.toggle('urgent', approvalUrgent(approvalRemainingFrom(el.dataset.expires)))
  }
  // 卡片进度条：剩余越多条越长，临期变短并转黄（DSHBOTS-108）。
  for (const el of document.querySelectorAll('.approval-progress[data-expires]') as NodeListOf<HTMLElement>) {
    const remaining = approvalRemainingFrom(el.dataset.expires)
    const ratio = approvalProgressRatio(remaining, el.dataset.window)
    const fill = el.querySelector('.approval-progress-fill') as HTMLElement
    if (fill) fill.style.width = `${Math.round(ratio * 100)}%`
    el.classList.toggle('urgent', approvalUrgent(remaining))
    el.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }
  // 提问倒计时局部刷新（DSHBOTS-116）：与审批同口径，只改文本与危险色，不整卡重绘。
  for (const el of document.querySelectorAll('.question-clock[data-expires], .question-menu-time[data-expires]') as NodeListOf<HTMLElement>) {
    const remaining = questionRemainingFrom(el.dataset.expires)
    // 卡片与顶部窄条都用同一「剩余 X 分 Y 秒」口径（提问没有审批那种「自动拒绝」语义）。
    el.textContent = formatQuestionCountdown(remaining)
    el.classList.toggle('urgent', questionUrgent(remaining))
  }
  for (const el of document.querySelectorAll('.question-countdown[data-expires]') as NodeListOf<HTMLElement>) {
    el.classList.toggle('urgent', questionUrgent(questionRemainingFrom(el.dataset.expires)))
  }
  for (const el of document.querySelectorAll('.question-progress[data-expires]') as NodeListOf<HTMLElement>) {
    const remaining = questionRemainingFrom(el.dataset.expires)
    const ratio = questionProgressRatio(remaining, el.dataset.window)
    const fill = el.querySelector('.question-progress-fill') as HTMLElement
    if (fill) fill.style.width = `${Math.round(ratio * 100)}%`
    el.classList.toggle('urgent', questionUrgent(remaining))
    el.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }
}, 1000)
void init()

// DSHBOTS-15 批次3：IIFE 包裹已拆除（模块作用域等价于原 IIFE 私有作用域，模块天然 strict）。
// 以下导出仅供后续批次外迁的 ui/modules/*.js 反向依赖（调用期解析）；随各域搬出逐步收缩。
export { app, UI_SCALE_KEY, UI_THEME_KEY, savedScale, refresh, startWechatPoll, stopWechatPoll, startTerminalPoll, stopTerminalPoll, syncTerminalPoll, updateTerminalDom, bootError, isTyping, pendingProposals, tabDot, renderShell, syncChromeHeight, renderKeepingChatScroll, panelKey, isPanelOpen, panelOpenAttr }
export { applyPanelToggle, panelAttrs, lastRenderedView, captureViewScroll, restoreViewScroll, CHAT_BOTTOM_THRESHOLD, nextChatAtBottom, render, renderView, noProject, runStatusLabel, sideRowStatusHtml, runKindLabel, chatContextPending, beginChatPending, endChatPending }
export { observer, updateRunClocks, init, syncLanguage, formPayload }
