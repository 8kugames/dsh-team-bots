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
    view: ['chat', 'solo-config', 'tasks', 'bots', 'skills', 'memory', 'evolution', 'usage', 'terminal', 'settings', 'global'].includes(initialView) ? initialView : 'chat',
    projectId: params.get('project') || null,
    chatMode: 'group',
    soloBotId: null,
    soloDetail: null,
    modal: null,
    // 草稿按上下文分开记（群聊 group:<projectId>、单聊 solo:<botId>），切换互不覆盖、互不清空。
    chatDrafts: {},
    // composer 手动拖高后的像素高度；null = 自动高度（随内容长高，上限 150px）。
    composerHeight: null,
    // 群聊引用回复：{ id, senderName, excerpt }，非空时 composer 上方显示引用条，随发送/取消清除。
    replyTo: null,
    // 聊天历史分片（DSHBOTS-33）：state 轮询只回最后 200 条，更早的经 messages_page 手动加载后存这里。
    // key 与当前会话对齐（group:<projectId> / solo:<botId>），切会话即失效重置；items 与轮询结果按 id 去重合并。
    chatOlder: { key: null, items: [], hasMore: false, loading: false },
    // 折叠面板（<details data-panel>）展开态的 key 集合，toggle 时增删；render 全量重建后据此恢复 open 属性。
    openPanels: new Set(),
    ac: null,
    busy: 0,
    chatAtBottom: true,
    taskFilter: { status: 'all', assignee: 'all', search: '', timeRange: '7d' },
    memoryFilter: 'all',
    usageScope: 'global',
    usageBot: null,
    memoryQuery: '',
    memoryResults: null,
    theme: 'dsh',
    tree: { chats: true, bots: true, archived: false },
    // 群聊已读水位：`<projectId>:<最新消息时间>`，用于避免重复上报已读。
    markedRead: null,
    bootError: null,
    wechatAuth: null,
    wechatPollTimer: null,
    terminalDraft: '',
    terminalPollTimer: null,
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
  // 调度页「正在调度」列表用的运行类型名；未知 kind 直接显示原值，不静默吞掉。
  const RUN_KIND = {
    task_run: '任务运行',
    owner_task_run: '总监任务',
    solo_chat_run: '单聊回复',
    chat_run: '群聊运行',
    dm_run: '私信运行',
    dm_reply: '私信回复',
    memory_review: '记忆复核',
  }
  // 聊天历史分片大小：与后端 messagesPage 的默认/上限一致（state 轮询同口径）。
  const CHAT_PAGE_SIZE = 200
  // 群聊右栏「活跃任务」列表显示上限：标题右侧计数仍显示项目在办任务总数，超出部分用「还有 N 条」提示。
  const CHAT_ACTIVE_TASK_LIMIT = 9
  const SKILL_STATUS = { active: '启用中', missing: '已失效' }
  const MEMORY_STATUS = { active: '已生效', pending: '待审', frozen: '已冻结', rejected: '已拒绝', archived: '已归档' }
  const PROPOSAL_KIND = { bot_update: 'Bot 更新', skill: '技能更新', workflow: '流程更新' }
  const TERMINAL_STATUS = { running: '运行中', succeeded: '已完成', failed: '失败', timeout: '超时', canceled: '已停止', interrupted: '已中断' }
  const CREATOR_TYPE = { bot: 'Bot', user: '用户' }
  const EFFORT = { minimal: '最低', low: '低', medium: '中', high: '高', max: '最高' }
  const FILE_POLICY = { 'read-only': '只读', 'workspace-write': '工作区内修改', 'danger-full-access': '完全访问' }
  const DEFAULT_FILE_POLICY = 'workspace-write'
  function filePolicyOptions(current) {
    const value = FILE_POLICY[current] ? current : DEFAULT_FILE_POLICY
    return Object.entries(FILE_POLICY).map(([id, label]) => `<option value="${attr(id)}" ${value === id ? 'selected' : ''}>${esc(label)}</option>`).join('')
  }
  // The one action in the top-right belongs to the page you are on.
  const VIEW_ACTION = {
    tasks: { label: '新建任务', action: 'new-task', icon: 'plus' },
    memory: { label: '写入记忆', action: 'new-memory', icon: 'plus' },
    skills: { label: '新建提案', action: 'new-proposal', icon: 'plus', kind: 'skill' },
    settings: { label: '保存设置', icon: 'check', submit: 'project-settings-form' },
    'solo-config': { label: '保存配置', icon: 'check', submit: 'solo-config-form' },
  }
  const NAV = [
    ['chat', '群聊', 'message'],
    ['tasks', '任务', 'board'],
    ['members', '成员', 'users'],
    ['skills', '技能', 'spark'],
    ['memory', '记忆', 'memory'],
    ['evolution', '进化', 'branch'],
    ['usage', '用量', 'chart'],
    ['terminal', '终端', 'terminal'],
    ['settings', '设置', 'settings'],
  ]
  // 1V1 上下文的导航：调度窗口 + 集中配置页 + 团队级页面（技能/记忆/进化/用量）。
  // 首个 tab 展示名是「调度」——单聊页已升级为调度页（对话 + 任务 + 运行一览）。
  const SOLO_NAV = [
    ['chat', '调度', 'message'],
    ['solo-config', '配置', 'settings'],
    ['skills', '技能', 'spark'],
    ['memory', '记忆', 'memory'],
    ['evolution', '进化', 'branch'],
    ['usage', '用量', 'chart'],
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
    reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    // 引用标记：两枚引号（lucide quote 标准路径，水平镜像成「“」开口式，描边加粗到 2.2，
    // 保证 14px 下仍可辨），与「返回/滚回」的回转箭头彻底区分。
    quote: '<g transform="translate(24 0) scale(-1 1)" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></g>',
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
  // 1V1 单聊上下文（对话/配置/技能/记忆/进化/用量）不携带任何项目，页面呈现团队全局口径。
  const inSoloContext = () => state.chatMode === 'solo' || state.view === 'solo-config'
  const pageProject = () => (inSoloContext() ? null : activeProject())
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
  // 成员/总监状态点：红黄绿三色——空闲绿、运行中黄（且仅此态闪烁）、失败红（含限流等待）。
  // 排队中按空闲处理（绿、不闪），只有真正 running 才闪。
  function memberRunDot(member) {
    const status = member?.run_status ?? 'idle'
    const phase = member?.run_phase ?? null
    const waitMin = member?.retry_wait_seconds ? Math.max(1, Math.round(member.retry_wait_seconds / 60)) : null
    if (status === 'running') {
      return phase === 'running'
        ? { cls: 'running', status: 'running', text: '运行中' }
        : { cls: 'idle', status: 'queued', text: '排队中（按空闲计）' }
    }
    if (status === 'plan_wait') return { cls: 'plan-wait', status: 'plan_wait', text: `限流等待，约 ${waitMin} 分钟后自动重试` }
    if (status === 'failed') return { cls: 'failed', status: 'failed', text: '最近运行失败' }
    return { cls: 'idle', status: 'idle', text: '空闲' }
  }
  function runDotHtml(dot) {
    return `<span class="run-dot ${dot.cls}" data-status="${dot.status}" title="${esc(dot.text)}" aria-label="${esc(dot.text)}"></span>`
  }
  function memorySource(source) {
    const value = String(source ?? '')
    if (!value) return '手动写入'
    if (value === 'chat-command') return '群聊指令'
    if (value.startsWith('run:')) return '运行沉淀'
    if (value.startsWith('session:')) return '会话沉淀'
    return '自动沉淀'
  }

  // markdown-render:start —— 聊天 markdown 渲染纯逻辑（tests/markdown.test.js 抽取此块断言）。
  // 管线固定：md → mdRewriteImageSources → marked.parse → DOMPurify.sanitize → innerHTML。
  // 消毒不可绕：marked 或 DOMPurify 缺席、或 DOMPurify.isSupported=false（node/损坏安装）时
  // mdCreateRenderer 返回 null，调用方回退 esc 纯文本，绝不裸插 HTML。
  // 工作区图片路径改写成 GET /api/dsh-team/file（服务端再做 MIME 白名单与防穿越）。
  const MD_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i
  function mdImageFileUrl(href, scope) {
    if (!scope || !href) return null
    const raw = String(href)
    // 只改写本地路径形态；http(s)/data:/锚点等协议引用原样交给消毒层。
    if (MD_SCHEME.test(raw)) return null
    let rel = raw
    const root = scope.root ? String(scope.root).replace(/\/+$/, '') : ''
    if (root && raw.startsWith(`${root}/`)) rel = raw.slice(root.length + 1)
    else if (raw.startsWith('/')) rel = raw.replace(/^\/+/, '')
    // 只剥前导 "./"，不剥 "../"——越界段留给下面统一拒绝。
    else rel = raw.replace(/^(?:\.\/)+/, '')
    if (!rel || rel.split('/').includes('..')) return null
    const params = new URLSearchParams()
    if (scope.projectId) params.set('projectId', scope.projectId)
    else if (scope.soloBotId) params.set('soloBotId', scope.soloBotId)
    else return null
    params.set('path', rel)
    return `/api/dsh-team/file?${params.toString()}`
  }
  function mdRewriteImageSources(source, scope) {
    return String(source ?? '').replace(/(!\[[^\]]*\]\()\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (whole, lead, href) => {
      const url = mdImageFileUrl(href, scope)
      return url ? `${lead}${url})` : whole
    })
  }
  function mdCreateRenderer(deps) {
    const { marked, DOMPurify } = deps ?? {}
    if (typeof marked?.parse !== 'function') return null
    if (typeof DOMPurify?.sanitize !== 'function' || DOMPurify.isSupported === false) return null
    // 外链统一新窗口 + noopener：afterSanitizeAttributes 原生配方，随消毒管线走，不经手拼 HTML。
    if (typeof DOMPurify.addHook === 'function') {
      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node?.tagName !== 'A' || typeof node.getAttribute !== 'function' || !node.getAttribute('href')) return
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      })
    }
    return function renderMarkdown(body, scope) {
      const html = marked.parse(mdRewriteImageSources(body, scope), { gfm: true, breaks: true })
      return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
    }
  }
  // markdown-render:end

  // 真实依赖来自 vendor 脚本（见 index.html）；缺席时 mdRender 为 null，richText 走纯文本兜底。
  const mdRender = mdCreateRenderer({ marked: window.marked, DOMPurify: window.DOMPurify })
  function richText(value, scope) {
    if (mdRender) return mdRender(value, scope)
    return `<p>${esc(value).replaceAll('\n', '<br>')}</p>`
  }

  // 聊天图片的工作区指向：群聊=当前项目工作区，单聊=Bot 专属工作区；root 供绝对路径归一。
  function mdChatScope() {
    if (inSoloContext()) {
      const bot = botById(state.soloBotId)
      return bot?.soloWorkspace ? { soloBotId: bot.id, root: bot.soloWorkspace } : null
    }
    const project = pageProject()
    return project ? { projectId: project.id, root: project.workspace_path } : null
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

  // IM 式已读：群聊可见时把水位推到最后一条消息，服务端据此算未读数。
  // 只在群聊视图上报；切到任务/设置等 tab 不算数。
  async function markVisibleChatRead(data) {
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

  async function loadState(projectId = state.projectId, { quiet = false } = {}) {
    // 仅单聊场景携带 soloBotId，避免把单聊口径的 runs/memories 泄漏进群聊视图。
    const data = await api('state', { projectId: projectId || undefined, soloBotId: state.chatMode === 'solo' ? state.soloBotId : undefined }, { quiet })
    state.data = data
    await markVisibleChatRead(data)
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
    // 场景分支：单聊上下文的统计口径 = 该 Bot 的单聊运行；群聊上下文 = 当前项目。
    const project = solo ? null : activeProject()
    const soloRuns = solo ? (state.data?.solo?.runs ?? []) : []
    const pending = pendingProposals()
    const running = solo
      ? soloRuns.filter(run => run.status === 'running' || run.status === 'queued').length
      : (project?.stats?.running ?? 0)
    const tokenTotal = usageTotals('project').totalTokens ?? 0
    const isGlobal = state.view === 'global'
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
      : state.view === 'bots' ? '全部 Bots'
      : state.view === 'skills' ? '技能池'
      : state.view === 'memory' ? '团队记忆'
      : state.view === 'evolution' ? '进化提案'
      : state.view === 'usage' ? '资源用量'
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
            <button class="global-config ${isGlobal ? 'active' : ''}" data-action="nav" data-view="global">
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
            ${(inSolo ? SOLO_NAV : NAV).map(([key, label]) => {
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

  function render() {
    if (!state.data) return
    state.ac = null
    app.className = ''
    const hadModal = Boolean(document.querySelector('.modal'))
    const previousFocus = document.activeElement
    // chat-scroll-restore:mark —— render() 全量重建 DOM，非贴底时先记下消息列表滚动位置，重建后原位恢复；
    // 2.8s 轮询重渲染因此不再把上翻历史的用户拽回顶部；贴底（chatAtBottom）仍走下方 rAF 自动落底。
    const savedChatScroll = document.querySelector('.chat-messages')?.scrollTop ?? null
    const savedViewScroll = captureViewScroll(lastRenderedView === state.view)
    app.innerHTML = renderShell()
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
    })
    syncTerminalPoll()
  }

  function renderView() {
    const body = (() => {
      switch (state.view) {
        case 'tasks': return renderTasks()
        case 'bots': return renderBots()
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
              <span class="reply-bar-text"><strong>${esc(state.replyTo.senderName)}</strong><span>${esc(state.replyTo.excerpt)}</span></span>
              <button class="reply-bar-cancel" data-action="cancel-reply" title="取消引用（Esc）" aria-label="取消引用">${icon('close')}</button>
            </div>` : ''}
            <div class="composer-box">
              <div class="composer-ac" id="composer-ac" role="listbox" aria-label="输入补全" hidden></div>
              <div class="composer-resizer" id="composer-resizer" title="拖动调整输入框高度，双击恢复自动高度" role="separator" aria-orientation="horizontal" aria-label="拖动调整输入框高度，双击恢复自动高度"></div>
              <textarea id="composer-input" rows="2" placeholder="给团队发消息，或输入 /task @Bot 任务标题">${esc(currentDraft(state))}</textarea>
              <div class="composer-bottom">
                <span class="composer-hint"><kbd>⌘</kbd><kbd>Enter</kbd> 发送</span>
                <button class="send-btn" data-action="send-message" ${currentDraft(state).trim() ? '' : 'disabled'} title="发送" aria-label="发送消息">${icon('send')}</button>
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
              <div class="composer-resizer" id="composer-resizer" title="拖动调整输入框高度，双击恢复自动高度" role="separator" aria-orientation="horizontal" aria-label="拖动调整输入框高度，双击恢复自动高度"></div>
              <textarea id="composer-input" rows="2" placeholder="和 ${esc(bot.name)} 对话，/clear 清空本会话，/remember 内容 写入 Bot 记忆">${esc(currentDraft(state))}</textarea>
              <div class="composer-bottom">
                <span class="composer-hint"><kbd>⌘</kbd><kbd>Enter</kbd> 发送</span>
                <button class="send-btn" data-action="send-message" ${currentDraft(state).trim() ? '' : 'disabled'} title="发送" aria-label="发送消息">${icon('send')}</button>
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
    // 引用块：气泡顶部一行「❝ 名字：摘要」，纯展示。
    const quoteBlock = message.reply_to ? `<div class="msg-quote" title="引用自 ${attr(message.reply_to.sender_name)}">${icon('quote')}<span>${esc(message.reply_to.sender_name)}：${esc(message.reply_to.excerpt)}</span></div>` : ''
    // hover 引用按钮：仅群聊；点击进入引用回复（选中该消息作为回复目标）。
    const quoteBtn = state.chatMode === 'group' ? `<button class="msg-quote-btn" data-action="quote-message" data-message-id="${attr(message.id)}" data-sender-name="${attr(message.senderName)}" data-excerpt="${attr(message.body.slice(0, 120))}" title="引用回复" aria-label="引用回复这条消息">${icon('quote')}</button>` : ''
    // hover 复制按钮：群聊/单聊都有，紧邻引用按钮右侧；复制消息原文 message.body（非渲染后 HTML），走统一 copy handler。
    const copyBtn = `<button class="msg-copy-btn" data-action="copy" data-copy="${attr(message.body)}" title="复制消息" aria-label="复制这条消息的原文">${icon('copy')}</button>`
    // 任务/思考过程 chip 合并同一行：固定顺序「思考过程 → 任务」，缺哪个不留空位。
    const trajChip = message.run_id && !isUser ? `<button class="task-chip" data-action="open-trajectory" data-run-id="${attr(message.run_id)}">思考过程</button>` : ''
    const taskChip = message.taskIdentifier ? `<button class="task-chip" data-action="open-task" data-task-id="${attr(message.task_id)}" title="${attr(message.taskTitle ?? '')}"><strong>${esc(message.taskIdentifier)}</strong></button>` : ''
    const chipsLine = trajChip || taskChip ? `<div class="task-chip-line">${trajChip}${taskChip}</div>` : ''
    return `<div class="message-row ${isUser ? 'user' : ''}">
      ${isUser ? '' : avatar(bot ?? { name: message.senderName, color: 'gray' })}
      <div class="message-body-wrap">
        <div class="message-meta"><strong>${esc(message.senderName)}</strong><span>${esc(formatTime(message.created_at))}</span>${quoteBtn}${copyBtn}</div>
        <div class="message-bubble">${quoteBlock}${richText(message.body, mdChatScope())}</div>
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
  // task-sort:end

  // task-time-range:start —— 终态时间筛选（DSHBOTS-44）：只作用于终态任务（done/canceled），
  // 按各自终态时间戳（completed_at / canceled_at）与窗口下限比较；非终态任务不受影响照常显示。
  // 终态但缺时间戳（极老数据）在窗口模式下视为窗口外——无法证明在窗口内就不默认放行。
  const TASK_TIME_RANGES = { '7d': 7 * 86_400_000, all: 0 }
  function taskEndsOutsideRange(task, timeRange) {
    if (timeRange === 'all') return false
    if (task.status !== 'done' && task.status !== 'canceled') return false
    const field = task.status === 'done' ? 'completed_at' : 'canceled_at'
    const endedAt = task[field] ? new Date(task[field]).getTime() : NaN
    return !(Number.isFinite(endedAt) && endedAt >= Date.now() - (TASK_TIME_RANGES[timeRange] ?? 0))
  }
  // task-time-range:end

  function filteredTasks() {
    const filter = state.taskFilter
    return sortTasksByPriority((state.data?.tasks ?? []).filter(task => {
      if (filter.status !== 'all' && task.status !== filter.status) return false
      if (filter.assignee !== 'all' && task.assignee_bot_id !== filter.assignee) return false
      if (taskEndsOutsideRange(task, filter.timeRange)) return false
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
          <select class="select" data-task-filter="timeRange" aria-label="按终态时间筛选">
            <option value="7d" ${state.taskFilter.timeRange !== 'all' ? 'selected' : ''}>近 7 天</option>
            <option value="all" ${state.taskFilter.timeRange === 'all' ? 'selected' : ''}>全部时间</option>
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

  // task-card:start —— 任务卡运行徽标（DSHBOTS-42）：文案来自后端 taskStage 纯函数查表的 stageLabel，
  // 不再从 latestRun.status 拼映射。终态（done/canceled → stage 'ended'）一律不渲染任何运行徽标：
  // 状态点、运行文案、计时与 running 高亮全部隐藏，已完成/已取消任务上挂着的遗留运行不再误导看板。
  function renderTaskCard(task) {
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
    return `<article class="task-card${isRunning ? ' running' : ''}" draggable="true" data-task-id="${attr(task.id)}" data-action="open-task">
      <div class="task-card-top">
        <span class="task-id">${esc(task.identifier)}</span>
        <span class="task-priority">${esc(PRIORITY[taskPriorityKey(task.priority)])}</span>
      </div>
      <div class="task-card-title" title="${attr(task.title)}">${esc(task.title)}</div>
      ${tags.length ? `<div class="task-tags">${tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}</div>` : ''}
      <div class="task-card-foot">
        ${!ended && run ? runDot(run.status) : ''}
        <span class="task-run-label">${runLabel}</span>
        ${isRunning ? `<span class="run-clock" data-started="${attr(run.started_at ?? '')}">${duration(run.started_at)}</span>` : ''}
        ${endAt ? `<span class="task-end-time" title="${attr(endAt)}">${icon('check')} ${formatTime(endAt)}</span>` : ''}
        ${bot ? avatar(bot, 'sm') : '<span class="faint">未指派</span>'}
      </div>
    </article>`
  }
  // task-card:end

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
        ${taskBusy ? `<div class="terminal-warn">${icon('alert')}<span>有任务正在写该项目工作区，终端命令与它并发需自担风险</span></div>` : ''}
        <div class="card terminal-card${active ? ' is-running' : ''}">
          <div class="terminal-chrome">
            <span class="terminal-chrome-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="terminal-chrome-label">终端</span>
            <span class="terminal-chrome-path" title="${attr(project.workspace_path ?? '')}">${esc(project.workspace_path ?? project.name)}</span>
          </div>
          <form class="terminal-input-row" data-form="terminal-run">
            <input type="hidden" name="projectId" value="${attr(project.id)}">
            <span class="terminal-prompt" aria-hidden="true">$</span>
            <input class="input terminal-input" id="terminal-cmd-input" name="command" placeholder="${active ? '有命令正在运行…' : '输入命令'} " value="${attr(state.terminalDraft)}" autocomplete="off" autocapitalize="off" spellcheck="false" ${active ? 'disabled' : ''}>
            ${active ? '' : '<span class="terminal-kbd" aria-hidden="true">⌘ / Ctrl ↵</span>'}
            <button class="btn primary" type="submit" ${active ? 'disabled' : ''}>${icon('play')}<span class="btn-label">执行</span></button>
          </form>
          ${active ? `<div class="terminal-active-row">
            ${runDot('running')}
            <code class="terminal-active-cmd">${esc(active.command)}</code>
            <span class="run-clock" data-started="${attr(active.createdAt ?? '')}">${duration(active.createdAt)}</span>
            <button class="btn danger terminal-stop" data-action="terminal-stop" data-command-id="${attr(active.id)}">${icon('stop')}<span class="btn-label">停止</span></button>
          </div>` : ''}
          <pre class="terminal-output" id="terminal-output" data-command-id="${attr(latest?.id ?? '')}">${output ? esc(output) : '<span class="faint">暂无输出。执行一条命令后，这里显示实时输出（最多保留末尾 200KB）。</span>'}</pre>
        </div>
        <div class="card terminal-history-card">
          <div class="terminal-history-head"><strong>历史命令</strong><span class="tag">${terminal.history.length} 条</span></div>
          ${terminal.history.length === 0 ? '<div class="side-empty" style="padding:14px 16px">还没有执行过命令。</div>' : `<div class="terminal-history">
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

  // 项目成员管理页：状态与用量均按当前项目聚合（busy=本项目有排队/运行中运行；
  // usage 四项与 cost 为该项目全部运行的累计）。邀请走 add_member API，移除走 remove_member。
  function renderMembers() {
    const project = activeProject()
    if (!project) return noProject()
    const members = project.members ?? []
    const memberIds = new Set(members.map(member => member.id))
    const candidates = (state.data?.bots ?? []).filter(bot => bot.status === 'active' && !memberIds.has(bot.id))
    return `
      <div class="section-head">
        <p>成员状态与用量按本项目口径聚合；移除后该 Bot 不再接收本项目的提及与新任务。</p>
        <div class="btn-row">
          <select class="select" id="invite-bot" aria-label="选择要邀请的 Bot">
            ${candidates.length === 0 ? '<option value="">没有可邀请的 Bot</option>' : candidates.map(bot => `<option value="${attr(bot.id)}">${esc(bot.name)} · ${esc(bot.role || '成员')}</option>`).join('')}
          </select>
          <button class="btn" data-action="add-member" ${candidates.length === 0 ? 'disabled' : ''}>${icon('plus')}邀请加入</button>
          <button class="btn" data-action="nav" data-view="bots" title="查看全部 Bot 或新建">${icon('bot')}全部 Bots</button>
        </div>
      </div>
      <div class="card list-card">
        ${members.map(member => {
          const bot = botById(member.id)
          if (!bot) return ''
          const dot = memberRunDot(member)
          const isOwner = member.member_role === 'owner' || member.id === project.owner_bot_id
          const tokens = Number(member.usage_input ?? 0) + Number(member.usage_cache_read ?? 0) + Number(member.usage_cache_write ?? 0) + Number(member.usage_output ?? 0)
          const modelRef = member.modelRef ?? bot.modelRef ?? bot.model ?? null
          const modelLine = modelRef ? String(modelRef) : '未配置模型'
          return `
          <div class="list-row member-row" title="${esc(bot.name)} · ${esc(bot.role || '成员')} · ${esc(dot.text)}">
            ${avatar(bot, 'sm')}
            <div class="list-main">
              <div class="list-title"><strong>${esc(bot.name)}</strong>${isOwner ? '<span class="pill violet">总监</span>' : `<span class="member-role">${esc(bot.role || '成员')}</span>`}<span class="member-model">${esc(modelLine)}</span></div>
              <div class="list-meta">
                <span>输入 ${formatNumber(member.usage_input)} · 缓存读 ${formatNumber(member.usage_cache_read)} · 缓存写 ${formatNumber(member.usage_cache_write)} · 输出 ${formatNumber(member.usage_output)}</span>
                <span>合计 <strong>${formatNumber(tokens)}</strong> tokens · <strong>${formatCost(Number(member.usage_cost ?? 0))}</strong></span>
              </div>
            </div>
            <div class="btn-row">
              <span class="pill ${member.busy ? 'amber' : 'green'}">${member.busy ? '任务中' : '空闲中'}</span>
              ${runDotHtml(dot)}
              ${isOwner ? '' : `<button class="btn small" data-action="remove-member" data-bot-id="${attr(member.id)}">移除</button>`}
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
    const all = state.data?.memories ?? []
    // 单聊上下文没有项目记忆：把群聊遗留的「项目记忆」筛选回退为全部作用域。
    const filter = inSoloContext() && state.memoryFilter === 'project' ? 'all' : state.memoryFilter
    const memories = all.filter(memory => filter === 'all' || memory.scope_type === filter)
    const pending = pendingMemoryCount()
    const results = state.memoryResults
    return `
      ${(state.data?.memories ?? []).length === 0 ? '' : `<div class="board-toolbar">
        <select class="select" id="memory-filter" aria-label="按作用域筛选记忆">
          <option value="all" ${filter === 'all' ? 'selected' : ''}>全部作用域</option>
          ${inSoloContext() ? '' : `<option value="project" ${filter === 'project' ? 'selected' : ''}>项目记忆</option>`}
          <option value="bot" ${filter === 'bot' ? 'selected' : ''}>Bot 记忆</option>
          <option value="team" ${filter === 'team' ? 'selected' : ''}>团队记忆</option>
        </select>
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
    const project = pageProject()
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
    const project = pageProject()
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
      ${Number(reconciliation?.mismatched ?? 0) > 0 ? `<div class="usage-note">${Number(reconciliation.mismatched)} 次运行的用量记录对不上，数据可能不完整。</div>` : ''}
      ${usage.legacy ? '<div class="usage-note">服务端尚未按口径过滤明细，下方分组仍是全局数据。</div>' : ''}
      <div class="usage-grid">
        <div class="card usage-panel">
          <div class="card-head"><h3>按 Bot</h3><span class="meta">${byBot.length} 个</span></div>
          ${byBot.length === 0 ? '<div class="faint">暂无调用记录。</div>' : `<div class="bar-list">${byBot.map(item => botRow(item, maxBot)).join('')}</div>`}
        </div>
        <div class="card usage-panel">
          <div class="card-head"><h3>${scope === 'global' ? '按项目' : scope === 'project' ? '按模型' : '运行记录'}</h3>${drillBot ? `<button class="btn small" data-action="usage-clear-drill">${icon('close')}清除选择</button>` : ''}</div>
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
          <div class="usage-note">未配置价格的成本不会按 0 计费；价格按每百万 token 配置。</div>
        </div>
      </div>
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
      footer: `<button class="btn" data-action="close-modal">关闭</button><button class="btn" type="button" data-action="run-task" data-task-id="${attr(task.id)}">${icon('play')}保存并运行</button><button class="btn primary" type="submit" form="task-form">${icon('check')}保存</button>`,
    })
  }

  function modalMemory(memory) {
    const project = pageProject()
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
    if (button) button.disabled = input.value.trim() === ''
  }

  async function sendMessage() {
    const body = currentDraft(state).trim()
    if (!body) return
    closeAutocomplete()
    try {
      let result
      if (state.chatMode === 'solo') {
        const bot = botById(state.soloBotId)
        if (!bot) return
        if (body === '/clear' && !window.confirm(`清空和 ${bot.name} 的全部对话记录？清除后不可恢复（记忆保留）。`)) return
        result = await api('send_solo_message', { botId: bot.id, body })
      } else {
        const project = activeProject()
        if (!project) return
        if (body === '/clear' && !window.confirm('清空本群全部聊天记录？清除后不可恢复（任务与记忆保留）。')) return
        // 引用回复：带上 replyTo；命令路径（/clear、/task、/remember）后端会忽略该参数。
        result = await api('send_message', { projectId: project.id, body, ...(state.replyTo ? { replyTo: state.replyTo.id } : {}) })
      }
      state.chatDrafts[draftKey(state)] = ''
      state.replyTo = null
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
        case 'nav': {
          // 带 data-project-id 的导航：从调度页的任务行跳到该项目的任务页（顺带切回群聊上下文）。
          const navProjectId = target.dataset.projectId
          state.view = target.dataset.view || 'chat'
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
        case 'add-member': {
          const select = document.getElementById('invite-bot')
          const botId = select?.value
          if (!botId) break
          await api('add_member', { projectId: activeProject()?.id, botId })
          await refresh()
          toast('已邀请加入项目', 'success')
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
        const common = {
          name: payload.name,
          role: payload.role,
          instructions: payload.instructions,
          color: payload.color,
          provider,
          model,
          effort: payload.effort || null,
          filePolicy: payload.filePolicy || undefined,
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
    if (el.id === 'secret-scope') {
      const projectSelect = document.getElementById('secret-project')
      if (projectSelect) {
        projectSelect.disabled = el.value !== 'project'
        if (el.value !== 'project') projectSelect.value = ''
      }
    }
  })

  document.addEventListener('scroll', (event) => {
    if (event.target.classList?.contains('chat-messages')) {
      const el = event.target
      state.chatAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
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
})()
