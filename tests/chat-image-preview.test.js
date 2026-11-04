import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

// DSHBOTS-80：消息图片缩略图化 + 点击放大预览（复用 image-viewer）。
// ① 附图瓦片从「图标 + 文件名」文本条改成真缩略图（blob: URL，会话级缓存，base64 不进 DOM）；
// ② markdown 正文内嵌 <img> 点击委托放大（复用全屏查看器，直接用现有 src）。
const source = readUiSource()
const css = await uiStylesSource()

function extractFn(regex, label) {
  const fn = regex.exec(source)?.[0]
  assert.ok(fn, `找不到 ${label}`)
  return fn
}

test('附图瓦片渲染真缩略图：缓存命中同步嵌 msg-image-thumb，未命中保留图标占位', () => {
  const tileFn = extractFn(/function renderMessageImages\(images\) \{[\s\S]*?\n\}/, 'renderMessageImages')
  const render = new Function(
    'messageImageThumbUrls', 'attr', 'esc', 'icon', 'formatImageBytes',
    `${tileFn}\nreturn renderMessageImages`,
  )(new Map([['img-1', 'blob:stub-1']]), (v) => String(v ?? ''), (v) => String(v ?? ''), () => '[icon]', (bytes) => `${bytes} B`)
  const hit = render([{ id: 'img-1', name: '截图 a.png', bytes: 2048 }])
  assert.match(hit, /data-action="view-message-image" data-image-id="img-1"/, '点击行为不变：仍走 view-message-image 进全屏查看器')
  assert.match(hit, /<img class="msg-image-thumb" src="blob:stub-1" alt="截图 a\.png" \/>/, '缓存命中时同步嵌缩略图，轮询重渲染不闪占位')
  const miss = render([{ id: 'img-2', name: 'b.png', bytes: 1 }])
  assert.ok(!miss.includes('msg-image-thumb'), '未命中不硬造 URL，等 hydrate 异步补齐')
  assert.match(miss, /<span class="msg-image-icon">\[icon\]<\/span>/, '未命中用图标占位，瓦片仍可点击')
  assert.ok(!/base64/.test(tileFn), '瓦片模板不得出现 base64（原图数据不进消息 HTML）')
})

test('缩略图取图共用查看器路径：会话级缓存 + 并发去重，同一张图只请求一次', async () => {
  const fetchFn = extractFn(/function messageImageThumbUrl\(imageId\) \{[\s\S]*?\n\}/, 'messageImageThumbUrl')
  assert.match(fetchFn, /api\('get_message_image', \{ imageId \}, \{ quiet: true \}\)/, '复用全屏查看器同一条取图 API')
  assert.match(fetchFn, /base64BlobUrl\(image\.data, image\.mediaType\)/, '复用 base64 → blob: URL 转换，不另造轮子')
  let calls = 0
  const urls = new Map()
  const messageImageThumbUrl = new Function(
    'api', 'base64BlobUrl', 'messageImageThumbUrls', 'messageImageThumbPending',
    `${fetchFn}\nreturn messageImageThumbUrl`,
  )(
    async (payload) => {
      calls += 1
      return { data: 'eHg=', mediaType: 'image/png', name: `${payload.imageId}.png`, bytes: 3 }
    },
    (data, mediaType) => `blob:${mediaType}-${data}`,
    urls,
    new Map(),
  )
  const [a, b] = await Promise.all([messageImageThumbUrl('x'), messageImageThumbUrl('x')])
  await messageImageThumbUrl('y')
  assert.equal(calls, 2, '并发同图只发一个请求（pending 去重）')
  assert.equal(a, b, '并发请求拿到同一 URL')
  assert.equal(urls.size, 2)
  const again = await messageImageThumbUrl('x')
  assert.equal(again, a, '缓存命中不再请求')
  assert.equal(calls, 2, '命中后零额外请求')
})

test('渲染后补齐接线：hydrate 只处理未命中的瓦片，且不释放缓存 URL', () => {
  assert.match(source, /app\.innerHTML = renderShell\(\)\n\s*\/\/[^\n]*\n\s*hydrateMessageImageThumbs\(app\)/, 'render() 全量重建后异步补齐缩略图')
  const hydrateFn = extractFn(/async function hydrateMessageImageThumbs\(root = document\) \{[\s\S]*?\n\}/, 'hydrateMessageImageThumbs')
  assert.match(hydrateFn, /msg-image-tile\[data-image-id\]/, '按瓦片定位')
  assert.match(hydrateFn, /messageImageThumbUrl\(imageId\)/, '复用取图缓存')
  assert.match(hydrateFn, /replaceWith\(img\)/, '原位替换图标占位')
  assert.ok(!hydrateFn.includes('revokeObjectURL'), '缓存 URL 会话期存活：补齐路径不释放（查看器关闭的 revoke 不碰缓存）')
})

