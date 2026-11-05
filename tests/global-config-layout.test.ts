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
async function renderPage(module, fn, data?) {
  stubDom()
  const { state } = await import(pathToFileURL(join(root, 'ui/modules/state.js')) as unknown as string)
  const mod = await import(pathToFileURL(join(root, `ui/modules/${module}.js`)) as unknown as string)
  state.projectId = null
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
  state.view = { renderGlobal: 'global', renderChannel: 'channel', renderSecretsPage: 'secrets', renderUsageGlobal: 'usage', renderSkills: 'skills' }[fn]
  return { html: mod[fn](), state }
}

test('配置页三分组，导航锚点与 section 一一对应', async () => {
  const { html } = await renderPage('settings', 'renderGlobal')
  assert.match(html, /class="global-page"/, '页面根应为 .global-page')
  const sections = [...html.matchAll(/<section class="gsec" id="(g-[a-z]+)"/g)].map((m) => m[1])
  assert.deepEqual(sections, ['g-pref', 'g-runtime', 'g-about'], '配置页应为 偏好/运行/关于 三分组')
  const anchors = [...html.matchAll(/class="global-nav-item" href="#(g-[a-z]+)"/g)].map((m) => m[1])
  assert.deepEqual(anchors, sections, '导航锚点必须与分组一一对应')
  for (const id of sections) {
    assert.match(html, new RegExp(`aria-labelledby="${id}-title"`), `${id} 缺 aria-labelledby`)
    assert.match(html, new RegExp(`id="${id}-title"`), `${id} 缺标题 id`)
  }
  assert.doesNotMatch(html, /class="global-grid"/, '旧的 12 列混排容器应被分组容器取代')
  stopTimers()
})

test('配置页分组头保留序号、标题与说明', async () => {
  const { html } = await renderPage('settings', 'renderGlobal')
  for (const index of ['01', '02', '03']) {
    assert.match(html, new RegExp(`class="gsec-index mono">${index}</`), `缺分组序号 ${index}`)
  }
  for (const index of ['04', '05']) {
    assert.doesNotMatch(html, new RegExp(`class="gsec-index mono">${index}</`), `分组 ${index} 不应存在`)
  }
  for (const title of ['偏好', '运行与预算', '关于与系统状态']) {
    assert.ok(html.includes(title), `缺分组标题 ${title}`)
  }
  for (const title of ['环境与版本', '接入与计价']) {
    assert.ok(!html.includes(title), `分组标题 ${title} 已迁出`)
  }
  assert.match(html, /class="gsec-desc"/, '分组应有说明副行')
  assert.doesNotMatch(html, /class="gsec-meta"/, '「N 个模块」计数属噪音，不应渲染')
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

test('配置页核心组交互入口完整保留', async () => {
  const { html } = await renderPage('settings', 'renderGlobal')
  for (const action of ['save-ui-language', 'save-run-limits', 'save-settings', 'reset-scale', 'set-theme', 'toggle-notify', 'check-dsh-update']) {
    assert.ok(html.includes(`data-action="${action}"`), `缺交互入口 ${action}`)
  }
  assert.match(html, /class="g-slot g-slot--/, '卡片应由槽位包裹以控制跨列')
  stopTimers()
})

test('通道页承载微信通道卡：未启用空态、启用后可绑定', async () => {
  const empty = await renderPage('global-pages', 'renderChannel')
  assert.match(empty.html, /<h3>微信通道未启用<\/h3>/, '未启用时应显示空态引导')
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
  assert.match(html, /data-form="upsert-secret"/, '保存密钥表单随卡迁入')
  assert.match(html, /data-form="approve-secret"/, '待审请求批准表单随卡迁入')
  assert.match(html, /data-action="deny-secret-request"/, '拒绝按钮随卡迁入')
  assert.match(html, /data-action="delete-secret"/, '删除密钥按钮随卡迁入')
  stopTimers()
})

test('关于内容回迁配置页第三分组：DSH 路径/服务卡 + 检查更新 + 投递失败提示', async () => {
  const { html } = await renderPage('settings', 'renderGlobal', { outbox: { pending: 1, failed: 2, delivered: 10 } })
  assert.match(html, /<h3>DSH 路径<\/h3>/, 'DSH 路径卡应回迁配置页')
  assert.match(html, /<h3>DSH 服务<\/h3>/, 'DSH 服务卡应回迁配置页')
  assert.match(html, /data-action="check-dsh-update"/, '检查更新按钮随卡回迁')
  assert.match(html, /2 条消息投递失败/, '投递失败提示随卡回迁')
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
    const { html } = await renderPage('settings', 'renderGlobal', fixture)
    assert.ok(!html.includes('>dsh 当前版本</span>'), 'dsh 当前版本取不到时该行不应渲染')
    assert.ok(!html.includes('>dsh-team-bots 当前版本</span>'), '插件当前版本取不到时该行不应渲染')
    assert.ok(html.includes('>dsh 最新版本</span>'), 'dsh 最新版本行不受影响')
    assert.ok(html.includes('>dsh-team-bots 最新版本</span>'), '插件最新版本行不受影响')
    stopTimers()
  }
  const shown = await renderPage('settings', 'renderGlobal', { dsh: { version: '0.2.2-rc.1' }, pluginVersion: '0.2.316' })
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
  const { html } = await renderPage('settings', 'renderUsageGlobal')
  assert.match(html, /gsec-title" id="u-price-title">模型价格规则<\/h3>/, '价格规则分组应落在全局用量页')
  assert.match(html, /gsec-body"><div class="g-slot g-slot--full"><div class="card price-card"/, '价格卡落在整行槽位')
  assert.match(html, /class="card price-card"/, '价格卡样式类保留')
  assert.doesNotMatch(html, /设置价格/, '模型面板的「设置价格」按钮与价格卡入口去重后移除')
  stopTimers()
})
