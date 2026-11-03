import { state, STATUS, STATUS_ORDER, PRIORITY, PROPOSAL_STATUS, COLORS, COLOR_NAMES, BOT_STATUS, RUN_STATUS, RUN_KIND, CHAT_PAGE_SIZE, CHAT_ACTIVE_TASK_LIMIT, SKILL_STATUS, MEMORY_STATUS, PROPOSAL_KIND, TERMINAL_STATUS, CREATOR_TYPE, EFFORT, FILE_POLICY, DEFAULT_FILE_POLICY, VIEW_ACTION, NAV, SOLO_NAV } from './modules/state.js'
import { icon } from './modules/icons.js'
import { applyUiScale, applyUiTheme, esc, attr, pathCode, costValue, clamp, botById, shortRefId, actorLabel, taskById, activeProject, inSoloContext, pageProject, activeBots, formatNumber, CURRENCY_SYMBOL, formatCost, timeAgo, formatTime, duration, initials, avatar, statusPill, runDot, memberRunDot, runDotHtml, MEMBER_STATUS_TEXT, memorySource, toast, filePolicyOptions } from './modules/util.js'
import { richText, mdPlainSummary, mdChatScope } from './modules/markdown.js'
import { api, loadState, markVisibleChatRead } from './modules/api.js'
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

