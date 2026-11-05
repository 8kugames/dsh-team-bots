// composer.js —— 输入区域：@ 自动补全、草稿、图片附件、消息图片渲染与查看器、
// 输入框高度自适应、发送消息与任务表单提交。
import { state } from './state.js'
import { icon } from './icons.js'
import { activeProject, attr, avatar, botById, esc, initials, toast } from './util.js'
import { api, loadState } from './api.js'
import { applyOptimisticTyping } from './typing-linger.js'
import { t } from './i18n.js'
import { app, renderShell, renderKeepingChatScroll, render } from '../app.js'
import { flushAppRender } from './modal-layer.js'

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
  const input = document.getElementById('composer-input') as HTMLInputElement
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
  const input = document.getElementById('composer-input') as HTMLInputElement
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
  for (const file of Array.from(files ?? []) as File[]) {
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
  for (const item of rejected) toast(t('toast.fileRejected', { name: item.name || t('toast.fileFallback'), reason: item.reason }), 'error')
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
      toast(t('toast.fileReadFailed', { name: item.name || t('toast.fileFallback') }), 'error')
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
  return `<button type="button" class="attach-btn" data-action="attach-image"${full ? ' disabled' : ''} title="${t('composer.attachTitle')}" aria-label="${t('composer.attachLabel')}">${icon('image')}</button>`
}

// composer 的图片件：待发缩略图条（贴在输入框上方）+ 隐藏 file input（群聊/单聊共用）。
function composerImageStrip() {
  const pending = pendingImagesFor()
  if (pending.length === 0) return ''
  return `<div class="image-strip" id="image-strip">${pending.map(image => `
    <div class="image-thumb" data-image-key="${attr(image.key)}">
      <img class="image-thumb-img" src="${attr(image.previewUrl)}" alt="${attr(image.name || t('composer.imageAlt'))}" />
      <button class="image-thumb-remove" data-action="remove-pending-image" data-image-key="${attr(image.key)}" title="${t('composer.removeImageTitle')}" aria-label="${attr(t('composer.removeImageLabel', { name: image.name || '' }))}">${icon('close')}</button>
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
  let el = doc.getElementById('composer-image-input') as HTMLInputElement | null
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
  const tiles = Array.from(root.querySelectorAll('.msg-image-tile[data-image-id]') as NodeListOf<HTMLElement>)
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
  } catch (error: any) {
    body.textContent = error?.message || '图片加载失败'
  }
}

