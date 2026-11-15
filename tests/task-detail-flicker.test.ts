import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'

const source = readUiSource()
const modalCss = readFileSync(fileURLToPath(new URL('../ui/styles/modal.css', import.meta.url)), 'utf8')

// —— DSHBOTS-255：任务详情卡滚动闪烁 ——
// 取证结论（本地预览服务 + headless Chrome CDP Tracing，真 GPU，与部署逐字节同源的 ui 产物）：
// ① 滚动窗口内 DOM 变更只有 run-clock 文本 1 次/秒（textContent 赋值每次产生 2 条 childList
//    记录）；#app 与 #modal-root 结构零变更——轮询 tick（2.8s）在遮罩开着时不写任何 DOM
//    （render() 的 overlayOpen 闸门 → markAppRenderPending 早退），renderModalLayer 在被动
//    滚动期间不被调用，modalScrollRecent 守卫与闪烁无关；弹窗无整块重建、无入场动画重播。
// ② 滚动 6 个滚轮 tick 的 UpdateLayoutTree = 33 次，把底页动画全部关掉后塌缩到 2 次——
//    滚动期的主线程样式/布局 churn 来自 #app 里看板运行卡的 swim/sheen 等无穷动画：它们在
//    全页 backdrop-filter 的输入侧每帧翻动模糊输入。D-210 冻结了 JS 写入，CSS 动画是底页
//    仅剩的「每帧动的东西」。
// 修复口径（源头，无时间窗）：遮罩在档期间用纯 CSS :has 冻结 #app 动画时间基（状态由样式
// 系统随 .modal-backdrop 挂载/卸载原子推导）；updateRunClocks 加等值守卫，文本没变不写。

