// DSHBOTS-148：右侧「活跃任务」栏「进行中」状态标签在摆动（DSHBOTS-122）之上
// 再叠一层流光——周期性扫过的高光带（shimmer sheen）。
// 实现口径：覆盖层用 ::after + linear-gradient（透明→高光→透明）+ translateX 扫过，
// 只动 transform 不触发布局重排；高光色由既有 token 用 color-mix 合成，零新增色值；
// pointer-events:none 不拦截点击；prefers-reduced-motion 闸门同时覆盖摆动与流光。
// 本文件读页面 CSS 汇总真源（ui/styles/* 拼接，DSHBOTS-160）做源码断言，不复制一份样式
// 到测试里（仓库先例：tests/task-status-motion.test.js、tests/message-link-contrast.test.js）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uiStylesSource } from './ui-styles-source.js'

const css = await uiStylesSource()

// 注释里可能带花括号，先剥掉再配平。
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

const MOTION_GATE = '@media (prefers-reduced-motion: no-preference)'

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

// 取某个 @media 条件下的规则体：条件文本命中才返回块体（首个命中）。
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

// 覆盖层的规则体（允许 ::after 之类的伪类后缀）。
function ruleBody(selector) {
  const index = bare.indexOf(selector)
  assert.ok(index >= 0, `CSS 里找不到规则：${selector}`)
  return blockAt(bare, index)
}

// ---- 用例 ------------------------------------------------------------------

