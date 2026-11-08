// tests/chat-collapse.test.ts —— B8/DSHBOTS-336：连续系统通知折叠守门。
// 前端用例沿用仓库先例：标记块 new Function 执行真实源码。守门四向：
// ①纯函数行为——≥3 条连续 system 折叠、<3 原样、非 system 断组、组键按首条 id 跨轮询稳定；
// ②展开态持久——state.expandedCollapses 命中的组整组原样展开（2.8s 轮询不重开）；
// ③折叠行不丢信息——计数 + 末条摘要 + toggle 动作在场；
// ④接线锚——renderChat 走折叠序列、events-click 有 toggle-collapse 分支、i18n 键入典；
// ⑤样式锚——chat-cards.css 的 .msg-collapse-row > svg 规则块内含 width 与 height（防尺寸约束再失配）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readUiSource } from './helpers/ui-sources.js'

const here = fileURLToPath(new URL('..', import.meta.url))
const chatSource = readFileSync(join(here, 'ui', 'modules', 'chat.ts'), 'utf8')
const clickSource = readFileSync(join(here, 'ui', 'modules', 'events-click.ts'), 'utf8')
const stateSource = readFileSync(join(here, 'ui', 'modules', 'state.ts'), 'utf8')
const utilSource = readFileSync(join(here, 'ui', 'modules', 'util.ts'), 'utf8')
const chatCardsCss = readFileSync(join(here, 'ui', 'styles', 'chat-cards.css'), 'utf8')
readUiSource()

const markerBlock = (source, name) => {
  const match = source.match(new RegExp(`// ===== ${name}:start[\\s\\S]*?// ===== ${name}:end =====`))
  assert.ok(match, `${name} 标记块必须存在`)
  return match[0]
}

const attrStub = (value) => String(value ?? '')
const iconStub = () => '<svg></svg>'
const tStub = (key: any, params?: any) => key === 'chat.collapseLabel' ? `${params?.count} 条系统通知` : key
// mdPlainSummary 取 util/markdown 真实实现（与前端同一份）——折叠行末条摘要走同一管线。
const mdSource = readFileSync(join(here, 'ui', 'modules', 'markdown.ts'), 'utf8')
const mdPlainSource = mdSource.match(/function mdPlainSummary\([\s\S]*?\n\}/)[0]
const mdPlainSummary = new Function(`${mdPlainSource}\nreturn mdPlainSummary`)()

const build = () => {
  const expanded = new Set()
  const state = { expandedCollapses: expanded }
  const source = `${markerBlock(chatSource, 'auto-collapse')}`
  const escStub = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  const fns = new Function('state', 'attr', 'icon', 't', 'mdPlainSummary', 'esc', `${source}
return { collapseAutoMessages, collapseRowView, COLLAPSE_MIN }`)(state, attrStub, iconStub, tStub, mdPlainSummary, escStub)
  return { ...fns, expanded }
}

const msg = (id, senderType, body = `内容 ${id}`) => ({ id, sender_type: senderType, body })
const sys = (id, body = `系统通知 ${id}`) => msg(id, 'system', body)

test('折叠行为：≥3 条连续 system 折叠为组，<3 原样，非 system 断组', () => {
  const { collapseAutoMessages, COLLAPSE_MIN } = build()
  assert.equal(COLLAPSE_MIN, 3)
  // 两段连续系统通知被中间 bot 消息断开：2+2 均不折叠。
  const short = [sys('s1'), sys('s2'), msg('b1', 'bot'), sys('s3'), sys('s4')]
  assert.deepEqual(collapseAutoMessages(short).map(item => item.id ?? item.collapsed), ['s1', 's2', 'b1', 's3', 's4'])
  // 3 条连续系统通知折叠为一行。
  const long = [msg('u1', 'user'), sys('s1'), sys('s2'), sys('s3'), msg('b1', 'bot')]
  const view = collapseAutoMessages(long)
  assert.equal(view.length, 3)
  assert.equal(view[1].collapsed, true)
  assert.equal(view[1].key, 'collapse:s1', '组键=首条消息 id（跨轮询稳定）')
  assert.equal(view[1].count, 3)
  assert.equal(view[1].last.id, 's3', '末条摘要取组尾')
})

test('展开态持久：expandedCollapses 命中的组整组原样展开', () => {
  const { collapseAutoMessages, expanded } = build()
  expanded.add('collapse:s1')
  const long = [sys('s1'), sys('s2'), sys('s3'), sys('s4')]
  const view = collapseAutoMessages(long)
  assert.equal(view.length, 4, '展开态下整组原样渲染（跨轮询不重开）')
  assert.deepEqual(view.map(item => item.id), ['s1', 's2', 's3', 's4'])
})

test('折叠行不丢信息：计数 + 末条摘要 + toggle 动作在场', () => {
  const { collapseRowView } = build()
  const row = collapseRowView({ key: 'collapse:s1', count: 5, last: sys('s5', '验收通过，任务已收口') })
  assert.match(row, /data-action="toggle-collapse"/)
  assert.match(row, /data-group="collapse:s1"/)
  assert.match(row, /5 条系统通知/)
  assert.match(row, /验收通过，任务已收口/, '末条摘要保留入口')
})

test('接线锚：renderChat 走折叠序列、toggle 分支在场、state/i18n 入位', () => {
  assert.match(chatSource, /collapseAutoMessages\(messages\)\.map\(item => item\.collapsed \? collapseRowView\(item\) : renderMessage\(item\)\)/)
  assert.match(clickSource, /case 'toggle-collapse':/)
  assert.match(clickSource, /state\.expandedCollapses\.has\(key\)/)
  assert.match(stateSource, /expandedCollapses: new Set\(\)/)
  const zh = readFileSync(join(here, 'ui', 'i18n', 'zh', 'chat.ts'), 'utf8')
  const en = readFileSync(join(here, 'ui', 'i18n', 'en', 'chat.ts'), 'utf8')
  assert.match(zh, /"chat\.collapseLabel": "\$\{count\} 条系统通知"/)
  assert.match(en, /"chat\.collapseLabel": "\$\{count\} system notices"/)
})

test('样式锚：折叠行 chevron 有显式 width/height 尺寸约束', () => {
  // icon() 产出的 svg 只带 viewBox、无 width/height 属性，CSS 不约束时按 replaced element
  // 默认尺寸渲染（约 300×150），会把群聊折叠行撑破——此处锚住尺寸约束不失配。
  const match = chatCardsCss.match(/\.msg-collapse-row\s*>\s*svg\s*\{([^}]*)\}/)
  assert.ok(match, '.msg-collapse-row > svg 规则必须存在')
  const body = match[1]
  const width = body.match(/width:\s*(\d+(?:\.\d+)?)px/)
  const height = body.match(/height:\s*(\d+(?:\.\d+)?)px/)
  assert.ok(width, '折叠行 chevron 必须显式约束 width')
  assert.ok(height, '折叠行 chevron 必须显式约束 height')
  assert.ok(Number(width[1]) <= 24 && Number(height[1]) <= 24, '折叠行 chevron 尺寸应在 24px 内，不得退回默认渲染尺寸')
})
