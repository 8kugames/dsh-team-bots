// DSHBOTS-195 入口行为锁：移除追踪双入口——总览 bots 页归档卡片 + solo-config 配置页归档后原地显示。
// 手法对齐 tests/bot-untrack-confirm.test.js：真实源码求值（tasks.js renderBots / events-click click 监听器）
// + 归档态条件锁 + 反向断言 active 态不渲染入口。链路本身（弹窗 markup/提交契约）由 D-193 既有
// 守门覆盖，本文件不重复；此处锁的是「入口存在且可达」：
//   1) 总览归档卡片渲染入口按钮（真实 renderBots 求值，active 卡反向不含）；
//   2) 总览上下文点击入口经既有 case 开两步弹窗，零 api 副作用；
//   3) 配置页可达性根因锁：归档后不再踢出 solo-config（D-193 的 archived 分支从死分支变可达）；
//   4) confirm 导航重置只作用于单聊/配置页，总览页移除不传送视图；
//   5) 执行链唯一：全仓 events-click.js 只有一处 api('remove_bot_tracking') 调用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import './helpers/eval-shim.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tasksSource = readFileSync(join(root, 'ui', 'modules', 'tasks.js'), 'utf8')
const clickSource = readFileSync(join(root, 'ui', 'modules', 'events-click.js'), 'utf8')

