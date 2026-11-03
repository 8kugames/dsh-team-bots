import { state } from './state.js'
import { esc, inSoloContext, botById, pageProject } from './util.js'

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
