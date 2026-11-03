import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const indexHtml = readFileSync(fileURLToPath(new URL('../ui/index.html', import.meta.url)), 'utf8')

// 抽取 modal-layer 标记块（lastModalHtml + ensureModalRoot + renderModalLayer）
const block = /let lastModalHtml = ''[\s\S]*?\n\}\n\/\/ modal-layer:end/.exec(source)?.[0]
assert.ok(block, 'ui/app.js 缺少 modal-layer 标记块（lastModalHtml … renderModalLayer）')
const fnSrc = block.replace(/\n\/\/ modal-layer:end$/, '')

// —— 迷你 DOM：只实现 modal-layer 块用到的操作子集 ——
// innerHTML 的「解析」不做真解析：测试按字符串在 doc._trees 注册预构建树，setter 命中即挂树。
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

// 弹窗骨架：.modal-backdrop > .modal(class/aria-label) > .modal-head + .modal-body + .modal-foot
const makeModalTree = ({ panelClass = 'modal task', label = '任务详情', bodyHtml = '<p>v1</p>', bodyChildren = [] } = {}) => {
  const backdrop = makeNode({ className: 'modal-backdrop' })
  const panel = makeNode({ className: panelClass, attrs: { 'aria-label': label } })
  const head = makeNode({ className: 'modal-head' })
  const body = makeNode({ className: 'modal-body' })
  body._innerHTML = bodyHtml
  bodyChildren.forEach(c => body.appendChild(c))
  const foot = makeNode({ className: 'modal-foot' })
  backdrop.appendChild(panel)
  panel.append(head, body, foot)
  return { backdrop, panel, head, body, foot }
}

// root 与 createElement 出来的解析台共用 doc._trees 注册表（同一 html 字符串 → 同一预建树）
const makeDoc = (root, trees) => ({ _trees: trees, getElementById: id => (id === 'modal-root' ? root : null), body: { appendChild() {} }, activeElement: null })
const load = (doc, renderModal) =>
  new Function('document', 'renderModal', 'HTMLElement', `${fnSrc}\nreturn { ensureModalRoot, renderModalLayer }`)(
    { ...doc, createElement: () => { const n = makeNode(); n.parse = h => { if (doc._trees[h]) n.children = [doc._trees[h]] }; return n } },
    renderModal,
    FakeHTMLElement,
  )
// root 的 innerHTML 记写入次数（首建走 innerHTML，原位刷新与清空都不应再走）
const withWriteCounter = root => {
  let writes = 0
  const desc = Object.getOwnPropertyDescriptor(root, 'innerHTML')
  Object.defineProperty(root, 'innerHTML', { get: () => root._innerHTML, set(v) { writes += 1; desc.set.call(root, v) } })
  return () => writes
}

test('ensureModalRoot：无则创建并挂到 body 一次，已有则原样返回（稳定容器）', () => {
  const made = []
  let lookup = null
  const doc = { getElementById: () => lookup, createElement: () => { const n = makeNode(); made.push(n); return n }, body: { appendChild: n => { n.parent = doc.body } } }
  const { ensureModalRoot } = load(doc, () => '')
  const a = ensureModalRoot(doc)
  assert.equal(a.id, 'modal-root')
  assert.equal(a.parent, doc.body, '创建后挂到 body')
  lookup = a
  assert.equal(ensureModalRoot(doc), a, '已存在则原样返回，不重建')
  assert.equal(made.filter(n => n.id === 'modal-root').length, 1, '全程只创建一次')
})

test('renderModalLayer：首次整层写入 root，同 html 再渲染零 DOM 操作', () => {
  const tree = makeModalTree()
  const htmlA = 'HTML_A'
  const root = makeNode()
  root.parse = h => { if (h === htmlA) root.children = [tree.backdrop] }
  const writes = withWriteCounter(root)
  let current = htmlA
  const { renderModalLayer } = load(makeDoc(root, { [htmlA]: tree.backdrop }), () => current)
  renderModalLayer()
  assert.equal(writes(), 1, '首次渲染整层写入一次')
  assert.equal(root.firstElementChild, tree.backdrop)
  renderModalLayer()
  assert.equal(writes(), 1, '内容未变时不做任何 DOM 写入（含 body innerHTML）')
})

