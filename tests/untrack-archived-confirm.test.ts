// DSHBOTS-192 交互行为锁：已归档项目「移除追踪」两步确认弹窗的完整链路。
// 根因复盘：step1→step2 / step2→step1 翻页 case 直改 state.modal 后曾误调 render()，
// 而 app.js 的 D-98 遮罩闸门在弹窗打开时 early-return（只记 pending，永不触碰 #modal-root），
// 弹窗层只认 renderModalLayer() 直调（modal-layer.js 的解耦契约，同文件 edit-scopes 先例）——
// 结果点「继续 / 上一步」零响应。本文件从 ui/modules/events-click.js、events-submit.js 提取
// 真实监听器，从 modal-layer.js / modal-forms.js 提取真实 modalShell/modalRemoveTracking，
// 用最小 DOM shim 驱动真实 click/submit 链路并锁定接线，锚点全部语义化（非复制实现）。
// 桩语义镜像线上契约：render 桩=只计数不碰弹窗层（遮罩闸门），renderModalLayer 桩=经真实
// modalRemoveTracking 重算 #modal-root 内容——修复前本套件前两例必须红（红验证锚）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import './helpers/eval-shim.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clickSource = readFileSync(join(root, 'ui', 'modules', 'events-click.js'), 'utf8')
const submitSource = readFileSync(join(root, 'ui', 'modules', 'events-submit.js'), 'utf8')
const layerSource = readFileSync(join(root, 'ui', 'modules', 'modal-layer.js'), 'utf8')
const formsSource = readFileSync(join(root, 'ui', 'modules', 'modal-forms.js'), 'utf8')
const settingsSource = readFileSync(join(root, 'ui', 'modules', 'settings.js'), 'utf8')
const serverApiSource = readFileSync(join(root, 'src', 'api.js'), 'utf8')

