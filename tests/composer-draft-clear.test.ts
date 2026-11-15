import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/modules/composer.js', import.meta.url)), 'utf8')

// —— DSHBOTS-244：已发消息偶现聊天框草稿残留（乐观清空 DOM 未同步）——
// 根因：乐观清空只写 state.chatDrafts 后靠 render() 同步 DOM。morph 复用持焦 textarea 时
// （⌘Enter 发送焦点必在输入框；Safari 点按钮也不转移焦点），dom-morph 的 syncFormValue 按
// 「聚焦中控件的值归用户管」不覆写 .value——state 已清而 DOM 残留；render 的 rAF 里
// syncComposerBox（app.ts）再把残值回写复活 state 草稿，失败恢复串随之叠加 "body\nbody"。
// 全量重建路径新节点从子文本取值 '' 无残留，故缺陷呈偶发。
// 修复口径：sendMessage 乐观清空段在 render() 后显式清 #composer-input 的 DOM 值，收敛唯一
// 出口；⌘Enter / 发送按钮 / 补全回车三入口同经 sendMessage，一处覆盖。以下断言锁死该行为。

const fnSrc = /async function sendMessage\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
assert.ok(fnSrc, 'ui/modules/composer.js 缺少 sendMessage()')

// 求值 sendMessage：源码逐字取自真实文件，以 stub 复刻模块作用域（composer-double-send 惯例）。
// box 模拟 morph 复用路径下的 #composer-input：render 前后同一节点、.value 残留用户输入
// （render stub 不动 DOM，等价于 syncFormValue 对持焦控件跳过覆写）。
const makeHarness = (over: {
  state?: any
  apiHandler?: (action: any, payload: any, seq: number) => any
  loadState?: () => Promise<void>
  boxValue?: string
} = {}) => {
  const state = {
    chatMode: 'group', projectId: 'p1', soloBotId: null, chatAtBottom: false, replyTo: null,
    chatDrafts: {}, pendingImages: {}, ...over.state,
  }
  const key = s => (s.chatMode === 'solo' ? `solo:${s.soloBotId}` : `group:${s.projectId}`)
  const box = { value: over.boxValue ?? '', focusCalls: 0, focus() { this.focusCalls += 1 } }
  const calls = { api: [], render: 0, optimistic: [] }
  const deps = {
    state,
    draftKey: key,
    currentDraft: s => s.chatDrafts[key(s)] ?? '',
    pendingImagesFor: (s = state) => s.pendingImages?.[key(s)] ?? [],
    setPendingImages: (list, s = state) => { s.pendingImages = { ...(s.pendingImages ?? {}), [key(s)]: list } },
    clearPendingImages: () => deps.setPendingImages([]),
    base64BlobUrl: (data, mediaType) => `blob:rebuilt:${mediaType}:${data}`,
    api: async (action, payload) => { calls.api.push({ action, payload }); return over.apiHandler ? over.apiHandler(action, payload, calls.api.length) : { ok: true } },
    loadState: over.loadState ?? (async () => {}),
    toast: () => {},
    t: id => id,
    botById: id => ({ id, name: 'Bot' }),
    activeProject: () => ({ id: state.projectId }),
    applyOptimisticTyping: (result, scope) => calls.optimistic.push({ result, scope }),
    render: () => { calls.render += 1 },
    closeAutocomplete: () => {},
    document: { getElementById: id => (id === 'composer-input' ? box : null) },
    window: { confirm: () => true },
  }
  const scope = new Function(
    'state', 'api', 'toast', 't', 'render', 'loadState', 'closeAutocomplete', 'currentDraft', 'pendingImagesFor',
    'setPendingImages', 'clearPendingImages', 'draftKey', 'botById', 'activeProject', 'applyOptimisticTyping',
    'base64BlobUrl', 'document', 'window',
    `let sendInFlight = false\n${fnSrc}\nreturn { sendMessage, __inFlight: () => sendInFlight }`,
  )(
    state, deps.api, deps.toast, deps.t, deps.render, deps.loadState, deps.closeAutocomplete, deps.currentDraft,
    deps.pendingImagesFor, deps.setPendingImages, deps.clearPendingImages, deps.draftKey, deps.botById,
    deps.activeProject, deps.applyOptimisticTyping, deps.base64BlobUrl, deps.document, deps.window,
  )
  return { state, calls, box, sendMessage: scope.sendMessage, inFlight: scope.__inFlight }
}