test('renderModalLayer：同弹窗刷新只换内容，遮罩/面板/滚动体节点原位保留', () => {
  const treeA = makeModalTree({ bodyHtml: '<p>v1</p>' })
  const treeB = makeModalTree({ panelClass: 'modal wide', bodyHtml: '<p>v2</p>' })
  const htmlA = 'HTML_A', htmlB = 'HTML_B'
  const root = makeNode()
  root.parse = h => { root.children = [(h === htmlA ? treeA : treeB).backdrop] }
  const writes = withWriteCounter(root)
  let current = htmlA
  const { renderModalLayer } = load(makeDoc(root, { [htmlA]: treeA.backdrop, [htmlB]: treeB.backdrop }), () => current)
  renderModalLayer()
  const prevPanel = treeA.panel, prevBody = treeA.body
  prevBody.scrollTop = 180
  current = htmlB
  renderModalLayer()
  assert.equal(writes(), 1, '原位刷新不重写 root.innerHTML')
  assert.equal(root.children[0], treeA.backdrop, '遮罩节点不重建')
  assert.equal(treeA.backdrop.children[0], prevPanel, '.modal 容器节点不重建')
  assert.equal(prevPanel.children[1], prevBody, '.modal-body 滚动容器节点不重建')
  assert.equal(prevBody.innerHTML, '<p>v2</p>', '内容区按新数据原位替换')
  assert.equal(prevBody.scrollTop, 180, '弹窗滚动位保留')
  assert.notEqual(prevPanel.children[0], treeA.head, 'head 槽位换成新节点')
  assert.equal(prevPanel.children[0].classList.contains('modal-head'), true, 'head 槽位语义不变')
  assert.equal(prevPanel.className, 'modal wide', '面板尺寸 class 同步（loading small → 详情 wide）')
})

test('renderModalLayer：原位刷新保留 body 内正在编辑的输入焦点', () => {
  const input = makeNode({ id: 'task-title' })
  Object.setPrototypeOf(input, FakeHTMLElement.prototype)
  const treeA = makeModalTree({ bodyChildren: [input] })
  const treeB = makeModalTree({ bodyChildren: [makeNode({ id: 'task-title' })] })
  const htmlA = 'HTML_A', htmlB = 'HTML_B'
  const root = makeNode()
  root.parse = h => { root.children = [(h === htmlA ? treeA : treeB).backdrop] }
  const active = { id: 'task-title' }
  treeA.body.contains = n => n === active
  const doc = makeDoc(root, { [htmlA]: treeA.backdrop, [htmlB]: treeB.backdrop })
  doc.activeElement = active
  let current = htmlA
  const { renderModalLayer } = load(doc, () => current)
  renderModalLayer()
  current = htmlB
  renderModalLayer()
  assert.equal(input.focusCalls, 1, '刷新后按 id 原位重新聚焦输入框')
})

test('renderModalLayer：modal 消失只清空 root（replaceChildren），不重写 innerHTML', () => {
  const tree = makeModalTree()
  const htmlA = 'HTML_A'
  const root = makeNode()
  root.parse = () => { root.children = [tree.backdrop] }
  const writes = withWriteCounter(root)
  let current = htmlA
  const { renderModalLayer } = load(makeDoc(root, { [htmlA]: tree.backdrop }), () => current)
  renderModalLayer()
  assert.equal(root.children.length, 1)
  current = ''
  renderModalLayer()
  assert.equal(root.children.length, 0, 'root 子节点被清空')
  assert.equal(writes(), 1, '关闭走 replaceChildren，不重写 root.innerHTML')
})

