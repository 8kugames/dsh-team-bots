// DSHBOTS-176 交互测试：ask 提问卡片的选项选择 / 自定义回复 / 提交链路。
// 与 tests/question-ui.test.js（纯函数与 markup）互补：本文件驱动「真实事件监听器」——
// 从 ui/modules/events-click.js 提取 document click 委托、ui/modules/events-misc.js 提取
// document input 监听（均为拆分外迁后的线上实现，非复制），用最小 DOM shim 解析
// ui/modules/cards.js question-card 标记块渲染出的真实 HTML，派发 click/input，
// 断言委托链路（data-action=question-option/question-submit、.question-custom 输入）
// 从事件到草稿、DOM 态、api('question_answer') 载荷与失败回滚的完整行为。
// D-159 第九批外迁后此链路无 DOM 级测试兜底；本文件即为此而设，锚点全部语义化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { readUiSource } from './helpers/ui-sources.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const uiSource = readUiSource()
const utilSource = readFileSync(join(root, 'ui', 'modules', 'util.js'), 'utf8')
const clickSource = readFileSync(join(root, 'ui', 'modules', 'events-click.js'), 'utf8')
const miscSource = readFileSync(join(root, 'ui', 'modules', 'events-misc.js'), 'utf8')

// ---------- 最小 DOM shim：仅覆盖两个真实监听器与卡片 markup 用到的 API ----------
class FakeEl {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase()
    this.attrs = { ...attrs }
    this.children = []
    this.parent = null
    this.value = 'value' in attrs ? attrs.value : ''
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
      toggle: (c, force) => {
        const on = force === undefined ? !el._classes.has(c) : !!force
        if (on) el._classes.add(c)
        else el._classes.delete(c)
        return on
      },
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
      // 两段后代选择器（监听器前导的 '.message-bubble img'）：自身匹配末段且祖先匹配前段
      const [anc, last] = sel.split(/\s+/)
      let node = this
      while (node) {
        if (node.matches(last)) {
          let up = node.parent
          while (up) { if (up.matches(anc)) return node; up = up.parent }
        }
        node = node.parent
      }
      return null
    }
    let node = this
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

// 迷你 HTML 解析：只处理卡片 markup 的简单标签（属性双引号、<i> 等 void 标签无闭合）
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

// ---------- 真实源码求值 ----------
const markerBlock = (name) => {
  const match = uiSource.match(new RegExp(`// ===== ${name}:start[\\s\\S]*?// ===== ${name}:end =====`))
  assert.ok(match, `${name} 标记块必须存在`)
  return match[0]
}
const formatTimeSource = utilSource.match(/export function formatTime\(value\) \{[\s\S]*?\n\}/)[0].replace(/^export /, '')
const formatTime = new Function(`${formatTimeSource}\nreturn formatTime`)()
const iconStub = (name) => `<i data-icon="${name}"></i>`
const escStub = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

// 求值真实模块文件：剥 import 行后整文件求值，document.addEventListener 换成捕获器，
// 监听器依赖以参数注入——question 链路（question-option/question-submit/question-custom）
// 全部落在真实实现上，其余动作为安全桩。
function loadModule(source, stubs) {
  const stripped = source.split('\n').filter((line) => !line.startsWith('import ')).join('\n')
  const listeners = new Map()
  const documentStub = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const globals = {
    document: documentStub,
    window: { addEventListener: noop, confirm: () => false, open: noop, prompt: () => null },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem: noop },
  }
  const names = [...Object.keys(stubs), ...Object.keys(globals)]
  new Function(...names, stripped)(...Object.values(stubs), ...Object.values(globals))
  return listeners
}

const noop = () => {}
const makeState = () => ({
  questionDraft: new Map(),
  questionAnswering: new Set(),
  questionPanelOpen: false,
  data: { questions: [], pendingQuestions: { count: 0, items: [] } },
})

const cardOf = (state) => new Function('state', 'icon', 'esc', 'attr', 'formatTime', `${formatTimeSource}
${markerBlock('question-card')}
return { questionCardMarkup, questionDraftOf, questionDraftSelection, questionSelectOption }`)(state, iconStub, escStub, escStub, formatTime)

