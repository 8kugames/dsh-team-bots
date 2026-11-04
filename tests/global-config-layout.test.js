// 全局配置页信息架构守门（DSHBOTS-184）。
// 本文件锁「美术重设计」的结构契约：页头指标带、锚点导航、四个分组 section、
// 组内 12 列槽位，以及「计划迁移」占位标记。样式细节由 tests/styles-split.test.js 兜底。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const intervalIds = new Set()
const nativeSetInterval = globalThis.setInterval
let timersWrapped = false

function stopTimers() {
  for (const id of intervalIds) clearInterval(id)
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
  }
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { href: 'http://127.0.0.1:3080/api/dsh-team/ui?view=global' },
    innerWidth: 1440, innerHeight: 900,
  }
  globalThis.location = globalThis.window.location
  globalThis.performance = { now: () => 0 }
  globalThis.HTMLElement = class {}
  globalThis.Element = class {}
  globalThis.Node = class {}
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } }
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} }
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.confirm = () => false
  globalThis.alert = () => {}
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true,
  })
  if (!timersWrapped) {
    timersWrapped = true
    globalThis.setInterval = (fn, ms, ...args) => {
      const id = nativeSetInterval(fn, ms, ...args)
      intervalIds.add(id)
      return id
    }
  }
}

async function renderGlobalWith(data) {
  stubDom()
  const { state } = await import(pathToFileURL(join(root, 'ui/modules/state.js')))
  const settings = await import(pathToFileURL(join(root, 'ui/modules/settings.js')))
  state.view = 'global'
  state.projectId = null
  state.data = {
    bots: [{ id: 'b1', status: 'active' }], projects: [{ id: 'p1', status: 'active' }],
    tasks: [], approvals: [], proposals: [], models: [], prices: [], priceDefaults: [],
    members: [], runs: [], skills: [{ id: 's1' }],
    usage: { priceCount: 3 }, wechat: { enabled: false }, secrets: [],
    paths: { dshHome: '/tmp/.dsh', workspace: '/tmp/ws', skillRoot: '/tmp/skills', dataDir: '/tmp/data' },
    project: null, settings: { ui_language: 'zh' },
    ...data,
  }
  return settings.renderGlobal()
}

test('全局配置页按四个分组渲染，导航锚点与 section 一一对应', async () => {
  const html = await renderGlobalWith()
  assert.match(html, /class="global-page"/, '页面根应为 .global-page')
  const sections = [...html.matchAll(/<section class="gsec" id="(g-[a-z]+)"/g)].map((m) => m[1])
  assert.deepEqual(sections, ['g-pref', 'g-runtime', 'g-env', 'g-integrations'], '分组顺序固定为 偏好/运行/环境/接入')
  const anchors = [...html.matchAll(/class="global-nav-item" href="#(g-[a-z]+)"/g)].map((m) => m[1])
  assert.deepEqual(anchors, sections, '导航锚点必须与分组一一对应')
  for (const id of sections) {
    assert.match(html, new RegExp(`aria-labelledby="${id}-title"`), `${id} 缺 aria-labelledby`)
    assert.match(html, new RegExp(`id="${id}-title"`), `${id} 缺标题 id`)
  }
  assert.doesNotMatch(html, /class="global-grid"/, '旧的 12 列混排容器应被分组容器取代')
  stopTimers()
})

test('分组头给出序号、标题、说明与模块计数', async () => {
  const html = await renderGlobalWith()
  for (const index of ['01', '02', '03', '04']) {
    assert.match(html, new RegExp(`class="gsec-index mono">${index}</`), `缺分组序号 ${index}`)
  }
  for (const title of ['偏好', '运行与预算', '环境与版本', '接入与计价']) {
    assert.ok(html.includes(title), `缺分组标题 ${title}`)
  }
  assert.match(html, /class="gsec-desc"/, '分组应有说明副行')
  assert.match(html, /class="gsec-meta"/, '分组应有模块计数')
  stopTimers()
})

test('原「团队与资源」卡降级为页头指标带', async () => {
  const html = await renderGlobalWith()
  assert.match(html, /class="global-head"/, '应有页头')
  assert.match(html, /class="global-metrics"/, '应有指标带')
  assert.match(html, /class="global-metric-label">活跃 Bot</, '指标带应含活跃 Bot')
  assert.match(html, /class="global-metric-label">待审提案</, '指标带应含待审提案')
  assert.doesNotMatch(html, /<h3>团队与资源<\/h3>/, '不应再保留「团队与资源」卡标题')
  stopTimers()
})

test('九块模块全部落进分组槽位，原有交互入口不丢', async () => {
  const html = await renderGlobalWith()
  for (const title of ['界面', 'DSH 路径', 'DSH 服务', '运行时效', '系统与运维', '密钥管理', '模型价格']) {
    assert.ok(html.includes(`<h3>${title}</h3>`), `缺模块卡 ${title}`)
  }
  assert.match(html, /class="gsec-body"/, '分组内应是槽位网格')
  assert.match(html, /class="g-slot g-slot--/, '卡片应由槽位包裹以控制跨列')
  for (const action of ['save-ui-language', 'save-run-limits', 'save-settings', 'sync-skills', 'check-dsh-update']) {
    assert.ok(html.includes(`data-action="${action}"`), `缺交互入口 ${action}`)
  }
  stopTimers()
})

test('待迁移模块标注「计划迁移」占位，价格卡由样式层兜底标注', async () => {
  const html = await renderGlobalWith()
  for (const note of ['计划迁移 · 关于页', '计划迁移 · 密钥页']) {
    assert.ok(html.includes(note), `缺迁移标注 ${note}`)
  }
  assert.match(html, /class="g-move-note"/, '迁移标注应使用统一标记')
  assert.match(html, /class="card price-card"/, '价格卡应仍在页内（样式层负责跨列与标注）')
  stopTimers()
})

test('微信通道启用时出现在接入分组并带迁移标注', async () => {
  const html = await renderGlobalWith({ wechat: { enabled: true, phase: 'connected' } })
  assert.match(html, /<h3>微信通道<\/h3>/, '启用后应渲染微信通道卡')
  assert.ok(html.includes('计划迁移 · 通道页'), '微信通道应标注计划迁往通道页')
  stopTimers()
})
