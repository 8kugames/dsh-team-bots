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
import { updateAutocomplete, moveAcSelection, closeAutocomplete, applyAutocomplete, currentDraft, pendingImagesFor, attachImageButton, composerImageStrip, resolveImageMediaType, addPendingImages, removePendingImage, thumbnailFallback, ensureComposerImageInput, parseFileUriList, insertTextAtCursor, hydrateMessageImageThumbs, ensureImageViewer, openMessageImage, closeImageViewer, openInlineImage, COMPOSER_AUTO_MAX_PX, composerPanelCap, applyComposerHeight, syncComposerBox, sendMessage, saveTaskFromForm } from './modules/composer.js'
import { renderTasks, renderTerminal, renderBotsOverview, renderMembers, renderSkills, renderMemory, renderEvolution, taskGroupKey, taskChildrenKey, terminalOutputText, searchMemories, currentSkillVersion, skillVersions } from './modules/tasks.js'
import { overlayOpen, markAppRenderPending, renderModalLayer, ensureModalRoot, noteModalScroll, flushAppRender } from './modules/modal-layer.js'
import { openModal, closeModal, openTask, openSkillDetail, openTrajectory, openBot, reloadTaskModal, bindProposalForm, updateEffortOptions, updateFallbackEffortOptions, trapModalFocus, renderDirPicker, closeDirPicker, parseFallbackFields, normalizeTimeBudgetMinutes, modelOptions, effortOptions, fallbackModelOptions, renderPriceCard } from './modules/modal-forms.js'
import { activeTypingRuns, typingRows, chatKey, mergedChatMessages, canLoadOlder, loadOlderButton, loadOlderMessages, renderChatMembersCard, renderChat, DISPATCH_LIST_LIMIT, dispatchListNote, dispatchTaskRow, dispatchRunRow, renderSoloChat, loadSoloDetail, renderSoloConfig } from './modules/chat.js'
const app = document.getElementById('app')
const UI_SCALE_KEY = 'dshb:ui-scale'
const UI_THEME_KEY = 'dshb:ui-theme'

// 任务分组默认全展开（DSHBOTS-58）：把各分组的展开态 key 预置进 state.openPanels，
// 与 <details data-panel> 同一套通道（key 形如 task-group:<status>），折叠即从集合里删掉。
for (const status of STATUS_ORDER) state.openPanels.add(taskGroupKey(status))