// —— ① 源码接线：乐观清空段在 render 后显式清 DOM 值，收敛唯一出口 ——
test('源码接线：state 清空 + render 之后存在对 #composer-input 的显式 DOM 清空', () => {
  const clearAt = fnSrc.indexOf("state.chatDrafts[key] = ''")
  const renderAt = fnSrc.indexOf('render()')
  const domClearAt = fnSrc.indexOf("box.value = ''")
  assert.ok(clearAt >= 0 && renderAt > clearAt, 'state 清空先于 render（乐观清空时序不变）')
  assert.ok(domClearAt > renderAt, 'render 之后必须显式清 DOM 值——morph 复用持焦节点时 render 不同步 .value')
  assert.ok(fnSrc.indexOf('await api(') > domClearAt, 'DOM 清空发生在出站 await 之前的同一同步段')
})

// —— ② DOM 级断言：出站成功 + 节点复用（持焦）场景，DOM 值与 state 同步为空 ——
test('出站成功且 render 复用 textarea 节点：#composer-input.value 被显式清空，不残留', async () => {
  const h = makeHarness({ boxValue: 'hello' })
  h.state.chatDrafts['group:p1'] = 'hello'
  await h.sendMessage()
  assert.equal(h.calls.api.length, 1)
  assert.equal(h.box.value, '', 'DOM 值必须为空（修复前 morph 复用持焦节点时残留 "hello"）')
  assert.equal(h.state.chatDrafts['group:p1'], '', 'state 草稿为空')
  assert.ok(h.box.focusCalls >= 1, '成功路径仍回焦输入框')
})

// —— ③ render 后 rAF 的 syncComposerBox 回写不再复活草稿 ——
test('render 后 rAF 回写（syncComposerBox 语义）不复活已清空的草稿', async () => {
  const h = makeHarness({ boxValue: 'hello' })
  h.state.chatDrafts['group:p1'] = 'hello'
  const sending = h.sendMessage()
  // 模拟 app.ts render 的 rAF：把 DOM 当前值回写 state（DOM→state）。修复前此处写回 'hello'。
  h.state.chatDrafts['group:p1'] = h.box.value
  await sending
  assert.equal(h.box.value, '', 'DOM 已清')
  assert.equal(h.state.chatDrafts['group:p1'], '', '回写无害：DOM 值已清空，state 不被复活（修复前为 "hello"）')
})

// —— ④ 出站失败：残值不被误当窗口期新输入叠加，真输入仍保留在其后 ——
test('出站失败：窗口期仅 rAF 回写残值时恢复串不叠加；真输入保留在后', async () => {
  // 场景 a：窗口期用户无新输入，只有 render 的 rAF 把 DOM 残值回写 state（DOM→state）。
  // 修复前残值 'hello' 被误当 typed，恢复串叠加成 "hello\nhello"。
  {
    let reject
    const h = makeHarness({ boxValue: 'hello', apiHandler: () => new Promise((_, rej) => { reject = rej }) })
    h.state.chatDrafts['group:p1'] = 'hello'
    const sending = h.sendMessage()
    h.state.chatDrafts['group:p1'] = h.box.value
    reject(new Error('offline'))
    await sending
    assert.equal(h.state.chatDrafts['group:p1'], 'hello', '无新输入时恢复串恰为失败消息本体，不得叠加 DOM 残值（修复前为 "hello\\nhello"）')
    assert.equal(h.inFlight(), false, '失败路径复位')
  }
  // 场景 b：窗口期先有 rAF 回写、用户再真输入新草稿——新输入保留在恢复串之后。
  {
    let reject
    const h = makeHarness({ boxValue: 'hello', apiHandler: () => new Promise((_, rej) => { reject = rej }) })
    h.state.chatDrafts['group:p1'] = 'hello'
    const sending = h.sendMessage()
    h.state.chatDrafts['group:p1'] = h.box.value
    h.box.value = 'typed meanwhile'
    h.state.chatDrafts['group:p1'] = h.box.value
    reject(new Error('offline'))
    await sending
    assert.equal(h.state.chatDrafts['group:p1'], 'hello\ntyped meanwhile', '窗口期新输入不被恢复串覆盖，排在失败消息之后')
  }
})
