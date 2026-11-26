import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'
import './helpers/eval-shim.js'

const source = readUiSource()
const block = /\/\/ desktop-notify:start[\s\S]*?\/\/ desktop-notify:end/.exec(source)?.[0]
assert.ok(block, 'ui 源码缺少 desktop-notify 标记块')

// 以注入桩的方式执行 marker 块：块内只依赖 Notification/document/window/localStorage/state/refresh/render。
function loadBlock({ Notification = undefined, hidden = true, focused = false, stored = null } = {}) {
  const calls = { renders: 0, focus: 0, refreshes: 0 }
  const store = stored === null ? {} : { 'dshb:desktop-notify': stored }
  const localStorage = {
    getItem: key => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value) },
  }
  const document = { hidden, hasFocus: () => focused }
  const window = { focus: () => { calls.focus += 1 } }
  const state = { projectId: 'prj_1', chatMode: 'group', soloBotId: null, view: 'chat', modal: null }
  const refresh = () => { calls.refreshes += 1; return Promise.resolve() }
  const render = () => { calls.renders += 1 }
  const exported = new Function('Notification', 'document', 'window', 'localStorage', 'state', 'refresh', 'render',
    `${block}\nreturn { notifySupported, notifyOn, toggleDesktopNotify, notifyToggleView, ensureNotifyPermission, notifyInbox, inboxNotifyEntries, approvalNotifyBody }`)(
    Notification, document, window, localStorage, state, refresh, render)
  return { calls, store, state, ...exported }
}

// 可编程的 Notification 桩：记录实例、可改权限、统计权限申请次数；grantOnRequest 模拟用户在弹窗里点了允许。
function fakeNotification(permission, { grantOnRequest = false } = {}) {
  const made = { requested: 0, instances: [] }
  class FakeNotification {
    static permission = permission
    static async requestPermission() {
      made.requested += 1
      if (grantOnRequest) FakeNotification.permission = 'granted'
      return FakeNotification.permission
    }
    declare title: string
    declare options: { tag: string; body: string }
    declare closed: boolean
    declare onclick: (() => void) | null
    constructor(title: string, options: { tag: string; body: string }) {
      this.title = title; this.options = options; this.closed = false; this.onclick = null; made.instances.push(this)
    }
    close() { this.closed = true }
  }
  return { FakeNotification, made }
}

// 收件箱四类事项的最小数据形状；pending 之外的条目不该进通知。
const inboxData = {
  pendingApprovals: {
    count: 1,
    items: [
      { id: 'apr_0', status: 'allowed', project_id: 'prj_1', botName: 'Old', tool_name: 'Bash' },
      { id: 'apr_1', status: 'pending', project_id: 'prj_1', botName: 'Alpha', tool_name: 'Bash', display_reason: '运行构建脚本' },
    ],
  },
  pendingQuestions: {
    count: 1,
    items: [
      { id: 'q_0', status: 'answered', projectName: '项目甲' },
      { id: 'q_1', status: 'pending', projectName: '项目甲', botName: 'Beta', questions: [{ question: '走方案 A 还是 B？' }] },
      { id: 'q_2', status: 'pending', scope: 'solo', botName: 'Gamma', questions: [{ question: '单聊里的问题' }] },
    ],
  },
  proposals: [
    { id: 'pp_0', status: 'approved', botName: 'Old', title: '旧提案' },
    { id: 'pp_1', status: 'pending', botName: 'Delta', title: '精简交付自检' },
  ],
  pendingOwnerMentions: {
    count: 1,
    items: [{ id: 'msg_1', project_id: 'prj_1', projectName: '项目甲', projectKey: 'JIA', senderName: 'director', snippet: '@owner 任务 A 已完成，请验收。' }],
  },
}

