import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'

const source = readUiSource()
const modalCss = readFileSync(fileURLToPath(new URL('../ui/styles/modal.css', import.meta.url)), 'utf8')

// —— DSHBOTS-154：任务详情 modal 滚动稳定性 ——
// 取证结论（CDP 活体）：2.8s 轮询期间 renderModalLayer 根本不被调（render() 的遮罩闸门
// 拦截，#app 与 #modal-root 零 DOM 写入）；滚动中唯一的正文重建路径是动作触发的
// reloadTaskModal，而 modalTask 运行行内嵌的 duration()（running 无 end、按 Date.now() 计）
// 每秒必变，使任何动作刷新的字符串比对必然不相等 → 必走正文重建 → 滚动中肉眼可见。
// 修复口径：①易变时长改稳定占位 + data-started（1s 定时器定点刷新文本，见 updateRunClocks）；
// ③滚动进行中（100ms 内有滚动事件）延后正文补丁到滚动停止；no-op 路径（html 未变即 return）
// 保持不变。以下断言把这三条锁进源码与行为。

// —— 迷你 DOM：与 tests/modal-layer.test.js 同一套子集（该文件先例）——
class FakeHTMLElement {}
const makeNode = (over = {}) => {
  const node = {
    children: [], parent: null, _innerHTML: '', className: '', attrs: {}, scrollTop: 0, id: '', focusCalls: 0,
    get firstElementChild() { return node.children[0] ?? null },
    get childNodes() { return [...node.children] },
    classList: { contains: c => String(node.className).split(/\s+/).includes(c) },
    querySelector(sel) {
      if (sel.startsWith('.')) return node.children.find(c => c.classList.contains(sel.slice(1))) ?? null
      const byId = /^\[id="(.*)"\]$/.exec(sel)
      if (byId) return node.children.find(c => c.id === byId[1]) ?? null
      return null
    },
    appendChild(...cs) { cs.forEach(c => { c.parent = node; node.children.push(c) }); return cs[0] },
    append(...cs) { cs.forEach(c => { c.parent = node; node.children.push(c) }) },
    prepend(...cs) { cs.forEach(c => { c.parent = node; node.children.unshift(c) }) },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter(x => x !== node) },
    replaceWith(n) { n.parent = node.parent; const i = node.parent.children.indexOf(node); node.parent.children[i] = n },
    replaceChildren(...cs) { cs.forEach(c => { c.parent = node }); node.children = [...cs] },
    setAttribute(k, v) { node.attrs[k] = v },
    getAttribute(k) { return node.attrs[k] ?? null },
    contains() { return false },
    focus() { node.focusCalls += 1 },
    set innerHTML(v) { node._innerHTML = v; node.parse?.(v) },
    get innerHTML() { return node._innerHTML },
    ...over,
  }
  return node
}

const makeModalTree = ({ panelClass = 'modal task', bodyHtml = '<p>v1</p>' } = {}) => {
  const backdrop = makeNode({ className: 'modal-backdrop' })
  const panel = makeNode({ className: panelClass })
  const head = makeNode({ className: 'modal-head' })
  const body = makeNode({ className: 'modal-body' })
  body._innerHTML = bodyHtml
  const foot = makeNode({ className: 'modal-foot' })
  backdrop.appendChild(panel)
  panel.append(head, body, foot)
  return { backdrop, panel, head, body, foot }
}

// 抽取 modal-layer 标记块（与 tests/modal-layer.test.js 同一锚点）
const block = /let lastModalHtml = ''[\s\S]*?\n\}\n\/\/ modal-layer:end/.exec(source)?.[0]
assert.ok(block, 'ui/app.js 缺少 modal-layer 标记块')
const fnSrc = block.replace(/\n\/\/ modal-layer:end$/, '')

