// 全局配置页「界面语言」下拉的真实渲染守门（DSHBOTS-162）。
// tests/ui-language.test.js 覆盖解析优先级与保存链路；本文件补上「UI 真的渲染出来」这层：
// 用最小 DOM 桩真实导入 ui/modules/settings.js 并调用 renderGlobal()，断言下拉存在、
// 三选项齐全、按保存值选中，且 label/hint/按钮随当前语言换字典（i18n 键真实生效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// app.js 顶层挂了 2800ms 轮询定时器，会把 node --test 子进程吊住不退出；
// 包一层 setInterval 记录句柄，测试末尾统一清掉。
const intervalIds = new Set()
const nativeSetInterval = globalThis.setInterval
let timersWrapped = false

function stopTimers() {
  for (const id of intervalIds) clearInterval(id)
  intervalIds.clear()
}

// settings.js 的模块图会拉起 app.js（顶层 void init() + 若干 window/document 监听），
// node 下给最小桩即可：init() 内部自 catch，桩不满足时走 bootError 兜底，不影响 renderGlobal()。
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

test('全局配置页渲染界面语言下拉：三选项 + 按保存值选中 + 保存按钮', async () => {
  stubDom()
  const { state } = await import(pathToFileURL(join(root, 'ui/modules/state.js')))
  const settings = await import(pathToFileURL(join(root, 'ui/modules/settings.js')))
  const { setLanguage } = await import(pathToFileURL(join(root, 'ui/modules/i18n.js')))
  // app.js 的 void init() 在导入期异步跑过并可能把 state.data 置空，故导入后再铺数据。
  state.view = 'global'
  state.projectId = null
  state.data = {
    bots: [], projects: [], tasks: [], approvals: [], proposals: [],
    models: [], prices: [], priceDefaults: [], members: [], runs: [],
    usage: {}, wechat: {}, secrets: [], paths: {}, project: null,
    settings: { ui_language: 'en' },
  }

  const html = settings.renderGlobal()
  assert.match(html, /id="settings-ui-language"/, '界面卡应有语言下拉')
  assert.match(html, /name="ui_language"/, '下拉 name 必须是 ui_language（updateSettings 的键）')
  assert.match(html, /for="settings-ui-language"/, '下拉应有对应 label')
  for (const value of ['auto', 'zh', 'en']) {
    assert.match(html, new RegExp(`value="${value}"`), `下拉应有 ${value} 选项`)
  }
  assert.match(html, /value="en" selected/, '保存值为 en 时 en 选项应选中')
  assert.match(html, /data-action="save-ui-language"/, '应有保存按钮走 save-ui-language')

  // i18n 真实生效：切到 en 后同一份 renderGlobal() 输出换字典。
  setLanguage('en')
  const htmlEn = settings.renderGlobal()
  assert.match(htmlEn, /UI language/, '英文 label')
  assert.match(htmlEn, /Auto = follow the DSH host language setting\./, '英文 hint')
  assert.match(htmlEn, /Save language/, '英文保存按钮')
  assert.notEqual(htmlEn, html, '换语言后输出应变化')
  stopTimers()
})

test('未保存过语言时下拉回落 auto（跟随 DSH 宿主）', async () => {
  stubDom()
  const { state } = await import(pathToFileURL(join(root, 'ui/modules/state.js')))
  const settings = await import(pathToFileURL(join(root, 'ui/modules/settings.js')))
  state.view = 'global'
  state.projectId = null
  state.data = {
    bots: [], projects: [], tasks: [], approvals: [], proposals: [],
    models: [], prices: [], priceDefaults: [], members: [], runs: [],
    usage: {}, wechat: {}, secrets: [], paths: {}, project: null,
    settings: {},
  }
  const html = settings.renderGlobal()
  assert.match(html, /value="auto" selected/, '无保存值时 auto 应选中')
  assert.doesNotMatch(html, /value="zh" selected|value="en" selected/, '无保存值时不应选中具体语言')
  stopTimers()
})
