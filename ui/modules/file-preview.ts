import { state } from './state.js'
import { attr, esc } from './util.js'
import { t } from './i18n.js'
import { modalShell, renderModalLayer } from './modal-layer.js'
import { mdChatScope, richText } from './markdown.js'

// file-preview-logic:start —— 文本预览纯逻辑（tests/file-preview.test.js 抽取此块断言）。
// 白名单与后端 chatFile 的文本扩展同口径；SVG 可执行脚本、.env 常带密钥，永不入列。
const FILE_TEXT_EXT = /\.(md|markdown|txt|log|json|csv|ini|toml|yaml|yml|ts|tsx|js|mjs|cjs|jsx|css|html|htm|sh|xml|py|sql)$/i
const PREVIEW_MAX_CHARS = 256 * 1024
const PREVIEW_MAX_LINES = 2000
function isPreviewableText(path) {
  return FILE_TEXT_EXT.test(String(path ?? ''))
}
// markdown 扩展走渲染预览（richText 管线），与纯文本展示分开。
const FILE_MD_EXT = /\.(md|markdown)$/i
function isMarkdownPath(path) {
  return FILE_MD_EXT.test(String(path ?? ''))
}
// 超限截断：256KB 与 2000 行先到先裁；弹层只提示，不改写内容本身。
function clipPreviewText(text) {
  const source = String(text ?? '')
  let body = source.length > PREVIEW_MAX_CHARS ? source.slice(0, PREVIEW_MAX_CHARS) : source
  const lines = body.split('\n')
  if (lines.length > PREVIEW_MAX_LINES) body = lines.slice(0, PREVIEW_MAX_LINES).join('\n')
  return { body, truncated: body.length < source.length }
}
// 交付产物 chip → /api/dsh-team/file（拼法与 markdown.ts mdImageFileUrl 同口径）；
// 绝对路径或含 .. 段不生成链接，越界交给服务端防穿越兜底。
function deliverableFileUrl(projectId, path) {
  const rel = String(path ?? '')
  if (!projectId || !rel || rel.startsWith('/') || rel.split('/').includes('..')) return null
  const params = new URLSearchParams()
  params.set('projectId', String(projectId))
  params.set('path', rel)
  return `/api/dsh-team/file?${params.toString()}`
}
// file-preview-logic:end

// 交付产物文件链接基建：图片走原 artifact-file 内联缩略，文本扩展改应用内预览。
const ARTIFACT_IMAGE = /\.(png|jpe?g|gif|webp)$/i
const artifactFileUrl = (runId, path) =>
  `/api/dsh-team/artifact-file?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`
const artifactExt = (path) =>
  (String(path).match(/\.([a-z0-9]+)$/i)?.[1] ?? 'file').toUpperCase().slice(0, 6)

// 文件预览弹层：文本走 textContent 通道；markdown 走与聊天气泡同一条 richText
// 消毒管线（marked → DOMPurify），不经手拼 HTML。footer 保留「新窗口打开」。
function modalFilePreview(modal) {
  const path = String(modal?.path ?? '')
  if (modal?.error) {
    return modalShell({
      title: path || t("文件预览"),
      body: `<div class="note">${t("加载文件失败：")}${esc(modal.error)}</div>`,
      footer: `<button class="btn" data-action="close-modal">${t("关闭")}</button>`,
      size: 'wide',
    })
  }
  return modalShell({
    title: path || t("文件预览"),
    subtitle: modal?.truncated ? t("文件较大，已截断，仅显示开头部分。") : '',
    body: modal?.kind === 'md'
      ? '<div class="comment-body" id="dsh-file-preview-md"></div>'
      : '<pre class="detail-pre" id="dsh-file-preview-pre"></pre>',
    footer: `<button class="btn" data-action="close-modal">${t("关闭")}</button><button class="btn" data-action="open-artifact" data-url="${attr(modal?.url ?? '')}">${t("新窗口打开")}</button>`,
    size: 'wide',
  })
}

// 正文水合：把已取回的内容写进占位节点。滚动守卫可能把补拍延后约 120ms，
// 首拍未命中节点时短重试，避免补拍后弹层空白。
function hydrateFilePreview(retry = 3) {
  if (state.modal?.type !== 'file-preview') return
  const isMd = state.modal.kind === 'md'
  const node = document.getElementById(isMd ? 'dsh-file-preview-md' : 'dsh-file-preview-pre')
  if (!node) {
    if (retry > 0) setTimeout(() => hydrateFilePreview(retry - 1), 150)
    return
  }
  if (isMd) node.innerHTML = richText(state.modal.content ?? '', mdChatScope())
  else node.textContent = state.modal.content ?? ''
}

async function openFilePreview(url, path) {
  if (!url) return
  const kind = isMarkdownPath(path) ? 'md' : 'text'
  state.modal = { type: 'file-preview', loading: true, kind, title: String(path ?? '').split('/').pop() || t("文件预览"), url, path }
  renderModalLayer()
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { body, truncated } = clipPreviewText(await res.text())
    state.modal = { type: 'file-preview', kind, url, path, content: body, truncated }
  } catch (error: any) {
    state.modal = { type: 'file-preview', kind, url, path, error: String(error?.message ?? error) }
  }
  renderModalLayer()
  hydrateFilePreview()
}

export { FILE_TEXT_EXT, isPreviewableText, clipPreviewText, deliverableFileUrl, ARTIFACT_IMAGE, artifactFileUrl, artifactExt, modalFilePreview, hydrateFilePreview, openFilePreview }
