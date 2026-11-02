import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')
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
  assert.match(source, /case 'attach-image':[\s\S]*?getElementById\('composer-image-input'\)\?\.click\(\)/)
})

test('file input：accept 限定四种 MIME、multiple、隐藏', () => {
  assert.match(source, /<input type="file" id="composer-image-input"[^>]*accept="\$\{attr\(IMAGE_ACCEPT\)\}"[^>]*multiple hidden/)
  assert.match(source, /el\.id === 'composer-image-input'/)
  assert.match(source, /addPendingImages\(files\)/)
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
  assert.match(source, /该命令不支持附图，请先移除图片/, '命令消息附图需拦截提示')
})

test('气泡渲染：只渲染图片元数据，base64 不进消息 HTML', () => {
  assert.match(source, /\$\{renderMessageImages\(message\.images\)\}/)
  const fn = /function renderMessageImages\(images\) \{[\s\S]*?\n  \}/.exec(source)?.[0]
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
