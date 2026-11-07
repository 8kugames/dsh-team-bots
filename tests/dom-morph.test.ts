import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'

// 原位补丁（DSHBOTS-227）：轮询不再整页拆节点，于是下拉弹层不被关、输入框不被重建、
// 看板动画不重启。这里守两条纯逻辑：身份键与子节点合并计划、属性/值同步策略。
const source = readUiSource()

const keysBlock = /\/\/ morph-keys:start[\s\S]*?\n\/\/ morph-keys:end/.exec(source)?.[0]
assert.ok(keysBlock, 'ui/modules/dom-morph.js 缺少 morph-keys 标记块')
const attrsBlock = /\/\/ morph-attrs:start[\s\S]*?\n\/\/ morph-attrs:end/.exec(source)?.[0]
assert.ok(attrsBlock, 'ui/modules/dom-morph.js 缺少 morph-attrs 标记块')

const morphLib = new Function(
  `${keysBlock}\n${attrsBlock.replace(/\n\/\/ morph-attrs:end$/, '')}\nreturn { MORPH_KEY_ATTRS, morphKey, morphTag, morphDescriptor, planChildren, MORPH_PRESERVE_CLASSES, MORPH_SOFT_CLASSES, mergeClass, stylePatch, desiredFormValue, shouldDescend }`,
)()
const { morphKey, morphTag, planChildren, mergeClass, stylePatch, desiredFormValue, shouldDescend, MORPH_PRESERVE_CLASSES, MORPH_SOFT_CLASSES } = morphLib

// —— 迷你节点：只给纯逻辑要用的口子（getAttribute/hasAttribute/children/textContent/tagName/nodeType）——
const elem = (tag, { attrs = {}, children = [], text = '' } = {}) => ({
  nodeType: 1,
  tagName: tag,
  attrs,
  children,
  textContent: text,
  getAttribute(name) { return name in attrs ? String(attrs[name]) : null },
  hasAttribute(name) { return name in attrs },
})
const text = value => ({ nodeType: 3, nodeValue: value })
const desc = (node) => ({ node, key: morphKey(node), tag: morphTag(node) })

test('身份键：id 优先，其次模板里的业务 data-*，静态节点无键', () => {
  assert.equal(morphKey(elem('DIV', { attrs: { id: 'composer-input', 'data-task-id': 'T-1' } })), '#composer-input')
  assert.equal(morphKey(elem('DIV', { attrs: { 'data-task-id': 'T-1', 'data-panel': 'task-group:done' } })), 'data-panel=task-group:done', '同节点多键时按 MORPH_KEY_ATTRS 的列表顺序取（面板在前）')
  assert.equal(morphKey(elem('SELECT', { attrs: { 'data-task-filter': 'status' } })), 'data-task-filter=status')
  assert.equal(morphKey(elem('SECTION', { attrs: { 'data-drop-status': 'todo' } })), 'data-drop-status=todo')
  assert.equal(morphKey(elem('SPAN', { attrs: { class: 'faint' } })), null, '纯展示节点不认领身份，走同位置配对')
  assert.equal(morphKey(elem('DIV', { attrs: { 'data-panel': '' } })), null, '空值不算身份')
  assert.equal(morphKey(text('x')), null, '文本节点没有身份键')
})

test('标签口径：元素取 tagName，文本与注释用占位标签（大小写不敏感）', () => {
  assert.equal(morphTag(elem('textarea')), 'TEXTAREA')
  assert.equal(morphTag(text('hi')), '#text')
  assert.equal(morphTag(null), '')
})

test('合并计划：模板结构没变即整树原位复用，零插入零删除', () => {
  const live = [elem('DIV', { attrs: { id: 'a' } }), elem('SPAN'), text('旧文案')]
  const fresh = [elem('DIV', { attrs: { id: 'a' } }), elem('SPAN'), text('新文案')]
  const { entries, removals } = planChildren(live.map(desc), fresh.map(desc))
  assert.equal(entries.length, 3)
  assert.ok(entries.every(entry => entry.live), '三处都认到原有节点')
  assert.equal(removals.length, 0)
})

