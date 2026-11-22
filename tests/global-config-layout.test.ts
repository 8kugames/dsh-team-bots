// 全局配置页信息架构守门（DSHBOTS-184 立骨架，DSHBOTS-197 迁移出通道/密钥，DSHBOTS-200 关于内容回迁）。
// 契约：配置页为「偏好 / 运行与预算 / 关于与系统状态」三个分组；微信通道、密钥分别落在
// 通道页 / 密钥页（ui/modules/global-pages.js），模型价格规则落在全局用量页。
// 样式细节由 tests/styles-split.test.js 兜底。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const intervalIds = new Set()
const nativeSetInterval = globalThis.setInterval
let timersWrapped = false

function stopTimers() {
  for (const id of intervalIds) clearInterval(id as any)
  intervalIds.clear()
}

// 与 tests/ui-language-render.test.js 同款最小 DOM 桩：app.js 顶层 void init()
// 会拉起定时器与 window/document 监听，桩不满足时走 bootError 兜底，不影响渲染函数。
function stubDom() {
  const fakeEl = () => ({
    style: {}, dataset: {}, children: [], childNodes: [],
    innerHTML: '', textContent: '', hidden: false, value: '', className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    appendChild(child) { this.children.push(child); return child },
    replaceChildren() {}, replaceWith() {}, prepend() {}, append() {}, remove() {},
    setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, removeEventListener() {}, focus() {},
    contains() { return false }, closest() { return null },
    get firstElementChild() { return null },
    get offsetWidth() { return 1 }, get offsetHeight() { return 1 },
  })
  const elements = new Map()
  globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, fakeEl()); return elements.get(id) },
    createElement: fakeEl,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    documentElement: {
      dataset: {}, style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
    },
    body: fakeEl(), activeElement: null,
  } as unknown as Document
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { href: 'http://127.0.0.1:3080/api/dsh-team/ui?view=global' },
    innerWidth: 1440, innerHeight: 900,
  } as unknown as Window & typeof globalThis
  globalThis.location = globalThis.window.location
  globalThis.performance = { now: () => 0 } as unknown as Performance
  globalThis.HTMLElement = (class {}) as unknown as typeof HTMLElement
  globalThis.Element = (class {}) as unknown as typeof Element
  globalThis.Node = (class {}) as unknown as typeof Node
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } }
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  globalThis.IntersectionObserver = (class { observe() {} disconnect() {} }) as unknown as typeof IntersectionObserver
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration)
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) } as unknown as Response)
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} } as unknown as Storage
  globalThis.confirm = () => false
  globalThis.alert = () => {}
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true,
  })
  if (!timersWrapped) {
    timersWrapped = true
    globalThis.setInterval = ((fn, ms, ...args) => {
      const id = nativeSetInterval(fn, ms, ...args)
      intervalIds.add(id)
      return id
    }) as unknown as typeof setInterval
  }
}

// 与原版守门同款时序约束：模块 import（会触发 app.js 顶层 void init() 排队 fetch 桩）
// 必须全部完成后再同步设置 fixture 并同步调用渲染——中间隔任何 await 边界，
// init 里的 loadState 就会把 state.data 覆盖为桩响应（null）。
async function renderPage(module, fn, data?, pageTab?) {
  stubDom()
  const { state } = await import(pathToFileURL(join(root, 'ui/modules/state.js')) as unknown as string)
  const mod = await import(pathToFileURL(join(root, `ui/modules/${module}.js`)) as unknown as string)
  state.projectId = null
  state.pageTab = pageTab ?? null
  state.data = {
    bots: [{ id: 'b1', status: 'active' }], projects: [{ id: 'p1', status: 'active' }],
    tasks: [], approvals: [], proposals: [], models: [], prices: [], priceDefaults: [],
    members: [], runs: [], skills: [{ id: 's1' }],
    usage: {
      priceCount: 3, window: '30d', byModel: [], byBot: [], byProject: [], byDay: [],
      reconciliation: null,
    },
    wechat: { enabled: false }, secrets: [], secretRequests: [],
    outbox: { pending: 0, failed: 0, delivered: 0 },
    paths: { dshHome: '/tmp/.dsh', workspace: '/tmp/ws', skillRoot: '/tmp/skills', dataDir: '/tmp/data' },
    dsh: { version: '0.2.284' }, pluginVersion: '0.2.284',
    project: null, settings: { ui_language: 'zh' },
    ...data,
  }
  state.view = { renderGlobal: 'global', renderChannel: 'channel', renderSecretsPage: 'secrets', renderUsageGlobal: 'usage', renderSkills: 'skills', renderBotsOverview: 'bots-overview' }[fn]
  return { html: mod[fn](), state, mod }
}