// ---------- 最小 DOM shim（沿用 bot-untrack-confirm 的 FakeEl 形态） ----------
class FakeEl { declare tagName: string; declare attrs: Record<string, unknown>; declare parent: FakeEl | null; declare children: FakeEl[]; declare dataset: Record<string, string>; declare value: unknown;
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase()
    this.attrs = { ...attrs }
    this.parent = null
    this.children = []
    this.dataset = {}
    this.value = 'value' in attrs ? attrs.value : ''
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) {
        this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v)
      }
    }
  }
  matches(sel) {
    return sel.split(/(?=[.\[])/).every((part) => {
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
}

// ---------- 真实 renderBots 求值（tasks.js） ----------
const renderBotsSource = tasksSource.match(/^function renderBots\(\) \{[\s\S]*?^\}/m)?.[0] ?? ''
const escStub = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const fixtureBots = [
  {
    id: 'bot_archived', name: '离队成员', role: '旧成员', status: 'archived',
    modelRef: 'fake/model-a', effort: 'high', openTasks: 0, memoryCount: 3,
    stats: { succeeded: 12 },
  },
  {
    id: 'bot_active', name: '在职成员', role: '现役', status: 'active',
    modelRef: 'fake/model-a', effort: 'high', openTasks: 2, memoryCount: 5,
    stats: { succeeded: 30 },
  },
]

function evalRenderBots(bots) {
  const state = { data: { bots } }
  const renderBots = new Function(
    'state', 'icon', 'avatar', 'esc', 'attr', 'BOT_STATUS', 'EFFORT',
    `${renderBotsSource}\nreturn renderBots`,
  )(state, () => '', () => '', escStub, escStub, { active: '在职', archived: '已归档' }, { high: '高' })
  return renderBots()
}

const cardSegment = (html, botId) => html.split('<article').find(part => part.includes(`data-bot-id="${botId}"`))

test('总览入口渲染：真实 renderBots 求值——归档卡片含 danger 移除追踪按钮（bot-remove-tracking-open）', () => {
  const html = evalRenderBots(fixtureBots)
  const archivedCard = cardSegment(html, 'bot_archived')
  assert.ok(archivedCard, '归档 Bot 卡片必须渲染')
  assert.match(
    archivedCard,
    /class="btn small danger"[^>]*data-action="bot-remove-tracking-open"[^>]*data-bot-id="bot_archived"/,
    '归档卡片按钮行有 danger 移除追踪入口，携带 bot id',
  )
  assert.ok(/移除追踪/.test(archivedCard), '按钮文案为「移除追踪」')
})

test('总览入口反向锁：active 卡片不渲染移除追踪入口（active 卡只有 调度/归档）', () => {
  const html = evalRenderBots(fixtureBots)
  const activeCard = cardSegment(html, 'bot_active')
  assert.ok(activeCard, 'active Bot 卡片必须渲染')
  assert.doesNotMatch(activeCard, /bot-remove-tracking-open/, 'active 卡不得出现移除追踪入口')
  assert.match(activeCard, /data-action="archive-bot"/, 'active 卡保持归档入口（现状不变）')
})

test('总览入口源级条件锁：tasks.js 入口挂 archived 分支，active 分支与 renderBotsOverview 接线不回退', () => {
  assert.match(
    tasksSource,
    /bot\.status === 'archived' \? `[^`]*data-action="bot-remove-tracking-open"/,
    'renderBots 的移除追踪按钮必须挂在 archived 条件分支内',
  )
  assert.doesNotMatch(
    tasksSource,
    /bot\.status === 'active' \? `[^`]*bot-remove-tracking-open/,
    'active 分支不得出现移除追踪入口',
  )
  assert.match(
    tasksSource,
    /function renderBotsOverview\(\) \{[\s\S]*?\$\{renderBots\(\)\}/,
    'bots-overview 页必须复用 renderBots 渲染全部 Bot 卡片',
  )
})

// ---------- 真实 click 监听器求值（events-click.js，confirm 放行为 true） ----------
const noop = () => {}
function makeClickHarness({ bots, view = 'bots-overview', chatMode = 'group', soloBotId = null, modal = null }: { bots?: any[]; view?: string; chatMode?: string; soloBotId?: any; modal?: any } = {}) {
  const state = { modal, soloBotId, view, chatMode, data: { projects: [], bots } }
  const apiCalls = []
  const toasts = []
  const idRegistry = new Map()
  const stubs = {
    state,
    t: (k) => k, activeProject: () => null,
    botById: (botId) => bots.find(bot => bot.id === botId) ?? null,
    toast: (msg, kind) => toasts.push({ msg, kind }),
    // api 桩镜像服务端契约：archive_bot 成功即把内存 fixture 的 status 翻为 archived
    //（真实链路里 refresh 会带回同样结果），否则 archive-bot case 的归档态判定失真。
    api: async (action, payload) => {
      apiCalls.push({ action, payload })
      if (action === 'archive_bot') {
        const target = bots.find(bot => bot.id === payload.botId)
        if (target) target.status = 'archived'
      }
    },
    loadState: async () => {},
    refresh: async () => {},
    render: noop,
    renderKeepingChatScroll: noop, handleBoardAction: async () => false,
    renderModalLayer: noop,
    closeModal: () => { state.modal = null },
    openModal: (next) => { state.modal = next },
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
  const listeners = new Map()
  const documentStub = {
    addEventListener: (t, fn) => listeners.set(t, fn),
    getElementById: (id) => idRegistry.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const globals = {
    document: documentStub,
    window: { addEventListener: noop, confirm: () => true, open: noop, prompt: () => null },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem: noop },
  }
  const stripped = clickSource.split('\n').filter((line) => !line.startsWith('import ')).join('\n')
  new Function(...Object.keys(stubs), ...Object.keys(globals), stripped)(...Object.values(stubs), ...Object.values(globals))
  return {
    state, apiCalls, toasts, idRegistry,
    click: async (el) => { await listeners.get('click')({ target: el, preventDefault: noop }) },
  }
}

const archivedBot = { id: 'bot_1', name: '离队成员', status: 'archived' }
const activeBot = { id: 'bot_1', name: '在职成员', status: 'active' }

test('总览入口点击锁：bots-overview 上下文点入口 → 复用既有 case 打开两步弹窗第一步，零 api 调用', async () => {
  const h = makeClickHarness({ bots: [archivedBot] })
  await h.click(new FakeEl('button', { 'data-action': 'bot-remove-tracking-open', 'data-bot-id': 'bot_1' }))
  assert.equal(h.state.modal?.type, 'bot-remove-tracking', '总览页入口打开既有两步弹窗')
  assert.equal(h.state.modal?.step, 1, '从第一步开始')
  assert.equal(h.state.modal?.botId, 'bot_1', '弹窗携带正确 botId')
  assert.equal(h.apiCalls.length, 0, '打开弹窗阶段零 api 副作用')
})

test('配置页可达性锁：solo-config 上点归档 → api 归档 + 视图留守（D-193 archived 分支由此可达）', async () => {
  const h = makeClickHarness({ bots: [activeBot], view: 'solo-config', chatMode: 'solo', soloBotId: 'bot_1' })
  await h.click(new FakeEl('button', { 'data-action': 'archive-bot', 'data-bot-id': 'bot_1' }))
  assert.equal(h.apiCalls.length, 1, '恰好一次 api 调用')
  assert.equal(h.apiCalls[0].action, 'archive_bot', '走归档端点')
  assert.equal(h.state.view, 'solo-config', '归档后留在 solo-config，不踢回群聊')
  assert.equal(h.state.chatMode, 'solo', 'chatMode 不被改写')
  assert.ok(h.toasts.some(item => item.kind === 'success' && /已归档/.test(item.msg)), '成功 toast')
})

test('配置页可达性源级锁：archive-bot case 块内不再出现踢出导航', () => {
  const m = clickSource.match(/case 'archive-bot': \{([\s\S]*?)\n      case /)
  assert.ok(m, 'events-click.js 必须存在 archive-bot case')
  assert.doesNotMatch(m[1], /state\.view = 'chat'/, 'archive-bot case 不得把视图踢回聊天页（会杀死配置页 archived 入口的可达性）')
  assert.doesNotMatch(m[1], /state\.chatMode = 'group'/, 'archive-bot case 不得改写 chatMode')
})

test('confirm 导航重置范围锁：总览页移除不传送视图；solo-config 上移除仍重置回群聊', async () => {
  // 总览上下文：soloBotId 是旧会话残留，移除后留在总览页。
  const hOverview = makeClickHarness({ bots: [archivedBot], view: 'bots-overview', chatMode: 'group', soloBotId: 'bot_1', modal: { type: 'bot-remove-tracking', botId: 'bot_1', name: '离队成员', step: 2 } })
  hOverview.idRegistry.set('remove-tracking-name', { value: '离队成员' })
  await hOverview.click(new FakeEl('button', { 'data-action': 'bot-remove-tracking-confirm' }))
  assert.equal(hOverview.apiCalls[0]?.action, 'remove_bot_tracking', '走既有执行链')
  assert.equal(hOverview.state.view, 'bots-overview', '总览页移除后不被传送走')
  assert.ok(hOverview.toasts.some(item => /已移除追踪/.test(item.msg)), '成功 toast')

  // 配置页上下文：移除当前 bot 必须重置导航（既有行为保持）。
  const hSolo = makeClickHarness({ bots: [archivedBot], view: 'solo-config', chatMode: 'solo', soloBotId: 'bot_1', modal: { type: 'bot-remove-tracking', botId: 'bot_1', name: '离队成员', step: 2 } })
  hSolo.idRegistry.set('remove-tracking-name', { value: '离队成员' })
  await hSolo.click(new FakeEl('button', { 'data-action': 'bot-remove-tracking-confirm' }))
  assert.equal(hSolo.state.view, 'chat', 'solo-config 移除后回群聊')
  assert.equal(hSolo.state.chatMode, 'group', 'chatMode 回群聊')
  assert.equal(hSolo.state.soloBotId, null, 'soloBotId 清空')
})

test('执行链唯一锁：events-click.js 中 api(\'remove_bot_tracking\') 恰一处——双入口共用同一链路，禁止第二条', () => {
  assert.equal(
    (clickSource.match(/api\('remove_bot_tracking'/g) ?? []).length, 1,
    'remove_bot_tracking 执行链必须唯一（总览入口只开弹窗，不另起调用）',
  )
})