test('流光关键帧存在：只动 transform，不触发布局重排', () => {
  const body = keyframesBody('task-status-sheen')
  assert.match(body, /translateX\(-140%\)/, '起始帧应在标签左侧之外（扫光从左侧进入）')
  assert.match(body, /translateX\(140%\)/, '结束帧应扫到标签右侧之外')
  const props = [...body.matchAll(/(^|[{;])\s*([a-z-]+)\s*:/g)].map((m) => m[2])
  const layoutProps = props.filter((p) => p !== 'transform')
  assert.deepEqual(layoutProps, [], `关键帧里出现非 transform 属性：${layoutProps.join(', ')}`)
})

test('扫光覆盖层存在：::after + linear-gradient 高光带，且不拦截点击', () => {
  const gate = mediaBlock(MOTION_GATE)
  const overlay = ruleBody('.task-status-live::after')
  assert.ok(gate.includes('.task-status-live::after'), '覆盖层必须落在动效闸门内')
  assert.match(overlay, /content:\s*""/, '覆盖层需要 content 才生成盒子')
  assert.match(overlay, /position:\s*absolute/, '覆盖层需绝对定位，不占布局')
  assert.match(overlay, /inset:\s*0/, '覆盖层应铺满标签盒')
  assert.match(overlay, /pointer-events:\s*none/, '扫光层不得拦截点击')
  assert.match(overlay, /background:\s*linear-gradient\(/, '高光带应由 linear-gradient 生成')
  assert.match(overlay, /var\(--task-sheen-tint\)/, '高光色走 token，不写字面色值')
  assert.match(
    overlay,
    /animation:\s*task-status-sheen\s+2\.8s\s+ease-in-out\s+infinite/,
    '流光动画应为 2.8s ease-in-out infinite',
  )
})

test('reduced-motion 覆盖（例一）：闸门之外不得再出现扫光覆盖层与流光动画', () => {
  const outside = removeMediaBlock(bare, MOTION_GATE)
  assert.doesNotMatch(outside, /\.task-status-live::after/, '闸门外不得定义扫光覆盖层')
  assert.doesNotMatch(outside, /animation:\s*task-status-sheen/, '闸门外不得引用流光动画')
  // 覆盖层自身的动画声明只允许出现在闸门内的 .task-status-live::after 规则上。
  const outsideOverlay = [...outside.matchAll(/\.task-status-live::after\s*\{([^}]*)\}/g)]
  assert.equal(outsideOverlay.length, 0, '闸门外不应存在 .task-status-live::after 规则')
})

test('reduced-motion 覆盖（例二）：流光与摆动共用同一道 no-preference 闸门', () => {
  const gate = mediaBlock(MOTION_GATE)
  assert.match(gate, /animation:\s*task-status-swim/, '摆动动效仍受该闸门约束')
  assert.match(gate, /animation:\s*task-status-sheen/, '流光动效必须同受该闸门约束')
  // 闸门内不得出现 prefers-reduced-motion: reduce 的反向分支（避免两套口径打架）。
  assert.doesNotMatch(gate, /prefers-reduced-motion:\s*reduce/, '闸门内不应再开 reduce 分支')
  // 减动偏好下标签退化为静态状态色：颜色仍由既有 token 提供。
  const label = ruleBody('.side-row .side-row-status')
  assert.match(label, /color:\s*var\(--ink-3\)/, '状态标签配色仍是既有 --ink-3')
})

test('流光与摆动错拍：时长不同且非整数倍，避免两层动效每次同步', () => {
  const gate = mediaBlock(MOTION_GATE)
  const swim = gate.match(/animation:\s*task-status-swim\s+([\d.]+)s/)
  const sheen = gate.match(/animation:\s*task-status-sheen\s+([\d.]+)s/)
  assert.ok(swim && sheen, '摆动与流光的 animation 声明都应存在')
  const swimSec = Number(swim[1])
  const sheenSec = Number(sheen[1])
  assert.notEqual(swimSec, sheenSec, '两层动效时长不应相同')
  const ratio = sheenSec / swimSec
  assert.ok(
    Math.abs(ratio - Math.round(ratio)) > 0.01,
    `流光与摆动时长应为非整数倍关系（当前 ${sheenSec}s / ${swimSec}s）`,
  )
})

test('零新增色值：高光色由既有 token 的 color-mix 合成', () => {
  const gate = mediaBlock(MOTION_GATE)
  assert.doesNotMatch(gate, /#[0-9a-f]{3,8}\b/i, '动效规则里不得出现字面色值')
  assert.doesNotMatch(gate, /rgba?\(|hsla?\(/i, '动效规则里不得出现字面颜色函数')
  const defs = [
    ...bare.matchAll(
      /--task-sheen-tint:\s*color-mix\(in srgb,\s*var\(--accent\)\s+([\d.]+)%\s*,\s*transparent\s*\)/g,
    ),
  ]
  assert.equal(defs.length, 2, '高光色应在亮色与暗色各定义一次（明暗两套）')
  for (const def of defs) {
    assert.ok(
      def[0].includes('var(--accent)'),
      '高光色必须由既有 token（--accent 系）合成，不得引入新色',
    )
  }
})

test('明暗两套：深色压低高光占比避免刺眼，亮色保证可见', () => {
  // DSHBOTS-349：暗色根块改由 :root[data-color-scheme="dark"] 承载（媒体查询包裹已删）。
  const darkIndex = bare.indexOf(':root[data-color-scheme="dark"] {')
  assert.ok(darkIndex >= 0, 'CSS 缺少 :root[data-color-scheme="dark"] 暗色根块')
  const darkRoot = blockAt(bare, darkIndex)
  assert.ok(darkRoot.includes('--task-sheen-tint'), '暗色根块应覆盖高光色定义')
  const pct = (body) => {
    const m = body.match(/--task-sheen-tint:[^;]*?var\(--accent\)\s+([\d.]+)%/)
    assert.ok(m, '高光色定义里应能读出占比')
    return Number(m[1])
  }
  const darkPct = pct(darkRoot)
  const lightDefs = [
    ...bare.matchAll(
      /--task-sheen-tint:\s*color-mix\(in srgb,\s*var\(--accent\)\s+([\d.]+)%\s*,\s*transparent\s*\)/g,
    ),
  ].map((m) => Number(m[1]))
  const lightPct = lightDefs.find((v) => v !== darkPct)
  assert.ok(lightPct !== undefined, '亮色下的高光色定义缺失')
  assert.ok(darkPct < lightPct, `深色下高光占比（${darkPct}%）必须低于亮色（${lightPct}%）`)
  assert.ok(darkPct <= 20, `深色下高光占比应压到 20% 以内，当前 ${darkPct}%`)
  assert.ok(lightPct >= 25, `亮色下高光占比应不低于 25%，否则看不见，当前 ${lightPct}%`)
})
