import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { uiStylesSource } from './ui-styles-source.js'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
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