if (window.matchMedia?.('(max-width: 980px)').matches) state.tree = { chats: false, bots: false }
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
  if (!language || language === state.uiLanguage) return
  const first = state.uiLanguage === undefined
  state.uiLanguage = language
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
      } else if (changed && state.view === 'settings') {
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
      const emptyEl = document.querySelector('.terminal-output-empty')
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
  const el = document.activeElement
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
  const isGlobal = state.view === 'global' || state.view === 'bots-overview' || (state.view === 'usage' && usageMode() === 'global')
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
  const head = document.querySelector('.main-head')
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
  const activeBeforeRebuild = document.activeElement
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
          try { composerInput.setSelectionRange(composerCaret.start, composerCaret.end, composerCaret.direction) } catch {}
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

async function refreshAfterTask(taskId) {
  await loadState(state.projectId, { quiet: true })
  await reloadTaskModal(taskId)
}

document.addEventListener('click', async (event) => {
  // 正文内嵌图（markdown <img>）没有 data-action：先于动作委托拦截，点击直接放大；
  // 附图缩略图在 .message-bubble 外，不受此分支影响，仍走 view-message-image 进查看器。
  const bubbleImg = event.target.closest?.('.message-bubble img')
  if (bubbleImg) {
    event.preventDefault()
    openInlineImage(bubbleImg)
    return
  }
  const target = event.target.closest('[data-action]')
  if (!target) return
  const action = target.dataset.action
  if (action === 'modal-backdrop') {
    if (event.target === target) closeModal()
    return
  }
  try {
    switch (action) {
      case 'retry-boot':
        state.bootError = null
        await init()
        break
      case 'nav': {
        // 带 data-project-id 的导航：从调度页的任务行跳到该项目的任务页（顺带切回群聊上下文）。
        const navProjectId = target.dataset.projectId
        state.view = target.dataset.view || 'chat'
        // 用量页三态（DSHBOTS-56）：侧栏入口=全局视图（与上下文零耦合）；群聊 tab=本群；单聊 tab=本 bot。
        // 口径由入口决定，不再按当前上下文收敛。
        if (state.view === 'usage') {
          state.usageMode = target.dataset.usageMode === 'solo' || target.dataset.usageMode === 'domain'
            ? target.dataset.usageMode
            : 'global'
          state.usageScope = 'global'
          state.usageBot = null
        }
        if (navProjectId) {
          state.projectId = navProjectId
          state.chatMode = 'group'
          state.replyTo = null
          await refresh()
          break
        }
        if (state.view === 'solo-config') void loadSoloDetail()
        render()
        break
      }
      case 'toggle-tree': {
        const key = target.dataset.tree
        if (key && key in state.tree) {
          state.tree[key] = !state.tree[key]
          render()
        }
        break
      }
      case 'toggle-task-group': {
        // 分组折叠（DSHBOTS-58）：展开态记在 state.openPanels（key: task-group:<status>），默认全展开。
        const status = target.dataset.status
        if (!status) break
        const key = taskGroupKey(status)
        if (state.openPanels.has(key)) state.openPanels.delete(key)
        else state.openPanels.add(key)
        render()
        break
      }
      case 'toggle-task-children': {
        // 子任务折叠（DSHBOTS-58）：展开态记在 state.openPanels（key: task-children:<taskId>），默认收起。
        const taskId = target.dataset.taskId
        if (!taskId) break
        const key = taskChildrenKey(taskId)
        if (state.openPanels.has(key)) state.openPanels.delete(key)
        else state.openPanels.add(key)
        render()
        break
      }
      case 'reset-scale': {
        const scale = applyUiScale(1)
        try { localStorage.setItem(UI_SCALE_KEY, String(scale)) } catch {}
        render()
        break
      }
      case 'set-theme': {
        state.theme = applyUiTheme(target.dataset.theme)
        try { localStorage.setItem(UI_THEME_KEY, state.theme) } catch {}
        render()
        break
      }
      case 'toggle-notify': {
        await toggleDesktopNotify()
        break
      }
      case 'save-settings': {
        const value = id => document.getElementById(id)?.value ?? ''
        const patch = {
          budget_currency: value('settings-currency'),
          memory_review: value('settings-memory-review'),
          global_token_budget: value('settings-global-token-budget'),
          global_cost_budget: value('settings-global-cost-budget'),
          retention_usage_days: value('settings-retention-usage'),
          retention_run_event_days: value('settings-retention-run'),
          retention_message_days: value('settings-retention-message'),
        }
        await api('update_settings', patch)
        await loadState(state.projectId)
        toast('系统设置已保存', 'success')
        break
      }
      // 界面语言（DSHBOTS-162）：保存后 loadState 拿回新的 state.language，
      // 由既有 syncLanguage 热切换（换字典 + toast.languageSwitched + render），无需重启。
      case 'save-ui-language': {
        const value = document.getElementById('settings-ui-language')?.value ?? 'auto'
        await api('update_settings', { ui_language: value })
        await loadState(state.projectId)
        toast(t('toast.uiLanguageSaved'), 'success')
        break
      }
      case 'save-run-limits': {
        const value = id => document.getElementById(id)?.value ?? ''
        await api('update_settings', {
          run_timeout_minutes: value('settings-run-timeout'),
          stall_watchdog_minutes: value('settings-stall-watchdog'),
        })
        await loadState(state.projectId)
        toast('运行时效已保存', 'success')
        break
      }
      case 'reconcile-usage': {
        const result = await api('reconcile_usage', {})
        const reconciliation = result?.reconciliation ?? {}
        toast(`对账完成：检查 ${reconciliation.runsChecked ?? 0} 个运行，差异 ${reconciliation.mismatched ?? 0} 个`, 'success')
        await loadState(state.projectId)
        break
      }
      case 'check-dsh-update': {
        state.dshUpdate = await api('dsh_update_info', {})
        render()
        break
      }
      case 'wechat-login': {
        const result = await api('wechat_login', {})
        state.wechatAuth = { qrSvg: result.qrSvg, qrCodeUrl: result.qrCodeUrl }
        toast('二维码已生成，请用微信扫码', 'success')
        startWechatPoll()
        render()
        break
      }
      case 'wechat-code': {
        const code = document.getElementById('wechat-code')?.value?.trim()
        if (!code) {
          toast('请输入微信验证码', 'error')
          break
        }
        await api('wechat_code', { code })
        state.wechatAuth = null
        toast('验证码已提交', 'success')
        startWechatPoll()
        break
      }
      case 'wechat-logout': {
        if (!window.confirm('退出绑定后需要重新扫码才能恢复推送。确认退出？')) break
        await api('wechat_logout', {})
        state.wechatAuth = null
        stopWechatPoll()
        await refresh({ quiet: true })
        toast('已退出微信绑定', 'success')
        break
      }
      case 'select-project':
        state.projectId = target.dataset.projectId
        state.replyTo = null // 切项目即切群聊，引用不能跨项目
        state.chatMode = 'group'
        state.view = 'chat'
        // 乐观切换（DSHBOTS-167）：先出骨架让点击立即有反馈，再异步取数落真实列表。
        const pendingSeq = beginChatPending({ projectId: state.projectId, chatMode: 'group', soloBotId: null })
        render()
        try {
          await refresh()
        } finally {
          // refresh 成功时内部已 render；只有它没落真实内容（取数失败或项目回退到别的项目）
          // 时才补一次，否则骨架会一直停在那里。
          const stuckOnSkeleton = chatContextPending()
          endChatPending(pendingSeq)
          if (stuckOnSkeleton) render()
        }
        break
      case 'refresh':
        await refresh()
        break
      case 'close-modal':
        closeModal()
        break
      case 'new-project':
        openModal({ type: 'new-project' })
        break
      case 'new-bot':
        openModal({ type: 'new-bot' })
        break
      case 'new-task': {
        if (!activeProject()) {
          toast('请先创建项目', 'error')
          break
        }
        openModal({ type: 'new-task' })
        break
      }
      // 派生子任务（D-63）：从任务详情 footer 进入，复用新建任务表单并预填 parentTaskId；
      // 任何任务都可派生（子任务同样可以作为父任务），不加额外限制。
      case 'derive-subtask': {
        if (!activeProject()) {
          toast('请先创建项目', 'error')
          break
        }
        const parentId = target.dataset.taskId || ''
        if (!parentId || !(state.data?.tasks ?? []).some(task => task.id === parentId)) {
          toast('父任务不存在或已刷新，请重试', 'error')
          break
        }
        openModal({ type: 'new-task', parentTaskId: parentId })
        break
      }
      case 'new-memory':
        if (!activeProject()) {
          toast('请先创建项目', 'error')
          break
        }
        openModal({ type: 'memory', memory: null })
        break
      case 'new-proposal':
        if (!activeProject()) {
          toast('请先创建项目', 'error')
          break
        }
        openModal({ type: 'proposal', kind: target.dataset.kind || 'bot_update' })
        break
      case 'new-price':
        openModal({ type: 'price' })
        break
      case 'edit-price': {
        const model = target.dataset.model
        const provider = target.dataset.provider ?? ''
        const price = (state.data?.prices ?? []).find(item => item.model === model && (item.provider ?? '') === provider)
        openModal({ type: 'price', price: price ?? { model, provider } })
        break
      }
      case 'reset-price': {
        const model = target.dataset.model
        if (!window.confirm(`把 ${model} 的价格恢复为配置默认值？`)) break
        await api('reset_price', { provider: target.dataset.provider ?? '', model })
        closeModal()
        await loadState(state.projectId, { quiet: true })
        render()
        toast(`${model} 已恢复默认价格`, 'success')
        break
      }
      case 'open-task':
        await openTask(target.dataset.taskId)
        break
      case 'open-trajectory':
        await openTrajectory(target.dataset.runId)
        break
      case 'edit-bot':
        await openBot(target.dataset.botId)
        break
      case 'send-message':
        await sendMessage()
        break
      case 'load-older':
        await loadOlderMessages()
        break
      case 'approval-decide': {
        // 群聊审批卡片按钮：本地立即回显已决状态（不等 2.8s 轮询），请求失败回滚并提示。
        const approvalId = target.dataset.approvalId
        const decision = target.dataset.decision
        if (!approvalId || !['allow', 'reject'].includes(decision)) break
        // 幂等：同一审批正在决策中时不再发请求（按钮已 disabled，这里再挡一层）。
        if (state.approvalDeciding.has(approvalId)) break
        const list = state.data?.approvals ?? []
        const index = list.findIndex(item => item.id === approvalId)
        const previous = index >= 0 ? { ...list[index] } : null
        const status = decision === 'allow' ? 'allowed' : 'rejected'
        state.approvalDeciding.add(approvalId)
        // 乐观回显：卡片立刻变已决，顶部徽标同步减一。
        if (previous) list[index] = { ...previous, status, decided_at: new Date().toISOString(), remainingMs: 0 }
        const pending = state.data?.pendingApprovals
        if (pending) {
          pending.items = (pending.items ?? []).filter(item => item.id !== approvalId)
          pending.count = Math.max(0, Number(pending.count ?? 0) - 1)
        }
        render()
        try {
          // 用后端返回的终态覆盖乐观值（decided_at 以后端为准）。
          const updated = await api('approval_decide', { approvalId, decision }, { quiet: true })
          if (updated && index >= 0) list[index] = updated
          else if (updated) list.push(updated)
        } catch (error) {
          // 回滚到决策前状态，避免「界面已决、后端仍 pending」的假成功。
          if (previous && index >= 0) list[index] = previous
          const rollback = state.data?.pendingApprovals
          if (rollback && previous) {
            rollback.items = [previous, ...(rollback.items ?? [])]
            rollback.count = Number(rollback.count ?? 0) + 1
          }
          toast(error?.message ? `审批失败：${error.message}` : '审批失败，请重试', 'error')
        } finally {
          state.approvalDeciding.delete(approvalId)
          render()
        }
        break
      }
      case 'toggle-approvals':
        // 顶部「待处理审批」条：展开/收起跨项目明细。
        state.approvalPanelOpen = !state.approvalPanelOpen
        render()
        break
      case 'focus-approval': {
        // 点明细跳到对应项目群聊并滚动到该审批卡（复用 focusApprovalCard）。
        const item = (state.data?.pendingApprovals?.items ?? []).find(entry => entry.id === target.dataset.approvalId)
        if (!item) break
        state.approvalPanelOpen = false
        focusApprovalCard(item)
        break
      }
      case 'question-option': {
        // 选项切换：只改本地草稿与按钮态，不整页重绘（保住同卡内其它输入框的焦点与内容）。
        const questionId = target.dataset.questionId
        const label = target.dataset.label
        if (!questionId || label === undefined) break
        const draft = state.questionDraft.get(questionId)
        const question = (state.data?.questions ?? []).find(entry => entry.id === questionId)
        const item = question?.questions?.find(entry => entry.id === target.dataset.itemId)
        if (!draft || !item) break
        const selectedOf = questionSelectOption(draft, item, label, target.dataset.multi === '1')
        const group = target.closest('.question-options')
        if (group) {
          for (const btn of group.querySelectorAll('.question-option')) {
            const on = selectedOf.has(btn.dataset.label)
            btn.classList.toggle('is-selected', on)
            btn.setAttribute('aria-pressed', on ? 'true' : 'false')
          }
        }
        break
      }
      case 'question-submit': {
        // 提交回答：本地草稿 + 卡片内补充说明合成宿主 {answers:[{id,selected,custom}]}。
        const questionId = target.dataset.questionId
        if (!questionId || state.questionAnswering.has(questionId)) break
        const question = (state.data?.questions ?? []).find(entry => entry.id === questionId)
        if (!question || question.status !== 'pending') break
        const items = Array.isArray(question.questions) ? question.questions : []
        const draft = state.questionDraft.get(questionId) ?? { selected: new Map(), custom: {} }
        const card = target.closest('.question-card')
        const answers = items.map(item => {
          let custom = ''
          if (card) {
            for (const input of card.querySelectorAll('.question-custom')) {
              if (input.dataset.itemId === item.id) { custom = String(input.value ?? '').trim(); break }
            }
          }
          if (!custom) custom = String(draft.custom[item.id] ?? '').trim()
          return { id: item.id, selected: Array.from(questionDraftSelection(draft, item.id)), custom: custom || undefined }
        })
        // 幂等 + 乐观回显：卡片立刻变已答，顶部徽标同步减一。
        state.questionAnswering.add(questionId)
        const list = state.data?.questions ?? []
        const index = list.findIndex(entry => entry.id === questionId)
        const previous = index >= 0 ? { ...list[index] } : null
        if (previous) list[index] = { ...previous, status: 'answered', answered_at: new Date().toISOString(), answer: { answers }, remainingMs: 0 }
        const pending = state.data?.pendingQuestions
        if (pending) {
          pending.items = (pending.items ?? []).filter(entry => entry.id !== questionId)
          pending.count = Math.max(0, Number(pending.count ?? 0) - 1)
        }
        render()
        try {
          // 用后端返回的终态覆盖乐观值（answered_at 以后端为准）。
          const updated = await api('question_answer', { questionId, answers }, { quiet: true })
          if (updated && index >= 0) list[index] = updated
          else if (updated) list.push(updated)
          state.questionDraft.delete(questionId)
        } catch (error) {
          // 回滚到提交前状态，避免「界面已答、后端仍 pending」的假成功。
          if (previous && index >= 0) list[index] = previous
          const rollback = state.data?.pendingQuestions
          if (rollback && previous) {
            rollback.items = [previous, ...(rollback.items ?? [])]
            rollback.count = Number(rollback.count ?? 0) + 1
          }
          toast(error?.message ? `回答失败：${error.message}` : '回答失败，请重试', 'error')
        } finally {
          state.questionAnswering.delete(questionId)
          render()
        }
        break
      }
      case 'toggle-questions':
        // 顶部「待回答提问」条：展开/收起跨项目明细。
        state.questionPanelOpen = !state.questionPanelOpen
        render()
        break
      case 'focus-question': {
        // 点明细跳到对应项目群聊并滚动到该提问卡（复用 focusQuestionCard）。
        const entry = (state.data?.pendingQuestions?.items ?? []).find(item => item.id === target.dataset.questionId)
        if (!entry) break
        state.questionPanelOpen = false
        focusQuestionCard(entry)
        break
      }
      case 'quote-message': {
        // 引用回复：把目标消息挂到 composer 上方的引用条；再点同一条则取消。
        const messageId = target.dataset.messageId
        if (!messageId) break
        state.replyTo = state.replyTo?.id === messageId
          ? null
          : { id: messageId, senderName: target.dataset.senderName ?? '', excerpt: (target.dataset.excerpt ?? '').slice(0, 120) }
        renderKeepingChatScroll()
        break
      }
      case 'cancel-reply':
        state.replyTo = null
        renderKeepingChatScroll()
        break
      case 'attach-image':
        // 打开 body 级单例 file input，选完由 change 事件读文件（accept 已在 input 上限定四种 MIME）。
        ensureComposerImageInput().click()
        break
      case 'remove-pending-image':
        removePendingImage(target.dataset.imageKey)
        break
      case 'view-message-image':
        await openMessageImage(target.dataset.imageId)
        break
      case 'close-image-viewer':
        closeImageViewer()
        break
      case 'solo-bot': {
        const botId = target.dataset.botId
        if (!botId) break
        // 从树上或 Bots 页打开 1V1 对话窗口；已在看同一个会话则不重复加载。
        // 草稿按 solo:<botId> 分开记，切换不清空（群聊/单聊/其他 Bot 各自保留）。
        if (state.soloBotId !== botId) {
          state.soloBotId = botId
          closeAutocomplete()
        }
        state.replyTo = null // 单聊无引用语义，跨上下文不留引用条
        state.chatMode = 'solo'
        state.view = 'chat'
        // 乐观切换（DSHBOTS-167）：先出骨架让点击立即有反馈，再异步取数落真实列表。
        const pendingSeq = beginChatPending({ projectId: state.projectId, chatMode: 'solo', soloBotId: botId })
        render()
        try {
          await loadState(state.projectId, { quiet: true })
        } catch {
          // 取数失败也要清标志并落回上一次可用数据，否则骨架常驻。
        } finally {
          endChatPending(pendingSeq)
        }
        render()
        break
      }
      case 'copy': {
        const value = target.dataset.copy
        if (value) {
          await navigator.clipboard.writeText(value).catch(() => {})
          toast(t('toast.copied'), 'success')
        }
        break
      }
      case 'pick-dir-open': {
        const input = document.getElementById(target.dataset.pickerFor)
        const current = input?.value?.trim() ?? ''
        await renderDirPicker(target.dataset.pickerFor, current.startsWith('/') ? current : '')
        break
      }
      case 'pick-dir-nav': {
        await renderDirPicker(target.dataset.pickerFor, target.dataset.path || '')
        break
      }
      case 'pick-dir-up': {
        const from = target.dataset.path || '/'
        const parent = from.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
        await renderDirPicker(target.dataset.pickerFor, parent)
        break
      }
      case 'pick-dir-home': {
        await renderDirPicker(target.dataset.pickerFor, '')
        break
      }
      case 'pick-dir-choose': {
        const input = document.getElementById(target.dataset.pickerFor)
        if (input && target.dataset.path) {
          input.value = target.dataset.path
          // 程序赋值不触发 input 事件，手动把所属表单标记为未保存，暂停自动刷新直到保存。
          input.closest('form')?.setAttribute('data-dirty', '1')
          closeDirPicker(target.dataset.pickerFor)
        }
        break
      }
      case 'pick-dir-close': {
        closeDirPicker(target.dataset.pickerFor)
        break
      }
      case 'sync-skills': {
        const result = await api('sync_skills', {})
        await loadState(state.projectId, { quiet: true })
        render()
        toast(`已扫描 ${result.count} 个共享技能`, 'success')
        break
      }
      case 'skill-detail': {
        void openSkillDetail(String(target.dataset.slug || ''))
        break
      }
      case 'toggle-skill': {
        const project = activeProject()
        const slug = String(target.dataset.slug || '')
        const disabled = target.dataset.disabled === '1'
        if (!project || !slug) break
        await api('toggle_skill', { projectId: project.id, slug, disabled })
        await loadState(state.projectId, { quiet: true })
        render()
        toast(disabled ? `已在项目「${project.name}」关闭 ${slug}` : `已在项目「${project.name}」恢复 ${slug}`, 'success')
        break
      }
      case 'archive-bot': {
        const botId = target.dataset.botId
        const bot = botById(botId)
        if (!bot || !window.confirm(`归档 ${bot.name}？总监关系必须先解除。`)) break
        await api('archive_bot', { botId })
        closeModal()
        await refresh()
        if (state.view === 'solo-config' && botById(botId)?.status !== 'active') {
          state.view = 'chat'
          state.chatMode = 'group'
        }
        toast('Bot 已归档', 'success')
        break
      }
      case 'rollback-bot': {
        const botId = target.dataset.botId
        if (!window.confirm('回滚到该版本？')) break
        await api('rollback_bot', { botId, revisionId: target.dataset.revisionId })
        await loadState(state.projectId, { quiet: true })
        if (state.view === 'solo-config') {
          await loadSoloDetail()
        } else {
          await openBot(botId)
        }
        toast('已回滚并生成新版本', 'success')
        break
      }
      case 'archive-project': {
        if (!window.confirm('归档项目？项目将停止新运行，工作区文件保留。')) break
        await api('archive_project', { projectId: target.dataset.projectId })
        await refresh()
        toast('项目已归档', 'success')
        break
      }
      case 'reopen-project': {
        await api('reopen_project', { projectId: target.dataset.projectId })
        await refresh()
        toast('项目已再开，恢复为进行中', 'success')
        break
      }
      case 'remove-tracking-open': {
        const item = (state.data?.projects ?? []).find(project => project.id === target.dataset.projectId)
        if (!item) break
        openModal({ type: 'remove-tracking', projectId: item.id, name: item.name, step: 1, purge: false })
        break
      }
      case 'remove-tracking-step2': {
        if (state.modal?.type !== 'remove-tracking') break
        // 复选框状态在翻页时读取一次：第二步的确认文案与最终提交都以此为准。
        state.modal.purge = document.getElementById('remove-tracking-purge')?.checked === true
        state.modal.step = 2
        render()
        break
      }
      case 'remove-tracking-back': {
        if (state.modal?.type !== 'remove-tracking') break
        state.modal.step = 1
        render()
        break
      }
      case 'reject-task': {
        // 驳回（DSHBOTS-141）：终态任务退回 backlog，走 transition_task 通道，与看板拖拽同口径；
        // 后端在离开终态且仍有活跃运行时会拒绝，错误文案直接透出。
        const taskId = target.dataset.taskId
        const task = (state.data?.tasks ?? []).find(item => item.id === taskId)
        if (!window.confirm(t('task.rejectConfirm', { title: task?.title ?? '' }))) break
        try {
          await api('transition_task', { taskId, status: 'backlog' }, { quiet: true })
          await refreshAfterTask(taskId)
          toast(t('task.rejectDone'), 'success')
        } catch (error) {
          toast(error.message || String(error), 'error')
        }
        break
      }
      case 'review-delegate': {
        // 验收核验委派（DSHBOTS-107）：核验运行由后端派生，结论评论落任务；裁决仍走拖卡/验收。
        const taskId = target.dataset.taskId
        await api('task_review_delegate', { taskId })
        await refreshAfterTask(taskId)
        toast('已委派子代理核验，结论将写回任务评论', 'success')
        break
      }
      case 'run-task': {
        const taskId = target.dataset.taskId
        const assignee = await saveTaskFromForm(taskId)
        if (!assignee) {
          toast('请先选择负责人', 'error')
          break
        }
        await api('assign_task', { taskId, botId: assignee })
        await refreshAfterTask(taskId)
        toast('任务已进入执行队列', 'success')
        break
      }
      case 'cancel-run': {
        await api('cancel_run', { runId: target.dataset.runId })
        await refreshAfterTask(target.dataset.taskId || state.modal?.detail?.id)
        toast('运行已取消', 'success')
        break
      }
      case 'retry-run': {
        const run = await api('retry_run', { runId: target.dataset.runId })
        await refreshAfterTask(run.task_id)
        toast('已重新排队', 'success')
        break
      }
      case 'open-artifact': {
        window.open(target.dataset.url, '_blank', 'noopener')
        break
      }
      case 'delete-secret': {
        const name = target.dataset.secretName || '该密钥'
        // DSHBOTS-106 起明文只在批准时一次性物化到数据目录，项目工作区不再有明文密钥文件；
        // 删除即吊销：已下发的一次性运行时副本当场失效，重新使用要再走一次申请与批准。
        if (!window.confirm(`删除密钥 ${name}？相关项目已下发的一次性运行时副本会立即失效，重新使用需再次申请。`)) break
        await api('delete_secret', { secretId: target.dataset.secretId })
        await refresh()
        toast('密钥已删除', 'success')
        break
      }
      case 'deny-secret-request': {
        if (!window.confirm('拒绝该密钥请求？发起的 Bot 会在群里收到系统提示。')) break
        await api('deny_secret_request', { requestId: target.dataset.requestId })
        await refresh()
        toast('已拒绝该密钥请求', 'success')
        break
      }
      case 'delete-memory': {
        if (!window.confirm('归档这条记忆？归档后不会再被 Bot 引用。')) break
        await api('delete_memory', { memoryId: target.dataset.memoryId })
        await refresh()
        toast('记忆已归档', 'success')
        break
      }
      case 'edit-memory': {
        const memory = (state.data?.memories ?? []).find(item => item.id === target.dataset.memoryId)
        if (memory) openModal({ type: 'memory', memory })
        break
      }
      case 'open-invite-member': {
        openModal({ type: 'invite-member', botId: '' })
        break
      }
      case 'remove-member': {
        const botId = target.dataset.botId
        const name = botById(botId)?.name ?? '该成员'
        if (!window.confirm(`确认将 ${name} 移出本项目？移除后不再接收本项目的提及与新任务。`)) break
        await api('remove_member', { projectId: activeProject()?.id, botId })
        await refresh()
        toast('已移出项目', 'success')
        break
      }
      case 'batch-decide-proposals': {
        const decision = target.dataset.decision
        const botId = target.dataset.botId
        const items = (state.data?.proposals ?? [])
          .filter(item => item.status === 'pending' && (item.bot_id ?? '') === botId)
        if (items.length === 0) break
        const bot = botById(botId)
        const label = decision === 'approved' ? '通过并应用' : '拒绝'
        if (!window.confirm(`确认${label} ${bot?.name ?? '未归属 Bot'} 的全部 ${items.length} 条待审提案？`)) break
        for (const item of items) {
          await api('decide_proposal', { proposalId: item.id, decision })
        }
        await refresh()
        toast(`已批量${label} ${items.length} 条提案`, 'success')
        break
      }
      case 'decide-proposal': {
        const decision = target.dataset.decision
        const label = decision === 'approved' ? '通过并应用' : '拒绝'
        if (!window.confirm(`确认${label}该提案？`)) break
        await api('decide_proposal', { proposalId: target.dataset.proposalId, decision })
        await refresh()
        toast(decision === 'approved' ? '提案已应用' : '提案已拒绝', 'success')
        break
      }
      case 'evaluate-proposal': {
        const verdict = target.dataset.verdict === 'fail' ? 'fail' : 'pass'
        const notes = window.prompt('评估说明（可留空）', '') ?? ''
        await api('evaluate_proposal', { proposalId: target.dataset.proposalId, evaluation: { verdict, notes } })
        await refresh()
        toast(verdict === 'pass' ? '已记录评估结论：通过' : '已记录评估结论：不通过', 'success')
        break
      }
      case 'promote-proposal': {
        if (!window.confirm('确认把灰度提案转正为全量生效？')) break
        await api('promote_proposal', { proposalId: target.dataset.proposalId })
        await refresh()
        toast('提案已转正', 'success')
        break
      }
      case 'usage-window':
        await switchUsageWindow(target.dataset.window)
        break
      case 'usage-scope':
        // 口径切换只属于全局视图；群聊/单聊 tab 的口径由入口固定，不接受切换。
        if (usageMode() !== 'global') break
        state.usageScope = target.dataset.scope
        state.usageBot = null
        render()
        break
      case 'usage-drill':
        state.usageBot = target.dataset.botId || null
        render()
        break
      case 'usage-clear-drill':
        state.usageBot = null
        render()
        break
      case 'export-usage-csv':
        await exportUsageCsv()
        break
      case 'search-memories':
        await searchMemories()
        break
      case 'clear-memory-search':
        state.memoryQuery = ''
        state.memoryResults = null
        render()
        break
      case 'approve-memory':
        await api('approve_memory', { memoryId: target.dataset.memoryId })
        await refresh()
        toast('记忆已通过', 'success')
        break
      case 'reject-memory':
        await api('reject_memory', { memoryId: target.dataset.memoryId })
        await refresh()
        toast('记忆已拒绝', 'success')
        break
      case 'rollback-skill':
        await api('rollback_skill', { slug: target.dataset.slug, version: target.dataset.version })
        await refresh()
        toast(`技能已回滚到 v${target.dataset.version}`, 'success')
        break
      case 'terminal-stop': {
        await api('cancel_command', { commandId: target.dataset.commandId })
        toast('停止信号已发送', 'success')
        break
      }
      case 'terminal-fill': {
        state.terminalDraft = target.dataset.command ?? ''
        const cmdInput = document.getElementById('terminal-cmd-input')
        if (cmdInput && !cmdInput.disabled) {
          cmdInput.value = state.terminalDraft
          cmdInput.focus()
        }
        break
      }
      default:
        break
    }
  } catch (error) {
    toast(error.message || String(error), 'error')
  }
})

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]')
  if (!form) return
  event.preventDefault()
  const type = form.dataset.form
  const payload = formPayload(form)
  try {
    if (type === 'create-project') {
      const result = await api('create_project', {
        name: payload.name,
        key: payload.key || undefined,
        description: payload.description,
        ownerBotId: payload.ownerBotId,
        memberIds: new FormData(form).getAll('memberIds'),
        productionDir: payload.productionDir?.trim() || undefined,
      })
      closeModal()
      state.projectId = result.id
      state.view = 'chat'
      await refresh()
      toast('项目已创建', 'success')
      return
    }
    if (type === 'remove-tracking') {
      // 第二步表单：项目名一致才提交（input 监听门禁已保证按钮可用）。
      await api('remove_project_tracking', {
        projectId: payload.projectId,
        confirmName: payload.confirmName,
        purgeWorkdir: payload.purge === '1',
      })
      closeModal()
      // 移除后若正停在该项目上，回到群聊并让 loadState 重新解析可用项目，避免引用已删除的数据。
      if (state.projectId === payload.projectId) {
        state.projectId = null
        state.view = 'chat'
      }
      await refresh()
      toast('已移除追踪，管理数据已清理', 'success')
      return
    }
    if (type === 'create-bot' || type === 'update-bot') {
      const ref = String(payload.modelRef || '')
      const slash = ref.indexOf('/')
      const provider = slash > 0 ? ref.slice(0, slash) : null
      const model = slash > 0 ? ref.slice(slash + 1) : null
      // 备用模型：留空 = 不启用（三个字段一起清空，由后端按 null 落库）。
      const fallback = parseFallbackFields(payload.fallbackModelRef, payload.fallbackEffort)
      const common = {
        name: payload.name,
        role: payload.role,
        instructions: payload.instructions,
        color: payload.color,
        provider,
        model,
        effort: payload.effort || null,
        filePolicy: payload.filePolicy || undefined,
        fallbackProvider: fallback.fallbackProvider,
        fallbackModel: fallback.fallbackModel,
        fallbackEffort: fallback.fallbackEffort,
      }
      if (type === 'create-bot') {
        await api('create_bot', common)
        toast('Bot 已创建', 'success')
      } else {
        await api('update_bot', { botId: payload.botId, patch: common })
        toast('Bot 配置已更新', 'success')
      }
      closeModal()
      await refresh()
      if (state.view === 'solo-config') await loadSoloDetail()
      return
    }
    if (type === 'invite-member') {
      const botId = String(payload.botId || '')
      // 未选人时不提交，弹窗保持打开（零变更）。
      if (!botId) {
        toast('请先选择一个 Bot', 'error')
        return
      }
      await api('add_member', { projectId: activeProject()?.id, botId })
      closeModal()
      await refresh()
      toast('已邀请加入项目', 'success')
      return
    }
    if (type === 'create-task') {
      // 父任务与依赖任务（DSHBOTS-58）：多选字段用 getAll 取全部选中项；空值即不建关系。
      const blockedBy = new FormData(form).getAll('blockedBy').map(String).filter(Boolean)
      // 时效要求（分钟）：选填；空串/0/负数 → null（整键不传），正数取整数分钟。
      const timeBudgetMinutes = normalizeTimeBudgetMinutes(payload.time_budget_minutes)
      const task = await api('create_task', {
        projectId: payload.projectId,
        title: payload.title,
        description: payload.description,
        assigneeBotId: payload.assigneeBotId || null,
        priority: payload.priority,
        parentTaskId: payload.parentTaskId || null,
        blockedBy,
        autoStart: form.querySelector('[name="autoStart"]')?.checked === true,
        // 时效要求（分钟）：选填；空串/0/负数归一为 null 且整键不传（服务端钳 1..10080，NULL 即不注入提示词）。
        ...(timeBudgetMinutes === null ? {} : { time_budget_minutes: timeBudgetMinutes }),
      })
      closeModal()
      await loadState(state.projectId, { quiet: true })
      render()
      toast(`已创建 ${task.identifier}`, 'success')
      await openTask(task.id)
      return
    }
    if (type === 'update-task') {
      const taskId = payload.taskId
      await saveTaskFromForm(taskId)
      await loadState(state.projectId, { quiet: true })
      await reloadTaskModal(taskId)
      toast('任务已保存', 'success')
      return
    }
    if (type === 'add-comment') {
      const comment = await api('add_comment', { taskId: payload.taskId, body: payload.body })
      await loadState(state.projectId, { quiet: true })
      await reloadTaskModal(payload.taskId)
      toast(comment?.steered ? '评论已直通执行中的会话' : '评论已添加', 'success')
      return
    }
    if (type === 'create-memory') {
      const [scopeType, scopeId] = String(payload.scope || '').split(':')
      await api('create_memory', {
        scopeType,
        scopeId,
        topic: payload.topic,
        content: payload.content,
      })
      closeModal()
      await refresh()
      toast('记忆已写入', 'success')
      return
    }
    if (type === 'update-memory') {
      await api('update_memory', {
        memoryId: payload.memoryId,
        topic: payload.topic,
        content: payload.content,
      })
      closeModal()
      await refresh()
      toast('记忆已更新', 'success')
      return
    }
    if (type === 'create-proposal') {
      const kind = payload.kind
      const proposal = await api('create_proposal', {
        kind,
        botId: payload.botId || null,
        projectId: payload.projectId || null,
        title: payload.title,
        rationale: payload.rationale,
        evaluation: payload.evaluation,
        payload: kind === 'skill'
          ? {
            slug: payload.slug,
            name: payload.name,
            description: payload.description,
            content: payload.content,
            version: payload.version,
          }
          : { instructions: payload.instructions },
      })
      if (kind === 'skill' && !payload.content) throw new Error('技能内容不能为空')
      closeModal()
      await refresh()
      toast('提案已提交审批', 'success')
      return
    }
    if (type === 'save-price') {
      if (!String(payload.model ?? '').trim()) throw new Error('模型不能为空')
      const price = value => (String(value ?? '').trim() === '' ? 0 : Number(value))
      if ([payload.inputPerMtok, payload.outputPerMtok, payload.cacheReadPerMtok, payload.cacheWritePerMtok].some(value => Number.isNaN(price(value)))) throw new Error('价格需要是数字')
      await api('save_price', {
        provider: payload.provider ?? '',
        model: payload.model,
        inputPerMtok: price(payload.inputPerMtok),
        cacheReadPerMtok: price(payload.cacheReadPerMtok),
        cacheWritePerMtok: price(payload.cacheWritePerMtok),
        outputPerMtok: price(payload.outputPerMtok),
        currency: (payload.currency || 'CNY').toUpperCase(),
      })
      closeModal()
      await refresh()
      toast('模型价格已保存，新调用将按此计价', 'success')
      return
    }
    if (type === 'save-project') {
      // 成员改在「成员」tab 用邀请/移除管理（增量 API）；设置页不再全量提交成员表。
      await api('update_project', {
        projectId: payload.projectId,
        patch: {
          name: payload.name,
          description: payload.description,
          ownerBotId: payload.ownerBotId,
          replyMode: payload.replyMode,
          tokenBudget: payload.tokenBudget === '' ? null : Number(payload.tokenBudget),
          costBudget: payload.costBudget === '' ? null : Number(payload.costBudget),
          productionDir: String(payload.productionDir ?? ''),
        },
      })
      await refresh()
      toast('项目设置已保存', 'success')
      return
    }
    if (type === 'upsert-secret') {
      const scope = payload.scope === 'team' ? 'team' : 'project'
      if (scope === 'project' && !payload.projectId) throw new Error('项目级密钥必须选择项目')
      if (String(payload.value ?? '').length < 8) throw new Error('密钥值至少 8 个字符')
      await api('upsert_secret', {
        scope,
        projectId: scope === 'project' ? payload.projectId : null,
        name: payload.name,
        purpose: payload.purpose ?? '',
        value: payload.value,
      })
      await refresh()
      toast('密钥已保存', 'success')
      return
    }
    if (type === 'approve-secret') {
      if (String(payload.value ?? '').length < 8) throw new Error('密钥值至少 8 个字符')
      await api('approve_secret_request', { requestId: payload.requestId, value: payload.value })
      await refresh()
      toast('密钥请求已批准并物化', 'success')
      return
    }
    if (type === 'terminal-run') {
      const command = String(payload.command ?? '').trim()
      if (!command) throw new Error('命令不能为空')
      await api('run_command', { projectId: payload.projectId, command })
      state.terminalDraft = ''
      await loadState(state.projectId, { quiet: true })
      render()
      startTerminalPoll()
      return
    }
  } catch (error) {
    toast(error.message || String(error), 'error')
  }
})