// 组装一次可交互场景：真实 markup + 真实 click/input 监听器 + 可编程 api/toast/render 桩。
function makeHarness() {
  const state = makeState()
  const card = cardOf(state)
  const apiCalls = []
  const toasts = []
  let renderCount = 0
  let apiImpl = async () => ({ id: 'qst_1', status: 'answered' })

  const stubs = {
    // question 链路（真实）
    state, questionDraftOf: card.questionDraftOf,
    questionDraftSelection: card.questionDraftSelection,
    questionSelectOption: card.questionSelectOption,
    // 依赖桩（question 路径不触达，触达即安全 no-op）
    t: (k) => k, activeProject: () => null, botById: () => null,
    toast: (msg, kind) => toasts.push({ msg, kind }),
    api: async (action, payload, opts) => { apiCalls.push({ action, payload, opts }); return apiImpl(payload) },
    loadState: async () => {}, refresh: async () => {}, render: () => { renderCount++ },
    renderKeepingChatScroll: noop, handleBoardAction: async () => false,
    focusApprovalCard: noop, focusQuestionCard: noop, closeAutocomplete: noop,
    ensureComposerImageInput: () => ({ click: noop }), removePendingImage: noop,
    openMessageImage: async () => {}, openInlineImage: noop, closeImageViewer: noop,
    closeDirPicker: noop, closeModal: noop, openBot: async () => {}, openModal: noop,
    openSkillDetail: async () => {}, renderDirPicker: async () => {},
    exportUsageCsv: async () => {}, switchUsageWindow: async () => {}, usageMode: () => 'global',
    searchMemories: async () => {}, loadSoloDetail: async () => {},
    beginChatPending: () => 1, endChatPending: noop, reloadTaskModal: async () => {},
    saveTaskFromForm: async () => null,
    applyUiScale: (v) => Number(v) || 1, syncComposerBox: noop, updateAutocomplete: noop,
    UI_SCALE_KEY: 'dshb:ui-scale',
    // events-misc.js 其余 import：question 路径不触达，补齐以满足模块求值
    STATUS: {}, icon: () => '', COMPOSER_AUTO_MAX_PX: 0, addPendingImages: noop,
    applyAutocomplete: noop, composerPanelCap: () => 0, insertTextAtCursor: noop,
    moveAcSelection: noop, parseFileUriList: () => [], resolveImageMediaType: () => null,
    sendMessage: noop, thumbnailFallback: noop, trapModalFocus: noop,
    updateEffortOptions: noop, updateFallbackEffortOptions: noop,
    renderShell: () => '', panelKey: () => 'p', applyPanelToggle: noop, nextChatAtBottom: () => true,
  }
  const evalListener = (source, type, extraStubs = {}) =>
    loadModule(source, { ...stubs, ...extraStubs }).get(type)
  const clickHandler = evalListener(clickSource, 'click')
  const inputHandler = evalListener(miscSource, 'input')

  const now = Date.now()
  const baseQuestion = {
    id: 'qst_1', status: 'pending', botName: 'tester',
    created_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 179_000).toISOString(), remainingMs: 179_000,
    questions: [
      { id: 'q1', question: '选哪个分支？', options: [{ label: 'main' }, { label: 'dev' }] },
      { id: 'q2', question: '需要哪些步骤？', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] },
    ],
  }
  const mount = (question = baseQuestion) => {
    state.data.questions = [question]
    state.data.pendingQuestions = { count: question.status === 'pending' ? 1 : 0, items: question.status === 'pending' ? [question] : [] }
    const tree = parseHtml(card.questionCardMarkup(question))
    return {
      option: (label, itemId = 'q1') => tree.querySelectorAll('.question-option').find((el) => el.dataset.label === label && el.dataset.itemId === itemId),
      custom: (itemId = 'q1') => tree.querySelectorAll('.question-custom').find((el) => el.dataset.itemId === itemId),
      submit: () => tree.querySelectorAll('[data-action]').find((el) => el.dataset.action === 'question-submit'),
    }
  }
  const click = async (el) => { await clickHandler({ target: el, preventDefault: noop }) }
  const type = (el, value) => { el.value = value; inputHandler({ target: el }) }

  return {
    state, card, apiCalls, toasts, baseQuestion, mount, click, type,
    get renderCount() { return renderCount },
    setApi(impl) { apiImpl = impl },
  }
}

test('question-option 委托链路：点击选项写草稿并即时切换 is-selected/aria-pressed', async () => {
  const h = makeHarness()
  const els = h.mount()
  const main = els.option('main')
  assert.ok(main, 'pending 卡渲染出 main 选项按钮（data-label=main）')

  await h.click(main)
  assert.deepEqual([...h.card.questionDraftOf('qst_1').selected.get('q1')], ['main'], '单击写草稿')
  assert.ok(main.classList.contains('is-selected'), '被点按钮进入 is-selected')
  assert.equal(main.getAttribute('aria-pressed'), 'true', 'aria-pressed 同步为 true')

  await h.click(main)
  assert.deepEqual([...h.card.questionDraftOf('qst_1').selected.get('q1')], [], '再点已选单选项=取消')
  assert.ok(!main.classList.contains('is-selected'), '取消后 is-selected 移除')
  assert.equal(main.getAttribute('aria-pressed'), 'false', 'aria-pressed 回 false')
})

test('单选互斥与多选叠加：同组兄弟按钮态随草稿联动', async () => {
  const h = makeHarness()
  const els = h.mount()
  const main = els.option('main')
  const dev = els.option('dev')

  await h.click(main)
  await h.click(dev)
  assert.deepEqual([...h.card.questionDraftOf('qst_1').selected.get('q1')], ['dev'], '单选互斥：改选清空前者')
  assert.ok(!main.classList.contains('is-selected'), '前选项被联动取消')
  assert.equal(main.getAttribute('aria-pressed'), 'false', '前选项 aria-pressed 联动')
  assert.ok(dev.classList.contains('is-selected'), '新选项选中')

  await h.click(els.option('x', 'q2'))
  await h.click(els.option('y', 'q2'))
  const q2 = [...h.card.questionDraftOf('qst_1').selected.get('q2')]
  assert.deepEqual(q2.sort(), ['x', 'y'], '多选叠加')
  await h.click(els.option('x', 'q2'))
  assert.deepEqual([...h.card.questionDraftOf('qst_1').selected.get('q2')], ['y'], '多选再点=取消单项')
})

