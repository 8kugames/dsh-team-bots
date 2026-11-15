import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

const source = readUiSource()
const mdSource = readFileSync(fileURLToPath(new URL('../ui/modules/markdown.ts', import.meta.url)), 'utf8')
const html = readFileSync(fileURLToPath(new URL('../ui/index.html', import.meta.url)), 'utf8')
const css = await uiStylesSource()

// —— markdown 渲染纯逻辑块（mdImageFileUrl / mdRewriteImageSources / mdCreateRenderer）——
const mdBlock = /\/\/ markdown-render:start[\s\S]*?\/\/ markdown-render:end/.exec(source)?.[0]
assert.ok(mdBlock, 'ui/app.js 缺少 markdown-render 标记块')
const { mdImageFileUrl, mdRewriteImageSources, mdCreateRenderer } = new Function(
  `${mdBlock}\nreturn { mdImageFileUrl, mdRewriteImageSources, mdCreateRenderer }`,
)()

const groupScope = { projectId: 'p1', root: '/srv/ws/art' }
const soloScope = { soloBotId: 'b1', root: '/srv/ws/_the_bots/sd' }
const fileUrl = (scope, rel) => {
  const params = new URLSearchParams()
  if (scope.projectId) params.set('projectId', scope.projectId)
  else params.set('soloBotId', scope.soloBotId)
  params.set('path', rel)
  return `/api/dsh-team/file?${params.toString()}`
}

test('mdImageFileUrl：群聊相对路径改写为 /api/dsh-team/file 路由', () => {
  assert.equal(mdImageFileUrl('assets/preview.png', groupScope), fileUrl(groupScope, 'assets/preview.png'))
  assert.equal(mdImageFileUrl('./assets/preview.png', groupScope), fileUrl(groupScope, 'assets/preview.png'))
  // 工作区绝对路径按 scope.root 归一成相对路径。
  assert.equal(mdImageFileUrl('/srv/ws/art/assets/preview.png', groupScope), fileUrl(groupScope, 'assets/preview.png'))
})

test('mdImageFileUrl：单聊走 soloBotId 参数', () => {
  assert.equal(mdImageFileUrl('shots/draft.png', soloScope), fileUrl(soloScope, 'shots/draft.png'))
  assert.equal(mdImageFileUrl('/srv/ws/_the_bots/sd/shots/draft.png', soloScope), fileUrl(soloScope, 'shots/draft.png'))
})

test('mdImageFileUrl：协议引用与越界路径不改写（交消毒层/服务端拒绝）', () => {
  for (const href of ['https://cdn.example.com/x.png', 'http://e.com/x.png', '//cdn.example.com/x.png', 'data:image/png;base64,AAAA', '#anchor', 'mailto:a@b.c']) {
    assert.equal(mdImageFileUrl(href, groupScope), null, `${href} 应原样交给消毒层`)
  }
  assert.equal(mdImageFileUrl('../../etc/passwd.png', groupScope), null, '.. 段拒绝')
  assert.equal(mdImageFileUrl('assets/../../x.png', groupScope), null, '中段 .. 也拒绝')
  // 不属于本工作区的绝对路径：改写成路由 URL 后由服务端防穿越兜底（403 + 前端 chip）。
  assert.equal(mdImageFileUrl('/srv/other/x.png', groupScope), fileUrl(groupScope, 'srv/other/x.png'))
  assert.equal(mdImageFileUrl('x.png', null), null, '无 scope 不改写')
  assert.equal(mdImageFileUrl('x.png', { root: '/srv' }), null, 'scope 无 id 不改写')
  assert.equal(mdImageFileUrl('', groupScope), null, '空 href 不改写')
})

test('mdRewriteImageSources：只改图片引用，链接与正文不动', () => {
  const md = [
    '# 标题',
    '',
    '看 ![预览](assets/preview.png) 和 ![带标题](shots/draft.png "示意")',
    '',
    '[文档](assets/doc.md) 与 ![外链](https://cdn.example.com/x.png) 保持原样',
  ].join('\n')
  const out = mdRewriteImageSources(md, groupScope)
  assert.ok(out.includes(`![预览](${fileUrl(groupScope, 'assets/preview.png')})`), '相对路径图片被改写')
  assert.ok(out.includes(`![带标题](${fileUrl(groupScope, 'shots/draft.png')})`), '带标题图片被改写（改写只保留 url，丢弃标题）')
  assert.ok(out.includes('[文档](assets/doc.md)'), '普通链接不改写')
  assert.ok(out.includes('![外链](https://cdn.example.com/x.png)'), '协议图片不改写')
  assert.ok(out.includes('# 标题'), '正文不动')
})