document.addEventListener('input', (event) => {
  const el = event.target
  el.closest?.('form')?.setAttribute('data-dirty', '1')
  if (el.id === 'remove-tracking-name') {
    // 输入项目名与待移除项目完全一致才点亮执行按钮；不属于此弹窗时跳过。
    const submitBtn = document.getElementById('remove-tracking-submit')
    if (submitBtn) submitBtn.disabled = el.value !== state.modal?.name
    return
  }
  if (el.id === 'ui-scale') {
    const scale = applyUiScale(el.value)
    try { localStorage.setItem(UI_SCALE_KEY, String(scale)) } catch {}
    const value = document.getElementById('ui-scale-value')
    if (value) value.textContent = `${Math.round(scale * 100)}%`
    return
  }
  if (el.id === 'composer-input') {
    state.composerInputAt = Date.now()
    syncComposerBox(el)
    updateAutocomplete()
  }
  if (el.id === 'task-search') {
    state.taskFilter.search = el.value
  }
  if (el.id === 'memory-search') {
    state.memoryQuery = el.value
  }
  if (el.id === 'terminal-cmd-input') {
    state.terminalDraft = el.value
  }
  // 提问卡补充说明（DSHBOTS-116）：只写草稿不重绘，避免整页重建吞掉输入焦点与未提交内容。
  if (el.classList?.contains('question-custom')) {
    const questionId = el.dataset.questionId
    const itemId = el.dataset.itemId
    if (questionId && itemId) questionDraftOf(questionId).custom[itemId] = el.value
  }
})