// —— ① 冻结规则：遮罩存在即暂停 #app 动画（含伪元素，sheen 扫光挂在 ::after 上）——
test('遮罩冻结：body:has(#modal-root .modal-backdrop) 暂停 #app 全部动画（含 ::before/::after），只动 animation-play-state', () => {
  const freeze = /body:has\(#modal-root \.modal-backdrop\) #app \*,\nbody:has\(#modal-root \.modal-backdrop\) #app \*::before,\nbody:has\(#modal-root \.modal-backdrop\) #app \*::after \{\n([^}]*)\}/.exec(modalCss)
  assert.ok(freeze, 'ui/styles/modal.css 缺少遮罩期 #app 动画冻结规则（body:has(#modal-root .modal-backdrop)）')
  const decls = freeze[1].replace(/\/\*[\s\S]*?\*\//g, '').trim()
  assert.equal(decls, 'animation-play-state: paused;', '冻结规则只声明 animation-play-state: paused——不碰可见性/布局，纯停时间基')
})

test('冻结条件挂在遮罩存在性上（.modal-backdrop 进 :has），不引入 JS 状态或时间窗', () => {
  const selector = /((?:body:has\([^)]*\) #app [^,{]*,?\n?)+)\{/.exec(modalCss)?.[1] ?? ''
  assert.match(selector, /body:has\(#modal-root \.modal-backdrop\)/, '条件必须是「遮罩在档」这个 DOM 事实本身')
  // 反向护栏：冻结不得波及弹窗自身（#modal-root 在 #app 之外，选择器只允许 #app 前缀）
  const freezeBlock = modalCss.slice(modalCss.indexOf('body:has(#modal-root .modal-backdrop)'))
  const ruleText = freezeBlock.slice(0, freezeBlock.indexOf('}'))
  assert.doesNotMatch(ruleText, /(^|\s|\>)#modal-root\s+\*/, '冻结只作用于 #app 子树，弹窗内动画不受影响')
})

test('无 JS 侧并行状态：modal-layer 块不维护动画冻结的类切换（防 CSS/JS 双源漂移）', () => {
  const block = /let lastModalHtml = ''[\s\S]*?\n\}\n\/\/ modal-layer:end/.exec(source)?.[0]
  assert.ok(block, 'ui/app.js 缺少 modal-layer 标记块')
  assert.doesNotMatch(block, /animation-play-state|classList\.(add|remove|toggle)/, '冻结状态只由 CSS :has 从 DOM 推导，modal-layer 不另持一份')
})

// —— ② 时钟等值守卫：文本没变不产生 DOM 写入 ——
test('updateRunClocks：文本未变零写入；变了写一次；遮罩开着只写弹窗层时钟', () => {
  const updaterSrc = /function updateRunClocks\(root = document\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(updaterSrc, 'ui/app.js 缺少 updateRunClocks()')
  const makeUpdater = (duration, overlayOpen) =>
    new Function('duration', 'overlayOpen', `${updaterSrc}\nreturn updateRunClocks`)(duration, overlayOpen)
  const makeEl = ({ text, inModal = true }) => {
    const el = {
      _text: text, writes: 0, dataset: { started: '2026-11-05T00:00:00.000Z' },
      closest: sel => (inModal && sel === '#modal-root' ? { fake: true } : null),
    }
    Object.defineProperty(el, 'textContent', {
      get() { return el._text },
      set(v) { el.writes += 1; el._text = v },
    })
    return el
  }
  const run = ({ overlay, text, next, inModal = true }) => {
    const el = makeEl({ text, inModal })
    makeUpdater(() => next, () => overlay)({ querySelectorAll: () => [el] })
    return el.writes
  }
  assert.equal(run({ overlay: false, text: '5m 3s', next: '5m 3s' }), 0, '等值守卫：textContent 赋值即使值相同也会替换文本节点（childList 变更），没变就不写')
  assert.equal(run({ overlay: false, text: '5m 3s', next: '5m 4s' }), 1, '真实变更写一次')
  assert.equal(run({ overlay: true, text: '5m 3s', next: '5m 4s', inModal: true }), 1, '遮罩开着：弹窗层时钟照常刷新')
  assert.equal(run({ overlay: true, text: '5m 3s', next: '5m 4s', inModal: false }), 0, '遮罩开着：底页时钟跳过（D-210 口径不变）')
})

// —— ③ 轮询 tick 与滚动窗口的写入口径（卡面守门）：遮罩开着 tick 不触详情子树 ——
test('render()：overlayOpen 闸门先于 morph()/renderModalLayer——轮询 tick 走 render() 时不碰任何 DOM', () => {
  const renderSrc = /function render\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(renderSrc, 'ui/app.js 缺少 render()')
  const gateAt = renderSrc.indexOf('if (overlayOpen())')
  const pendingAt = renderSrc.indexOf('markAppRenderPending()')
  const morphAt = renderSrc.indexOf('morph(app,')
  const layerAt = renderSrc.indexOf('renderModalLayer()')
  assert.ok(gateAt >= 0 && pendingAt > gateAt, '遮罩开着先记 pending 早退')
  assert.ok(morphAt > gateAt, 'morph()（#app 原位补丁）在闸门之后：遮罩期间不可达')
  assert.ok(layerAt > morphAt, 'renderModalLayer 仍在 morph 之后（DSHBOTS-90 结构不变）')
})

test('poll()：轮询体本身不直接写 DOM、不直接调弹窗层', () => {
  const pollSrc = /async function poll\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(pollSrc, 'ui/app.js 缺少 poll()')
  assert.doesNotMatch(pollSrc, /renderModalLayer|innerHTML|morph\(/, '轮询 tick 的 DOM 影响只能经 render() 的闸门路径')
})

// —— ④ 一次性收敛路径保持：滚动中延后、停止后单飞补拍仍由 modal-layer 守卫承担（见
// tests/modal-scroll-stability.test.ts ③）；本文件只钉「冻结不改变该路径」——冻结规则不
// 写 modal 子树（只 #app），与补拍互不干扰（上面选择器反向护栏已覆盖）。
