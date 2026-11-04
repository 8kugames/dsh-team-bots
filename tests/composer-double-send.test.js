import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/modules/composer.js', import.meta.url)), 'utf8')

// —— DSHBOTS-165：sendMessage 双发防护 ——
// 根因：sendMessage 无在途守卫，草稿要等出站成功才清空；⌘Enter 按键重复 / 双击发送按钮 /
// 慢网重复点击在出站窗口内再次进入，同一草稿被发出两遍；catch {} 还吞掉出站失败。
// 修复口径：①模块级 sendInFlight 收口全部入口；②草稿乐观清空（拿到入站参数立刻清 + 重画），
// 出站失败恢复草稿与图片（previewUrl 按手上的 base64 重建，不复用已 revoke 的死链）；
// ③出站成功后的取数/重画失败不得恢复草稿——恢复加重发等于再制造双发；④命令类 /clear 的
// confirm 拦截语义原样保留。以下断言把这些锁进源码与行为。

const guardDecl = /^let sendInFlight = false$/m.exec(source)?.[0]
assert.ok(guardDecl, 'ui/modules/composer.js 缺少模块级在途标志 let sendInFlight = false')
const fnSrc = /async function sendMessage\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
assert.ok(fnSrc, 'ui/modules/composer.js 缺少 sendMessage()')

// 求值 sendMessage：源码逐字取自真实文件，以 stub 复刻模块作用域（参照 modal-scroll-stability 惯例）。
const makeHarness = (over = {}) => {
  const state = {
    chatMode: 'group', projectId: 'p1', soloBotId: null, chatAtBottom: false, replyTo: null,
    chatDrafts: {}, pendingImages: {}, ...over.state,
  }
  const key = s => (s.chatMode === 'solo' ? `solo:${s.soloBotId}` : `group:${s.projectId}`)
  const calls = { api: [], render: 0, toasts: [], optimistic: [], revoked: [], warns: [] }
  const deps = {
    state,
    draftKey: key,
    currentDraft: s => s.chatDrafts[key(s)] ?? '',
    pendingImagesFor: (s = state) => s.pendingImages?.[key(s)] ?? [],
    setPendingImages: (list, s = state) => { s.pendingImages = { ...(s.pendingImages ?? {}), [key(s)]: list } },
    clearPendingImages: () => { for (const image of deps.pendingImagesFor()) calls.revoked.push(image.previewUrl); deps.setPendingImages([]) },
    base64BlobUrl: (data, mediaType) => `blob:rebuilt:${mediaType}:${data}`,
    api: async (action, payload) => { calls.api.push({ action, payload }); return over.apiHandler ? over.apiHandler(action, payload, calls.api.length) : { ok: true } },
    loadState: over.loadState ?? (async () => {}),
    toast: (message, kind) => { calls.toasts.push({ message, kind }) },
    t: id => id,
    botById: id => over.botById?.(id) ?? { id, name: 'Bot' },
    activeProject: () => over.activeProject?.() ?? { id: state.projectId },
    applyOptimisticTyping: (result, scope) => calls.optimistic.push({ result, scope }),
    render: () => { calls.render += 1 },
    closeAutocomplete: () => {},
    document: over.document ?? { getElementById: () => null },
    window: over.window ?? { confirm: () => true },
  }
  const warnOrig = console.warn
  console.warn = (...args) => calls.warns.push(args)
  const scope = new Function(
    'state', 'api', 'toast', 't', 'render', 'loadState', 'closeAutocomplete', 'currentDraft', 'pendingImagesFor',
    'setPendingImages', 'clearPendingImages', 'draftKey', 'botById', 'activeProject', 'applyOptimisticTyping',
    'base64BlobUrl', 'document', 'window',
    `${guardDecl}\n${fnSrc}\nreturn { sendMessage, __inFlight: () => sendInFlight }`,
  )(
    state, deps.api, deps.toast, deps.t, deps.render, deps.loadState, deps.closeAutocomplete, deps.currentDraft,
    deps.pendingImagesFor, deps.setPendingImages, deps.clearPendingImages, deps.draftKey, deps.botById,
    deps.activeProject, deps.applyOptimisticTyping, deps.base64BlobUrl, deps.document, deps.window,
  )
  return { state, calls, sendMessage: scope.sendMessage, inFlight: scope.__inFlight, restoreWarn() { console.warn = warnOrig } }
}