// IME 组词标记（DSHBOTS-123）：组词期间 composition 事件不总是伴随常规 input 节奏，
// 单独记 composerComposing，让轮询渲染闸门在组词全程让路；compositionend 后回到静默窗判定。
document.addEventListener('compositionstart', (event) => {
  if (event.target?.id === 'composer-input') state.composerComposing = true
})
document.addEventListener('compositionend', (event) => {
  if (event.target?.id === 'composer-input') state.composerComposing = false
})

// select / checkbox 只发 change 不发 input，同样要计入未保存修改。
document.addEventListener('change', (event) => {
  event.target.closest?.('form')?.setAttribute('data-dirty', '1')
  // 邀请弹窗：单选后放开「确认邀请」按钮，并把选择记在 state.modal 上（重渲染后仍保持）。
  if (state.modal?.type === 'invite-member' && event.target?.name === 'botId') {
    state.modal.botId = String(event.target.value || '')
    const submit = document.getElementById('invite-member-submit')
    if (submit) submit.disabled = !state.modal.botId
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && state.modal) {
    trapModalFocus(event)
    return
  }
  const tab = event.target.closest?.('[role="tab"]')
  if (tab && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
    const index = tabs.indexOf(tab)
    const next = event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs[tabs.length - 1]
      : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    next?.focus()
    next?.click()
    return
  }
  if (state.ac && event.target.id === 'composer-input') {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveAcSelection(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      applyAutocomplete(state.ac.items[state.ac.selected])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAutocomplete()
      return
    }
  }
  // 图片查看器：Esc 关闭（优先级高于 modal 与 composer 快捷键）。
  if (event.key === 'Escape' && !document.getElementById('image-viewer')?.hidden) {
    event.preventDefault()
    closeImageViewer()
    return
  }
  if (event.key === 'Escape' && state.modal) {
    closeModal()
    return
  }
  // 引用条：Esc 取消（优先级低于补全与 modal，高于 composer 快捷键）。
  if (event.key === 'Escape' && state.replyTo) {
    event.preventDefault()
    state.replyTo = null
    renderKeepingChatScroll()
    return
  }
  if (event.target.id === 'composer-input' && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    void sendMessage()
    return
  }
  if (event.target.id === 'task-search' && event.key === 'Enter') {
    event.preventDefault()
    render()
    return
  }
  if (event.target.id === 'memory-search' && event.key === 'Enter') {
    event.preventDefault()
    void searchMemories()
    return
  }
  if (event.target.id === 'terminal-cmd-input' && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    document.querySelector('form[data-form="terminal-run"]')?.requestSubmit()
    return
  }
})

