// DSHBOTS-159 域边界守门：ui/app.js 按视图域拆到 ui/modules/* 后，
// ① 每个模块都能被真实 ESM 求值（顶层不引用 app.js 局部符号——D-15 事故防线）；
// ② 每个模块 <800 行（800 行铁律）；
// ③ 标记块（:start/:end）成对且唯一（迁移不得破坏标记块完整性）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modulesDir = join(root, 'ui/modules')
const MODULES = readdirSync(modulesDir).filter((name) => name.endsWith('.js')).sort()

// 最小 DOM 桩：让 app.js 顶层（含 void init()）在 node 下可求值。
function installDomStubs() {
  const noop = () => {}
  const el = () => ({
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute: noop,
    getAttribute: () => null,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {},
    dataset: {},
    appendChild: noop,
    remove: noop,
    innerHTML: '',
    textContent: '',
    hidden: false,
    focus: noop,
    blur: noop,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  })
  globalThis.document = {
    getElementById: () => el(),
    createElement: () => el(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    body: el(),
    hidden: false,
    documentElement: {
      dataset: {},
      style: { setProperty: noop },
      lang: 'zh',
      setAttribute: noop,
      removeAttribute: noop,
      getAttribute: () => null,
    },
    activeElement: null,
  }
  globalThis.window = {
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    location: { search: '', href: 'http://localhost/' },
    confirm: () => true,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  }
  globalThis.localStorage = globalThis.window.localStorage
  globalThis.location = globalThis.window.location
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
  globalThis.HTMLImageElement = class {}
  globalThis.HTMLElement = class {}
  globalThis.Element = class {}
  globalThis.Image = class {}
}

test('每个 ui/modules/*.js 可被真实 ESM 求值（顶层零 app.js 局部符号）', async () => {
  installDomStubs()
  // app.js 顶层 void init() 会挂定时器；测试进程内禁用，避免悬挂。
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  globalThis.setInterval = () => 0
  globalThis.setTimeout = () => 0
  try {
    for (const name of MODULES) {
      const mod = await import(pathToFileURL(join(modulesDir, name)))
      assert.ok(mod, `${name} 应可求值`)
    }
    // app.js 是本轮拆分的宿主，单独再确认一次可求值。
    const app = await import(pathToFileURL(join(root, 'ui/app.js')))
    assert.equal(typeof app.render, 'function')
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.setTimeout = realSetTimeout
  }
})

test('每个 ui/modules/*.js 行数 <800（800 行铁律）', () => {
  for (const name of MODULES) {
    const lines = readFileSync(join(modulesDir, name), 'utf8').split('\n').length
    assert.ok(lines < 800, `${name} ${lines} 行，超过 800 行铁律`)
  }
})

test('标记块成对且唯一（迁移不得破坏标记块）', () => {
  const source =
    readFileSync(join(root, 'ui/app.js'), 'utf8') +
    '\n' +
    MODULES.map((name) => readFileSync(join(modulesDir, name), 'utf8')).join('\n')
  const found = [...source.matchAll(/^\s*\/\/.*?\b([a-z0-9-]+):(start|end)\b/gm)].map((m) => [m[1], m[2]])
  assert.ok(found.length > 0, '应能识别到标记块')
  const tally = new Map()
  for (const [name, kind] of found) {
    const key = `${name}:${kind}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const names = new Set(found.map(([name]) => name))
  for (const name of names) {
    assert.equal(tally.get(`${name}:start`), 1, `标记块 ${name}:start 应恰好出现一次`)
    assert.equal(tally.get(`${name}:end`), 1, `标记块 ${name}:end 应恰好出现一次`)
  }
})