test('配置页四分组 tab 分页：导航与激活分组一一对应，一次只渲染一组', async () => {
  const { html, state, mod } = await renderPage('settings', 'renderGlobal')
  assert.match(html, /class="global-page"/, '页面根应为 .global-page')
  const tabs = [...html.matchAll(/class="global-nav-item(?: active)?" data-action="page-tab" data-tab="(g-[a-z]+)"/g)].map((m) => m[1])
  assert.deepEqual(tabs, ['g-pref', 'g-runtime', 'g-prompts', 'g-about'], '配置页应为 偏好/运行/团队指令/关于 四个 tab')
  const sections = [...html.matchAll(/<section class="gsec" id="(g-[a-z]+)"/g)].map((m) => m[1])
  assert.deepEqual(sections, ['g-pref'], '默认只渲染第一个分组')
  // 切 tab 后只渲染对应分组
  for (const id of tabs) {
    state.pageTab = id
    const next = mod.renderGlobal()
    const nextSections = [...next.matchAll(/<section class="gsec" id="(g-[a-z]+)"/g)].map((m) => m[1])
    assert.deepEqual(nextSections, [id], `激活 ${id} 时只渲染该分组`)
    assert.match(next, new RegExp(`aria-labelledby="${id}-title"`), `${id} 缺 aria-labelledby`)
    assert.match(next, new RegExp(`id="${id}-title"`), `${id} 缺标题 id`)
  }
  state.pageTab = null
  assert.doesNotMatch(html, /class="global-grid"/, '旧的 12 列混排容器应被分组容器取代')
  stopTimers()
})

test('配置页分组头保留序号、标题与说明（逐 tab 断言）', async () => {
  const { state, mod } = await renderPage('settings', 'renderGlobal')
  const byTab = { 'g-pref': ['01', '偏好'], 'g-runtime': ['02', '运行与预算'], 'g-prompts': ['03', '团队指令'], 'g-about': ['04', '关于与系统状态'] }
  for (const [tab, [index, title]] of Object.entries(byTab)) {
    state.pageTab = tab
    const html = mod.renderGlobal()
    assert.match(html, new RegExp(`class="gsec-index mono">${index}</`), `${tab} 缺分组序号 ${index}`)
    assert.ok(html.includes(title), `${tab} 缺分组标题 ${title}`)
    assert.match(html, /class="gsec-desc"/, '分组应有说明副行')
  }
  state.pageTab = null
  const all = mod.renderGlobal()
  assert.doesNotMatch(all, /class="gsec-index mono">05</, '分组 05 不应存在')
  for (const title of ['环境与版本', '接入与计价']) {
    assert.ok(!all.includes(title), `分组标题 ${title} 已迁出`)
  }
  assert.doesNotMatch(all, /class="gsec-meta"/, '「N 个模块」计数属噪音，不应渲染')
  stopTimers()
})