test('默认开启：权限未表态时开关显示待授权，首次手势内申请一次并持久化结果', async () => {
  const { FakeNotification, made } = fakeNotification('default', { grantOnRequest: true })
  const harness = loadBlock({ Notification: FakeNotification })
  assert.equal(harness.notifySupported(), true)
  assert.equal(harness.notifyOn(), false, '浏览器权限没给之前开关事实上是关的')
  let view = harness.notifyToggleView()
  assert.deepEqual([view.on, view.disabled, view.label], [false, false, '待授权'])
  await harness.ensureNotifyPermission()
  assert.equal(made.requested, 1, '首次手势内申请一次')
  assert.equal(harness.store['dshb:desktop-notify'], 'granted')
  assert.equal(harness.notifyOn(), true)
  assert.ok(harness.calls.renders >= 1, '权限落定后重渲染：设置页上的「待授权」要即时变成「已开启」')
  await harness.ensureNotifyPermission()
  assert.equal(made.requested, 1, '每个页面生命周期只申请一次')
  view = harness.notifyToggleView()
  assert.deepEqual([view.on, view.label], [true, '已开启'])
})

test('用户在权限弹窗里没点允许：按关闭记，之后不再申请', async () => {
  const { FakeNotification, made } = fakeNotification('default')
  const harness = loadBlock({ Notification: FakeNotification })
  await harness.ensureNotifyPermission()
  assert.equal(made.requested, 1)
  assert.equal(harness.store['dshb:desktop-notify'], 'denied')
  assert.equal(harness.notifyOn(), false)
  assert.equal(harness.notifyToggleView().label, '已关闭')
  await harness.ensureNotifyPermission()
  assert.equal(made.requested, 1)
})

test('用户在配置页关过（denied 记忆）后不再申请权限，开关显示已关闭且可重新打开', async () => {
  const { FakeNotification, made } = fakeNotification('default')
  const harness = loadBlock({ Notification: FakeNotification, stored: 'denied' })
  await harness.ensureNotifyPermission()
  assert.equal(made.requested, 0, '关过就不再打扰')
  assert.equal(harness.notifyToggleView().label, '已关闭')
  FakeNotification.permission = 'granted'
  await harness.toggleDesktopNotify()
  assert.equal(made.requested, 1, '开关由用户点击手势内主动申请')
  assert.equal(harness.store['dshb:desktop-notify'], 'granted')
  assert.equal(harness.notifyToggleView().on, true)
  assert.ok(harness.calls.renders >= 1, '开关后重渲染配置页')
})

test('已授权的老用户默认开启；关闭只写 denied 记忆，浏览器权限保持 granted', async () => {
  const { FakeNotification, made } = fakeNotification('granted')
  const harness = loadBlock({ Notification: FakeNotification })
  assert.equal(harness.notifyOn(), true, '从未设置过偏好即视为开启')
  await harness.toggleDesktopNotify()
  assert.equal(made.requested, 0)
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
  assert.doesNotThrow(() => harness.notifyInbox(inboxData))
})

test('被浏览器拒绝：开关置灰，不申请权限', async () => {
  const { FakeNotification, made } = fakeNotification('denied')
  const harness = loadBlock({ Notification: FakeNotification })
  const view = harness.notifyToggleView()
  assert.deepEqual([view.on, view.disabled, view.label], [false, true, '已被浏览器拒绝'])
  await harness.ensureNotifyPermission()
  assert.equal(made.requested, 0)
})

test('收件箱增量：四类待办各弹一次，标题/tag/正文正确，onclick 聚焦窗口并打开收件箱', () => {
  const { FakeNotification, made } = fakeNotification('granted')
  const harness = loadBlock({ Notification: FakeNotification, hidden: true, focused: false })
  harness.notifyInbox(inboxData)
  assert.equal(made.instances.length, 0, '首拍只记基线：页面加载时已存在的事项不算新到达')
  harness.notifyInbox(inboxData)
  assert.equal(made.instances.length, 0, '已入基线不重复弹')
  const next = {
    ...inboxData,
    pendingApprovals: { count: 2, items: [...inboxData.pendingApprovals.items, { id: 'apr_2', status: 'pending', botName: 'Solo', tool_name: 'Write', scope: 'solo' }] },
  }
  harness.notifyInbox(next)
  assert.equal(made.instances.length, 1, '只弹新到达的那一条；已决/已答/已通过的条目不进通知')
  const [notification] = made.instances
  assert.equal(notification.title, 'DSH 审批请求')
  assert.equal(notification.options.tag, 'approval-apr_2')
  assert.match(notification.options.body, /Solo 请求使用 Write/)
  assert.equal(typeof notification.onclick, 'function')
  notification.onclick()
  assert.equal(harness.calls.focus, 1)
  assert.equal(harness.state.view, 'inbox')
  assert.equal(harness.calls.renders, 1, '先渲染收件箱')
  assert.equal(harness.calls.refreshes, 1, '再取一轮数据')
  assert.equal(notification.closed, true)
})