document.addEventListener('mousedown', (event) => {
  if (event.target.closest('.composer-ac-item')) {
    event.preventDefault()
    return
  }
  if (state.ac && !event.target.closest('.composer-box')) closeAutocomplete()
})

document.addEventListener('click', (event) => {
  const el = event.target.closest('.composer-ac-item')
  if (!el || !state.ac) return
  applyAutocomplete(state.ac.items[Number(el.dataset.acIdx)])
})

// 粘贴分发（DSHBOTS-70）：document 级委托——#composer-input 在 renderShell 里被 2.8s 轮询重建，
// 监听挂节点会随节点一起被换掉（D-64 同类根因）。target 不是 composer 就完全放行，纯文本粘贴行为不变。
document.addEventListener('paste', (event) => {
  const input = event.target
  if (input?.id !== 'composer-input') return
  const files = Array.from(event.clipboardData?.files ?? [])
  if (files.length === 0) return
  // 剪贴板里是文件（截图/复制的文件），接管默认行为：图片走现有校验与待发通道（顺带补上粘贴截图能力），
  // 不支持的类型从剪贴板文本里找 file:// 绝对路径；都拿不到就明说，不静默、不猜路径。
  event.preventDefault()
  const images = files.filter(file => resolveImageMediaType(file.type, file.name))
  if (images.length > 0) void addPendingImages(images)
  if (images.length === files.length) return
  const data = event.clipboardData
  const paths = parseFileUriList(data.getData('text/uri-list') || data.getData('text/plain'))
  if (paths.length > 0) {
    insertTextAtCursor(input, paths.join('\n'))
  } else {
    insertTextAtCursor(input, files.map(file => file.name || '未命名文件').join('\n'))
    toast('浏览器未提供完整路径', 'error')
  }
})

