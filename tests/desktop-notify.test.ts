import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'

const source = readUiSource()
const block = /\/\/ desktop-notify:start[\s\S]*?\/\/ desktop-notify:end/.exec(source)?.[0]
assert.ok(block, 'ui 源码缺少 desktop-notify 标记块')

// 以注入桩的方式执行 marker 块：块内只依赖 Notification/document/window/localStorage/state/refresh/render。
function loadBlock({ Notification = undefined, hidden = true, focused = false, stored = null } = {}) {
  const calls = { renders: 0, focus: 0, scroll: 0 }
  const store = stored === null ? {} : { 'dshb:desktop-notify': stored }
  const localStorage = {
    getItem: key => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value) },
  }
  const document = {
    hidden,
    hasFocus: () => focused,
    querySelector: () => ({ scrollIntoView: () => { calls.scroll += 1 } }),
  }
  const window = { focus: () => { calls.focus += 1 } }
  const state = { projectId: null, chatMode: 'group', view: 'global' }
  const refresh = () => Promise.resolve()
  const render = () => { calls.renders += 1 }
  const exported = new Function('Notification', 'document', 'window', 'localStorage', 'state', 'refresh', 'render',
    `${block}\nreturn { notifySupported, notifyOn, toggleDesktopNotify, notifyToggleView, notifyNewApprovals, approvalNotifyBody }`)(
    Notification, document, window, localStorage, state, refresh, render)
  return { calls, store, state, ...exported }
}

test('开关分支：开启在用户手势内调 requestPermission 并把结果持久到 localStorage，关闭只写 denied 记忆且不再申请权限', async () => {
  let requested = 0
  class FakeNotification {
    static permission = 'default'
    static async requestPermission() { requested += 1; FakeNotification.permission = 'granted'; return 'granted' }
  }
  const harness = loadBlock({ Notification: FakeNotification })
  assert.equal(harness.notifySupported(), true)
  assert.equal(harness.notifyOn(), false)
  assert.equal(harness.notifyToggleView().label, '未开启')
  await harness.toggleDesktopNotify()
  assert.equal(requested, 1)
  assert.equal(harness.store['dshb:desktop-notify'], 'granted')
  assert.equal(harness.notifyOn(), true)
  assert.equal(harness.notifyToggleView().on, true)
  assert.ok(harness.calls.renders >= 1, '开关后重渲染配置页')
  // 关闭：只写 'denied' 记忆，不再调 requestPermission，浏览器权限保持 granted
  await harness.toggleDesktopNotify()
  assert.equal(requested, 1)
  assert.equal(harness.store['dshb:desktop-notify'], 'denied')
  assert.equal(FakeNotification.permission, 'granted')
  assert.equal(harness.notifyOn(), false)
  assert.equal(harness.notifyToggleView().label, '已关闭')
})

test('不支持 Notification 的环境（file:// 或非 localhost http）：开关置灰、给出说明、触发不报错', () => {
  const harness = loadBlock({ Notification: undefined })
  assert.equal(harness.notifySupported(), false)
  assert.equal(harness.notifyOn(), false)
  const view = harness.notifyToggleView()
  assert.equal(view.disabled, true)
  assert.equal(view.label, '不可用')
  assert.match(view.hint, /HTTPS 或 localhost/)
  assert.doesNotThrow(() => harness.notifyNewApprovals([{ id: 'apr_1', status: 'pending', project_id: 'prj_1' }]))
})

