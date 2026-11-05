// DSHBOTS-193 交互行为锁：已归档 Bot「移除追踪」两步确认弹窗的完整链路（软移除，非物理删除）。
// 语义对齐项目侧（DSHBOTS-192 的 remove-tracking 链）：确认弹窗 + 输入名称门禁 + 继续后执行；
// 差异点：Bot 侧数据全部保留（仅从工作台列表移除追踪），故无 purge 复选框、无目录删除。
// 本文件从 ui/modules/events-click.js 提取真实 click 监听器，从 modal-layer.js / modal-forms.js
// 提取真实 modalShell/modalRemoveBotTracking，用最小 DOM shim 驱动真实链路并锁定接线；
// 服务层部分以真实 TeamService + handleAction 走 remove_bot_tracking 全契约（镜像 tests/archive.test.js）。
// 桩语义镜像线上契约：render 桩 = D-98 遮罩闸门（弹窗期只计数不碰 #modal-root），
// renderModalLayer 桩 = #modal-root 唯一同步通道（经真实 modalRemoveBotTracking 重算内容）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { handleAction } from '../src/api.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clickSource = readFileSync(join(root, 'ui', 'modules', 'events-click.js'), 'utf8')
const layerSource = readFileSync(join(root, 'ui', 'modules', 'modal-layer.js'), 'utf8')
const formsSource = readFileSync(join(root, 'ui', 'modules', 'modal-forms.js'), 'utf8')
const chatSource = readFileSync(join(root, 'ui', 'modules', 'chat.js'), 'utf8')
const serverApiSource = readFileSync(join(root, 'src', 'api.js'), 'utf8')