// 待发缩略图兜底（DSHBOTS-75）：捕获阶段接资源 error，破图当场换成「图标 + 文件名」占位。
// 不用内联 onerror——CSP script-src 'self' 会把内联处理器一起拦掉。
document.addEventListener('error', (event) => {
  const target = event.target
  if (!(target instanceof HTMLImageElement)) return
  if (!target.classList.contains('image-thumb-img')) return
  if (target.dataset.fallbackApplied === '1') return
  target.dataset.fallbackApplied = '1'
  target.replaceWith(thumbnailFallback(target.getAttribute('alt') || '', icon('image'), target.ownerDocument ?? document))
}, true)

document.addEventListener('change', (event) => {
  const el = event.target
  // composer 选图：先把文件列表取出来（清空 input 后 FileList 会失效），再交给前端校验 + 读取。
  if (el.id === 'composer-image-input') {
    const files = Array.from(el.files ?? [])
    el.value = ''
    if (files.length > 0) void addPendingImages(files)
    return
  }
  if (el.matches('[data-task-filter]')) {
    state.taskFilter[el.dataset.taskFilter] = el.value
    render()
  }
  // 任务排序（D-63）：组内重排，不动分组与父子层级。
  if (el.matches('[data-task-sort]')) {
    state.taskSort = el.value
    render()
  }
  if (el.matches('[data-model-select]')) updateEffortOptions(el)
  if (el.matches('[data-fallback-model-select]')) updateFallbackEffortOptions(el)
  if (el.id === 'secret-scope') {
    const projectSelect = document.getElementById('secret-project')
    if (projectSelect) {
      projectSelect.disabled = el.value !== 'project'
      if (el.value !== 'project') projectSelect.value = ''
    }
  }
})

