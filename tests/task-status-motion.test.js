// DSHBOTS-122：右侧「活跃任务」栏里的「进行中」状态标签加 swim 摆动动效。
// 等效复刻 DSH 原生会话页 hero 的鱼尾动画——原生实现是构建期哈希类名的纯 CSS
// 三帧 keyframes，不可直接引用（随宿主版本漂移），故本仓自己落地一份等价实现：
//   @keyframes task-status-swim { 0%,100% none / 35% rotate(-4deg) / 70% rotate(1.6deg) }
// 硬约束三条：①动效只挂在「进行中」标签上；②无障碍闸门——只有
// prefers-reduced-motion: no-preference 时才启用（对齐宿主做法）；③只用 transform，
// 不引发重排、不新增色值。本文件读 ui/styles.css 与 ui/app.js 真源做断言（仓库先例：
// tests/message-link-contrast.test.js、tests/question-ui.test.js），不复制一份样式到测试里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const css = readFileSync(join(root, 'ui', 'styles.css'), 'utf8')
const app = readFileSync(join(root, 'ui', 'app.js'), 'utf8')
const zh = readFileSync(join(root, 'ui', 'i18n', 'zh.js'), 'utf8')

// 注释里可能带花括号，先剥掉再配平。
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

function matchingBrace(source, open) {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('CSS 块花括号不配平')
}

function blockAt(source, from) {
  const open = source.indexOf('{', from)
  assert.ok(open >= 0, 'CSS 块起始未找到')
  return source.slice(open + 1, matchingBrace(source, open))
}

// 去掉某个媒体查询整块（闸门之外的内容）：保留块外文本，块体整段移除。
function removeMediaBlock(source, condition) {
  const index = source.indexOf(condition)
  if (index < 0) return source
  const open = source.indexOf('{', index)
  const close = matchingBrace(source, open)
  return source.slice(0, index) + source.slice(close + 1)
}

// 取某个 @media 条件下的规则体：条件文本命中才返回块体。
function mediaBlock(condition) {
  const index = bare.indexOf(condition)
  assert.ok(index >= 0, `CSS 里找不到媒体查询：${condition}`)
  return blockAt(bare, index)
}

function keyframesBody(name) {
  const index = bare.indexOf(`@keyframes ${name}`)
  assert.ok(index >= 0, `CSS 里找不到 @keyframes ${name}`)
  return blockAt(bare, index)
}

// ---- 用例 ------------------------------------------------------------------

test('swim 关键帧存在：三帧摆动用 transform 表达，且不含会引发重排的属性', () => {
  const body = keyframesBody('task-status-swim')
  assert.match(body, /0%\s*,\s*100%\s*\{[^}]*transform\s*:\s*none/, '首尾帧应回到静止位')
  assert.match(body, /35%\s*\{[^}]*transform\s*:\s*rotate\(-4deg\)/, '35% 帧应向左倾 -4deg')
  assert.match(body, /70%\s*\{[^}]*transform\s*:\s*rotate\(1\.6deg\)/, '70% 帧应向右倾 1.6deg')
  // 只允许 transform：top/left/margin/width 等会触发布局重排。
  const props = [...body.matchAll(/(^|[{;])\s*([a-z-]+)\s*:/g)].map((m) => m[2])
  const layoutProps = props.filter((p) => !['transform', 'animation-timing-function'].includes(p))
  assert.deepEqual(layoutProps, [], `关键帧里出现非 transform 属性：${layoutProps.join(', ')}`)
})

test('无障碍闸门：动画只在 prefers-reduced-motion: no-preference 下启用', () => {
  const gate = mediaBlock('@media (prefers-reduced-motion: no-preference)')
  assert.match(gate, /\.task-status-live\s*\{[^}]*animation\s*:\s*task-status-swim/, '动效必须挂在 .task-status-live 上')
  assert.match(gate, /animation\s*:\s*task-status-swim\s+1\.6s\s+ease-in-out\s+infinite/, '动效参数应为 1.6s ease-in-out infinite')

  // 反向护栏：no-preference 闸门之外不得再有裸的 .task-status-live 动画规则。
  const outside = removeMediaBlock(bare, '@media (prefers-reduced-motion: no-preference)')
  const liveRules = [...outside.matchAll(/\.task-status-live\s*\{([^}]*)\}/g)].map((m) => m[1])
  for (const body of liveRules) {
    assert.doesNotMatch(body, /animation\s*:/, '.task-status-live 不得在闸门外出现 animation 声明')
  }
})

test('动效不新增色值：标签配色仍走既有 token', () => {
  const gate = mediaBlock('@media (prefers-reduced-motion: no-preference)')
  assert.doesNotMatch(gate, /#[0-9a-f]{3,8}\b/i, '动效规则里不得出现字面色值')
  assert.doesNotMatch(gate, /rgba?\(|hsla?\(/i, '动效规则里不得出现字面颜色函数')
  const label = blockAt(bare, bare.indexOf('.side-row .side-row-status'))
  assert.match(label, /color\s*:\s*var\(--ink-3\)/, '状态标签配色仍是既有 --ink-3')
})

test('挂载点：只有「进行中」标签挂 .task-status-live，且所有状态标签都走同一渲染函数', () => {
  assert.match(app, /function sideRowStatusHtml\(status\)/, '缺少 sideRowStatusHtml 渲染函数')
  assert.match(
    app,
    /status\s*===\s*'in_progress'\s*\?\s*' task-status-live'\s*:\s*''/,
    '只有 in_progress 才挂 task-status-live',
  )
  // 所有侧栏任务行的状态标签都必须走这一个函数，避免出现绕过动效的裸标签。
  const rawLabels = app.match(/<span class="side-row-status">/g) ?? []
  assert.equal(rawLabels.length, 0, '不应残留未接管的裸 side-row-status 标签')
  const calls = app.match(/sideRowStatusHtml\(task\.status\)/g) ?? []
  assert.equal(calls.length, 2, '活跃任务卡与调度任务行两处都应走 sideRowStatusHtml')
  assert.match(app, /card\.activeTasks[\s\S]{0,1200}sideRowStatusHtml\(task\.status\)/, '活跃任务卡应使用 sideRowStatusHtml')
})

test('「进行中」文案仍由 i18n 提供（动效不改动文案本身）', () => {
  assert.match(zh, /'status\.in_progress':\s*'进行中'/, '中文「进行中」文案缺失')
  // 标签文案走 statusLabel() → t('status.' + status)，动效没有把文案写死进模板。
  assert.match(app, /sideRowStatusHtml[\s\S]{0,400}esc\(statusLabel\(status\)\)/, '状态标签文案应走 statusLabel（i18n）')
})
