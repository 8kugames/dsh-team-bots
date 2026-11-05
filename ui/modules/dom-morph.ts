// dom-morph —— #app 稳定节点原位补丁（DSHBOTS-227）
// 轮询每 2.8s 把整页 innerHTML 重建一次，节点全部换新：CSS 动画从头重启（看板进行中的
// 鱼尾/微光每拍抽一下）、composer 的 textarea 被拆走（输入框闪）、聚焦中的 <select> 被拆走
// （原生下拉弹层直接关闭，选不中项）。这里改成「按身份键复用现有节点、只写真正变了的东西」：
// 结构没变即零 DOM 操作，变了的只改属性与文本，节点身份连同动画相位、焦点、滚动位一起活下来。
//
// 复用规则（宁可少动，不可动错）：
// 1) 同一位置的同标签节点算「同一身份」——先按 key（id / data-task-id / data-panel 等）配对，
//    未带 key 的再按位置与标签配对；配不上的新节点插入，配不上的旧节点删除。
// 2) 表单控件只同步值，不重建子树；聚焦中的控件不覆写用户手上的值；聚焦中的 <select>
//    连 option 都不动（动 option 会关掉原生弹层）。
// 3) 运行期由 JS 加的东西不清：data-dirty 属性、拖拽态 class、行内 style 只做叠加合并。
// 4) 需要「搬动或删除正在持有焦点的节点」才能成立的重排，整页放弃补丁回退全量重建
//    ——顺序与正确性优先于保焦点；morph() 自己兜底，调用方只管一行。

// morph-keys:start —— 身份键与子节点合并计划的纯逻辑（tests/dom-morph.test.ts 抽取本块断言）
// 模板里携带业务身份的 data-* 依次优先；没有键的静态节点走「同标签 + 同位置」。
const MORPH_KEY_ATTRS = [
  'data-panel', 'data-task-id', 'data-run-id', 'data-bot-id', 'data-project-id',
  'data-memory-id', 'data-proposal-id', 'data-question-id', 'data-approval-id',
  'data-image-key', 'data-bubble-key', 'data-task-filter', 'data-task-sort',
  'data-drop-status', 'data-tree', 'data-view', 'data-slug', 'data-section',
  'data-picker-for', 'data-revision-id', 'data-item-id', 'data-command-id',
]

function morphKey(el) {
  if (!el || el.nodeType !== 1 || !el.getAttribute) return null
  const id = el.getAttribute('id')
  if (id) return `#${id}`
  for (const name of MORPH_KEY_ATTRS) {
    const value = el.getAttribute(name)
    if (value != null && value !== '') return `${name}=${value}`
  }
  return null
}

function morphTag(el) {
  if (!el) return ''
  if (el.nodeType === 3) return '#text'
  if (el.nodeType === 8) return '#comment'
  return String(el.tagName ?? '').toUpperCase()
}

function morphDescriptor(el) {
  return { node: el, key: morphKey(el), tag: morphTag(el) }
}

// 子节点合并计划：liveItems/freshItems 为同序 descriptor 数组（{node,key,tag}）。
// entries 按 fresh 顺序给出落位方案（live=null 即需要插入新节点）；removals 是没人认领的 live 节点。
function planChildren(liveItems, freshItems) {
  const free = liveItems.map(item => ({ ...item, taken: false }))
  const byKey = new Map()
  for (const item of free) {
    if (!item.key || byKey.has(item.key)) continue
    byKey.set(item.key, item)
  }
  const entries = freshItems.map(fresh => ({ live: null, fresh }))
  // 第一轮：身份键配对（标签不一致即不是同一身份，交给插入 + 删除）
  for (const entry of entries) {
    if (!entry.fresh.key) continue
    const hit = byKey.get(entry.fresh.key)
    if (hit && !hit.taken && hit.tag === entry.fresh.tag) {
      hit.taken = true
      entry.live = hit
    }
  }
  // 第二轮：无键节点按同位置配对（模板结构没变即整树原位复用）
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.live || entry.fresh.key) continue
    const cand = free[index]
    if (cand && !cand.taken && !cand.key && cand.tag === entry.fresh.tag) {
      cand.taken = true
      entry.live = cand
    }
  }
  const removals = free.filter(item => !item.taken)
  return { entries, removals }
}
// morph-keys:end

