import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 引用摘要（DSHBOTS-71）：摘要来自消息原文前 120 字，原文可能带 markdown 记号。
// 这里先做纯逻辑断言（剥记号），再做渲染接线与样式断言（不许撑破气泡）。
const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')

// —— 引用摘要纯逻辑块（mdPlainSummary）——
const quoteBlock = /\/\/ quote-summary:start[\s\S]*?\/\/ quote-summary:end/.exec(source)?.[0]
assert.ok(quoteBlock, 'ui/app.js 缺少 quote-summary 标记块')
const { mdPlainSummary } = new Function(`${quoteBlock}\nreturn { mdPlainSummary }`)()

test('摘要剥掉加粗/斜体/删除线记号', () => {
  assert.equal(mdPlainSummary('**加粗标题**'), '加粗标题')
  assert.equal(mdPlainSummary('*斜体*'), '斜体')
  assert.equal(mdPlainSummary('~~删除~~'), '删除')
  assert.equal(mdPlainSummary('***又粗又斜***'), '又粗又斜')
})

test('摘要剥掉列表/标题/引用行记号', () => {
  assert.equal(mdPlainSummary('- 列表项一\n- 列表项二'), '列表项一 列表项二')
  assert.equal(mdPlainSummary('1. 第一步\n2. 第二步'), '第一步 第二步')
  assert.equal(mdPlainSummary('## 小标题'), '小标题')
  assert.equal(mdPlainSummary('> 引用行'), '引用行')
})

test('摘要保留链接文字、图片 alt、行内代码内容', () => {
  assert.equal(mdPlainSummary('[链接文本](https://example.com/a)'), '链接文本')
  assert.equal(mdPlainSummary('![封面图](https://example.com/a.png)'), '封面图')
  assert.equal(mdPlainSummary('`inline code` 片段'), 'inline code 片段')
  assert.equal(mdPlainSummary('```js\nconst a = 1\n```'), 'const a = 1')
})

test('摘要把换行与多余空白压成单空格', () => {
  assert.equal(mdPlainSummary('第一行\n第二行\n\n第三行'), '第一行 第二行 第三行')
  assert.equal(mdPlainSummary('  两边有空格  '), '两边有空格')
})

test('摘要超长按上限截断并加省略号', () => {
  const out = mdPlainSummary('长'.repeat(200), 120)
  assert.equal(out.length, 120)
  assert.ok(out.endsWith('…'))
  assert.equal(mdPlainSummary('短文本', 120), '短文本')
})

test('摘要不误伤普通文本与 snake_case', () => {
  assert.equal(mdPlainSummary('run_id 与 fallback_effort 已就绪'), 'run_id 与 fallback_effort 已就绪')
  assert.equal(mdPlainSummary('纯文本消息'), '纯文本消息')
})

test('渲染接线：引用块与引用按钮都走 mdPlainSummary', () => {
  assert.match(source, /mdPlainSummary\(message\.reply_to\.excerpt, 120\)/, '引用块摘要应剥 markdown 记号')
  assert.match(source, /data-excerpt="\$\{attr\(mdPlainSummary\(message\.body, 120\)\)\}"/, '引用按钮摘要应剥 markdown 记号')
  assert.match(source, /mdPlainSummary\(state\.replyTo\.excerpt, 120\)/, '引用回复条摘要应剥 markdown 记号')
})

test('样式：气泡与引用块都不许超出容器宽度', () => {
  const bubble = /\n\.message-bubble\s*\{([\s\S]*?)\n\}/.exec(css)?.[1]
  assert.ok(bubble, '缺少 .message-bubble 规则')
  assert.match(bubble, /max-width:\s*100%/, '气泡必须封顶容器宽度，否则引用摘要的 min-content 会把它顶出聊天列')
  const quote = /\n\.msg-quote\s*\{([\s\S]*?)\n\}/.exec(css)?.[1]
  assert.ok(quote, '缺少 .msg-quote 规则')
  assert.match(quote, /max-width:\s*100%/, '引用块必须封顶气泡内容宽')
  assert.match(quote, /overflow:\s*hidden/, '引用块需要裁掉溢出内容')
  assert.match(quote, /min-width:\s*0/, '引用块需要 min-width:0 才能在 flex 里收缩')
})

test('样式：引用摘要两行截断，不再是单行 nowrap', () => {
  const span = /\n\.msg-quote span\s*\{([\s\S]*?)\n\}/.exec(css)?.[1]
  assert.ok(span, '缺少 .msg-quote span 规则')
  assert.match(span, /-webkit-line-clamp:\s*2/, '摘要应两行截断')
  assert.match(span, /display:\s*-webkit-box/)
  assert.match(span, /-webkit-box-orient:\s*vertical/)
  assert.match(span, /overflow-wrap:\s*anywhere/, '长词/长串要能换行，不能把气泡撑宽')
  assert.match(span, /overflow:\s*hidden/)
  assert.match(span, /min-width:\s*0/)
  assert.doesNotMatch(span, /white-space:\s*nowrap/, '摘要不许再走单行 nowrap（那会把整条摘要挤成一行）')
})

test('样式：气泡补 min-width:0，flex 里才收缩得下来', () => {
  const bubble = /\n\.message-bubble\s*\{([\s\S]*?)\n\}/.exec(css)?.[1]
  assert.ok(bubble, '缺少 .message-bubble 规则')
  assert.match(bubble, /min-width:\s*0/)
})
