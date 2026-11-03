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