test('mdRewriteImageSources：含空格 / file:// / 反斜杠 / 转义路径都改写到文件端点', () => {
  const cases: Array<[string, string]> = [
    ['![x](bench/xxx.png)', 'bench/xxx.png'],
    ['![x](bench/a b.png)', 'bench/a b.png'],
    ['![x](file:///srv/ws/art/bench/xxx.png)', 'bench/xxx.png'],
    ['![x](file:///ws/bench/xxx.png)', 'ws/bench/xxx.png'],
    ['![x](bench\\xxx.png)', 'bench/xxx.png'],
    ['![x](<bench/a b.png>)', 'bench/a b.png'],
    ['![x](bench/a%20b.png)', 'bench/a b.png'],
    ['![x](bench/a b.png "示意")', 'bench/a b.png'],
  ]
  for (const [md, rel] of cases) {
    const out = mdRewriteImageSources(md, groupScope)
    assert.ok(out.includes(`![x](${fileUrl(groupScope, rel)})`), `${md} → ${out}`)
  }
  // 未改写形态原样保留：协议引用与越界段都不该被改写正则接走。
  for (const md of [
    '![x](https://cdn.example.com/x.png)',
    '![x](../../etc/x.png)',
    '![x](bench/../../x.png)',
    '![x](file://../../etc/x.png)',
  ]) {
    assert.equal(mdRewriteImageSources(md, groupScope), md, `${md} 应原样保留`)
  }
})

test('mdImageFileUrl：先解码再判定，file:// 与反斜杠归一', () => {
  assert.equal(mdImageFileUrl('bench/a%20b.png', groupScope), fileUrl(groupScope, 'bench/a b.png'))
  assert.equal(mdImageFileUrl('file:///srv/ws/art/bench/xxx.png', groupScope), fileUrl(groupScope, 'bench/xxx.png'))
  assert.equal(mdImageFileUrl('bench\\xxx.png', groupScope), fileUrl(groupScope, 'bench/xxx.png'))
  assert.equal(mdImageFileUrl('file://../../etc/x.png', groupScope), null, 'file:// 剥协议后仍拒绝 ..')
})

test('mdCreateRenderer：依赖缺席或不可用一律 fail-closed 返回 null', () => {
  assert.equal(mdCreateRenderer(null), null, '无 deps')
  assert.equal(mdCreateRenderer({}), null, '缺 marked')
  assert.equal(mdCreateRenderer({ marked: { parse() {} } }), null, '缺 DOMPurify')
  assert.equal(mdCreateRenderer({ marked: { parse() {} }, DOMPurify: { sanitize: 'nope' } }), null, 'sanitize 非函数')
  assert.equal(
    mdCreateRenderer({ marked: { parse() {} }, DOMPurify: { sanitize() {}, isSupported: false } }),
    null,
    'isSupported=false（无 DOM 环境）拒绝渲染',
  )
})

test('mdCreateRenderer：管线接线=改写→marked.parse→DOMPurify.sanitize，顺序不可绕', () => {
  const seen = { parse: '', sanitize: '', parseOpts: null }
  const purify = {
    isSupported: true,
    hooks: [],
    addHook(name, fn) { this.hooks.push([name, fn]) },
    sanitize(html, opts) { seen.sanitize = html; return `SANITIZED(${html})` },
  }
  const marked = { parse(src, opts) { seen.parse = src; seen.parseOpts = opts; return '<p>PARSE OUT</p>' } }
  const render = mdCreateRenderer({ marked, DOMPurify: purify })
  assert.equal(typeof render, 'function')
  const out = render('![图](assets/preview.png)', groupScope)
  assert.ok(seen.parse.includes(fileUrl(groupScope, 'assets/preview.png')), 'marked 收到的是改写后的 md')
  assert.equal(seen.sanitize, '<p>PARSE OUT</p>', 'sanitize 收到的是 marked 输出')
  assert.equal(seen.parseOpts.gfm, true)
  assert.equal(seen.parseOpts.breaks, true)
  assert.equal(out, 'SANITIZED(<p>PARSE OUT</p>)')
})