document.addEventListener('scroll', (event) => {
  const el = event.target
  if (!el?.classList?.contains('chat-messages')) return
  // 判定口径抽成纯函数 nextChatAtBottom：渲染窗口内与已脱离文档的节点保持原值（DSHBOTS-72）。
  state.chatAtBottom = nextChatAtBottom({
    rendering: state.rendering,
    connected: el.isConnected,
    current: state.chatAtBottom,
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
  })
}, true)

// 折叠面板展开态：toggle 不冒泡，在 document 捕获阶段统一记录 <details data-panel> 的展开/收起（含 modal 里的面板）。
document.addEventListener('toggle', (event) => {
  applyPanelToggle(state, panelKey(event.target), event.target.open)
}, true)

// composer 拖柄：按住垂直拖动调整输入框高度，最小不低于当前内容的自动高度，最大不超过面板 61.8%；双击恢复自动高度。
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest?.('.composer-resizer')) return
  const input = document.getElementById('composer-input')
  if (!input) return
  event.preventDefault()
  const startY = event.clientY
  const startHeight = input.offsetHeight
  input.style.height = 'auto'
  const minHeight = Math.min(COMPOSER_AUTO_MAX_PX, input.scrollHeight)
  const capHeight = composerPanelCap(input)
  const lowerBound = Math.min(minHeight, capHeight)
  const onMove = (moveEvent) => {
    state.composerHeight = Math.min(Math.max(Math.round(startHeight - (moveEvent.clientY - startY)), lowerBound), capHeight)
    input.style.height = `${state.composerHeight}px`
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
})
document.addEventListener('dblclick', (event) => {
  if (!event.target.closest?.('.composer-resizer')) return
  const input = document.getElementById('composer-input')
  if (!input) return
  state.composerHeight = null
  applyComposerHeight(input)
})