// ---------- 最小 DOM shim（沿用 question-card-interaction / untrack-archived-confirm 的形态） ----------
class FakeEl {
  declare tagName: string
  declare attrs: Record<string, any>
  declare children: FakeEl[]
  declare parent: FakeEl | null
  declare value: string
  declare checked: boolean
  declare disabled: boolean
  declare dataset: Record<string, string>
  constructor(tag, attrs: Record<string, any> = {}) {
    this.tagName = tag.toUpperCase()
    this.attrs = { ...attrs }
    this.children = []
    this.parent = null
    this.value = 'value' in attrs ? attrs.value : ''
    this.checked = false
    this.disabled = false
    this.dataset = {}
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) {
        const key = k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())
        this.dataset[key] = String(v)
      }
    }
  }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return this.attrs[name] ?? null }
  append(child) { child.parent = this; this.children.push(child); return this }
  matches(sel) {
    return sel.split(/(?=[.\[])/).every((part) => {
      if (part.startsWith('.')) return false
      const m = part.match(/^\[([-\w]+)\]$/)
      if (m) {
        const camel = m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())
        return m[1] in this.attrs || camel in this.dataset
      }
      return this.tagName === part.toUpperCase()
    })
  }
  closest(sel) {
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

// ---------- 真实源码求值：modalShell（modal-layer.js）+ modalRemoveBotTracking（modal-forms.js） ----------
const shellSource = layerSource.match(/^function modalShell\(\{[\s\S]*?^\}/m)[0]
const removeBotTrackingSource = formsSource.match(/^function modalRemoveBotTracking\(\) \{[\s\S]*?^\}/m)?.[0] ?? ''
const escStub = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

// ---------- 组装可交互场景（桩契约与 untrack-archived-confirm.test.js 一致） ----------
const noop = () => {}
function makeHarness({ bot }: { bot?: { id: string; name: string; status: string } } = {}) {
  const state = {
    modal: null,
    soloBotId: bot?.id ?? null,
    view: 'solo-config',
    chatMode: 'solo',
    data: { projects: [], bots: bot ? [bot] : [] },
  }
  const modalFns = new Function('state', 'attr', 'esc', `${shellSource}
${removeBotTrackingSource}
return { modalShell, modalRemoveBotTracking }`)(state, escStub, escStub)

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
    layer.html = state.modal ? modalFns.modalRemoveBotTracking() : ''
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
    t: (k) => k, activeProject: () => null,
    botById: (botId) => bot && bot.id === botId ? bot : null,
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
  const click = async (el) => { await clickHandler({ target: el, preventDefault: noop }) }

  const step1Tree = () => {
    state.modal = { type: 'bot-remove-tracking', botId: 'bot_1', name: '离队成员', step: 1 }
    return syncLayer()
  }
  const step2Tree = () => {
    state.modal = { type: 'bot-remove-tracking', botId: 'bot_1', name: '离队成员', step: 2 }
    return syncLayer()
  }
  const byAction = (tree, action) => tree.querySelectorAll('[data-action]').find((el) => el.dataset.action === action)

  return {
    state, layer, apiCalls, toasts, modalFns, click, byAction, idRegistry,
    get renderCount() { return renderCount },
    get refreshCount() { return refreshCount },
    step1Tree, step2Tree,
  }
}

const archivedBot = { id: 'bot_1', name: '离队成员', status: 'archived' }

test('markup 接线锁：第一步「继续」= bot-remove-tracking-step2；第二步输入框复用门禁 id、执行按钮走 data-action 而非表单', () => {
  const h = makeHarness({ bot: archivedBot })
  const step1 = h.step1Tree()
  const next = h.byAction(step1, 'bot-remove-tracking-step2')
  assert.ok(next, '第一步 footer 必须有 data-action=bot-remove-tracking-step2 按钮')
  assert.equal(next.attrs.type, 'button', '「继续」必须是 type=button')
  assert.match(h.layer.html, /离队成员/, '第一步文案点名 Bot 名称')
  assert.match(h.layer.html, /保留/, '第一步后果清单必须声明数据保留（软移除口径）')

  const step2 = h.step2Tree()
  const back = h.byAction(step2, 'bot-remove-tracking-back')
  assert.ok(back, '第二步 footer 必须有 data-action=bot-remove-tracking-back 按钮')
  const input = step2.querySelectorAll('input').find((el) => el.attrs.id === 'remove-tracking-name')
  assert.ok(input, '第二步必须复用 input id=remove-tracking-name（events-misc 输入门禁据此点亮按钮）')
  const submitBtn = step2.querySelectorAll('button').find((el) => el.attrs.id === 'remove-tracking-submit')
  assert.ok(submitBtn, '第二步执行按钮带 id=remove-tracking-submit 供门禁点亮')
  // 裸 disabled（无值属性）不经 shim 的 attr 解析，直接在原始 HTML 上断言。
  assert.match(h.layer.html, /<button[^>]*id="remove-tracking-submit"[^>]*disabled/, '执行按钮初始禁用，等待名称门禁')
  assert.equal(submitBtn.dataset.action, 'bot-remove-tracking-confirm', '执行按钮走 data-action=bot-remove-tracking-confirm')
  assert.equal(submitBtn.attrs.type, 'button', '执行按钮是 type=button，不经表单提交')
  assert.equal(step2.querySelectorAll('form').length, 0, '第二步不含 form 元素（不与项目侧 remove-tracking 表单提交链冲突）')
})

test('翻页锁：点「继续」经 renderModalLayer 把弹窗层翻到第二步（D-192 同根因预防）', async () => {
  const h = makeHarness({ bot: archivedBot })
  const step1 = h.step1Tree()
  const before = h.layer.syncCount
  await h.click(h.byAction(step1, 'bot-remove-tracking-step2'))
  assert.equal(h.state.modal.step, 2, 'state.modal.step 翻到 2')
  assert.ok(h.layer.syncCount > before, '#modal-root 必须被同步（直调 renderModalLayer，绕开 D-98 遮罩闸门）')
  assert.match(h.layer.html, /remove-tracking-name/, '第二步出现名称确认输入框')
})

test('第二步点「上一步」：弹窗层回到第一步（镜像路径）', async () => {
  const h = makeHarness({ bot: archivedBot })
  const step2 = h.step2Tree()
  const before = h.layer.syncCount
  await h.click(h.byAction(step2, 'bot-remove-tracking-back'))
  assert.equal(h.state.modal.step, 1, 'state.modal.step 回到 1')
  assert.ok(h.layer.syncCount > before, '弹窗层被同步')
  assert.doesNotMatch(h.layer.html, /remove-tracking-name/, '回到第一步后不再有名称输入框')
})

test('执行链路锁：点执行按钮 → remove_bot_tracking + 关弹窗 + 单聊导航重置 + 刷新 + 成功 toast', async () => {
  const h = makeHarness({ bot: archivedBot })
  const step2 = h.step2Tree()
  h.idRegistry.get('remove-tracking-name').value = '离队成员'
  await h.click(h.byAction(step2, 'bot-remove-tracking-confirm'))
  assert.equal(h.apiCalls.length, 1, '恰好一次 api 调用')
  assert.equal(h.apiCalls[0].action, 'remove_bot_tracking')
  assert.deepEqual(h.apiCalls[0].payload, { botId: 'bot_1', confirmName: '离队成员' })
  assert.equal(h.state.modal, null, '执行成功后弹窗关闭')
  assert.equal(h.layer.html, '', '#modal-root 已清层')
  assert.equal(h.state.soloBotId, null, '正停在该 Bot 单聊时导航重置：soloBotId 清空')
  assert.equal(h.state.view, 'chat', '视图回群聊')
  assert.equal(h.state.chatMode, 'group', 'chatMode 回群聊')
  assert.ok(h.refreshCount >= 1, '列表经 refresh 重载')
  assert.ok(h.toasts.some(item => item.kind === 'success' && /已移除追踪/.test(item.msg)), '成功 toast')
})

test('guard 锁：非 bot-remove-tracking 弹窗下点翻页按钮不写 step 不碰弹窗层', async () => {
  const h = makeHarness({ bot: archivedBot })
  const step1 = h.step1Tree()
  h.state.modal = { type: 'task', detail: {} }
  const before = h.layer.syncCount
  await h.click(h.byAction(step1, 'bot-remove-tracking-step2'))
  assert.equal(h.state.modal.step, undefined, 'task 弹窗不被写入 step')
  assert.equal(h.layer.syncCount, before, '弹窗层零同步')
})

test('入口锁：仅已归档 Bot 打开弹窗；未归档点击零响应', async () => {
  const entryAttrs = { 'data-action': 'bot-remove-tracking-open', 'data-bot-id': 'bot_1' }
  const h1 = makeHarness({ bot: archivedBot })
  await h1.click(new FakeEl('button', entryAttrs))
  assert.equal(h1.state.modal?.type, 'bot-remove-tracking', '已归档 Bot 点击入口打开弹窗')
  assert.equal(h1.state.modal?.step, 1, '从第一步开始')

  const h2 = makeHarness({ bot: { id: 'bot_1', name: '在职成员', status: 'active' } })
  await h2.click(new FakeEl('button', entryAttrs))
  assert.equal(h2.state.modal, null, 'active Bot 点击入口不打开弹窗（归档态校验）')
})

test('源级接线锁：chat.js 入口 archived-only + case 块直调 renderModalLayer + modal 层分发 + api 端点', () => {
  // 入口：renderSoloConfig 的按钮行里，移除追踪按钮必须挂在 archived 条件分支内。
  assert.match(
    chatSource,
    /bot\.status === 'archived' \? `[^`]*data-action="bot-remove-tracking-open"/,
    'chat.js 已归档分支保留移除追踪入口',
  )
  assert.doesNotMatch(
    chatSource,
    /bot\.status === 'active' \? `[^`]*bot-remove-tracking-open/,
    'active 分支不得出现移除追踪入口',
  )
  // 翻页 case 块体：直调 renderModalLayer、禁裸 render（块体 = case 起到同缩进下一 case 止）。
  const caseBlock = (name) => {
    const m = clickSource.match(new RegExp(`case '${name}': \\{([\\s\\S]*?)\\n      case `))
    assert.ok(m, `events-click.js 必须存在 case '${name}'`)
    return m[1]
  }
  for (const name of ['bot-remove-tracking-step2', 'bot-remove-tracking-back', 'bot-remove-tracking-confirm']) {
    const block = caseBlock(name)
    if (name === 'bot-remove-tracking-confirm') {
      assert.match(block, /api\('remove_bot_tracking', \{ botId, confirmName \}\)/, `case '${name}' 以固定签名调 remove_bot_tracking`)
    } else {
      assert.match(block, /renderModalLayer\(\)/, `case '${name}' 块内直调 renderModalLayer()`)
      assert.doesNotMatch(block, /[^.]\brender\(\)/, `case '${name}' 块内不得调裸 render()（遮罩期对弹窗层无效）`)
    }
  }
  // modal 层分发与导出。
  assert.match(layerSource, /case 'bot-remove-tracking': return modalRemoveBotTracking\(\)/, 'modal-layer.js 分发 bot-remove-tracking')
  assert.match(formsSource, /modalRemoveBotTracking/, 'modal-forms.js 定义 modalRemoveBotTracking')
  // 服务端动作白名单与分发 case。
  assert.match(serverApiSource, /'remove_bot_tracking'/, 'src/api.js 白名单含 remove_bot_tracking')
  assert.match(serverApiSource, /case 'remove_bot_tracking':/, 'src/api.js 有对应分发 case')
})