test('四类事项的通知标题与正文：带来源定位，超长截断', () => {
  const harness = loadBlock({ Notification: undefined })
  const entries = harness.inboxNotifyEntries({
    pendingApprovals: { items: [{ id: 'a', status: 'pending', botName: 'Alpha', tool_name: 'Bash', display_reason: '运行构建脚本', projectName: 'DSHbots', projectKey: 'DSHBOTS' }] },
    pendingQuestions: { items: [{ id: 'q', status: 'pending', projectName: '项目甲', botName: 'Beta', questions: [{ question: '走方案 A 还是 B？' }] }] },
    proposals: [{ id: 'p', status: 'pending', botName: 'Delta', title: '精简交付自检' }],
    pendingOwnerMentions: { items: [{ id: 'm', projectName: '项目甲', projectKey: 'JIA', senderName: 'director', snippet: `@owner ${'很长'.repeat(100)}` }] },
  })
  assert.deepEqual(entries.map(entry => entry.id), ['approval:a', 'question:q', 'proposal:p', 'owner:m'])
  assert.deepEqual(entries.map(entry => entry.title), ['DSH 审批请求', 'DSH 待回答提问', 'DSH 进化审批', 'DSH 总监 @owner'])
  assert.equal(entries[0].body, 'DSHbots · DSHBOTS｜Alpha 请求使用 Bash：运行构建脚本')
  assert.equal(entries[1].body, '项目甲｜Beta 提问：走方案 A 还是 B？')
  assert.equal(entries[2].body, 'Delta 提交了提案：精简交付自检')
  assert.match(entries[3].body, /^项目甲 · JIA｜director @owner：@owner 很长/)
  assert.equal(entries[3].body.length, 120, '正文截到 120 字符')
})

// 往数据里追加一条待办（收件箱口径：聚合 count 随之 +1）。
const withApproval = (data, approval) => ({ ...data, pendingApprovals: { count: data.pendingApprovals.count + 1, items: [...data.pendingApprovals.items, approval] } })
const withMention = (data, mention) => ({ ...data, pendingOwnerMentions: { count: data.pendingOwnerMentions.count + 1, items: [...data.pendingOwnerMentions.items, mention] } })
const withProposal = (data, proposal) => ({ ...data, proposals: [...data.proposals, proposal] })

test('页面可见但失焦（窗口露在背后）：载入后的第一条新事项就弹，不被吞进基线', () => {
  const { FakeNotification, made } = fakeNotification('granted')
  const harness = loadBlock({ Notification: FakeNotification, hidden: false, focused: false })
  harness.notifyInbox(inboxData)
  assert.equal(made.instances.length, 0, '首拍只记基线')
  harness.notifyInbox(withApproval(inboxData, { id: 'apr_first', status: 'pending', project_id: 'prj_1', botName: 'Alpha', tool_name: 'Bash', display_reason: '第一条' }))
  assert.deepEqual(made.instances.map(note => note.options.tag), ['approval-apr_first'])
})

