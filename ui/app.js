(() => {
  'use strict'

  const app = document.getElementById('app')
  const toastRoot = document.getElementById('toast-root')
  const params = new URLSearchParams(location.search)
  const initialView = params.get('view')
  const UI_SCALE_KEY = 'dshb:ui-scale'
  const UI_THEME_KEY = 'dshb:ui-theme'
  const state = {
    data: null,
    view: ['chat', 'tasks', 'bots', 'skills', 'memory', 'evolution', 'usage', 'settings', 'global'].includes(initialView) ? initialView : 'chat',
    projectId: params.get('project') || null,
    modal: null,
    draft: '',
    busy: 0,
    chatAtBottom: true,
    taskFilter: { status: 'all', assignee: 'all', search: '' },
    memoryFilter: 'all',
    usageScope: 'global',
    theme: 'dsh',
    tree: { chats: true, bots: true },
    bootError: null,
  }

  const STATUS = {
    backlog: '待规划',
    todo: '待执行',
    in_progress: '进行中',
    blocked: '受阻',
    in_review: '待验收',
    done: '已完成',
    canceled: '已取消',
  }
  const STATUS_ORDER = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled']
  const PRIORITY = { urgent: '紧急', high: '高', medium: '中', low: '低', none: '无' }
  const PROPOSAL_STATUS = { pending: '待审', approved: '已通过', rejected: '已拒绝' }
  const COLORS = ['teal', 'blue', 'violet', 'amber', 'coral', 'pink', 'green', 'gray']
  const COLOR_NAMES = { teal: '青', blue: '蓝', violet: '紫', amber: '琥珀', coral: '珊瑚', pink: '粉', green: '绿', gray: '灰' }
  const BOT_STATUS = { active: '运行中', paused: '已暂停', archived: '已归档' }
  const RUN_STATUS = { queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', canceled: '已取消' }
  const SKILL_STATUS = { active: '启用中', missing: '已失效' }
  const PROPOSAL_KIND = { bot_update: 'Bot 更新', skill: '技能更新', workflow: '流程更新' }
  const CREATOR_TYPE = { bot: 'Bot', user: '用户' }
  const EFFORT = { minimal: '最低', low: '低', medium: '中', high: '高', max: '最高' }
  // The one action in the top-right belongs to the page you are on.
  const VIEW_ACTION = {
    tasks: { label: '新建任务', action: 'new-task', icon: 'plus' },
    bots: { label: '新建 Bot', action: 'new-bot', icon: 'plus' },
    memory: { label: '写入记忆', action: 'new-memory', icon: 'plus' },
    skills: { label: '新建提案', action: 'new-proposal', icon: 'plus', kind: 'skill' },
    settings: { label: '保存设置', icon: 'check', submit: 'project-settings-form' },
  }
  const NAV = [
    ['chat', '群聊', 'message'],
    ['tasks', '任务', 'board'],
    ['bots', 'Bots', 'bot'],
    ['skills', '技能', 'spark'],
    ['memory', '记忆', 'memory'],
    ['evolution', '进化', 'branch'],
    ['usage', '用量', 'chart'],
    ['settings', '设置', 'settings'],
  ]

  const icons = {
    message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
    board: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>',
    bot: '<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6"/>',
    spark: '<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
    memory: '<path d="M9 4h6a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 10h4a6 6 0 0 0 6-2"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 9A7 7 0 0 1 18.7 7M17.9 15A7 7 0 0 1 5.3 17"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    alert: '<path d="M12 3 2 21h20z"/><path d="M12 9v5M12 18h.01"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
    terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  }

  const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.settings}</svg>`

  function applyUiScale(value) {
    const scale = Math.min(1.4, Math.max(1, Number(value) || 1))
    document.documentElement.style.setProperty('--ui-scale', String(scale))
    return scale
  }
  if (window.matchMedia?.('(max-width: 980px)').matches) state.tree = { chats: false, bots: false }
  const savedScale = (() => {
    try { return Number(localStorage.getItem(UI_SCALE_KEY)) || null } catch { return null }
  })()
  if (savedScale) applyUiScale(savedScale)
  function applyUiTheme(value) {
    const theme = value === 'catppuccin' ? 'catppuccin' : 'dsh'
    if (theme === 'dsh') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
    return theme
  }
  state.theme = applyUiTheme((() => {
    try { return localStorage.getItem(UI_THEME_KEY) } catch { return null }
  })())
  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  const attr = esc
  const pathCode = value => `<code>${esc(value).split('/').join('/<wbr>')}</code>`
  const costValue = value => {
    const text = formatCost(value)
    return /^[¥$€£]/.test(text) ? `<span class="unit">${esc(text[0])}</span>${esc(text.slice(1))}` : esc(text)
  }
  const clamp = (value, max, fallback = '') => String(value ?? fallback).slice(0, max)
  const botById = (id) => state.data?.bots.find(bot => bot.id === id)
  const taskById = (id) => state.data?.tasks.find(task => task.id === id)
  const activeProject = () => state.data?.project
  const activeBots = () => (state.data?.bots ?? []).filter(bot => bot.status === 'active')

  function formatNumber(value) {
    const n = Number(value ?? 0)
    if (!Number.isFinite(n)) return '0'
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}m`
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 1 : 2)}k`
    return String(Math.round(n))
  }
  const CURRENCY_SYMBOL = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', JPY: '¥' }
  function formatCost(value, currency = 'CNY') {
    if (value === null || value === undefined) return '未配置'
    const code = String(currency || 'CNY').toUpperCase()
    const symbol = CURRENCY_SYMBOL[code] ?? `${code} `
    if (value === 0) return `${symbol}0.00`
    if (value < 0.01) return `${symbol}${value.toFixed(4)}`
    return `${symbol}${value.toFixed(2)}`
  }
  function timeAgo(value) {
    if (!value) return '—'
    const ms = Date.now() - new Date(value).getTime()
    if (!Number.isFinite(ms)) return '—'
    if (ms < 45_000) return '刚刚'
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`
    if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)} 天前`
    return new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  }
  function formatTime(value) {
    if (!value) return ''
    return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }
  function duration(start, end) {
    if (!start) return '—'
    const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
    if (!Number.isFinite(ms) || ms < 0) return '—'
    if (ms < 1000) return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  }
  function initials(name) {
    const text = String(name ?? '?').trim()
    return /^[A-Za-z]/.test(text) ? text.slice(0, 2).toUpperCase() : text.slice(0, 2)
  }
  function avatar(bot, size = '') {
    return `<div class="avatar ${attr(bot?.color ?? 'gray')} ${size}">${esc(initials(bot?.name ?? '?'))}</div>`
  }
  function statusPill(status, text = STATUS[status] ?? status) {
    const tone = status === 'done' ? 'green' : status === 'blocked' || status === 'canceled' ? 'red' : status === 'in_review' ? 'violet' : status === 'in_progress' ? 'amber' : ''
    return `<span class="pill ${tone}">${esc(text)}</span>`
  }
  function runDot(status) {
    return `<span class="run-dot ${attr(status ?? '')}" title="${attr(RUN_STATUS[status] ?? '未运行')}"></span>`
  }
  function memorySource(source) {
    const value = String(source ?? '')
    if (!value) return '手动写入'
    if (value === 'chat-command') return '群聊指令'
    if (value.startsWith('run:')) return '运行沉淀'
    if (value.startsWith('session:')) return '会话沉淀'
    return '自动沉淀'
  }

  function richText(value) {
    let text = esc(value)
    const blocks = []
    text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      blocks.push(`<pre>${code.replace(/^\n|\n$/g, '')}</pre>`)
      return `@@CODE${blocks.length - 1}@@`
    })
    text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    const paragraphs = text.split(/\n{2,}/).map(part => `<p>${part.replace(/\n/g, '<br>')}</p>`).join('')
    return paragraphs.replace(/@@CODE(\d+)@@/g, (_, index) => blocks[Number(index)] ?? '')
  }

  function toast(message, type = '') {
    const el = document.createElement('div')
    el.className = `toast ${type}`
    el.textContent = message
    toastRoot.appendChild(el)
    setTimeout(() => {
      el.style.opacity = '0'
      el.style.transform = 'translateY(5px)'
      el.style.transition = 'opacity .2s, transform .2s'
      setTimeout(() => el.remove(), 220)
    }, 3600)
  }

  async function api(action, payload = {}, { quiet = false } = {}) {
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

  async function loadState(projectId = state.projectId, { quiet = false } = {}) {
    const data = await api('state', { projectId: projectId || undefined }, { quiet })
    state.data = data
    if (!state.projectId || !data.projects.some(project => project.id === state.projectId)) {
      state.projectId = data.project?.id ?? data.projects.find(project => project.status === 'active')?.id ?? null
    }
    return data
  }

  async function refresh({ quiet = false } = {}) {
    try {
      await loadState(state.projectId, { quiet })
      if (!state.modal) render()
    } catch (error) {
      if (!state.data) bootError(error)
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
    const project = activeProject()
    const pending = pendingProposals()
    const running = project?.stats?.running ?? 0
    const tokenTotal = data.usage?.scope?.project?.totalTokens ?? data.usage?.totalTokens ?? 0
    const isGlobal = state.view === 'global'
    const viewTitle = state.view === 'chat' ? (project?.name ?? '团队空间')
      : state.view === 'tasks' ? '任务面板'
      : state.view === 'bots' ? '团队 Bots'
      : state.view === 'skills' ? '共享技能池'
      : state.view === 'memory' ? '团队记忆'
      : state.view === 'evolution' ? '进化提案'
      : state.view === 'usage' ? '资源用量'
      : state.view === 'global' ? '全局配置'
      : '项目设置'
    const title = state.view === 'chat' ? (project?.name ?? '团队空间') : viewTitle
    const spec = VIEW_ACTION[state.view]
    const cardOwnsPrimary = state.view === 'evolution' && pendingProposals() > 0
    const primary = !project || !spec ? '' : spec.submit
      ? `<button class="btn primary" type="submit" form="${spec.submit}">${icon(spec.icon)}<span class="btn-label">${spec.label}</span></button>`
      : `<button class="btn ${cardOwnsPrimary ? '' : 'primary'}" data-action="${spec.action}"${spec.kind ? ` data-kind="${spec.kind}"` : ''}>${icon(spec.icon)}<span class="btn-label">${spec.label}</span></button>`
    const eyebrow = isGlobal
      ? ''
      : project
        ? `${project.key}<span class="sep"></span>${project.status === 'active' ? '进行中' : '已归档'}`
        : '未选择项目'
    const chats = data.projects
    const bots = data.bots ?? []
    const activeBots = bots.filter(bot => bot.status === 'active')
    const chevron = (open) => `<svg class="chev ${open ? 'open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`
    return `
      <div class="shell">
        <aside class="sidebar">
          <a class="brand" href="/" title="返回 DSH Web">
            <div class="brand-mark">DSH</div>
            <div class="brand-copy"><strong>DSH Team Bots</strong></div>
          </a>
          <div class="tree">
            <div class="tree-group">
              <div class="side-label">
                <button class="tree-toggle" data-action="toggle-tree" data-tree="chats" title="群聊 / 项目">${chevron(state.tree.chats)}<span>群聊</span></button>
                <span class="tree-count">${chats.length}</span>
                <button class="side-add" data-action="new-project" title="新建群聊 / 项目">${icon('plus')}</button>
              </div>
              ${state.tree.chats ? `<div class="tree-list">
                ${chats.length === 0 ? '<div class="side-empty">还没有群聊。</div>' : chats.map(item => `
                  <button class="tree-item chat-item ${item.id === project?.id && !isGlobal ? 'active' : ''}" data-action="select-project" data-project-id="${attr(item.id)}" title="${esc(item.name)}">
                    <span class="chat-hash">#</span>
                    <span class="tree-item-name">${esc(item.name)}</span>
                    ${item.status !== 'active' ? '<span class="tree-flag">已归档</span>' : ''}
                    ${Number(item.reviewTasks ?? 0) > 0 ? '<span class="red-dot" title="有任务待人工验收"></span>' : ''}
                    ${Number(item.openTasks ?? 0) > 0 ? `<span class="tree-open-count">${Number(item.openTasks)}</span>` : ''}
                  </button>
                `).join('')}
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
                  <button class="tree-item bot-item" data-action="edit-bot" data-bot-id="${attr(bot.id)}" title="${esc(bot.name)} · ${esc(bot.role || '成员')} · ${esc(bot.modelRef ?? '未配置模型')}">
                    <span class="avatar sm ${attr(bot.color ?? 'gray')}">${esc(initials(bot.name))}</span>
                    <span class="tree-item-name">${esc(bot.name)}</span>
                    ${bot.openTasks > 0 ? `<span class="tree-open-count">${bot.openTasks}</span>` : ''}
                    ${bot.status !== 'active' ? '<span class="tree-flag">已归档</span>' : ''}
                  </button>
                `).join('')}
              </div>` : ''}
            </div>
          </div>
          <div class="sidebar-bottom">
            <button class="global-config ${isGlobal ? 'active' : ''}" data-action="nav" data-view="global">
              ${icon('settings')}<span>全局配置</span>
            </button>
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
            ${isGlobal ? '' : `<div class="topbar-meta">
              <span><b>${project?.stats?.openTasks ?? 0}</b> 任务</span>
              <span class="sep"></span>
              <span><b>${running}</b> 运行中</span>
              <span class="sep"></span>
              <span><b>${formatNumber(tokenTotal)}</b> tokens</span>
            </div>`}
            <div class="topbar-actions">
              ${primary}
              <button class="btn icon" data-action="refresh" title="刷新" aria-label="刷新">${icon('refresh')}</button>
            </div>
          </header>
          ${isGlobal ? '' : `<div class="tabbar">
            ${NAV.map(([key, label]) => {
              const dot = tabDot(key)
              return `<button class="tab ${state.view === key ? 'active' : ''}" data-action="nav" data-view="${key}">${label}${dot ? '<span class="red-dot" title="有待人工处理事项"></span>' : ''}</button>`
            }).join('')}
          </div>`}
          </div>
          <section class="content">
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

  function render() {
    if (!state.data) return
    app.className = ''
    app.innerHTML = renderShell()
    requestAnimationFrame(() => {
      syncChromeHeight()
      if (state.view === 'chat') {
        const messages = document.querySelector('.chat-messages')
        if (messages && state.chatAtBottom) messages.scrollTop = messages.scrollHeight
      }
    })
  }

  function renderView() {
    const body = (() => {
      switch (state.view) {
        case 'tasks': return renderTasks()
        case 'bots': return renderBots()
        case 'skills': return renderSkills()
        case 'memory': return renderMemory()
        case 'evolution': return renderEvolution()
        case 'usage': return renderUsage()
        case 'settings': return renderSettings()
        case 'global': return renderGlobal()
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

  function renderChat() {
    const project = activeProject()
    if (!project) return noProject()
    const messages = state.data.messages ?? []
    const owner = botById(project.owner_bot_id)
    const members = project.members ?? []
    const open = (state.data.tasks ?? []).filter(task => !['done', 'canceled'].includes(task.status)).slice(0, 5)
    return `
      <div class="chat-layout">
        <div class="card chat-panel">
          <div class="chat-head">
            <div>
              <div class="chat-head-title"><span class="chat-hash">#</span>群聊</div>
              <div class="chat-head-meta"><span>负责人 ${esc(owner?.name ?? '未设置')}</span><span class="sep"></span><span>${members.length} 个成员</span></div>
            </div>
            <div class="member-stack">
              ${members.slice(0, 6).map(member => {
                const bot = botById(member.id)
                return bot ? avatar(bot, 'sm') : ''
              }).join('')}
            </div>
          </div>
          <div class="chat-messages">
            ${messages.length === 0 ? `<div class="chat-empty">
              <div class="empty-symbol">${icon('message')}</div>
              <h3>还没有人说话</h3>
              <p>直接发言会交给负责人 Bot；用 <strong>@Bot</strong> 点名成员，或输入 <strong>/task @Bot 任务标题</strong> 直接创建任务。</p>
            </div>` : messages.map(renderMessage).join('')}
          </div>
          <div class="composer">
            <div class="composer-box">
              <textarea id="composer-input" rows="2" placeholder="给团队发消息，或输入 /task @Bot 任务标题">${esc(state.draft)}</textarea>
              <div class="composer-bottom">
                <span class="composer-hint"><kbd>⌘</kbd><kbd>Enter</kbd> 发送</span>
                <button class="send-btn" data-action="send-message" ${state.draft.trim() ? '' : 'disabled'} title="发送" aria-label="发送消息">${icon('send')}</button>
              </div>
            </div>
          </div>
        </div>
        <aside class="chat-side">
          <div class="side-card">
            <div class="side-card-head"><h3>项目负责人</h3></div>
            ${owner ? `<div class="owner-row">
              ${avatar(owner, 'lg')}
              <div class="owner-info"><strong>${esc(owner.name)}</strong><span>${esc(owner.role || '项目负责人')} · ${esc(owner.model ?? '未配置模型')}</span></div>
            </div>` : '<div class="faint">未设置负责人</div>'}
          </div>
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
            </div>`}
          </div>
          <div class="side-card">
            <div class="side-card-head"><h3>项目成员</h3><span>${members.length}</span></div>
            <div class="side-list">
              ${members.map(member => {
                const bot = botById(member.id)
                if (!bot) return ''
                return `<div class="side-row">
                  ${avatar(bot, 'sm')}
                  <span class="side-row-title">${esc(bot.name)}</span>
                  <span class="faint">${member.member_role === 'owner' ? '负责人' : esc(bot.role || '成员')}</span>
                </div>`
              }).join('')}
            </div>
          </div>
          <div class="side-card">
            <div class="side-card-head"><h3>工作区</h3></div>
            <div class="path-row">${pathCode(project.workspace_path)}<button class="btn icon small" data-action="copy" data-copy="${attr(project.workspace_path)}" title="复制路径" aria-label="复制路径">${icon('copy')}</button></div>
          </div>
        </aside>
      </div>`
  }

  function renderMessage(message) {
    if (message.sender_type === 'system') {
      return `<div class="message-system">
        <span>${esc(message.body)}</span>
        ${message.taskIdentifier ? `<div class="task-chip-line center"><button class="task-chip" data-action="open-task" data-task-id="${attr(message.task_id)}"><strong>${esc(message.taskIdentifier)}</strong>${esc(message.taskTitle ?? '')}</button></div>` : ''}
      </div>`
    }
    const isUser = message.sender_type === 'user'
    const bot = isUser ? null : botById(message.sender_id)
    return `<div class="message-row ${isUser ? 'user' : ''}">
      ${isUser ? '' : avatar(bot ?? { name: message.senderName, color: 'gray' })}
      <div class="message-body-wrap">
        <div class="message-meta"><strong>${esc(message.senderName)}</strong><span>${esc(formatTime(message.created_at))}</span></div>
        <div class="message-bubble">${richText(message.body)}</div>
        ${message.taskIdentifier ? `<div class="task-chip-line"><button class="task-chip" data-action="open-task" data-task-id="${attr(message.task_id)}"><strong>${esc(message.taskIdentifier)}</strong>${esc(message.taskTitle ?? '')}</button></div>` : ''}
      </div>
    </div>`
  }

  function filteredTasks() {
    const filter = state.taskFilter
    return (state.data?.tasks ?? []).filter(task => {
      if (filter.status !== 'all' && task.status !== filter.status) return false
      if (filter.assignee !== 'all' && task.assignee_bot_id !== filter.assignee) return false
      if (filter.search) {
        const haystack = `${task.identifier} ${task.title} ${task.description} ${task.labels?.join(' ') ?? ''}`.toLowerCase()
        if (!haystack.includes(filter.search.toLowerCase())) return false
      }
      return true
    })
  }

  function renderTasks() {
    const project = activeProject()
    if (!project) return noProject()
    const tasks = filteredTasks()
    const members = project.members ?? []
    const filtering = Boolean(state.taskFilter.search) || state.taskFilter.status !== 'all' || state.taskFilter.assignee !== 'all'
    return `
      <div class="section-head">
        <p>拖拽卡片切换状态。</p>
        <div class="board-toolbar" style="margin:0">
          <input class="input search" id="task-search" placeholder="搜索任务、编号或标签" value="${attr(state.taskFilter.search)}">
          <select class="select" data-task-filter="status">
            <option value="all">全部状态</option>
            ${STATUS_ORDER.map(status => `<option value="${status}" ${state.taskFilter.status === status ? 'selected' : ''}>${STATUS[status]}</option>`).join('')}
          </select>
          <select class="select" data-task-filter="assignee">
            <option value="all">全部成员</option>
            ${members.map(member => `<option value="${attr(member.id)}" ${state.taskFilter.assignee === member.id ? 'selected' : ''}>${esc(member.name)}</option>`).join('')}
          </select>
          <span class="tag">${tasks.length} 个任务</span>
        </div>
      </div>
      ${tasks.length === 0 ? `<div class="empty-state">
        <div class="empty-symbol">${icon('board')}</div>
        <h3>${filtering ? '没有匹配的任务' : '任务面板还是空的'}</h3>
        <button class="btn" data-action="new-task">${icon('plus')}新建任务</button>
      </div>` : `<div class="board">
        ${STATUS_ORDER.map(status => {
          const column = tasks.filter(task => task.status === status)
          return `<div class="column" data-drop-status="${status}">
            <div class="column-head"><strong>${STATUS[status]}</strong><span class="column-count">${column.length}</span></div>
            ${column.map(renderTaskCard).join('')}
            ${column.length === 0 ? `<div class="board-empty">拖到这里</div>` : ''}
          </div>`
        }).join('')}
      </div>`}
    `
  }

  function renderTaskCard(task) {
    const bot = botById(task.assignee_bot_id)
    const run = task.latestRun
    const runLabel = run ? ({
      running: '运行中',
      failed: '失败',
      queued: '排队',
      succeeded: '已完成',
      canceled: '已取消',
    }[run.status] ?? '') : ''
    const tags = []
    if (task.status === 'in_review') tags.push(task.review_target === 'owner_bot' ? '负责人验收中' : '待您验收')
    for (const label of task.labels ?? []) tags.push(label)
    const isRunning = run?.status === 'running'
    return `<article class="task-card${isRunning ? ' running' : ''}" draggable="true" data-task-id="${attr(task.id)}" data-action="open-task">
      <div class="task-card-top">
        <span class="task-id">${esc(task.identifier)}</span>
        <span class="task-priority">${esc(PRIORITY[task.priority] ?? task.priority)}</span>
      </div>
      <div class="task-card-title">${esc(task.title)}</div>
      ${tags.length ? `<div class="task-tags">${tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}</div>` : ''}
      <div class="task-card-foot">
        ${run ? runDot(run.status) : ''}
        <span>${runLabel}</span>
        ${isRunning ? `<span class="run-clock" data-started="${attr(run.started_at ?? '')}">${duration(run.started_at)}</span>` : ''}
        ${bot ? avatar(bot, 'sm') : '<span class="faint">未指派</span>'}
      </div>
    </article>`
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
            ${bot.status === 'active' ? `<button class="btn small" data-action="archive-bot" data-bot-id="${attr(bot.id)}">归档</button>` : ''}
          </div>
        </article>`).join('')}
      </div>`}
    `
  }

  function renderSkills() {
    const skills = state.data?.skills ?? []
    const proposals = (state.data?.proposals ?? []).filter(item => item.kind === 'skill' && item.status === 'pending')
    return `
      <div class="section-head">
        <p>技能变更走提案和审批，不直接覆盖。</p>
        <div class="btn-row">
          <button class="btn" data-action="sync-skills">${icon('refresh')}重新扫描</button>
        </div>
      </div>
      <div class="path-row plain" style="margin-bottom:14px"><span>技能根目录</span><code>${esc(state.data.paths.skillRoot)}/skills</code><button class="btn icon small" data-action="copy" data-copy="${attr(state.data.paths.skillRoot + '/skills')}">${icon('copy')}</button></div>
      <div class="card list-card">
        ${skills.length === 0 ? `<div class="empty-state" style="border:0"><div class="empty-symbol">${icon('spark')}</div><h3>技能池为空</h3><p>在技能根目录放置技能文件，或提交一个技能提案并审批。</p></div>` : skills.map(skill => `
          <div class="list-row skill-row">
            <div class="empty-symbol" style="width:30px;height:30px;border-radius:9px;margin:0">${icon('spark')}</div>
            <div class="list-main">
              <div class="list-title"><span class="skill-slug">${esc(skill.slug)}</span><span class="faint mono">v${esc(skill.version)}</span><span class="pill ${skill.status === 'active' ? 'green' : 'red'}">${esc(SKILL_STATUS[skill.status] ?? skill.status)}</span></div>
              <div class="list-desc">${esc(skill.description || '无描述')}</div>
              <div class="list-meta"><span>${esc(skill.relativePath)}</span></div>
            </div>
          </div>
        `).join('')}
      </div>
      ${proposals.length ? `<div class="card-head" style="margin-top:24px"><h3>待审批技能提案</h3></div>
      <div class="grid">
        ${proposals.map(item => `<div class="card proposal-card">
          <div class="proposal-head"><div class="empty-symbol" style="width:30px;height:30px;border-radius:9px;margin:0">${icon('spark')}</div><div><h3>${esc(item.title)}</h3><p>${esc(item.rationale)}</p></div></div>
          <div class="proposal-actions"><span class="pill">待审</span><button class="btn small" data-action="decide-proposal" data-proposal-id="${attr(item.id)}" data-decision="approved">${icon('check')}通过</button><button class="btn small" data-action="decide-proposal" data-proposal-id="${attr(item.id)}" data-decision="rejected">拒绝</button></div>
        </div>`).join('')}
      </div>` : ''}
    `
  }

  function renderMemory() {
    const project = activeProject()
    const memories = (state.data?.memories ?? []).filter(memory => state.memoryFilter === 'all' || memory.scope_type === state.memoryFilter)
    return `
      <div class="board-toolbar">
        <select class="select" id="memory-filter">
          <option value="all" ${state.memoryFilter === 'all' ? 'selected' : ''}>全部作用域</option>
          <option value="project" ${state.memoryFilter === 'project' ? 'selected' : ''}>项目记忆</option>
          <option value="bot" ${state.memoryFilter === 'bot' ? 'selected' : ''}>Bot 记忆</option>
        </select>
        <span class="tag" style="margin-left:auto">${memories.length} 条</span>
      </div>
      ${!project ? noProject() : memories.length === 0 ? `<div class="empty-state"><div class="empty-symbol">${icon('memory')}</div><h3>还没有记忆</h3><p>任务完成后会自动沉淀交付经验。</p><button class="btn" data-action="new-memory">${icon('plus')}写入记忆</button></div>` : `<div class="grid">
        ${memories.map(memory => {
          const scopeName = memory.scope_type === 'project' ? '项目' : (botById(memory.scope_id)?.name ?? 'Bot')
          return `<article class="card list-card">
            <div class="list-row">
              <div class="list-main">
                <div class="card-head">
                  <div class="list-title">${esc(memory.topic)}</div>
                  <div class="btn-row">
                    <span class="pill">${esc(scopeName)}</span>
                    <button class="btn icon" data-action="edit-memory" data-memory-id="${attr(memory.id)}" title="编辑记忆" aria-label="编辑记忆">${icon('edit')}</button>
                    <button class="btn icon" data-action="delete-memory" data-memory-id="${attr(memory.id)}" title="删除记忆" aria-label="删除记忆">${icon('trash')}</button>
                  </div>
                </div>
                <div class="list-desc">${esc(memory.content)}</div>
                <div class="list-meta" style="justify-content:space-between">
                  <span>${esc(memorySource(memory.source))}</span>
                  <span>${esc(timeAgo(memory.updated_at))} · 置信度 ${Number(memory.confidence).toFixed(2)}</span>
                </div>
              </div>
            </div>
          </article>`
        }).join('')}
      </div>`}
    `
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
    const pending = proposals.filter(item => item.status === 'pending')
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
    return `
      <div class="section-head">
        <p>变更需经人工审批后生效。</p>
        <div class="btn-row">
          ${pending.length ? `<span class="pill">${pending.length} 个待审批</span>` : ''}
          <button class="btn" data-action="new-proposal" data-kind="bot_update">${icon('plus')}新建提案</button>
        </div>
      </div>
      ${proposals.length === 0 ? `<div class="empty-state"><div class="empty-symbol">${icon('branch')}</div><h3>还没有进化提案</h3><p>Bot 可以提交自我改进建议，但无法自行批准。</p><button class="btn" data-action="new-proposal" data-kind="bot_update">${icon('plus')}新建提案</button></div>` : `<div class="grid" style="gap:16px">
        ${proposals.map(proposal => {
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
            <div class="proposal-body" style="margin-top:0">${esc(proposalPreview(proposal).slice(0, 6000))}</div>
            <div class="list-meta"><span>${esc(PROPOSAL_KIND[proposal.kind] ?? proposal.kind)}</span>${proposal.botName ? `<span>${esc(proposal.botName)}</span>` : ''}<span>${esc(timeAgo(proposal.created_at))}</span>${proposal.decided_by ? `<span>由 ${esc(proposal.decided_by)} 决定</span>` : ''}</div>
            ${proposal.evaluation ? `<div class="list-desc">评估 · ${esc(proposal.evaluation)}</div>` : ''}
            ${proposal.status === 'pending' ? `<details class="proposal-diff">
              <summary class="btn small">${icon('chevron', 'chev')}查看差异</summary>
              <div class="proposal-body" style="margin-top:8px">${esc(proposalDiff(proposal).slice(0, 4000))}</div>
            </details>
            <div class="proposal-actions end">
              <button class="btn ${proposal.id === pending[0]?.id ? 'primary' : ''}" data-action="decide-proposal" data-proposal-id="${attr(proposal.id)}" data-decision="approved">${icon('check')}通过并应用</button>
              <button class="btn" data-action="decide-proposal" data-proposal-id="${attr(proposal.id)}" data-decision="rejected">拒绝</button>
            </div>` : ''}
          </article>`
        }).join('')}
      </div>`}
    `
  }

  function usageScopeData() {
    if (state.usageScope === 'project' && state.data?.usage?.scope?.project) return state.data.usage.scope.project
    return state.data?.usage?.scope?.global ?? state.data?.usage ?? {}
  }

  function renderUsage() {
    const usage = state.data?.usage ?? {}
    const scope = usageScopeData()
    const byBot = usage.byBot ?? []
    const byProject = usage.byProject ?? []
    const byModel = usage.byModel ?? []
    const maxBot = Math.max(1, ...byBot.map(item => item.totalTokens))
    const maxProject = Math.max(1, ...byProject.map(item => item.totalTokens))
    const maxModel = Math.max(1, ...byModel.map(item => item.totalTokens))
    const days = usage.byDay ?? []
    const maxDay = Math.max(1, ...days.map(item => item.totalTokens))
    const usingProject = state.usageScope === 'project' && activeProject()
    const barList = (rows, key, max) => rows.map(item => `<div class="bar-row"><span class="bar-label">${esc(item[key])}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, item.totalTokens / max * 100)}%"></span></span><span class="bar-value">${formatNumber(item.totalTokens)}</span></div>`).join('')
    return `
      <div class="section-head">
        <div class="seg">
          <button data-action="usage-scope" data-scope="global" aria-pressed="${state.usageScope === 'global'}">全局</button>
          <button data-action="usage-scope" data-scope="project" aria-pressed="${state.usageScope === 'project'}" ${activeProject() ? '' : 'disabled'}>本项目</button>
        </div>
      </div>
      <div class="metric-grid">
        <div class="card metric">
          <span class="metric-label">总 tokens（${usingProject ? '项目' : '全局'}）</span>
          <strong>${formatNumber(scope.totalTokens)}</strong>
          <small class="mono">${formatNumber(scope.inputTokens)} 输入 · ${formatNumber(scope.outputTokens)} 输出</small>
        </div>
        <div class="card metric">
          <span class="metric-label">模型调用</span>
          <strong>${formatNumber(scope.calls)}</strong>
          <small class="mono">缓存读 ${formatNumber(scope.cacheReadTokens)}</small>
        </div>
        <div class="card metric">
          <span class="metric-label">成本</span>
          <strong>${costValue(scope.cost)}</strong>
          <small class="mono">${usage.priceCount ? `${usage.priceCount} 条价格规则` : '尚未配置模型价格'}</small>
        </div>
        <div class="card metric">
          <span class="metric-label">统计窗口</span>
          <strong>${usage.days ?? 30}d</strong>
          <small class="mono">${usingProject ? '本项目' : '全局'} · 按调用时间归集</small>
        </div>
      </div>
      <div class="usage-grid">
        <div class="card usage-panel">
          <div class="card-head"><h3>按 Bot</h3></div>
          ${byBot.length === 0 ? '<div class="faint">暂无调用记录。</div>' : `<div class="bar-list">${barList(byBot, 'name', maxBot)}</div>`}
        </div>
        <div class="card usage-panel">
          <div class="card-head"><h3>${usingProject ? '按模型' : '按项目'}</h3></div>
          ${usingProject ? (byModel.length === 0 ? '<div class="faint">暂无调用记录。</div>' : `<div class="bar-list">${barList(byModel, 'model', maxModel)}</div>`)
            : (byProject.length === 0 ? '<div class="faint">暂无调用记录。</div>' : `<div class="bar-list">${barList(byProject, 'name', maxProject)}</div>`)}
        </div>
      </div>
      <div class="usage-grid" style="margin-top:12px">
        <div class="card usage-panel">
          <div class="card-head"><h3>近 14 天</h3></div>
          ${days.length === 0 ? '<div class="faint">暂无按日数据。</div>' : `<div class="day-bars">${days.map(day => `<div class="day-bar${day.totalTokens ? '' : ' zero'}" style="height:${Math.max(3, day.totalTokens / maxDay * 100)}%" title="${esc(day.day)} · ${formatNumber(day.totalTokens)} tokens"></div>`).join('')}</div><div class="day-axis">${days.map((day, index) => `<span title="${esc(day.day)} · ${formatNumber(day.totalTokens)} tokens">${index === 0 || index === days.length - 1 || index % 3 === 0 ? esc(String(day.day).slice(5).replace('-', '/')) : ''}</span>`).join('')}</div>`}
        </div>
        <div class="card usage-panel">
          <div class="card-head"><h3>模型明细</h3><button class="btn small" data-action="new-price">设置价格</button></div>
          ${byModel.length === 0 ? '<div class="faint">暂无数据。</div>' : `<table class="usage-table"><thead><tr><th class="eyebrow mono">模型</th><th class="eyebrow mono num">调用</th><th class="eyebrow mono num">tokens</th><th class="eyebrow mono">成本</th></tr></thead><tbody>${byModel.map(item => `<tr><td>${esc(item.model)}</td><td class="mono num">${formatNumber(item.calls)}</td><td class="mono num">${formatNumber(item.totalTokens)}</td><td class="mono">${formatCost(item.cost)}</td></tr>`).join('')}</tbody></table>`}
          <div class="usage-note">未配置价格时成本显示“未配置”，不会按 0 计费。价格按每百万 token 配置。</div>
        </div>
      </div>
    `
  }

  function renderSettings() {
    const project = activeProject()
    const paths = state.data.paths ?? {}
    const copyPath = value => `<button class="btn icon small" type="button" data-action="copy" data-copy="${attr(value)}" title="复制路径" aria-label="复制路径">${icon('copy')}</button>`
    if (!project) return `${noProject()}
      <div class="card form-card" style="margin-top:14px">
        <div class="card-head"><h3>系统路径</h3></div>
        <div class="path-row"><span>工作区</span>${pathCode(paths.workspace ?? '')}${copyPath(paths.workspace ?? '')}</div>
        <div class="path-row"><span>共享</span>${pathCode(paths.skillRoot ?? '')}${copyPath(paths.skillRoot ?? '')}</div>
        <div class="path-row"><span>数据</span>${pathCode(paths.dataDir ?? '')}${copyPath(paths.dataDir ?? '')}</div>
      </div>`
    const members = activeBots()
    const owner = botById(project.owner_bot_id)
    const memberIds = new Set(project.members.map(member => member.id))
    return `
      <form id="project-settings-form" data-form="save-project">
        <div class="settings-grid">
          <div>
            <div class="card form-card">
              <div class="card-head"><h3>项目资料</h3><span class="meta">${esc(project.key ?? project.id)}</span></div>
              <input type="hidden" name="projectId" value="${attr(project.id)}">
              <div class="field"><label>项目名称</label><input class="input" name="name" value="${attr(project.name)}" maxlength="80"></div>
              <div class="field"><label>项目描述</label><textarea class="textarea" name="description">${esc(project.description || '')}</textarea></div>
              <div class="field-row">
                <div class="field"><label>负责人 Bot</label><select class="select" name="ownerBotId">${members.map(bot => `<option value="${attr(bot.id)}" ${bot.id === project.owner_bot_id ? 'selected' : ''}>${esc(bot.name)}</option>`).join('')}</select></div>
                <div class="field"><label>群聊回复模式</label><select class="select" name="replyMode"><option value="owner_first" ${project.group?.reply_mode !== 'everyone' ? 'selected' : ''}>负责人优先</option><option value="everyone" ${project.group?.reply_mode === 'everyone' ? 'selected' : ''}>全员响应</option></select></div>
              </div>
            </div>
            <div class="card form-card" style="margin-top:12px">
              <div class="card-head"><h3>项目成员</h3><span class="meta">${project.members.length} 位</span></div>
              <div class="check-list">${members.map(bot => `<div class="check-row"><input type="checkbox" id="member-${attr(bot.id)}" name="memberIds" value="${attr(bot.id)}" ${memberIds.has(bot.id) ? 'checked' : ''} ${bot.id === project.owner_bot_id ? 'disabled' : ''}>${avatar(bot, 'sm')}<label for="member-${attr(bot.id)}">${esc(bot.name)}</label><span class="role">${esc(bot.role || '')}</span></div>`).join('')}</div>
              <div class="hint">负责人始终是成员，取消勾选即可调整其他成员的参与范围。</div>
            </div>
            <div class="card form-card" style="margin-top:12px">
              <div class="card-head"><h3>月度预算</h3></div>
              <div class="field-row">
                <div class="field"><label>Token 预算</label><input class="input mono" style="text-align:right" type="number" min="0" name="tokenBudget" value="${project.token_budget ?? ''}" placeholder="不限制"></div>
                <div class="field"><label>成本预算 (USD)</label><input class="input mono" style="text-align:right" type="number" min="0" step="0.01" name="costBudget" value="${project.cost_budget ?? ''}" placeholder="不限制"></div>
              </div>
              <div class="hint">超出预算时项目会提示预算已用尽。</div>
            </div>
          </div>
          <div>
            <div class="card form-card">
              <div class="card-head"><h3>工作区路径</h3></div>
              <div class="path-row"><span>工作区</span>${pathCode(project.workspace_path)}${copyPath(project.workspace_path)}</div>
              <div class="path-row"><span>共享</span>${pathCode(paths.skillRoot ?? '')}${copyPath(paths.skillRoot ?? '')}</div>
              <div class="path-row"><span>数据</span>${pathCode(paths.dataDir ?? '')}${copyPath(paths.dataDir ?? '')}</div>
            </div>
            <div class="card form-card" style="margin-top:12px">
              <div class="card-head"><h3>项目状态</h3>${project.status === 'active' ? '<span class="pill green">运行中</span>' : '<span class="pill amber">已归档</span>'}</div>
              <div class="kv"><span>负责人</span><strong>${esc(owner?.name ?? '未设置')}</strong></div>
              <div class="kv"><span>任务总数</span><strong>${project.stats.tasks}</strong></div>
              <div class="kv"><span>运行总数</span><strong>${project.stats.runs}</strong></div>
              ${project.status === 'active' ? `<div class="btn-row" style="margin-top:12px"><button class="btn small" type="button" data-action="archive-project" data-project-id="${attr(project.id)}">归档项目</button></div>` : ''}
            </div>
            <div class="card form-card" style="margin-top:12px">
              <div class="card-head"><h3>团队信息</h3></div>
              <div class="kv"><span>Bot 数量</span><strong>${state.data.bots.length}</strong></div>
              <div class="kv"><span>项目数量</span><strong>${state.data.projects.length}</strong></div>
              <div class="kv"><span>共享技能</span><strong>${state.data.skills.length}</strong></div>
              <div class="kv"><span>待审提案</span><strong>${state.data.proposals.filter(item => item.status === 'pending').length}</strong></div>
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
            <label>界面字号 <span class="mono" id="ui-scale-value">${Math.round(scale * 100)}%</span></label>
            <input type="range" id="ui-scale" class="range" min="1" max="1.4" step="0.05" value="${scale}">
            <div class="scale-row">
              <span class="faint">小</span>
              <span class="faint" style="margin-left:auto">大</span>
            </div>
          </div>
          <div class="field">
            <label>配色</label>
            <div class="seg" role="group" aria-label="配色">
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
      ${renderPriceCard()}
    `
  }

  function modalShell({ title, subtitle = '', body = '', footer = '', size = '', badge = '' }) {
    return `<div class="modal-backdrop" data-action="modal-backdrop">
      <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${attr(title)}">
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
      case 'new-bot': return modalBot(null)
      case 'edit-bot': return modalBot(modal.detail)
      case 'new-task': return modalNewTask()
      case 'task': return modalTask(modal.detail)
      case 'memory': return modalMemory(modal.memory)
      case 'proposal': return modalProposal(modal.kind)
      case 'price': return modalPrice(modal.price ?? {})
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

  function modalNewProject() {
    const bots = activeBots()
    return modalShell({
      title: '新建项目空间',
      badge: '',
      body: `<form data-form="create-project" id="modal-form">
        <div class="field"><label>项目名称</label><input class="input" style="width:100%" name="name" placeholder="例如：官网重构" required maxlength="80" autofocus></div>
        <div class="field-row">
          <div class="field"><label>项目 Key</label><input class="input mono" style="width:100%" name="key" placeholder="WEB" maxlength="10" pattern="[A-Za-z][A-Za-z0-9]{0,9}"><div class="hint">任务的编号前缀。</div></div>
          <div class="field"><label>负责人 Bot</label><select class="select" style="width:100%" name="ownerBotId">${bots.map(bot => `<option value="${attr(bot.id)}">${esc(bot.name)} · ${esc(bot.role || '成员')}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>项目说明</label><textarea class="textarea" name="description" placeholder="项目目标、边界和验收标准"></textarea></div>
        ${bots.length > 1 ? `<div class="field"><label>其他成员</label><div class="check-list">${bots.slice(1).map(bot => `<label class="check-row"><input type="checkbox" name="memberIds" value="${attr(bot.id)}"> ${avatar(bot, 'sm')} ${esc(bot.name)} <span class="role">${esc(bot.role || '')}</span></label>`).join('')}</div></div>` : ''}
      </form>`,
      footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${icon('plus')}创建项目</button>`,
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
            <div class="field"><label>名称</label><input class="input" style="width:100%" name="name" value="${attr(bot?.name ?? '')}" placeholder="例如：Builder" required maxlength="24"></div>
            <div class="field"><label>角色标签</label><input class="input" style="width:100%" name="role" value="${attr(bot?.role ?? '')}" placeholder="例如：开发" maxlength="24"></div>
          </div>
          <div class="field-row">
            <div class="field"><label>模型</label><select class="select" style="width:100%" name="modelRef" data-model-select>${modelOptions(bot?.provider, bot?.model)}</select></div>
            <div class="field"><label>推理强度</label><select class="select" style="width:100%" name="effort" data-effort-select>${effortOptions(modelRef, bot?.effort)}</select></div>
          </div>
          <div class="field"><label>外观颜色</label><select class="select" style="width:100%" name="color">${COLORS.map(color => `<option value="${color}" ${bot?.color === color ? 'selected' : ''}>${COLOR_NAMES[color] ?? color}</option>`).join('')}</select></div>
          <div class="field"><label>角色指令</label><textarea class="textarea" name="instructions" rows="10" placeholder="说明职责、工作方式、边界和交付标准">${esc(bot?.instructions ?? '')}</textarea></div>
          ${bot ? `<div class="btn-row"><button class="btn small" type="button" data-action="archive-bot" data-bot-id="${attr(bot.id)}">归档 Bot</button></div>` : ''}
        </form>
        ${bot ? `<aside class="task-detail-side">
          <div class="eyebrow" style="margin-bottom:9px">版本历史</div>
          ${(detail.revisions ?? []).map(revision => `<div class="revision-row"><span class="mono">v${revision.version}</span><span class="faint">${esc(timeAgo(revision.created_at))}</span><button class="btn small" data-action="rollback-bot" data-bot-id="${attr(bot.id)}" data-revision-id="${attr(revision.id)}" ${revision.version === bot.current_revision ? 'disabled' : ''}>回滚</button></div>`).join('') || '<div class="faint">暂无版本</div>'}
          <div class="divider"></div>
          <div class="kv"><span>运行次数</span><strong>${bot.stats.runs}</strong></div>
          <div class="kv"><span>成功 / 失败</span><strong>${bot.stats.succeeded} / ${bot.stats.failed}</strong></div>
          <div class="kv"><span>长期记忆</span><strong>${bot.memoryCount}</strong></div>
          <div class="kv"><span>状态</span><strong>${esc(BOT_STATUS[bot.status] ?? bot.status)}</strong></div>
          <div class="usage-note">模型或强度变更会在下一次运行时生效，不会中断当前运行。</div>
        </aside>` : ''}
      </div>`,
      footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${icon('check')}${bot ? '保存新版本' : '创建 Bot'}</button>`,
    })
  }

  function modalNewTask() {
    const project = activeProject()
    if (!project) return ''
    return modalShell({
      title: '新建任务',
      subtitle: `${project.key} · ${project.name}`,
      badge: '',
      body: `<form data-form="create-task" id="modal-form">
        <input type="hidden" name="projectId" value="${attr(project.id)}">
        <div class="field"><label>标题</label><input class="input" style="width:100%" name="title" required maxlength="240" placeholder="一个可执行、可验收的结果" autofocus></div>
        <div class="field"><label>描述</label><textarea class="textarea" name="description" rows="8" placeholder="背景、范围、约束、验收标准"></textarea></div>
        <div class="field-row">
          <div class="field"><label>指派给</label><select class="select" style="width:100%" name="assigneeBotId">${project.members.map(member => `<option value="${attr(member.id)}">${esc(member.name)} · ${esc(member.bot_role || '')}</option>`).join('')}</select></div>
          <div class="field"><label>优先级</label><select class="select" style="width:100%" name="priority"><option value="medium">中</option><option value="high">高</option><option value="urgent">紧急</option><option value="low">低</option><option value="none">无</option></select></div>
        </div>
        <label class="check-row"><input type="checkbox" name="autoStart" checked> 创建后立即进入执行队列</label>
      </form>`,
      footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${icon('plus')}创建任务</button>`,
    })
  }

  function modalTask(task) {
    if (!task) return modalLoading('任务')
    const project = activeProject()
    const activeRun = (task.runs ?? []).find(run => ['queued', 'running'].includes(run.status))
    const latestFailed = (task.runs ?? []).find(run => ['failed', 'canceled'].includes(run.status))
    return modalShell({
      title: `${task.identifier} · ${task.title}`,
      badge: '',
      size: 'wide',
      body: `<div class="task-detail-grid">
        <div class="task-detail-main">
          <form data-form="update-task" id="task-form">
            <input type="hidden" name="taskId" value="${attr(task.id)}">
            <input type="hidden" name="version" value="${task.version}">
            <div class="field"><label>标题</label><input class="input" style="width:100%" name="title" value="${attr(task.title)}" required maxlength="240"></div>
            <div class="field"><label>描述</label><textarea class="textarea" name="description" rows="9">${esc(task.description || '')}</textarea></div>
            <div class="field-row">
              <div class="field"><label>状态</label><select class="select" style="width:100%" name="status">${STATUS_ORDER.map(status => `<option value="${status}" ${task.status === status ? 'selected' : ''}>${STATUS[status]}</option>`).join('')}</select></div>
              <div class="field"><label>优先级</label><select class="select" style="width:100%" name="priority">${Object.entries(PRIORITY).map(([key, label]) => `<option value="${key}" ${task.priority === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
            </div>
            <div class="field"><label>负责人</label><select class="select" style="width:100%" name="assigneeBotId"><option value="">未指派</option>${project.members.map(member => `<option value="${attr(member.id)}" ${task.assignee_bot_id === member.id ? 'selected' : ''}>${esc(member.name)} · ${esc(member.bot_role || '')}</option>`).join('')}</select></div>
          </form>
          <div class="divider"></div>
          <div class="eyebrow" style="margin-bottom:6px">评论</div>
          ${(task.comments ?? []).length === 0 ? '<div class="note">还没有评论。</div>' : task.comments.map(comment => `<div class="comment">
            ${avatar(comment.author_type === 'bot' ? (botById(comment.author_id) ?? { name: comment.authorName, color: 'gray' }) : { name: '我', color: 'teal' }, 'sm')}
            <div class="comment-main"><div class="comment-head"><strong>${esc(comment.authorName)}</strong><span>${esc(timeAgo(comment.created_at))}</span></div><div class="comment-body">${richText(comment.body)}</div></div>
          </div>`).join('')}
          <form data-form="add-comment" style="margin-top:14px">
            <input type="hidden" name="taskId" value="${attr(task.id)}">
            <textarea class="textarea" name="body" rows="3" placeholder="补充说明、验收意见或阻塞原因"></textarea>
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
            ${run.output ? `<details style="margin-top:6px"><summary class="summary-link">查看输出</summary><div class="run-output">${esc(run.output)}</div></details>` : ''}
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
      footer: `<button class="btn" data-action="close-modal">关闭</button><button class="btn" type="button" data-action="run-task" data-task-id="${attr(task.id)}">${icon('play')}保存并运行</button><button class="btn primary" type="submit" form="task-form">${icon('check')}保存</button>`,
    })
  }

  function modalMemory(memory) {
    const project = activeProject()
    const choices = [
      ...(project ? [`<option value="project:${attr(project.id)}" ${memory?.scope_type === 'project' ? 'selected' : ''}>项目 · ${esc(project.name)}</option>`] : []),
      ...activeBots().map(bot => `<option value="bot:${attr(bot.id)}" ${memory?.scope_type === 'bot' && memory?.scope_id === bot.id ? 'selected' : ''}>Bot · ${esc(bot.name)}</option>`),
    ]
    return modalShell({
      title: memory ? '编辑记忆' : '写入记忆',
      badge: '',
      body: `<form data-form="${memory ? 'update-memory' : 'create-memory'}" id="modal-form">
        <input type="hidden" name="memoryId" value="${attr(memory?.id ?? '')}">
        <div class="field"><label>作用域</label>${memory
          ? `<input class="input" style="width:100%" value="${esc(memory.scope_type === 'project' ? '项目记忆' : `Bot · ${botById(memory.scope_id)?.name ?? ''}`)}" disabled>`
          : `<select class="select" style="width:100%" name="scope">${choices.join('')}</select>`}</div>
        <div class="field"><label>主题</label><input class="input" style="width:100%" name="topic" value="${attr(memory?.topic ?? '')}" maxlength="120" placeholder="例如：发布流程约束" required></div>
        <div class="field"><label>内容</label><textarea class="textarea" name="content" rows="9" required placeholder="写清楚背景、结论和适用范围">${esc(memory?.content ?? '')}</textarea><div class="hint">密钥、密码和 token 会被自动过滤为 [REDACTED]。</div></div>
      </form>`,
      footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${icon('check')}${memory ? '保存记忆' : '写入记忆'}</button>`,
    })
  }

  function modalProposal(kind = 'bot_update') {
    const project = activeProject()
    return modalShell({
      title: '新建进化提案',
      subtitle: '审批通过后才会生效。',
      badge: '',
      size: 'wide',
      body: `<form data-form="create-proposal" id="modal-form">
        <input type="hidden" name="projectId" value="${attr(project?.id ?? '')}">
        <div class="field-row">
          <div class="field"><label>提案类型</label><select class="select" style="width:100%" name="kind" data-proposal-kind><option value="bot_update" ${kind === 'bot_update' ? 'selected' : ''}>Bot 指令更新</option><option value="skill" ${kind === 'skill' ? 'selected' : ''}>共享技能</option></select></div>
          <div class="field" data-field="bot"><label>目标 Bot</label><select class="select" style="width:100%" name="botId">${activeBots().map(bot => `<option value="${attr(bot.id)}">${esc(bot.name)}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>标题</label><input class="input" style="width:100%" name="title" required maxlength="200" placeholder="一句话说明变更"></div>
        <div class="field"><label>依据</label><textarea class="textarea" name="rationale" rows="4" required placeholder="为什么需要变更，来自哪些失败或重复模式"></textarea></div>
        <div data-section="bot"><div class="field"><label>新的角色指令</label><textarea class="textarea" name="instructions" rows="9" placeholder="完整替换现有指令，而不是追加"></textarea></div></div>
        <div data-section="skill" style="display:none">
          <div class="field-row"><div class="field"><label>技能标识</label><input class="input mono" style="width:100%" name="slug" placeholder="发布检查"></div><div class="field"><label>版本</label><input class="input" style="width:100%" name="version" value="1.0.0"></div></div>
          <div class="field"><label>显示名称</label><input class="input" style="width:100%" name="name"></div>
          <div class="field"><label>描述</label><input class="input" style="width:100%" name="description"></div>
          <div class="field"><label>技能内容（Markdown）</label><textarea class="textarea" name="content" rows="10" placeholder="## When to use&#10;..."></textarea></div>
        </div>
        <div class="field"><label>评估方式</label><textarea class="textarea" name="evaluation" rows="3" placeholder="审批前如何验证：回归任务、失败案例、人工检查点"></textarea></div>
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
      : '每百万 token 计价。供应商留空表示匹配任意模型。'
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
        <div class="field-row"><div class="field"><label>模型供应商（可留空）</label><input class="input mono" style="width:100%" name="provider" list="price-providers" value="${attr(seed.provider ?? '')}" placeholder="留空 = 匹配任意供应商"></div><div class="field"><label>模型名</label><input class="input mono" style="width:100%" name="model" list="price-models" value="${attr(seed.model ?? '')}" placeholder="deepseek-flash" required autofocus></div></div>
        <div class="field-row"><div class="field"><label>输入</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" name="inputPerMtok" value="${attr(seed.input_per_mtok ?? fallback?.inputPerMtok ?? 0)}"></div><div class="field"><label>输出</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" name="outputPerMtok" value="${attr(seed.output_per_mtok ?? fallback?.outputPerMtok ?? 0)}"></div></div>
        <div class="field-row"><div class="field"><label>缓存读</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" name="cacheReadPerMtok" value="${attr(seed.cache_read_per_mtok ?? fallback?.cacheReadPerMtok ?? 0)}"></div><div class="field"><label>缓存写</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" name="cacheWritePerMtok" value="${attr(seed.cache_write_per_mtok ?? fallback?.cacheWritePerMtok ?? 0)}"></div></div>
        <div class="field"><label>币种</label><input class="input mono" style="width:100%" name="currency" value="${attr(seed.currency ?? fallback?.currency ?? 'CNY')}" placeholder="CNY"></div>
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

  function formPayload(form) {
    return Object.fromEntries(new FormData(form).entries())
  }

  async function sendMessage() {
    const body = state.draft.trim()
    const project = activeProject()
    if (!body || !project) return
    try {
      await api('send_message', { projectId: project.id, body })
      state.draft = ''
      state.chatAtBottom = true
      await loadState(project.id, { quiet: true })
      render()
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
        case 'nav':
          state.view = target.dataset.view || 'chat'
          render()
          break
        case 'toggle-tree': {
          const key = target.dataset.tree
          if (key && key in state.tree) {
            state.tree[key] = !state.tree[key]
            render()
          }
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
        case 'select-project':
          state.projectId = target.dataset.projectId
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
        case 'edit-bot':
          await openBot(target.dataset.botId)
          break
        case 'send-message':
          await sendMessage()
          break
        case 'copy': {
          const value = target.dataset.copy
          if (value) {
            await navigator.clipboard.writeText(value).catch(() => {})
            toast('路径已复制', 'success')
          }
          break
        }
        case 'sync-skills': {
          const result = await api('sync_skills', {})
          await loadState(state.projectId, { quiet: true })
          render()
          toast(`已扫描 ${result.count} 个共享技能`, 'success')
          break
        }
        case 'archive-bot': {
          const botId = target.dataset.botId
          const bot = botById(botId)
          if (!bot || !window.confirm(`归档 ${bot.name}？负责人关系必须先解除。`)) break
          await api('archive_bot', { botId })
          state.modal = null
          await refresh()
          toast('Bot 已归档', 'success')
          break
        }
        case 'rollback-bot': {
          const botId = target.dataset.botId
          if (!window.confirm('回滚到该版本？')) break
          await api('rollback_bot', { botId, revisionId: target.dataset.revisionId })
          await loadState(state.projectId, { quiet: true })
          await openBot(botId)
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
        case 'decide-proposal': {
          const decision = target.dataset.decision
          const label = decision === 'approved' ? '通过并应用' : '拒绝'
          if (!window.confirm(`确认${label}该提案？`)) break
          await api('decide_proposal', { proposalId: target.dataset.proposalId, decision })
          await refresh()
          toast(decision === 'approved' ? '提案已应用' : '提案已拒绝', 'success')
          break
        }
        case 'usage-scope':
          state.usageScope = target.dataset.scope
          render()
          break
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
        })
        state.modal = null
        state.projectId = result.id
        state.view = 'chat'
        await refresh()
        toast('项目已创建', 'success')
        return
      }
      if (type === 'create-bot' || type === 'update-bot') {
        const ref = String(payload.modelRef || '')
        const slash = ref.indexOf('/')
        const provider = slash > 0 ? ref.slice(0, slash) : null
        const model = slash > 0 ? ref.slice(slash + 1) : null
        const common = {
          name: payload.name,
          role: payload.role,
          instructions: payload.instructions,
          color: payload.color,
          provider,
          model,
          effort: payload.effort || null,
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
        return
      }
      if (type === 'create-task') {
        const task = await api('create_task', {
          projectId: payload.projectId,
          title: payload.title,
          description: payload.description,
          assigneeBotId: payload.assigneeBotId || null,
          priority: payload.priority,
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
        await api('save_price', {
          provider: payload.provider ?? '',
          model: payload.model,
          inputPerMtok: Number(payload.inputPerMtok),
          cacheReadPerMtok: Number(payload.cacheReadPerMtok),
          cacheWritePerMtok: Number(payload.cacheWritePerMtok),
          outputPerMtok: Number(payload.outputPerMtok),
          currency: (payload.currency || 'CNY').toUpperCase(),
        })
        state.modal = null
        await refresh()
        toast('模型价格已保存，新调用将按此计价', 'success')
        return
      }
      if (type === 'save-project') {
        const memberIds = new FormData(form).getAll('memberIds')
        await api('update_project', {
          projectId: payload.projectId,
          patch: {
            name: payload.name,
            description: payload.description,
            ownerBotId: payload.ownerBotId,
            replyMode: payload.replyMode,
            memberIds,
            tokenBudget: payload.tokenBudget === '' ? null : Number(payload.tokenBudget),
            costBudget: payload.costBudget === '' ? null : Number(payload.costBudget),
          },
        })
        await refresh()
        toast('项目设置已保存', 'success')
        return
      }
    } catch (error) {
      toast(error.message || String(error), 'error')
    }
  })

  document.addEventListener('input', (event) => {
    const el = event.target
    if (el.id === 'ui-scale') {
      const scale = applyUiScale(el.value)
      try { localStorage.setItem(UI_SCALE_KEY, String(scale)) } catch {}
      const value = document.getElementById('ui-scale-value')
      if (value) value.textContent = `${Math.round(scale * 100)}%`
      return
    }
    if (el.id === 'composer-input') {
      state.draft = el.value
      el.style.height = 'auto'
      el.style.height = `${Math.min(150, el.scrollHeight)}px`
      const button = document.querySelector('[data-action="send-message"]')
      if (button) button.disabled = state.draft.trim() === ''
    }
    if (el.id === 'task-search') {
      state.taskFilter.search = el.value
    }
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.modal) {
      closeModal()
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
    }
  })

  document.addEventListener('change', (event) => {
    const el = event.target
    if (el.matches('[data-task-filter]')) {
      state.taskFilter[el.dataset.taskFilter] = el.value
      render()
    }
    if (el.id === 'memory-filter') {
      state.memoryFilter = el.value
      render()
    }
    if (el.matches('[data-model-select]')) updateEffortOptions(el)
  })

  document.addEventListener('scroll', (event) => {
    if (event.target.classList?.contains('chat-messages')) {
      const el = event.target
      state.chatAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
  }, true)

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
      if (state.modal?.type === 'proposal') bindProposalForm()
    } catch (error) {
      state.data = null
      bootError(error)
    }
  }

  window.addEventListener('resize', () => { syncChromeHeight() })

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
})()