// morph-attrs:start —— 属性/类/样式/表单值的同步策略纯逻辑（tests/dom-morph.test.ts 抽取本块断言）
// 运行期由 JS 写上的属性与 class 不归模板管：data-dirty 是「表单有未保存修改」的轮询闸门信号，
// dragging/drop-target 是一次拖拽的中间态，删掉就等于打断正在进行的动作。
const MORPH_PRESERVE_ATTRS = new Set(['data-dirty'])
const MORPH_PRESERVE_CLASSES = new Set(['dragging', 'drop-target'])
// 秒级定时器维护的 class（倒计时临期色）：模板算出的时刻可能比上一拍定时器旧，
// 保留旧值等下一拍校正，免得临期色被抹掉再闪回来。
const MORPH_SOFT_CLASSES = new Set(['urgent'])
// 表单控件的值是 IDL 属性不是内容属性：value/checked/selected 走专门的值同步通道，
// 通用属性写入改不动用户手上的当前值，反而会污染默认值。
const MORPH_VALUE_ATTRS = new Set(['value', 'checked', 'selected'])

function mergeClass(freshClass, liveClass) {
  const freshTokens = String(freshClass ?? '').split(/\s+/).filter(Boolean)
  const liveTokens = String(liveClass ?? '').split(/\s+/).filter(Boolean)
  const out = [...freshTokens]
  for (const token of liveTokens) {
    if (freshTokens.includes(token)) continue
    if (MORPH_PRESERVE_CLASSES.has(token) || MORPH_SOFT_CLASSES.has(token)) out.push(token)
  }
  return out.join(' ')
}

// 行内样式只叠加不清空：composer 高度、终态气泡淡出 opacity、进度条宽度都是 JS 写的。
// 入参是 fresh 声明的 [[prop, value]] 列表（模板侧的期望值），原样交回给写入方。
function stylePatch(freshDecls) {
  return Array.from(freshDecls ?? []) as [string, string][]
}

// 目标值：从模板节点算出「这一拍应有的值」；null 表示这个标签不管值。
function desiredFormValue(fresh, tag) {
  if (tag === 'TEXTAREA') return { kind: 'value', value: fresh.textContent ?? '' }
  if (tag === 'SELECT') {
    const options = [...(fresh.children ?? [])].filter(node => node.tagName === 'OPTION')
    const chosen = options.find(node => node.hasAttribute('selected')) ?? options[0] ?? null
    if (!chosen) return null
    const value = chosen.hasAttribute('value') ? chosen.getAttribute('value') : (chosen.textContent ?? '')
    return { kind: 'value', value }
  }
  if (tag === 'INPUT') {
    const type = String(fresh.getAttribute?.('type') ?? 'text').toLowerCase()
    // file 输入的值只能由用户给：写 value（含清空）会抹掉刚选好还没提交的文件。
    if (type === 'file') return null
    if (type === 'checkbox' || type === 'radio') return { kind: 'checked', value: fresh.hasAttribute('checked') }
    return { kind: 'value', value: fresh.getAttribute?.('value') ?? '' }
  }
  if (tag === 'OPTION') return { kind: 'selected', value: fresh.hasAttribute('selected') }
  return null
}

// 是否继续向下补子树：控件的子节点大多是「默认值」本身，动它们等于改用户的输入；
// OPTION 的文本是标签（成员改名要跟着变）所以下得去；聚焦中的 SELECT 一律不下（弹层会关）。
function shouldDescend(tag, focused) {
  if (['INPUT', 'TEXTAREA', 'PROGRESS', 'METER'].includes(tag)) return false
  if (tag === 'SELECT') return !focused
  return true
}
// morph-attrs:end

// 表单控件标签集：值走同步通道，子树按 shouldDescend 裁决。
const MORPH_FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'PROGRESS', 'METER'])

function hasFocusIn(node, doc) {
  const active = doc.activeElement
  if (!active || active === doc.body) return false
  return node === active || Boolean(node.contains?.(active))
}

function freshStyleDecls(node) {
  const style = node.style
  if (!style) return []
  const out = []
  for (let i = 0; i < style.length; i += 1) {
    const prop = style.item(i)
    if (!prop) continue
    out.push([prop, style.getPropertyValue(prop)])
  }
  return out
}

function syncAttributes(live, fresh) {
  for (const attr of Array.from(fresh.attributes) as Attr[]) {
    if (attr.name === 'class' || attr.name === 'style' || MORPH_VALUE_ATTRS.has(attr.name)) continue
    if (live.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value)
  }
  for (const attr of Array.from(live.attributes) as Attr[]) {
    if (MORPH_PRESERVE_ATTRS.has(attr.name) || attr.name === 'class' || attr.name === 'style' || MORPH_VALUE_ATTRS.has(attr.name)) continue
    if (!fresh.hasAttribute(attr.name)) live.removeAttribute(attr.name)
  }
  const merged = mergeClass(fresh.getAttribute('class'), live.getAttribute('class'))
  if ((live.getAttribute('class') ?? '') !== merged) live.setAttribute('class', merged)
  for (const [prop, value] of stylePatch(freshStyleDecls(fresh))) {
    if (live.style.getPropertyValue(prop) !== value) live.style.setProperty(prop, value)
  }
}