test('看得到就不弹：页面可见且聚焦时，正看着的事项只记基线；别的项目、任务页、开着弹窗里的新事项照弹', () => {
  const { FakeNotification, made } = fakeNotification('granted')
  const harness = loadBlock({ Notification: FakeNotification, hidden: false, focused: true })
  let data = inboxData
  harness.notifyInbox(data)
  assert.equal(made.instances.length, 0, '首拍只记基线')
  // 本项目群聊页：本项目的新审批与总监 @owner 就在眼前，不弹。
  data = withApproval(data, { id: 'apr_same', status: 'pending', project_id: 'prj_1', botName: 'Alpha', tool_name: 'Bash' })
  data = withMention(data, { id: 'msg_same', project_id: 'prj_1', projectName: '项目甲', senderName: 'director', snippet: '@owner 本项目的提醒' })
  harness.notifyInbox(data)
  assert.equal(made.instances.length, 0, '本项目群聊页上看得到的新事项不弹')
  // 别的项目的新事项在这个页面上看不见：弹。
  data = withApproval(data, { id: 'apr_other', status: 'pending', project_id: 'prj_9', botName: 'Beta', tool_name: 'Bash' })
  data = withMention(data, { id: 'msg_other', project_id: 'prj_9', projectName: '项目乙', senderName: 'director', snippet: '@owner 别的项目的提醒' })
  harness.notifyInbox(data)
  assert.deepEqual(made.instances.map(note => note.options.tag), ['approval-apr_other', 'owner-msg_other'], '别的项目的审批与 @owner 照弹')
  // 收件箱页：什么都看得到。
  harness.state.view = 'inbox'
  data = withApproval(data, { id: 'apr_inbox', status: 'pending', project_id: 'prj_1', botName: 'Alpha', tool_name: 'Bash' })
  harness.notifyInbox(data)
  assert.equal(made.instances.length, 2, '收件箱页上的新事项不弹')
  // 任务页：看不见。
  harness.state.view = 'tasks'
  data = withApproval(data, { id: 'apr_tasks', status: 'pending', project_id: 'prj_1', botName: 'Alpha', tool_name: 'Bash' })
  harness.notifyInbox(data)
  assert.equal(made.instances.length, 3, '任务页上的新事项照弹')
  // 开着弹窗时群聊被遮住：看不见。
  harness.state.view = 'chat'
  harness.state.modal = { type: 'task' }
  data = withApproval(data, { id: 'apr_modal', status: 'pending', project_id: 'prj_1', botName: 'Alpha', tool_name: 'Bash' })
  harness.notifyInbox(data)
  assert.equal(made.instances.length, 4, '弹窗遮住群聊时照弹')
  // 当场看到的那几条已记入基线：之后切走也不补弹。
  harness.state.modal = null
  harness.notifyInbox(data, { hidden: true, focused: false })
  assert.equal(made.instances.length, 4, '看得到时记基线，切走后不补弹')
})

test('单聊与进化页的「看得到」口径：单聊只认与该 bot 会话里的审批/提问，进化页只认提案', () => {
  const { FakeNotification, made } = fakeNotification('granted')
  const harness = loadBlock({ Notification: FakeNotification, hidden: false, focused: true })
  harness.state.chatMode = 'solo'
  harness.state.soloBotId = 'b1'
  let data = inboxData
  harness.notifyInbox(data)
  const tags = () => made.instances.map(note => note.options.tag)
  data = withApproval(data, { id: 'apr_solo_b1', status: 'pending', bot_id: 'b1', botName: 'Alpha', tool_name: 'Bash' })
  harness.notifyInbox(data)
  assert.deepEqual(tags(), [], '与当前 bot 单聊里的审批就在眼前')
  data = withApproval(data, { id: 'apr_solo_b2', status: 'pending', bot_id: 'b2', botName: 'Beta', tool_name: 'Bash' })
  data = withApproval(data, { id: 'apr_prj', status: 'pending', project_id: 'prj_1', bot_id: 'b1', botName: 'Alpha', tool_name: 'Bash' })
  harness.notifyInbox(data)
  assert.deepEqual(tags(), ['approval-apr_solo_b2', 'approval-apr_prj'], '别的 bot 的单聊审批、项目群聊的审批都看不见')
  harness.state.view = 'evolution'
  data = withProposal(data, { id: 'pp_b1', status: 'pending', bot_id: 'b1', title: '该 bot 的提案' })
  data = withProposal(data, { id: 'pp_b2', status: 'pending', bot_id: 'b2', title: '别的 bot 的提案' })
  harness.notifyInbox(data)
  assert.deepEqual(tags(), ['approval-apr_solo_b2', 'approval-apr_prj', 'proposal-pp_b2'], '单聊进化页只列该 bot 的提案')
})

