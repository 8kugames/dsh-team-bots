import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'
import './helpers/eval-shim.js'

const source = readUiSource()
const css = await uiStylesSource()
const backend = readFileSync(fileURLToPath(new URL('../src/services/message-images.js', import.meta.url)), 'utf8')

// —— 聊天图片纯逻辑块 ——
const imagesBlock = /\/\/ chat-images:start[\s\S]*?\/\/ chat-images:end/.exec(source)?.[0]
assert.ok(imagesBlock, 'ui/app.js 缺少 chat-images 标记块')
const {
  IMAGE_MEDIA_TYPES,
  IMAGE_ACCEPT,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  resolveImageMediaType,
  formatImageBytes,
  validateImageSelection,
} = new Function(
  `${imagesBlock}\nreturn { IMAGE_MEDIA_TYPES, IMAGE_ACCEPT, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, resolveImageMediaType, formatImageBytes, validateImageSelection }`,
)()

const fakeFile = (name, type, size) => ({ name, type, size })

test('口径对齐后端：四种 MIME、单图 5MB、单条 4 张', () => {
  assert.deepEqual(IMAGE_MEDIA_TYPES, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  assert.equal(IMAGE_ACCEPT, 'image/png,image/jpeg,image/gif,image/webp')
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024)
  assert.equal(MAX_IMAGES_PER_MESSAGE, 4)
  assert.match(backend, /MAX_IMAGE_BYTES = 5 \* 1024 \* 1024/)
  assert.match(backend, /MAX_IMAGES_PER_MESSAGE = 4/)
})

test('resolveImageMediaType：MIME 优先，缺失时按扩展名兜底，不支持返回 null', () => {
  assert.equal(resolveImageMediaType('image/png', 'a.png'), 'image/png')
  assert.equal(resolveImageMediaType('IMAGE/JPEG', 'a.jpg'), 'image/jpeg')
  assert.equal(resolveImageMediaType('', 'shot.webp'), 'image/webp')
  assert.equal(resolveImageMediaType('', 'anim.gif'), 'image/gif')
  assert.equal(resolveImageMediaType('application/pdf', 'a.pdf'), null)
  assert.equal(resolveImageMediaType('', 'a.bmp'), null)
})

test('formatImageBytes：B / KB / MB 三档', () => {
  assert.equal(formatImageBytes(512), '512 B')
  assert.equal(formatImageBytes(2048), '2 KB')
  assert.equal(formatImageBytes(5 * 1024 * 1024), '5.0 MB')
})

test('validateImageSelection：类型不符与超 5MB 前端拦截并给出可读原因', () => {
  const { accepted, rejected } = validateImageSelection(
    [fakeFile('ok.png', 'image/png', 1024), fakeFile('doc.pdf', 'application/pdf', 1024), fakeFile('big.png', 'image/png', 6 * 1024 * 1024)],
    0,
  )
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].name, 'ok.png')
  assert.equal(accepted[0].mediaType, 'image/png')
  assert.equal(accepted[0].bytes, 1024)
  assert.deepEqual(
    rejected.map(item => item.reason),
    ['仅支持 PNG / JPEG / GIF / WebP 格式', '单张图片不能超过 5MB'],
  )
})

test('validateImageSelection：一条消息最多 4 张，超出的被拒', () => {
  const files = Array.from({ length: 6 }, (_, i) => fakeFile(`img${i}.png`, 'image/png', 100))
  const { accepted, rejected } = validateImageSelection(files, 0)
  assert.equal(accepted.length, 4)
  assert.equal(rejected.length, 2)
  assert.match(rejected[0].reason, /最多 4 张图片/)
  const partial = validateImageSelection(files, 3)
  assert.equal(partial.accepted.length, 1, '已有 3 张时只再收 1 张')
  assert.equal(partial.rejected.length, 5)
})