test('question-custom 输入链路：真实 input 监听器写草稿，重渲染不丢已输入值', async () => {
  const h = makeHarness()
  const els = h.mount()
  const input = els.custom('q1')
  assert.ok(input, 'pending 卡渲染出补充说明输入框（.question-custom）')

  h.type(input, '按现状处理')
  assert.equal(h.card.questionDraftOf('qst_1').custom.q1, '按现状处理', '输入事件写入草稿 custom')

  // 2.8s 轮询重渲染同卡：值从草稿回填（input 的 value 属性来自 draft.custom）
  const html = h.card.questionCardMarkup(h.baseQuestion)
  assert.match(html, /value="按现状处理"/, '重渲染从草稿恢复输入值')
})

test('question-submit 提交链路：草稿+输入框合成宿主载荷，成功后清草稿清占用', async () => {
  const h = makeHarness()
  const els = h.mount()
  await h.click(els.option('main'))
  h.type(els.custom('q1'), '按现状处理')
  await h.click(els.option('y', 'q2'))

  const submit = els.submit()
  assert.ok(submit, 'pending 卡渲染出提交按钮（data-action=question-submit）')
  await h.click(submit)
  await Promise.resolve()

  assert.equal(h.apiCalls.length, 1, '恰好一次 api 调用')
  const { action, payload } = h.apiCalls[0]
  assert.equal(action, 'question_answer', '提交走 question_answer 动作')
  assert.equal(payload.questionId, 'qst_1')
  assert.deepEqual(payload.answers, [
    { id: 'q1', selected: ['main'], custom: '按现状处理' },
    { id: 'q2', selected: ['y'], custom: undefined },
  ], '载荷覆盖全部问题条目：选中项 + 输入框 custom 优先于草稿，缺省项按空选')
  assert.ok(!h.state.questionDraft.has('qst_1'), '成功后清草稿')
  assert.equal(h.state.questionAnswering.size, 0, '提交占用释放')
  assert.deepEqual(h.toasts, [], '成功不弹错误')
})

test('question-submit 失败回滚：恢复 pending 与徽标，保留草稿可重提', async () => {
  const h = makeHarness()
  h.setApi(async () => { throw new Error('网络错误') })
  const els = h.mount()
  await h.click(els.option('main'))
  h.type(els.custom('q1'), '按现状处理')
  await h.click(els.submit())
  await Promise.resolve()

  const question = h.state.data.questions.find((entry) => entry.id === 'qst_1')
  assert.equal(question.status, 'pending', '失败后问题回到 pending')
  assert.equal(h.state.data.pendingQuestions.count, 1, '徽标计数恢复')
  assert.ok(h.state.questionDraft.has('qst_1'), '草稿保留供重提')
  assert.deepEqual([...h.card.questionDraftOf('qst_1').selected.get('q1')], ['main'], '草稿选择未丢')
  assert.equal(h.state.questionAnswering.size, 0, '占用释放，允许再次提交')
  assert.ok(h.toasts.some((entry) => entry.kind === 'error' && entry.msg.includes('回答失败')), '失败 toast 提示')
})

test('守卫：非 pending 提问卡不渲染任何交互件（选项/输入框/提交钮）', () => {
  const h = makeHarness()
  const dead = { ...h.baseQuestion, status: 'expired' }
  const html = h.card.questionCardMarkup(dead)
  assert.ok(!html.includes('question-option'), 'expired 卡无选项按钮')
  assert.ok(!html.includes('question-custom'), 'expired 卡无补充说明输入框')
  assert.ok(!html.includes('question-submit'), 'expired 卡无提交按钮')
  assert.match(html, /已取消/, 'expired 卡出终态 pill')
})

test('守卫：question-option 点击对已失效（非 pending）问题不写草稿不建桶', async () => {
  const h = makeHarness()
  const dead = { ...h.baseQuestion, status: 'expired' }
  h.state.data.questions = [dead] // 无 pending 卡渲染 ⇒ 不存在 questionDraftOf 建的草稿桶
  // 模拟过期前遗留的陈旧 DOM 按钮（或手工构造的伪造按钮）：点击必须无副作用
  const stale = new FakeEl('button', {
    class: 'question-option', 'data-action': 'question-option',
    'data-question-id': 'qst_1', 'data-item-id': 'q1', 'data-label': 'main', 'data-multi': '0',
  })
  const group = new FakeEl('div', { class: 'question-options' })
  group.append(stale)
  await h.click(stale)
  assert.ok(!h.state.questionDraft.has('qst_1'), '草稿桶不得因失效问题的点击而创建')
  assert.ok(!stale.classList.contains('is-selected'), '陈旧按钮不得进入选中态')
  assert.deepEqual(h.apiCalls, [], '不得触发任何 api 调用')
})