test('pending 增量触发：标题/tag/正文正确，onclick 聚焦窗口并跳转滚动到审批卡后关闭，同审批只弹一次', async () => {
  const instances = []
  class FakeNotification {
    static permission = 'granted'
    static async requestPermission() { return 'granted' }
    declare title: string
    declare options: { tag: string; body: string }
    declare closed: boolean
    declare onclick: (() => void) | null
    constructor(title, options) { this.title = title; this.options = options; this.closed = false; this.onclick = null; instances.push(this) }
    close() { this.closed = true }
  }
  const harness = loadBlock({ Notification: FakeNotification, hidden: true, focused: false, stored: 'granted' })
  const list = [
    { id: 'apr_0', status: 'allowed', project_id: 'prj_1', botName: 'Old', tool_name: 'Bash' },
    { id: 'apr_1', status: 'pending', project_id: 'prj_1', botName: 'Alpha', tool_name: 'Bash', display_reason: '运行构建脚本' },
  ]
  harness.notifyNewApprovals(list)
  assert.equal(instances.length, 1, '非 pending 不弹')
  assert.equal(instances[0].title, 'DSH 审批请求')
  assert.equal(instances[0].options.tag, 'approval-apr_1')
  assert.match(instances[0].options.body, /Alpha 请求使用 Bash：运行构建脚本/)
  // onclick：聚焦窗口 → 跳项目群聊 → 滚动到审批卡 → 关闭通知
  assert.equal(typeof instances[0].onclick, 'function')
  instances[0].onclick()
  assert.equal(harness.calls.focus, 1)
  assert.equal(harness.state.projectId, 'prj_1')
  assert.equal(harness.state.chatMode, 'group')
  assert.equal(harness.state.view, 'chat')
  assert.equal(instances[0].closed, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(harness.calls.scroll, 1, 'refresh 后滚动到审批卡')
  // 同一列表再来一轮：不重复弹（tag 之外再有会话级去重兜底）
  harness.notifyNewApprovals(list)
  assert.equal(instances.length, 1)
})

test('页面可见且聚焦时只记基线不补弹；通知关闭时基线照记；换项目基线重置后未见过的存量 pending 照弹且每条只弹一次', () => {
  const instances = []
  class FakeNotification {
    static permission = 'granted'
    static async requestPermission() { return 'granted' }
    declare title: string
    declare options: { tag: string; body: string }
    constructor(title, options) { this.title = title; this.options = options; instances.push(this) }
    close() {}
  }
  const harness = loadBlock({ Notification: FakeNotification, hidden: false, focused: true, stored: 'granted' })
  const seen = [{ id: 'apr_2', status: 'pending', project_id: 'prj_1', botName: 'Beta', tool_name: 'WebFetch' }]
  harness.notifyNewApprovals(seen)
  assert.equal(instances.length, 0, '在场看到卡片不弹')
  harness.notifyNewApprovals(seen, { hidden: true, focused: false })
  assert.equal(instances.length, 0, '已入基线，隐藏后也不补弹')
  // 通知关闭：新审批照记基线但不弹
  harness.notifyNewApprovals([{ id: 'apr_3', status: 'pending', project_id: 'prj_1', botName: 'Gamma', tool_name: 'Bash' }], { enabled: false, hidden: true, focused: false })
  assert.equal(instances.length, 0)
  // 换项目：基线重置，新项目从未见过的存量 pending 作为新审批弹出
  const other = [{ id: 'apr_9', status: 'pending', project_id: 'prj_2', botName: 'Delta', tool_name: 'Bash' }]
  harness.notifyNewApprovals(other, { hidden: true, focused: false })
  assert.equal(instances.length, 1)
  assert.equal(instances[0].options.tag, 'approval-apr_9')
  harness.notifyNewApprovals(other, { hidden: true, focused: false })
  assert.equal(instances.length, 1, '每条审批只弹一次')
})

test('渲染与轮询接线：全局配置开关、点击 case、poll 隐藏静默分支、审批卡 data-approval-id 锚点', () => {
  assert.match(source, /id="desktop-notify-label">桌面通知/)
  assert.match(source, /data-action="toggle-notify"/)
  assert.match(source, /case 'toggle-notify':[\s\S]{0,80}await toggleDesktopNotify\(\)/)
  // 页面隐藏时静默拉 state 只喂审批增量，不写 state.data、不渲染
  assert.match(source, /if \(document\.hidden\) \{[\s\S]{0,200}api\('state', \{ projectId: state\.projectId \|\| undefined \}, \{ quiet: true \}\)[\s\S]{0,120}notifyNewApprovals\(data\?\.approvals \?\? \[\]\)/)
  // 可见路径：render 后喂增量
  assert.match(source, /render\(\)[\s\S]{0,80}notifyNewApprovals\(state\.data\?\.approvals \?\? \[\]\)/)
  // 审批卡带 id 定位锚点（通知点击滚动定位用）
  assert.match(source, /approval-card" data-approval-status="\$\{attr\(approval\.status\)\}" data-approval-id="\$\{attr\(approval\.id\)\}"/)
})