// 求值 modal-layer 块：额外以参数遮蔽 performance/setTimeout，行为测试可控时间与定时器；
// 并在返回对象里带出守卫内部状态（__setScroll / last），供断言「延后期间 lastModalHtml 不更新」。
const makeLayerHarness = ({ trees } = {}) => {
  const root = makeNode()
  root.parse = h => { if (trees[h]) root.children = [trees[h]] }
  const doc = {
    _trees: trees,
    getElementById: id => (id === 'modal-root' ? root : null),
    body: { appendChild() {} },
    activeElement: null,
    createElement: () => { const n = makeNode(); n.parse = h => { if (doc._trees[h]) n.children = [doc._trees[h]] }; return n },
  }
  let now = 1000
  let scheduled = null
  const scope = new Function(
    'document', 'renderModal', 'HTMLElement', 'performance', 'setTimeout',
    `${fnSrc}\nreturn { renderModalLayer, __setScroll: t => { modalScrollAt = t }, get last() { return lastModalHtml }, __timer: () => modalPatchTimer }`,
  )(
    doc,
    () => current,
    FakeHTMLElement,
    { now: () => now },
    cb => { scheduled = cb; return 1 },
  )
  let current = ''
  return {
    root, scope,
    set current(v) { current = v }, get current() { return current },
    get now() { return now }, set now(v) { now = v },
    get scheduled() { return scheduled }, clearScheduled() { scheduled = null },
  }
}