async function refresh({ quiet = false } = {}) {
  try {
    await loadState(state.projectId, { quiet })
    if (!state.modal) render()
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
          toast('微信通道已连接', 'success')
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
      <div class="boot-error-title">无法连接 DSH Team Bots</div>
      <div class="boot-error-msg">${esc(error?.message ?? error)}</div>
      <div class="btn-row" style="justify-content:center;margin-top:18px">
        <button class="btn primary" data-action="retry-boot">${icon('refresh')}重试</button>
        <a class="btn" href="/">返回 DSH</a>
      </div>
    </div>`
}

function isTyping() {
  const el = document.activeElement
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

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

function renderShell() {
  const data = state.data
  const solo = inSoloContext()
  // 场景分支：单聊上下文无项目域；群聊上下文 = 当前项目。
  const project = solo ? null : activeProject()
  const pending = pendingProposals()
  // 侧栏状态行全局口径（DSHBOTS-77）：全库活跃运行，不随群聊/单聊上下文跳变；topbar 仍按项目口径。
  const running = Number(data?.activeRuns ?? 0)
  const projectRunning = project?.stats?.running ?? 0
  const tokenTotal = usageTotals('project').totalTokens ?? 0
  const isGlobal = state.view === 'global' || state.view === 'bots-overview' || (state.view === 'usage' && usageMode() === 'global')
  // 单聊是独立于项目的 1V1 上下文：对话/配置/技能/记忆/进化/用量共用一套导航。
  const isSolo = state.view === 'chat' && state.chatMode === 'solo'
  const inSolo = inSoloContext()
  const soloBot = inSolo ? botById(state.soloBotId) : null
  const viewTitle = isSolo
    ? (soloBot ? `调度 · @${soloBot.name}` : '调度')
    : state.view === 'solo-config' ? (soloBot ? `配置 · @${soloBot.name}` : 'Bot 配置')
    : state.view === 'chat' ? (project?.name ?? '团队空间')
    : state.view === 'tasks' ? '任务面板'
    : state.view === 'members' ? '项目成员'
    : state.view === 'bots-overview' ? '总览 Bots'
    : state.view === 'skills' ? '技能池'
    : state.view === 'memory' ? '记忆'
    : state.view === 'evolution' ? '进化提案'
    : state.view === 'usage' ? usageViewTitle()
    : state.view === 'terminal' ? (project ? `终端 · ${project.name}` : '项目终端')
    : state.view === 'global' ? '全局配置'
    : '项目设置'
  const title = viewTitle
  const spec = VIEW_ACTION[state.view]
  const cardOwnsPrimary = state.view === 'evolution' && pendingProposals() > 0
  const primary = (!project && !inSolo) || !spec ? '' : spec.submit
    ? `<button class="btn primary" type="submit" form="${spec.submit}">${icon(spec.icon)}<span class="btn-label">${spec.label}</span></button>`
    : `<button class="btn ${cardOwnsPrimary ? '' : 'primary'}" data-action="${spec.action}"${spec.kind ? ` data-kind="${spec.kind}"` : ''}>${icon(spec.icon)}<span class="btn-label">${spec.label}</span></button>`
  const eyebrow = isGlobal
    ? ''
    : inSolo
      ? 'Bot 调度<span class="sep"></span>项目外'
      : project
        ? `${project.key}<span class="sep"></span>${project.status === 'active' ? '进行中' : '已归档'}`
        : '未选择项目'
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
        <a class="brand" href="/index.html" title="返回 DSH 原生 Web 界面">
          <div class="brand-mark">DSH</div>
          <div class="brand-copy"><strong>DSH Team Bots</strong></div>
        </a>
        <div class="tree">
          <div class="tree-group">
            <div class="side-label">
              <button class="tree-toggle" data-action="toggle-tree" data-tree="chats" title="群聊 / 项目">${chevron(state.tree.chats)}<span>群聊</span></button>
              <span class="tree-count">${activeChats.length}</span>
              <button class="side-add" data-action="new-project" title="新建群聊 / 项目">${icon('plus')}</button>
            </div>
            ${state.tree.chats ? `<div class="tree-list">
              ${activeChats.length === 0 ? '<div class="side-empty">还没有群聊。</div>' : activeChats.map(item => {
                // 未读与待审红点互斥：行尾最多一个红色信号，未读优先（会话流更即时）。
                const unread = Number(item.unreadCount ?? 0)
                const signal = unread > 0
                  ? (unread === 1
                    ? '<span class="red-dot" title="1 条未读消息"></span>'
                    : `<span class="unread-badge" title="${unread} 条未读消息">${unread > 99 ? '99+' : unread}</span>`)
                  : (Number(item.reviewTasks ?? 0) > 0 ? '<span class="red-dot" title="有任务待人工验收"></span>' : '')
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
              <button class="tree-toggle" data-action="toggle-tree" data-tree="bots" title="团队 Bots">${chevron(state.tree.bots)}<span>Bots</span></button>
              <span class="tree-count">${activeBots.length}</span>
              <button class="side-add" data-action="new-bot" title="新建 Bot">${icon('plus')}</button>
            </div>
            ${state.tree.bots ? `<div class="tree-list">
              ${bots.length === 0 ? '<div class="side-empty">还没有 Bot。</div>' : bots.map(bot => `
                <button class="tree-item bot-item ${state.view === 'chat' && state.chatMode === 'solo' && bot.id === state.soloBotId ? 'active' : ''}" data-action="${bot.status === 'active' ? 'solo-bot' : 'edit-bot'}" data-bot-id="${attr(bot.id)}" title="${esc(bot.name)} · ${esc(bot.role || '成员')} · ${esc(bot.modelRef ?? '未配置模型')}">
                  <span class="avatar sm ${attr(bot.color ?? 'gray')}">${esc(initials(bot.name))}</span>
                  <span class="tree-item-name">${esc(bot.name)}</span>
                  ${bot.openTasks > 0 ? `<span class="tree-open-count">${bot.openTasks}</span>` : ''}
                  ${bot.status !== 'active' ? '<span class="tree-flag">已归档</span>' : ''}
                </button>
              `).join('')}
            </div>` : ''}
          </div>
          <div class="tree-group tree-archived">
            <div class="side-label">
              <button class="tree-toggle" data-action="toggle-tree" data-tree="archived" title="已归档群聊">${chevron(state.tree.archived)}<span>已归档</span></button>
              <span class="tree-count">${archivedChats.length}</span>
            </div>
            ${state.tree.archived ? `<div class="tree-list">
              ${archivedChats.length === 0 ? '<div class="side-empty">没有已归档项目。</div>' : archivedChats.map(item => `
                <button class="tree-item chat-item archived ${item.id === project?.id && !isGlobal && state.chatMode !== 'solo' ? 'active' : ''}" data-action="select-project" data-project-id="${attr(item.id)}" title="${esc(item.name)} · 再开与移除在项目设置 · 项目状态里">
                  <span class="chat-hash">#</span>
                  <span class="tree-item-name">${esc(item.name)}</span>
                  <span class="tree-flag">已归档</span>
                </button>
              `).join('')}
            </div>` : ''}
          </div>
        </div>
        <div class="sidebar-bottom">
          <button class="global-config ${state.view === 'bots-overview' ? 'active' : ''}" data-action="nav" data-view="bots-overview">
            ${icon('bot')}<span>总览bots</span>${pendingProposals() > 0 ? '<span class="red-dot" title="有待审批提案"></span>' : ''}
          </button>
          <button class="global-config ${state.view === 'usage' && state.usageMode === 'global' ? 'active' : ''}" data-action="nav" data-view="usage" data-usage-mode="global">
            ${icon('chart')}<span>用量统计</span>
          </button>
          <button class="global-config ${state.view === 'global' ? 'active' : ''}" data-action="nav" data-view="global">
            ${icon('settings')}<span>全局配置</span>
          </button>
          <a class="global-config dsh-official-link" href="/index.html" title="切换到 DSH 原生 Web 界面">
            ${icon('external')}<span>DSH 原生界面</span>
          </a>
          <div class="sidebar-meta">
            <span class="dot ${running ? 'amber' : ''}"></span>
            <span>${running ? `${running} 个运行中` : '团队空闲'}</span>
            <span class="sidebar-meta-sep">·</span>
            <span>${activeBots.length} Bots</span>
            <span class="sidebar-meta-sep">·</span>
            <span>${pending} 待审</span>
          </div>
        </div>
      </aside>
      <main class="main">
        <div class="main-head">
        <header class="topbar">
          <div class="topbar-title">
            ${eyebrow ? `<div class="topbar-eyebrow">${eyebrow}</div>` : ''}
            <h1>${esc(title)}</h1>
          </div>
          ${isGlobal || solo || !project ? '' : `<div class="topbar-meta">
            <span><b>${project?.stats?.openTasks ?? 0}</b> 任务</span>
            <span class="sep"></span>
            <span><b>${projectRunning}</b> 运行中</span>
            <span class="sep"></span>
            <span><b>${formatNumber(tokenTotal)}</b> tokens</span>
          </div>`}
          <div class="topbar-actions">
            ${primary}
            <button class="btn icon" data-action="refresh" title="刷新" aria-label="刷新">${icon('refresh')}</button>
          </div>
        </header>
        ${isGlobal ? '' : `<div class="tabbar" role="tablist" aria-label="主导航">
          ${(inSolo ? SOLO_NAV : NAV).map(([key, label]) => {
            const dot = tabDot(key)
            // 用量 tab 有三态：群聊 tab=本群口径，单聊 tab=本 bot 口径，侧栏入口=全局视图。
            const tabMode = key === 'usage' ? (inSolo ? 'solo' : 'domain') : null
            const active = state.view === key && (tabMode ? state.usageMode === tabMode : true)
            return `<button class="tab ${active ? 'active' : ''}" role="tab" id="tab-${key}" aria-controls="main-content" aria-selected="${active}" tabindex="${active ? '0' : '-1'}" data-action="nav" data-view="${key}"${tabMode ? ` data-usage-mode="${tabMode}"` : ''}>${label}${dot ? '<span class="red-dot" title="有待人工处理事项"></span>' : ''}</button>`
          }).join('')}
        </div>`}
        </div>
        <section class="content" id="main-content" role="tabpanel" tabindex="-1"${isGlobal ? '' : ` aria-labelledby="tab-${state.view}"`}>
          ${renderView()}
        </section>
      </main>
    </div>
    ${state.modal ? renderModal() : ''}
  `
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
  state.ac = null
  app.className = ''
  const hadModal = Boolean(document.querySelector('.modal'))
  const previousFocus = document.activeElement
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
  if (state.modal && !hadModal) {
    lastFocused = previousFocus
    focusModal()
  }
  if (!state.modal && hadModal) restoreFocus()
  requestAnimationFrame(() => {
    try {
      syncChromeHeight()
      if (state.view === 'chat') {
        // 全量重建会丢 composer 的内联高度与发送按钮态，先恢复，再处理贴底滚动。
        const composerInput = document.getElementById('composer-input')
        if (composerInput) syncComposerBox(composerInput)
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

function renderView() {
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
    <h3>先创建一个项目空间</h3>
    <button class="btn primary" data-action="new-project">${icon('plus')}新建项目</button>
  </div>`
}

// typing-status:start —— 消息流末尾「Bot 响应中」状态行的纯逻辑（tests/typing-status.test.js 抽取此块断言）
// 只认 chat / solo_chat 的活跃运行；task、review、handle、dm、dm_reply、memory_review 与已结束运行一律不出行。
function activeTypingRuns(runs, kind) {
  return (runs ?? [])
    .filter(run => run.kind === kind && ['queued', 'running'].includes(run.status))
    .sort((a, b) => String(a.queued_at ?? '').localeCompare(String(b.queued_at ?? '')))
    .map(run => ({
      botId: run.bot_id,
      botName: run.botName ?? 'Bot',
      status: run.status,
      text: run.status === 'queued' ? '排队等待回复…' : '正在思考与回复…',
      // 耗时起点：未开始运行的从排队时刻起算
      startedAt: run.started_at ?? run.queued_at,
    }))
}
// typing-status:end

// 活跃运行的「响应中」行：头像 + 三点跳动 + 状态文案 + 秒表（复用 .run-clock 的每秒刷新 interval）。
function typingRows(runs, kind) {
  return activeTypingRuns(runs, kind).map(row => {
    const bot = botById(row.botId)
    return `<div class="typing-row">
      ${avatar(bot, 'sm')}
      <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <strong class="typing-name">${esc(row.botName)}</strong>
      <span class="typing-text">${row.text}</span>
      <span class="run-clock" data-started="${attr(row.startedAt ?? '')}">${duration(row.startedAt)}</span>
    </div>`
  }).join('')
}

// chat-pagination:start —— 聊天历史分片加载（DSHBOTS-33）纯逻辑，tests/chat-pagination.test.js 按本标记块抽取断言。
// state 轮询只回最后 CHAT_PAGE_SIZE 条；更早的经 messages_page 手动加载，与轮询结果按 id 去重合并展示。

// 当前会话的分片桶 key：与轮询数据的会话一一对应，切会话即失效（loadOlderMessages 里判断重置）。
function chatKey() {
  if (state.chatMode === 'solo') return state.soloBotId ? `solo:${state.soloBotId}` : null
  const project = activeProject()
  return project ? `group:${project.id}` : null
}

// 合并分片桶与轮询消息：older 在前、latest 在后，按 id 去重以轮询侧为准（轮询是活数据）。
function mergedChatMessages(latest) {
  const key = chatKey()
  const bucket = state.chatOlder.key === key ? state.chatOlder : null
  if (!bucket || !bucket.items.length) return latest ?? []
  const seen = new Set((latest ?? []).map(m => m.id))
  const older = bucket.items.filter(m => !seen.has(m.id))
  return [...older, ...(latest ?? [])]
}

// 未翻过页且首屏已满页时也可能还有更早历史——显示按钮探一页，由 hasMore 收敛。
function canLoadOlder(mergedCount) {
  const key = chatKey()
  const bucket = state.chatOlder.key === key ? state.chatOlder : null
  if (!bucket) return mergedCount >= CHAT_PAGE_SIZE
  if (bucket.loading || !bucket.hasMore) return false
  return true
}

function loadOlderButton() {
  const disabled = state.chatOlder.loading ? ' disabled' : ''
  const label = state.chatOlder.loading ? '加载中…' : `加载前 ${CHAT_PAGE_SIZE} 条`
  return `<button class="load-older" data-action="load-older"${disabled}>${label}</button>`
}

async function loadOlderMessages() {
  const key = chatKey()
  if (!key || state.chatOlder.loading) return
  if (state.chatOlder.key !== key) {
    state.chatOlder = { key, items: [], hasMore: false, loading: false }
  }
  const listEl = document.querySelector('.chat-messages')
  const solo = state.data?.solo?.bot?.id === state.soloBotId ? state.data.solo : null
  const merged = state.chatMode === 'solo'
    ? mergedChatMessages(solo?.messages ?? [])
    : mergedChatMessages(state.data.messages ?? [])
  const oldest = merged[0]
  if (!oldest) return
  state.chatOlder.loading = true
  render()
  try {
    const scope = state.chatMode === 'solo' ? { soloBotId: state.soloBotId } : { projectId: key.slice('group:'.length) }
    const res = await api('messages_page', { ...scope, beforeCreatedAt: oldest.createdAt, beforeId: oldest.id, limit: CHAT_PAGE_SIZE })
    state.chatOlder.items = [...(res.messages ?? []), ...state.chatOlder.items]
    state.chatOlder.hasMore = Boolean(res.hasMore)
    const prevTop = listEl ? listEl.scrollTop : 0
    const prevHeight = listEl ? listEl.scrollHeight : 0
    render()
    // 阅读位补偿：套一层 rAF 排在 render 自身 rAF 的落底滚动之后，避免被 chatAtBottom 分支覆盖。
    requestAnimationFrame(() => {
      if (!listEl || state.chatAtBottom) return
      listEl.scrollTop = prevTop + (listEl.scrollHeight - prevHeight)
    })
  } catch (err) {
    toast(err?.message || '加载历史失败')
  } finally {
    state.chatOlder.loading = false
    render()
  }
}
// chat-pagination:end

// 群聊右栏「项目成员」概览卡（只读）：DSHBOTS-49 恢复 D-5 信息架构收敛时删掉的面板，
// DSHBOTS-55 按 232f1c8 的双行方案修正——①位置在「项目总监」卡正下方（活跃任务之前）；
// ②成员行剔除总监（总监独占上方自己的 panel），计数同口径；
// ③行样式回到成员两行式 .member-info：第一行 名称+角色标签，第二行 模型小字，状态点留在行尾。
// 数据源与「成员」tab 同一张表（project.members）；状态点走 memberRunDot，与「成员」tab 一致。
// 卡内不含任何管理操作——邀请与移除留在「成员」tab，避免旧版「复选框全量提交」式的误清空成员。
function renderChatMembersCard() {
  const project = activeProject()
  const members = project?.members ?? []
  // 总监独占一张卡，成员卡里不再重复展示总监。
  const memberList = members.filter(member => member.id !== project?.owner_bot_id && member.member_role !== 'owner')
  return `
    <div class="side-card members-overview" data-members-overview>
      <div class="side-card-head"><h3>项目成员</h3><span>${memberList.length}</span></div>
      ${memberList.length === 0 ? '<div class="faint">没有其他成员。</div>' : `<div class="side-list">
        ${memberList.map(member => {
          const bot = botById(member.id)
          if (!bot) return ''
          const dot = memberRunDot(member)
          // modelRef 已是 provider/model 形态（如 deepseek/deepseek-chat），不再拼 provider；缺配置给兜底文案。
          const modelRef = member.modelRef ?? bot.modelRef ?? bot.model ?? null
          const modelLine = modelRef ? String(modelRef) : '未配置模型'
          return `<div class="side-row" title="${esc(bot.name)} · ${esc(bot.role || '成员')} · ${esc(dot.text)}">
            ${avatar(bot, 'sm')}
            <div class="member-info">
              <span class="member-name-line"><strong>${esc(bot.name)}</strong><span class="member-role">${esc(bot.role || '成员')}</span></span>
              <span class="member-model">${esc(modelLine)}</span>
            </div>
            ${runDotHtml(dot)}
          </div>`
        }).join('')}
      </div>`}
    </div>`
}

function renderChat() {
  if (state.chatMode === 'solo') return renderSoloChat()
  const project = activeProject()
  if (!project) return noProject()
  const messages = mergedChatMessages(state.data.messages ?? [])
  const owner = botById(project.owner_bot_id)
  const members = project.members ?? []
  // modelRef 本身已是 provider/model（如 deepseek/deepseek-chat），不再单独拼 provider，避免重复。
  const ownerModelRef = owner ? (owner.modelRef ?? owner.model ?? null) : null
  const ownerModelLine = ownerModelRef ? String(ownerModelRef) : '未配置模型'
  // 总监也是 bot，状态点取同一成员表口径（bot 全局）。
  const ownerMember = members.find(m => m.id === project.owner_bot_id) ?? null
  const ownerDot = ownerMember ? memberRunDot(ownerMember) : null
  const openTasks = (state.data.tasks ?? []).filter(task => !['done', 'canceled'].includes(task.status))
  const open = openTasks.slice(0, CHAT_ACTIVE_TASK_LIMIT)
  return `
    <div class="chat-layout">
      <div class="card chat-panel">
        <div class="chat-head">
          <div>
            <div class="chat-head-title"><span class="chat-hash">#</span>群聊</div>
            <div class="chat-head-meta"><span>总监 ${esc(owner?.name ?? '未设置')}</span><span class="sep"></span><span>${members.length} 个成员</span></div>
          </div>
          <div class="member-stack">
            ${members.slice(0, 6).map(member => {
              const bot = botById(member.id)
              return bot ? avatar(bot, 'sm') : ''
            }).join('')}
          </div>
        </div>
        <div class="chat-messages">
          ${canLoadOlder(messages.length) ? loadOlderButton() : ''}
          ${messages.length === 0 ? `<div class="chat-empty">
            <div class="empty-symbol">${icon('message')}</div>
            <h3>还没有人说话</h3>
            <p>直接发言会交给总监 Bot；用 <strong>@Bot</strong> 点名成员，或输入 <strong>/task @Bot 任务标题</strong> 直接创建任务。</p>
          </div>` : messages.map(renderMessage).join('')}
          ${typingRows(state.data.runs, 'chat')}
        </div>
        ${renderDirectMessagesCard()}
                  <div class="composer">
          ${state.replyTo ? `<div class="reply-bar" id="reply-bar">
            <span class="reply-bar-icon">${icon('quote')}</span>
            <span class="reply-bar-text"><strong>${esc(state.replyTo.senderName)}</strong><span>${esc(mdPlainSummary(state.replyTo.excerpt, 120))}</span></span>
            <button class="reply-bar-cancel" data-action="cancel-reply" title="取消引用（Esc）" aria-label="取消引用">${icon('close')}</button>
          </div>` : ''}
          <div class="composer-box">
            ${composerImageStrip()}
            <div class="composer-ac" id="composer-ac" role="listbox" aria-label="输入补全" hidden></div>
            <div class="composer-resizer" id="composer-resizer" title="拖动调整输入框高度，双击恢复自动高度" role="separator" aria-orientation="horizontal" aria-label="拖动调整输入框高度，双击恢复自动高度"></div>
            <textarea id="composer-input" rows="2" placeholder="给团队发消息，或输入 /task @Bot 任务标题">${esc(currentDraft(state))}</textarea>
            <div class="composer-bottom">
              ${attachImageButton()}
              <span class="composer-hint"><kbd>⌘</kbd><kbd>Enter</kbd> 发送</span>
              <button class="send-btn" data-action="send-message" ${(currentDraft(state).trim() || pendingImagesFor().length) ? '' : 'disabled'} title="发送" aria-label="发送消息">${icon('send')}</button>
            </div>
          </div>
        </div>
      </div>
      <aside class="chat-side">
        <div class="side-card">
          <div class="side-card-head"><h3>工作区</h3></div>
          <div class="path-row">${pathCode(project.workspace_path)}<button class="btn icon small" data-action="copy" data-copy="${attr(project.workspace_path)}" title="复制路径" aria-label="复制路径">${icon('copy')}</button></div>
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>项目总监</h3></div>
          ${owner ? `<div class="side-row owner-row">
            ${avatar(owner, 'sm')}
            <div class="member-info">
              <span class="member-name-line"><strong>${esc(owner.name)}</strong><span class="member-role">总监</span></span>
              <span class="member-model">${esc(ownerModelLine)}</span>
            </div>
            ${ownerDot ? runDotHtml(ownerDot) : ''}
          </div>` : '<div class="faint">未设置总监</div>'}
        </div>
        ${renderChatMembersCard()}
        <div class="side-card">
          <div class="side-card-head"><h3>活跃任务</h3><span>${project.stats.openTasks}</span></div>
          ${open.length === 0 ? '<div class="faint">没有进行中的任务。</div>' : `<div class="side-list">
            ${open.map(task => {
              const bot = botById(task.assignee_bot_id)
              return `<div class="side-row" data-action="open-task" data-task-id="${attr(task.id)}" style="cursor:pointer">
                <span class="side-row-status">${esc(STATUS[task.status] ?? task.status)}</span>
                <strong>${esc(task.identifier)}</strong>
                <span class="side-row-title">${esc(task.title)}</span>
                ${bot ? avatar(bot, 'sm') : ''}
              </div>`
            }).join('')}
          </div>${openTasks.length > CHAT_ACTIVE_TASK_LIMIT ? `<div class="faint">还有 ${openTasks.length - CHAT_ACTIVE_TASK_LIMIT} 条</div>` : ''}`}
        </div>
      </aside>
    </div>`
}

// 调度页侧栏列表的显示上限：后端已按 50 条封顶，侧栏再截断并给出剩余条数提示。
const DISPATCH_LIST_LIMIT = 10
function dispatchListNote(total) {
  return total > DISPATCH_LIST_LIMIT ? `<div class="faint">还有 ${total - DISPATCH_LIST_LIMIT} 条</div>` : ''
}

// 调度页任务行：编号 + 标题 + 状态 + 项目名；点击跳到该项目的任务页。
function dispatchTaskRow(task) {
  return `<div class="side-row" data-action="nav" data-view="tasks" data-project-id="${attr(task.project_id ?? '')}" style="cursor:pointer" title="${esc(`${task.identifier ?? ''} · ${task.title ?? ''} · ${task.projectName ?? ''}`)}">
    <span class="side-row-status">${esc(STATUS[task.status] ?? task.status)}</span>
    <strong>${esc(task.identifier ?? '')}</strong>
    <span class="side-row-title">${esc(task.title ?? '')}</span>
    <span class="faint">${esc(task.projectName ?? '')}</span>
  </div>`
}

// 调度页运行行：类型 + 状态点 + 项目 + 已运行时长（run-clock 每秒自刷新）。
function dispatchRunRow(run) {
  const started = run.started_at ?? run.queued_at ?? ''
  return `<div class="side-row" title="${esc(`${RUN_KIND[run.kind] ?? run.kind} · ${RUN_STATUS[run.status] ?? run.status}`)}">
    <span class="run-dot ${attr(run.status ?? '')}"></span>
    <strong>${esc(RUN_KIND[run.kind] ?? run.kind ?? '')}</strong>
    <span class="side-row-title">${esc(run.projectKey ?? '单聊')}</span>
    <span class="run-clock" data-started="${attr(started)}">${duration(started)}</span>
  </div>`
}

// 项目外单聊（已升级为「调度页」）：每个 Bot 一条独立会话，运行目录在 _the_bots/<bot> 下。
function renderSoloChat() {
  const bots = (state.data?.bots ?? []).filter(bot => bot.status === 'active')
  if (bots.length === 0) {
    return `<div class="empty-state">
      <div class="empty-symbol">${icon('bot')}</div>
      <h3>还没有可调度的 Bot</h3>
      <p>先创建一个 Bot，就可以和它一对一对话，并查看它的调度。</p>
      <button class="btn primary" data-action="new-bot">${icon('plus')}新建 Bot</button>
    </div>`
  }
  if (!state.soloBotId || !bots.some(bot => bot.id === state.soloBotId)) state.soloBotId = bots[0].id
  const bot = botById(state.soloBotId)
  const solo = state.data?.solo?.bot?.id === bot.id ? state.data.solo : null
  const messages = mergedChatMessages(solo?.messages ?? [])
  const runs = solo?.runs ?? []
  const running = runs.filter(run => run.status === 'running' || run.status === 'queued').length
  // 调度数据只认当前 bot 的那一段：切 bot 后旧数据不得串台。
  const dispatch = state.data?.dispatch?.botId === bot.id ? state.data.dispatch : null
  const dispatchActive = dispatch?.tasks?.active ?? []
  const dispatchPending = dispatch?.tasks?.pending ?? []
  const dispatchRuns = dispatch?.runs ?? []
  return `
    <div class="chat-layout">
      <div class="card chat-panel">
        <div class="chat-head">
          <div>
            <div class="chat-head-title">${avatar(bot, 'sm')}<span>@${esc(bot.name)}</span></div>
            <div class="chat-head-meta"><span>${esc(bot.role || '团队成员')}</span><span class="sep"></span><span>${esc(bot.modelRef ?? '未配置模型')}</span>${running > 0 ? `<span class="sep"></span><span class="run-dot"></span><span>${running} 个运行中</span>` : ''}</div>
          </div>
          <div class="chat-head-actions">
            <button class="btn small" data-action="nav" data-view="solo-config" title="打开集中配置页">${icon('settings')}配置</button>
          </div>
        </div>
        <div class="chat-messages">
          ${canLoadOlder(messages.length) ? loadOlderButton() : ''}
          ${messages.length === 0 ? `<div class="chat-empty">
            <div class="empty-symbol">${icon('message')}</div>
            <h3>和 ${esc(bot.name)} 单独聊聊</h3>
            <p>这里没有项目上下文，适合单独请教、调试指令或闲聊。需要文件产出时会落在它自己的工作区。</p>
          </div>` : messages.map(renderMessage).join('')}
          ${typingRows(runs, 'solo_chat')}
        </div>
        <div class="composer">
          <div class="composer-box">
            ${composerImageStrip()}
            <div class="composer-resizer" id="composer-resizer" title="拖动调整输入框高度，双击恢复自动高度" role="separator" aria-orientation="horizontal" aria-label="拖动调整输入框高度，双击恢复自动高度"></div>
            <textarea id="composer-input" rows="2" placeholder="和 ${esc(bot.name)} 对话，/clear 清空本会话，/remember 内容 写入 Bot 记忆">${esc(currentDraft(state))}</textarea>
            <div class="composer-bottom">
              ${attachImageButton()}
              <span class="composer-hint"><kbd>⌘</kbd><kbd>Enter</kbd> 发送</span>
              <button class="send-btn" data-action="send-message" ${(currentDraft(state).trim() || pendingImagesFor().length) ? '' : 'disabled'} title="发送" aria-label="发送消息">${icon('send')}</button>
            </div>
          </div>
        </div>
      </div>
      <aside class="chat-side">
        <div class="side-card">
          <div class="side-card-head"><h3>调度对象</h3><button class="btn small" data-action="nav" data-view="solo-config" title="打开集中配置页">配置</button></div>
          <div class="owner-row">
            ${avatar(bot, 'lg')}
            <div class="owner-info"><strong>${esc(bot.name)}</strong><span>${esc(bot.role || '团队成员')} · ${esc(bot.modelRef ?? '未配置模型')}</span></div>
          </div>
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>在办任务</h3><span>${dispatchActive.length}</span></div>
          ${dispatchActive.length === 0 ? '<div class="faint">没有在办任务。</div>' : `<div class="side-list">
            ${dispatchActive.slice(0, DISPATCH_LIST_LIMIT).map(dispatchTaskRow).join('')}
          </div>${dispatchListNote(dispatchActive.length)}`}
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>待办任务</h3><span>${dispatchPending.length}</span></div>
          ${dispatchPending.length === 0 ? '<div class="faint">没有待办任务。</div>' : `<div class="side-list">
            ${dispatchPending.slice(0, DISPATCH_LIST_LIMIT).map(dispatchTaskRow).join('')}
          </div>${dispatchListNote(dispatchPending.length)}`}
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>正在调度</h3><span>${dispatchRuns.length}</span></div>
          ${dispatchRuns.length === 0 ? '<div class="faint">当前没有运行中的调度。</div>' : `<div class="side-list">
            ${dispatchRuns.slice(0, DISPATCH_LIST_LIMIT).map(dispatchRunRow).join('')}
          </div>${dispatchListNote(dispatchRuns.length)}`}
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>子智能体</h3></div>
          <div class="faint">bot 会话已内置 subagent / subagent_fork / workflow 工具，可在执行中自行派生子智能体并行加速；无需工作台额外编排。</div>
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>最近调度运行</h3><span>${runs.length}</span></div>
          ${runs.length === 0 ? '<div class="faint">还没有调度运行。</div>' : `<div class="side-list">
            ${runs.slice(0, 5).map(run => `<div class="side-row">
              <span class="run-dot ${attr(run.status)}"></span>
              <strong>${esc(RUN_STATUS[run.status] ?? run.status)}</strong>
              <span class="side-row-title">${esc(formatTime(run.queued_at))}</span>
            </div>`).join('')}
          </div>`}
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>专属工作区</h3></div>
          <div class="path-row">${pathCode(bot.soloWorkspace)}<button class="btn icon small" data-action="copy" data-copy="${attr(bot.soloWorkspace ?? '')}" title="复制路径" aria-label="复制路径">${icon('copy')}</button></div>
        </div>
      </aside>
    </div>`
}

// 单聊 Bot 的集中配置页：身份、模型、指令、运行统计与版本历史在一页完成。
async function loadSoloDetail() {
  const botId = state.soloBotId
  if (!botId) return
  state.soloDetail = null
  try {
    const detail = await api('bot_detail', { botId })
    if (state.view === 'solo-config' && state.soloBotId === botId) {
      state.soloDetail = detail
      render()
    }
  } catch {}
}

function renderSoloConfig() {
  const bot = botById(state.soloBotId)
  if (!bot) {
    return `<div class="empty-state">
      <div class="empty-symbol">${icon('bot')}</div>
      <h3>还没有选择 Bot</h3>
      <p>从左侧 Bots 树点一个 Bot 进入调度页，再点「配置」来到这里。</p>
      <button class="btn primary" data-action="nav" data-view="chat">返回对话</button>
    </div>`
  }
  const revisions = state.soloDetail?.revisions ?? []
  return `
    <div class="task-detail-grid">
      <div class="card config-card">
        <div class="owner-row" style="margin-bottom:16px">
          ${avatar(bot, 'lg')}
          <div class="owner-info"><strong style="font-size:var(--fs-title)">${esc(bot.name)}</strong><span>${esc(bot.role || '团队成员')} · ${esc(bot.modelRef ?? '未配置模型')} · ${esc(BOT_STATUS[bot.status] ?? bot.status)}</span></div>
        </div>
        <form data-form="update-bot" id="solo-config-form">
          <input type="hidden" name="botId" value="${attr(bot.id)}">
          <div class="field-row">
            <div class="field"><label for="solo-bot-name">名称</label><input class="input" style="width:100%" id="solo-bot-name" name="name" value="${attr(bot.name)}" placeholder="例如：Builder" required maxlength="24"></div>
            <div class="field"><label for="solo-bot-role">角色标签</label><input class="input" style="width:100%" id="solo-bot-role" name="role" value="${attr(bot.role ?? '')}" placeholder="例如：开发" maxlength="24"></div>
          </div>
          <div class="field-row">
            <div class="field"><label for="solo-bot-model">模型</label><select class="select" style="width:100%" id="solo-bot-model" name="modelRef" data-model-select>${modelOptions(bot.provider, bot.model)}</select></div>
            <div class="field"><label for="solo-bot-effort">推理强度</label><select class="select" style="width:100%" id="solo-bot-effort" name="effort" data-effort-select>${effortOptions(bot.modelRef ?? '', bot.effort)}</select></div>
            <div class="field"><label for="solo-bot-file-policy">文件权限</label><select class="select" style="width:100%" id="solo-bot-file-policy" name="filePolicy" title="Bot 会话内文件操作的沙箱边界，下次运行生效">${filePolicyOptions(bot.file_policy)}</select></div>
          </div>
          <div class="field-row">
            <div class="field"><label for="solo-bot-fallback-model">备用模型</label><select class="select" style="width:100%" id="solo-bot-fallback-model" name="fallbackModelRef" data-fallback-model-select title="主模型不可用时自动接手的备用模型，留空 = 不启用">${fallbackModelOptions(bot.fallbackModelRef ?? '')}</select></div>
            <div class="field"><label for="solo-bot-fallback-effort">备用推理强度</label><select class="select" style="width:100%" id="solo-bot-fallback-effort" name="fallbackEffort" data-fallback-effort-select>${effortOptions(bot.fallbackModelRef ?? '', bot.fallback_effort)}</select></div>
          </div>
          <div class="field"><span class="field-label" id="solo-bot-color-label">外观颜色</span><div class="swatch-row" role="radiogroup" aria-labelledby="solo-bot-color-label">${COLORS.map(color => `<label class="swatch" title="${COLOR_NAMES[color] ?? color}"><input type="radio" name="color" value="${color}" aria-label="${COLOR_NAMES[color] ?? color}" ${(bot.color ?? COLORS[0]) === color ? 'checked' : ''}><span class="swatch-dot ${color}"></span></label>`).join('')}</div></div>
          <div class="field"><label for="solo-bot-instructions">角色指令</label><textarea class="textarea" style="width:100%" id="solo-bot-instructions" name="instructions" rows="12" placeholder="说明职责、工作方式、边界和交付标准">${esc(bot.instructions ?? '')}</textarea></div>
        </form>
        <div class="divider"></div>
        <div class="btn-row">
          <button class="btn primary" type="submit" form="solo-config-form">${icon('check')}保存新版本</button>
          ${bot.status === 'active' ? `<button class="btn small" data-action="archive-bot" data-bot-id="${attr(bot.id)}">归档 Bot</button>` : ''}
        </div>
      </div>
      <aside class="task-detail-side">
        <div class="eyebrow" style="margin-bottom:9px">运行统计</div>
        <div class="kv"><span>运行次数</span><strong>${bot.stats.runs}</strong></div>
        <div class="kv"><span>成功 / 失败</span><strong>${bot.stats.succeeded} / ${bot.stats.failed}</strong></div>
        <div class="kv"><span>长期记忆</span><strong>${bot.memoryCount}</strong></div>
        <div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:6px">专属工作区</div>
        <div class="path-row">${pathCode(bot.soloWorkspace)}<button class="btn icon small" data-action="copy" data-copy="${attr(bot.soloWorkspace ?? '')}" title="复制路径" aria-label="复制路径">${icon('copy')}</button></div>
        <div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:9px">版本历史</div>
        ${revisions.length === 0 ? '<div class="faint">' + (state.soloDetail ? '暂无版本' : '加载中…') + '</div>' : revisions.map(revision => `<div class="revision-row"><span class="mono">v${revision.version}</span><span class="faint">${esc(timeAgo(revision.created_at))}</span>${revision.version === bot.current_revision ? '' : `<button class="btn small" data-action="rollback-bot" data-bot-id="${attr(bot.id)}" data-revision-id="${attr(revision.id)}">回滚</button>`}</div>`).join('')}
        <div class="usage-note">模型或强度变更会在下一次运行时生效，不会中断当前运行。</div>
      </aside>
    </div>`
}

// ===== approval-card:start 审批卡片（DSHBOTS-32 UI）=====
const APPROVAL_STATUS = { pending: '等待审批', allowed: '已允许一次', rejected: '已拒绝', timeout: '已超时', cancelled: '已取消' }

// 审批卡片：消息行只是锚点，状态以 state.data.approvals 为准（渲染时查表，轮询自然刷新）。
// 查不到该条（超出 30 条窗口）时退化为 system 纯文本，不留假状态。
function renderApprovalCard(message) {
  const approval = (state.data?.approvals ?? []).find(item => item.id === message.approval_id)
  if (!approval) return `<div class="message-system"><span>${esc(message.body)}</span></div>`
  const pending = approval.status === 'pending'
  const remainMin = Math.max(1, Math.round((approval.remainingMs ?? 0) / 60000))
  const summary = approval.display_reason || approval.reason || '（无说明）'
  return `<div class="message-row">
    <div class="message-body-wrap approval-card" data-approval-status="${attr(approval.status)}">
      <div class="message-meta"><strong>${esc(approval.botName)} 请求审批</strong><span>${esc(formatTime(approval.created_at))}</span></div>
      <div class="approval-tool mono">${esc(approval.tool_name)}</div>
      <div class="approval-summary">${esc(summary)}</div>
      ${pending
        ? `<div class="approval-foot faint">约 ${remainMin} 分钟内有效</div>
      <div class="approval-actions">
        <button class="btn small" data-action="approval-decide" data-approval-id="${attr(approval.id)}" data-decision="allow">允许一次</button>
        <button class="btn small danger" data-action="approval-decide" data-approval-id="${attr(approval.id)}" data-decision="reject">拒绝</button>
      </div>`
        : `<div class="approval-foot"><span class="pill">${esc(APPROVAL_STATUS[approval.status] ?? approval.status)}</span>${approval.decided_at ? `<span class="faint">${esc(formatTime(approval.decided_at))}</span>` : ''}</div>`}
    </div>
  </div>`
}
// ===== approval-card:end =====

function renderMessage(message) {
  if (message.kind === 'approval') return renderApprovalCard(message)
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
  const quoteBlock = message.reply_to ? `<div class="msg-quote" title="引用自 ${attr(message.reply_to.sender_name)}">${icon('quote')}<span>${esc(message.reply_to.sender_name)}：${esc(mdPlainSummary(message.reply_to.excerpt, 120))}</span></div>` : ''
  // hover 引用按钮：仅群聊；点击进入引用回复（选中该消息作为回复目标）。摘要同样去 markdown 记号。
  const quoteBtn = state.chatMode === 'group' ? `<button class="msg-quote-btn" data-action="quote-message" data-message-id="${attr(message.id)}" data-sender-name="${attr(message.senderName)}" data-excerpt="${attr(mdPlainSummary(message.body, 120))}" title="引用回复" aria-label="引用回复这条消息">${icon('quote')}</button>` : ''
  // hover 复制按钮：群聊/单聊都有，紧邻引用按钮右侧；复制消息原文 message.body（非渲染后 HTML），走统一 copy handler。
  const copyBtn = `<button class="msg-copy-btn" data-action="copy" data-copy="${attr(message.body)}" title="复制消息" aria-label="复制这条消息的原文">${icon('copy')}</button>`
  // 任务/思考过程 chip 合并同一行：固定顺序「思考过程 → 任务」，缺哪个不留空位。
  const trajChip = message.run_id && !isUser ? `<button class="task-chip" data-action="open-trajectory" data-run-id="${attr(message.run_id)}">思考过程</button>` : ''
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
    <summary title="展开 / 收起 Bot 私信">${icon('chevron', 'chev')}<span>Bot 私信</span><span class="subpanel-count">${items.length}</span></summary>
    <div class="subpanel-body">
      ${items.length === 0 ? '<div class="subpanel-empty">Bot 之间经 <code>team_message_bot</code> 的直接交互会出现在这里。</div>' : items.map(dm => `
        <div class="subpanel-row">
          <div class="subpanel-row-head">
            <strong>${esc(dm.fromName)} → ${esc(dm.toName)}</strong>
            <span class="pill ${DM_STATUS_TONE[dm.status] ?? ''}">${esc(DM_STATUS[dm.status] ?? dm.status)}</span>
            <span class="faint">${esc(formatTime(dm.createdAt))}</span>
            ${dm.repliedAt ? `<span class="faint">回复于 ${esc(formatTime(dm.repliedAt))}</span>` : ''}
            <span class="subpanel-tag">#${esc(dm.id)}</span>
          </div>
          ${dm.textSnippet ? `<div class="subpanel-row-text">${esc(dm.textSnippet)}</div>` : ''}
          ${dm.replySnippet ? `<div class="subpanel-row-sub">↩ ${esc(dm.replySnippet)}</div>` : ''}
        </div>`).join('')}
    </div>
  </details>`
}

// task-sort:start —— 任务面板排序的纯逻辑（tests/task-sort.test.js 按本标记块抽取断言）。
// 权重表把优先级文案映射成「越小越靠前」：紧急(0) → 高(1) → 中(2) → 低(3) → 无(4)。
// 未知或缺失的优先级按 medium（中）处理，旧数据没有 priority 时同样落在中档。
const TASK_PRIORITY_WEIGHT = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
const TASK_PRIORITY_DEFAULT = 'medium'
// 归一化优先级取值：表内值原样返回（大小写不敏感），表外值与缺失一律落到默认档 medium。
function taskPriorityKey(priority) {
  const key = String(priority ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(TASK_PRIORITY_WEIGHT, key) ? key : TASK_PRIORITY_DEFAULT
}
function taskPriorityWeight(priority) {
  return TASK_PRIORITY_WEIGHT[taskPriorityKey(priority)]
}
// 同优先级按 position（看板列内手动顺序）回退，再按 number（任务编号）回退，保证结果稳定。
function compareTasksByPriority(a, b) {
  const byPriority = taskPriorityWeight(a?.priority) - taskPriorityWeight(b?.priority)
  if (byPriority !== 0) return byPriority
  const byPosition = (Number(a?.position) || 0) - (Number(b?.position) || 0)
  if (byPosition !== 0) return byPosition
  return (Number(a?.number) || 0) - (Number(b?.number) || 0)
}
function sortTasksByPriority(tasks) {
  return [...(tasks ?? [])].sort(compareTasksByPriority)
}
// 组内排序口径（D-63）：排序只发生在状态分组的组内兄弟层，不改分组、不动父子挂载——
// 应用点在 renderTaskRows 建树前，父子挂载按 parent_task_id 组装，顺序变化不会拆散树。
// 完成时间排序只有终态任务参与（done→completed_at、canceled→canceled_at，复用 taskTerminalTime）；
// 非终态与缺时间戳的终态没有时间基准，两个方向都排在末尾，不穿插、不当 0 排最前。
const TASK_SORTS = [
  { value: 'created_desc', label: '创建时间 新→旧' },
  { value: 'created_asc', label: '创建时间 旧→新' },
  { value: 'completed_desc', label: '完成时间 新→旧' },
  { value: 'completed_asc', label: '完成时间 旧→新' },
  { value: 'priority_desc', label: '优先级 高→低' },
  { value: 'priority_asc', label: '优先级 低→高' },
]
function sortTasksForPanel(tasks, mode = state.taskSort) {
  const list = [...(tasks ?? [])]
  const created = task => new Date(task?.created_at ?? 0).getTime() || 0
  const number = task => Number(task?.number) || 0
  if (mode === 'created_asc') return list.sort((a, b) => created(a) - created(b) || number(a) - number(b))
  if (mode === 'created_desc') return list.sort((a, b) => created(b) - created(a) || number(b) - number(a))
  if (mode === 'completed_desc' || mode === 'completed_asc') {
    const dir = mode === 'completed_desc' ? -1 : 1
    const timed = list.filter(task => taskTerminalTime(task))
    const untimed = list.filter(task => !taskTerminalTime(task))
    timed.sort((a, b) => (new Date(taskTerminalTime(a)).getTime() - new Date(taskTerminalTime(b)).getTime()) * dir || (number(a) - number(b)) * dir)
    return [...timed, ...untimed]
  }
  if (mode === 'priority_desc') return sortTasksByPriority(list)
  if (mode === 'priority_asc') return sortTasksByPriority(list).reverse()
  return list
}
// task-sort:end

// task-time-range:start —— 终态时间筛选（DSHBOTS-44）：只作用于终态任务（done/canceled），
// 按各自终态时间戳（completed_at / canceled_at）与窗口下限比较；非终态任务不受影响照常显示。
// 终态但缺时间戳（极老数据）在窗口模式下视为窗口外——无法证明在窗口内就不默认放行。
// 窗口口径：「今天」按自然日当天 00:00 起（非 24 小时滚动窗），其余为自当前时刻回溯的滚动窗口。
const TASK_TIME_RANGES = { '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: 0 }
function taskEndsOutsideRange(task, timeRange) {
  if (timeRange === 'all') return false
  if (task.status !== 'done' && task.status !== 'canceled') return false
  const field = task.status === 'done' ? 'completed_at' : 'canceled_at'
  const endedAt = task[field] ? new Date(task[field]).getTime() : NaN
  const cutoff = timeRange === '1d' ? new Date().setHours(0, 0, 0, 0) : Date.now() - (TASK_TIME_RANGES[timeRange] ?? 0)
  return !(Number.isFinite(endedAt) && endedAt >= cutoff)
}
// 终态时间戳取值口径（DSHBOTS-62）：done → completed_at，canceled → canceled_at；非终态没有终态时间。
// 缺终态时间戳的终态任务没有可比的时间基准（老数据，或直接以终态状态建的任务），
// 这类任务不参与时间筛选、始终可见——按窗口外处理会把整个「已完成」分组静默清空
// （库里 1 条 done、面板 0 条的成因）。筛选入口用 taskTerminalTime 做这道门。
function taskTerminalTime(task) {
  if (!task) return null
  if (task.status === 'done') return task.completed_at ?? null
  if (task.status === 'canceled') return task.canceled_at ?? null
  return null
}
// task-time-range:end

function filteredTasks() {
  const filter = state.taskFilter
  return sortTasksByPriority((state.data?.tasks ?? []).filter(task => {
    if (filter.status !== 'all' && task.status !== filter.status) return false
    if (filter.assignee !== 'all' && task.assignee_bot_id !== filter.assignee) return false
    // 时间筛选只对「有终态时间戳」的终态任务生效（DSHBOTS-62）：缺时间戳的终态任务没有时间基准，
    // 参与筛选会被整组清空（库里 done、面板「已完成」0 条的成因）；其余状态照常显示（D-34 口径）。
    if (taskTerminalTime(task) && taskEndsOutsideRange(task, filter.timeRange)) return false
    if (filter.search) {
      const haystack = `${task.identifier} ${task.title} ${task.description} ${task.labels?.join(' ') ?? ''}`.toLowerCase()
      if (!haystack.includes(filter.search.toLowerCase())) return false
    }
    return true
  }))
}

function renderTasks() {
  const project = activeProject()
  if (!project) return noProject()
  const tasks = filteredTasks()
  const members = project.members ?? []
  const filtering = Boolean(state.taskFilter.search) || state.taskFilter.status !== 'all' || state.taskFilter.assignee !== 'all' || state.taskFilter.timeRange !== 'all'
  // 头部计数口径（DSHBOTS-62）：与各分组计数同源，取「各组计数之和」——
  // 头部数字必须等于面板上真正看到的行数之和，不能各算各的（口径不一致就会出现头部与分组对不上）。
  // 与项目总数（设置页「任务总数」同源）的差额单独提示，不混进主计数。
  const groupCounts = STATUS_ORDER.map(status => tasks.filter(task => task.status === status).length)
  const shownCount = groupCounts.reduce((sum, count) => sum + count, 0)
  const totalCount = Number(project.stats?.tasks ?? state.data?.tasks?.length ?? shownCount)
  const hiddenCount = Math.max(0, totalCount - shownCount)
  return `
    <div class="section-head">
      <p>拖拽任务行切换状态，点组头可折叠分组。</p>
      <div class="board-toolbar" style="margin:0">
        <input class="input search" id="task-search" placeholder="搜索任务、编号或标签" aria-label="搜索任务、编号或标签" value="${attr(state.taskFilter.search)}">
        <select class="select" data-task-filter="status">
          <option value="all">全部状态</option>
          ${STATUS_ORDER.map(status => `<option value="${status}" ${state.taskFilter.status === status ? 'selected' : ''}>${STATUS[status]}</option>`).join('')}
        </select>
        <select class="select" data-task-filter="assignee">
          <option value="all">全部成员</option>
          ${members.map(member => `<option value="${attr(member.id)}" ${state.taskFilter.assignee === member.id ? 'selected' : ''}>${esc(member.name)}</option>`).join('')}
        </select>
        <select class="select" data-task-filter="timeRange" aria-label="按终态时间筛选">
          <option value="1d" ${state.taskFilter.timeRange === '1d' ? 'selected' : ''}>今天</option>
          <option value="7d" ${state.taskFilter.timeRange === '7d' ? 'selected' : ''}>近 7 天</option>
          <option value="30d" ${state.taskFilter.timeRange === '30d' ? 'selected' : ''}>近 30 天</option>
          <option value="all" ${state.taskFilter.timeRange === 'all' ? 'selected' : ''}>全部时间</option>
        </select>
        <select class="select" data-task-sort aria-label="任务排序" title="组内排序：不影响分组与父子层级">
          ${TASK_SORTS.map(sort => `<option value="${sort.value}" ${state.taskSort === sort.value ? 'selected' : ''}>${sort.label}</option>`).join('')}
        </select>
        <span class="tag">${shownCount} 个任务</span>
        ${hiddenCount > 0 ? `<span class="faint" title="项目共 ${totalCount} 个任务；当前筛选、时间窗或列表上限隐藏了 ${hiddenCount} 个">项目共 ${totalCount} 个 · 隐藏 ${hiddenCount} 个</span>` : ''}
      </div>
    </div>
    ${tasks.length === 0 ? `<div class="empty-state">
      <div class="empty-symbol">${icon('board')}</div>
      <h3>${filtering ? '没有匹配的任务' : '任务面板还是空的'}</h3>
      <button class="btn" data-action="new-task">${icon('plus')}新建任务</button>
    </div>` : `<div class="board board-list">
      ${STATUS_ORDER.map(status => renderTaskGroup(status, tasks.filter(task => task.status === status))).join('')}
    </div>`}
  `
}

// 任务分组（DSHBOTS-58，参照 Linear）：按状态分组的树形分组列表，组头可折叠。
// 展开态记在 state.openPanels（key: task-group:<status>），组体容器带同一个 data-panel key —— 与 <details data-panel> 同一套通道。
// 组 section 仍然带 data-drop-status：拖拽换状态的通道不变，拖到组头/组体即改状态（DSHBOTS-54 看板联动靠它）。
function taskGroupKey(status) {
  return `task-group:${status}`
}

function renderTaskGroup(status, tasks) {
  const key = taskGroupKey(status)
  const expanded = state.openPanels.has(key)
  // 空组不渲染组体（DSHBOTS-62 P1-4）：只留一行组头，去掉「拖到这里」占位留下的大块竖向空白；
  // 组 section 仍带 data-drop-status，拖到组头照样能改状态，拖放通道不变。
  const body = tasks.length === 0 ? '' : renderTaskRows(tasks)
  return `<section class="column task-group${expanded ? '' : ' collapsed'}" data-drop-status="${status}">
    <div class="column-head task-group-head">
      <button type="button" class="task-group-toggle" data-action="toggle-task-group" data-status="${attr(status)}" aria-expanded="${expanded ? 'true' : 'false'}" title="${expanded ? '折叠' : '展开'}${esc(STATUS[status])}分组">${icon('chevron', `chev${expanded ? ' open' : ''}`)}</button>
      <span class="column-dot ${status}"></span>
      <strong>${STATUS[status]}</strong>
      <span class="column-count">${tasks.length}</span>
    </div>
    ${expanded && body ? `<div class="task-group-body" data-panel="${attr(key)}">${body}</div>` : ''}
  </section>`
}

// Linear 式状态图标：小圆环（待办/进行中/受阻/待验收），已完成是环内对勾，已取消是环内横杠。
// 颜色沿用现有状态色 token（与分组头圆点同色表），形状靠 CSS 画，无需额外图标资源。
function taskStatusIcon(task) {
  const status = task?.status ?? 'todo'
  const label = STATUS[status] ?? status
  return `<span class="task-status-icon ${attr(status)}" title="${attr(label)}" aria-label="${attr(label)}">${status === 'done' ? icon('check') : ''}</span>`
}

// 优先级图标：三档横条 + title 说明（紧急/高/中/低/无），配色沿用现有优先级色（danger/star/accent/ink-3）。
function taskPriorityIcon(task) {
  const key = taskPriorityKey(task?.priority)
  const label = PRIORITY[key] ?? key
  return `<span class="task-priority ${key}" title="优先级：${esc(label)}" aria-label="优先级：${esc(label)}">${icon('priority')}</span>`
}

// task-card:start —— 任务行（DSHBOTS-58，参照 Linear）：紧凑单行 —— 状态图标 + 优先级图标 + 编号 + 标题 + 右簇（标签/依赖/运行态/终态时间/头像）。
// 运行徽标文案来自后端 taskStage 纯函数查表的 stageLabel，不再从 latestRun.status 拼映射。
// 终态（done/canceled → stage 'ended'）一律不渲染任何运行徽标：状态点、运行文案、计时与 running 高亮全部隐藏，
// 已完成/已取消任务上挂着的遗留运行不再误导看板。
function renderTaskCard(task, options = {}) {
  const depth = Number(options.depth ?? 0)
  const childCount = Number(options.childCount ?? 0)
  const expanded = options.expanded === true
  const bot = botById(task.assignee_bot_id)
  const run = task.latestRun
  const stage = task.stage ?? { stage: 'idle' }
  const ended = stage.stage === 'ended'
  const runLabel = ended ? '' : task.stageLabel ?? ''
  const tags = []
  if (task.status === 'in_review') tags.push(task.review_target === 'owner_bot' ? '总监验收中' : '待您验收')
  for (const label of task.labels ?? []) tags.push(label)
  const isRunning = stage.stage === 'working' && !stage.action
  // 终态时间小字（DSHBOTS-44）：done 取 completed_at、canceled 取 canceled_at，缺列或非终态不显示。
  const endAt = task.status === 'done' ? task.completed_at : task.status === 'canceled' ? task.canceled_at : null
  // 依赖徽标（DSHBOTS-58）：depsSatisfied=false 即被未完成的任务挡住；blockedByNames 只列未满足项。
  const blockedNames = Array.isArray(task.blockedByNames) ? task.blockedByNames : []
  const depsBlocked = task.depsSatisfied === false && blockedNames.length > 0
  const depsTitle = `被 ${blockedNames.length} 个任务阻塞：${blockedNames.join('、')}`
  return `<article class="task-card${isRunning ? ' running' : ''}${depth > 0 ? ' task-child' : ''}" draggable="true" data-task-id="${attr(task.id)}" data-action="open-task">
    ${taskStatusIcon(task)}
    ${taskPriorityIcon(task)}
    <div class="task-card-top">
      ${childCount > 0 ? `<button type="button" class="task-children-toggle" data-action="toggle-task-children" data-task-id="${attr(task.id)}" aria-expanded="${expanded ? 'true' : 'false'}" title="${expanded ? '折叠' : '展开'}${childCount} 个子任务">${icon('chevron', `chev${expanded ? ' open' : ''}`)}</button>` : ''}
      <span class="task-id">${esc(task.identifier)}</span>
    </div>
    <div class="task-card-title" title="${attr(task.title)}">${esc(task.title)}</div>
    <div class="task-card-foot">
      ${tags.length ? `<span class="task-tags">${tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}</span>` : ''}
      ${depsBlocked ? `<span class="task-deps-badge" title="${attr(depsTitle)}">${icon('alert')}被 ${blockedNames.length} 个任务阻塞</span>` : ''}
      ${!ended && run ? runDot(run.status) : ''}
      <span class="task-run-label">${runLabel}</span>
      ${isRunning ? `<span class="run-clock" data-started="${attr(run.started_at ?? '')}">${duration(run.started_at)}</span>` : ''}
      ${endAt ? `<span class="task-end-time" title="${attr(endAt)}">${icon('check')} ${formatTime(endAt)}</span>` : ''}
      ${bot ? avatar(bot, 'sm') : '<span class="faint">未指派</span>'}
    </div>
  </article>`
}
// task-card:end

// 任务父子层级（DSHBOTS-58 第二笔，依赖后端 D-59 落库的 parent_task_id）：
// 分组内按 parent_task_id 组树——子任务挂到父行下方、容器左缩进一级，父行可折叠子行；
// 展开态记在 state.openPanels，key 形如 task-children:<taskId>（与 <details data-panel> 同一套 key 口径）。
// 只有父任务也在本组可见时才挂成子级：父被搜索/筛选掉、或父在别的状态分组时，
// 子任务回到本组顶层，避免任务因为层级关系在看板上凭空消失。
function taskChildrenKey(taskId) {
  return `task-children:${taskId}`
}

function taskParentId(task) {
  return task?.parent_task_id ?? task?.parentTaskId ?? null
}

function renderTaskRows(tasks) {
  // D-63：进组后先按当前排序档重排兄弟顺序，再组树——排序只影响同层先后，
  // 父子挂载按 parent_task_id 判定，不因顺序变化拆树（分组结构在 renderTaskGroup 上游，不在本函数）。
  const sorted = sortTasksForPanel(tasks)
  const visible = new Set(sorted.map(task => task.id))
  const childrenOf = new Map()
  const roots = []
  for (const task of sorted) {
    const parentId = taskParentId(task)
    if (parentId && visible.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, [])
      childrenOf.get(parentId).push(task)
    } else {
      roots.push(task)
    }
  }
  const renderSubtree = (task, depth) => {
    const children = childrenOf.get(task.id) ?? []
    const key = taskChildrenKey(task.id)
    const expanded = children.length > 0 && state.openPanels.has(key)
    const row = renderTaskCard(task, { depth, childCount: children.length, expanded })
    if (!children.length || !expanded) return row
    return `${row}<div class="task-children" data-panel="${attr(key)}">${children.map(child => renderSubtree(child, depth + 1)).join('')}</div>`
  }
  return roots.map(task => renderSubtree(task, 0)).join('')
}

// ── 项目「终端」tab：非交互式命令台（无 PTY/xterm），输入命令 → 项目工作目录执行 → 实时输出 ──
// 实时 tail 由 1s 轮询直更输出区（startTerminalPoll），常规状态走 2.8s poll 的 view.terminal。
function terminalStatusPill(status) {
  const tone = status === 'succeeded' ? 'green' : ['failed', 'timeout', 'interrupted'].includes(status) ? 'red' : status === 'running' ? 'amber' : ''
  return `<span class="pill ${tone}">${esc(TERMINAL_STATUS[status] ?? status)}</span>`
}

function terminalOutputText(terminal) {
  return terminal?.active?.output ?? terminal?.history?.[0]?.output ?? ''
}

function renderTerminal() {
  const project = activeProject()
  if (!project || inSoloContext()) return noProject()
  const terminal = state.data?.terminal ?? { active: null, history: [] }
  const active = terminal.active
  const latest = active ?? terminal.history[0] ?? null
  const output = terminalOutputText(terminal)
  // 有任务类运行在写该项目工作区时只提示不拦截：终端命令与它并发执行的风险由用户自担。
  const taskBusy = (state.data?.runs ?? []).some(run => run.kind === 'task' && ['queued', 'running'].includes(run.status))
  return `
    <div class="terminal-page">
      <div class="terminal-main">
        <div class="card terminal-card${active ? ' is-running' : ''}">
          <div class="terminal-chrome">
            <span class="terminal-chrome-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="terminal-chrome-label">终端</span>
            <span class="terminal-chrome-path" title="${attr(project.workspace_path ?? '')}">${esc(project.workspace_path ?? project.name)}</span>
          </div>
          ${active ? `<div class="terminal-active-row">
            ${runDot('running')}
            <code class="terminal-active-cmd">${esc(active.command)}</code>
            <span class="run-clock" data-started="${attr(active.createdAt ?? '')}">${duration(active.createdAt)}</span>
            <button class="btn danger terminal-stop" data-action="terminal-stop" data-command-id="${attr(active.id)}">${icon('stop')}<span class="btn-label">停止</span></button>
          </div>` : ''}
          <div class="terminal-output-wrap">
            <pre class="terminal-output" id="terminal-output" data-command-id="${attr(latest?.id ?? '')}">${output ? esc(output) : ''}</pre>
            ${output ? '' : `<div class="terminal-output-empty">${icon('terminal', 'terminal-empty-icon')}<span>暂无输出。执行一条命令后，这里显示实时输出（最多保留末尾 200KB）。</span></div>`}
          </div>
          <form class="terminal-input-row" data-form="terminal-run">
            <input type="hidden" name="projectId" value="${attr(project.id)}">
            <span class="terminal-prompt" aria-hidden="true">$</span>
            <input class="input terminal-input" id="terminal-cmd-input" name="command" placeholder="${active ? '有命令正在运行…' : '输入命令'} " value="${attr(state.terminalDraft)}" autocomplete="off" autocapitalize="off" spellcheck="false" ${active ? 'disabled' : ''}>
            ${active ? '' : '<span class="terminal-kbd" aria-hidden="true">⌘ / Ctrl ↵</span>'}
            <button class="btn primary" type="submit" ${active ? 'disabled' : ''}>${icon('play')}<span class="btn-label">执行</span></button>
          </form>
        </div>
      </div>
      <aside class="terminal-side">
        ${taskBusy ? `<div class="terminal-warn">${icon('alert', 'terminal-warn-icon')}<span class="terminal-warn-text">有任务正在写该项目工作区，终端命令与它并发需自担风险</span></div>` : ''}
        <div class="card terminal-history-card">
          <div class="terminal-history-head"><span class="eyebrow">命令历史</span><span class="tag">${terminal.history.length} 条</span></div>
          ${terminal.history.length === 0 ? '<div class="terminal-history-empty">还没有执行过命令。</div>' : `<div class="terminal-history">
            ${terminal.history.map(item => `
              <button class="terminal-history-item" data-action="terminal-fill" data-command="${attr(item.command)}" data-status="${attr(item.status ?? '')}" title="点击回填到输入框">
                ${terminalStatusPill(item.status)}
                <code class="terminal-history-cmd">${esc(item.command)}</code>
                <span class="terminal-history-meta">
                  ${item.status === 'running' ? `<span class="run-clock" data-started="${attr(item.createdAt ?? '')}">${duration(item.createdAt)}</span>` : `exit ${item.exitCode ?? '—'} · ${duration(item.createdAt, item.endedAt)}`}
                  · ${formatTime(item.createdAt)}
                </span>
              </button>
            `).join('')}
          </div>`}
        </div>
      </aside>
    </div>
  `
}

function renderBots() {
  const bots = state.data?.bots ?? []
  return `
    ${bots.length === 0 ? `<div class="empty-state">
      <div class="empty-symbol">${icon('bot')}</div><h3>还没有 Bot</h3><p>至少创建一个 Bot 才能运行项目群聊和任务。</p>
      <button class="btn" data-action="new-bot">${icon('plus')}新建 Bot</button>
    </div>` : `<div class="grid bots">
      ${bots.map(bot => `<article class="card bot-card">
        <div class="bot-card-head">
          ${avatar(bot, 'lg')}
          <div class="bot-card-title"><strong>${esc(bot.name)}</strong><span>${esc(bot.role || '通用成员')}</span></div>
          <span class="bot-status ${attr(bot.status)}">${esc(BOT_STATUS[bot.status] ?? bot.status)}</span>
        </div>
        <div class="bot-model"><span>${esc(bot.modelRef ?? '未配置模型')}${bot.effort ? ` · ${esc(EFFORT[bot.effort] ?? bot.effort)}` : ''}</span></div>
        <div class="bot-metrics"><span><strong>${bot.openTasks}</strong> 任务</span><span class="dot-sep"></span><span><strong>${bot.memoryCount}</strong> 记忆</span><span class="dot-sep"></span><span><strong>${bot.stats.succeeded}</strong> 次成功</span></div>
        <div class="bot-card-actions">
          <button class="btn small" data-action="edit-bot" data-bot-id="${attr(bot.id)}">${icon('edit')}配置</button>
          ${bot.status === 'active' ? `<button class="btn small" data-action="solo-bot" data-bot-id="${attr(bot.id)}" title="打开该 Bot 的调度页">调度</button><button class="btn small" data-action="archive-bot" data-bot-id="${attr(bot.id)}">归档</button>` : ''}
        </div>
      </article>`).join('')}
    </div>`}
  `
}

// 总览bots：全部 Bot 管理（复用 renderBots）+ 按 bot 分组的待审提案批量审批。
// 进化审批从项目 NAV 移到这里（批量）与单聊 bot tab（逐个），项目群聊不再有进化入口。
function renderBotsOverview() {
  const pending = (state.data?.proposals ?? []).filter(item => item.status === 'pending')
  const groups = new Map()
  for (const item of pending) {
    const key = item.bot_id ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const proposalsSection = pending.length === 0 ? '' : `
    <section class="section">
      <div class="section-head"><h3>待审批提案</h3><span>${pending.length} 条待审</span></div>
      ${[...groups.entries()].map(([botId, items]) => {
        const bot = botById(botId)
        const label = bot ? `${bot.name}（${bot.role || '成员'}）` : '未归属 Bot'
        return `
        <div class="card" style="margin-bottom: 10px;">
          <div class="bot-card-head">
            ${botId ? avatar(bot, 'sm') : `<div class="avatar sm">${icon('bot')}</div>`}
            <div class="bot-card-title"><strong>${esc(label)}</strong><span>${items.length} 条待审提案</span></div>
            <div class="bot-card-actions">
              <button class="btn small" data-action="batch-decide-proposals" data-bot-id="${attr(botId)}" data-decision="approved">${icon('check')}全部通过并应用</button>
              <button class="btn small" data-action="batch-decide-proposals" data-bot-id="${attr(botId)}" data-decision="rejected">全部拒绝</button>
            </div>
          </div>
          <div class="list">
            ${items.map(item => `
              <div class="list-row" title="${esc(item.title ?? '')}">
                ${avatar({ name: label, color: 'gray' }, 'sm')}
                <div class="list-main">
                  <div class="list-title"><strong>${esc(item.title ?? '未命名提案')}</strong><span class="member-role">${esc(PROPOSAL_KIND[item.kind] ?? item.kind)}</span></div>
                  <div class="list-meta"><span>${esc(item.created_at ?? '')}</span></div>
                </div>
              </div>`).join('')}
          </div>
        </div>`
      }).join('')}
    </section>`
  return `
    ${proposalsSection}
    <div class="section-head"><h3>全部 Bots</h3><button class="btn" data-action="new-bot">${icon('plus')}新建 Bot</button></div>
    ${renderBots()}
  `
}

// 项目成员管理页：状态与用量均按当前项目聚合（busy=本项目有排队/运行中运行；
// usage 四项与 cost 为该项目全部运行的累计）。邀请走 add_member API，移除走 remove_member。
// DSHBOTS-52：成员行改卡片式网格；上头像、中名称+角色、下状态点与用量。
// DSHBOTS-57：卡片放大（max-width 320px、头像 56px），中段改三行式——名称 / 角色标签 /
// provider·model 小字，模型不再收进 title 提示，关键信息全部在卡面可见；
// 尺寸与「总览bots」的 bot 卡片同口径，不再锁 0.618:1 宽高比（用户 m_c2ff7f）。
// DSHBOTS-65：卡底去掉与 busy pill 重复的运行状态行，新增「已完成 n · 待办 m」任务统计
// （member.taskStats，待办=未完成且未取消，与右侧 pill 各说各的：pill 说运行态，统计说任务量）。
function renderMembers() {
  const project = activeProject()
  if (!project) return noProject()
  const members = project.members ?? []
  return `
    <div class="section-head">
      <p>成员状态与用量按本项目口径聚合；移除后该 Bot 不再接收本项目的提及与新任务。</p>
      <div class="btn-row">
        <button class="btn" data-action="open-invite-member">${icon('plus')}邀请加入</button>
        <button class="btn" data-action="nav" data-view="bots-overview" title="查看全部 Bot 或新建">${icon('bot')}总览bots</button>
      </div>
    </div>
    <div class="members-grid">
      ${members.map(member => {
        const bot = botById(member.id)
        if (!bot) return ''
        const dot = memberRunDot(member)
        const isOwner = member.member_role === 'owner' || member.id === project.owner_bot_id
        const tokens = Number(member.usage_input ?? 0) + Number(member.usage_cache_read ?? 0) + Number(member.usage_cache_write ?? 0) + Number(member.usage_output ?? 0)
        const modelRef = member.modelRef ?? bot.modelRef ?? bot.model ?? null
        const modelLine = modelRef ? String(modelRef) : '未配置'
        const taskStats = member.taskStats ?? {}
        const taskDone = Number(taskStats.done ?? 0)
        const taskOpen = Number(taskStats.open ?? 0)
        const usageDetail = `输入 ${formatNumber(member.usage_input)} · 缓存读 ${formatNumber(member.usage_cache_read)} · 缓存写 ${formatNumber(member.usage_cache_write)} · 输出 ${formatNumber(member.usage_output)}`
        return `
        <div class="member-card${isOwner ? ' is-owner' : ''}" data-member-card data-bot-id="${attr(member.id)}" title="${esc(bot.name)} · ${esc(bot.role || '成员')} · ${esc(dot.text)}">
          ${isOwner ? '' : `<button class="member-card-remove" data-action="remove-member" data-bot-id="${attr(member.id)}" title="移出项目" aria-label="将 ${esc(bot.name)} 移出项目">${icon('close')}</button>`}
          <div class="member-card-top">${avatar(bot, 'lg')}</div>
          <div class="member-card-mid">
            <div class="member-card-name"><strong>${esc(bot.name)}</strong></div>
            <div class="member-card-role">${isOwner ? '<span class="pill violet">总监</span>' : `<span class="member-role">${esc(bot.role || '成员')}</span>`}</div>
            <div class="member-card-model" title="${esc(modelLine)}">${esc(modelLine)}</div>
          </div>
          <div class="member-card-foot">
            <span class="pill ${member.busy ? 'amber' : 'green'} member-card-busy">${member.busy ? '任务中' : '空闲中'}</span>
            <span class="member-card-tasks" title="本项目任务：已完成 ${taskDone} · 待办 ${taskOpen}（待办不含已取消）">已完成 ${taskDone} · 待办 ${taskOpen}</span>
            <span class="member-card-usage" title="${esc(usageDetail)}">合计 <strong>${formatNumber(tokens)}</strong> tokens</span>
            <span class="member-card-cost"><strong>${formatCost(Number(member.usage_cost ?? 0))}</strong></span>
          </div>
        </div>`
      }).join('')}
    </div>
  `
}

function renderSkills() {
  const skills = state.data?.skills ?? []
  const projectSkills = state.data?.projectSkills ?? []
  const proposals = (state.data?.proposals ?? []).filter(item => item.kind === 'skill' && item.status === 'pending')
  const project = pageProject()
  const disabledSet = new Set(project?.disabledSkills ?? [])
  return `
    <div class="section-head">
      <p>技能变更走提案和审批，不直接覆盖。${project ? `开关只作用于当前项目「${esc(project.name)}」：关闭后补全不再列出，Bot 会被明确告知不要调用；技能池本身不变。` : '进入一个项目后可按项目关闭特定技能。'}</p>
      <div class="btn-row">
        <button class="btn" data-action="sync-skills">${icon('refresh')}重新扫描</button>
      </div>
    </div>
    <div class="card-head" style="margin-bottom:10px"><h3>共享技能池</h3></div>
    <div class="path-row plain" style="margin-bottom:14px"><span>技能根目录</span><code>${esc(state.data.paths.skillRoot)}/skills</code><button class="btn icon small" data-action="copy" data-copy="${attr(state.data.paths.skillRoot + '/skills')}">${icon('copy')}</button></div>
    <div class="card list-card">
      ${skills.length === 0 ? `<div class="empty-state" style="border:0"><div class="empty-symbol">${icon('spark')}</div><h3>技能池为空</h3><p>在技能根目录放置技能文件，或提交一个技能提案并审批。</p></div>` : skills.map(skill => {
        const off = disabledSet.has(skill.slug)
        return `
        <div class="list-row skill-row">
          <div class="empty-symbol" style="width:30px;height:30px;border-radius:9px;margin:0">${icon('spark')}</div>
          <div class="list-main">
            <div class="list-title"><span class="skill-slug">${esc(skill.slug)}</span><span class="faint mono">v${esc(currentSkillVersion(skill))}</span><span class="pill ${skill.status === 'active' ? 'green' : 'red'}">${esc(SKILL_STATUS[skill.status] ?? skill.status)}</span>${off ? '<span class="pill red">本项目已关闭</span>' : ''}</div>
            <div class="list-desc">${esc(skill.description || '无描述')}</div>
            <div class="list-meta"><span>${esc(skill.relativePath)}</span></div>
            ${skillVersions(skill)}
          </div>
          <div class="btn-row">
            <button class="btn small" data-action="skill-detail" data-slug="${attr(skill.slug)}">详情</button>
            ${project ? `<button class="btn small" data-action="toggle-skill" data-slug="${attr(skill.slug)}" data-disabled="${off ? '0' : '1'}">${off ? '恢复' : '本项目关闭'}</button>` : ''}
          </div>
        </div>
      `}).join('')}
    </div>
    ${project ? `<div class="card-head" style="margin-top:24px"><h3>当前项目技能</h3></div>
    <div class="section-head"><p>从项目目录（设了生产目录以生产目录为准，见下方实际路径）的 <code>.agents</code>、<code>.claude</code>、<code>.codex</code> 三个根扫描发现；同名技能按 .agents &gt; .claude &gt; .codex 去重。这些技能只在当前项目可用，且优先于同名共享技能。</p></div>
    ${(state.data.paths.projectSkillRoots ?? []).map(root => `<div class="path-row plain" style="margin-bottom:6px"><span style="text-transform:none">${esc(root.root)}</span><code>${esc(root.path)}/skills</code><button class="btn icon small" data-action="copy" data-copy="${attr(root.path + '/skills')}">${icon('copy')}</button></div>`).join('')}
    <div class="card list-card">
      ${projectSkills.length === 0 ? `<div class="empty-state" style="border:0"><div class="empty-symbol">${icon('spark')}</div><h3>项目内没有技能</h3><p>在项目目录的 .agents、.claude 或 .codex 下放置 skills/&lt;技能名&gt;/SKILL.md 即可。</p></div>` : projectSkills.map(skill => {
        const off = disabledSet.has(skill.name)
        const dupRoots = (skill.roots ?? []).filter(root => root !== skill.root)
        return `
        <div class="list-row skill-row">
          <div class="empty-symbol" style="width:30px;height:30px;border-radius:9px;margin:0">${icon('spark')}</div>
          <div class="list-main">
            <div class="list-title"><span class="skill-slug">${esc(skill.name)}</span><span class="faint mono">v${esc(skill.version ?? '1.0.0')}</span><span class="pill green">${esc(skill.root)}</span>${off ? '<span class="pill red">本项目已关闭</span>' : ''}</div>
            <div class="list-desc">${esc(skill.description || '无描述')}</div>
            <div class="list-meta"><span>${esc(skill.relativePath)}</span></div>
            ${dupRoots.length ? `<div class="list-meta"><span>同名技能也出现在 ${dupRoots.map(root => esc(root)).join('、')}，按 ${esc(skill.root)} 优先取用</span></div>` : ''}
          </div>
          <div class="btn-row">
            <button class="btn small" data-action="copy" data-copy="${attr(skill.path)}">${icon('copy')}复制路径</button>
          </div>
        </div>
      `}).join('')}
    </div>` : ''}
    ${proposals.length ? `<div class="card-head" style="margin-top:24px"><h3>待审批技能提案</h3></div>
    <div class="grid">
      ${proposals.map(item => `<div class="card proposal-card">
        <div class="proposal-head"><div class="empty-symbol" style="width:30px;height:30px;border-radius:9px;margin:0">${icon('spark')}</div><div><h3>${esc(item.title)}</h3><p>${esc(item.rationale)}</p></div></div>
        <div class="proposal-actions"><span class="pill">待审</span><button class="btn small" data-action="decide-proposal" data-proposal-id="${attr(item.id)}" data-decision="approved">${icon('check')}通过</button><button class="btn small" data-action="decide-proposal" data-proposal-id="${attr(item.id)}" data-decision="rejected">拒绝</button></div>
      </div>`).join('')}
    </div>` : ''}
  `
}

function memoryStatusTone(status) {
  if (status === 'active') return 'green'
  if (status === 'pending') return 'amber'
  if (status === 'rejected' || status === 'archived') return 'red'
  return ''
}

function pendingMemoryCount() {
  const list = state.data?.memories
  if (Array.isArray(list)) return list.filter(item => item.status === 'pending').length
  return Number(list?.pending ?? 0)
}

async function searchMemories() {
  const query = String(state.memoryQuery ?? '').trim()
  if (!query) {
    state.memoryResults = null
    render()
    return
  }
  const project = pageProject()
  const payload = { query }
  if (project) payload.projectId = project.id
  else if (inSoloContext() && state.soloBotId) payload.botId = state.soloBotId
  const result = await api('search_memories', payload)
  state.memoryResults = Array.isArray(result) ? result : (result?.items ?? [])
  render()
}

function renderMemory() {
  const project = pageProject()
  // 记忆随上下文收敛（DSHBOTS-5）：群聊=当前项目 scope、单聊=该 bot scope，服务端已按上下文过滤，
  // 客户端不再有作用域筛选与「团队记忆」概念。
  const memories = state.data?.memories ?? []
  const pending = pendingMemoryCount()
  const results = state.memoryResults
  return `
    ${memories.length === 0 ? '' : `<div class="board-toolbar">
      <input class="input search" id="memory-search" placeholder="搜索记忆主题或内容" aria-label="搜索记忆主题或内容" value="${attr(state.memoryQuery)}">
      <button class="btn" data-action="search-memories">${icon('search')}搜索</button>
      ${pending ? `<span class="pill amber">${pending} 条待审</span>` : ''}
      <span class="tag" style="margin-left:auto">${memories.length} 条</span>
    </div>`}
    ${results ? `<div class="card list-card" style="margin-bottom:12px">
      <div class="card-head"><h3>搜索结果（${results.length}）</h3><button class="btn small" data-action="clear-memory-search">${icon('close')}清除</button></div>
      ${results.length === 0 ? '<div class="faint">没有匹配的记忆。</div>' : results.map(item => `<div class="list-row">
        <div class="list-main">
          <div class="list-title">${esc(item.topic)}<span class="pill ${memoryStatusTone(item.status)}">${esc(MEMORY_STATUS[item.status] ?? item.status ?? '未知')}</span></div>
          <div class="list-desc">${esc(item.content)}</div>
          <div class="list-meta"><span>${esc(item.scope_type === 'project' ? '项目' : (botById(item.scope_id)?.name ?? 'Bot'))}</span><span>${esc(timeAgo(item.updated_at))}</span></div>
        </div>
      </div>`).join('')}
    </div>` : ''}
    ${!project && !inSoloContext() ? noProject() : memories.length === 0 ? `<div class="empty-state"><div class="empty-symbol">${icon('memory')}</div><h3>还没有记忆</h3><p>任务完成后会自动沉淀交付经验。</p><button class="btn" data-action="new-memory">${icon('plus')}写入记忆</button></div>` : `<div class="grid">
      ${memories.map(memory => {
        const scopeName = memory.scope_type === 'project' ? '项目' : (botById(memory.scope_id)?.name ?? 'Bot')
        const status = memory.status ?? 'active'
        return `<article class="card list-card">
          <div class="list-row">
            <div class="list-main">
              <div class="card-head">
                <div class="list-title">${esc(memory.topic)}<span class="pill ${memoryStatusTone(status)}">${esc(MEMORY_STATUS[status] ?? status)}</span></div>
                <div class="btn-row">
                  ${status === 'pending' ? `<button class="btn small" data-action="approve-memory" data-memory-id="${attr(memory.id)}">${icon('check')}通过</button><button class="btn small" data-action="reject-memory" data-memory-id="${attr(memory.id)}">${icon('close')}拒绝</button>` : ''}
                  <span class="pill">${esc(scopeName)}</span>
                  <button class="btn icon" data-action="edit-memory" data-memory-id="${attr(memory.id)}" title="编辑记忆" aria-label="编辑记忆">${icon('edit')}</button>
                  <button class="btn icon" data-action="delete-memory" data-memory-id="${attr(memory.id)}" title="删除记忆" aria-label="删除记忆">${icon('trash')}</button>
                </div>
              </div>
              <div class="list-desc">${esc(memory.content)}</div>
              <div class="list-meta" style="justify-content:space-between">
                <span>${esc(memorySource(memory.source))}</span>
                <span>${esc(timeAgo(memory.updated_at))} · 置信度 ${Number(memory.confidence ?? 0).toFixed(2)}${memory.approved_by ? ` · 审批人 ${esc(actorLabel(memory.approved_by))}` : ''}</span>
              </div>
            </div>
          </div>
        </article>`
      }).join('')}
    </div>`}
  `
}

function currentSkillVersion(skill) {
  return skill?.currentVersion ?? skill?.version ?? '—'
}

function skillVersions(skill, { rollback = true } = {}) {
  const versions = skill?.versions ?? []
  if (!versions.length) return ''
  const current = String(currentSkillVersion(skill))
  const key = `skill-versions:${skill.slug}`
  return `<details class="skill-versions"${panelAttrs(state, key)}>
    <summary class="summary-link">版本历史（${versions.length}）</summary>
    ${versions.map(version => `<div class="list-meta">
      <span class="mono">v${esc(version.version)}</span>
      <span>${esc(version.status ?? '')}</span>
      <span>${esc(timeAgo(version.created_at))}</span>
      ${String(version.version) !== current && rollback ? `<button class="btn small" data-action="rollback-skill" data-slug="${attr(skill.slug)}" data-version="${attr(version.version)}">回滚</button>` : ''}
    </div>`).join('')}
  </details>`
}

function canaryText(canary) {
  if (!canary) return ''
  if (typeof canary === 'string') return canary
  if (typeof canary === 'object') {
    const parts = Object.entries(canary).map(([key, value]) => {
      const label = key === 'projectIds' ? '项目' : key
      const values = Array.isArray(value) ? value.join('、') : String(value)
      return `${label} ${values}`
    })
    return parts.join(' · ')
  }
  return String(canary)
}

function evaluationText(evaluation) {
  if (!evaluation) return ''
  if (typeof evaluation === 'string') return evaluation
  const verdict = { pass: '通过', fail: '不通过', pending: '待评估' }[evaluation.verdict] ?? evaluation.verdict ?? ''
  const notes = evaluation.notes ? `：${evaluation.notes}` : ''
  const by = evaluation.evaluatedBy ? `（${evaluation.evaluatedBy}）` : ''
  return `${verdict}${notes}${by}`
}

function proposalPreview(proposal) {
  const payload = proposal.payload ?? {}
  if (proposal.kind === 'skill') return payload.content || '技能内容为空'
  if (proposal.kind === 'bot_update') {
    return [payload.role ? `role: ${payload.role}` : '', payload.instructions ? `instructions:\n${payload.instructions}` : '', payload.model ? `model: ${payload.provider}/${payload.model}` : ''].filter(Boolean).join('\n\n') || '无配置内容'
  }
  return JSON.stringify(payload, null, 2)
}

function renderEvolution() {
  const proposals = state.data?.proposals ?? []
  // 单聊进化 tab 只看该 bot 自己的提案（逐个审批）；项目群聊不再挂进化入口（批量审批在「总览bots」）。
  const scoped = inSoloContext() ? proposals.filter(item => item.bot_id === state.soloBotId) : proposals
  const pending = scoped.filter(item => item.status === 'pending')
  const proposalDiff = (proposal) => {
    const payload = proposal.payload ?? {}
    const bot = proposal.bot_id ? botById(proposal.bot_id) : null
    const blocks = []
    if (proposal.kind === 'bot_update' && bot) {
      const fields = [
        ['role', bot.role, payload.role],
        ['instructions', bot.instructions, payload.instructions],
        ['model', bot.modelRef ?? bot.model, payload.model ? `${payload.provider ?? bot.provider}/${payload.model}` : ''],
        ['effort', bot.effort, payload.effort]
      ]
      for (const [field, before, after] of fields) {
        if (!after || String(before ?? '') === String(after)) continue
        blocks.push(`${field}\n- ${before}\n+ ${after}`)
      }
    }
    if (proposal.kind === 'skill') {
      blocks.push(`skill ${payload.slug ?? payload.name ?? 'new'}\n+ ${payload.content ?? proposalPreview(proposal)}`)
    }
    if (!blocks.length) blocks.push(proposalPreview(proposal))
    return blocks.join('\n\n')
  }
  const proposalDiffText = (proposal) => {
    const diff = proposal?.diff
    if (diff && typeof diff === 'object') {
      const blocks = Object.entries(diff).map(([field, change]) => {
        const from = change?.from ?? ''
        const to = change?.to ?? ''
        if (!from && !to) return ''
        return `${field}\n- ${from}\n+ ${to}`
      }).filter(Boolean)
      if (blocks.length) return blocks.join('\n\n')
    }
    return proposalDiff(proposal)
  }
  return `
    <div class="section-head">
      <p>变更需经人工审批后生效。</p>
      <div class="btn-row">
        ${pending.length ? `<span class="pill">${pending.length} 个待审批</span>` : ''}
        <button class="btn" data-action="new-proposal" data-kind="bot_update">${icon('plus')}新建提案</button>
      </div>
    </div>
    ${scoped.length === 0 ? `<div class="empty-state"><div class="empty-symbol">${icon('branch')}</div><h3>还没有进化提案</h3><p>Bot 可以提交自我改进建议，但无法自行批准。</p><button class="btn" data-action="new-proposal" data-kind="bot_update">${icon('plus')}新建提案</button></div>` : `<div class="grid" style="gap:16px">
      ${scoped.map(proposal => {
        const tone = proposal.status === 'approved' ? 'green' : proposal.status === 'rejected' ? 'red' : ''
        return `<article class="card proposal-card">
          <div class="card-head">
            <div class="proposal-head" style="flex:1;min-width:0">
              <div class="empty-symbol" style="width:34px;height:34px;border-radius:9px;margin:0">${icon(proposal.kind === 'skill' ? 'spark' : 'branch')}</div>
              <div class="list-main">
                <h3>${esc(proposal.title)}</h3>
                <p>${esc(proposal.rationale)}</p>
              </div>
            </div>
            <span class="pill ${tone}">${esc(PROPOSAL_STATUS[proposal.status] ?? proposal.status)}</span>
          </div>
          ${proposal.kind === 'workflow' ? '<div class="note">工作流提案尚未支持执行。</div>' : ''}
          <div class="proposal-body" style="margin-top:0">${esc(proposalPreview(proposal).slice(0, 6000))}</div>
          <div class="list-meta"><span>${esc(PROPOSAL_KIND[proposal.kind] ?? proposal.kind)}</span>${proposal.botName ? `<span>${esc(proposal.botName)}</span>` : ''}<span>${esc(timeAgo(proposal.created_at))}</span>${proposal.decided_by ? `<span>由 ${esc(actorLabel(proposal.decided_by))} 决定</span>` : ''}${proposal.approvedBy ? `<span>审批人 ${esc(actorLabel(proposal.approvedBy))}</span>` : ''}${proposal.appliedAt ? `<span>已生效 ${esc(formatTime(proposal.appliedAt))}</span>` : ''}${proposal.canary ? `<span>灰度 ${esc(canaryText(proposal.canary))}</span>` : ''}</div>
          ${proposal.evaluation ? `<div class="list-desc">评估 · ${esc(evaluationText(proposal.evaluation))}</div>` : ''}
          ${proposal.status === 'pending' ? `<details class="proposal-diff"${panelAttrs(state, `proposal:${proposal.id}`)}>
            <summary class="btn small">${icon('chevron', 'chev')}查看差异</summary>
            <div class="proposal-body" style="margin-top:8px">${esc(proposalDiffText(proposal).slice(0, 4000))}</div>
          </details>
          <div class="proposal-actions end">
            <button class="btn small" data-action="evaluate-proposal" data-proposal-id="${attr(proposal.id)}" data-verdict="pass">评估通过</button>
            <button class="btn small" data-action="evaluate-proposal" data-proposal-id="${attr(proposal.id)}" data-verdict="fail">评估不通过</button>
            <button class="btn ${proposal.id === pending[0]?.id ? 'primary' : ''}" data-action="decide-proposal" data-proposal-id="${attr(proposal.id)}" data-decision="approved">${icon('check')}通过并应用</button>
            <button class="btn" data-action="decide-proposal" data-proposal-id="${attr(proposal.id)}" data-decision="rejected">拒绝</button>
          </div>` : ''}
          ${proposal.status === 'canary' ? `<div class="proposal-actions end">
            <button class="btn primary" data-action="promote-proposal" data-proposal-id="${attr(proposal.id)}">${icon('check')}转正全量</button>
          </div>` : ''}
        </article>`
      }).join('')}
    </div>`}
  `
}

function usageSnapshot() {
  const raw = state.data?.usage ?? {}
  const tiers = raw.scopeTiers ?? null
  const legacy = tiers ? null : (raw.scope && typeof raw.scope === 'object' ? raw.scope : null)
  const global = raw.global ?? legacy?.global ?? {}
  const project = raw.project ?? legacy?.project ?? null
  const solo = raw.solo ?? null
  const scope = typeof raw.scope === 'string' ? raw.scope : (project ? 'project' : 'global')
  return { ...raw, tiers, global, project, solo, scope, legacy: Boolean(legacy) }
}

function usageTotals(scope = state.usageScope) {
  const usage = usageSnapshot()
  if (scope === 'project') return usage.project ?? usage.global ?? {}
  if (scope === 'solo') return usage.solo ?? {}
  return usage.global ?? {}
}

function formatAmount(value) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return '0.00'
  if (n === 0) return '0.00'
  if (Math.abs(n) < 0.01) return n.toFixed(4)
  return n.toFixed(2)
}

// 用量页成本口径（DSHBOTS-81）：预算币种用符号式（¥42.64），其余币种进副行，
// 同页不再混排「CNY 42.64」与「¥0.11」两种写法；小数位规则与全站 formatCost 一致。
function usageCurrency(usage) {
  return String(usage?.currency ?? 'CNY').toUpperCase() || 'CNY'
}

function usageCostParts(totals, currency) {
  const map = totals?.costByCurrency
  const codes = map && typeof map === 'object' ? Object.keys(map).sort() : []
  const budget = String(currency || 'CNY').toUpperCase()
  const primary = codes.includes(budget) ? budget : (codes[0] ?? null)
  if (!primary && (totals?.cost === null || totals?.cost === undefined)) {
    return { code: null, symbol: '', amount: null, others: [] }
  }
  const code = primary ?? budget
  return {
    code,
    symbol: CURRENCY_SYMBOL[code] ?? `${code} `,
    amount: primary ? Number(map[primary] ?? 0) : Number(totals.cost ?? 0),
    others: codes.filter(code2 => code2 !== code).map(code2 => ({ code: code2, amount: Number(map[code2] ?? 0) })),
  }
}

// 成本文本：符号 + 金额；多币种时主币种在前，其余币种跟在后面（不再用 'CNY x / USD y'）。
function usageCostText(totals, currency) {
  const parts = usageCostParts(totals, currency)
  if (!parts.code) return '未配置'
  const main = `${parts.symbol.trim()}${formatAmount(parts.amount)}`
  if (!parts.others.length) return main
  return `${main} + ${parts.others.map(other => `${other.code} ${formatAmount(other.amount)}`).join(' + ')}`
}

// 成本单元格只放主币种金额（保证列宽固定不折行），完整多币种金额进 title。
function usageCostPrimaryText(totals, currency) {
  const parts = usageCostParts(totals, currency)
  if (!parts.code) return '未配置'
  return formatCost(parts.amount, parts.code)
}

async function exportUsageCsv() {
  const usage = usageSnapshot()
  const project = pageProject()
  const payload = { days: usage.days ?? 30 }
  // 导出口径跟随当前页面口径（DSHBOTS-56）：
  // global=全局明细（不带任何过滤）；domain=本群明细；solo=该 Bot 的项目外明细。
  const mode = usageMode()
  if (mode === 'domain' && project) payload.projectId = project.id
  if (mode === 'solo' && state.soloBotId) payload.soloBotId = state.soloBotId
  const result = await api('export_usage_csv', payload)
  const csv = String(result?.csv ?? '')
  if (!csv) throw new Error('导出内容为空，请稍后重试。')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = result?.filename || 'usage.csv'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast('CSV 已导出', 'success')
}

// 用量页三态（DSHBOTS-56）：侧栏入口=全局视图（与群聊/单聊上下文零耦合）；
// 群聊 NAV 的「用量」tab=本群口径；单聊 NAV 的「用量」tab=本 bot 口径。
function usageMode() {
  return state.usageMode === 'domain' || state.usageMode === 'solo' ? state.usageMode : 'global'
}

// 页面标题区分三态：全局用量 / 本群用量 / 本 Bot 用量。
function usageViewTitle() {
  if (usageMode() === 'domain') {
    const project = pageProject()
    return project ? `用量 · ${project.name}` : '本群用量'
  }
  if (usageMode() === 'solo') {
    const soloBot = botById(state.soloBotId)
    return soloBot ? `用量 · @${soloBot.name}` : '本 Bot 用量'
  }
  return '全局用量'
}

// 用量行内容：名称 / 条形 / tokens / 调用 / 成本 五列。
// 数值列等宽右对齐、单位只出现在表头，行内不塞「次」「CNY」等后缀，杜绝折行。
function usageRowCells(item, label, hint, max, currency) {
  const tokens = Number(item.totalTokens ?? 0)
  const calls = Number(item.calls ?? 0)
  const ratio = tokens > 0 ? Math.min(100, (tokens / (max || 1)) * 100) : 0
  const unpriced = Number(item.unpricedCalls ?? 0)
  const fill = tokens > 0 ? `<span class="usage-fill${unpriced > 0 ? ' partial' : ''}" style="width:${ratio}%"></span>` : ''
  const cost = usageCostPrimaryText(item, currency)
  const costFull = usageCostText(item, currency)
  const costTitle = unpriced > 0 ? `${costFull}（含 ${unpriced} 次未计价调用，成本为部分值）` : costFull
  return `<span class="usage-col-name" title="${attr(label + hint)}">${esc(label)}</span>
    <span class="usage-track">${fill}</span>
    <span class="usage-col-num">${formatNumber(tokens)}</span>
    <span class="usage-col-num">${formatNumber(calls)}</span>
    <span class="usage-col-num" title="${attr(costTitle)}">${esc(cost)}</span>`
}

function usageBarRow(item, label, max, currency, hint = '') {
  return `<div class="usage-row">${usageRowCells(item, label, hint, max, currency)}</div>`
}

// 分 bot 行：drillable=true 时可点击查看该 bot 的运行记录。
function usageBotRow(item, max, drillable, currency) {
  const botId = item.botId ?? item.id ?? ''
  const name = String(item.name ?? botById(botId)?.name ?? '').trim() || '未知 Bot'
  const cells = usageRowCells(item, name, '', max, currency)
  if (!drillable) return `<div class="usage-row">${cells}</div>`
  const active = state.usageBot === botId
  return `<button type="button" class="usage-row usage-row-action${active ? ' active' : ''}" data-action="usage-drill" data-bot-id="${attr(botId)}" aria-pressed="${active}" title="查看该 Bot 在本群的运行记录">${cells}</button>`
}

// 分项目行：行首只显示项目名/项目 key，不再回落到 prj_ raw id（D-67 P1-6），原始 id 只进 title。
function usageProjectRow(item, max, currency) {
  const label = String(item.name ?? item.key ?? '').trim() || '未命名项目'
  const hint = item.projectId ? ` · ${item.projectId}` : ''
  return usageBarRow(item, label, max, currency, hint)
}

// 分布列表面板：表头给出列名与单位，行内只放数值。
function usageListPanel(title, rows, nameLabel) {
  return `<div class="card usage-panel">
    <div class="card-head"><h3>${esc(title)}</h3><span class="meta">${rows.length} 个</span></div>
    ${rows.length === 0 ? '<div class="faint">暂无调用记录。</div>' : `<div class="usage-list">
      <div class="usage-list-head">
        <span class="usage-col-name">${esc(nameLabel)}</span>
        <span class="usage-col-bar">tokens 占比</span>
        <span class="usage-col-num">tokens</span>
        <span class="usage-col-num">调用</span>
        <span class="usage-col-num">成本</span>
      </div>
      ${rows.join('')}
    </div>
    <div class="usage-legend">
      <span class="usage-legend-item"><i class="usage-swatch"></i>已计价用量</span>
      <span class="usage-legend-item"><i class="usage-swatch star"></i>含未计价调用</span>
      <span class="usage-legend-item"><i class="usage-swatch empty"></i>零用量</span>
    </div>`}
  </div>`
}

function usageRunRow(run) {
  return `<div class="run-row">
    <div class="run-row-top">${runDot(run.status)}<strong class="mono">${esc(String(run.id ?? '').slice(0, 8))}</strong><span>${esc(RUN_STATUS[run.status] ?? run.status)}</span><span style="margin-left:auto">${esc(timeAgo(run.queued_at))}</span></div>
    <div class="run-row-meta"><span>${esc(run.kind || '—')}</span><span>${formatNumber(Number(run.usage_input ?? 0) + Number(run.usage_output ?? 0))} tok</span>${run.usage_cost !== null && run.usage_cost !== undefined ? `<span>${formatCost(run.usage_cost)}</span>` : ''}</div>
  </div>`
}

// 同一模型名可能分属不同 provider（src/usage.js 按 provider+model 分组），用暗色标签区分。
function usageModelCell(item) {
  const provider = String(item.provider ?? '').trim()
  const model = String(item.model ?? '').trim() || '未知模型'
  const tag = provider ? `<span class="usage-tag">${esc(provider)}</span>` : ''
  return `${tag}<span class="usage-model-name" title="${attr(model)}">${esc(model)}</span>`
}

function usageModelPanel(byModel, title, headerExtra = '', currency = 'CNY') {
  return `<div class="card usage-panel">
    <div class="card-head"><h3>${esc(title)}</h3>${headerExtra || `<span class="meta">${byModel.length} 个</span>`}</div>
    ${byModel.length === 0 ? '<div class="faint">暂无调用记录。</div>' : `<table class="usage-table"><thead><tr><th class="eyebrow mono">模型</th><th class="eyebrow mono num">调用</th><th class="eyebrow mono num">tokens</th><th class="eyebrow mono num">成本</th></tr></thead><tbody>${byModel.map(item => `<tr><td class="usage-model-cell">${usageModelCell(item)}</td><td class="mono num">${formatNumber(item.calls)}</td><td class="mono num">${formatNumber(item.totalTokens)}</td><td class="mono num" title="${attr(usageCostText(item, currency))}">${esc(usageCostPrimaryText(item, currency))}</td></tr>`).join('')}</tbody></table>`}
    <div class="usage-note">未配置价格的成本不会按 0 计费；价格按每百万 token 配置。</div>
  </div>`
}

// 四张 KPI 卡：同字重同字号（成本卡不再降级成小字），标签写清口径。
function usageMetricCards(totals, scopeLabel, usage) {
  const currency = usageCurrency(usage)
  const cost = usageCostParts(totals, currency)
  const windowDays = Number(usage.days ?? 30) || 30
  const totalTokens = Number(totals.totalTokens ?? 0)
  const calls = Number(totals.calls ?? 0)
  const dailyTokens = windowDays > 0 ? totalTokens / windowDays : 0
  const perCall = calls > 0 ? totalTokens / calls : 0
  const costValue = cost.code
    ? `<span class="unit">${esc(cost.symbol.trim())}</span>${esc(formatAmount(cost.amount))}`
    : '未配置'
  const costMeta = [
    ...cost.others.map(other => `另有 ${other.code} ${formatAmount(other.amount)}`),
    usage.priceCount ? `${usage.priceCount} 条价格规则` : '尚未配置模型价格',
  ].join(' · ')
  return `<div class="metric-grid">
    <div class="card metric">
      <span class="metric-label">总 tokens（${esc(scopeLabel)}）</span>
      <strong>${formatNumber(totalTokens)}</strong>
      <small class="mono">入 ${formatNumber(totals.inputTokens)} · 出 ${formatNumber(totals.outputTokens)} · 缓存读 ${formatNumber(totals.cacheReadTokens)}</small>
    </div>
    <div class="card metric">
      <span class="metric-label">调用次数（${esc(scopeLabel)}）</span>
      <strong>${formatNumber(calls)}</strong>
      <small class="mono">平均每次 ${formatNumber(perCall)} tokens</small>
    </div>
    <div class="card metric">
      <span class="metric-label">总成本（${esc(scopeLabel)}）</span>
      <strong class="metric-cost">${costValue}</strong>
      <small class="mono">${esc(costMeta)}</small>
    </div>
    <div class="card metric">
      <span class="metric-label">日均 tokens（${esc(scopeLabel)}）</span>
      <strong>${formatNumber(dailyTokens)}</strong>
      <small class="mono">按 ${windowDays} 天汇总窗口折算</small>
    </div>
  </div>`
}

function usageDayPanel(days) {
  const maxDay = Math.max(1, ...days.map(item => item.totalTokens ?? 0))
  const peak = days.reduce((best, day) => ((day.totalTokens ?? 0) > (best?.totalTokens ?? 0) ? day : best), null)
  return `<div class="card usage-panel">
    <div class="card-head"><h3>近 14 天</h3>${peak && peak.totalTokens ? `<span class="meta">峰值 ${formatNumber(peak.totalTokens)} · ${esc(String(peak.day).slice(5))}</span>` : ''}</div>
    ${days.length === 0 ? '<div class="faint">暂无按日数据。</div>' : `<div class="day-bars">${days.map(day => `<div class="day-bar${day.totalTokens ? '' : ' zero'}" style="height:${Math.max(3, (day.totalTokens ?? 0) / maxDay * 100)}%" title="${esc(day.day)} · ${formatNumber(day.totalTokens)} tokens"></div>`).join('')}</div><div class="day-axis">${days.map((day, index) => `<span title="${esc(day.day)} · ${formatNumber(day.totalTokens)} tokens">${index === 0 || index === days.length - 1 || index % 3 === 0 ? esc(String(day.day).slice(5).replace('-', '/')) : ''}</span>`).join('')}</div>`}
    <div class="usage-note">按日明细由服务端保留最近 14 天；更早的调用计入上方汇总，不进这张图。</div>
  </div>`
}

// 用量页区块：真实标题（H2）+ 一行口径说明。页面不再只剩一个与 H1 重复的灰字 caption。
function usageSection(title, desc, body, headExtra = '') {
  return `<section class="usage-section">
    <div class="usage-section-head">
      <div class="usage-section-title">
        <h2 class="usage-h2">${esc(title)}</h2>
        <p class="usage-desc">${esc(desc)}</p>
      </div>
      ${headExtra}
    </div>
    ${body}
  </section>`
}

// 页面头：单一声明统计窗口与本页口径，避免各面板各说一套。
function usagePageHead(usage, scopeText, exportLabel = '') {
  const windowDays = Number(usage.days ?? 30) || 30
  return `<div class="section-head usage-page-head">
    <div class="usage-head-meta">
      <span class="usage-window">汇总窗口 近 ${windowDays} 天</span>
      <span class="usage-head-desc">${esc(scopeText)}</span>
    </div>
    <div class="btn-row">
      <button class="btn" data-action="export-usage-csv">${icon('download')}导出 CSV${exportLabel ? `（${esc(exportLabel)}）` : ''}</button>
    </div>
  </div>`
}

function renderUsage() {
  if (usageMode() === 'domain') return renderUsageDomain()
  if (usageMode() === 'solo') return renderUsageSolo()
  return renderUsageGlobal()
}

// 全局视图：只用全局口径数据，与当前群聊/单聊上下文零耦合。
// 四个维度（趋势 / 分模型 / 分 Bot / 分项目）始终同时展示，口径切换只调展示顺序。
function renderUsageGlobal() {
  const usage = usageSnapshot()
  const tier = usage.tiers?.global
  const byBot = tier?.byBot ?? usage.byBot ?? []
  const byProject = tier?.byProject ?? usage.byProject ?? []
  const byModel = tier?.byModel ?? usage.byModel ?? []
  const days = tier?.byDay ?? usage.byDay ?? []
  const totals = usage.global ?? {}
  const currency = usageCurrency(usage)
  const windowDays = Number(usage.days ?? 30) || 30
  const focus = ['global', 'model', 'bot', 'project'].includes(state.usageScope) ? state.usageScope : 'global'
  const maxBot = Math.max(1, ...byBot.map(item => item.totalTokens ?? 0))
  const maxProject = Math.max(1, ...byProject.map(item => item.totalTokens ?? 0))
  const reconciliation = usage.reconciliation ?? null
  const unpriced = Number(totals.unpricedCalls ?? 0)
  const panels = {
    days: usageDayPanel(days),
    model: usageModelPanel(byModel, '分模型', `<span class="meta">${byModel.length} 个</span><button class="btn small" data-action="new-price">设置价格</button>`, currency),
    bot: usageListPanel('分 Bot', byBot.map(item => usageBotRow(item, maxBot, false, currency)), 'Bot'),
    project: usageListPanel('分项目', byProject.map(item => usageProjectRow(item, maxProject, currency)), '项目'),
  }
  // 口径切换只调展示顺序，四个维度始终可见（关键信息不折叠）。
  const order = {
    global: ['days', 'model', 'bot', 'project'],
    model: ['model', 'days', 'bot', 'project'],
    bot: ['bot', 'days', 'model', 'project'],
    project: ['project', 'days', 'model', 'bot'],
  }[focus]
  const overviewNotes = [
    unpriced > 0 ? `<div class="note warn-note">${unpriced} 次调用未配置价格，成本为部分值。</div>` : '',
    Number(reconciliation?.mismatched ?? 0) > 0 ? `<div class="usage-note">${Number(reconciliation.mismatched)} 次运行的用量记录对不上，数据可能不完整。</div>` : '',
    usage.legacy ? '<div class="usage-note">服务端尚未按口径过滤明细，下方分组仍是全局数据。</div>' : '',
  ].join('')
  return `
    ${usagePageHead(usage, '全局口径，不随当前群聊 / 单聊上下文变化')}
    ${usageSection(
      '全局用量总览',
      `四项指标覆盖全部调用来源，按汇总窗口 近 ${windowDays} 天统计。`,
      `${overviewNotes}${usageMetricCards(totals, '全局', usage)}`,
    )}
    ${usageSection(
      '分布明细',
      `四个维度始终同时展示；按日面板只保留最近 14 天明细，其余面板与上方汇总同为 ${windowDays} 天窗口。条形长度 = tokens 占比，琥珀色 = 含未计价调用，空条 = 零用量。`,
      `<div class="usage-grid">${order.map(key => panels[key]).join('')}</div>`,
      `<div class="usage-seg">
        <span class="usage-seg-label">面板顺序</span>
        <div class="seg" role="group" aria-label="面板顺序">
          <button data-action="usage-scope" data-scope="global" aria-pressed="${focus === 'global'}">趋势优先</button>
          <button data-action="usage-scope" data-scope="model" aria-pressed="${focus === 'model'}">模型优先</button>
          <button data-action="usage-scope" data-scope="bot" aria-pressed="${focus === 'bot'}">Bot 优先</button>
          <button data-action="usage-scope" data-scope="project" aria-pressed="${focus === 'project'}">项目优先</button>
        </div>
      </div>`,
    )}
  `
}

// 群聊「用量」tab：本群消耗汇总 + 本群分模型 + 本群各 bot，内容严格限本群。
function renderUsageDomain() {
  const usage = usageSnapshot()
  const tier = usage.tiers?.project
  const byModel = tier?.byModel ?? []
  const byBot = tier?.byBot ?? []
  const days = tier?.byDay ?? []
  const totals = usage.project ?? {}
  const currency = usageCurrency(usage)
  const windowDays = Number(usage.days ?? 30) || 30
  const maxBot = Math.max(1, ...byBot.map(item => item.totalTokens ?? 0))
  const drillBot = state.usageBot ? botById(state.usageBot) : null
  const drillRuns = drillBot
    ? (state.data?.runs ?? []).filter(run => run.bot_id === drillBot.id)
    : []
  const unpriced = Number(totals.unpricedCalls ?? 0)
  const overviewNotes = [
    unpriced > 0 ? `<div class="note warn-note">${unpriced} 次调用未配置价格，成本为部分值。</div>` : '',
    tier ? '' : '<div class="usage-note">服务端尚未提供本群口径明细，下方分组可能是全局数据。</div>',
  ].join('')
  return `
    ${usagePageHead(usage, '仅当前群聊内的用量，不含其他群聊', '本群')}
    ${usageSection(
      '本群用量总览',
      `四项指标只统计当前群聊的调用，按汇总窗口 近 ${windowDays} 天归集。`,
      `${overviewNotes}${usageMetricCards(totals, '本群', usage)}`,
    )}
    ${usageSection(
      '本群分布明细',
      `按日面板只保留最近 14 天明细，其余面板与上方汇总同为 ${windowDays} 天窗口；条形长度 = tokens 占比，琥珀色 = 含未计价调用，空条 = 零用量。`,
      `<div class="usage-grid">
        ${usageDayPanel(days)}
        ${usageModelPanel(byModel, '本群分模型', '', currency)}
        ${usageListPanel('本群各 Bot', byBot.map(item => usageBotRow(item, maxBot, true, currency)), 'Bot')}
      </div>`,
    )}
    ${drillBot ? usageSection(
      `${drillBot.name} 在本群的运行记录`,
      '在「本群各 Bot」列表点选可切换查看对象。',
      `<div class="card usage-panel">
        ${drillRuns.length === 0 ? '<div class="faint">该 Bot 在本群还没有运行记录。</div>' : `<div class="run-list">${drillRuns.map(usageRunRow).join('')}</div>`}
      </div>`,
      `<button class="btn small" data-action="usage-clear-drill">${icon('close')}清除选择</button>`,
    ) : ''}
  `
}

// 单聊「用量」tab：本 bot 汇总 + 本 bot 分模型，内容严格限本 bot。
function renderUsageSolo() {
  const usage = usageSnapshot()
  const tier = usage.tiers?.solo
  const byModel = tier?.byModel ?? []
  const days = tier?.byDay ?? []
  const totals = usage.solo ?? {}
  const currency = usageCurrency(usage)
  const windowDays = Number(usage.days ?? 30) || 30
  const runs = (state.data?.solo?.runs ?? state.data?.runs ?? [])
    .filter(run => run.bot_id === state.soloBotId && (run.project_id ?? null) === null)
  const unpriced = Number(totals.unpricedCalls ?? 0)
  const overviewNotes = [
    unpriced > 0 ? `<div class="note warn-note">${unpriced} 次调用未配置价格，成本为部分值。</div>` : '',
    usage.solo ? '' : '<div class="usage-note">服务端尚未提供该 Bot 的单聊口径明细。</div>',
  ].join('')
  return `
    ${usagePageHead(usage, '仅该 Bot 在项目外（单聊）的用量，不含项目内调用', '该 Bot')}
    ${usageSection(
      '该 Bot 用量总览',
      `四项指标只统计该 Bot 的单聊调用，按汇总窗口 近 ${windowDays} 天归集。`,
      `${overviewNotes}${usageMetricCards(totals, '该 Bot', usage)}`,
    )}
    ${usageSection(
      '该 Bot 分布明细',
      `按日面板只保留最近 14 天明细，其余面板与上方汇总同为 ${windowDays} 天窗口。`,
      `<div class="usage-grid">
        ${usageDayPanel(days)}
        ${usageModelPanel(byModel, '该 Bot 分模型', '', currency)}
      </div>`,
    )}
    ${usageSection(
      '该 Bot 的运行记录',
      '与上方用量同口径：只含项目外（单聊）的运行。',
      `<div class="card usage-panel">
        <div class="card-head"><h3>运行明细</h3><span class="meta">${runs.length} 条</span></div>
        ${runs.length === 0 ? '<div class="faint">该 Bot 在项目外还没有运行记录。</div>' : `<div class="run-list">${runs.map(usageRunRow).join('')}</div>`}
      </div>`,
    )}
  `
}

// 全局配置页「运行时效」卡：超时中止与无进展看门狗（分钟），保存走 update_settings。
// 输入框回填保存值（未保存时回填当前生效值）；卡头显示生效值。
function renderRunLimitsCard() {
  const settings = state.data.settings ?? {}
  const limits = state.data.runLimits ?? {}
  const savedRun = settings.run_timeout_minutes ?? ''
  const savedStall = settings.stall_watchdog_minutes ?? ''
  const runValue = savedRun !== '' ? savedRun : String(limits.runTimeoutMinutes ?? 120)
  // 看门狗保存值 '0'（关闭）合法，不能用 || 短路吞掉。
  const stallValue = savedStall !== '' ? savedStall : String(limits.stallTimeoutMinutes ?? 30)
  const envNames = [
    limits.runTimeoutEnv ? 'DSH_TEAM_RUN_TIMEOUT_MS' : '',
    limits.stallTimeoutEnv ? 'DSH_TEAM_STALL_TIMEOUT_MS' : '',
  ].filter(Boolean).join(' / ')
  const stallText = limits.stallTimeoutMinutes === 0 ? '看门狗关闭' : `${limits.stallTimeoutMinutes ?? 30} 分钟看门狗`
  return `
    <div class="card form-card" style="margin-top:12px">
      <div class="card-head"><h3>运行时效</h3><span class="meta">当前生效 ${limits.runTimeoutMinutes ?? 120} 分钟超时 / ${stallText}</span></div>
      <div class="field-row">
        <div class="field"><label id="settings-run-timeout-label" for="settings-run-timeout">超时中止（分钟）</label><input class="input mono" style="text-align:right" type="number" min="1" max="360" id="settings-run-timeout" name="run_timeout_minutes" value="${attr(runValue)}"></div>
        <div class="field"><label id="settings-stall-watchdog-label" for="settings-stall-watchdog">无进展看门狗（分钟）</label><input class="input mono" style="text-align:right" type="number" min="0" max="360" id="settings-stall-watchdog" name="stall_watchdog_minutes" value="${attr(stallValue)}"></div>
      </div>
      <div class="hint">超时中止 = 单次运行的最长时长（1–360 分钟）；无进展看门狗 = 运行多久没有任何输出即判定卡住（0–360 分钟，0 为关闭）。</div>
      <div class="hint">新值只对之后启动的运行生效，进行中的运行不追溯。</div>
      ${envNames ? `<div class="hint">环境变量 ${envNames} 已显式设置，对应项以环境变量为准，页面保存值不生效。</div>` : ''}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn small" type="button" data-action="save-run-limits">保存运行时效</button>
      </div>
    </div>`
}

function renderOpsCard() {
  const settings = state.data.settings ?? {}
  const outbox = state.data.outbox ?? { pending: 0, failed: 0, delivered: 0 }
  const reconciliation = state.data.usage?.reconciliation ?? null
  const currency = settings.budget_currency || 'CNY'
  const num = value => (value === '' || value === undefined || value === null ? '' : String(value))
  return `
    <div class="card form-card" style="margin-top:12px">
      <div class="card-head"><h3>系统与运维</h3></div>
      <div class="field-row">
        <div class="field">
          <label id="settings-currency-label" for="settings-currency">预算币种</label>
          <select class="select" id="settings-currency" name="budget_currency">
            ${['CNY', 'USD'].map(code => `<option value="${code}" ${code === currency ? 'selected' : ''}>${code}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label id="settings-memory-review-label" for="settings-memory-review">记忆自动审查</label>
          <select class="select" id="settings-memory-review" name="memory_review">
            <option value="1" ${settings.memory_review !== '0' ? 'selected' : ''}>开启</option>
            <option value="0" ${settings.memory_review === '0' ? 'selected' : ''}>关闭</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label id="settings-global-token-budget-label" for="settings-global-token-budget">全局 Token 预算</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-global-token-budget" name="global_token_budget" value="${attr(num(settings.global_token_budget))}" placeholder="不限制"></div>
        <div class="field"><label id="settings-global-cost-budget-label" for="settings-global-cost-budget">全局成本预算</label><input class="input mono" style="text-align:right" type="number" min="0" step="0.01" id="settings-global-cost-budget" name="global_cost_budget" value="${attr(num(settings.global_cost_budget))}" placeholder="不限制"></div>
      </div>
      <div class="field-row">
        <div class="field"><label id="settings-retention-usage-label" for="settings-retention-usage">用量保留天数</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-retention-usage" name="retention_usage_days" value="${attr(num(settings.retention_usage_days))}" placeholder="永久"></div>
        <div class="field"><label id="settings-retention-run-label" for="settings-retention-run">运行事件保留天数</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-retention-run" name="retention_run_event_days" value="${attr(num(settings.retention_run_event_days))}" placeholder="永久"></div>
      </div>
      <div class="field"><label id="settings-retention-message-label" for="settings-retention-message">消息保留天数</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-retention-message" name="retention_message_days" value="${attr(num(settings.retention_message_days))}" placeholder="永久"></div>
      <div class="hint">全局预算对所有项目生效；保留天数按天清理过期用量、运行事件与消息，0 表示永久保留。</div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn small" type="button" data-action="save-settings">保存系统设置</button>
      </div>
      ${Number(outbox.failed ?? 0) > 0 ? `<div class="kv" style="margin-top:12px"><span>投递队列</span><strong>${outbox.failed} 条消息投递失败</strong></div>` : ''}
    </div>`
}

function renderWechatCard() {
  const wechat = state.data.wechat ?? { enabled: false, phase: 'disabled' }
  if (!wechat.enabled) return ''
  const phaseText = {
    disabled: '未启用', unbound: '未绑定', connecting: '连接中', connected: '已连接',
    reconnecting: '重连中', needs_reauth: '凭证失效', scanning: '待扫码',
    verification: '待输验证码',
  }
  const auth = state.wechatAuth
  const pillClass = wechat.phase === 'connected' ? 'green' : ['needs_reauth'].includes(wechat.phase) ? 'amber' : ''
  return `
    <div class="card form-card" style="margin-top:12px" id="wechat-card">
      <div class="card-head"><h3>微信通道</h3><span class="pill ${pillClass}">${phaseText[wechat.phase] ?? wechat.phase}</span></div>
      ${wechat.adminPeerId ? `<div class="kv"><span>管理员</span><strong>${esc(String(wechat.adminPeerId).slice(0, 12))}…</strong></div>` : ''}
      ${wechat.error ? `<div class="hint" style="color:var(--coral,#e5484d)">${esc(wechat.error)}</div>` : ''}
      ${auth?.qrSvg ? `
        <div class="wechat-qr">${auth.qrSvg}</div>
        <div class="hint">微信扫码授权 ClawBot；手机上确认后此处会自动变为已连接。</div>` : ''}
      ${wechat.phase === 'verification' || auth?.verification ? `
        <div class="field-row" style="margin-top:8px">
          <div class="field"><label for="wechat-code">微信验证码</label><input class="input mono" id="wechat-code" inputmode="numeric" placeholder="扫码后手机上的验证码"></div>
          <div class="field"><label>&nbsp;</label><button class="btn small" type="button" data-action="wechat-code">提交验证码</button></div>
        </div>` : ''}
      <div class="btn-row" style="margin-top:12px">
        ${['connected', 'reconnecting', 'connecting'].includes(wechat.phase)
          ? '<button class="btn small danger" type="button" data-action="wechat-logout">退出绑定</button>'
          : '<button class="btn small" type="button" data-action="wechat-login">扫码绑定</button>'}
      </div>
      <div class="hint">扫码授权成功后自动把授权者绑定为管理员；之后可用：状态 / 详情 web-3 / 验收 web-3 / 驳回 web-3 理由。任务完成会主动推送。</div>
    </div>`
}

// 密钥管理：团队/项目两级密钥列表 + Bot 发起的待审请求，均来自 state.secrets / state.secretRequests。
function renderSecretsCard() {
  const secrets = state.data?.secrets ?? []
  const requests = state.data?.secretRequests ?? []
  const projects = (state.data?.projects ?? []).filter(project => project.status === 'active')
  return `
    <div class="card form-card" style="margin-top:12px">
      <div class="card-head"><h3>密钥管理</h3><span class="meta">${secrets.length} 条 · ${requests.length} 待审</span></div>
      <div class="hint" style="margin:2px 0 12px">密钥加密存储；团队级密钥对所有活动项目生效，Bot 可以直接使用。</div>
      ${requests.length === 0 ? '' : `<div class="secret-block">
        ${requests.map(request => `
          <form class="secret-request" data-form="approve-secret">
            <input type="hidden" name="requestId" value="${attr(request.id)}">
            <div class="secret-request-info">
              <strong>${esc(request.botName)}</strong>
              <span>请求 <code>${esc(request.name)}</code></span>
              ${request.projectName ? `<span class="faint">${esc(request.projectName)}</span>` : ''}
              <span class="faint">${esc(formatTime(request.createdAt))}</span>
            </div>
            ${request.reason ? `<div class="secret-request-reason">${esc(request.reason)}</div>` : ''}
            <div class="secret-request-actions">
              <input class="input mono" type="password" name="value" minlength="8" autocomplete="new-password" placeholder="填写密钥值（至少 8 个字符）后批准">
              <button class="btn primary small" type="submit">批准</button>
              <button class="btn small" type="button" data-action="deny-secret-request" data-request-id="${attr(request.id)}">拒绝</button>
            </div>
          </form>`).join('')}
      </div>`}
      ${secrets.length === 0 ? '<div class="faint" style="padding:6px 0 12px">还没有密钥。</div>' : `<div class="secret-list">
        ${secrets.map(secret => `
          <div class="secret-row">
            <span class="pill ${secret.scope === 'team' ? 'violet' : ''}">${secret.scope === 'team' ? '团队' : '项目'}</span>
            <strong class="mono">${esc(secret.name)}</strong>
            ${secret.scope === 'project' && secret.projectName ? `<span class="faint">${esc(secret.projectName)}</span>` : ''}
            <span class="secret-purpose">${esc(secret.purpose || '')}</span>
            <span class="subpanel-tag" title="值指纹（sha256 前 8 位）">${esc(secret.fingerprint)}</span>
            <span class="faint">${esc(formatTime(secret.updatedAt))}</span>
            <span class="faint">${esc(secret.updatedBy ?? '')}</span>
            <button class="btn icon small" type="button" data-action="delete-secret" data-secret-id="${attr(secret.id)}" data-secret-name="${attr(secret.name)}" title="删除密钥" aria-label="删除密钥 ${attr(secret.name)}">${icon('trash')}</button>
          </div>`).join('')}
      </div>`}
      <form data-form="upsert-secret" style="margin-top:12px">
        <div class="field-row">
          <div class="field"><label for="secret-scope">作用域</label>
            <select class="select" id="secret-scope" name="scope">
              <option value="team">团队（全部活动项目）</option>
              <option value="project">单个项目</option>
            </select>
          </div>
          <div class="field"><label for="secret-project">所属项目</label>
            <select class="select" id="secret-project" name="projectId">
              <option value="">团队级无需选择</option>
              ${projects.map(project => `<option value="${attr(project.id)}">${esc(project.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label for="secret-name">名称</label><input class="input mono" id="secret-name" name="name" maxlength="64" placeholder="如 DEPLOY_TOKEN" required></div>
          <div class="field"><label for="secret-purpose">用途说明</label><input class="input" id="secret-purpose" name="purpose" maxlength="200" placeholder="选填"></div>
        </div>
        <div class="field"><label for="secret-value">密钥值</label>
          <input class="input mono" id="secret-value" name="value" type="password" minlength="8" autocomplete="new-password" placeholder="至少 8 个字符，保存后不再回显">
          <div class="hint">至少 8 个字符；同作用域同名会覆盖旧值。</div>
        </div>
        <div class="btn-row"><button class="btn small" type="submit">${icon('check')}保存密钥</button></div>
      </form>
    </div>`
}

function renderSettings() {
  const project = activeProject()
  const copyPath = value => `<button class="btn icon small" type="button" data-action="copy" data-copy="${attr(value)}" title="复制路径" aria-label="复制路径">${icon('copy')}</button>`
  if (!project) return noProject()
  const members = activeBots()
  const owner = botById(project.owner_bot_id)
  return `
    <form id="project-settings-form" data-form="save-project">
      <div class="settings-grid">
        <div>
          <div class="card form-card">
            <div class="card-head"><h3>项目资料</h3><span class="meta">${esc(project.key ?? project.id)}</span></div>
            <input type="hidden" name="projectId" value="${attr(project.id)}">
            <div class="field"><label id="settings-name-label" for="settings-name">项目名称</label><input class="input" id="settings-name" name="name" value="${attr(project.name)}" maxlength="80"></div>
            <div class="field"><label id="settings-description-label" for="settings-description">项目描述</label><textarea class="textarea" id="settings-description" name="description">${esc(project.description || '')}</textarea></div>
            <div class="field-row">
              <div class="field"><label id="settings-owner-label" for="settings-owner">总监 Bot</label><select class="select" id="settings-owner" name="ownerBotId">${members.map(bot => `<option value="${attr(bot.id)}" ${bot.id === project.owner_bot_id ? 'selected' : ''}>${esc(bot.name)}</option>`).join('')}</select></div>
              <div class="field"><label id="settings-reply-mode-label" for="settings-reply-mode">群聊回复模式</label><select class="select" id="settings-reply-mode" name="replyMode"><option value="owner_first" ${project.group?.reply_mode !== 'everyone' ? 'selected' : ''}>总监优先</option><option value="everyone" ${project.group?.reply_mode === 'everyone' ? 'selected' : ''}>全员响应</option></select></div>
            </div>
          </div>
          <div class="card form-card" style="margin-top:12px">
            <div class="card-head"><h3>月度预算</h3></div>
            <div class="field-row">
              <div class="field"><label id="settings-token-budget-label" for="settings-token-budget">Token 预算</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-token-budget" name="tokenBudget" value="${project.token_budget ?? ''}" placeholder="不限制"></div>
              <div class="field"><label id="settings-cost-budget-label" for="settings-cost-budget">成本预算</label><input class="input mono" style="text-align:right" type="number" min="0" step="0.01" id="settings-cost-budget" name="costBudget" value="${project.cost_budget ?? ''}" placeholder="不限制"></div>
            </div>
            <div class="hint">超出预算时项目会提示预算已用尽。成本预算与模型价格使用同一币种计价。</div>
          </div>
        </div>
        <div>
          <div class="card form-card">
            <div class="card-head"><h3>工作区路径</h3></div>
            <div class="field">
              <label id="settings-production-label" for="settings-production">生产目录</label>
              <div style="display:flex;gap:8px"><input class="input mono" style="flex:1" id="settings-production" name="productionDir" value="${attr(project.production_dir ?? '')}" placeholder="/Users/you/repos/my-game（可选）"><button class="btn" type="button" data-action="pick-dir-open" data-picker-for="settings-production">${icon('folder')}选择</button></div>
              <div class="hint">Bots 的工作目录，可指向既有代码库；留空则用默认管理目录，切换后已有密钥会自动迁移并清理旧目录。</div>
              <div class="dir-picker" id="dir-picker-settings-production" hidden></div>
            </div>
            <div class="path-row"><span>当前生效</span>${pathCode(project.workspace_path)}${copyPath(project.workspace_path)}</div>
            <div class="path-row"><span>管理数据</span>${pathCode(project.data_path ?? '')}${copyPath(project.data_path ?? '')}</div>
          </div>
          <div class="card form-card" style="margin-top:12px">
            <div class="card-head"><h3>项目状态</h3>${project.status === 'active' ? '<span class="pill green">运行中</span>' : '<span class="pill amber">已归档</span>'}</div>
            <div class="kv"><span>总监</span><strong>${esc(owner?.name ?? '未设置')}</strong></div>
            <div class="kv"><span>任务总数</span><strong>${project.stats.tasks}</strong></div>
            <div class="kv"><span>运行总数</span><strong>${project.stats.runs}</strong></div>
            ${project.status === 'active'
              ? `<div class="btn-row settings-danger-row" style="margin-top:12px;justify-content:flex-end"><button class="btn small danger" type="button" data-action="archive-project" data-project-id="${attr(project.id)}">归档项目</button></div>`
              : `<div class="hint" style="margin-top:10px">已归档项目停止新运行，工作区文件保留。项目再开会恢复为进行中；移除追踪会清理本项目的管理数据。</div>
                <div class="btn-row" style="margin-top:12px;justify-content:flex-end"><button class="btn small" type="button" data-action="remove-tracking-open" data-project-id="${attr(project.id)}" data-project-name="${attr(project.name)}">移除追踪</button><button class="btn small primary" type="button" data-action="reopen-project" data-project-id="${attr(project.id)}">项目再开</button></div>`}
          </div>
        </div>
      </div>
    </form>
  `
}

function currentScale() {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))
  return Number.isFinite(value) && value > 0 ? value : 1
}

function renderGlobal() {
  const data = state.data
  const scale = currentScale()
  const bots = data.bots ?? []
  const activeBots = bots.filter(bot => bot.status === 'active')
  const pending = pendingProposals()
  const copyPath = value => `<button class="btn icon small" type="button" data-action="copy" data-copy="${attr(value)}" title="复制路径" aria-label="复制路径">${icon('copy')}</button>`
  return `
    <div class="global-grid">
      <div class="card form-card">
        <div class="card-head">
          <h3>界面</h3>
          <div class="btn-row"><button class="btn small" type="button" data-action="reset-scale">${icon('refresh')}重置</button></div>
        </div>
        <div class="field">
          <label id="ui-scale-label" for="ui-scale">界面字号 <span class="mono" id="ui-scale-value">${Math.round(scale * 100)}%</span></label>
          <input type="range" id="ui-scale" class="range" min="1" max="1.4" step="0.05" value="${scale}">
          <div class="scale-row">
            <span class="faint">小</span>
            <span class="faint" style="margin-left:auto">大</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label" id="ui-theme-label">配色</span>
          <div class="seg" role="group" aria-labelledby="ui-theme-label">
            <button data-action="set-theme" data-theme="dsh" aria-pressed="${state.theme === 'dsh'}">DSH</button>
            <button data-action="set-theme" data-theme="catppuccin" aria-pressed="${state.theme === 'catppuccin'}">Catppuccin</button>
          </div>
        </div>
        <div class="kv"><span>缩放范围</span><strong>100% – 140%</strong></div>
        <div class="kv"><span>偏好存储</span><strong>本地浏览器</strong></div>
      </div>
      <div class="card form-card">
        <div class="card-head"><h3>DSH 路径</h3><button class="btn small" data-action="sync-skills">${icon('refresh')}重新扫描技能</button></div>
        <div class="path-row"><span>DSH 目录</span>${pathCode(data.paths.dshHome ?? '~/.dsh')}${copyPath(data.paths.dshHome ?? '')}</div>
        <div class="path-row"><span>工作区</span>${pathCode(data.paths.workspace)}${copyPath(data.paths.workspace)}</div>
        <div class="path-row"><span>共享</span>${pathCode(data.paths.skillRoot)}${copyPath(data.paths.skillRoot)}</div>
        <div class="path-row"><span>数据</span>${pathCode(data.paths.dataDir)}${copyPath(data.paths.dataDir)}</div>
      </div>
      <div class="card form-card">
        <div class="card-head"><h3>DSH 服务</h3></div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn" data-action="check-dsh-update">${icon('refresh')}检查更新</button>
          <button class="btn" data-action="reboot-dsh">仅重启 DSH</button>
        </div>
        <div class="btn-row split">
          <button class="btn danger" data-action="upgrade-dsh">升级并重启</button>
        </div>
        <div class="usage-note">有排队或运行中任务时会拒绝升级。</div>
      </div>
      <div class="card form-card" style="grid-column:1/-1">
        <div class="card-head"><h3>团队与资源</h3></div>
        <div class="kv-grid">
          <div class="kv"><span>活跃 Bot</span><strong>${activeBots.length} / ${bots.length}</strong></div>
          <div class="kv"><span>群聊 / 项目</span><strong>${data.projects.length}</strong></div>
          <div class="kv"><span>共享技能</span><strong>${(data.skills ?? []).length}</strong></div>
          <div class="kv"><span>待审提案</span><strong>${pending}</strong></div>
          <div class="kv"><span>模型价格规则</span><strong>${data.usage?.priceCount ?? 0}</strong></div>
        </div>
      </div>
    </div>
    ${renderRunLimitsCard()}
    ${renderOpsCard()}
    ${renderWechatCard()}
    ${renderSecretsCard()}
    ${renderPriceCard()}
  `
}

function modalShell({ title, subtitle = '', body = '', footer = '', size = '', badge = '' }) {
  return `<div class="modal-backdrop" data-action="modal-backdrop">
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${attr(title)}" tabindex="-1">
      <div class="modal-head">
        <div class="modal-head-main">${badge ? `<div class="eyebrow">${badge}</div>` : ''}<h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
        <button class="modal-close" data-action="close-modal" aria-label="关闭">×</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>
  </div>`
}

function modalLoading(title) {
  return modalShell({
    title,
    body: '<div class="modal-loading"><div class="boot-mark sm">DSH</div><div>正在读取数据…</div></div>',
    footer: '<button class="btn" data-action="close-modal">关闭</button>',
    size: 'small',
  })
}

function renderModal() {
  const modal = state.modal
  if (!modal) return ''
  if (modal.loading) return modalLoading(modal.title || '加载中')
  switch (modal.type) {
    case 'new-project': return modalNewProject()
    case 'remove-tracking': return modalRemoveTracking()
    case 'new-bot': return modalBot(null)
    case 'invite-member': return modalInviteMember()
    case 'edit-bot': return modalBot(modal.detail)
    case 'new-task': return modalNewTask()
    case 'task': return modalTask(modal.detail)
    case 'skill-detail': return modalSkill(modal.detail)
    case 'memory': return modalMemory(modal.memory)
    case 'proposal': return modalProposal(modal.kind)
    case 'price': return modalPrice(modal.price ?? {})
    case 'trajectory': return modalTrajectory(modal.detail, modal.runId)
    default: return ''
  }
}

function modelOptions(provider, model) {
  const models = state.data?.models ?? []
  if (models.length === 0) return '<option value="">DSH 尚未提供模型</option>'
  return models.map(item => `<option value="${attr(item.ref)}" ${item.provider === provider && item.model === model ? 'selected' : ''}>${esc(item.providerName)} / ${esc(item.name)}</option>`).join('')
}

function effortOptions(modelRef, current) {
  const model = (state.data?.models ?? []).find(item => item.ref === modelRef)
  const efforts = model?.efforts ?? []
  if (efforts.length === 0) return `<option value="">模型默认${current ? `（当前 ${esc(EFFORT[current] ?? current)}）` : ''}</option>`
  return `<option value="">模型默认</option>${efforts.map(effort => `<option value="${attr(effort.id)}" ${current === effort.id ? 'selected' : ''}>${esc(EFFORT[effort.id] ?? effort.name)}</option>`).join('')}`
}

// 备用模型下拉：首项留空即「不启用」；其余与主模型同一模型表。
function fallbackModelOptions(currentRef) {
  const models = state.data?.models ?? []
  const blank = `<option value=""${currentRef ? '' : ' selected'}>不启用（留空）</option>`
  if (models.length === 0) return blank
  return blank + models.map(item => `<option value="${attr(item.ref)}" ${item.ref === currentRef ? 'selected' : ''}>${esc(item.providerName)} / ${esc(item.name)}</option>`).join('')
}

// fallback-model:start —— 备用模型字段的纯逻辑（tests/bot-fallback-model.test.js 抽取此块断言）
// ref 形如 provider/model；留空即「不启用」，三个字段一起清空（后端按 null 落库）。
function parseFallbackFields(ref, effort) {
  const value = String(ref ?? '')
  const slash = value.indexOf('/')
  const provider = slash > 0 ? value.slice(0, slash) : null
  const model = slash > 0 ? value.slice(slash + 1) : null
  return {
    fallbackProvider: provider,
    fallbackModel: model,
    fallbackEffort: model ? (effort || null) : null,
  }
}
// fallback-model:end

function modalNewProject() {
  const bots = activeBots()
  return modalShell({
    title: '新建项目空间',
    badge: '',
    body: `<form data-form="create-project" id="modal-form">
      <div class="field"><label id="new-project-name-label" for="new-project-name">项目名称</label><input class="input" style="width:100%" id="new-project-name" name="name" placeholder="例如：官网重构" required maxlength="80" autofocus></div>
      <div class="field-row">
        <div class="field"><label id="new-project-key-label" for="new-project-key">项目 Key</label><input class="input mono" style="width:100%" id="new-project-key" name="key" placeholder="WEB" maxlength="10" pattern="[A-Za-z][A-Za-z0-9]{0,9}"><div class="hint">任务的编号前缀。</div></div>
        <div class="field"><label id="new-project-owner-label" for="new-project-owner">总监 Bot</label><select class="select" style="width:100%" id="new-project-owner" name="ownerBotId">${bots.map(bot => `<option value="${attr(bot.id)}">${esc(bot.name)} · ${esc(bot.role || '成员')}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label id="new-project-description-label" for="new-project-description">项目说明</label><textarea class="textarea" id="new-project-description" name="description" placeholder="项目目标、边界和验收标准"></textarea></div>
      <div class="field"><label id="new-project-production-label" for="new-project-production">生产目录</label><div style="display:flex;gap:8px"><input class="input mono" style="flex:1" id="new-project-production" name="productionDir" placeholder="/Users/you/repos/my-game（可选）"><button class="btn" type="button" data-action="pick-dir-open" data-picker-for="new-project-production">${icon('folder')}选择</button></div><div class="hint">Bots 的工作目录，可指向既有代码库等本机目录；留空则用默认管理目录。</div><div class="dir-picker" id="dir-picker-new-project-production" hidden></div></div>
      ${bots.length > 1 ? `<div class="field"><span class="field-label" id="new-project-members-label">其他成员</span><div class="check-list" role="group" aria-labelledby="new-project-members-label">${bots.slice(1).map(bot => `<div class="check-row"><input type="checkbox" id="new-project-member-${attr(bot.id)}" name="memberIds" value="${attr(bot.id)}"><label for="new-project-member-${attr(bot.id)}">${avatar(bot, 'sm')} ${esc(bot.name)}</label><span class="role">${esc(bot.role || '')}</span></div>`).join('')}</div></div>` : ''}
    </form>`,
    footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${icon('plus')}创建项目</button>`,
  })
}

// 移除追踪的两步确认弹窗：第一步列后果 + 可选「同时移除生产目录」；
// 第二步输入项目名（完全一致才点亮执行按钮，见 input 监听里的门禁）。
function modalRemoveTracking() {
  const modal = state.modal
  if (modal.step === 2) {
    return modalShell({
      title: '移除追踪 · 确认执行',
      badge: '不可恢复',
      subtitle: `输入项目名「${modal.name}」以确认。`,
      body: `<form data-form="remove-tracking" id="modal-form">
        <input type="hidden" name="projectId" value="${attr(modal.projectId)}">
        <input type="hidden" name="purge" value="${modal.purge ? '1' : ''}">
        <div class="field"><label for="remove-tracking-name">项目名称</label><input class="input" style="width:100%" id="remove-tracking-name" name="confirmName" placeholder="${esc(modal.name)}" autocomplete="off" autofocus></div>
        <div class="hint">${modal.purge ? '将删除本项目全部管理数据，并移除项目生产目录（含全部文件）。' : '将删除本项目全部管理数据；项目生产目录保留。'}此操作不可恢复。</div>
      </form>`,
      footer: `<button class="btn" data-action="remove-tracking-back" type="button">上一步</button><button class="btn danger" type="submit" form="modal-form" id="remove-tracking-submit" disabled>确认移除追踪</button>`,
    })
  }
  return modalShell({
    title: '移除追踪 · 后果确认',
    badge: '不可恢复',
    subtitle: `将从本工作台移除已归档项目「${modal.name}」。`,
    body: `
      <ul class="remove-tracking-list">
        <li>本项目全部管理数据将删除：任务、运行记录、聊天消息、成员、记忆、提案、密钥绑定等。</li>
        <li>数据库中本项目的记录将一并清理，<strong>不可恢复</strong>。</li>
        <li>项目生产目录默认保留在原处。</li>
      </ul>
      <div class="check-row"><input type="checkbox" id="remove-tracking-purge"><label for="remove-tracking-purge">同时移除项目生产目录</label></div>
      <div class="hint">勾选后将删除项目生产目录（含目录内全部文件），同样不可恢复；不确定就先不勾。</div>`,
    footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn danger" data-action="remove-tracking-step2" type="button">继续</button>`,
  })
}

// 生产目录路径选择器：逐级浏览本机目录后回填目标输入框。
// 只改写选择器子树与目标输入框，不触发全局 render，避免重建创建表单丢掉已填内容。
function closeDirPicker(inputId) {
  const box = document.getElementById(`dir-picker-${inputId}`)
  if (box) {
    box.hidden = true
    box.innerHTML = ''
  }
}

async function renderDirPicker(inputId, path) {
  const box = document.getElementById(`dir-picker-${inputId}`)
  if (!box) return
  box.hidden = false
  let data = null
  let error = ''
  try {
    data = await api('browse_dirs', { path }, { quiet: true })
  } catch (err) {
    error = err?.message || String(err)
  }
  const current = data?.path ?? path ?? ''
  const head = `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <button class="btn small" type="button" data-action="pick-dir-up" data-picker-for="${attr(inputId)}" data-path="${attr(current)}" title="上一级">↑</button>
      <button class="btn small" type="button" data-action="pick-dir-home" data-picker-for="${attr(inputId)}">主目录</button>
      <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${attr(current)}">${esc(current)}</span>
      <button class="btn primary small" type="button" data-action="pick-dir-choose" data-picker-for="${attr(inputId)}" data-path="${attr(current)}">选定此目录</button>
      <button class="btn small" type="button" data-action="pick-dir-close" data-picker-for="${attr(inputId)}" title="关闭">✕</button>
    </div>`
  if (error) {
    box.innerHTML = `${head}<div class="hint" style="color:#c0392b">${esc(error)}</div>`
    return
  }
  const dirs = data?.dirs ?? []
  const list = dirs.length === 0
    ? '<div class="hint">没有子目录</div>'
    : dirs.map(name => `
      <button class="btn small" type="button" style="display:block;width:100%;text-align:left;margin-bottom:4px" data-action="pick-dir-nav" data-picker-for="${attr(inputId)}" data-path="${attr(`${current.replace(/\/+$/, '')}/${name}`)}">${icon('folder')} ${esc(name)}</button>`).join('')
  box.innerHTML = `${head}<div style="max-height:220px;overflow:auto">${list}</div>`
}

// 邀请选人弹窗：只列未入本项目且 status 为 active 的 bot，单选后确认提交 add_member。
// 关闭 / 取消 / 遮罩 / ESC 均为零变更（复用 modalShell 骨架）。
function modalInviteMember() {
  const project = activeProject()
  if (!project) {
    return modalShell({
      title: '邀请加入',
      body: `<div class="empty-state" style="border:0"><div class="empty-symbol">${icon('bot')}</div><h3>请先进入一个项目</h3><p>进入项目后才能邀请成员。</p></div>`,
      footer: '<button class="btn" data-action="close-modal">关闭</button>',
      size: 'small',
    })
  }
  const memberIds = new Set((project.members ?? []).map(member => member.id))
  const candidates = (state.data?.bots ?? []).filter(bot => bot.status === 'active' && !memberIds.has(bot.id))
  if (candidates.length === 0) {
    return modalShell({
      title: '邀请加入',
      subtitle: `项目：${project.name}`,
      body: `<div class="empty-state" style="border:0"><div class="empty-symbol">${icon('bot')}</div><h3>所有可用 Bot 都已在项目中</h3><p>先新建一个 Bot，再回来邀请它加入。</p></div>`,
      footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn" data-action="new-bot">${icon('plus')}新建 Bot</button>`,
    })
  }
  const selected = state.modal?.botId ?? ''
  return modalShell({
    title: '邀请加入',
    subtitle: `项目：${project.name}，选择一个 Bot。`,
    body: `<form data-form="invite-member" id="modal-form">
      <div class="list">
        ${candidates.map(bot => `
          <label class="list-row" title="${esc(bot.name)} · ${esc(bot.role || '成员')}">
            <input type="radio" name="botId" value="${attr(bot.id)}" ${bot.id === selected ? 'checked' : ''}>
            ${avatar(bot, 'sm')}
            <div class="list-main">
              <div class="list-title"><strong>${esc(bot.name)}</strong><span class="member-role">${esc(bot.role || '成员')}</span></div>
            </div>
          </label>`).join('')}
      </div>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form" id="invite-member-submit" ${selected ? '' : 'disabled'}>${icon('check')}确认邀请</button>`,
  })
}

function modalBot(detail) {
  const bot = detail?.bot ?? null
  const modelRef = bot?.modelRef ?? state.data?.models?.[0]?.ref ?? ''
  return modalShell({
    title: bot ? `配置 ${bot.name}` : '新建 Bot',
    subtitle: '',
    badge: '',
    size: 'wide',
    body: `<div class="${bot ? 'task-detail-grid' : ''}">
      <form data-form="${bot ? 'update-bot' : 'create-bot'}" id="modal-form">
        <input type="hidden" name="botId" value="${attr(bot?.id ?? '')}">
        <div class="field-row">
          <div class="field"><label id="bot-name-label" for="bot-name">名称</label><input class="input" style="width:100%" id="bot-name" name="name" value="${attr(bot?.name ?? '')}" placeholder="例如：Builder" required maxlength="24"></div>
          <div class="field"><label id="bot-role-label" for="bot-role">角色标签</label><input class="input" style="width:100%" id="bot-role" name="role" value="${attr(bot?.role ?? '')}" placeholder="例如：开发" maxlength="24"></div>
        </div>
        <div class="field-row">
          <div class="field"><label id="bot-model-label" for="bot-model">模型</label><select class="select" style="width:100%" id="bot-model" name="modelRef" data-model-select>${modelOptions(bot?.provider, bot?.model)}</select></div>
          <div class="field"><label id="bot-effort-label" for="bot-effort">推理强度</label><select class="select" style="width:100%" id="bot-effort" name="effort" data-effort-select>${effortOptions(modelRef, bot?.effort)}</select></div>
          <div class="field"><label id="bot-file-policy-label" for="bot-file-policy">文件权限</label><select class="select" style="width:100%" id="bot-file-policy" name="filePolicy" title="Bot 会话内文件操作的沙箱边界，下次运行生效">${filePolicyOptions(bot?.file_policy)}</select></div>
        </div>
        <div class="field-row">
          <div class="field"><label id="bot-fallback-model-label" for="bot-fallback-model">备用模型</label><select class="select" style="width:100%" id="bot-fallback-model" name="fallbackModelRef" data-fallback-model-select title="主模型不可用时自动接手的备用模型，留空 = 不启用">${fallbackModelOptions(bot?.fallbackModelRef ?? '')}</select></div>
          <div class="field"><label id="bot-fallback-effort-label" for="bot-fallback-effort">备用推理强度</label><select class="select" style="width:100%" id="bot-fallback-effort" name="fallbackEffort" data-fallback-effort-select>${effortOptions(bot?.fallbackModelRef ?? '', bot?.fallback_effort)}</select></div>
        </div>
        <div class="field"><span class="field-label" id="bot-color-label">外观颜色</span><div class="swatch-row" role="radiogroup" aria-labelledby="bot-color-label">${COLORS.map(color => `<label class="swatch" title="${COLOR_NAMES[color] ?? color}"><input type="radio" name="color" value="${color}" aria-label="${COLOR_NAMES[color] ?? color}" ${(bot?.color ?? COLORS[0]) === color ? 'checked' : ''}><span class="swatch-dot ${color}"></span></label>`).join('')}</div></div>
        <div class="field"><label id="bot-instructions-label" for="bot-instructions">角色指令</label><textarea class="textarea" id="bot-instructions" name="instructions" rows="10" placeholder="说明职责、工作方式、边界和交付标准">${esc(bot?.instructions ?? '')}</textarea></div>
        ${bot ? `<div class="btn-row"><button class="btn small" type="button" data-action="archive-bot" data-bot-id="${attr(bot.id)}">归档 Bot</button></div>` : ''}
      </form>
      ${bot ? `<aside class="task-detail-side">
        <div class="eyebrow" style="margin-bottom:9px">版本历史</div>
        ${(detail.revisions ?? []).map(revision => `<div class="revision-row"><span class="mono">v${revision.version}</span><span class="faint">${esc(timeAgo(revision.created_at))}</span>${revision.version === bot.current_revision ? '' : `<button class="btn small" data-action="rollback-bot" data-bot-id="${attr(bot.id)}" data-revision-id="${attr(revision.id)}">回滚</button>`}</div>`).join('') || '<div class="faint">暂无版本</div>'}
        <div class="divider"></div>
        <div class="kv"><span>运行次数</span><strong>${bot.stats.runs}</strong></div>
        <div class="kv"><span>成功 / 失败</span><strong>${bot.stats.succeeded} / ${bot.stats.failed}</strong></div>
        <div class="kv"><span>长期记忆</span><strong>${bot.memoryCount}</strong></div>
        <div class="kv"><span>状态</span><strong>${esc(BOT_STATUS[bot.status] ?? bot.status)}</strong></div>
        <div class="usage-note">模型或强度变更会在下一次运行时生效，不会中断当前运行。</div>
      </aside>` : ''}
    </div>`,
    footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${bot ? `${icon('check')}保存新版本` : `${icon('plus')}创建 Bot`}</button>`,
  })
}

// 任务关系选项（DSHBOTS-58）：父任务与依赖任务都只从本项目已有任务里选——
// 后端只接受同项目内引用，跨项目与自引用会被直接拒绝，列表因此不给别的项目的任务。
// selectedId（D-63 派生子任务）：给指定任务打 selected，让预填的父任务在下拉里真正选中显示，
// 而不是值带了、显示还停在「无（顶层任务）」。
function taskRelationOptions(selectedId = '') {
  const tasks = state.data?.tasks ?? []
  return tasks.map(task => `<option value="${attr(task.id)}"${task.id === selectedId ? ' selected' : ''}>${esc(task.identifier)} · ${esc(task.title)}</option>`).join('')
}

function modalNewTask() {
  const project = activeProject()
  if (!project) return ''
  // 派生子任务入口（D-63）带 parentTaskId 预填；常规新建不带。
  const preselectedParent = state.modal?.parentTaskId ?? ''
  return modalShell({
    title: '新建任务',
    subtitle: `${project.key} · ${project.name}`,
    badge: '',
    body: `<form data-form="create-task" id="modal-form">
      <input type="hidden" name="projectId" value="${attr(project.id)}">
      <div class="field"><label id="new-task-title-label" for="new-task-title">标题</label><input class="input" style="width:100%" id="new-task-title" name="title" required maxlength="240" placeholder="一个可执行、可验收的结果" autofocus></div>
      <div class="field"><label id="new-task-description-label" for="new-task-description">描述</label><textarea class="textarea" id="new-task-description" name="description" rows="8" placeholder="背景、范围、约束、验收标准"></textarea></div>
      <div class="field-row">
        <div class="field"><label id="new-task-assignee-label" for="new-task-assignee">指派给</label><select class="select" style="width:100%" id="new-task-assignee" name="assigneeBotId">${project.members.map(member => `<option value="${attr(member.id)}">${esc(member.name)} · ${esc(member.bot_role || '')}</option>`).join('')}</select></div>
        <div class="field"><label id="new-task-priority-label" for="new-task-priority">优先级</label><select class="select" style="width:100%" id="new-task-priority" name="priority"><option value="medium">中</option><option value="high">高</option><option value="urgent">紧急</option><option value="low">低</option><option value="none">无</option></select></div>
      </div>
      <div class="field-row">
        <div class="field"><label id="new-task-parent-label" for="new-task-parent">父任务</label><select class="select" style="width:100%" id="new-task-parent" name="parentTaskId"><option value="">无（顶层任务）</option>${taskRelationOptions(preselectedParent)}</select></div>
        <div class="field"><label id="new-task-blocked-label" for="new-task-blocked">依赖任务</label><select class="select" style="width:100%" id="new-task-blocked" name="blockedBy" multiple size="4">${taskRelationOptions()}</select></div>
      </div>
      <div class="usage-note">父任务只影响看板上的层级缩进；依赖任务未完成前，本任务不会被调度执行。</div>
      <div class="check-row"><input type="checkbox" id="new-task-autostart" name="autoStart" checked><label for="new-task-autostart">创建后立即进入执行队列</label></div>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${icon('plus')}创建任务</button>`,
  })
}

function modalSkill(detail) {
  if (!detail) return modalLoading('技能详情')
  const project = pageProject()
  const off = project?.disabledSkills?.includes(detail.slug) ?? false
  return modalShell({
    title: detail.name || detail.slug,
    subtitle: `/${detail.slug}`,
    badge: '共享技能',
    size: 'wide',
    body: `<div class="kv-grid">
        <div><div class="eyebrow">状态</div><div class="pill ${detail.status === 'active' ? 'green' : 'red'}">${esc(SKILL_STATUS[detail.status] ?? detail.status)}</div></div>
        <div><div class="eyebrow">版本</div><div>v${esc(currentSkillVersion(detail))}</div></div>
        <div><div class="eyebrow">本项目</div><div>${off ? '<span class="pill">已停用</span>' : '<span class="pill green">可用</span>'}</div></div>
      </div>
      <div class="detail-block"><div class="eyebrow">描述</div><div>${esc(detail.description || '无描述')}</div></div>
      <div class="detail-block"><div class="eyebrow">文件</div><code class="mono detail-path">${esc(detail.path || detail.sharedPath || '')}</code></div>
      <div class="divider"></div>
      <div class="eyebrow">SKILL.md 全文</div>
      ${detail.readable ? `<pre class="detail-pre">${esc(detail.content)}</pre>` : '<div class="note">技能文件当前不可读（可能已被移动或删除），可尝试重新扫描。</div>'}
      ${(detail.versions ?? []).length ? `<div class="divider"></div>
      ${skillVersions(detail)}` : ''}`,
    footer: `<button class="btn" data-action="close-modal">关闭</button>${project ? `<button class="btn ${off ? 'primary' : ''}" data-action="toggle-skill" data-slug="${attr(detail.slug)}" data-disabled="${off ? '0' : '1'}">${off ? '在本项目恢复' : '在本项目停用'}</button>` : ''}`,
  })
}

const ARTIFACT_IMAGE = /\.(png|jpe?g|gif|webp)$/i
const artifactFileUrl = (runId, path) =>
  `/api/dsh-team/artifact-file?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`

// 已完成写运行的交付产物：默认收起（与「查看输出」同一折叠口径），展开后图片内联预览（点击新窗口打开），其余文件列出路径与扩展名徽标。
function runArtifacts(state, run) {
  const list = Array.isArray(run.artifacts) ? run.artifacts : []
  if (run.status !== 'succeeded' || list.length === 0) return ''
  const rows = []
  for (const item of list) {
    const path = String(item?.path ?? '')
    if (!path) continue
    const url = artifactFileUrl(run.id, path)
    if (ARTIFACT_IMAGE.test(path)) {
      rows.push(`<button type="button" class="artifact-thumb" data-action="open-artifact" data-url="${attr(url)}" title="${attr(path)}"><img src="${attr(url)}" alt="${attr(path)}" loading="lazy"></button>`)
    } else {
      const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'file').toUpperCase().slice(0, 6)
      rows.push(`<a class="artifact-file" href="${attr(url)}" target="_blank" rel="noopener"><span class="artifact-path">${esc(path)}</span><span class="artifact-ext mono">${esc(ext)}</span></a>`)
    }
  }
  if (!rows.length) return ''
  return `<details style="margin-top:6px"${panelAttrs(state, `run-artifacts:${run.id}`)}><summary class="summary-link">交付产物（${rows.length}）</summary><div class="artifact-list">${rows.join('')}</div></details>`
}

// ===== 思考过程：Bot 运行轨迹（run_trajectory）=====

const TRAJ_LABELS = { thinking: '思考', text: '回复', tool_call: '调用工具', tool_result: '工具返回', end: '运行结束' }

function trajectoryLabel(entry) {
  const kind = String(entry?.kind ?? '')
  const title = String(entry?.title ?? '').trim()
  if (kind === 'tool_call') return title ? (title.startsWith('调用工具') ? title : `调用工具 ${title}`) : TRAJ_LABELS.tool_call
  if (kind === 'tool_result') return title ? (title.startsWith('工具') ? title : `工具 ${title} 返回`) : TRAJ_LABELS.tool_result
  return title || TRAJ_LABELS[kind] || ''
}

function trajectoryEntry(entry, index = 0, runId = '') {
  const kind = String(entry?.kind ?? '')
  const title = String(entry?.title ?? '').trim()
  const detail = String(entry?.detail ?? '')
  const label = trajectoryLabel(entry)
  if (kind === 'turn') {
    return `<div class="traj-turn"><span>${esc(title || `第 ${entry?.turn ?? ''} 轮`)}</span></div>`
  }
  if (kind === 'note') {
    return `<div class="traj-note">${esc([title, detail].filter(Boolean).join(' · '))}</div>`
  }
  if (kind === 'thinking' || kind === 'tool_call' || kind === 'tool_result') {
    const body = detail ? `<div class="traj-detail${kind === 'thinking' ? '' : ' traj-json'}">${esc(detail)}</div>` : ''
    return `<details class="traj-entry traj-fold"${panelAttrs(state, `traj:${runId}:${index}`)}><summary class="traj-entry-head">${esc(label)}</summary>${body}</details>`
  }
  const head = `<div class="traj-entry-head">${esc(label || title || kind)}</div>`
  const body = detail ? `<div class="traj-detail">${esc(detail)}</div>` : ''
  return `<div class="traj-entry${kind === 'end' ? ' traj-end' : ''}">${head}${body}</div>`
}

function modalTrajectory(detail, runId) {
  const entries = Array.isArray(detail?.entries) ? detail.entries : []
  const body = entries.length === 0
    ? '<div class="faint">这次运行没有可展示的轨迹。</div>'
    : `<div class="traj-stream">${entries.map((entry, index) => trajectoryEntry(entry, index, runId)).join('')}</div>`
  return modalShell({
    title: '思考过程',
    subtitle: entries.length ? `${entries.length} 条轨迹记录` : '',
    body,
    footer: '<button class="btn" data-action="close-modal">关闭</button>',
    size: 'wide',
  })
}

function modalTask(task) {
  if (!task) return modalLoading('任务')
  const project = activeProject()
  const activeRun = (task.runs ?? []).find(run => ['queued', 'running'].includes(run.status))
  const latestFailed = (task.runs ?? []).find(run => ['failed', 'canceled'].includes(run.status))
  // 终态时间小字（DSHBOTS-44）：与任务卡同口径——done 取 completed_at、canceled 取 canceled_at，缺列不造占位。
  // 终态下 stageLabel 为 null（DSHBOTS-42 口径），badge 槽正好空出，用「完成于/取消于 + 时间」补位。
  const endAt = task.status === 'done' ? task.completed_at : task.status === 'canceled' ? task.canceled_at : null
  // 任务关系（DSHBOTS-58）：父任务取本项目任务表里的那条，依赖只列未满足项（blockedByNames）。
  const parentTask = (state.data?.tasks ?? []).find(item => item.id === (task.parent_task_id ?? task.parentTaskId ?? null)) ?? null
  const blockedNames = Array.isArray(task.blockedByNames) ? task.blockedByNames : []
  return modalShell({
    title: `${task.identifier} · ${task.title}`,
    // 任务阶段徽标走 taskStage 查表口径（DSHBOTS-42）：ended → stageLabel 为 null → 不显示。
    badge: task.stageLabel ? esc(task.stageLabel) : endAt ? esc(`${task.status === 'done' ? '完成于' : '取消于'} ${formatTime(endAt)}`) : '',
    size: 'task',
    body: `<div class="task-detail-grid">
      <div class="task-detail-main">
        <form data-form="update-task" id="task-form">
          <input type="hidden" name="taskId" value="${attr(task.id)}">
          <input type="hidden" name="version" value="${task.version}">
          <div class="field"><label id="task-title-label" for="task-title">标题</label><input class="input" style="width:100%" id="task-title" name="title" value="${attr(task.title)}" required maxlength="240"></div>
          <div class="field"><label id="task-description-label" for="task-description">描述</label><textarea class="textarea" id="task-description" name="description" rows="9">${esc(task.description || '')}</textarea></div>
          <div class="field-row">
            <div class="field"><label id="task-status-label" for="task-status">状态</label><select class="select" style="width:100%" id="task-status" name="status">${STATUS_ORDER.map(status => `<option value="${status}" ${task.status === status ? 'selected' : ''}>${STATUS[status]}</option>`).join('')}</select></div>
            <div class="field"><label id="task-priority-label" for="task-priority">优先级</label><select class="select" style="width:100%" id="task-priority" name="priority">${Object.entries(PRIORITY).map(([key, label]) => `<option value="${key}" ${task.priority === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label id="task-assignee-label" for="task-assignee">负责人</label><select class="select" style="width:100%" id="task-assignee" name="assigneeBotId"><option value="">未指派</option>${project.members.map(member => `<option value="${attr(member.id)}" ${task.assignee_bot_id === member.id ? 'selected' : ''}>${esc(member.name)} · ${esc(member.bot_role || '')}</option>`).join('')}</select></div>
        </form>
        ${(parentTask || blockedNames.length) ? `<div class="note">${parentTask ? `父任务：${esc(parentTask.identifier)} · ${esc(parentTask.title)}` : ''}${parentTask && blockedNames.length ? ' · ' : ''}${blockedNames.length ? `被 ${blockedNames.length} 个任务阻塞：${esc(blockedNames.join('、'))}` : ''}</div>` : ''}
        <div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:6px">评论</div>
        ${(task.comments ?? []).length === 0 ? '<div class="note">还没有评论。</div>' : task.comments.map(comment => `<div class="comment">
          ${avatar(comment.author_type === 'bot' ? (botById(comment.author_id) ?? { name: comment.authorName, color: 'gray' }) : { name: '我', color: 'teal' }, 'sm')}
          <div class="comment-main"><div class="comment-head"><strong>${esc(comment.authorName)}</strong><span>${esc(timeAgo(comment.created_at))}</span></div><div class="comment-body">${richText(comment.body, mdChatScope())}</div></div>
        </div>`).join('')}
        <form data-form="add-comment" style="margin-top:14px">
          <input type="hidden" name="taskId" value="${attr(task.id)}">
          <textarea class="textarea" id="task-comment-body" name="body" rows="3" aria-label="评论内容" placeholder="补充说明、验收意见或阻塞原因"></textarea>
          <div class="btn-row" style="margin-top:7px"><button class="btn small" type="submit">${icon('send')}添加评论</button></div>
        </form>
      </div>
      <aside class="task-detail-side">
        <div class="eyebrow">运行记录</div>
        ${(activeRun || latestFailed) ? `<div class="btn-row" style="margin:9px 0 2px">${activeRun ? `<button class="btn danger small" type="button" data-action="cancel-run" data-run-id="${attr(activeRun.id)}">${icon('stop')}停止运行</button>` : ''}${latestFailed ? `<button class="btn small" type="button" data-action="retry-run" data-run-id="${attr(latestFailed.id)}">${icon('refresh')}重试</button>` : ''}</div>` : ''}
        <div style="margin-top:8px">${(task.runs ?? []).length === 0 ? '<div class="note">还没有运行。</div>' : task.runs.map(run => `<div class="run-row">
          <div class="run-row-top">${runDot(run.status)}<strong>#${run.attempt}</strong><span>${esc(RUN_STATUS[run.status] ?? run.status)}</span><span style="margin-left:auto">${esc(timeAgo(run.queued_at))}</span></div>
          <div class="run-row-meta"><span>${esc(duration(run.started_at, run.ended_at))}</span><span>${formatNumber(run.usage_input + run.usage_output)} tok</span>${run.usage_cost !== null && run.usage_cost !== undefined ? `<span>${formatCost(run.usage_cost)}</span>` : ''}</div>
          ${run.error_message ? `<div class="run-output error">${esc(run.error_message)}</div>` : ''}
          ${run.output ? `<details style="margin-top:6px"${panelAttrs(state, `run-output:${run.id}`)}><summary class="summary-link">查看输出</summary><div class="run-output">${esc(run.output)}</div></details>` : ''}
          ${runArtifacts(state, run)}
        </div>`).join('')}</div>
        <div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:7px">详情</div>
        <div class="kv"><span>编号</span><strong>${esc(task.identifier)}</strong></div>
        <div class="kv"><span>负责人</span><strong>${esc(task.assignee_name || '未指派')}</strong></div>
        <div class="kv"><span>创建者</span><strong>${esc(CREATOR_TYPE[task.creator_type] ?? task.creator_type)}</strong></div>
        <div class="kv"><span>更新时间</span><strong>${esc(timeAgo(task.updated_at))}</strong></div>
        ${(task.dependencies ?? []).length ? `<div class="divider"></div><div class="eyebrow" style="margin-bottom:7px">依赖</div>${task.dependencies.map(dep => `<div class="kv"><span>${esc(dep.title)}</span><strong>${esc(STATUS[dep.status] ?? dep.status)}</strong></div>`).join('')}` : ''}
      </aside>
    </div>`,
    footer: `<button class="btn" data-action="close-modal">关闭</button><button class="btn" type="button" data-action="derive-subtask" data-task-id="${attr(task.id)}" title="以本任务为父任务新建子任务">${icon('branch')}派生子任务</button><button class="btn" type="button" data-action="run-task" data-task-id="${attr(task.id)}">${icon('play')}保存并运行</button><button class="btn primary" type="submit" form="task-form">${icon('check')}保存</button>`,
  })
}

function modalMemory(memory) {
  // 写作入口随上下文收敛（DSHBOTS-5）：群聊只写当前项目记忆，单聊只写该 bot 记忆，不再可选 Bot 列表。
  const project = pageProject()
  const soloBot = inSoloContext() ? botById(state.soloBotId) : null
  const scope = soloBot
    ? `bot:${attr(soloBot.id)}`
    : project ? `project:${attr(project.id)}` : ''
  const disabledText = soloBot ? `Bot · ${esc(soloBot.name)}` : '项目记忆'
  return modalShell({
    title: memory ? '编辑记忆' : '写入记忆',
    badge: '',
    body: `<form data-form="${memory ? 'update-memory' : 'create-memory'}" id="modal-form">
      <input type="hidden" name="memoryId" value="${attr(memory?.id ?? '')}">
      <div class="field"><label id="memory-scope-label" for="memory-scope">作用域</label>${memory
        ? `<input class="input" style="width:100%" id="memory-scope" value="${esc(memory.scope_type === 'project' ? '项目记忆' : `Bot · ${botById(memory.scope_id)?.name ?? ''}`)}" disabled>`
        : `<input class="input" style="width:100%" id="memory-scope" value="${esc(disabledText)}" disabled>${scope ? `<input type="hidden" name="scope" value="${attr(scope)}">` : ''}`}</div>
      <div class="field"><label id="memory-topic-label" for="memory-topic">主题</label><input class="input" style="width:100%" id="memory-topic" name="topic" value="${attr(memory?.topic ?? '')}" maxlength="120" placeholder="例如：发布流程约束" required></div>
      <div class="field"><label id="memory-content-label" for="memory-content">内容</label><textarea class="textarea" id="memory-content" name="content" rows="9" required placeholder="写清楚背景、结论和适用范围">${esc(memory?.content ?? '')}</textarea><div class="hint">密钥、密码和 token 会被自动过滤为 [REDACTED]。</div></div>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${memory ? `${icon('check')}保存记忆` : `${icon('plus')}写入记忆`}</button>`,
  })
}

function modalProposal(kind = 'bot_update') {
  // 单聊上下文发起的提案不挂任何项目（团队级提案）。
  const project = pageProject()
  return modalShell({
    title: '新建进化提案',
    subtitle: '审批通过后才会生效。',
    badge: '',
    size: 'wide',
    body: `<form data-form="create-proposal" id="modal-form">
      <input type="hidden" name="projectId" value="${attr(project?.id ?? '')}">
      <div class="field-row">
        <div class="field"><label id="proposal-kind-label" for="proposal-kind">提案类型</label><select class="select" style="width:100%" id="proposal-kind" name="kind" data-proposal-kind><option value="bot_update" ${kind === 'bot_update' ? 'selected' : ''}>Bot 指令更新</option><option value="skill" ${kind === 'skill' ? 'selected' : ''}>共享技能</option></select></div>
        <div class="field" data-field="bot"><label id="proposal-bot-label" for="proposal-bot">目标 Bot</label><select class="select" style="width:100%" id="proposal-bot" name="botId">${activeBots().map(bot => `<option value="${attr(bot.id)}">${esc(bot.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label id="proposal-title-label" for="proposal-title">标题</label><input class="input" style="width:100%" id="proposal-title" name="title" required maxlength="200" placeholder="一句话说明变更"></div>
      <div class="field"><label id="proposal-rationale-label" for="proposal-rationale">变更理由</label><textarea class="textarea" id="proposal-rationale" name="rationale" rows="4" required placeholder="为什么需要变更，来自哪些失败或重复模式"></textarea></div>
      <div data-section="bot"><div class="field"><label id="proposal-instructions-label" for="proposal-instructions">新的角色指令</label><textarea class="textarea" id="proposal-instructions" name="instructions" rows="9" placeholder="完整替换现有指令，而不是追加"></textarea></div></div>
      <div data-section="skill" style="display:none">
        <div class="field-row"><div class="field"><label id="proposal-slug-label" for="proposal-slug">技能标识</label><input class="input mono" style="width:100%" id="proposal-slug" name="slug" placeholder="发布检查"></div><div class="field"><label id="proposal-version-label" for="proposal-version">版本</label><input class="input" style="width:100%" id="proposal-version" name="version" value="1.0.0"></div></div>
        <div class="field-row"><div class="field"><label id="proposal-name-label" for="proposal-name">显示名称</label><input class="input" style="width:100%" id="proposal-name" name="name"></div><div class="field"><label id="proposal-description-label" for="proposal-description">描述</label><input class="input" style="width:100%" id="proposal-description" name="description"></div></div>
        <div class="field"><label id="proposal-content-label" for="proposal-content">技能内容（Markdown）</label><textarea class="textarea" id="proposal-content" name="content" rows="10" placeholder="## When to use&#10;..."></textarea></div>
      </div>
      <div class="field"><label id="proposal-evaluation-label" for="proposal-evaluation">评估方式</label><textarea class="textarea" id="proposal-evaluation" name="evaluation" rows="3" placeholder="审批前如何验证：回归任务、失败案例、人工检查点"></textarea></div>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${icon('branch')}提交提案</button>`,
  })
}

function priceDefaults() {
  return state.data?.priceDefaults ?? []
}

function defaultPriceFor(model) {
  const key = String(model ?? '').toLowerCase()
  return priceDefaults().find(item => item.model.toLowerCase() === key)
}

function modalPrice(seed = {}) {
  const editing = Boolean(seed.model)
  const catalogModels = (state.data?.models ?? []).map(item => item.model)
  const knownModels = [...new Set([...catalogModels, ...priceDefaults().map(item => item.model)])]
  const providers = [...new Set((state.data?.models ?? []).map(item => item.provider))]
  const fallback = defaultPriceFor(seed.model)
  const hint = fallback
    ? `配置默认：缓存读 ${fallback.cacheReadPerMtok} / 输入 ${fallback.inputPerMtok} / 输出 ${fallback.outputPerMtok} ${fallback.currency}（每百万 token）`
    : '价格为每百万 token。供应商留空表示匹配任意供应商。'
  const overridden = Boolean(editing && fallback) && (
    Number(seed.cache_read_per_mtok) !== Number(fallback.cacheReadPerMtok)
    || Number(seed.input_per_mtok) !== Number(fallback.inputPerMtok)
    || Number(seed.output_per_mtok) !== Number(fallback.outputPerMtok)
    || String(seed.currency ?? fallback.currency).toUpperCase() !== String(fallback.currency).toUpperCase()
  )
  return modalShell({
    title: editing ? `编辑价格 · ${seed.model}` : '设置模型价格',
    subtitle: '保存后仅影响后续调用。',
    badge: '',
    body: `<form data-form="save-price" id="modal-form">
      <div class="field-row"><div class="field"><label id="price-provider-label" for="price-provider">模型供应商</label><input class="input mono" style="width:100%" id="price-provider" name="provider" list="price-providers" value="${attr(seed.provider ?? '')}" placeholder="留空 = 匹配任意供应商"></div><div class="field"><label id="price-model-label" for="price-model">模型名</label><input class="input mono" style="width:100%" id="price-model" name="model" list="price-models" value="${attr(seed.model ?? '')}" placeholder="deepseek-flash" required autofocus></div></div>
      <div class="field-row"><div class="field"><label id="price-input-label" for="price-input">输入</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-input" name="inputPerMtok" required value="${attr(seed.input_per_mtok ?? fallback?.inputPerMtok ?? '')}" placeholder="2"></div><div class="field"><label id="price-output-label" for="price-output">输出</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-output" name="outputPerMtok" required value="${attr(seed.output_per_mtok ?? fallback?.outputPerMtok ?? '')}" placeholder="8"></div></div>
      <div class="field-row"><div class="field"><label id="price-cache-read-label" for="price-cache-read">缓存读</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-cache-read" name="cacheReadPerMtok" value="${attr(seed.cache_read_per_mtok ?? fallback?.cacheReadPerMtok ?? '')}" placeholder="0.2"></div><div class="field"><label id="price-cache-write-label" for="price-cache-write">缓存写</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-cache-write" name="cacheWritePerMtok" value="${attr(seed.cache_write_per_mtok ?? fallback?.cacheWritePerMtok ?? '')}" placeholder="0"></div></div>
      <div class="field"><label id="price-currency-label" for="price-currency">币种</label><input class="input mono" style="width:100%" id="price-currency" name="currency" value="${attr(seed.currency ?? fallback?.currency ?? 'CNY')}" placeholder="CNY"></div>
      <div class="hint">${esc(hint)}</div>
      ${overridden ? `<div class="btn-row"><button class="btn danger" type="button" data-action="reset-price" data-model="${attr(seed.model)}" data-provider="${attr(seed.provider ?? '')}">恢复默认价格</button></div>` : ''}
      <datalist id="price-models">${knownModels.map(model => `<option value="${attr(model)}"></option>`).join('')}</datalist>
      <datalist id="price-providers">${providers.map(provider => `<option value="${attr(provider)}"></option>`).join('')}</datalist>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${icon('check')}保存价格</button>`,
  })
}

function renderPriceCard() {
  const prices = state.data?.prices ?? []
  const defaults = priceDefaults()
  const missing = defaults.filter(item => !prices.some(price => price.model.toLowerCase() === item.model.toLowerCase()))
  const rows = prices.map(price => {
    const fallback = defaultPriceFor(price.model)
    const builtin = Boolean(fallback)
      && Number(price.cache_read_per_mtok) === Number(fallback.cacheReadPerMtok)
      && Number(price.cache_write_per_mtok) === Number(fallback.cacheWritePerMtok)
      && Number(price.input_per_mtok) === Number(fallback.inputPerMtok)
      && Number(price.output_per_mtok) === Number(fallback.outputPerMtok)
    const provider = price.provider ? price.provider : '任意供应商'
    return `<tr>
      <td class="price-model">${esc(price.model)}<span class="pill ${builtin ? 'green' : 'violet'}">${builtin ? '内置' : '自定义'}</span></td>
      <td class="num mono">${esc(price.cache_read_per_mtok)}</td>
      <td class="num mono">${esc(price.input_per_mtok)}</td>
      <td class="num mono">${esc(price.output_per_mtok)}</td>
      <td>${esc(price.currency)}</td>
      <td>${esc(provider)}</td>
      <td class="num"><button class="btn small" data-action="edit-price" data-model="${attr(price.model)}" data-provider="${attr(price.provider)}">${icon('edit')}编辑</button></td>
    </tr>`
  }).join('')
  const body = prices.length
    ? `<table class="usage-table price-table">
        <thead><tr>
          <th class="eyebrow mono">模型</th>
          <th class="eyebrow mono num">缓存读</th>
          <th class="eyebrow mono num">输入</th>
          <th class="eyebrow mono num">输出</th>
          <th class="eyebrow mono">币种</th>
          <th class="eyebrow mono">供应商</th>
          <th class="eyebrow mono num"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<div class="empty-state"><div class="empty-symbol">${icon('chart')}</div><h3>还没有价格规则</h3><p>新增一条模型价格，成本估算才会生效。</p></div>`
  return `<div class="card price-card">
    <div class="card-head">
      <h3>模型价格</h3>
      <div class="btn-row">
        <span class="meta">${prices.length} 条规则</span>
        <button class="btn" data-action="new-price">${icon('plus')}新增</button>
      </div>
    </div>
    ${body}
    <div class="usage-note">价格为每百万 token。在「编辑」里可以还原配置默认值。${missing.length ? `配置中但未生效：${missing.map(item => esc(item.model)).join('、')}。` : ''}</div>
  </div>`
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
let lastFocused = null

function focusableItems(root) {
  if (!root) return []
  return Array.from(root.querySelectorAll(FOCUSABLE))
    .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement)
}

function focusModal() {
  const modal = document.querySelector('.modal')
  if (!modal) return
  const body = modal.querySelector('.modal-body')
  const preferred = body?.querySelector('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])')
  const items = focusableItems(modal)
  ;(preferred ?? items[0] ?? modal).focus()
}

function restoreFocus() {
  const target = lastFocused && document.contains(lastFocused) ? lastFocused : document.getElementById('main-content')
  lastFocused = null
  if (target) target.focus()
}

function trapModalFocus(event) {
  const modal = document.querySelector('.modal')
  if (!modal) return false
  const items = focusableItems(modal)
  if (items.length === 0) {
    event.preventDefault()
    modal.focus()
    return true
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (event.shiftKey && (active === first || !modal.contains(active))) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && (active === last || !modal.contains(active))) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}

function openModal(modal) {
  state.modal = modal
  render()
}

function closeModal() {
  if (!state.modal) return
  state.modal = null
  render()
}

async function openTask(taskId) {
  state.modal = { type: 'task', loading: true, title: '任务详情' }
  render()
  try {
    const detail = await api('task_detail', { taskId })
    if (state.modal?.type !== 'task') return
    state.modal = { type: 'task', detail }
    render()
  } catch {
    closeModal()
  }
}

async function openSkillDetail(slug) {
  state.modal = { type: 'skill-detail', loading: true, title: '技能详情' }
  render()
  try {
    const detail = await api('skill_detail', { slug })
    if (state.modal?.type !== 'skill-detail') return
    state.modal = { type: 'skill-detail', detail }
    render()
  } catch {
    closeModal()
  }
}

async function openTrajectory(runId) {
  openModal({ type: 'trajectory', loading: true, title: '思考过程' })
  try {
    const detail = await api('run_trajectory', { runId }, { quiet: true })
    if (state.modal?.type !== 'trajectory') return
    state.modal = { type: 'trajectory', detail, runId }
    render()
  } catch (error) {
    closeModal()
    toast(error?.message || '读取思考过程失败', 'error')
  }
}

async function openBot(botId) {
  state.modal = { type: 'edit-bot', loading: true, title: 'Bot 配置' }
  render()
  try {
    const detail = await api('bot_detail', { botId })
    if (state.modal?.type !== 'edit-bot') return
    state.modal = { type: 'edit-bot', detail }
    render()
  } catch {
    closeModal()
  }
}

async function reloadTaskModal(taskId) {
  const detail = await api('task_detail', { taskId }, { quiet: true })
  if (state.modal?.type === 'task') {
    state.modal = { type: 'task', detail }
    render()
  }
}

function bindProposalForm() {
  const kind = document.querySelector('[data-proposal-kind]')
  if (!kind) return
  const apply = () => {
    const value = kind.value
    document.querySelectorAll('[data-section]').forEach(section => {
      section.style.display = section.dataset.section === value ? '' : 'none'
    })
    const botField = document.querySelector('[data-field="bot"]')
    if (botField) botField.style.display = value === 'bot_update' ? '' : 'none'
  }
  kind.addEventListener('change', apply)
  apply()
}

function updateEffortOptions(select) {
  const form = select.closest('form')
  const effort = form?.querySelector('[data-effort-select]')
  if (!effort) return
  effort.innerHTML = effortOptions(select.value, '')
}

// 备用模型的推理强度跟随备用模型变化，选项来源与主模型同一张表。
function updateFallbackEffortOptions(select) {
  const form = select.closest('form')
  const effort = form?.querySelector('[data-fallback-effort-select]')
  if (!effort) return
  effort.innerHTML = effortOptions(select.value, '')
}

function formPayload(form) {
  return Object.fromEntries(new FormData(form).entries())
}

// ac-core:start —— 输入框 / 与 @ 自动补全的纯逻辑（tests/ac.test.js 抽取此块断言）
const AC_COMMANDS = [
  { kind: 'command', label: '/task', title: '派任务', desc: '创建任务并排队执行：/task @成员 标题', insert: '/task @', then: 'mention' },
  { kind: 'command', label: '/remember', title: '写项目记忆', desc: '写入项目级记忆：/remember 内容', insert: '/remember ' },
  { kind: 'command', label: '/clear', title: '清空聊天', desc: '清空本群全部聊天记录（任务与记忆保留）', insert: '/clear' },
]
const acWordChar = (ch) => ch !== undefined && !/[\s@/]/.test(ch)

// 光标处的补全令牌：slash 仅在消息开头（服务端命令都锚定行首）；mention 需 @ 前是行首或空白，与 src/util.js parseMentions 一致
function detectAcToken(value, caret) {
  const pos = Math.min(Math.max(caret ?? 0, 0), value.length)
  if (pos > 0 && value[0] === '/') {
    let end = 1
    while (end < value.length && acWordChar(value[end])) end += 1
    if (pos <= end) return { mode: 'slash', from: 0, to: end, query: value.slice(1, end) }
  }
  let start = pos
  while (start > 0 && acWordChar(value[start - 1])) start -= 1
  const at = start - 1
  if (at >= 0 && value[at] === '@' && (at === 0 || /\s/.test(value[at - 1]))) {
    let end = pos
    while (end < value.length && acWordChar(value[end])) end += 1
    return { mode: 'mention', from: at, to: end, query: value.slice(start, end) }
  }
  return null
}

function buildAcItems(mode, query, sources) {
  const needle = String(query ?? '').trim().toLowerCase()
  const hit = (text) => !needle || String(text ?? '').toLowerCase().includes(needle)
  const items = []
  if (mode === 'slash') {
    for (const command of AC_COMMANDS) {
      if (hit(command.label.slice(1)) || hit(command.title)) items.push(command)
    }
    for (const skill of sources.skills ?? []) {
      if (hit(skill.slug) || hit(skill.name)) items.push({
        kind: 'skill', label: `/${skill.slug}`, title: skill.name || skill.slug,
        desc: skill.description || '共享技能', insert: `/${skill.slug} `,
      })
    }
  } else {
    for (const member of sources.members ?? []) {
      if (hit(member.name) || hit(member.role)) items.push({
        kind: 'member', label: `@${member.name}`, title: member.name, color: member.color,
        desc: member.owner ? `总监 · ${member.role || '成员'}` : (member.role || '成员'),
        insert: `@${member.name} `,
      })
    }
  }
  return items
}
// ac-core:end

function acSources() {
  const project = activeProject()
  const disabled = new Set(project?.disabledSkills ?? [])
  const members = (project?.members ?? [])
    .map(member => botById(member.id))
    .filter(bot => bot && bot.status === 'active')
    .map(bot => ({ id: bot.id, name: bot.name, role: bot.role, color: bot.color, owner: bot.id === project.owner_bot_id }))
  const skills = (state.data?.skills ?? [])
    .filter(skill => skill.status === 'active' && !disabled.has(skill.slug))
    .map(skill => ({ slug: skill.slug, name: skill.name, description: skill.description }))
  // 项目技能只在当前项目可用；与共享技能同名时项目技能优先。
  const projectSkills = (state.data?.projectSkills ?? [])
    .filter(skill => !disabled.has(skill.name))
    .map(skill => ({ slug: skill.name, name: skill.name, description: skill.description }))
  const projectNames = new Set(projectSkills.map(skill => skill.slug))
  return { skills: [...projectSkills, ...skills.filter(skill => !projectNames.has(skill.slug))], members }
}

function updateAutocomplete() {
  const input = document.getElementById('composer-input')
  const popup = document.getElementById('composer-ac')
  if (!input || !popup) { state.ac = null; return }
  const token = input === document.activeElement ? detectAcToken(input.value, input.selectionStart) : null
  const items = token ? buildAcItems(token.mode, token.query, acSources()) : []
  if (items.length === 0) { state.ac = null; renderAcPopup(popup, null); return }
  const keep = state.ac && state.ac.mode === token.mode && state.ac.query === token.query
  state.ac = { ...token, items, selected: keep ? Math.min(state.ac.selected, items.length - 1) : 0 }
  renderAcPopup(popup, state.ac)
}

function renderAcPopup(popup, session) {
  if (!popup) return
  const input = document.getElementById('composer-input')
  if (!session) {
    popup.hidden = true
    popup.innerHTML = ''
    input?.removeAttribute('aria-activedescendant')
    return
  }
  popup.innerHTML = session.items.map((item, index) => {
    const glyph = item.kind === 'member'
      ? `<span class="avatar sm ${attr(item.color || 'gray')}">${esc(initials(item.title))}</span>`
      : `<span class="composer-ac-glyph">${icon(item.kind === 'skill' ? 'spark' : 'terminal')}</span>`
    return `<button type="button" class="composer-ac-item${index === session.selected ? ' active' : ''}" role="option" aria-selected="${index === session.selected}" data-ac-idx="${index}" id="composer-ac-item-${index}">
      ${glyph}
      <span class="composer-ac-text"><strong>${esc(item.label)}</strong><span>${esc(item.desc)}</span></span>
    </button>`
  }).join('') + `<div class="composer-ac-hint">↑↓ 选择 · Enter 或 Tab 插入 · Esc 关闭</div>`
  popup.hidden = false
  const active = popup.querySelector('.composer-ac-item.active')
  if (active && input) input.setAttribute('aria-activedescendant', active.id)
}

function moveAcSelection(delta) {
  if (!state.ac) return
  const count = state.ac.items.length
  state.ac.selected = (state.ac.selected + delta + count) % count
  const popup = document.getElementById('composer-ac')
  renderAcPopup(popup, state.ac)
  popup?.querySelector('.composer-ac-item.active')?.scrollIntoView({ block: 'nearest' })
}

function closeAutocomplete() {
  state.ac = null
  renderAcPopup(document.getElementById('composer-ac'), null)
}

function applyAutocomplete(item) {
  const input = document.getElementById('composer-input')
  if (!input || !item || !state.ac) return
  const { from, to } = state.ac
  input.value = input.value.slice(0, from) + item.insert + input.value.slice(to)
  const caret = from + item.insert.length
  state.ac = null
  input.focus()
  input.setSelectionRange(caret, caret)
  syncComposerBox(input)
  closeAutocomplete()
  if (item.then === 'mention') updateAutocomplete()
}

// chat-drafts:start —— 草稿键与读取的纯逻辑（tests/chat-ui.test.js 抽取此块断言）
// 群聊按项目、单聊按 Bot 分开记草稿，切换上下文互不覆盖、互不清空。
function draftKey(s) {
  return s.chatMode === 'solo' ? `solo:${s.soloBotId}` : `group:${s.projectId}`
}
function currentDraft(s) {
  return s.chatDrafts[draftKey(s)] ?? ''
}
// chat-drafts:end

// chat-images:start —— 聊天图片输入的纯逻辑（tests/chat-image-ui.test.js 抽取此块断言）
// 口径与后端 src/services/message-images.js 对齐：png/jpeg/gif/webp 四种，单图 ≤5MB，单条 ≤4 张。
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const IMAGE_ACCEPT = IMAGE_MEDIA_TYPES.join(',')
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 4
const IMAGE_EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

// 浏览器给的 MIME 优先；为空时按扩展名兜底（部分系统不给 type）。都不匹配返回 null（前端拦截）。
function resolveImageMediaType(type, name) {
  const declared = String(type ?? '').trim().toLowerCase()
  if (IMAGE_MEDIA_TYPES.includes(declared)) return declared
  const ext = String(name ?? '').trim().toLowerCase().split('.').pop()
  return IMAGE_EXT_TYPES[ext] ?? null
}

function formatImageBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// 选片校验：类型不符 / 超 5MB / 超张数，各给可读原因；accepted 只收合规文件（带原 file 引用供读取）。
function validateImageSelection(files, existingCount = 0) {
  const accepted = []
  const rejected = []
  let count = Number(existingCount) || 0
  for (const file of Array.from(files ?? [])) {
    const name = file?.name ?? ''
    const mediaType = resolveImageMediaType(file?.type, name)
    if (!mediaType) {
      rejected.push({ name, reason: '仅支持 PNG / JPEG / GIF / WebP 格式' })
      continue
    }
    const bytes = Number(file?.size) || 0
    if (bytes > MAX_IMAGE_BYTES) {
      rejected.push({ name, reason: '单张图片不能超过 5MB' })
      continue
    }
    if (count >= MAX_IMAGES_PER_MESSAGE) {
      rejected.push({ name, reason: `一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片` })
      continue
    }
    count += 1
    accepted.push({ file, name, mediaType, bytes })
  }
  return { accepted, rejected }
}
// chat-images:end

// —— 聊天图片 UI（附件按钮 / 待发缩略图条 / 消息附图块 / 原图查看器）——
// 图片数据只走两条路：待发图片的 base64 随 send_message 出站，原图按 id 现取现看；
// 任何时候都不把 base64 写进 HTML 字符串，缩略图预览用 blob: URL。

// 当前上下文的待发图片（同草稿口径分键：群聊按项目、单聊按 Bot）。
function pendingImagesFor(s = state) {
  return s.pendingImages?.[draftKey(s)] ?? []
}

function setPendingImages(list, s = state) {
  s.pendingImages = { ...(s.pendingImages ?? {}), [draftKey(s)]: list }
}

// 释放预览 blob: URL（移除或发送成功后调用，避免 blob 泄漏）。
function revokePreview(image) {
  if (image?.previewUrl) {
    try { URL.revokeObjectURL(image.previewUrl) } catch {}
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取失败'))
    reader.readAsDataURL(file)
  })
}

// base64 → blob: URL：查看器里用 img.src 指向 blob，base64 本身不进 DOM。
function base64BlobUrl(data, mediaType) {
  const binary = atob(String(data ?? ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mediaType || 'application/octet-stream' }))
}

// 选图入口：前端先按类型/大小/张数拦截，合规的读成 base64 进待发列表。
async function addPendingImages(files) {
  const current = pendingImagesFor()
  const { accepted, rejected } = validateImageSelection(files, current.length)
  for (const item of rejected) toast(`${item.name || '文件'}：${item.reason}`, 'error')
  const added = []
  for (const item of accepted) {
    try {
      const data = await readFileAsBase64(item.file)
      added.push({
        key: `img-${Date.now()}-${added.length}-${Math.random().toString(36).slice(2, 8)}`,
        name: item.name,
        mediaType: item.mediaType,
        bytes: item.bytes,
        data,
        previewUrl: URL.createObjectURL(item.file),
      })
    } catch {
      toast(`${item.name || '文件'}：读取失败`, 'error')
    }
  }
  if (added.length === 0) return
  setPendingImages([...current, ...added])
  renderKeepingChatScroll()
  document.getElementById('composer-input')?.focus()
}

function removePendingImage(key) {
  const current = pendingImagesFor()
  const target = current.find(item => item.key === key)
  revokePreview(target)
  setPendingImages(current.filter(item => item.key !== key))
  renderKeepingChatScroll()
}

function clearPendingImages() {
  for (const image of pendingImagesFor()) revokePreview(image)
  setPendingImages([])
}

// 「添加图片」按钮（群聊/单聊共用）：点开隐藏的 file input，读文件交给 change 事件。
function attachImageButton() {
  const full = pendingImagesFor().length >= MAX_IMAGES_PER_MESSAGE
  return `<button type="button" class="attach-btn" data-action="attach-image"${full ? ' disabled' : ''} title="添加图片（PNG / JPEG / GIF / WebP，单张 ≤5MB，一条最多 4 张）" aria-label="添加图片">${icon('image')}</button>`
}

// composer 的图片件：待发缩略图条（贴在输入框上方）+ 隐藏 file input（群聊/单聊共用）。
function composerImageStrip() {
  const pending = pendingImagesFor()
  if (pending.length === 0) return ''
  return `<div class="image-strip" id="image-strip">${pending.map(image => `
    <div class="image-thumb" data-image-key="${attr(image.key)}">
      <img class="image-thumb-img" src="${attr(image.previewUrl)}" alt="${attr(image.name || '待发送图片')}" />
      <button class="image-thumb-remove" data-action="remove-pending-image" data-image-key="${attr(image.key)}" title="移除这张图片" aria-label="移除图片 ${attr(image.name || '')}">${icon('close')}</button>
    </div>`).join('')}</div>`
}

// image-fallback:start —— 待发缩略图加载失败兜底（tests/chat-image-ui.test.js 抽取此块断言）
// CSP script-src 'self' 不允许内联 onerror 属性，兜底走 document 捕获阶段委托：
// 资源 error 事件不冒泡但一定经过捕获阶段。blob: URL 失效或被策略拦下时，
// 用「图标 + 文件名」占位替换破图，文件名走 textContent 不进 innerHTML。
function thumbnailFallback(name, iconHtml, doc = document) {
  const wrap = doc.createElement('div')
  wrap.className = 'image-thumb-fallback'
  const glyph = doc.createElement('span')
  glyph.className = 'image-thumb-fallback-icon'
  glyph.innerHTML = iconHtml
  const label = doc.createElement('span')
  label.className = 'image-thumb-fallback-name'
  label.textContent = String(name || '图片预览不可用')
  wrap.append(glyph, label)
  return wrap
}
// image-fallback:end

// composer-file-input:start —— body 级 file input 单例（tests/chat-image-ui.test.js 抽取此块断言）
// 选图的 <input> 不能进 renderShell：2.8s 轮询全量重建会换掉节点，用户在系统选框选完文件后
// change 落在已脱离 document 的旧节点上，document 级委托收不到（DSHBOTS-64 根因）。
// 挂在 body 上只建一次，任何重渲染都动不了它，change 始终能冒泡到委托层。
function ensureComposerImageInput(doc = document) {
  let el = doc.getElementById('composer-image-input')
  if (el) return el
  el = doc.createElement('input')
  el.id = 'composer-image-input'
  el.className = 'composer-image-input'
  el.type = 'file'
  el.accept = IMAGE_ACCEPT
  el.multiple = true
  el.hidden = true
  doc.body.appendChild(el)
  return el
}
// composer-file-input:end

// composer-paste:start —— 粘贴截图与文件路径（tests/paste-paths.test.js 抽取此块断言）
// 纯浏览器侧：不扫目录、不读文件系统、不加服务端接口；file:// 路径只来自用户自己复制进
// 剪贴板的内容（浏览器已经交给我们的那份），decodeURIComponent 还原后原样插入，缺失就明说。
// 从 text/uri-list 或 text/plain 文本里提取 file:// 绝对路径；uri-list 的 # 行是注释要跳过。
// 还原失败的形态（空串/无匹配）一律返回 []，不猜、不编造。
function parseFileUriList(text) {
  const raw = String(text ?? '')
  if (!raw) return []
  const out = []
  const seen = new Set()
  const push = uri => {
    const path = decodeURIComponent(uri.replace(/^file:\/\//, ''))
    if (path && !seen.has(path)) {
      seen.add(path)
      out.push(path)
    }
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^file:\/\/\S+$/.exec(trimmed)
    if (match) push(match[0])
  }
  if (out.length > 0) return out
  // uri-list 没给：退到 text/plain 里找内嵌的 file:// 片段（Chromium 复制文件时常见只有文件名）。
  for (const match of raw.matchAll(/file:\/\/[^\s"'<>]+/g)) push(match[0])
  return out
}

// 按 textarea 当前光标位置 splice 插入，不覆盖未选内容；插入后补派 input 事件，
// 否则 2.8s 轮询重渲染会用旧草稿（state）回滚掉刚插入的文本。
function insertTextAtCursor(input, insertText) {
  const value = String(input.value ?? '')
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start
  input.value = value.slice(0, start) + insertText + value.slice(end)
  const pos = start + insertText.length
  try { input.setSelectionRange(pos, pos) } catch {}
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
// composer-paste:end

// 消息附图块：缩略图 + 文件名/大小。缩略图 URL 走会话级缓存（hydrateMessageImageThumbs 渲染后补齐），
// 原图数据不进消息 HTML；点击行为不变，仍走 data-action 进全屏查看器。
const messageImageThumbUrls = new Map()
const messageImageThumbPending = new Map()

// 按 id 取原图并转 blob: URL：复用全屏查看器同一条取图 API 与转换函数，会话级缓存 + 并发去重，
// 同一张图只请求一次；轮询全量重建时命中缓存直接嵌模板，不重复请求。
function messageImageThumbUrl(imageId) {
  const cached = messageImageThumbUrls.get(imageId)
  if (cached) return Promise.resolve(cached)
  let pending = messageImageThumbPending.get(imageId)
  if (!pending) {
    pending = api('get_message_image', { imageId }, { quiet: true })
      .then(image => {
        const url = base64BlobUrl(image.data, image.mediaType)
        messageImageThumbUrls.set(imageId, url)
        return url
      })
      .finally(() => { messageImageThumbPending.delete(imageId) })
    messageImageThumbPending.set(imageId, pending)
  }
  return pending
}

function renderMessageImages(images) {
  const list = Array.isArray(images) ? images : []
  if (list.length === 0) return ''
  return `<div class="msg-images">${list.map(image => {
    const thumbUrl = messageImageThumbUrls.get(image.id) ?? ''
    return `
    <button type="button" class="msg-image-tile" data-action="view-message-image" data-image-id="${attr(image.id)}" title="${attr(image.name || '查看原图')}">
      ${thumbUrl
        ? `<img class="msg-image-thumb" src="${attr(thumbUrl)}" alt="${attr(image.name || '图片')}" />`
        : `<span class="msg-image-icon">${icon('image')}</span>`}
      <span class="msg-image-meta"><span class="msg-image-name">${esc(image.name || '图片')}</span><span class="msg-image-size">${esc(formatImageBytes(image.bytes))}</span></span>
    </button>`
  }).join('')}</div>`
}

// 渲染后补缩略图：模板已同步嵌缓存命中者，这里只处理未命中的瓦片——异步取图并原位替换图标占位；
// 取图失败保留占位（瓦片仍可点击，报错交给查看器路径兜底）。
async function hydrateMessageImageThumbs(root = document) {
  const tiles = Array.from(root.querySelectorAll('.msg-image-tile[data-image-id]'))
  await Promise.all(tiles.filter(tile => !tile.querySelector('.msg-image-thumb')).map(async tile => {
    const imageId = tile.dataset.imageId
    if (!imageId) return
    try {
      const url = await messageImageThumbUrl(imageId)
      if (!tile.isConnected || tile.querySelector('.msg-image-thumb')) return
      const img = document.createElement('img')
      img.className = 'msg-image-thumb'
      img.alt = tile.querySelector('.msg-image-name')?.textContent || '图片'
      img.src = url
      tile.querySelector('.msg-image-icon')?.replaceWith(img)
    } catch {}
  }))
}

// 原图查看器：按需取 base64 → blob: URL → img.src；关闭时释放 blob。
function ensureImageViewer() {
  let el = document.getElementById('image-viewer')
  if (el) return el
  el = document.createElement('div')
  el.className = 'image-viewer'
  el.id = 'image-viewer'
  el.hidden = true
  el.innerHTML = `<div class="image-viewer-backdrop" data-action="close-image-viewer"></div>
    <div class="image-viewer-panel" role="dialog" aria-modal="true" aria-label="图片预览">
      <div class="image-viewer-head">
        <strong id="image-viewer-name"></strong>
        <span class="faint" id="image-viewer-size"></span>
        <button type="button" class="image-viewer-close" data-action="close-image-viewer" title="关闭" aria-label="关闭图片预览">${icon('close')}</button>
      </div>
      <div class="image-viewer-body" id="image-viewer-body"></div>
    </div>`
  document.body.appendChild(el)
  return el
}

async function openMessageImage(imageId) {
  if (!imageId) return
  const viewer = ensureImageViewer()
  const body = document.getElementById('image-viewer-body')
  const nameEl = document.getElementById('image-viewer-name')
  const sizeEl = document.getElementById('image-viewer-size')
  viewer.hidden = false
  body.textContent = '图片加载中…'
  if (nameEl) nameEl.textContent = ''
  if (sizeEl) sizeEl.textContent = ''
  try {
    const image = await api('get_message_image', { imageId }, { quiet: true })
    if (nameEl) nameEl.textContent = image.name || '图片'
    if (sizeEl) sizeEl.textContent = formatImageBytes(image.bytes)
    body.textContent = ''
    const img = document.createElement('img')
    img.className = 'image-viewer-img'
    img.alt = image.name || '图片'
    img.src = base64BlobUrl(image.data, image.mediaType)
    body.appendChild(img)
  } catch (error) {
    body.textContent = error?.message || '图片加载失败'
  }
}

function closeImageViewer() {
  const viewer = document.getElementById('image-viewer')
  if (!viewer || viewer.hidden) return
  const img = viewer.querySelector('.image-viewer-img')
  if (img?.src) {
    try { URL.revokeObjectURL(img.src) } catch {}
    img.removeAttribute('src')
  }
  viewer.hidden = true
}

// 正文内嵌图（markdown 渲染的 <img>，file 路由/blob URL）点击放大：直接复用该 img 的现有 src，
// 不再拉原图数据；关闭链路复用 close-image-viewer——它只 revoke 查看器自建的 blob: URL，
// 对 file 路由 URL 是 no-op，正文里的原 img 不受影响。
function openInlineImage(img) {
  const src = img.currentSrc || img.getAttribute('src') || ''
  if (!src) return
  const viewer = ensureImageViewer()
  const body = document.getElementById('image-viewer-body')
  let name = img.getAttribute('alt')?.trim() || ''
  if (!name) {
    try {
      const url = new URL(src, location.href)
      name = url.searchParams.get('path')?.split('/').pop() ?? url.pathname.split('/').pop() ?? ''
    } catch { name = '' }
  }
  if (!name) name = '图片'
  document.getElementById('image-viewer-name').textContent = name
  document.getElementById('image-viewer-size').textContent = ''
  viewer.hidden = false
  body.textContent = ''
  const view = document.createElement('img')
  view.className = 'image-viewer-img'
  view.alt = name
  view.src = src
  body.appendChild(view)
}

// composer-resize:start —— 输入框高度合成的纯逻辑（tests/chat-ui.test.js 抽取此块断言）
// 自动长高上限沿用 150px；手动拖高的封顶 = 聊天面板高度 × 0.618（用户给定的黄金比数字）。
const COMPOSER_AUTO_MAX_PX = 150
const COMPOSER_PANEL_RATIO = 0.618
function composerCap(panelHeight) {
  return Math.max(1, Math.round(panelHeight * COMPOSER_PANEL_RATIO))
}
function composerHeightFor(autoHeight, manualHeight, capHeight) {
  // 手动高度是下限（拖高后不因内容变少回缩），内容超出手动高度仍可长高，两者都封顶在面板 61.8%。
  return Math.min(capHeight, Math.max(autoHeight, manualHeight ?? 0))
}
// composer-resize:end
function composerPanelCap(input) {
  const panel = input.closest('.chat-panel')
  return panel ? composerCap(panel.clientHeight) : COMPOSER_AUTO_MAX_PX
}
function applyComposerHeight(input) {
  input.style.height = 'auto'
  const auto = Math.min(COMPOSER_AUTO_MAX_PX, input.scrollHeight)
  input.style.height = `${composerHeightFor(auto, state.composerHeight, composerPanelCap(input))}px`
}

function syncComposerBox(input) {
  state.chatDrafts[draftKey(state)] = input.value
  applyComposerHeight(input)
  const button = document.querySelector('[data-action="send-message"]')
  if (button) button.disabled = input.value.trim() === '' && pendingImagesFor().length === 0
}

async function sendMessage() {
  const body = currentDraft(state).trim()
  const pending = pendingImagesFor()
  if (!body && pending.length === 0) return
  // 命令消息（/clear、/remember）后端不落图片：附件留不住，直接拦下并提示先移除。
  if (pending.length > 0 && (body === '/clear' || body.startsWith('/remember'))) {
    toast('该命令不支持附图，请先移除图片', 'error')
    return
  }
  // 待发图片随消息一起出站：mediaType + name + base64，字段口径与后端 normalizeImageInputs 一致。
  const images = pending.map(item => ({ mediaType: item.mediaType, name: item.name, data: item.data }))
  closeAutocomplete()
  try {
    let result
    if (state.chatMode === 'solo') {
      const bot = botById(state.soloBotId)
      if (!bot) return
      if (body === '/clear' && !window.confirm(`清空和 ${bot.name} 的全部对话记录？清除后不可恢复（记忆保留）。`)) return
      result = await api('send_solo_message', { botId: bot.id, body, ...(images.length ? { images } : {}) })
    } else {
      const project = activeProject()
      if (!project) return
      if (body === '/clear' && !window.confirm('清空本群全部聊天记录？清除后不可恢复（任务与记忆保留）。')) return
      // 引用回复：带上 replyTo；命令路径（/clear、/task、/remember）后端会忽略该参数。
      result = await api('send_message', { projectId: project.id, body, ...(state.replyTo ? { replyTo: state.replyTo.id } : {}), ...(images.length ? { images } : {}) })
    }
    state.chatDrafts[draftKey(state)] = ''
    state.replyTo = null
    state.chatAtBottom = true
    clearPendingImages()
    await loadState(state.projectId, { quiet: true })
    render()
    if (body === '/clear') toast(`已清空 ${result.cleared} 条消息`, 'success')
    if (result?.memory) toast('已写入 Bot 记忆', 'success')
    const input = document.getElementById('composer-input')
    input?.focus()
  } catch {}
}

async function saveTaskFromForm(taskId) {
  const form = document.getElementById('task-form')
  if (!form) throw new Error('保存失败，请重试。')
  const formData = new FormData(form)
  const assignee = formData.get('assigneeBotId')
  await api('update_task', {
    taskId,
    patch: {
      title: formData.get('title'),
      description: formData.get('description'),
      status: formData.get('status'),
      priority: formData.get('priority'),
      assigneeBotId: assignee || null,
      version: Number(formData.get('version')),
    },
  })
  return assignee || null
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
        const info = await api('dsh_update_info', {})
        toast(info.updateAvailable
          ? `当前 ${info.current}，可升级到 ${info.latest}`
          : `已是可用的最新版本 ${info.current}`, 'success')
        break
      }
      case 'upgrade-dsh': {
        if (!window.confirm('升级 DSH 会短暂中断服务。确认继续？')) break
        const info = await api('upgrade_dsh', {})
        if (info.upToDate) {
          toast(`当前 ${info.current} 已是可用的最新版本`, 'success')
          break
        }
        toast(`正在升级到 ${info.target}，服务将在约 1 秒后重启…`, 'success')
        setTimeout(() => location.reload(), 9000)
        break
      }
      case 'reboot-dsh': {
        if (!window.confirm('重启会短暂中断 DSH 和团队 Bot 运行。确认继续？')) break
        await api('reboot_dsh', {})
        toast('DSH 正在重启，页面将在完成后自动重载…', 'success')
        setTimeout(() => location.reload(), 7000)
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
        await refresh()
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
        state.modal = null
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
        // 群聊审批卡片按钮：allow/reject 后刷新状态表，卡片按新状态回显。
        const approvalId = target.dataset.approvalId
        const decision = target.dataset.decision
        if (!approvalId || !['allow', 'reject'].includes(decision)) break
        await api('approval_decide', { approvalId, decision })
        await loadState(state.projectId, { quiet: true })
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
        await loadState(state.projectId, { quiet: true })
        render()
        break
      }
      case 'copy': {
        const value = target.dataset.copy
        if (value) {
          await navigator.clipboard.writeText(value).catch(() => {})
          toast('已复制', 'success')
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
        state.modal = null
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
        state.modal = { type: 'remove-tracking', projectId: item.id, name: item.name, step: 1, purge: false }
        render()
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
        if (!window.confirm(`删除密钥 ${name}？各项目的 .team/secrets.env 会同步更新。`)) break
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
      state.modal = null
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
      state.modal = null
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
      state.modal = null
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
      state.modal = null
      await refresh()
      toast('已邀请加入项目', 'success')
      return
    }
    if (type === 'create-task') {
      // 父任务与依赖任务（DSHBOTS-58）：多选字段用 getAll 取全部选中项；空值即不建关系。
      const blockedBy = new FormData(form).getAll('blockedBy').map(String).filter(Boolean)
      const task = await api('create_task', {
        projectId: payload.projectId,
        title: payload.title,
        description: payload.description,
        assigneeBotId: payload.assigneeBotId || null,
        priority: payload.priority,
        parentTaskId: payload.parentTaskId || null,
        blockedBy,
        autoStart: form.querySelector('[name="autoStart"]')?.checked === true,
      })
      state.modal = null
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
      state.modal = null
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
      state.modal = null
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
      state.modal = null
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
      state.modal = null
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
  if (!state.data || state.modal || state.busy > 0 || document.hidden || isTyping()) return
  // 目录选择器开着或表单有未保存修改时暂停自动刷新：整页重渲染会吞掉选择器与已选/已填的值。
  if (document.querySelector('.dir-picker:not([hidden])') || document.querySelector('form[data-dirty]')) return
  try {
    await loadState(state.projectId, { quiet: true })
    render()
  } catch {}
}

async function init() {
  try {
    await loadState(state.projectId)
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

const observer = new MutationObserver(() => {
  if (state.modal?.type === 'proposal') bindProposalForm()
})
observer.observe(app, { childList: true, subtree: false })

setInterval(() => { void poll() }, 2800)
setInterval(() => {
  for (const el of document.querySelectorAll('.run-clock[data-started]')) {
    el.textContent = duration(el.dataset.started)
  }
}, 1000)
void init()

// DSHBOTS-15 批次3：IIFE 包裹已拆除（模块作用域等价于原 IIFE 私有作用域，模块天然 strict）。
// 以下导出仅供后续批次外迁的 ui/modules/*.js 反向依赖（调用期解析）；随各域搬出逐步收缩。
export { app, UI_SCALE_KEY, UI_THEME_KEY, savedScale, startWechatPoll, stopWechatPoll, startTerminalPoll, stopTerminalPoll, syncTerminalPoll, updateTerminalDom, bootError, isTyping, pendingProposals, tabDot, renderShell, syncChromeHeight, renderKeepingChatScroll, panelKey, isPanelOpen, panelOpenAttr }
export { applyPanelToggle, panelAttrs, lastRenderedView, captureViewScroll, restoreViewScroll, CHAT_BOTTOM_THRESHOLD, nextChatAtBottom, render, renderView, noProject, activeTypingRuns, typingRows, chatKey, mergedChatMessages, canLoadOlder, loadOlderButton, renderChatMembersCard, renderChat, DISPATCH_LIST_LIMIT, dispatchListNote }
export { dispatchTaskRow, dispatchRunRow, renderSoloChat, renderSoloConfig, APPROVAL_STATUS, renderApprovalCard, renderMessage, DM_STATUS, DM_STATUS_TONE, renderDirectMessagesCard, TASK_PRIORITY_WEIGHT, TASK_PRIORITY_DEFAULT, taskPriorityKey, taskPriorityWeight, compareTasksByPriority, sortTasksByPriority, TASK_SORTS, sortTasksForPanel, TASK_TIME_RANGES, taskEndsOutsideRange }
export { taskTerminalTime, filteredTasks, renderTasks, taskGroupKey, renderTaskGroup, taskStatusIcon, taskPriorityIcon, renderTaskCard, taskChildrenKey, taskParentId, renderTaskRows, terminalStatusPill, terminalOutputText, renderTerminal, renderBots, renderBotsOverview, renderMembers, renderSkills, memoryStatusTone, pendingMemoryCount }
export { renderMemory, currentSkillVersion, skillVersions, canaryText, evaluationText, proposalPreview, renderEvolution, usageSnapshot, usageTotals, formatAmount, usageCostParts, usageCostText, usageMode, usageViewTitle, usageBarRow, usageBotRow, usageRunRow, usageModelPanel, usageMetricCards, usageDayPanel, usageSection, usagePageHead, usageListPanel, renderUsage }
export { renderUsageGlobal, renderUsageDomain, renderUsageSolo, renderRunLimitsCard, renderOpsCard, renderWechatCard, renderSecretsCard, renderSettings, currentScale, renderGlobal, modalShell, modalLoading, renderModal, modelOptions, effortOptions, fallbackModelOptions, parseFallbackFields, modalNewProject, modalRemoveTracking, closeDirPicker }
export { modalInviteMember, modalBot, taskRelationOptions, modalNewTask, modalSkill, ARTIFACT_IMAGE, artifactFileUrl, runArtifacts, TRAJ_LABELS, trajectoryLabel, trajectoryEntry, modalTrajectory, modalTask, modalMemory, modalProposal, priceDefaults, defaultPriceFor, modalPrice, renderPriceCard, FOCUSABLE }
export { lastFocused, focusableItems, focusModal, restoreFocus, trapModalFocus, openModal, closeModal, bindProposalForm, updateEffortOptions, updateFallbackEffortOptions, formPayload, AC_COMMANDS, acWordChar, detectAcToken, buildAcItems, acSources, updateAutocomplete, renderAcPopup, moveAcSelection, closeAutocomplete }
export { applyAutocomplete, draftKey, currentDraft, IMAGE_MEDIA_TYPES, IMAGE_ACCEPT, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, IMAGE_EXT_TYPES, resolveImageMediaType, formatImageBytes, validateImageSelection, pendingImagesFor, setPendingImages, revokePreview, readFileAsBase64, base64BlobUrl, removePendingImage, clearPendingImages, attachImageButton, composerImageStrip }
export { thumbnailFallback, ensureComposerImageInput, parseFileUriList, insertTextAtCursor, renderMessageImages, messageImageThumbUrls, messageImageThumbPending, messageImageThumbUrl, hydrateMessageImageThumbs, ensureImageViewer, openInlineImage, closeImageViewer, COMPOSER_AUTO_MAX_PX, COMPOSER_PANEL_RATIO, composerCap, composerHeightFor, composerPanelCap, applyComposerHeight, syncComposerBox, draggedTask, observer }