test('合并计划：按身份键跨位置配对，中间插一条新任务不牵动其余行', () => {
  const live = [elem('DIV', { attrs: { 'data-task-id': 'T-1' } }), elem('DIV', { attrs: { 'data-task-id': 'T-2' } })]
  const fresh = [
    elem('DIV', { attrs: { 'data-task-id': 'T-1' } }),
    elem('DIV', { attrs: { 'data-task-id': 'T-9' } }),
    elem('DIV', { attrs: { 'data-task-id': 'T-2' } }),
  ]
  const { entries, removals } = planChildren(live.map(desc), fresh.map(desc))
  assert.equal(entries[1].live, null, '新行是插入')
  assert.equal(entries[2].live.node, live[1], 'T-2 仍复用原节点（键配对优先于位置）')
  assert.equal(removals.length, 0, '没有节点被删')
})

test('合并计划：重排靠键配对完成，不产生插入与删除', () => {
  const live = [elem('DIV', { attrs: { 'data-task-id': 'T-1' } }), elem('DIV', { attrs: { 'data-task-id': 'T-2' } })]
  const fresh = [live[1], live[0]]
  const { entries, removals } = planChildren(live.map(desc), fresh.map(desc))
  assert.deepEqual(entries.map(entry => entry.live?.node), [live[1], live[0]])
  assert.equal(removals.length, 0, '换序不是换身份：两行都活着')
})

test('合并计划：同位置不同标签是「不是同一身份」，走插入 + 删除', () => {
  const live = [elem('BUTTON', { attrs: { id: 'send' } })]
  const fresh = [elem('DIV', { attrs: { id: 'send' } })]
  const { entries, removals } = planChildren(live.map(desc), fresh.map(desc))
  assert.equal(entries[0].live, null, 'id 相同但标签不同即不同身份')
  assert.equal(removals.length, 1)
})

test('合并计划：live 侧多出来的重复键节点交回删除', () => {
  const live = [elem('DIV', { attrs: { 'data-panel': 'p' } }), elem('DIV', { attrs: { 'data-panel': 'p' } })]
  const fresh = [elem('DIV', { attrs: { 'data-panel': 'p' } })]
  const { entries, removals } = planChildren(live.map(desc), fresh.map(desc))
  assert.ok(entries[0].live, '第一次命中认到原节点')
  assert.equal(removals.length, 1, '多出来的旧节点交回删除')
})

test('合并计划：同键多节点按序一对一配对，轮询不再克隆置换（DSHBOTS-320）', () => {
  // 记忆卡 approve/reject/edit/delete 四个按钮共用 data-memory-id：修复前 morphKey
  // 只认领第一个，其余按钮每拍都被「删除旧 + 克隆插入新」，焦点与动画相位全丢。
  const actions = ['approve-memory', 'reject-memory', 'edit-memory', 'delete-memory']
  const buttons = () => actions.map(action => elem('BUTTON', { attrs: { 'data-action': action, 'data-memory-id': 'M-27' } }))
  const live = buttons()
  const { entries, removals } = planChildren(live.map(desc), buttons().map(desc))
  assert.equal(entries.length, 4)
  assert.deepEqual(entries.map(entry => entry.live?.node), live, '四个按钮全部复用原节点（节点身份保持，非克隆置换）')
  assert.equal(removals.length, 0)
})

test('类名合并：模板为准，运行期加上的拖拽态与临期色不被抹掉', () => {
  assert.equal(mergeClass('task-card done', 'task-card dragging done'), 'task-card done dragging')
  assert.equal(mergeClass('approval-clock', 'approval-clock urgent'), 'approval-clock urgent', '临期色由秒级定时器持有')
  assert.equal(mergeClass('column', 'column drop-target'), 'column drop-target', '拖拽中间态不被模板抹掉')
  assert.equal(mergeClass('column', 'column stale'), 'column', '非白名单的运行期类不残留')
  assert.ok(MORPH_PRESERVE_CLASSES.has('dragging') && MORPH_PRESERVE_CLASSES.has('drop-target'))
  assert.ok(MORPH_SOFT_CLASSES.has('urgent'))
})