// —— ① 易变内容移除：runClockSpan 行为 ——
test('runClockSpan：running 运行产出稳定占位（不含时长文本），终态运行产出静态时长', () => {
  const runClockSrc = /function runClockSpan\(run\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(runClockSrc, 'ui/app.js 缺少 runClockSpan（modalTask 运行行时长产出）')
  let calls = 0
  // 模拟真实 duration 的易变性：每次调用返回不同文本
  const durationStub = () => `T${++calls}s`
  const attrStub = v => String(v).replace(/"/g, '&quot;')
  const escStub = v => String(v)
  const runClockSpan = new Function('duration', 'attr', 'esc', `${runClockSrc}\nreturn runClockSpan`)(durationStub, attrStub, escStub)
  const running = { status: 'running', started_at: '2026-11-04T05:00:00.000Z', ended_at: null }
  const a = runClockSpan(running)
  const b = runClockSpan(running)
  assert.equal(a, b, '同一 running 运行两次产出逐字相等——字符串比对可走 no-op，不因时长秒级跳变必 diff')
  assert.match(a, /class="run-clock" data-started="2026-11-04T05:00:00\.000Z"/, 'running 走 data-started 定点刷新通道（1s 定时器只改 textContent）')
  assert.doesNotMatch(a, /T\d+s/, '占位符不含任何时长文本（duration 派生值不进字符串）')
  const done = { status: 'done', started_at: '2026-11-04T05:00:00.000Z', ended_at: '2026-11-04T05:01:00.000Z' }
  const ended = runClockSpan(done)
  assert.equal(ended, '<span>T1s</span>', '终态运行时长是静态事实，原样直出')
  assert.doesNotMatch(ended, /run-clock|data-started/, '终态不占刷新通道')
})

// —— ① 易变内容移除：modalTask 源码不再内嵌裸 duration() ——
test('modalTask：运行行时长改走 runClockSpan，模板内不再内嵌 duration()（易变内容出字符串）', () => {
  const modalTaskSrc = /function modalTask\(task\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(modalTaskSrc, 'ui/app.js 缺少 modalTask()')
  assert.doesNotMatch(modalTaskSrc, /duration\(/, 'modalTask 模板内不得再出现 duration()：running 运行的时长按 Date.now() 计，嵌进字符串会让 reloadTaskModal 的比对必然不相等')
  assert.match(modalTaskSrc, /run-row-meta">\$\{runClockSpan\(run\)\}/, '运行行 meta 的时长槽位改由 runClockSpan 产出（running → 稳定占位 + data-started）')
})

// —— ③ 滚动守卫：行为 ——
test('renderModalLayer：滚动进行中延后正文补丁，滚动停止后补拍；延后是单飞的', () => {
  const treeA = makeModalTree({ bodyHtml: '<p>v1</p>' })
  const treeB = makeModalTree({ bodyHtml: '<p>v2</p>' })
  const htmlA = 'HTML_A', htmlB = 'HTML_B'
  const h = makeLayerHarness({ trees: { [htmlA]: treeA.backdrop, [htmlB]: treeB.backdrop } })
  h.current = htmlA
  h.scope.renderModalLayer()
  assert.equal(treeA.body.innerHTML, '<p>v1</p>', '首挂立即写入（无旧内容可闪，不延后）')
  // 滚动进行中：最近一次滚动事件距今 10ms
  h.scope.__setScroll(h.now - 10)
  h.current = htmlB
  h.scope.renderModalLayer()
  assert.equal(treeA.body.innerHTML, '<p>v1</p>', '滚动中正文不被替换')
  assert.equal(h.scope.last, htmlA, '延后期间 lastModalHtml 不更新——补拍时仍能识别「内容变了」')
  assert.ok(h.scheduled, '延后补拍已排入定时器（120ms 后滚动停止再补）')
  assert.ok(h.scope.__timer(), '延后标记在档（单飞：重复触发不叠加定时器）')
  const first = h.scheduled
  h.current = htmlB
  h.scope.renderModalLayer()
  assert.equal(h.scheduled, first, '仍处延后窗口：定时器单飞，重复刷新不叠加新定时器')
  // 滚动停止：时间推进 500ms，补拍回调触发
  h.now += 500
  first()
  assert.equal(treeA.body.innerHTML, '<p>v2</p>', '滚动停止后补拍生效：内容追平，节点原位保留')
  assert.equal(h.scope.last, htmlB, '补拍后 lastModalHtml 更新——后续同内容刷新走 no-op')
})

// —— ③ 滚动守卫：源码接线 ——
test('守卫接线：defer 闸门在 no-op 之后/lastModalHtml 之前，关闭不延后，scroll 监听更新时间戳', () => {
  const layerSrc = /function renderModalLayer\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(layerSrc, 'ui/app.js 缺少 renderModalLayer()')
  const noopAt = layerSrc.indexOf('if (html === lastModalHtml) return')
  const deferAt = layerSrc.indexOf("if (html && root.firstElementChild?.classList?.contains('modal-backdrop') && modalScrollRecent())")
  const commitAt = layerSrc.indexOf('lastModalHtml = html')
  assert.ok(noopAt >= 0 && deferAt > noopAt, 'no-op 路径（html 未变即 return）仍是最先判断')
  assert.ok(commitAt > deferAt, 'defer 闸门在提交 lastModalHtml 之前：延后不吞掉后续 diff')
  assert.match(layerSrc, /if \(html && /, '关闭（html 为空）不延后：清层必须立即生效')
  assert.match(block, /function modalScrollRecent\(\) \{\n\s+return performance\.now\(\) - modalScrollAt < 100\n\}/, '滚动窗口 100ms（卡面口径）')
  assert.match(block, /function scheduleModalPatch\(\) \{\n\s+if \(modalPatchTimer\) return/, '补拍定时器单飞')
  // scroll 监听：scroll 不冒泡，捕获阶段在 window 可及；只认 .modal-body 内的滚动
  const scrollListener = /window\.addEventListener\('scroll', event => \{[\s\S]*?\}, \{ capture: true, passive: true \}\)/.exec(source)?.[0]
  assert.ok(scrollListener, '缺少 modal 滚动守卫的 scroll 监听')
  assert.match(scrollListener, /closest\?\.\('\.modal-body'\)/)
  assert.match(scrollListener, /noteModalScroll\(\)/, '监听命中即更新滚动时间戳')
})

// —— no-op 路径可达性：秒级时钟定点刷新通道接线 ——
test('时钟通道：1s 定时器与 renderModalLayer 共用 updateRunClocks，块内以 typeof 守卫水化占位', () => {
  const updater = /function updateRunClocks\(root = document\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(updater, '缺少 updateRunClocks（秒级时钟定点刷新的唯一实现）')
  assert.match(updater, /querySelectorAll\('\.run-clock\[data-started\]'\)/, '选择器口径与消息流 typing 行一致')
  assert.doesNotMatch(updater, /innerHTML|replaceWith/, '定点刷新只改 textContent，不重建节点')
  assert.doesNotMatch(block, /function updateRunClocks/, '实现留在 modal-layer 块外：隔离求值时块内 typeof 守卫安全跳过')
  const tickInterval = /setInterval\(\(\) => \{\n  updateRunClocks\(\)\n/.exec(source)?.[0]
  assert.ok(tickInterval, '1s 定时器改调 updateRunClocks()：modal 内占位与消息流同一通道刷新')
  const layerSrc = /function renderModalLayer\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  const hydrations = layerSrc.match(/if \(typeof updateRunClocks === 'function'\) updateRunClocks\(root\)/g) ?? []
  assert.equal(hydrations.length, 3, '三条写入路径（首挂/兜底整写/原位补丁）挂载即水化占位，不等 1s 定时器')
})

// —— DSHBOTS-166：滚动区合成层化（闪烁根因修复）——
// 取证结论（CDP Tracing + 真 GPU）：D-154 的 DOM 侧修复已上线且生效（滚动期 DOM 零写入），
// 但滚动容器 .modal-body 未被合成 → 滚动走主线程 → 每一帧都要重录祖先链。实测 250px 滚动
// 产生 37 次全视口级 Paint（#document 与带 backdrop-filter 的 .modal-backdrop 各一次，单次
// 8.2M 设备像素），空闲对照为 0 次 → 闪烁来自合成层重算（backdrop-filter 表面逐帧重算 +
// 面板内容逐帧重栅格），与 DOM 写入无关（DSHBOTS-98 已有同机制先例：遮罩下底页滚动即全屏闪烁）。
// 修复：.modal-body 提升为合成层（will-change: transform），滚动内容在自有层位移，祖先链
// 不再逐帧重录——实测该变体下 .modal-backdrop 从每帧 Paint 名单中消失。
const cssRule = (selector) => {
  const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(modalCss)
  assert.ok(m, `ui/styles/modal.css 缺少 ${selector} 规则`)
  // 去掉注释再断言：注释里出现过的属性名不算实际声明
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '')
}

test('滚动区合成层：.modal-body 提升为合成层（will-change: transform），滚动不再逐帧重录遮罩祖先', () => {
  const body = cssRule('.modal-body')
  assert.match(body, /will-change:\s*transform/, '.modal-body 必须是合成层：未合成时滚动走主线程，每帧重录带 backdrop-filter 的遮罩祖先')
})

test('视觉口径不变：backdrop-filter 仍留在 .modal-backdrop，滚动区不得自带 filter（防双层滤镜与额外重算）', () => {
  const backdrop = cssRule('.modal-backdrop')
  const body = cssRule('.modal-body')
  assert.match(backdrop, /backdrop-filter:\s*blur\(2px\)/, '遮罩的模糊仍在 .modal-backdrop（视觉口径不变）')
  assert.doesNotMatch(body, /backdrop-filter|filter\s*:/, '.modal-body 不得自带 filter：滚动子树里的滤镜会把每帧重算搬回滚动内容上')
})

test('滚动区合成层不改变滚动串联口径：overscroll-behavior: contain 仍在（DSHBOTS-98 底层滚动锁）', () => {
  assert.match(cssRule('.modal-body'), /overscroll-behavior:\s*contain/, '面板滚到尽头不得把滚动串到底层页面')
})