let draggedTask = null
document.addEventListener('dragstart', (event) => {
  const card = event.target.closest('.task-card')
  if (!card) return
  draggedTask = card.dataset.taskId
  card.classList.add('dragging')
  event.dataTransfer.effectAllowed = 'move'
  try { event.dataTransfer.setData('text/plain', draggedTask) } catch {}
})
document.addEventListener('dragend', () => {
  document.querySelectorAll('.task-card.dragging').forEach(card => card.classList.remove('dragging'))
  document.querySelectorAll('.column.drop-target').forEach(column => column.classList.remove('drop-target'))
  draggedTask = null
})
document.addEventListener('dragover', (event) => {
  const column = event.target.closest('.column[data-drop-status]')
  if (!column || !draggedTask) return
  event.preventDefault()
  document.querySelectorAll('.column.drop-target').forEach(item => { if (item !== column) item.classList.remove('drop-target') })
  column.classList.add('drop-target')
})
document.addEventListener('drop', async (event) => {
  const column = event.target.closest('.column[data-drop-status]')
  if (!column || !draggedTask) return
  event.preventDefault()
  const taskId = draggedTask
  const status = column.dataset.dropStatus
  try {
    await api('transition_task', { taskId, status })
    await refresh()
    toast(`任务已移动到 ${STATUS[status]}`, 'success')
  } catch (error) {
    toast(error.message || String(error), 'error')
  }
})

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
  if (event.target.closest?.('.approval-banner')) return
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
  for (const el of root.querySelectorAll('.run-clock[data-started]')) {
    el.textContent = duration(el.dataset.started)
  }
}

setInterval(() => { void poll() }, 2800)
setInterval(() => {
  updateRunClocks()
  // 终态气泡到期摘除与淡出刷新（DSHBOTS-150）：只动气泡节点，不整页重建（不打断输入中的草稿）。
  pruneTypingLinger()
  // 审批倒计时局部刷新（DSHBOTS-102）：只改文本与危险色，不整卡重绘（2.8s 轮询会打断跳动感）。
  for (const el of document.querySelectorAll('.approval-clock[data-expires], .approval-menu-time[data-expires]')) {
    const remaining = approvalRemainingFrom(el.dataset.expires)
    // 卡片内 .approval-clock 用 V2 倒计时文案（剩余 X 分 Y 秒），顶部窄条沿用「X 分后自动拒绝」。
    el.textContent = el.classList.contains('approval-menu-time') ? formatApprovalRemaining(remaining) : formatApprovalCountdown(remaining)
    el.classList.toggle('urgent', approvalUrgent(remaining))
  }
  // 卡片倒计时外层：图标随临期转黄（DSHBOTS-108）。
  for (const el of document.querySelectorAll('.approval-countdown[data-expires]')) {
    el.classList.toggle('urgent', approvalUrgent(approvalRemainingFrom(el.dataset.expires)))
  }
  // 卡片进度条：剩余越多条越长，临期变短并转黄（DSHBOTS-108）。
  for (const el of document.querySelectorAll('.approval-progress[data-expires]')) {
    const remaining = approvalRemainingFrom(el.dataset.expires)
    const ratio = approvalProgressRatio(remaining, el.dataset.window)
    const fill = el.querySelector('.approval-progress-fill')
    if (fill) fill.style.width = `${Math.round(ratio * 100)}%`
    el.classList.toggle('urgent', approvalUrgent(remaining))
    el.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }
  // 提问倒计时局部刷新（DSHBOTS-116）：与审批同口径，只改文本与危险色，不整卡重绘。
  for (const el of document.querySelectorAll('.question-clock[data-expires], .question-menu-time[data-expires]')) {
    const remaining = questionRemainingFrom(el.dataset.expires)
    // 卡片与顶部窄条都用同一「剩余 X 分 Y 秒」口径（提问没有审批那种「自动拒绝」语义）。
    el.textContent = formatQuestionCountdown(remaining)
    el.classList.toggle('urgent', questionUrgent(remaining))
  }
  for (const el of document.querySelectorAll('.question-countdown[data-expires]')) {
    el.classList.toggle('urgent', questionUrgent(questionRemainingFrom(el.dataset.expires)))
  }
  for (const el of document.querySelectorAll('.question-progress[data-expires]')) {
    const remaining = questionRemainingFrom(el.dataset.expires)
    const ratio = questionProgressRatio(remaining, el.dataset.window)
    const fill = el.querySelector('.question-progress-fill')
    if (fill) fill.style.width = `${Math.round(ratio * 100)}%`
    el.classList.toggle('urgent', questionUrgent(remaining))
    el.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }
}, 1000)
void init()

// DSHBOTS-15 批次3：IIFE 包裹已拆除（模块作用域等价于原 IIFE 私有作用域，模块天然 strict）。
// 以下导出仅供后续批次外迁的 ui/modules/*.js 反向依赖（调用期解析）；随各域搬出逐步收缩。
export { app, UI_SCALE_KEY, UI_THEME_KEY, savedScale, refresh, startWechatPoll, stopWechatPoll, startTerminalPoll, stopTerminalPoll, syncTerminalPoll, updateTerminalDom, bootError, isTyping, pendingProposals, tabDot, renderShell, syncChromeHeight, renderKeepingChatScroll, panelKey, isPanelOpen, panelOpenAttr }
export { applyPanelToggle, panelAttrs, lastRenderedView, captureViewScroll, restoreViewScroll, CHAT_BOTTOM_THRESHOLD, nextChatAtBottom, render, renderView, noProject, runStatusLabel, sideRowStatusHtml, runKindLabel }
export { draggedTask, observer, updateRunClocks }