// —— 接线：按钮 / 缩略图条 / 发送 / 气泡渲染 / 查看器 ——
test('附件按钮：复用图标集的 image 图标，群聊与单聊各一个', () => {
  assert.match(source, /image: '<rect x="3"/, 'icons 应包含 image 图标')
  assert.equal((source.match(/\$\{attachImageButton\(\)\}/g) ?? []).length, 2, '群聊与单聊 composer 各接一个附件按钮')
  assert.match(source, /class="attach-btn" data-action="attach-image"/)
  assert.match(source, /case 'attach-image':[\s\S]*?ensureComposerImageInput\(\)\.click\(\)/)
})

test('file input：body 级单例，不进 renderShell，change 委托读文件', () => {
  assert.match(source, /function ensureComposerImageInput\(doc = document\)/)
  assert.match(source, /doc\.body\.appendChild\(el\)/)
  assert.doesNotMatch(source, /composerImageParts/, 'file input 不再渲染进 composer 模板（会被 2.8s 全量重建换掉）')
  assert.doesNotMatch(source, /<input type="file"/, 'shell 模板里不得出现 file input')
  assert.match(source, /el\.id === 'composer-image-input'/)
  assert.match(source, /addPendingImages\(files\)/)
})

// —— DSHBOTS-64：文件选择跨渲染周期不丢 ——
// 根因：input 渲染进 renderShell，2.8s 轮询 app.innerHTML 全量重建换掉节点，
// 用户选完文件后 change 落在已脱离 document 的旧节点上，document 级委托收不到 → 静默丢失。
// 修法：body 级单例。以下对真实 ensureComposerImageInput 做行为断言（不止源码文本）。
const singletonBlock = /\/\/ composer-file-input:start[\s\S]*?\/\/ composer-file-input:end/.exec(source)?.[0]
assert.ok(singletonBlock, 'ui/app.js 缺少 composer-file-input 标记块')
const { ensureComposerImageInput } = new Function(
  'IMAGE_ACCEPT', `${singletonBlock}\nreturn { ensureComposerImageInput }`,
)(IMAGE_ACCEPT)

// 迷你 DOM：body 子树（单例住处）+ app 子树（render() 全量重建时整体换新）。
function fakeDoc() {
  const world = { bodyChildren: [], appChildren: [] }
  let created = 0
  return {
    body: { appendChild: (el) => world.bodyChildren.push(el) },
    createElement(tag) { created += 1; return { tag } as any },
    createdCount: () => created,
    getElementById(id) {
      return [...world.appChildren, ...world.bodyChildren].find(el => el.id === id) ?? null
    },
    mountInApp: (el) => world.appChildren.push(el),
    rerender: () => { world.appChildren = [] },
    bodyChildren: world.bodyChildren,
  }
}

test('文件选择跨渲染周期不丢：单例挂 body 只建一次，任意次全量重建后节点不变', () => {
  const doc = fakeDoc()
  const first = ensureComposerImageInput(doc)
  assert.equal(doc.createdCount(), 1)
  assert.equal(doc.bodyChildren.length, 1, '挂在 body 上，不在 #app 子树里')
  assert.equal(first.tag, 'input')
  assert.equal(first.id, 'composer-image-input')
  assert.equal(first.className, 'composer-image-input')
  assert.equal(first.type, 'file')
  assert.equal(first.accept, IMAGE_ACCEPT)
  assert.equal(first.multiple, true)
  assert.equal(first.hidden, true)

  // 连续多轮 render() 全量重建（app 子树换新，body 不动）：取到的仍是同一节点。
  for (let i = 0; i < 3; i += 1) {
    doc.rerender()
    assert.equal(ensureComposerImageInput(doc), first, `第 ${i + 1} 轮重建后仍取到同一节点`)
    assert.equal(doc.getElementById('composer-image-input'), first, 'document 能查到的还是被点击的那个节点')
  }
  assert.equal(doc.createdCount(), 1, '只建一次')
  assert.equal(doc.bodyChildren.length, 1, '不重复挂载')

  // 对照旧结构（渲染进 shell 的 input）：一轮重建后从 document 查不到，
  // change 落在这种节点上到不了 document 级委托 —— 这正是 DSHBOTS-64 的断点。
  const shellInput = doc.createElement('input')
  shellInput.id = 'composer-image-input'
  doc.mountInApp(shellInput)
  assert.equal(doc.getElementById('composer-image-input'), shellInput, '旧结构：在 shell 里时能查到')
  doc.rerender()
  assert.notEqual(doc.getElementById('composer-image-input'), shellInput, '旧结构：一轮重建后节点从 document 消失')
  assert.equal(doc.getElementById('composer-image-input'), first, '新结构：body 单例不受重建影响')
})

test('待发缩略图条：渲染预览 + 可单删，附件满 4 张时按钮禁用', () => {
  assert.match(source, /class="image-strip"/)
  assert.match(source, /class="image-thumb-img" src="\$\{attr\(image\.previewUrl\)\}"/)
  assert.match(source, /data-action="remove-pending-image" data-image-key="\$\{attr\(image\.key\)\}"/)
  assert.match(source, /case 'remove-pending-image':[\s\S]*?removePendingImage\(target\.dataset\.imageKey\)/)
  assert.match(source, /const full = pendingImagesFor\(\)\.length >= MAX_IMAGES_PER_MESSAGE/)
  assert.match(source, /\$\{full \? ' disabled' : ''\}/)
})

test('发送：base64 随既有 send_message / send_solo_message 通道出站，成功后清空', () => {
  assert.match(source, /const images = pending\.map\(item => \(\{ mediaType: item\.mediaType, name: item\.name, data: item\.data \}\)\)/)
  assert.match(source, /api\('send_solo_message', \{ botId: bot\.id, body, \.\.\.\(images\.length \? \{ images \} : \{\}\) \}\)/)
  assert.match(source, /api\('send_message', \{ projectId: project\.id, body,[\s\S]*?\.\.\.\(images\.length \? \{ images \} : \{\}\) \}\)/)
  assert.match(source, /clearPendingImages\(\)/)
  assert.match(source, /if \(!body && pending\.length === 0\) return/, '纯图片消息也允许发送')
  assert.match(source, /toast\(t\('toast\.attachUnsupported'\), 'error'\)/, '命令消息附图需拦截提示')
})

test('气泡渲染：只渲染图片元数据，base64 不进消息 HTML', () => {
  assert.match(source, /\$\{renderMessageImages\(message\.images\)\}/)
  const fn = /function renderMessageImages\(images\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(fn, '找不到 renderMessageImages')
  assert.match(fn, /data-image-id="\$\{attr\(image\.id\)\}"/)
  assert.ok(!/base64/.test(fn), '消息附图块不得直接输出 base64')
  assert.match(fn, /formatImageBytes\(image\.bytes\)/)
})

test('原图查看器：按 id 现取原图，base64 转 blob: URL 后再给 img.src', () => {
  assert.match(source, /api\('get_message_image', \{ imageId \}, \{ quiet: true \}\)/)
  assert.match(source, /img\.src = base64BlobUrl\(image\.data, image\.mediaType\)/)
  assert.match(source, /URL\.createObjectURL\(new Blob/)
  assert.match(source, /case 'view-message-image':[\s\S]*?openMessageImage\(target\.dataset\.imageId\)/)
  assert.match(source, /case 'close-image-viewer':[\s\S]*?closeImageViewer\(\)/)
  assert.match(source, /event\.key === 'Escape' && !document\.getElementById\('image-viewer'\)\?\.hidden/)
})

test('样式：附件按钮 / 缩略图条 / 附图块 / 查看器全部走主题变量', () => {
  for (const selector of ['.attach-btn', '.image-strip', '.image-thumb', '.msg-images', '.msg-image-tile', '.image-viewer']) {
    assert.ok(css.includes(selector), `缺少 ${selector} 样式`)
  }
  const blocks = [
    /\.attach-btn \{[\s\S]*?\n\}/,
    /\.image-thumb \{[\s\S]*?\n\}/,
    /\.msg-image-tile \{[\s\S]*?\n\}/,
    /\.image-viewer-panel \{[\s\S]*?\n\}/,
  ]
  for (const pattern of blocks) {
    const block = pattern.exec(css)?.[0] ?? ''
    assert.match(block, /var\(--/, '样式块应使用主题变量')
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block), '样式块不得硬编码颜色')
    assert.ok(!/rgba?\(/i.test(block), '样式块不得硬编码颜色函数')
  }
  assert.match(css, /\.image-viewer\[hidden\] \{/, '查看器隐藏态需显式声明')
})

// —— DSHBOTS-75：生产 CSP 曾用 img-src 'self' data: 拦下 blob: 缩略图 → 破图 + alt 文件名 ——
// 修复：img-src 补 blob:。此锁防止 CSP 再被收紧回缺 blob: 的形态。
test('CSP 回归锁：img-src 必须放行 blob:（待发缩略图预览依赖）', () => {
  const http = readFileSync(fileURLToPath(new URL('../src/http.js', import.meta.url)), 'utf8')
  const imgSrc = /img-src ([^;]+);/.exec(http)?.[1]
  assert.ok(imgSrc, 'src/http.js 缺少 img-src 指令')
  assert.ok(imgSrc.includes('blob:'), `img-src 必须含 blob:（当前：${imgSrc}）`)
  assert.ok(imgSrc.includes("'self'"), "img-src 应保留 'self'")
})

// 兜底占位节点：真实 thumbnailFallback 行为断言（文件名走 textContent，不进 innerHTML）。
const fallbackBlock = /\/\/ image-fallback:start[^\n]*\n([\s\S]*?)\/\/ image-fallback:end/.exec(source)?.[1]
assert.ok(fallbackBlock, 'ui/app.js 缺少 image-fallback 标记块')
const { thumbnailFallback } = new Function(`${fallbackBlock}\nreturn { thumbnailFallback }`)()

test('缩略图兜底：破图换成「图标 + 文件名」占位，文件名走 textContent', () => {
  const made = []
  const doc = {
    createElement(tag) {
      const el: { tag: any; children: any[]; append(...kids: any[]): void; innerHTML: any; _html?: any } = {
        tag,
        children: [],
        append(...kids) { el.children.push(...kids) },
        set innerHTML(v) { el._html = v },
        get innerHTML() { return el._html },
      }
      made.push(el)
      return el
    },
  }
  const node = thumbnailFallback('报告 截图 <b>x</b>.png', '<svg></svg>', doc)
  assert.equal(node.tag, 'div')
  assert.equal(node.className, 'image-thumb-fallback')
  const [glyph, label] = node.children
  assert.equal(glyph._html, '<svg></svg>', '图标走注入的 iconHtml')
  assert.equal(label._html, undefined, '文件名节点从不写 innerHTML')
  assert.equal(label.textContent, '报告 截图 <b>x</b>.png', '文件名原样保留在 textContent')
  assert.equal(label.className, 'image-thumb-fallback-name')
  const anon = thumbnailFallback('', '<svg></svg>', doc)
  assert.equal(anon.children[1].textContent, '图片预览不可用', '空名兜底文案')
})

test('兜底接线：document 捕获阶段委托 resource error，不用内联 onerror（CSP 会拦）', () => {
  assert.match(source, /<img class="image-thumb-img" src="\$\{attr\(image\.previewUrl\)\}" alt="[^"]*" \/>/, '缩略图 img 不得带内联 onerror')
  assert.doesNotMatch(source, /onerror=/i, '任何元素都不得出现内联 onerror（script-src 无 unsafe-inline）')
  const reg = /document\.addEventListener\('error', \(event\) => \{[\s\S]*?\n\}, true\)/.exec(source)?.[0]
  assert.ok(reg, '存在 document 级 error 委托且第三参为 true（捕获）')
  assert.match(reg, /image-thumb-img/, '只认领待发缩略图')
  assert.match(reg, /target\.replaceWith\(thumbnailFallback\(/, '破图当场替换为兜底占位')
  assert.match(reg, /dataset\.fallbackApplied/, '幂等防重入')
  assert.ok(css.includes('.image-thumb-fallback'), '兜底占位样式存在')
})

test('blob 生命周期锁：previewUrl 的 revoke 只允许出现在移除与清空两条路径', () => {
  const calls = source.match(/revokePreview\(/g) ?? []
  assert.equal(calls.length, 3, 'revokePreview 恰好 3 处：定义 + removePendingImage + clearPendingImages')
  assert.match(source, /function removePendingImage\(key\) \{[\s\S]*?revokePreview\(target\)/, '移除单张时释放')
  assert.match(source, /function clearPendingImages\(\) \{[\s\S]*?for \(const image of pendingImagesFor\(\)\) revokePreview\(image\)/, '发送成功清空时释放')
  const others = (source.match(/URL\.revokeObjectURL\(/g) ?? []).length
  assert.equal(others, 3, '全文件 revokeObjectURL 恰好 3 处：revokePreview 定义 + CSV 导出 + 查看器关闭；兜底路径不 revoke（移除/清空时会统一释放）')
})