// ---------- 最小 DOM shim（沿用 question-card-interaction.test.js 的形态） ----------
class FakeEl {
  declare tagName: string
  declare attrs: Record<string, any>
  declare children: FakeEl[]
  declare parent: FakeEl | null
  declare value: string
  declare checked: boolean
  declare disabled: boolean
  declare _classes: Set<string>
  declare dataset: Record<string, string>
  constructor(tag, attrs: Record<string, any> = {}) {
    this.tagName = tag.toUpperCase()
    this.attrs = { ...attrs }
    this.children = []
    this.parent = null
    this.value = 'value' in attrs ? attrs.value : ''
    this.checked = false
    this.disabled = false
    this._classes = new Set(String(attrs.class ?? '').split(/\s+/).filter(Boolean))
    this.dataset = {}
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) {
        const key = k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())
        this.dataset[key] = String(v)
      }
    }
  }
  get classList() {
    const el = this
    return {
      contains: (c) => el._classes.has(c),
      add: (...cs) => cs.forEach((c) => el._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
    }
  }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return this.attrs[name] ?? null }
  append(child) { child.parent = this; this.children.push(child); return this }
  matches(sel) {
    return sel.split(/(?=[.\[])/).every((part) => {
      if (part.startsWith('.')) return this._classes.has(part.slice(1))
      const m = part.match(/^\[([-\w]+)\]$/)
      if (m) {
        const camel = m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())
        return m[1] in this.attrs || camel in this.dataset
      }
      return this.tagName === part.toUpperCase()
    })
  }
  closest(sel) {
    if (sel.includes(' ')) {
      // 两段后代选择器（监听器前导 '.message-bubble img'）：自身匹配末段且祖先匹配前段
      const [anc, last] = sel.split(/\s+/)
      let node: FakeEl = this
      while (node) {
        if (node.matches(last)) {
          let up = node.parent
          while (up) { if (up.matches(anc)) return node; up = up.parent }
        }
        node = node.parent
      }
      return null
    }
    let node: FakeEl = this
    while (node) { if (node.matches(sel)) return node; node = node.parent }
    return null
  }
  querySelectorAll(sel) {
    const out = []
    const walk = (el) => {
      for (const child of el.children) {
        if (child.matches(sel)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  focus() {}
}

const VOID_TAGS = new Set(['input', 'img', 'br', 'i', 'hr'])
function parseHtml(html) {
  const root = new FakeEl('#root')
  const stack = [root]
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
  let m
  while ((m = tagRe.exec(html))) {
    const tag = m[1]
    if (m[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    const attrs = {}
    const attrRe = /([a-zA-Z][\w-]*)="([^"]*)"/g
    let a
    while ((a = attrRe.exec(m[2]))) attrs[a[1]] = a[2]
    const el = new FakeEl(tag, attrs)
    stack[stack.length - 1].append(el)
    if (!m[3] && !VOID_TAGS.has(tag)) stack.push(el)
  }
  return root
}

// ---------- 真实源码求值：modalShell（modal-layer.js）+ modalRemoveTracking（modal-forms.js） ----------
const shellSource = layerSource.match(/^function modalShell\(\{[\s\S]*?^\}/m)[0]
const removeTrackingSource = formsSource.match(/^function modalRemoveTracking\(\) \{[\s\S]*?^\}/m)[0]
const escStub = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

// ---------- 组装可交互场景 ----------
// 桩语义契约（与线上实现一致）：
//   render 桩——D-98 遮罩闸门：弹窗打开期间只记 pending，不触碰 #modal-root（layerHtml 不变）；
//   renderModalLayer 桩——#modal-root 唯一同步通道：经真实 modalRemoveTracking 重算内容。
const noop = () => {}
function makeHarness() {
  const state = {
    modal: null,
    data: { projects: [{ id: 'prj_9', name: '官方重构', status: 'archived' }] },
  }
  const modalFns = new Function('state', 'attr', 'esc', `${shellSource}
${removeTrackingSource}
return { modalShell, modalRemoveTracking }`)(state, escStub, escStub)

  const layer = { html: '', syncCount: 0 }
  const idRegistry = new Map()
  const registerIds = (tree) => {
    idRegistry.clear()
    const walk = (el) => {
      if (el.attrs?.id) idRegistry.set(el.attrs.id, el)
      el.children.forEach(walk)
    }
    tree.children.forEach(walk)
  }
  const syncLayer = () => {
    layer.syncCount += 1
    layer.html = state.modal ? modalFns.modalRemoveTracking() : ''
    const tree = parseHtml(layer.html)
    registerIds(tree)
    return tree
  }
  let renderCount = 0
  let refreshCount = 0
  const apiCalls = []
  const toasts = []
  const closeModal = () => { state.modal = null; layer.html = ''; layer.syncCount += 1; idRegistry.clear() }
  const openModal = (modal) => { state.modal = modal; return syncLayer() }

  const stubs = {
    state,
    t: (k) => k, activeProject: () => null, botById: () => null,
    toast: (msg, kind) => toasts.push({ msg, kind }),
    api: async (action, payload, opts) => { apiCalls.push({ action, payload, opts }) },
    loadState: async () => {},
    refresh: async () => { refreshCount += 1 },
    render: () => { renderCount += 1 },
    renderKeepingChatScroll: noop, handleBoardAction: async () => false,
    renderModalLayer: () => { syncLayer() },
    closeModal, openModal,
    focusApprovalCard: noop, focusQuestionCard: noop, closeAutocomplete: noop,
    ensureComposerImageInput: () => ({ click: noop }), removePendingImage: noop,
    openMessageImage: async () => {}, openInlineImage: noop, closeImageViewer: noop,
    closeDirPicker: noop, openBot: async () => {},
    openSkillDetail: async () => {}, renderDirPicker: async () => {},
    exportUsageCsv: async () => {}, switchUsageWindow: async () => {}, usageMode: () => 'global',
    searchMemories: async () => {}, loadSoloDetail: async () => {},
    beginChatPending: () => 1, endChatPending: noop, reloadTaskModal: async () => {},
    saveTaskFromForm: async () => null,
    questionDraftSelection: noop, questionSelectOption: noop,
  }

  const loadListener = (source, type, extraStubs = {}) => {
    const stripped = source.split('\n').filter((line) => !line.startsWith('import ')).join('\n')
    const listeners = new Map()
    const documentStub = {
      addEventListener: (t, fn) => listeners.set(t, fn),
      getElementById: (id) => idRegistry.get(id) ?? null,
      querySelector: () => null,
      querySelectorAll: () => [],
    }
    const globals = {
      document: documentStub,
      window: { addEventListener: noop, confirm: () => false, open: noop, prompt: () => null },
      navigator: { clipboard: { writeText: async () => {} } },
      localStorage: { getItem: () => null, setItem: noop },
    }
    const names = [...Object.keys(extraStubs), ...Object.keys(globals)]
    new Function(...names, stripped)(...Object.values(extraStubs), ...Object.values(globals))
    return listeners.get(type)
  }

  const clickHandler = loadListener(clickSource, 'click', stubs)
  // events-submit.js 的其余 import：remove-tracking 路径不触达，触达即安全 no-op。
  const submitHandler = loadListener(submitSource, 'submit', {
    ...stubs,
    normalizeTimeBudgetMinutes: noop, openTask: async () => {}, parseFallbackFields: () => ({}),
    startTerminalPoll: noop,
    formPayload: (form) => Object.fromEntries(
      form.querySelectorAll('[name]').map((el) => [el.getAttribute('name'), el.value]),
    ),
  })

  const click = async (el) => { await clickHandler({ target: el, preventDefault: noop }) }
  const submit = async (formEl) => { await submitHandler({ target: formEl, preventDefault: noop }) }

  // 第一步真实 markup 里的「继续」按钮 / 第二步的「上一步」与提交按钮。
  const step1Tree = () => {
    state.modal = { type: 'remove-tracking', projectId: 'prj_9', name: '官方重构', step: 1, purge: false }
    return syncLayer()
  }
  const step2Tree = () => {
    state.modal = { type: 'remove-tracking', projectId: 'prj_9', name: '官方重构', step: 2, purge: false }
    return syncLayer()
  }
  const byAction = (tree, action) => tree.querySelectorAll('[data-action]').find((el) => el.dataset.action === action)

  return {
    state, layer, apiCalls, toasts, modalFns, click, submit, byAction,
    get renderCount() { return renderCount },
    get refreshCount() { return refreshCount },
    step1Tree, step2Tree,
  }
}

test('markup 接线锁：第一步「继续」= remove-tracking-step2，第二步「上一步」= back、执行=表单提交', () => {
  const h = makeHarness()
  const step1 = h.step1Tree()
  const next = h.byAction(step1, 'remove-tracking-step2')
  assert.ok(next, '第一步 footer 必须有 data-action=remove-tracking-step2 按钮')
  assert.equal(next.attrs.type, 'button', '「继续」必须是 type=button（不触发表单提交）')

  const step2 = h.step2Tree()
  const back = h.byAction(step2, 'remove-tracking-back')
  assert.ok(back, '第二步 footer 必须有 data-action=remove-tracking-back 按钮')
  const form = step2.querySelectorAll('form[data-form]').find((el) => el.dataset.form === 'remove-tracking')
  assert.ok(form, '第二步正文必须是 data-form=remove-tracking 表单')
  const submitBtn = step2.querySelectorAll('button').find((el) => el.getAttribute('type') === 'submit')
  assert.ok(submitBtn && submitBtn.attrs.form === 'modal-form', '第二步执行按钮必须 type=submit 关联 modal-form')
  assert.equal(submitBtn.attrs.id, 'remove-tracking-submit', '执行按钮带 id 供 input 门禁点亮')
})

test('红验证锚：点「继续」必须经 renderModalLayer 把弹窗层翻到第二步（DSHBOTS-192 修复本体）', async () => {
  const h = makeHarness()
  const step1 = h.step1Tree()
  const before = h.layer.syncCount
  await h.click(h.byAction(step1, 'remove-tracking-step2'))
  assert.equal(h.state.modal.step, 2, 'state.modal.step 翻到 2')
  assert.ok(h.layer.syncCount > before, '#modal-root 必须被同步（修复前：误调 render()，弹窗层零更新→点继续无响应）')
  assert.match(h.layer.html, /移除追踪 · 确认执行/, '弹窗层显示第二步标题')
  assert.match(h.layer.html, /remove-tracking-name/, '第二步出现项目名确认输入框')
})

test('勾选「同时移除生产目录」后点「继续」：purge 状态带入第二步文案', async () => {
  const h = makeHarness()
  const step1 = h.step1Tree()
  const purgeBox = step1.querySelectorAll('input').find((el) => el.attrs.id === 'remove-tracking-purge')
  assert.ok(purgeBox, '第一步存在 purge 复选框')
  purgeBox.checked = true
  await h.click(h.byAction(step1, 'remove-tracking-step2'))
  assert.equal(h.state.modal.purge, true, 'purge=true 从复选框读入 state.modal')
  assert.match(h.layer.html, /并移除项目生产目录/, '第二步确认文案体现生产目录将被移除')
  const hidden = h.layer.html.match(/name="purge" value="([^"]*)"/)
  assert.equal(hidden?.[1], '1', '第二步表单隐藏域 purge=1')
})

test('第二步点「上一步」：弹窗层回到第一步（同一根因的镜像路径）', async () => {
  const h = makeHarness()
  const step2 = h.step2Tree()
  const before = h.layer.syncCount
  await h.click(h.byAction(step2, 'remove-tracking-back'))
  assert.equal(h.state.modal.step, 1, 'state.modal.step 回到 1')
  assert.ok(h.layer.syncCount > before, '弹窗层被同步（修复前同样被遮罩闸门吞掉）')
  assert.match(h.layer.html, /移除追踪 · 后果确认/, '弹窗层回到第一步标题')
})

test('提交链路锁：第二步表单提交 → remove_project_tracking + 关弹窗 + 刷新 + 成功 toast', async () => {
  const h = makeHarness()
  const step2 = h.step2Tree()
  const form = step2.querySelectorAll('form[data-form]').find((el) => el.dataset.form === 'remove-tracking')
  const setVal = (name, value) => {
    const el = form.querySelectorAll('[name]').find((item) => item.getAttribute('name') === name)
    el.value = value
  }
  setVal('projectId', 'prj_9')
  setVal('confirmName', '官方重构')
  setVal('purge', '1')
  await h.submit(form)
  assert.equal(h.apiCalls.length, 1, '恰好一次 api 调用')
  assert.deepEqual(h.apiCalls[0].action, 'remove_project_tracking')
  assert.deepEqual(h.apiCalls[0].payload, { projectId: 'prj_9', confirmName: '官方重构', purgeWorkdir: true })
  assert.equal(h.state.modal, null, '提交成功后弹窗关闭（state.modal 置空）')
  assert.equal(h.layer.html, '', '#modal-root 已清层')
  assert.ok(h.refreshCount >= 1, '列表经 refresh 重载')
  assert.deepEqual(h.toasts, [{ msg: '已移除追踪，管理数据已清理', kind: 'success' }])
})

test('guard 锁：非 remove-tracking 弹窗下点 step2 按钮不翻页不碰弹窗层', async () => {
  const h = makeHarness()
  const step1 = h.step1Tree()
  h.state.modal = { type: 'task', detail: {} }
  const before = h.layer.syncCount
  await h.click(h.byAction(step1, 'remove-tracking-step2'))
  assert.equal(h.state.modal.step, undefined, 'task 弹窗不被写入 step')
  assert.equal(h.layer.syncCount, before, '弹窗层零同步')
})

test('入口与服务端接线锁：settings 入口按钮 + events-click case 直调 renderModalLayer + src/api.js 端点', async () => {
  // settings.js 项目状态卡的入口按钮（已归档分支）。
  assert.match(settingsSource, /data-action="remove-tracking-open"/, 'settings.js 已归档分支保留移除追踪入口')
  // case 接线：两个翻页 case 的块体内必须直调 renderModalLayer 且不得调裸 render()
  // （D-98 遮罩闸门下 render() 对弹窗层无效——D-192 根因锚；块体=case 起到同缩进下一 case 止）。
  const caseBlock = (name) => {
    const m = clickSource.match(new RegExp(`case '${name}': \\{([\\s\\S]*?)\\n      case `))
    assert.ok(m, `events-click.js 必须存在 case '${name}'`)
    return m[1]
  }
  for (const name of ['remove-tracking-step2', 'remove-tracking-back']) {
    const block = caseBlock(name)
    assert.match(block, /renderModalLayer\(\)/, `case '${name}' 块内直调 renderModalLayer()`)
    assert.doesNotMatch(block, /[^.]\brender\(\)/, `case '${name}' 块内不得调裸 render()（遮罩期对弹窗层无效）`)
  }
  // 入口 case → openModal 打开 step1。
  const h = makeHarness()
  const entry = new FakeEl('button', { 'data-action': 'remove-tracking-open', 'data-project-id': 'prj_9', 'data-project-name': '官方重构' })
  await h.click(entry)
  assert.equal(h.state.modal?.type, 'remove-tracking', '入口点击打开 remove-tracking 弹窗')
  assert.equal(h.state.modal?.step, 1, '入口从第一步开始')
  assert.match(h.layer.html, /移除追踪 · 后果确认/, '弹窗层已渲染第一步')
  // 服务端动作白名单与分发 case（排除 api/服务端拒绝路径）。
  assert.match(serverApiSource, /'remove_project_tracking'/, 'src/api.js 白名单含 remove_project_tracking')
  assert.match(serverApiSource, /case 'remove_project_tracking':/, 'src/api.js 有对应分发 case')
})