// ---------- 服务层契约（真实 TeamService + handleAction，镜像 tests/archive.test.js 的装配） ----------
class StubRuntime {
  declare models: {
    ref: string; provider: string; providerName: string; model: string; name: string
    efforts: { id: string; name: string }[]; defaultEffort: string
  }[]
  constructor() {
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }
  setCompletionHandler() {}
  async catalog() { return this.models }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bot-untrack-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

function insertSoloRun(store, { id: runId, botId, status = 'succeeded' }) {
  const ts = new Date().toISOString()
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, queued_at, started_at, ended_at)
     VALUES (?, NULL, ?, 'solo_chat', 'manual', ?, ?, ?, ?, ?)`,
    runId, botId, status, `idem-${runId}`, ts, ts, ts,
  )
}

const ACTOR = { type: 'user', id: 'owner' }

async function makeArchivedBot(service, name = '离队演示') {
  const bot = await service.createBot({ name, role: '测试' }, ACTOR)
  await handleAction(service, 'archive_bot', { botId: bot.id }, ACTOR)
  return bot
}

test('服务层：未归档 Bot 调 remove_bot_tracking → badRequest 且状态原样', async () => {
  const { root, service, store } = await setup()
  try {
    const bot = await service.createBot({ name: '在职演示' }, ACTOR)
    await assert.rejects(
      () => handleAction(service, 'remove_bot_tracking', { botId: bot.id, confirmName: bot.name }, ACTOR),
      err => (err as { code: string }).code === 'BAD_REQUEST',
    )
    assert.equal(store.get('SELECT status FROM bots WHERE id = ?', bot.id).status, 'active')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('服务层：confirmName 不匹配 → badRequest 且状态原样', async () => {
  const { root, service, store } = await setup()
  try {
    const bot = await makeArchivedBot(service)
    await assert.rejects(
      () => handleAction(service, 'remove_bot_tracking', { botId: bot.id, confirmName: '错误的名字' }, ACTOR),
      err => (err as { code: string }).code === 'BAD_REQUEST',
    )
    assert.equal(store.get('SELECT status FROM bots WHERE id = ?', bot.id).status, 'archived')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('服务层：存在排队/运行中 run → badRequest 且状态原样', async () => {
  const { root, service, store } = await setup()
  try {
    const bot = await makeArchivedBot(service)
    insertSoloRun(store, { id: 'run-q', botId: bot.id, status: 'queued' })
    await assert.rejects(
      () => handleAction(service, 'remove_bot_tracking', { botId: bot.id, confirmName: bot.name }, ACTOR),
      err => (err as { code: string }).code === 'BAD_REQUEST',
    )
    assert.equal(store.get('SELECT status FROM bots WHERE id = ?', bot.id).status, 'archived')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('服务层：软移除成功 → 状态 removed + audit 留痕 + 数据全保留 + 工作区目录保留', async () => {
  const { root, service, store } = await setup()
  try {
    const bot = await makeArchivedBot(service)
    const ts = new Date().toISOString()
    store.run(
      `INSERT INTO solo_messages(id, bot_id, sender_type, sender_id, body, created_at)
       VALUES ('msg-1', ?, 'user', 'owner', '历史消息保留', ?)`,
      bot.id, ts,
    )
    const soloDirAbs = join(service.config.workspace, '_the_bots', bot.soloDir)
    assert.ok(existsSync(soloDirAbs), '前置：单聊工作区目录存在')

    const result = await handleAction(
      service, 'remove_bot_tracking', { botId: bot.id, confirmName: ` ${bot.name} ` }, ACTOR,
    )
    assert.deepEqual(result, { removed: true, name: bot.name }, '返回形状 { removed, name }（confirmName 两侧 trim）')
    assert.equal(store.get('SELECT status FROM bots WHERE id = ?', bot.id).status, 'removed', 'bots.status 落 removed 终态')
    const audit = store.get(
      "SELECT * FROM audit_log WHERE action = 'bot.remove_tracking' AND target_id = ?", bot.id,
    )
    assert.ok(audit, 'audit_log 应有 bot.remove_tracking 留痕')
    // 非物理删除口径：消息、版本行、目录全部保留。
    assert.ok(store.get('SELECT 1 AS ok FROM solo_messages WHERE id = ?', 'msg-1'), '单聊消息保留')
    assert.ok(
      store.get('SELECT 1 AS ok FROM bot_revisions WHERE bot_id = ? ORDER BY version DESC LIMIT 1', bot.id),
      '版本历史保留',
    )
    assert.ok(existsSync(soloDirAbs), '单聊工作区目录保留（软移除不删文件）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('服务层：removed 为终态——update_bot / archive_bot 均拒绝复活', async () => {
  const { root, service, store } = await setup()
  try {
    const bot = await makeArchivedBot(service)
    await handleAction(service, 'remove_bot_tracking', { botId: bot.id, confirmName: bot.name }, ACTOR)
    await assert.rejects(
      () => handleAction(service, 'update_bot', { botId: bot.id, patch: { status: 'active' } }, ACTOR),
      err => (err as { code: string }).code === 'BAD_REQUEST',
    )
    await assert.rejects(
      () => handleAction(service, 'archive_bot', { botId: bot.id }, ACTOR),
      err => (err as { code: string }).code === 'BAD_REQUEST',
    )
    assert.equal(store.get('SELECT status FROM bots WHERE id = ?', bot.id).status, 'removed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('服务层：state 视图的工作台 Bots 列表不再含 removed Bot', async () => {
  const { root, service } = await setup()
  try {
    const bot = await makeArchivedBot(service)
    const before = await service.state(null, null)
    assert.ok(before.bots.some(item => item.id === bot.id), '前置：archived Bot 仍在列表')
    await handleAction(service, 'remove_bot_tracking', { botId: bot.id, confirmName: bot.name }, ACTOR)
    const view = await service.state(null, null)
    assert.ok(!view.bots.some(item => item.id === bot.id), 'removed Bot 从工作台列表消失')
    assert.ok(view.bots.some(item => item.name === 'director'), '其余 Bot 不受影响')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