test('通知关闭时基线照记；隐藏后新到达的事项照弹且每条只弹一次', () => {
  const { FakeNotification, made } = fakeNotification('granted')
  const harness = loadBlock({ Notification: FakeNotification, hidden: true, focused: false })
  harness.notifyInbox(inboxData)
  assert.equal(made.instances.length, 0, '首拍只记基线')
  const fresh = withMention(inboxData, { id: 'msg_2', projectName: '项目乙', senderName: 'director', snippet: '@owner 请决策' })
  harness.notifyInbox(fresh, { enabled: false, hidden: true, focused: false })
  assert.equal(made.instances.length, 0, '通知关闭：新事项照记基线但不弹')
  harness.notifyInbox(fresh, { hidden: true, focused: false })
  assert.equal(made.instances.length, 0, '关闭期间已入基线的事项不补弹')
  const again = withMention(fresh, { id: 'msg_3', projectName: '项目乙', senderName: 'director', snippet: '@owner 再决策一次' })
  harness.notifyInbox(again, { hidden: true, focused: false })
  assert.deepEqual(made.instances.map(note => note.options.tag), ['owner-msg_3'])
  harness.notifyInbox(again, { hidden: true, focused: false })
  assert.equal(made.instances.length, 1, '每条事项只弹一次')
})

test('渲染与轮询接线：全局配置开关、点击 case、首次手势申请权限、poll 隐藏静默分支、审批卡 data-approval-id 锚点', () => {
  assert.match(source, /id="desktop-notify-label">\$\{t\('桌面通知'\)\}/)
  assert.match(source, /data-action="toggle-notify"/)
  assert.match(source, /case 'toggle-notify':[\s\S]{0,80}await toggleDesktopNotify\(\)/)
  // 默认开启：首次点击或按键（浏览器要求权限申请由用户手势触发）申请一次。
  assert.match(source, /document\.addEventListener\('click', \(\) => \{ void ensureNotifyPermission\(\) \}, \{ capture: true \}\)/)
  assert.match(source, /document\.addEventListener\('keydown', \(\) => \{ void ensureNotifyPermission\(\) \}, \{ capture: true \}\)/)
  // 页面隐藏时静默拉 state 只喂收件箱增量，不写 state.data、不渲染；四类聚合都在 state 顶层，不必带 soloBotId。
  assert.match(source, /if \(document\.hidden\) \{[\s\S]{0,400}api\('state', \{ projectId: state\.projectId \|\| undefined \}, \{ quiet: true \}\)[\s\S]{0,120}notifyInbox\(data\)/)
  // 可见路径：render 后喂增量；载入即喂第一拍（只记基线），之后到达的第一条新事项才认得出来。
  assert.match(source, /render\(\)[\s\S]{0,80}notifyInbox\(state\.data\)/)
  assert.match(source, /notifyInbox\(state\.data\)\s*if \(state\.view === 'solo-config'\) void loadSoloDetail\(\)/, 'init 载入后立即喂收件箱第一拍')
  // 审批卡带 id 定位锚点（收件箱跳回会话滚动定位用）
  assert.match(source, /approval-card" data-approval-status="\$\{attr\(approval\.status\)\}" data-approval-id="\$\{attr\(approval\.id\)\}"/)
})

test('通知正文带来源群聊与任务定位（DSHBOTS-240）：无来源字段时原文案逐字不变', () => {
  const harness = loadBlock({ Notification: undefined })
  const withSource = harness.approvalNotifyBody({
    botName: 'Alpha', tool_name: 'Bash', display_reason: '运行构建脚本',
    projectName: 'DSHbots', projectKey: 'DSHBOTS', taskIdentifier: 'DSHBOTS-240', taskTitle: '越权审批通知增强',
  })
  assert.match(withSource, /DSHbots · DSHBOTS · DSHBOTS-240 越权审批通知增强｜Alpha 请求使用 Bash：运行构建脚本/, '来源群聊 + 任务 ID/任务名前置')
  // 既有文案口径不回退：无来源字段时仍是「<bot> 请求使用 <tool>：<说明>」。
  assert.equal(
    harness.approvalNotifyBody({ botName: 'Alpha', tool_name: 'Bash', display_reason: '运行构建脚本' }),
    'Alpha 请求使用 Bash：运行构建脚本',
  )
  // 点击通知打开收件箱：事项在那里统一处理或跳到来源。
  assert.match(source, /notification\.onclick = \(\) => \{ window\.focus\(\); openInboxFromNotify\(\); notification\.close\(\) \}/)
})