test('配置页无已迁出模块、无「计划迁移」标注、无指标带', async () => {
  const { html } = await renderPage('settings', 'renderGlobal', { wechat: { enabled: true, phase: 'connected' } })
  for (const title of ['微信通道', '密钥管理', '模型价格']) {
    assert.ok(!html.includes(`<h3>${title}</h3>`), `迁出模块 ${title} 不应留在配置页`)
  }
  assert.doesNotMatch(html, /g-move-note/, '迁移完成后不应再有 g-move-note 标注')
  assert.ok(!html.includes('计划迁移'), '页面任何位置都不应再出现「计划迁移」文案')
  assert.doesNotMatch(html, /global-metrics/, '指标带（团队统计）已迁出，与总览页去重')
  assert.doesNotMatch(html, /data-action="sync-skills"/, '重扫技能入口在技能页，配置页不放')
  stopTimers()
})

test('配置页核心组交互入口完整保留（逐 tab 汇总）', async () => {
  const { state, mod } = await renderPage('settings', 'renderGlobal')
  const html = ['g-pref', 'g-runtime', 'g-prompts', 'g-about']
    .map(tab => { state.pageTab = tab; return mod.renderGlobal() })
    .join('')
  state.pageTab = null
  for (const action of ['save-ui-language', 'save-run-limits', 'save-settings', 'reset-scale', 'set-theme', 'toggle-notify', 'check-dsh-update']) {
    assert.ok(html.includes(`data-action="${action}"`), `缺交互入口 ${action}`)
  }
  assert.match(html, /class="g-slot g-slot--/, '卡片应由槽位包裹以控制跨列')
  stopTimers()
})

test('免审规则编辑面在总览 bots 页「全部 Bots」下方：卡片式列表 + modal 编辑（DSHBOTS-365）', async () => {
  const rules = [
    { id: 'arul_default_tmp', path_prefix: '**/tmp/**', command: '', bot_id: '', tool_name: '', sandbox: '', note: '' },
    { id: 'arul_2', path_prefix: '', command: 'git push*', bot_id: 'b1', tool_name: '', sandbox: 'workspace-write', note: '' },
  ]
  const global = await renderPage('settings', 'renderGlobal', { approvalRules: rules })
  assert.doesNotMatch(global.html, /data-action="approval-rule-new"/, '配置页不渲染免审规则卡')
  assert.doesNotMatch(global.html, /data-form="save-approval-rule"/, '配置页没有规则表单')
  const overview = await renderPage('tasks', 'renderBotsOverview', {
    approvalRules: rules,
    bots: [{ id: 'b1', name: 'Bot', role: '成员', status: 'active', openTasks: 0, memoryCount: 0, stats: { succeeded: 0 } }],
  })
  assert.match(overview.html, /class="card perm-card"/, '总览页落免审权限卡')
  assert.match(overview.html, /class="perm-rule-card" data-approval-rule-id="arul_default_tmp"/, '每条规则一张独立卡片')
  assert.match(overview.html, /title="\*\*\/tmp\/\*\*">路径 \*\*\/tmp\/\*\*</, '卡片显示 glob 路径 chip')
  assert.match(overview.html, /title="git push\*">命令 git push\*/, '命令型规则同样出 chip')
  assert.match(overview.html, /data-action="approval-rule-edit" data-rule-id="arul_2"/, '每张卡带编辑入口（拉起 modal）')
  assert.match(overview.html, /data-action="approval-rule-delete" data-rule-id="arul_2"/, '每张卡带删除入口')
  assert.match(overview.html, /data-action="approval-rule-new"/, '新增规则按钮在卡尾')
  assert.doesNotMatch(overview.html, /data-action="save-approval-rules"/, '卡内不再有内联整表保存按钮')
  assert.doesNotMatch(overview.html, /class="perm-more"/, '不再有内联「更多条件」折叠区')
  // 位置：权限卡在「全部 Bots」之后，不抢 bots 列表的位置。
  const botsAt = overview.html.indexOf('全部')
  const permAt = overview.html.indexOf('perm-section')
  assert.ok(botsAt >= 0 && permAt > botsAt, '免审权限卡应排在「全部 Bots」之后')
  stopTimers()
})

test('完全权限总开关在总览 bots 页免审权限卡：开关行随 approvalFullAccess 翻转，配置页不渲染（DSHBOTS-366）', async () => {
  const global = await renderPage('settings', 'renderGlobal')
  assert.doesNotMatch(global.html, /data-action="toggle-full-access"/, '配置页不渲染完全权限开关')
  const off = await renderPage('tasks', 'renderBotsOverview', {
    bots: [{ id: 'b1', name: 'Bot', role: '成员', status: 'active', openTasks: 0, memoryCount: 0, stats: { succeeded: 0 } }],
  })
  assert.match(off.html, /class="perm-full-access"/, '免审权限卡顶渲染开关行')
  assert.match(off.html, /data-action="toggle-full-access" data-next="1"/, '默认关闭，点按打开')
  assert.match(off.html, /aria-checked="false"/, 'switch 角色默认未选中')
  const on = await renderPage('tasks', 'renderBotsOverview', {
    approvalFullAccess: true,
    bots: [{ id: 'b1', name: 'Bot', role: '成员', status: 'active', openTasks: 0, memoryCount: 0, stats: { succeeded: 0 } }],
  })
  assert.match(on.html, /data-action="toggle-full-access" data-next="0"/, '开启态点按关闭')
  assert.match(on.html, /aria-checked="true"/, '开启态 switch 选中')
  stopTimers()
})

test('通道页承载微信通道卡：停用态出启停开关、启用后可绑定', async () => {
  const empty = await renderPage('global-pages', 'renderChannel')
  assert.match(empty.html, /data-action="wechat-toggle" data-next="1"/, '停用态应渲染启用开关（DSHBOTS-334，不再依赖服务端注入）')
  assert.doesNotMatch(empty.html, /g-move-note/, '迁移落地后不再有迁移标注')
  stopTimers()
  const enabled = await renderPage('global-pages', 'renderChannel', { wechat: { enabled: true, phase: 'unbound' } })
  assert.match(enabled.html, /<h2 class="global-title">通道<\/h2>/, '单模块页只保留 pageHead 一层壳')
  assert.match(enabled.html, /data-action="wechat-login"/, '扫码绑定按钮随卡迁入')
  assert.doesNotMatch(enabled.html, /<h3>微信通道<\/h3>/, '标题只在页头出现一次')
  stopTimers()
})

test('密钥页承载密钥管理卡：列表 + 待审请求 + 保存表单', async () => {
  const { html } = await renderPage('global-pages', 'renderSecretsPage', {
    secrets: [{ id: 's1', name: 'DEPLOY_TOKEN', scope: 'team', fingerprint: 'abcd1234', updatedAt: '2026-11-04T00:00:00Z' }],
    secretRequests: [{ id: 'r1', botName: 'bot', name: 'API_KEY', reason: 'why', createdAt: '2026-11-04T00:00:00Z' }],
  })
  assert.match(html, /<h2 class="global-title">密钥管理<\/h2>/, '单模块页只保留 pageHead 一层壳')
  assert.doesNotMatch(html, /<h3>密钥管理<\/h3>/, '标题只在页头出现一次')
  assert.match(html, /data-action="page-tab"/, '密钥页应使用 tab 分页容器')
  stopTimers()
  // 三个 tab 各自的卡片入口逐个断言
  const { state, mod } = await renderPage('global-pages', 'renderSecretsPage', {
    secrets: [{ id: 's1', name: 'DEPLOY_TOKEN', scope: 'team', fingerprint: 'abcd1234', updatedAt: '2026-11-04T00:00:00Z' }],
    secretRequests: [{ id: 'r1', botName: 'bot', name: 'API_KEY', reason: 'why', createdAt: '2026-11-04T00:00:00Z' }],
  })
  state.pageTab = 's-requests'
  const requests = mod.renderSecretsPage()
  assert.match(requests, /data-form="approve-secret"/, '待审请求批准表单随卡迁入')
  assert.match(requests, /data-action="deny-secret-request"/, '拒绝按钮随卡迁入')
  state.pageTab = 's-list'
  const list = mod.renderSecretsPage()
  assert.match(list, /data-action="delete-secret"/, '删除密钥按钮随卡迁入')
  state.pageTab = 's-add'
  const add = mod.renderSecretsPage()
  assert.match(add, /data-form="upsert-secret"/, '保存密钥表单随卡迁入')
  state.pageTab = null
  stopTimers()
})

test('关于内容回迁配置页第四分组：DSH 路径/服务卡 + 检查更新；投递失败队列已移除', async () => {
  // state 残留 outbox 数据时也不渲染：投递失败明细属开发者信息，不出现在用户界面。
  const { html } = await renderPage('settings', 'renderGlobal', { outbox: { pending: 1, failed: 2, delivered: 10 } }, 'g-about')
  assert.match(html, /<h3>DSH 路径<\/h3>/, 'DSH 路径卡应回迁配置页')
  assert.match(html, /<h3>DSH 服务<\/h3>/, 'DSH 服务卡应回迁配置页')
  assert.match(html, /data-action="check-dsh-update"/, '检查更新按钮随卡回迁')
  assert.doesNotMatch(html, /投递队列|投递失败|重试全部失败投递/, '投递失败队列已从界面移除')
  assert.match(html, /data-action="copy"/, '路径复制按钮保留')
  assert.doesNotMatch(html, /data-action="sync-skills"/, '重扫技能入口去重到技能页，配置页不放')
  stopTimers()
})

test('DSH 服务卡版本行：取不到整行隐藏，取到显示真值（DSHBOTS-253）', async () => {
  // 取不到的三种形态：字段缺失 / 'unknown' 兜底 / 空串（含纯空白）——两个「当前版本」行
  // 整行不渲染，不留 unknown 或空占位；两个「最新版本」行行为不变。
  for (const fixture of [
    { dsh: {}, pluginVersion: undefined },
    { dsh: { version: 'unknown' }, pluginVersion: 'unknown' },
    { dsh: { version: ' ' }, pluginVersion: '' },
  ]) {
    const { html } = await renderPage('settings', 'renderGlobal', fixture, 'g-about')
    assert.ok(!html.includes('>dsh 当前版本</span>'), 'dsh 当前版本取不到时该行不应渲染')
    assert.ok(!html.includes('>dsh-team-bots 当前版本</span>'), '插件当前版本取不到时该行不应渲染')
    assert.ok(html.includes('>dsh 最新版本</span>'), 'dsh 最新版本行不受影响')
    assert.ok(html.includes('>dsh-team-bots 最新版本</span>'), '插件最新版本行不受影响')
    stopTimers()
  }
  const shown = await renderPage('settings', 'renderGlobal', { dsh: { version: '0.2.2-rc.1' }, pluginVersion: '0.2.316' }, 'g-about')
  assert.match(shown.html, /dsh 当前版本<\/span><strong>0\.2\.2-rc\.1<\/strong>/, 'dsh 当前版本取到时应显示真值')
  assert.match(shown.html, /dsh-team-bots 当前版本<\/span><strong>0\.2\.316<\/strong>/, '插件当前版本取到时应显示真值')
  stopTimers()
})

test('技能页保留重扫技能入口（自配置页去重合并的唯一入口）', async () => {
  const { html } = await renderPage('tasks', 'renderSkills')
  assert.match(html, /data-action="sync-skills"/, '重扫技能入口应在技能页')
  stopTimers()
})

test('全局用量页承载模型价格规则卡，「设置价格」面板头按钮去重', async () => {
  const { html } = await renderPage('settings', 'renderUsageGlobal', undefined, 'u-price')
  assert.match(html, /gsec-title" id="u-price-title">模型价格规则<\/h3>/, '价格规则分组应落在全局用量页')
  assert.match(html, /gsec-body"><div class="g-slot g-slot--full"><div class="card price-card"/, '价格卡落在整行槽位')
  assert.match(html, /class="card price-card"/, '价格卡样式类保留')
  assert.doesNotMatch(html, /设置价格/, '模型面板的「设置价格」按钮与价格卡入口去重后移除')
  stopTimers()
})