test('正文内嵌图点击放大：委托先于 data-action，openInlineImage 复用查看器不再拉数据', () => {
  assert.ok(
    source.indexOf('.message-bubble img') < source.indexOf("closest('[data-action]')"),
    '内嵌图分支必须在 data-action 委托之前，否则 img 无 data-action 会被忽略',
  )
  const inlineFn = extractFn(/function openInlineImage\(img\) \{[\s\S]*?\n\}/, 'openInlineImage')
  assert.match(inlineFn, /ensureImageViewer\(\)/, '复用全屏查看器浮层')
  assert.doesNotMatch(inlineFn, /api\(/, '直接用正文图现有 src，不再请求数据')
  assert.match(source, /case 'close-image-viewer':\s*\n\s*closeImageViewer\(\)/, '关闭链路复用 close-image-viewer（Escape/背景同路径）')

  // 行为断言：alt 优先做标题；src 原样进查看器 img；浮层显示。
  const seen = {}
  const viewer = { hidden: true }
  const openInlineImage = new Function(
    'document', 'ensureImageViewer', 'location',
    `${inlineFn}\nreturn openInlineImage`,
  )(
    {
      getElementById: (id) => (seen[id] ??= { textContent: '', appendChild: (child) => { seen[id].child = child } }),
      createElement: () => ({ className: '', alt: '', src: '' }),
    },
    () => viewer,
    { href: 'http://localhost/' },
  )
  openInlineImage({
    currentSrc: '',
    getAttribute: (k) => (k === 'src' ? '/api/dsh-team/file?projectId=p1&path=shots/a.png' : k === 'alt' ? '产物截图' : ''),
  })
  assert.equal(viewer.hidden, false, '浮层打开')
  assert.equal(seen['image-viewer-name'].textContent, '产物截图', '标题 alt 优先')
  assert.equal(seen['image-viewer-body'].child.src, '/api/dsh-team/file?projectId=p1&path=shots/a.png', 'src 原样复用')

  openInlineImage({
    currentSrc: '',
    getAttribute: (k) => (k === 'src' ? 'http://x/y/zz.png' : ''),
  })
  assert.equal(seen['image-viewer-name'].textContent, 'zz.png', '无 alt 时从 URL 取文件名兜底')
})

test('hydrate 行为：未命中瓦片原位替换图标，已命中跳过，取图失败保留占位', async () => {
  const hydrateFn = extractFn(/async function hydrateMessageImageThumbs\(root = document\) \{[\s\S]*?\n\}/, 'hydrateMessageImageThumbs')
  const hydrate = new Function('document', 'messageImageThumbUrl', `${hydrateFn}\nreturn hydrateMessageImageThumbs`)

  function makeTile(id, name, hasThumb) {
    const iconEl = {}
    const tile = {
      dataset: { imageId: id },
      isConnected: true,
      replaced: null,
      querySelector: (sel) => (sel === '.msg-image-thumb' ? (hasThumb ? {} : null) : sel === '.msg-image-name' ? { textContent: name } : sel === '.msg-image-icon' ? iconEl : null),
    }
    iconEl.replaceWith = (el) => { tile.replaced = el }
    return tile
  }
  const tiles = [makeTile('a', 'aa.png', false), makeTile('b', 'bb.png', true), makeTile('bad', 'cc.png', false)]
  const doc = { createElement: () => ({ className: '', alt: '', src: '' }) }
  const fetchThumb = async (id) => {
    if (id === 'bad') throw new Error('boom')
    return `blob:${id}`
  }
  const runHydrate = hydrate(doc, fetchThumb)
  await runHydrate({ querySelectorAll: () => tiles })
  assert.equal(tiles[0].replaced?.src, 'blob:a', '未命中瓦片原位换成缩略图')
  assert.equal(tiles[0].replaced?.alt, 'aa.png', 'alt 取瓦片上的文件名')
  assert.equal(tiles[0].replaced?.className, 'msg-image-thumb')
  assert.equal(tiles[1].replaced, null, '模板已嵌缩略图的瓦片跳过')
  assert.equal(tiles[2].replaced, null, '取图失败保留图标占位（瓦片仍可点击）')
})

test('样式锁：瓦片改方形缩略图布局，hover 提亮，全部走主题变量', () => {
  const tile = /\.msg-image-tile \{[\s\S]*?\n\}/.exec(css)?.[0]
  assert.ok(tile, '找不到 .msg-image-tile 规则')
  assert.match(tile, /flex-direction: column/, '瓦片纵向：缩略图在上、注脚在下')
  const shared = /\.msg-image-thumb,\n\.msg-image-icon \{[\s\S]*?\n\}/.exec(css)?.[0]
  assert.ok(shared, '缩略图与图标占位须共用同一尺寸方块')
  assert.match(shared, /aspect-ratio: 1 \/ 1/, '方形 1:1，未取到图不跳版')
  const thumb = /\n\.msg-image-thumb \{[\s\S]*?\n\}/.exec(css)?.[0]
  assert.ok(thumb, '找不到 .msg-image-thumb 规则')
  assert.match(thumb, /object-fit: cover/, 'cover 裁切不变形')
  assert.match(css, /\.msg-image-tile:hover \.msg-image-thumb \{[\s\S]*?brightness/, 'hover 提亮缩略图')
  for (const block of [tile, shared, thumb]) {
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block), '不得硬编码颜色（hex）')
    assert.ok(!/rgba?\(/i.test(block), '不得硬编码颜色（rgb）')
  }
  assert.match(css, /\.message-bubble img \{[\s\S]*?cursor: zoom-in/, '正文内嵌图给出可点暗示')
})