test('接线①：index.html 的 #modal-root 在 #app 外、#toast-root 前，render() 不写 modal-root', () => {
  assert.match(indexHtml, /\n  <!--[\s\S]*?-->\n  <div id="modal-root"><\/div>\n  <div id="toast-root"/, 'modal-root 是 #app 与 #toast-root 之间的独立兄弟容器')
  const appOpen = indexHtml.indexOf('<div id="app"')
  const modalRoot = indexHtml.indexOf('id="modal-root"')
  const appClose = indexHtml.indexOf('</div>\n', indexHtml.indexOf('boot-copy'))
  assert.ok(appOpen < modalRoot && modalRoot > appClose, 'modal-root 不在 #app 内部')
  const renderSrc = /function render\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(renderSrc, 'ui/app.js 缺少 render()')
  // 剥掉注释再断言：render() 代码里对 modal-root 零引用（注释里的说明文字不算）
  assert.doesNotMatch(renderSrc.replace(/\/\/[^\n]*/g, ''), /modal-root/, 'render() 全量重建只写 #app，永不触碰 #modal-root')
  assert.match(renderSrc, /app\.innerHTML = renderShell\(\)/)
})

test('接线②：renderModalLayer 独立于 renderShell，弹窗不再嵌入全量模板', () => {
  const shellSrc = /function renderShell\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(shellSrc, 'ui/app.js 缺少 renderShell()')
  assert.doesNotMatch(shellSrc, /renderModal/, 'renderShell 不再输出 modal')
  assert.match(source, /function renderModalLayer\(\) \{\n  const root = ensureModalRoot\(\)\n  const html = renderModal\(\)/)
  assert.match(source, /function openModal\(modal\) \{\n  state\.modal = modal\n  lastFocused = document\.activeElement instanceof HTMLElement \? document\.activeElement : null\n  renderModalLayer\(\)\n  focusModal\(\)\n\}/)
  assert.match(source, /renderModalLayer\(\)\n  requestAnimationFrame\(\(\) => \{/, 'render() 末尾按需同步弹窗层而非重建')
})

test('接线③：closeModal 只经 renderModalLayer 清 modal-root，不走全量 render', () => {
  assert.match(source, /function closeModal\(\) \{\n  if \(!state\.modal\) return\n  state\.modal = null\n  renderModalLayer\(\)\n  restoreFocus\(\)\n\}/)
  const closeSrc = /function closeModal\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.doesNotMatch(closeSrc, /\brender\(\)/, 'closeModal 不触发全量重建')
  assert.doesNotMatch(closeSrc, /app\.innerHTML/)
  assert.match(source, /  if \(!html\) \{\n    root\.replaceChildren\(\)\n    return\n  \}/, '弹窗层清空只 replaceChildren modal-root')
})

// —— DSHBOTS-98：遮罩闸门（行为级）——
// modal-layer 块与 render() 在真实代码里互相调用（render() 顶部问 overlayOpen()，
// 块内 flushAppRender() 调 render()），所以把两者放进同一作用域求值。
const renderSrc = /function render\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
assert.ok(renderSrc, 'ui/app.js 缺少 render()')

// 迷你运行时：只实现 render() 与遮罩闸门用到的操作子集。
// app.innerHTML 写入次数 = 整页重建次数（闪烁的直接来源）。
const makeOverlayHarness = ({ modal = null, viewerHidden = true } = {}) => {
  const app = makeNode()
  const writes = withWriteCounter(app)
  const viewer = makeNode({ hidden: viewerHidden })
  const root = makeNode()
  const state = { data: { version: 1 }, modal, view: 'chat', chatAtBottom: true, rendering: false }
  const doc = {
    getElementById: id => (id === 'modal-root' ? root : id === 'image-viewer' ? viewer : null),
    createElement: () => { const n = makeNode(); n.parse = () => { n.children = [] }; return n },
    body: { appendChild() {} },
    querySelector: () => null,
    activeElement: null,
  }
  const scope = new Function(
    'document', 'renderModal', 'HTMLElement', 'state', 'app', 'renderShell', 'hydrateMessageImageThumbs',
    'captureViewScroll', 'restoreViewScroll', 'syncChromeHeight', 'syncComposerBox', 'syncTerminalPoll',
    'requestAnimationFrame', 'lastRenderedView',
    `${fnSrc}\n${renderSrc}\nreturn { render, overlayOpen, flushAppRender, get pending() { return appRenderPending } }`,
  )(
    doc,
    () => '',
    FakeHTMLElement,
    state,
    app,
    () => `<div class="shell">${state.data.version}</div>`,
    () => {},
    () => null,
    () => {},
    () => {},
    () => {},
    () => {},
    cb => { cb(); return 0 },
    null,
  )
  // 注意：不能用展开（{...scope}）——展开会把 pending getter 求值成静态快照。
  return {
    render: scope.render,
    overlayOpen: scope.overlayOpen,
    flushAppRender: scope.flushAppRender,
    get pending() { return scope.pending },
    app, writes, state, viewer, root,
  }
}

test('遮罩闸门：弹窗开着时 render() 不重建 #app，只记 pending（DSHBOTS-98）', () => {
  const h = makeOverlayHarness({ modal: { type: 'task', title: '任务详情' } })
  h.render()
  assert.equal(h.writes(), 0, '遮罩开着时整页重建被跳过：半透明遮罩下不再透出闪烁')
  assert.equal(h.pending, true, '跳过时记 pending，遮罩关闭后补渲染')
  h.render()
  assert.equal(h.writes(), 0, '连续多次调用同样不重建')
  assert.equal(h.overlayOpen(), true, 'state.modal 有值即视为遮罩打开')
})

test('遮罩闸门：body 级图片查看器同样不重建 #app，关闭后补一次渲染（DSHBOTS-98）', () => {
  const h = makeOverlayHarness({ viewerHidden: false })
  assert.equal(h.overlayOpen(), true, '图片查看器可见即视为遮罩打开（轮询守卫此前只认 state.modal）')
  h.render()
  assert.equal(h.writes(), 0, '查看器开着时整页重建被跳过')
  h.viewer.hidden = true
  h.flushAppRender()
  assert.equal(h.writes(), 1, '查看器关闭后补一次渲染')
  h.flushAppRender()
  assert.equal(h.writes(), 1, 'pending 已清，不重复渲染')
})

test('遮罩闸门：关闭后补的那一次渲染追平遮罩期间取到的新 state（DSHBOTS-98）', () => {
  const h = makeOverlayHarness({ modal: { type: 'task' } })
  h.render()
  assert.equal(h.writes(), 0)
  h.state.data = { version: 2 }   // 遮罩期间轮询照常取数
  h.state.modal = null
  h.flushAppRender()
  assert.equal(h.writes(), 1, '关闭后补一次渲染')
  assert.equal(h.app.innerHTML, '<div class="shell">2</div>', '补的渲染用的是最新 state')
  assert.equal(h.pending, false, 'pending 清零')
})

test('接线④：轮询/刷新不因弹窗早退，遮罩关闭路径都补渲染（DSHBOTS-98）', () => {
  const pollSrc = /async function poll\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(pollSrc, 'ui/app.js 缺少 poll()')
  assert.doesNotMatch(pollSrc, /state\.modal/, '轮询不再因弹窗早退：遮罩期间照常取数，数据不丢')
  assert.match(pollSrc, /await loadState\(state\.projectId, \{ quiet: true \}\)\n    render\(\)/, '取数后仍走 render()（是否重建由 render 内的遮罩闸门决定）')
  const refreshSrc = /async function refresh\([^)]*\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(refreshSrc, 'ui/app.js 缺少 refresh()')
  assert.doesNotMatch(refreshSrc, /state\.modal/, '刷新不再因弹窗跳过渲染')
  assert.match(refreshSrc, /\n    render\(\)/, '刷新照常走 render()')
  const closeViewerSrc = /function closeImageViewer\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(closeViewerSrc, 'ui/app.js 缺少 closeImageViewer()')
  assert.match(closeViewerSrc, /flushAppRender\(\)/, '查看器关闭后补渲染')
  assert.ok(
    closeViewerSrc.indexOf('viewer.hidden = true') < closeViewerSrc.indexOf('flushAppRender()'),
    '先隐藏查看器再补渲染：补渲染时遮罩已关闭，闸门才放行',
  )
  assert.match(source, /if \(!html\) flushAppRender\(\)/, '弹窗层清空时补渲染')
  assert.match(renderSrc, /if \(overlayOpen\(\)\) \{\n    appRenderPending = true\n    return\n  \}/, 'render() 顶部是唯一的重建闸门')
})

// —— DSHBOTS-111：断言③（同类型刷新不重播入场动画）——
// 入场动画重播只有两条路：承载节点被重建（root.innerHTML 整层重写），或节点上的
// 动画 class 被重复加/重写。原位刷新两条路都不存在：遮罩/面板节点实例保持，
// 遮罩 class 零触碰，面板只做同值同步（同值 className 赋值不触发样式重算，动画无从重起）。
test('断言③：同类型原位刷新不重播入场动画——遮罩/面板节点零重建、零动画 class 变更', () => {
  const treeA = makeModalTree({ bodyHtml: '<p>v1</p>' })
  const treeB = makeModalTree({ bodyHtml: '<p>v2</p>' })
  const htmlA = 'HTML_A', htmlB = 'HTML_B'
  const root = makeNode()
  root.parse = h => { root.children = [(h === htmlA ? treeA : treeB).backdrop] }
  const writes = withWriteCounter(root)
  // 模拟「首挂即带入场动画 class」的形态：将来若给遮罩加 modal-in/modal-enter 动画即如此。
  treeA.backdrop.className = 'modal-backdrop modal-enter'
  treeB.backdrop.className = 'modal-backdrop modal-enter'
  // 遮罩 className 写入计数（原位刷新路径不应写它）
  let backdropClassWrites = 0
  {
    const backdrop = treeA.backdrop
    let v = backdrop.className
    Object.defineProperty(backdrop, 'className', { get: () => v, set(nv) { backdropClassWrites += 1; v = nv } })
  }
  // 面板 className 赋值记录（尺寸同步允许，但同类型必须是同值）
  const panelClassSets = []
  {
    const panel = treeA.panel
    let v = panel.className
    Object.defineProperty(panel, 'className', { get: () => v, set(nv) { panelClassSets.push(nv); v = nv } })
  }
  const addCalls = []
  treeA.backdrop.classList.add = (...cs) => { addCalls.push(['backdrop', ...cs]) }
  treeA.panel.classList.add = (...cs) => { addCalls.push(['panel', ...cs]) }
  let current = htmlA
  const { renderModalLayer } = load(makeDoc(root, { [htmlA]: treeA.backdrop, [htmlB]: treeB.backdrop }), () => current)
  renderModalLayer()
  backdropClassWrites = 0
  panelClassSets.length = 0
  current = htmlB
  renderModalLayer()
  assert.equal(writes(), 1, 'root.innerHTML 只在首挂写一次：动画节点不被整层重建')
  assert.equal(root.children[0], treeA.backdrop, '遮罩节点实例保持 → 其上的入场动画无从重播')
  assert.equal(treeA.backdrop.children[0], treeA.panel, '面板节点实例保持')
  assert.equal(backdropClassWrites, 0, '遮罩 className 零重写')
  assert.equal(addCalls.length, 0, '原位刷新路径零 classList.add：不给保留节点重复加动画 class')
  assert.ok(panelClassSets.every(c => c === 'modal task'), '同类型刷新面板只做同值 class 同步（同值赋值不触发动画重起）')
})

// renderModalLayer 原位刷新会重建 .modal-head / .modal-foot（replaceWith 换新节点）并整体
// 替换 .modal-body 的 innerHTML——这三个槽位上的任何 animation 都会随每次数据刷新重播（=
// 闪烁）。所以入场动画若要加，只能挂在被原位保留的 .modal-backdrop / .modal 上（首挂播放
// 一次，刷新不重播）。本断言把这条约束锁进 CSS：重建槽位的规则段不得声明 animation。
test('断言③守门：入场动画只允许挂在原位保留的遮罩/面板上，刷新会重建的槽位禁用 animation', () => {
  const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')
  const rebuiltSlots = ['modal-head', 'modal-foot', 'modal-body', 'modal-close', 'modal-loading']
  for (const sel of rebuiltSlots) {
    const rules = css.match(new RegExp(`\\.${sel}\\b[^{}]*\\{[^}]*\\}`, 'g')) ?? []
    for (const rule of rules) {
      assert.doesNotMatch(
        rule, /animation\b/,
        `.${sel} 规则段不得声明 animation（该节点每次原位刷新被重建，动画会随之重播）：${rule.split('\n')[0]}`,
      )
    }
  }
})