test('外链钩子：带 href 的 A 加 target=_blank + rel=noopener noreferrer', () => {
  const purify = {
    isSupported: true,
    hook: null,
    addHook(name, fn) { this.hook = fn },
    sanitize(html) { return html },
  }
  mdCreateRenderer({ marked: { parse: () => '<a href="https://x.example">x</a>' }, DOMPurify: purify })
  assert.ok(purify.hook, '应注册 afterSanitizeAttributes 钩子')
  const attrs: { target?: string; rel?: string } = {}
  const link = { tagName: 'A', getAttribute: () => 'https://x.example', setAttribute: (k, v) => { attrs[k] = v } }
  purify.hook(link)
  assert.equal(attrs.target, '_blank')
  assert.equal(attrs.rel, 'noopener noreferrer')
  // 非 A 或无 href 不动。
  const untouched = { tagName: 'A', getAttribute: () => null, setAttribute() { throw new Error('不应设置属性') } }
  purify.hook(untouched)
  const img = { tagName: 'IMG', getAttribute: () => 'a.png', setAttribute() { throw new Error('不应设置属性') } }
  purify.hook(img)
})

// —— 接线断言（真实 UI 文件里，渲染管线各环节都在位）——

test('renderMessage：system 保持 esc 纯文本，用户与 bot 气泡走 markdown 渲染', () => {
  const systemBranch = /function renderMessage\(message\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? ''
  assert.ok(systemBranch.includes("message.sender_type === 'system'"), 'system 分支存在')
  assert.ok(systemBranch.includes('${esc(message.body)}'), 'system 消息仍是 esc 纯文本')
  assert.match(source, /message-bubble">\$\{quoteBlock\}\$\{richText\(message\.body, mdChatScope\(\)\)\}/, '气泡正文走 richText(body, scope)')
  assert.match(source, /comment-body">\$\{richText\(comment\.body, mdChatScope\(\)\)\}/, '任务评论同样走 markdown 渲染')
})

test('richText 兜底：mdRender 不可用时回退 esc 纯文本，不裸渲染', () => {
  assert.match(source, /const mdRender = mdCreateRenderer\(\{ marked: window\.marked, DOMPurify: window\.DOMPurify \}\)/)
  assert.match(source, /function richText\(value, scope\) \{[\s\S]*?if \(mdRender\) return mdRender\(value, scope\)[\s\S]*?replaceAll\('\\n', '<br>'\)/)
})

test('index.html：vendor 脚本先于 app.js 引入（defer 保持文档序）', () => {
  const markedAt = html.indexOf('/api/dsh-team/vendor/marked.js')
  const purifyAt = html.indexOf('/api/dsh-team/vendor/purify.min.js')
  const appAt = html.indexOf('/api/dsh-team/app.js')
  assert.ok(markedAt >= 0 && purifyAt >= 0 && appAt >= 0, '三个 script 标签都在')
  assert.ok(markedAt < appAt && purifyAt < appAt, 'vendor 先于 app.js')
})

test('图片失败占位：全局 error 捕获把失败 img 换成文件名 chip', () => {
  assert.match(source, /window\.addEventListener\('error'[\s\S]*?true\)/)
  assert.match(source, /closest\('\.message-bubble, \.comment-body'\)/)
  assert.match(source, /md-img-missing/)
  assert.match(source, /replaceWith\(chip\)/)
})

test('图片失败占位：chip title 区分未改写与 403/404 原因', () => {
  assert.match(source, /mdImageChipTitle\(chip, img\)/)
  assert.match(mdSource, /new URL\(src, location\.href\)/)
  assert.match(mdSource, /pathname === '\/api\/dsh-team\/file'/)
  assert.match(mdSource, /t\('chat\.imageMissingUnrewritten'\)/)
  assert.match(mdSource, /fetch\(src\)/)
  assert.match(mdSource, /res\.status === 403[\s\S]*?t\('chat\.imageMissingForbidden'\)/)
  assert.match(mdSource, /res\.status === 404[\s\S]*?t\('chat\.imageMissingNotFound'\)/)
})

test('样式：代码块用终端井 token，md 元素共用既有设计语言，图片缩略', () => {
  assert.match(css, /:is\(\.message-bubble, \.comment-body\) pre \{[\s\S]*?var\(--console-bg\)[\s\S]*?var\(--console-ink\)/, '代码块复用终端井')
  assert.match(css, /:is\(\.message-bubble, \.comment-body\) blockquote \{[\s\S]*?border-left: 2px solid var\(--accent\)/)
  assert.match(css, /:is\(\.message-bubble, \.comment-body\) table \{[\s\S]*?overflow-x: auto/)
  assert.match(css, /:is\(\.message-bubble, \.comment-body\) img \{[\s\S]*?max-width: min\(100%, 340px\)[\s\S]*?max-height: 320px/)
  assert.match(css, /\.md-img-missing \{[\s\S]*?var\(--danger-wash\)[\s\S]*?var\(--danger\)/)
  assert.match(css, /\.comment-body \{[\s\S]*?white-space: normal/, '评论正文换行交给 <p>/<br>')
})
