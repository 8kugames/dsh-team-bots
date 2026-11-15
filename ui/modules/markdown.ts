import { state } from './state.js'
import { esc, inSoloContext, botById, pageProject } from './util.js'
import { t } from './i18n.js'

// markdown-render:start —— 聊天 markdown 渲染纯逻辑（tests/markdown.test.js 抽取此块断言）。
// 管线固定：md → mdRewriteImageSources → marked.parse → DOMPurify.sanitize → innerHTML。
// 消毒不可绕：marked 或 DOMPurify 缺席、或 DOMPurify.isSupported=false（node/损坏安装）时
// mdCreateRenderer 返回 null，调用方回退 esc 纯文本，绝不裸插 HTML。
// 工作区图片路径改写成 GET /api/dsh-team/file（服务端再做 MIME 白名单与防穿越）。
const MD_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i
// 图片语法内部：href 允许含空格（到标题或右括号前止），标题可为 "..." / '...' / (...)。
const MD_IMAGE = /(!\[[^\]]*\]\()([^)\n]*?)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
// 只剥尾部标题：含空格的路径若被标题正则误切会丢文件名，故仅匹配整段结尾的引号/括号标题。
const MD_IMAGE_TITLE = /\s+("[^"]*"|'[^']*'|\([^)]*\))$/
function mdImageTarget(inner) {
  const text = String(inner ?? '').trim()
  if (!text) return ''
  if (text.startsWith('<')) {
    const end = text.indexOf('>')
    if (end >= 0) return text.slice(1, end).trim()
  }
  const title = MD_IMAGE_TITLE.exec(text)
  return title ? text.slice(0, title.index) : text
}
function mdImageFileUrl(href, scope) {
  if (!scope || !href) return null
  let raw = String(href).trim()
  if (!raw) return null
  // 先还原转义再判定：%20 空格、%2F 斜杠都要按真实路径处理。
  try { raw = decodeURIComponent(raw) } catch { /* 非法转义保持原样 */ }
  // file:// URI 与 Windows 反斜杠都归一到工作区相对/绝对路径形态。
  raw = raw.replace(/^file:\/\//i, '').replace(/\\/g, '/')
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
  return String(source ?? '').replace(MD_IMAGE, (whole, lead, inner) => {
    const url = mdImageFileUrl(mdImageTarget(inner), scope)
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
  // 记忆缓存（DSHBOTS-167）：同一条正文 + 同一个 scope 只解析一次。
  // 整页重建每 2.8s 一次、点击切换再重建，200 条长消息若不缓存，每次都要重跑
  // marked + DOMPurify（实测 3.2KB 单条 ≈6.6ms，200 条可达秒级主线程阻塞）。
  // 有界 LRU：命中即删了重插把最近使用的顶到尾部，超限从最旧端淘汰。
  const MD_RENDER_CACHE_MAX = 1500
  const cache = new Map()
  // 键用 JSON 序列化而非分隔符拼接：正文里若出现分隔符，拼接会撞键。
  const cacheKey = (body, scope) =>
    JSON.stringify([String(body ?? ''), scope?.projectId ?? null, scope?.soloBotId ?? null, scope?.root ?? null])
  return function renderMarkdown(body, scope) {
    const key = cacheKey(body, scope)
    const hit = cache.get(key)
    if (hit !== undefined) {
      cache.delete(key)
      cache.set(key, hit)
      return hit
    }
    const html = marked.parse(mdRewriteImageSources(body, scope), { gfm: true, breaks: true })
    const safe = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
    cache.set(key, safe)
    if (cache.size > MD_RENDER_CACHE_MAX) cache.delete(cache.keys().next().value)
    return safe
  }
}
// markdown-render:end

// @ts-ignore 真实依赖来自 vendor 脚本（见 index.html）；缺席时 mdRender 为 null，richText 走纯文本兜底。
const mdRender = mdCreateRenderer({ marked: window.marked, DOMPurify: window.DOMPurify })
export function richText(value, scope) {
  if (mdRender) return mdRender(value, scope)
  return `<p>${esc(value).replaceAll('\n', '<br>')}</p>`
}

// quote-summary:start —— 引用摘要纯文本化（tests/quote-ui.test.js 抽取此块断言）。
// 引用块与引用回复条展示的是「原文前 120 字」，原文可能带 markdown 记号（**、-、`、[]()）。
// 记号原样塞进气泡会既被当字面量显示，又让整条摘要挤成一行、撑破气泡宽度，
// 所以先把 markdown 记号剥成纯文本，再交给 UI 单行省略。
function mdPlainSummary(value, max = 120) {
  const text = String(value ?? '')
    .replace(/```[^\n`]*\n?/g, ' ')             // 围栏代码块：只去掉围栏标记，留内容
    .replace(/`([^`]*)`/g, '$1')                // 行内代码：留内容
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')   // 图片：留 alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // 链接：留文字
    .replace(/^\s{0,3}>\s?/gm, '')              // 引用行标记
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')         // 标题标记
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, '') // 列表标记
    .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, ' ')  // 分隔线
    .replace(/\*\*\*|\*\*|__|~~/g, '')          // 强调与删除线记号
    .replace(/\*([^*\n]+)\*/g, '$1')            // 斜体
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2') // 下划线斜体（不碰 snake_case）
    .replace(/`/g, '')                          // 落单反引号
    .replace(/\s+/g, ' ')
    .trim()
  const limit = Math.max(0, Number(max) || 0)
  if (!limit || text.length <= limit) return text
  return `${text.slice(0, limit - 1)}…`
}
// quote-summary:end
// 导出声明放标记块外：块内保持与 app.js 原文一致，tests/quote-ui.test.js 用 new Function 求值块体。
export { mdPlainSummary }

// 聊天图片的工作区指向：群聊=当前项目工作区，单聊=Bot 专属工作区；root 供绝对路径归一。
export function mdChatScope() {
  if (inSoloContext()) {
    const bot = botById(state.soloBotId)
    return bot?.soloWorkspace ? { soloBotId: bot.id, root: bot.soloWorkspace } : null
  }
  const project = pageProject()
  return project ? { projectId: project.id, root: project.workspace_path } : null
}

// 图片失败 chip 的原因诊断：src 未被改写成文件端点（路径形态没接住，浏览器按页面 URL 解析）
// 与已改写但端点拒绝分开；已改写的再探一次状态码，403/404 直接写进 chip title。
export function mdImageChipTitle(chip, img) {
  const src = img.getAttribute('src') ?? ''
  let rewritten = false
  try { rewritten = new URL(src, location.href).pathname === '/api/dsh-team/file' } catch { /* 解析失败按未改写 */ }
  // 外链图片失败与本地路径漏改写是两回事：前者只给通用提示，后者才指路改用工作区相对路径。
  if (!rewritten) return /^(?:https?:|data:)/i.test(src) ? t('chat.imageMissingHint') : t('chat.imageMissingUnrewritten')
  void fetch(src)
    .then((res) => {
      if (res.ok) return
      chip.title = res.status === 403 ? t('chat.imageMissingForbidden')
        : res.status === 404 ? t('chat.imageMissingNotFound')
          : t('chat.imageMissingHint')
    })
    .catch(() => {})
  return t('chat.imageMissingHint')
}
