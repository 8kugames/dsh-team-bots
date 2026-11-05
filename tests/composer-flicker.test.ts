import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'

const source = readUiSource()

// DSHBOTS-153（composer-flicker）：轮询全量重建出的新 textarea 一开始没有内联高度，
// 浏览器先把 rows=2 内在高度（约 57.5px）画出去，下一帧 rAF 里 applyComposerHeight
// 才设回目标 px——空输入即每 2.8s 一次高度跳变（实测 57.5↔58，jumps=8/12.5s）。
// 修法：applyComposerHeight 记录最近一次应用的 px（composerAppliedHeightPx），
// 两处 composer 模板重建时直接内联同值；rAF 里 syncComposerBox 保留作纠错。
test('重建内联：群聊与单聊 composer 模板都携带最近应用的高度（null 时不输出 style）', () => {
  const withInline = source.match(
    /id="composer-input" rows="2"\$\{composerAppliedHeightPx \? ` style="height:\$\{composerAppliedHeightPx\}px"` : ''\} placeholder=/g,
  )
  assert.equal(withInline?.length, 2, '群聊与单聊两处 textarea 都应在重建时内联 composerAppliedHeightPx')
})

test('记录逻辑：applyComposerHeight 把最终裁决 px 写回 composerAppliedHeightPx（null 起步）', () => {
  assert.match(source, /let composerAppliedHeightPx = null/, '模块级声明必须存在且首渲染前为 null')
  assert.match(
    source,
    /const px = composerHeightFor\(auto, state\.composerHeight, composerPanelCap\(input\)\)/,
    'px 仍须走 composerHeightFor 的 cap/manual 裁决（D-4 拖高口径不变）',
  )
  assert.match(source, /input\.style\.height = `\$\{px\}px`/, '落 DOM 的高度与记录值必须是同一个 px')
  const setDom = source.indexOf('input.style.height = `${px}px`')
  const record = source.indexOf('composerAppliedHeightPx = px')
  assert.ok(setDom !== -1 && record > setDom, '记录必须发生在落 DOM 之后，两值恒一致')
})

test('模块接线：composer.js export 块登记 composerAppliedHeightPx，chat.js import 引用（缺任一则模块图断裂）', () => {
  assert.match(source, /export \{[^\n]*composerAppliedHeightPx/, 'composer.js 的 EOF export 块必须登记')
  assert.match(
    source,
    /import \{[^\n]*composerAppliedHeightPx[^\n]*\} from '\.\/composer\.js'/,
    'chat.js 必须 import 该活绑定',
  )
})

test('纠错保留：重建后的 rAF 仍调用 syncComposerBox，resize/内容变化路径不回归', () => {
  assert.match(source, /syncComposerBox\(composerInput\)/, 'render() 的 rAF 纠错钩子必须保留')
  assert.match(source, /function applyComposerHeight\(input\) \{\n  input\.style\.height = 'auto'/, 'auto 测量序列保持不变（funnel 唯一）')
})
