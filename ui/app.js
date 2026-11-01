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
    chatMode: 'group',
    soloBotId: null,
    modal: null,
    draft: '',
    ac: null,
    busy: 0,
    chatAtBottom: true,
    taskFilter: { status: 'all', assignee: 'all', search: '' },
    memoryFilter: 'all',
    usageScope: 'global',
    usageBot: null,
    memoryQuery: '',
    memoryResults: null,
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
  const PROPOSAL_STATUS = { pending: '待审', canary: '灰度中', approved: '已通过', rejected: '已拒绝' }
  const COLORS = ['teal', 'blue', 'violet', 'amber', 'coral', 'pink', 'green', 'gray']
  const COLOR_NAMES = { teal: '青', blue: '蓝', violet: '紫', amber: '琥珀', coral: '珊瑚', pink: '粉', green: '绿', gray: '灰' }
  const BOT_STATUS = { active: '运行中', paused: '已暂停', archived: '已归档' }
  const RUN_STATUS = { queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', canceled: '已取消' }
  const SKILL_STATUS = { active: '启用中', missing: '已失效' }
  const MEMORY_STATUS = { active: '已生效', pending: '待审', frozen: '已冻结', rejected: '已拒绝', archived: '已归档' }
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
    download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
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
    const data = await api('state', { projectId: projectId || undefined, soloBotId: state.soloBotId || undefined }, { quiet })
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
    const tokenTotal = usageTotals('project').totalTokens ?? 0
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
          ${isGlobal ? '' : `<div class="tabbar" role="tablist" aria-label="主导航">
            ${NAV.map(([key, label]) => {
              const dot = tabDot(key)
              const active = state.view === key
              return `<button class="tab ${active ? 'active' : ''}" role="tab" id="tab-${key}" aria-controls="main-content" aria-selected="${active}" tabindex="${active ? '0' : '-1'}" data-action="nav" data-view="${key}">${label}${dot ? '<span class="red-dot" title="有待人工处理事项"></span>' : ''}</button>`
            }).join('')}
          </div>`}
          </div>
          <section class="content" id="main-content" role="tabpanel" tabindex="-1"${state.view === 'global' ? '' : ` aria-labelledby="tab-${state.view}"`}>
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
    state.ac = null
    app.className = ''
    const hadModal = Boolean(document.querySelector('.modal'))
    const previousFocus = document.activeElement
    app.innerHTML = renderShell()
    if (state.modal && !hadModal) {
      lastFocused = previousFocus
      focusModal()
    }
    if (!state.modal && hadModal) restoreFocus()
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
    if (state.chatMode === 'solo') return renderSoloChat()
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
            <div class="chat-head-actions">
              <div class="mode-switch" aria-label="会话模式">
                <button type="button" class="active" data-action="chat-mode" data-mode="group">群聊</button>
                <button type="button" data-action="chat-mode" data-mode="solo">单聊</button>
              </div>
              <div class="member-stack">
                ${members.slice(0, 6).map(member => {
                  const bot = botById(member.id)
                  return bot ? avatar(bot, 'sm') : ''
                }).join('')}
              </div>
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
              <div class="composer-ac" id="composer-ac" role="listbox" aria-label="输入补全" hidden></div>
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

  // 项目外单聊：每个 Bot 一条独立会话，运行目录在 _the_bots/<bot> 下。
  function renderSoloChat() {
    const bots = (state.data?.bots ?? []).filter(bot => bot.status === 'active')
    if (bots.length === 0) {
      return `<div class="empty-state">
        <div class="empty-symbol">${icon('bot')}</div>
        <h3>还没有可单聊的 Bot</h3>
        <p>先创建一个 Bot，就可以和它一对一对话。</p>
        <button class="btn primary" data-action="new-bot">${icon('plus')}新建 Bot</button>
      </div>`
    }
    if (!state.soloBotId || !bots.some(bot => bot.id === state.soloBotId)) state.soloBotId = bots[0].id
    const bot = botById(state.soloBotId)
    const solo = state.data?.solo?.bot?.id === bot.id ? state.data.solo : null
    const messages = solo?.messages ?? []
    const runs = solo?.runs ?? []
    const running = runs.filter(run => run.status === 'running' || run.status === 'queued').length
    return `
      <div class="chat-layout">
        <div class="card chat-panel">
          <div class="chat-head">
            <div>
              <div class="chat-head-title">${avatar(bot, 'sm')}<span>@${esc(bot.name)}</span></div>
              <div class="chat-head-meta"><span>${esc(bot.role || '团队成员')}</span><span class="sep"></span><span>${esc(bot.modelRef ?? '未配置模型')}</span>${running > 0 ? `<span class="sep"></span><span class="run-dot"></span><span>${running} 个运行中</span>` : ''}</div>
            </div>
            <div class="chat-head-actions">
              <div class="mode-switch" aria-label="会话模式">
                <button type="button" data-action="chat-mode" data-mode="group">群聊</button>
                <button type="button" class="active" data-action="chat-mode" data-mode="solo">单聊</button>
              </div>
            </div>
          </div>
          <div class="solo-bot-strip" aria-label="切换单聊对象">
            ${bots.map(item => `<button type="button" class="solo-pick${item.id === bot.id ? ' active' : ''}" data-action="pick-solo-bot" data-bot-id="${attr(item.id)}" title="${attr(item.name)}">
              ${avatar(item, 'sm')}<span>${esc(item.name)}</span>
            </button>`).join('')}
          </div>
          <div class="chat-messages">
            ${messages.length === 0 ? `<div class="chat-empty">
              <div class="empty-symbol">${icon('message')}</div>
              <h3>和 ${esc(bot.name)} 单独聊聊</h3>
              <p>这里没有项目上下文，适合单独请教、调试指令或闲聊。需要文件产出时会落在它自己的工作区。</p>
            </div>` : messages.map(renderMessage).join('')}
          </div>
          <div class="composer">
            <div class="composer-box">
              <textarea id="composer-input" rows="2" placeholder="和 ${esc(bot.name)} 单聊，/clear 清空本会话，/remember 内容 写入 Bot 记忆">${esc(state.draft)}</textarea>
              <div class="composer-bottom">
                <span class="composer-hint"><kbd>⌘</kbd><kbd>Enter</kbd> 发送</span>
                <button class="send-btn" data-action="send-message" ${state.draft.trim() ? '' : 'disabled'} title="发送" aria-label="发送消息">${icon('send')}</button>
              </div>
            </div>
          </div>
        </div>
        <aside class="chat-side">
          <div class="side-card">
            <div class="side-card-head"><h3>单聊对象</h3></div>
            <div class="owner-row">
              ${avatar(bot, 'lg')}
              <div class="owner-info"><strong>${esc(bot.name)}</strong><span>${esc(bot.role || '团队成员')} · ${esc(bot.modelRef ?? '未配置模型')}</span></div>
            </div>
          </div>
          <div class="side-card">
            <div class="side-card-head"><h3>最近单聊运行</h3><span>${runs.length}</span></div>
            ${runs.length === 0 ? '<div class="faint">还没有单聊运行。</div>' : `<div class="side-list">
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
          <input class="input search" id="task-search" placeholder="搜索任务、编号或标签" aria-label="搜索任务、编号或标签" value="${attr(state.taskFilter.search)}">
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
            ${bot.status === 'active' ? `<button class="btn small" data-action="solo-bot" data-bot-id="${attr(bot.id)}">单聊</button><button class="btn small" data-action="archive-bot" data-bot-id="${attr(bot.id)}">归档</button>` : ''}
          </div>
        </article>`).join('')}
      </div>`}
    `
  }

  function renderSkills() {
    const skills = state.data?.skills ?? []
    const proposals = (state.data?.proposals ?? []).filter(item => item.kind === 'skill' && item.status === 'pending')
    const project = activeProject()
    const disabledSet = new Set(project?.disabledSkills ?? [])
    return `
      <div class="section-head">
        <p>技能变更走提案和审批，不直接覆盖。${project ? `开关只作用于当前项目「${esc(project.name)}」：关闭后补全不再列出，Bot 会被明确告知不要调用；技能池本身不变。` : '进入一个项目后可按项目关闭特定技能。'}</p>
        <div class="btn-row">
          <button class="btn" data-action="sync-skills">${icon('refresh')}重新扫描</button>
        </div>
      </div>
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
    const project = activeProject()
    const payload = { query }
    if (project) payload.projectId = project.id
    const result = await api('search_memories', payload)
    state.memoryResults = Array.isArray(result) ? result : (result?.items ?? [])
    render()
  }

  function renderMemory() {
    const project = activeProject()
    const all = state.data?.memories ?? []
    const memories = all.filter(memory => state.memoryFilter === 'all' || memory.scope_type === state.memoryFilter)
    const pending = pendingMemoryCount()
    const results = state.memoryResults
    return `
      <div class="board-toolbar">
        <select class="select" id="memory-filter" aria-label="按作用域筛选记忆">
          <option value="all" ${state.memoryFilter === 'all' ? 'selected' : ''}>全部作用域</option>
          <option value="project" ${state.memoryFilter === 'project' ? 'selected' : ''}>项目记忆</option>
          <option value="bot" ${state.memoryFilter === 'bot' ? 'selected' : ''}>Bot 记忆</option>
          <option value="team" ${state.memoryFilter === 'team' ? 'selected' : ''}>团队记忆</option>
        </select>
        <input class="input search" id="memory-search" placeholder="搜索记忆主题或内容" aria-label="搜索记忆主题或内容" value="${attr(state.memoryQuery)}">
        <button class="btn" data-action="search-memories">${icon('search')}搜索</button>
        ${pending ? `<span class="pill amber">${pending} 条待审</span>` : ''}
        <span class="tag" style="margin-left:auto">${memories.length} 条</span>
      </div>
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
      ${!project ? noProject() : memories.length === 0 ? `<div class="empty-state"><div class="empty-symbol">${icon('memory')}</div><h3>还没有记忆</h3><p>任务完成后会自动沉淀交付经验。</p><button class="btn" data-action="new-memory">${icon('plus')}写入记忆</button></div>` : `<div class="grid">
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
                  <span>${esc(timeAgo(memory.updated_at))} · 置信度 ${Number(memory.confidence ?? 0).toFixed(2)}${memory.approved_by ? ` · 审批人 ${esc(memory.approved_by)}` : ''}</span>
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
    return `<details class="skill-versions">
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
            ${proposal.kind === 'workflow' ? '<div class="note">工作流提案尚未支持执行。</div>' : ''}
            <div class="proposal-body" style="margin-top:0">${esc(proposalPreview(proposal).slice(0, 6000))}</div>
            <div class="list-meta"><span>${esc(PROPOSAL_KIND[proposal.kind] ?? proposal.kind)}</span>${proposal.botName ? `<span>${esc(proposal.botName)}</span>` : ''}<span>${esc(timeAgo(proposal.created_at))}</span>${proposal.decided_by ? `<span>由 ${esc(proposal.decided_by)} 决定</span>` : ''}${proposal.approvedBy ? `<span>审批人 ${esc(proposal.approvedBy)}</span>` : ''}${proposal.appliedAt ? `<span>已生效 ${esc(formatTime(proposal.appliedAt))}</span>` : ''}${proposal.canary ? `<span>灰度 ${esc(canaryText(proposal.canary))}</span>` : ''}</div>
            ${proposal.evaluation ? `<div class="list-desc">评估 · ${esc(evaluationText(proposal.evaluation))}</div>` : ''}
            ${proposal.status === 'pending' ? `<details class="proposal-diff">
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
    const scope = typeof raw.scope === 'string' ? raw.scope : (project ? 'project' : 'global')
    return { ...raw, tiers, global, project, scope, legacy: Boolean(legacy) }
  }

  function usageTotals(scope = state.usageScope) {
    const usage = usageSnapshot()
    if (scope === 'project') return usage.project ?? usage.global ?? {}
    return usage.global ?? {}
  }

  function formatAmount(value) {
    const n = Number(value ?? 0)
    if (!Number.isFinite(n)) return '0.00'
    if (n === 0) return '0.00'
    if (Math.abs(n) < 0.01) return n.toFixed(4)
    return n.toFixed(2)
  }

  function costSplit(totals) {
    const map = totals?.costByCurrency
    if (map && typeof map === 'object') {
      const codes = Object.keys(map).sort()
      if (codes.length) return codes.map(code => `${code} ${formatAmount(map[code])}`).join(' / ')
    }
    if (totals?.cost === null || totals?.cost === undefined) return '未配置'
    return `${formatAmount(totals.cost)}（币种未知）`
  }

  async function exportUsageCsv() {
    const usage = usageSnapshot()
    const project = activeProject()
    const payload = { days: usage.days ?? 30 }
    if (state.usageScope !== 'global' && project) payload.projectId = project.id
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

  function renderUsage() {
    const usage = usageSnapshot()
    const scope = state.usageScope
    // 分组明细跟随当前口径：scopeTiers.global / scopeTiers.project，缺省回退顶层（全局口径）。
    const tier = scope === 'project' ? usage.tiers?.project : usage.tiers?.global
    const byBot = tier?.byBot ?? usage.byBot ?? []
    const selectedBot = scope === 'bot' && state.usageBot
      ? byBot.find(item => String(item.botId ?? item.id ?? '') === String(state.usageBot))
      : null
    const totals = scope === 'bot' ? (selectedBot ?? usageTotals('global')) : usageTotals(scope)
    const byProject = tier?.byProject ?? usage.byProject ?? []
    const byModel = tier?.byModel ?? usage.byModel ?? []
    const days = tier?.byDay ?? usage.byDay ?? []
    const project = activeProject()
    const scopeLabel = scope === 'global' ? '全局' : scope === 'project' ? '本项目' : '按 Bot'
    const maxBot = Math.max(1, ...byBot.map(item => item.totalTokens ?? 0))
    const maxProject = Math.max(1, ...byProject.map(item => item.totalTokens ?? 0))
    const maxModel = Math.max(1, ...byModel.map(item => item.totalTokens ?? 0))
    const maxDay = Math.max(1, ...days.map(item => item.totalTokens ?? 0))
    const unpriced = Number(totals.unpricedCalls ?? 0)
    const reconciliation = usage.reconciliation ?? null
    const drillBot = state.usageBot ? botById(state.usageBot) : null
    const drillRuns = drillBot
      ? (state.data?.runs ?? []).filter(run => run.bot_id === drillBot.id
        && (scope !== 'project' || !project || run.project_id === project.id))
      : []

    const barRow = (item, label, max) => `<div class="bar-row">
      <span class="bar-label">${esc(label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, (item.totalTokens ?? 0) / max * 100)}%"></span></span>
      <span class="bar-value">${formatNumber(item.totalTokens)}</span>
      <span class="bar-calls">${formatNumber(item.calls)} 次</span>
      <span class="bar-cost">${costSplit(item)}</span>
    </div>`
    const botRow = (item, max) => {
      const id = item.botId ?? item.id ?? ''
      const name = item.name ?? botById(id)?.name ?? '未知 Bot'
      const active = state.usageBot === id
      return `<button type="button" class="bar-row bar-row-action${active ? ' active' : ''}" data-action="usage-drill" data-bot-id="${attr(id)}" aria-pressed="${active}" title="查看该 Bot 的运行记录">
        <span class="bar-label">${esc(name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, (item.totalTokens ?? 0) / max * 100)}%"></span></span>
        <span class="bar-value">${formatNumber(item.totalTokens)}</span>
        <span class="bar-calls">${formatNumber(item.calls)} 次</span>
        <span class="bar-cost">${costSplit(item)}</span>
      </button>`
    }
    const runRow = (run) => `<div class="run-row">
      <div class="run-row-top">${runDot(run.status)}<strong class="mono">${esc(String(run.id ?? '').slice(0, 8))}</strong><span>${esc(RUN_STATUS[run.status] ?? run.status)}</span><span style="margin-left:auto">${esc(timeAgo(run.queued_at))}</span></div>
      <div class="run-row-meta"><span>${esc(run.kind || '—')}</span><span>${formatNumber(Number(run.usage_input ?? 0) + Number(run.usage_output ?? 0))} tok</span>${run.usage_cost !== null && run.usage_cost !== undefined ? `<span>${formatCost(run.usage_cost)}</span>` : ''}</div>
    </div>`
    return `
      <div class="section-head">
        <div class="seg" role="group" aria-label="用量口径">
          <button data-action="usage-scope" data-scope="global" aria-pressed="${scope === 'global'}">全局</button>
          <button data-action="usage-scope" data-scope="project" aria-pressed="${scope === 'project'}" ${project ? '' : 'disabled'}>本项目</button>
          <button data-action="usage-scope" data-scope="bot" aria-pressed="${scope === 'bot'}">按 Bot</button>
        </div>
        <div class="btn-row">
          <button class="btn" data-action="export-usage-csv">${icon('download')}导出 CSV</button>
        </div>
      </div>
      <div class="metric-grid">
        <div class="card metric">
          <span class="metric-label">总 tokens（${scopeLabel}）</span>
          <strong>${formatNumber(totals.totalTokens)}</strong>
          <small class="mono">${formatNumber(totals.inputTokens)} 输入 · ${formatNumber(totals.outputTokens)} 输出</small>
        </div>
        <div class="card metric">
          <span class="metric-label">模型调用</span>
          <strong>${formatNumber(totals.calls)}</strong>
          <small class="mono">缓存读 ${formatNumber(totals.cacheReadTokens)}</small>
        </div>
        <div class="card metric">
          <span class="metric-label">成本（${scopeLabel}）</span>
          <strong class="metric-cost">${costSplit(totals)}</strong>
          <small class="mono">${usage.priceCount ? `${usage.priceCount} 条价格规则` : '尚未配置模型价格'}</small>
        </div>
        <div class="card metric">
          <span class="metric-label">统计窗口</span>
          <strong>${usage.days ?? 30}d</strong>
          <small class="mono">${scopeLabel} · 按调用时间归集</small>
        </div>
      </div>
      ${unpriced > 0 ? `<div class="note warn-note">${unpriced} 次调用未配置价格，成本为部分值。</div>` : ''}
      ${reconciliation ? `<div class="usage-note">用量对账：检查 ${Number(reconciliation.runsChecked ?? 0)} 次运行，${Number(reconciliation.runsWithEvents ?? 0)} 次有用量记录，${Number(reconciliation.missingUsage ?? 0)} 次缺记录，${Number(reconciliation.mismatched ?? 0)} 次不一致${reconciliation.checkedAt ? `（${esc(timeAgo(reconciliation.checkedAt))}）` : ''}。</div>` : ''}
      ${usage.legacy ? '<div class="usage-note">服务端尚未按口径过滤明细，下方分组仍是全局数据。</div>' : ''}
      <div class="usage-grid">
        <div class="card usage-panel">
          <div class="card-head"><h3>按 Bot</h3><span class="meta">${byBot.length} 个 · 点击下钻运行</span></div>
          ${byBot.length === 0 ? '<div class="faint">暂无调用记录。</div>' : `<div class="bar-list">${byBot.map(item => botRow(item, maxBot)).join('')}</div>`}
        </div>
        <div class="card usage-panel">
          <div class="card-head"><h3>${scope === 'global' ? '按项目' : scope === 'project' ? '按模型' : '运行下钻'}</h3>${drillBot ? `<button class="btn small" data-action="usage-clear-drill">${icon('close')}清除选择</button>` : ''}</div>
          ${scope === 'global' ? (byProject.length === 0 ? '<div class="faint">暂无调用记录。</div>' : `<div class="bar-list">${byProject.map(item => barRow(item, item.name ?? item.key ?? item.projectId ?? '', maxProject)).join('')}</div>`)
            : scope === 'project' ? (byModel.length === 0 ? '<div class="faint">暂无调用记录。</div>' : `<div class="bar-list">${byModel.map(item => barRow(item, item.model ?? '', maxModel)).join('')}</div>`)
            : (drillBot ? (drillRuns.length === 0 ? '<div class="faint">该 Bot 还没有运行记录。</div>' : `<div class="run-list">${drillRuns.map(runRow).join('')}</div>`) : '<div class="faint">在上方选择一个 Bot，查看它的运行记录。</div>')}
        </div>
      </div>
      <div class="usage-grid" style="margin-top:12px">
        <div class="card usage-panel">
          <div class="card-head"><h3>近 14 天</h3></div>
          ${days.length === 0 ? '<div class="faint">暂无按日数据。</div>' : `<div class="day-bars">${days.map(day => `<div class="day-bar${day.totalTokens ? '' : ' zero'}" style="height:${Math.max(3, (day.totalTokens ?? 0) / maxDay * 100)}%" title="${esc(day.day)} · ${formatNumber(day.totalTokens)} tokens"></div>`).join('')}</div><div class="day-axis">${days.map((day, index) => `<span title="${esc(day.day)} · ${formatNumber(day.totalTokens)} tokens">${index === 0 || index === days.length - 1 || index % 3 === 0 ? esc(String(day.day).slice(5).replace('-', '/')) : ''}</span>`).join('')}</div>`}
        </div>
        <div class="card usage-panel">
          <div class="card-head"><h3>模型明细</h3><button class="btn small" data-action="new-price">设置价格</button></div>
          ${byModel.length === 0 ? '<div class="faint">暂无数据。</div>' : `<table class="usage-table"><thead><tr><th class="eyebrow mono">模型</th><th class="eyebrow mono num">调用</th><th class="eyebrow mono num">tokens</th><th class="eyebrow mono">成本</th></tr></thead><tbody>${byModel.map(item => `<tr><td>${esc(item.model)}</td><td class="mono num">${formatNumber(item.calls)}</td><td class="mono num">${formatNumber(item.totalTokens)}</td><td class="mono">${costSplit(item)}</td></tr>`).join('')}</tbody></table>`}
          <div class="usage-note">成本按币种分组显示；未配置价格时显示“未配置”，不会按 0 计费。价格按每百万 token 配置。</div>
        </div>
      </div>
    `
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
          <button class="btn small" type="button" data-action="reconcile-usage">立即对账</button>
        </div>
        <div class="kv" style="margin-top:12px"><span>投递队列</span><strong>待投 ${outbox.pending ?? 0} · 失败 ${outbox.failed ?? 0} · 已投 ${outbox.delivered ?? 0}</strong></div>
        <div class="kv"><span>用量对账</span><strong>${reconciliation
          ? `检查 ${reconciliation.runsChecked ?? 0} 个运行，差异 ${reconciliation.mismatched ?? 0} 个`
          : '暂无对账记录'}</strong></div>
      </div>`
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
              <div class="field"><label id="settings-name-label" for="settings-name">项目名称</label><input class="input" id="settings-name" name="name" value="${attr(project.name)}" maxlength="80"></div>
              <div class="field"><label id="settings-description-label" for="settings-description">项目描述</label><textarea class="textarea" id="settings-description" name="description">${esc(project.description || '')}</textarea></div>
              <div class="field-row">
                <div class="field"><label id="settings-owner-label" for="settings-owner">负责人 Bot</label><select class="select" id="settings-owner" name="ownerBotId">${members.map(bot => `<option value="${attr(bot.id)}" ${bot.id === project.owner_bot_id ? 'selected' : ''}>${esc(bot.name)}</option>`).join('')}</select></div>
                <div class="field"><label id="settings-reply-mode-label" for="settings-reply-mode">群聊回复模式</label><select class="select" id="settings-reply-mode" name="replyMode"><option value="owner_first" ${project.group?.reply_mode !== 'everyone' ? 'selected' : ''}>负责人优先</option><option value="everyone" ${project.group?.reply_mode === 'everyone' ? 'selected' : ''}>全员响应</option></select></div>
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
                <div class="field"><label id="settings-token-budget-label" for="settings-token-budget">Token 预算</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-token-budget" name="tokenBudget" value="${project.token_budget ?? ''}" placeholder="不限制"></div>
                <div class="field"><label id="settings-cost-budget-label" for="settings-cost-budget">成本预算</label><input class="input mono" style="text-align:right" type="number" min="0" step="0.01" id="settings-cost-budget" name="costBudget" value="${project.cost_budget ?? ''}" placeholder="不限制"></div>
              </div>
              <div class="hint">超出预算时项目会提示预算已用尽。成本预算与模型价格使用同一币种计价。</div>
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
            ${renderOpsCard()}
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
      case 'new-bot': return modalBot(null)
      case 'edit-bot': return modalBot(modal.detail)
      case 'new-task': return modalNewTask()
      case 'task': return modalTask(modal.detail)
      case 'skill-detail': return modalSkill(modal.detail)
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
        <div class="field"><label id="new-project-name-label" for="new-project-name">项目名称</label><input class="input" style="width:100%" id="new-project-name" name="name" placeholder="例如：官网重构" required maxlength="80" autofocus></div>
        <div class="field-row">
          <div class="field"><label id="new-project-key-label" for="new-project-key">项目 Key</label><input class="input mono" style="width:100%" id="new-project-key" name="key" placeholder="WEB" maxlength="10" pattern="[A-Za-z][A-Za-z0-9]{0,9}"><div class="hint">任务的编号前缀。</div></div>
          <div class="field"><label id="new-project-owner-label" for="new-project-owner">负责人 Bot</label><select class="select" style="width:100%" id="new-project-owner" name="ownerBotId">${bots.map(bot => `<option value="${attr(bot.id)}">${esc(bot.name)} · ${esc(bot.role || '成员')}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label id="new-project-description-label" for="new-project-description">项目说明</label><textarea class="textarea" id="new-project-description" name="description" placeholder="项目目标、边界和验收标准"></textarea></div>
        ${bots.length > 1 ? `<div class="field"><span class="field-label" id="new-project-members-label">其他成员</span><div class="check-list" role="group" aria-labelledby="new-project-members-label">${bots.slice(1).map(bot => `<div class="check-row"><input type="checkbox" id="new-project-member-${attr(bot.id)}" name="memberIds" value="${attr(bot.id)}"><label for="new-project-member-${attr(bot.id)}">${avatar(bot, 'sm')} ${esc(bot.name)}</label><span class="role">${esc(bot.role || '')}</span></div>`).join('')}</div></div>` : ''}
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
            <div class="field"><label id="bot-name-label" for="bot-name">名称</label><input class="input" style="width:100%" id="bot-name" name="name" value="${attr(bot?.name ?? '')}" placeholder="例如：Builder" required maxlength="24"></div>
            <div class="field"><label id="bot-role-label" for="bot-role">角色标签</label><input class="input" style="width:100%" id="bot-role" name="role" value="${attr(bot?.role ?? '')}" placeholder="例如：开发" maxlength="24"></div>
          </div>
          <div class="field-row">
            <div class="field"><label id="bot-model-label" for="bot-model">模型</label><select class="select" style="width:100%" id="bot-model" name="modelRef" data-model-select>${modelOptions(bot?.provider, bot?.model)}</select></div>
            <div class="field"><label id="bot-effort-label" for="bot-effort">推理强度</label><select class="select" style="width:100%" id="bot-effort" name="effort" data-effort-select>${effortOptions(modelRef, bot?.effort)}</select></div>
          </div>
          <div class="field"><label id="bot-color-label" for="bot-color">外观颜色</label><select class="select" style="width:100%" id="bot-color" name="color">${COLORS.map(color => `<option value="${color}" ${bot?.color === color ? 'selected' : ''}>${COLOR_NAMES[color] ?? color}</option>`).join('')}</select></div>
          <div class="field"><label id="bot-instructions-label" for="bot-instructions">角色指令</label><textarea class="textarea" id="bot-instructions" name="instructions" rows="10" placeholder="说明职责、工作方式、边界和交付标准">${esc(bot?.instructions ?? '')}</textarea></div>
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
        <div class="field"><label id="new-task-title-label" for="new-task-title">标题</label><input class="input" style="width:100%" id="new-task-title" name="title" required maxlength="240" placeholder="一个可执行、可验收的结果" autofocus></div>
        <div class="field"><label id="new-task-description-label" for="new-task-description">描述</label><textarea class="textarea" id="new-task-description" name="description" rows="8" placeholder="背景、范围、约束、验收标准"></textarea></div>
        <div class="field-row">
          <div class="field"><label id="new-task-assignee-label" for="new-task-assignee">指派给</label><select class="select" style="width:100%" id="new-task-assignee" name="assigneeBotId">${project.members.map(member => `<option value="${attr(member.id)}">${esc(member.name)} · ${esc(member.bot_role || '')}</option>`).join('')}</select></div>
          <div class="field"><label id="new-task-priority-label" for="new-task-priority">优先级</label><select class="select" style="width:100%" id="new-task-priority" name="priority"><option value="medium">中</option><option value="high">高</option><option value="urgent">紧急</option><option value="low">低</option><option value="none">无</option></select></div>
        </div>
        <div class="check-row"><input type="checkbox" id="new-task-autostart" name="autoStart" checked><label for="new-task-autostart">创建后立即进入执行队列</label></div>
      </form>`,
      footer: `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit" form="modal-form">${icon('plus')}创建任务</button>`,
    })
  }

  function modalSkill(detail) {
    if (!detail) return modalLoading('技能详情')
    const project = activeProject()
    const off = project?.disabledSkills?.includes(detail.slug) ?? false
    return modalShell({
      title: detail.name || detail.slug,
      subtitle: `/${detail.slug}`,
      badge: '共享技能',
      size: 'wide',
      body: `<div class="kv-grid">
          <div><div class="eyebrow">状态</div><div class="pill ${detail.status === 'active' ? 'green' : 'red'}">${esc(SKILL_STATUS[detail.status] ?? detail.status)}</div></div>
          <div><div class="eyebrow">版本</div><div>v${esc(currentSkillVersion(detail))}</div></div>
          <div><div class="eyebrow">本项目</div><div>${off ? '<span class="pill red">已关闭</span>' : '<span class="pill green">可用</span>'}</div></div>
        </div>
        <div style="margin-top:12px"><div class="eyebrow" style="margin-bottom:5px">描述</div><div>${esc(detail.description || '无描述')}</div></div>
        <div style="margin-top:12px"><div class="eyebrow" style="margin-bottom:5px">文件</div><code class="mono" style="font-size:var(--fs-caption);word-break:break-all">${esc(detail.path || detail.sharedPath || '')}</code></div>
        <div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:5px">SKILL.md 全文</div>
        ${detail.readable ? `<pre class="detail-pre">${esc(detail.content)}</pre>` : '<div class="note">技能文件当前不可读（可能已被移动或删除），可尝试重新扫描。</div>'}
        ${(detail.versions ?? []).length ? `<div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:5px">版本历史</div>
        ${skillVersions(detail)}` : ''}`,
      footer: `<button class="btn" data-action="close-modal">关闭</button>${project ? `<button class="btn ${off ? 'primary' : ''}" data-action="toggle-skill" data-slug="${attr(detail.slug)}" data-disabled="${off ? '0' : '1'}">${off ? '在本项目恢复' : '在本项目关闭'}</button>` : ''}`,
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
            <div class="field"><label id="task-title-label" for="task-title">标题</label><input class="input" style="width:100%" id="task-title" name="title" value="${attr(task.title)}" required maxlength="240"></div>
            <div class="field"><label id="task-description-label" for="task-description">描述</label><textarea class="textarea" id="task-description" name="description" rows="9">${esc(task.description || '')}</textarea></div>
            <div class="field-row">
              <div class="field"><label id="task-status-label" for="task-status">状态</label><select class="select" style="width:100%" id="task-status" name="status">${STATUS_ORDER.map(status => `<option value="${status}" ${task.status === status ? 'selected' : ''}>${STATUS[status]}</option>`).join('')}</select></div>
              <div class="field"><label id="task-priority-label" for="task-priority">优先级</label><select class="select" style="width:100%" id="task-priority" name="priority">${Object.entries(PRIORITY).map(([key, label]) => `<option value="${key}" ${task.priority === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
            </div>
            <div class="field"><label id="task-assignee-label" for="task-assignee">负责人</label><select class="select" style="width:100%" id="task-assignee" name="assigneeBotId"><option value="">未指派</option>${project.members.map(member => `<option value="${attr(member.id)}" ${task.assignee_bot_id === member.id ? 'selected' : ''}>${esc(member.name)} · ${esc(member.bot_role || '')}</option>`).join('')}</select></div>
          </form>
          <div class="divider"></div>
          <div class="eyebrow" style="margin-bottom:6px">评论</div>
          ${(task.comments ?? []).length === 0 ? '<div class="note">还没有评论。</div>' : task.comments.map(comment => `<div class="comment">
            ${avatar(comment.author_type === 'bot' ? (botById(comment.author_id) ?? { name: comment.authorName, color: 'gray' }) : { name: '我', color: 'teal' }, 'sm')}
            <div class="comment-main"><div class="comment-head"><strong>${esc(comment.authorName)}</strong><span>${esc(timeAgo(comment.created_at))}</span></div><div class="comment-body">${richText(comment.body)}</div></div>
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
        <div class="field"><label id="memory-scope-label" for="memory-scope">作用域</label>${memory
          ? `<input class="input" style="width:100%" id="memory-scope" value="${esc(memory.scope_type === 'project' ? '项目记忆' : `Bot · ${botById(memory.scope_id)?.name ?? ''}`)}" disabled>`
          : `<select class="select" style="width:100%" id="memory-scope" name="scope">${choices.join('')}</select>`}</div>
        <div class="field"><label id="memory-topic-label" for="memory-topic">主题</label><input class="input" style="width:100%" id="memory-topic" name="topic" value="${attr(memory?.topic ?? '')}" maxlength="120" placeholder="例如：发布流程约束" required></div>
        <div class="field"><label id="memory-content-label" for="memory-content">内容</label><textarea class="textarea" id="memory-content" name="content" rows="9" required placeholder="写清楚背景、结论和适用范围">${esc(memory?.content ?? '')}</textarea><div class="hint">密钥、密码和 token 会被自动过滤为 [REDACTED]。</div></div>
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
          <div class="field"><label id="proposal-kind-label" for="proposal-kind">提案类型</label><select class="select" style="width:100%" id="proposal-kind" name="kind" data-proposal-kind><option value="bot_update" ${kind === 'bot_update' ? 'selected' : ''}>Bot 指令更新</option><option value="skill" ${kind === 'skill' ? 'selected' : ''}>共享技能</option></select></div>
          <div class="field" data-field="bot"><label id="proposal-bot-label" for="proposal-bot">目标 Bot</label><select class="select" style="width:100%" id="proposal-bot" name="botId">${activeBots().map(bot => `<option value="${attr(bot.id)}">${esc(bot.name)}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label id="proposal-title-label" for="proposal-title">标题</label><input class="input" style="width:100%" id="proposal-title" name="title" required maxlength="200" placeholder="一句话说明变更"></div>
        <div class="field"><label id="proposal-rationale-label" for="proposal-rationale">依据</label><textarea class="textarea" id="proposal-rationale" name="rationale" rows="4" required placeholder="为什么需要变更，来自哪些失败或重复模式"></textarea></div>
        <div data-section="bot"><div class="field"><label id="proposal-instructions-label" for="proposal-instructions">新的角色指令</label><textarea class="textarea" id="proposal-instructions" name="instructions" rows="9" placeholder="完整替换现有指令，而不是追加"></textarea></div></div>
        <div data-section="skill" style="display:none">
          <div class="field-row"><div class="field"><label id="proposal-slug-label" for="proposal-slug">技能标识</label><input class="input mono" style="width:100%" id="proposal-slug" name="slug" placeholder="发布检查"></div><div class="field"><label id="proposal-version-label" for="proposal-version">版本</label><input class="input" style="width:100%" id="proposal-version" name="version" value="1.0.0"></div></div>
          <div class="field"><label id="proposal-name-label" for="proposal-name">显示名称</label><input class="input" style="width:100%" id="proposal-name" name="name"></div>
          <div class="field"><label id="proposal-description-label" for="proposal-description">描述</label><input class="input" style="width:100%" id="proposal-description" name="description"></div>
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
        <div class="field-row"><div class="field"><label id="price-provider-label" for="price-provider">模型供应商（可留空）</label><input class="input mono" style="width:100%" id="price-provider" name="provider" list="price-providers" value="${attr(seed.provider ?? '')}" placeholder="留空 = 匹配任意供应商"></div><div class="field"><label id="price-model-label" for="price-model">模型名</label><input class="input mono" style="width:100%" id="price-model" name="model" list="price-models" value="${attr(seed.model ?? '')}" placeholder="deepseek-flash" required autofocus></div></div>
        <div class="field-row"><div class="field"><label id="price-input-label" for="price-input">输入</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-input" name="inputPerMtok" value="${attr(seed.input_per_mtok ?? fallback?.inputPerMtok ?? 0)}"></div><div class="field"><label id="price-output-label" for="price-output">输出</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-output" name="outputPerMtok" value="${attr(seed.output_per_mtok ?? fallback?.outputPerMtok ?? 0)}"></div></div>
        <div class="field-row"><div class="field"><label id="price-cache-read-label" for="price-cache-read">缓存读</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-cache-read" name="cacheReadPerMtok" value="${attr(seed.cache_read_per_mtok ?? fallback?.cacheReadPerMtok ?? 0)}"></div><div class="field"><label id="price-cache-write-label" for="price-cache-write">缓存写</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-cache-write" name="cacheWritePerMtok" value="${attr(seed.cache_write_per_mtok ?? fallback?.cacheWritePerMtok ?? 0)}"></div></div>
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
          desc: member.owner ? `负责人 · ${member.role || '成员'}` : (member.role || '成员'),
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
    return { skills, members }
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

  function syncComposerBox(input) {
    state.draft = input.value
    input.style.height = 'auto'
    input.style.height = `${Math.min(150, input.scrollHeight)}px`
    const button = document.querySelector('[data-action="send-message"]')
    if (button) button.disabled = state.draft.trim() === ''
  }

  async function sendMessage() {
    const body = state.draft.trim()
    if (!body) return
    closeAutocomplete()
    try {
      let result
      if (state.chatMode === 'solo') {
        const bot = botById(state.soloBotId)
        if (!bot) return
        if (body === '/clear' && !window.confirm(`清空和 ${bot.name} 的全部单聊记录？清除后不可恢复（记忆保留）。`)) return
        result = await api('send_solo_message', { botId: bot.id, body })
      } else {
        const project = activeProject()
        if (!project) return
        if (body === '/clear' && !window.confirm('清空本群全部聊天记录？清除后不可恢复（任务与记忆保留）。')) return
        result = await api('send_message', { projectId: project.id, body })
      }
      state.draft = ''
      state.chatAtBottom = true
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
        case 'chat-mode': {
          const mode = target.dataset.mode === 'solo' ? 'solo' : 'group'
          if (mode === 'solo' && !state.soloBotId) {
            const first = (state.data?.bots ?? []).find(bot => bot.status === 'active')
            if (first) state.soloBotId = first.id
          }
          state.chatMode = mode
          render()
          break
        }
        case 'pick-solo-bot':
          if (target.dataset.botId) {
            state.soloBotId = target.dataset.botId
            state.draft = ''
            closeAutocomplete()
            await loadState(state.projectId, { quiet: true })
            render()
          }
          break
        case 'solo-bot': {
          const botId = target.dataset.botId
          if (!botId) break
          state.soloBotId = botId
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
          state.usageScope = target.dataset.scope
          if (state.usageScope !== 'bot') state.usageBot = null
          render()
          break
        case 'usage-drill':
          state.usageBot = target.dataset.botId || null
          state.usageScope = 'bot'
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
      syncComposerBox(el)
      updateAutocomplete()
    }
    if (el.id === 'task-search') {
      state.taskFilter.search = el.value
    }
    if (el.id === 'memory-search') {
      state.memoryQuery = el.value
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
      return
    }
    if (event.target.id === 'memory-search' && event.key === 'Enter') {
      event.preventDefault()
      void searchMemories()
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
