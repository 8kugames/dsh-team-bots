// DSHBOTS 顶部跨会话通知跳转的乐观反馈测试：focusQuestionCard / focusApprovalCard
// 从「设 state 后干等 refresh」改为与侧栏 select-project 同构的乐观切换——点击立即
// 收面板出骨架（beginChatPending + render），数据到位清骨架并滚动定位卡片，失败也清骨架。
// 用真实 ui/modules/cards.js 的函数体求值驱动，断言事件时序与上下文切换参数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import './helpers/ui-sources.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const cardsSource = readFileSync(join(root, 'ui', 'modules', 'cards.js'), 'utf8')

const fnSource = (name) => {
  const match = cardsSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
  assert.ok(match, `cards.js 必须包含真实实现 ${name}（禁复制）`)
  return match[0]
}

// 求值真实跳转函数，依赖以桩注入；refresh 返回可控 promise 以断言「先反馈后取数」时序。
function makeFocus() {
  const calls = { begin: [], end: [], renders: 0, chatAtBottom: null }
  let resolveRefresh
  const refreshPromise = new Promise(resolve => { resolveRefresh = resolve })
  const state = {
    projectId: 'prj_old', chatMode: 'group', soloBotId: null, view: 'other',
    replyTo: { id: 'm1' }, chatAtBottom: true,
  }
  const scrolled = []
  const cardFor = {}
  const scope = new Function('state', 'refresh', 'render', 'beginChatPending', 'endChatPending', 'chatContextPending', 'document',
    `${fnSource('focusQuestionCard')}
${fnSource('focusApprovalCard')}
return { focusQuestionCard, focusApprovalCard }`)(
    state,
    () => refreshPromise,
    () => { calls.renders += 1 },
    pending => { calls.begin.push(pending); return 7 },
    seq => { calls.end.push(seq) },
    () => false,
    { querySelector: selector => (cardFor[selector] ??= { selector, scrollIntoView: opts => scrolled.push({ selector, opts }) }) },
  )
  return { scope, state, calls, scrolled, cardFor, settle: resolveRefresh }
}

test('项目提问：点击立即出骨架（render 先于取数完成），上下文切换参数正确', async () => {
  const h = makeFocus()
  h.state.view = 'tasks'
  const question = { id: 'qst_1', project_id: 'prj_zongmen', bot_id: 'bot_director' }

  h.scope.focusQuestionCard(question)
  assert.equal(h.calls.renders, 1, '同步先 render 一次：面板收起 + 骨架即时可见（不等数秒级 state 组装）')
  assert.deepEqual(h.calls.begin, [{ projectId: 'prj_zongmen', chatMode: 'group', soloBotId: null }], '登记乐观切换目标=宗门群聊')
  assert.equal(h.state.projectId, 'prj_zongmen')
  assert.equal(h.state.chatMode, 'group')
  assert.equal(h.state.view, 'chat')
  assert.equal(h.state.replyTo, null, '跨上下文跳转清引用条（与 select-project 同口径）')
  assert.deepEqual(h.calls.end, [], 'refresh 未完成前不得清骨架')

  h.settle()
  await Promise.resolve()
  assert.deepEqual(h.calls.end, [7], '数据到位后清骨架')
  assert.equal(h.scrolled.length, 1, '恰好滚动定位一次')
  assert.match(h.scrolled[0].selector, /^\.question-card\[data-question-id="qst_1"\]$/, '定位到该提问卡')
  assert.equal(h.state.chatAtBottom, false, '定位卡片即离开底部视角，贴底滚动让位')
})

test('单聊提问：跳转目标落到该 bot 的 solo 会话', async () => {
  const h = makeFocus()
  h.scope.focusQuestionCard({ id: 'qst_2', bot_id: 'bot_artist' })
  assert.deepEqual(h.calls.begin, [{ projectId: 'prj_old', chatMode: 'solo', soloBotId: 'bot_artist' }], 'solo 目标带 soloBotId，projectId 维持现值（与 solo-bot 点击同口径）')
  h.settle()
  await Promise.resolve()
  assert.match(h.scrolled[0].selector, /data-question-id="qst_2"/)
})

test('审批跳转同构：即时骨架 + 定位 .approval-card', async () => {
  const h = makeFocus()
  h.scope.focusApprovalCard({ id: 'apr_1', project_id: 'prj_zongmen' })
  assert.equal(h.calls.renders, 1, '审批条目点击同样立即反馈')
  assert.deepEqual(h.calls.begin, [{ projectId: 'prj_zongmen', chatMode: 'group', soloBotId: null }])
  h.settle()
  await Promise.resolve()
  assert.match(h.scrolled[0].selector, /^\.approval-card\[data-approval-id="apr_1"\]$/)
  assert.equal(h.state.chatAtBottom, false)
})

test('取数失败：清骨架并补渲染，不留常驻骨架', async () => {
  const h = makeFocus()
  const failing = new Function('state', 'refresh', 'render', 'beginChatPending', 'endChatPending', 'chatContextPending', 'document',
    `${fnSource('focusQuestionCard')}
return { focusQuestionCard }`)(
    h.state,
    () => Promise.reject(new Error('网络错误')),
    () => { h.calls.renders += 1 },
    pending => { h.calls.begin.push(pending); return 9 },
    seq => { h.calls.end.push(seq) },
    () => false,
    { querySelector: () => null },
  )
  failing.focusQuestionCard({ id: 'qst_3', project_id: 'prj_zongmen' })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(h.calls.end, [9], '失败也清骨架')
  assert.ok(h.calls.renders >= 2, '失败补一次渲染落回可交互视图')
  assert.equal(h.state.chatAtBottom, true, '没定位到卡片不动贴底视角')
})