test('行内样式：只交回模板声明，不清空 JS 写的 opacity/height', () => {
  const writes = stylePatch([['height', '120px'], ['opacity', '0.4']])
  assert.deepEqual(writes, [['height', '120px'], ['opacity', '0.4']])
  assert.deepEqual(stylePatch(null), [], '模板没写样式即什么都不改')
})

test('表单目标值：textarea 取模板正文，select 取选中项（无 value 属性回落文本）', () => {
  const area = elem('TEXTAREA', { text: '草稿内容' })
  assert.deepEqual(desiredFormValue(area, 'TEXTAREA'), { kind: 'value', value: '草稿内容' })
  const select = elem('SELECT', {
    children: [elem('OPTION', { attrs: { value: 'all' } }), elem('OPTION', { attrs: { value: 'done', selected: '' }, text: '已完成' })],
  })
  assert.deepEqual(desiredFormValue(select, 'SELECT'), { kind: 'value', value: 'done' })
  const labeled = elem('SELECT', { children: [elem('OPTION', { attrs: { selected: '' }, text: '全员响应' })] })
  assert.deepEqual(desiredFormValue(labeled, 'SELECT'), { kind: 'value', value: '全员响应' }, 'option 没写 value 时按文本')
  assert.equal(desiredFormValue(elem('SELECT', { children: [] }), 'SELECT'), null, '空 select 不认领值')
})

test('表单目标值：input 分文本与勾选两套口径，option 认领 selected', () => {
  assert.deepEqual(desiredFormValue(elem('INPUT', { attrs: { value: '搜索任务' } }), 'INPUT'), { kind: 'value', value: '搜索任务' })
  assert.deepEqual(desiredFormValue(elem('INPUT', {}), 'INPUT'), { kind: 'value', value: '' }, '没写 value 即空')
  assert.deepEqual(desiredFormValue(elem('INPUT', { attrs: { type: 'checkbox', checked: '' } }), 'INPUT'), { kind: 'checked', value: true })
  assert.deepEqual(desiredFormValue(elem('INPUT', { attrs: { type: 'radio' } }), 'INPUT'), { kind: 'checked', value: false })
  assert.equal(desiredFormValue(elem('INPUT', { attrs: { type: 'file', value: '' } }), 'INPUT'), null, 'file 输入不认领值：写 value 会抹掉还没提交的选择')
  assert.deepEqual(desiredFormValue(elem('OPTION', { attrs: { selected: '' } }), 'OPTION'), { kind: 'selected', value: true })
  assert.equal(desiredFormValue(elem('SPAN'), 'SPAN'), null, '非控件不管值')
})

test('子树下行闸门：控件不下行，option 下行，聚焦中的 select 一律不动（动弹层就关）', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'PROGRESS', 'METER']) {
    assert.equal(shouldDescend(tag, false), false, `${tag} 的子节点是默认值本身`)
  }
  assert.equal(shouldDescend('SELECT', true), false, '聚焦中的 select 连 option 都不碰')
  assert.equal(shouldDescend('SELECT', false), true, '没聚焦时照常同步 option（改名/换模型要跟上）')
  assert.equal(shouldDescend('OPTION', false), true)
  assert.equal(shouldDescend('DIV', false), true)
})

test('接线：render() 一行调用 morph()，补丁不成立才由 morph 自己整页重建', () => {
  assert.match(source, /morph\(app, renderShell\(\)\)/, 'render() 一行接线：补丁与兜底都在 morph() 里')
  assert.match(source, /function morph\(root, html\) \{\n\s*if \(patch\(root, html\)\) return\n\s*root\.innerHTML = html/, '兜底写在模块内：调用方不会漏')
  assert.match(source, /import \{ morph \} from '\.\/modules\/dom-morph\.js'/, 'dom-morph 已接进 app.js 模块图')
  assert.match(source, /if \(live\.isEqualNode\(fresh\)\) return true/, '整棵子树没变即跳过：轮询最常见路径零 DOM 操作')
  assert.match(source, /if \(hasFocusIn\(item\.node, doc\)\) return false/, '要删掉持焦节点即放弃补丁，回退全量重建')
})