// —— ① 源码接线：守卫、复位、乐观清空时序、静默 catch 移除 ——
test('源码接线：in-flight 守卫在函数首行，finally 复位，乐观清空先于出站，catch {} 静默已移除', () => {
  assert.match(fnSrc, /^async function sendMessage\(\) \{\n  if \(sendInFlight\) return/, '守卫必须是函数第一条语句（任何入口都先过闸）')
  assert.match(fnSrc, /\} finally \{\n    sendInFlight = false\n  \}/, '成功失败都要在 finally 里复位，不卡后续发送')
  assert.doesNotMatch(fnSrc, /catch \{\}/, '不得再有吞错的静默 catch {}')
  const clearAt = fnSrc.indexOf("state.chatDrafts[key] = ''")
  const imagesAt = fnSrc.indexOf('clearPendingImages()')
  const sendAt = fnSrc.indexOf('await api(')
  assert.ok(clearAt >= 0 && imagesAt > clearAt && sendAt > imagesAt, '草稿与图片清空必须发生在出站 await 之前（乐观清空）')
  assert.ok(fnSrc.indexOf('state.pendingImages = {') > sendAt, '恢复路径存在且只在出站之后（catch 分支内）')
})

// —— ② 双触发防护：同一草稿只出站一次 ——
test('双触发防护：在途窗口内第二次调用直接返回，复位后新草稿可正常出站', async () => {
  let release
  const h = makeHarness({ apiHandler: () => new Promise(resolve => { release = resolve }) })
  try {
    h.state.chatDrafts['group:p1'] = 'hello'
    const first = h.sendMessage()
    assert.equal(h.calls.api.length, 1, '第一次触发正常出站')
    assert.equal(h.inFlight(), true, '出站期间在途标志为真')
    assert.equal(h.state.chatDrafts['group:p1'], '', '草稿已乐观清空——重复触发无内容可出站')
    // 窗口期内第二击（按键重复/双击）：即便期间已另输入新草稿，也先被在途标志拦下
    h.state.chatDrafts['group:p1'] = 'second try'
    const second = h.sendMessage()
    assert.equal(h.calls.api.length, 1, '在途窗口内第二次触发不得再出站（核心双发场景）')
    release({ ok: true })
    await first
    await second
    assert.equal(h.inFlight(), false, 'finally 已复位')
    assert.equal(h.calls.api[0].payload.body, 'hello', '出站的是第一次的草稿内容')
    // 复位后，窗口期内输入的新草稿可正常发送（不被守卫误伤）
    const third = h.sendMessage()
    assert.equal(h.calls.api.length, 2)
    assert.equal(h.calls.api[1].payload.body, 'second try')
    release({ ok: true })
    await third
  } finally { h.restoreWarn() }
})

// —— ③ 出站失败：草稿与图片恢复，previewUrl 重建，replyTo 恢复，复位可重试 ——
test('出站失败：草稿与待发图片恢复回去供重发，已 revoke 的预览按 base64 重建', async () => {
  const h = makeHarness({ apiHandler: () => { throw new Error('boom') } })
  try {
    h.state.chatDrafts['group:p1'] = 'hello'
    h.state.replyTo = { id: 'm9' }
    h.state.pendingImages['group:p1'] = [{ key: 'img-1', name: 'a.png', mediaType: 'image/png', data: 'QUJD', previewUrl: 'blob:orig-1' }]
    await h.sendMessage()
    assert.equal(h.calls.api.length, 1)
    assert.equal(h.calls.api[0].payload.replyTo, 'm9', '引用回复随消息出站（快照于清空之前）')
    assert.ok(h.calls.revoked.includes('blob:orig-1'), '乐观清空确实 revoke 过旧预览')
    assert.equal(h.state.chatDrafts['group:p1'], 'hello', '失败后草稿恢复')
    assert.equal(h.state.replyTo?.id, 'm9', '失败后引用回复恢复')
    const pending = h.state.pendingImages['group:p1']
    assert.equal(pending.length, 1, '失败后待发图片恢复')
    assert.equal(pending[0].data, 'QUJD')
    assert.equal(pending[0].previewUrl, 'blob:rebuilt:image/png:QUJD', '预览是按 base64 重建的新 blob，不是已 revoke 的死链')
    assert.ok(h.calls.render >= 2, '乐观清空与失败恢复各重画一次')
    assert.equal(h.inFlight(), false, '失败路径同样复位')
    await h.sendMessage()
    assert.equal(h.calls.api.length, 2, '复位后可重试出站')
  } finally { h.restoreWarn() }
})

