import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

const source = readUiSource()
const css = await uiStylesSource()

test('任务详情 modal 占页面宽度 68.2%，窄屏回落全宽', () => {
  const modalTask = /function modalTask\(task\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(modalTask, '找不到 modalTask 函数体')
  assert.match(modalTask, /size: 'task'/, '任务详情用独立尺寸类，不动其它 wide modal')
  assert.match(css, /\.modal\.task \{\s*width: min\(68\.2vw, 100%\);/, '任务详情宽度为页宽 68.2%')
  assert.match(css, /@media \(max-width: 900px\) \{[\s\S]*?\.modal\.task \{\s*width: 100%;/, '窄屏回落全宽，避免挤压表单')
  assert.ok(!/\.modal\.task \{[^}]*width: min\(920px/.test(css), '未沿用旧的 920px 固定宽度')
})

test('交付产物默认收起：与「查看输出」同一折叠口径', () => {
  assert.match(source, /function runArtifacts\(state, run\)/, '交付产物渲染需要 state 以记住展开态')
  assert.match(
    source,
    /<details style="margin-top:6px"\$\{panelAttrs\(state, `run-artifacts:\$\{run\.id\}`\)\}><summary class="summary-link">交付产物（/,
    '交付产物包在 details/summary 里，且默认不带 open（收起）',
  )
  assert.match(source, /\$\{runArtifacts\(state, run\)\}/, '调用处传入 state')
  assert.match(source, /<summary class="summary-link">查看输出<\/summary>/, '与「查看输出」同一 summary-link 样式')
  assert.ok(!/artifact-list"><div class="eyebrow"[^>]*>交付产物</.test(source), '不再以常驻 eyebrow 展开展示交付产物')
})

// —— 沙箱档位标签（DSHBOTS-157）——
// runView 已透出 sandboxMode（生效档：非 write 运行恒 read-only；写运行取派发收紧覆盖或 bot 文件策略）。
// 任务详情的运行记录里渲成轻量标签；档位为空不渲。只复用既有 pill token，零新增色值。
const sandboxBlock = /\/\/ sandbox-pill:start[\s\S]*?\/\/ sandbox-pill:end/.exec(source)?.[0]
const escStub = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const attrStub = escStub
const sandboxPill = sandboxBlock
  ? new Function('esc', 'attr', `${sandboxBlock.replace('export ', '')}\nreturn sandboxPill`)(escStub, attrStub)
  : null

test('运行记录渲染生效沙箱档位标签：sandboxMode 非空出「沙箱 {mode}」', () => {
  assert.ok(sandboxBlock, 'ui 应有 sandbox-pill 标记块（util.js 的沙箱标签出口）')
  assert.ok(sandboxPill, 'sandboxPill 应可独立求值')
  const html = sandboxPill('workspace-write')
  assert.match(html, /沙箱 workspace-write/, '标签文案为「沙箱 {mode}」')
  assert.match(html, /class="pill green"/, '可写档位用既有 green 档位色')
  assert.match(html, /title="生效沙箱档位：workspace-write"/, '悬停给出档位说明')
  assert.match(source, /run-row-meta">\$\{runClockSpan\(run\)\}\$\{sandboxPill\(run\.sandboxMode\)\}/, '任务详情运行行插入沙箱档位标签（时长槽位之后）')
})

test('沙箱档位为空不渲染标签（null/空串/未知档位不崩）', () => {
  assert.ok(sandboxPill, 'sandboxPill 应可独立求值')
  assert.equal(sandboxPill(null), '', 'null 不渲染')
  assert.equal(sandboxPill(''), '', '空串不渲染')
  assert.equal(sandboxPill(undefined), '', 'undefined 不渲染')
  const unknown = sandboxPill('some-future-tier')
  assert.match(unknown, /沙箱 some-future-tier/, '未知档位照常显示原值，不吞信息')
  assert.match(unknown, /class="pill "/, '未知档位退回中性 pill，不臆造色值')
})

test('沙箱标签只复用既有 pill token：零新增色值', () => {
  assert.ok(sandboxBlock, 'ui 应有 sandbox-pill 标记块')
  const tones = [...sandboxBlock.matchAll(/':\s*'([a-z]+)'/g)].map((m) => m[1])
  assert.ok(tones.length > 0, '应能从标记块读出档位色映射')
  for (const tone of tones) {
    assert.ok(['green', 'amber', 'red', 'violet'].includes(tone), `档位色 ${tone} 必须是既有 pill token`)
    assert.match(css, new RegExp(`\\.pill\\.${tone}\\b`), `样式表已有 .pill.${tone}，无需新增色值`)
  }
  assert.doesNotMatch(sandboxBlock, /#[0-9a-fA-F]{3,8}\b/, '标签不得内联新的色值')
})