function closeImageViewer() {
  const viewer = document.getElementById('image-viewer')
  if (!viewer || viewer.hidden) return
  const img = viewer.querySelector('.image-viewer-img') as HTMLImageElement | null
  if (img?.src) {
    try { URL.revokeObjectURL(img.src) } catch {}
    img.removeAttribute('src')
  }
  viewer.hidden = true
  // 遮罩关闭：补上查看器开着期间被跳过的 #app 渲染（DSHBOTS-98）。
  flushAppRender()
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
// composer-flicker（DSHBOTS-153）：renderShell 全量重建出的新 textarea 没有内联高度，
// 轮询任务又常落在帧的 rAF 阶段之后，浏览器会先把「rows=2 内在高度」画出去，下一帧 rAF 里
// applyComposerHeight 才设回目标 px——空输入即每 2.8s 一次约半像素跳变，拖高/多行草稿放大为
// 数十像素闪一下。记住最近一次应用的 px，chat.js 的 composer 模板直接内联同值（活绑定），
// 重建帧与稳态帧高度一致；首次渲染前为 null，模板不输出 style。
let composerAppliedHeightPx = null
function applyComposerHeight(input) {
  input.style.height = 'auto'
  const auto = Math.min(COMPOSER_AUTO_MAX_PX, input.scrollHeight)
  const px = composerHeightFor(auto, state.composerHeight, composerPanelCap(input))
  input.style.height = `${px}px`
  composerAppliedHeightPx = px
}

function syncComposerBox(input) {
  state.chatDrafts[draftKey(state)] = input.value
  applyComposerHeight(input)
  const button = document.querySelector('[data-action="send-message"]') as HTMLButtonElement | null
  if (button) button.disabled = input.value.trim() === '' && pendingImagesFor().length === 0
}

// 双发防护（DSHBOTS-165）：⌘Enter 按键重复、双击发送按钮、慢网下重复点击都会在出站未完成时
// 再次进入 sendMessage，而旧实现草稿要等 api 成功才清空，同一草稿会被发出两遍。模块级在途
// 标志收口全部入口（发送按钮 / ⌘Enter / 自动补全回车）：在途时二次触发直接返回，finally 复位。
let sendInFlight = false

async function sendMessage() {
  if (sendInFlight) return
  const body = currentDraft(state).trim()
  const pending = pendingImagesFor()
  if (!body && pending.length === 0) return
  // 命令消息（/clear、/remember）后端不落图片：附件留不住，直接拦下并提示先移除。
  if (pending.length > 0 && (body === '/clear' || body.startsWith('/remember'))) {
    toast(t('toast.attachUnsupported'), 'error')
    return
  }
  const solo = state.chatMode === 'solo'
  const bot = solo ? botById(state.soloBotId) : null
  const project = solo ? null : activeProject()
  if (solo ? !bot : !project) return
  // 命令类消息保留原 confirm 拦截语义：取消即整体退出，草稿与附件原样不动。
  if (body === '/clear' && !window.confirm(solo ? `清空和 ${bot.name} 的全部对话记录？清除后不可恢复（记忆保留）。` : '清空本群全部聊天记录？清除后不可恢复（任务与记忆保留）。')) return
  // 待发图片随消息一起出站：mediaType + name + base64，字段口径与后端 normalizeImageInputs 一致。
  const images = pending.map(item => ({ mediaType: item.mediaType, name: item.name, data: item.data }))
  const key = draftKey(state)
  const replyTo = state.replyTo
  closeAutocomplete()
  let sent = false
  sendInFlight = true
  try {
    // 草稿乐观清空（原成功路径的清理前移到出站前）：窗口期内输入框已空、发送钮禁用，重复触发
    // 无内容可出站；出站失败由下方 catch 恢复。清理发生在同一同步段，此刻上下文键与 key 相同。
    state.chatDrafts[key] = ''
    state.replyTo = null
    state.chatAtBottom = true
    clearPendingImages()
    render()
    let result
    if (solo) {
      result = await api('send_solo_message', { botId: bot.id, body, ...(images.length ? { images } : {}) })
    } else {
      // 引用回复：带上 replyTo；命令路径（/clear、/task、/remember）后端会忽略该参数。
      result = await api('send_message', { projectId: project.id, body, ...(replyTo ? { replyTo: replyTo.id } : {}), ...(images.length ? { images } : {}) })
    }
    sent = true
    // 排队气泡乐观渲染（DSHBOTS-150）：发送成功后立刻为被 @ 的目标 bot 立排队行，不等下一拍
    // 2.8s 轮询——被 @ 的 bot 常常在轮询到达前就答完了，气泡否则肉眼不可见。
    // 目标 bot 取后端回传的 runBots / runBot，与实际派生的运行一致，无需前端解析 @。
    applyOptimisticTyping(result, state.chatMode === 'solo' ? 'solo_chat' : 'chat')
    render()
    await loadState(state.projectId, { quiet: true })
    // 取数后重画：真实运行接管乐观气泡（按 run id，不重复画），终态转驻留或同拍有回复直接撤掉。
    render()
    if (body === '/clear') toast(t('toast.chatCleared', { count: result.cleared }), 'success')
    if (result?.memory) toast(t('toast.memorySaved'), 'success')
    const input = document.getElementById('composer-input')
    input?.focus()
  } catch (error) {
    if (sent) {
      // 出站已成功、只是取数/重画失败：消息本体已落库，不得恢复草稿（恢复+重发=再制造双发），
      // 记录上下文即可，下一拍 2.8s 轮询会自然补齐数据。
      console.warn('[composer] post-send refresh failed:', { mode: state.chatMode, body: body.slice(0, 80), error })
    } else {
      // 出站失败：把草稿与待发图片恢复回去供重发；错误 toast 由 api() 非 quiet 调用统一弹出，
      // 这里不重复。恢复写进出站时的键（慢网窗口内切换会话不串写）；窗口期内新输入的草稿与
      // 新附件保留在其后不被覆盖。
      const typed = state.chatDrafts[key] ?? ''
      state.chatDrafts[key] = typed ? `${body}\n${typed}` : body
      if (!state.replyTo) state.replyTo = replyTo
      state.pendingImages = {
        ...(state.pendingImages ?? {}),
        // previewUrl 已被 clearPendingImages revoke，按手上的 base64 重建预览，缩略图不死链。
        [key]: [...pending.map(item => ({ ...item, previewUrl: base64BlobUrl(item.data, item.mediaType) })), ...(state.pendingImages?.[key] ?? [])],
      }
      render()
      document.getElementById('composer-input')?.focus()
    }
  } finally {
    sendInFlight = false
  }
}

async function saveTaskFromForm(taskId) {
  const form = document.getElementById('task-form') as HTMLFormElement
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


export { AC_COMMANDS, acWordChar, detectAcToken, buildAcItems, acSources, updateAutocomplete, renderAcPopup, moveAcSelection, closeAutocomplete, applyAutocomplete, draftKey, currentDraft, IMAGE_MEDIA_TYPES, IMAGE_ACCEPT, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, IMAGE_EXT_TYPES, resolveImageMediaType, formatImageBytes, validateImageSelection, pendingImagesFor, setPendingImages, revokePreview, readFileAsBase64, base64BlobUrl, addPendingImages, removePendingImage, clearPendingImages, attachImageButton, composerImageStrip, thumbnailFallback, ensureComposerImageInput, parseFileUriList, insertTextAtCursor, renderMessageImages, messageImageThumbUrls, messageImageThumbPending, messageImageThumbUrl, hydrateMessageImageThumbs, ensureImageViewer, openMessageImage, openInlineImage, closeImageViewer, COMPOSER_AUTO_MAX_PX, COMPOSER_PANEL_RATIO, composerCap, composerHeightFor, composerPanelCap, composerAppliedHeightPx, applyComposerHeight, syncComposerBox, sendMessage, saveTaskFromForm }