// —— ④ 失败恢复不覆盖窗口期内的新输入 ——
test('失败恢复：窗口期内新输入的草稿与新附件保留，不丢失', async () => {
  let reject
  const h = makeHarness({ apiHandler: () => new Promise((resolve, rej) => { reject = rej }) })
  try {
    h.state.chatDrafts['group:p1'] = 'hello'
    h.state.pendingImages['group:p1'] = [{ key: 'img-1', name: 'a.png', mediaType: 'image/png', data: 'QUJD', previewUrl: 'blob:orig-1' }]
    const sending = h.sendMessage()
    // 慢网窗口内：用户在已清空的输入框另起新草稿、加新图
    h.state.chatDrafts['group:p1'] = 'typed meanwhile'
    h.state.pendingImages['group:p1'] = [{ key: 'img-new', name: 'n.png', mediaType: 'image/png', data: 'TkVX', previewUrl: 'blob:new-1' }]
    reject(new Error('offline'))
    await sending
    assert.equal(h.state.chatDrafts['group:p1'], 'hello\ntyped meanwhile', '失败消息恢复在前，窗口期新输入保留在后')
    const pending = h.state.pendingImages['group:p1']
    assert.equal(pending.length, 2, '旧图与新图都在')
    assert.equal(pending[0].data, 'QUJD')
    assert.equal(pending[0].previewUrl, 'blob:rebuilt:image/png:QUJD')
    assert.equal(pending[1].data, 'TkVX')
    assert.equal(pending[1].previewUrl, 'blob:new-1', '新附件的预览原样保留')
  } finally { h.restoreWarn() }
})

// —— ⑤ 出站成功后的取数失败：不得恢复草稿（恢复+重发=再制造双发）——
test('出站成功后刷新失败：草稿保持清空，仅记上下文警告', async () => {
  const h = makeHarness({ apiHandler: () => ({ ok: true }), loadState: async () => { throw new Error('refresh down') } })
  try {
    h.state.chatDrafts['group:p1'] = 'hello'
    await h.sendMessage()
    assert.equal(h.calls.api.length, 1)
    assert.equal(h.state.chatDrafts['group:p1'], '', '消息已落库，取数失败不得恢复草稿')
    assert.deepEqual(h.state.pendingImages['group:p1'] ?? [], [])
    assert.equal(h.calls.warns.length, 1, '不再静默吞掉')
    assert.match(String(h.calls.warns[0]?.[1]?.error), /refresh down/)
    assert.equal(h.inFlight(), false)
  } finally { h.restoreWarn() }
})

// —— ⑥ 命令类消息保留 confirm 拦截语义 ——
test('/clear：confirm 取消时不出站、草稿不动、不卡在途；确认后正常发送', async () => {
  let confirmAnswer = false
  const h = makeHarness({ window: { confirm: () => confirmAnswer }, apiHandler: () => ({ ok: true }) })
  try {
    h.state.chatDrafts['group:p1'] = '/clear'
    await h.sendMessage()
    assert.equal(h.calls.api.length, 0, 'confirm 取消不出站')
    assert.equal(h.state.chatDrafts['group:p1'], '/clear', '拦截路径草稿原样不动')
    assert.equal(h.inFlight(), false, '拦截不置在途，后续发送不被卡死')
    confirmAnswer = true
    await h.sendMessage()
    assert.equal(h.calls.api.length, 1)
    assert.equal(h.calls.api[0].payload.body, '/clear')
    assert.equal(h.state.chatDrafts['group:p1'], '', '确认发送后草稿清空')
  } finally { h.restoreWarn() }
})

// —— ⑦ 单聊口径：分支重排后 send_solo_message 出站参数不变 ——
test('单聊：出站走 send_solo_message + botId，乐观清空与成功路径同样生效', async () => {
  const h = makeHarness({
    state: { chatMode: 'solo', soloBotId: 'b1' },
    botById: id => (id === 'b1' ? { id: 'b1', name: 'Ada' } : null),
    apiHandler: () => ({ ok: true }),
  })
  try {
    h.state.chatDrafts['solo:b1'] = 'hi ada'
    await h.sendMessage()
    assert.equal(h.calls.api.length, 1)
    assert.equal(h.calls.api[0].action, 'send_solo_message')
    assert.equal(h.calls.api[0].payload.botId, 'b1')
    assert.equal(h.calls.api[0].payload.body, 'hi ada')
    assert.equal(h.state.chatDrafts['solo:b1'], '', '单聊草稿同样乐观清空')
    assert.deepEqual(h.calls.optimistic.map(item => item.scope), ['solo_chat'], '排队气泡口径不变')
  } finally { h.restoreWarn() }
})