function syncFormValue(live, fresh, tag, doc) {
  const desired = desiredFormValue(fresh, tag)
  if (!desired) return
  // 聚焦中的控件：值归用户管，不覆写（否则正在输入的内容与光标会被模板回滚）。
  if (hasFocusIn(live, doc)) return
  if (desired.kind === 'checked') {
    if (live.checked !== desired.value) live.checked = desired.value
    return
  }
  if (desired.kind === 'selected') {
    if (live.selected !== desired.value) live.selected = desired.value
    return
  }
  if (live.value !== desired.value) live.value = desired.value
}

// 返回是否继续向下补子树。
function patchElement(live, fresh, doc) {
  syncAttributes(live, fresh)
  const tag = morphTag(live)
  if (MORPH_FORM_TAGS.has(tag)) syncFormValue(live, fresh, tag, doc)
  return shouldDescend(tag, hasFocusIn(live, doc))
}

function patchNode(live, fresh, doc) {
  if (live.nodeType === 3 || live.nodeType === 8) {
    if (live.nodeValue !== fresh.nodeValue) live.nodeValue = fresh.nodeValue
    return true
  }
  // 整棵子树的标签、属性与文本都相同即跳过：这是轮询最常见的路径，零 DOM 操作。
  if (live.isEqualNode(fresh)) return true
  if (!patchElement(live, fresh, doc)) return true
  return patchChildren(live, fresh, doc)
}

function patchChildren(live, fresh, doc) {
  const liveItems = Array.from(live.childNodes).map(morphDescriptor)
  const freshItems = Array.from(fresh.childNodes).map(morphDescriptor)
  const { entries, removals } = planChildren(liveItems, freshItems)
  for (const item of removals) {
    if (hasFocusIn(item.node, doc)) return false
    live.removeChild(item.node)
  }
  let index = 0
  for (const entry of entries) {
    const desired = entry.live ? entry.live.node : entry.fresh.node.cloneNode(true)
    const current = live.childNodes[index]
    if (current !== desired) {
      if (entry.live && hasFocusIn(entry.live.node, doc)) return false
      live.insertBefore(desired, current ?? null)
    }
    index += 1
  }
  for (const entry of entries) {
    if (!entry.live) continue
    if (!patchNode(entry.live.node, entry.fresh.node, doc)) return false
  }
  return true
}

// patch(root, html)：试着原位补成 html。false = 补不成（换页级结构变化、需要搬动/删除持焦节点），
// 调用方（morph）据此回退整页 innerHTML。
function firstElement(node) {
  for (const child of Array.from(node.childNodes ?? []) as Element[]) {
    if (child.nodeType === 1) return child
  }
  return null
}

function patch(root, html) {
  const doc = root.ownerDocument ?? document
  const stage = doc.createElement('template')
  stage.innerHTML = html
  // 壳层判定：模板首元素是 .shell，换标签或换类名即「换页级」变化（boot 屏 → 工作台等），
  // 这种变化交给全量重建；空白文本节点不算元素，所以逐个找首个元素而不是看 childNodes.length。
  const liveShell = firstElement(root)
  const freshShell = firstElement(stage.content)
  if (!liveShell || !freshShell) return false
  if (liveShell.tagName !== freshShell.tagName) return false
  if ((liveShell.getAttribute('class') ?? '') !== (freshShell.getAttribute('class') ?? '')) return false
  return patchChildren(root, stage.content, doc)
}

// morph(root, html)：保证 root 的内容与 html 一致——能原位补就补（节点身份、动画相位、
// 焦点与滚动位随之保留），补不动才整页重建。调用方一行接线，不必自己兜底。
function morph(root, html) {
  if (patch(root, html)) return
  root.innerHTML = html
}

export {
  MORPH_KEY_ATTRS,
  morphKey,
  morphTag,
  morphDescriptor,
  planChildren,
  MORPH_PRESERVE_ATTRS,
  MORPH_PRESERVE_CLASSES,
  MORPH_SOFT_CLASSES,
  MORPH_VALUE_ATTRS,
  MORPH_FORM_TAGS,
  mergeClass,
  stylePatch,
  desiredFormValue,
  shouldDescend,
  hasFocusIn,
  freshStyleDecls,
  syncAttributes,
  syncFormValue,
  patchElement,
  patchNode,
  patchChildren,
  patch,
  morph,
}
