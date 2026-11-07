// DSHBOTS-300：语言固化守门——英文环境下加载 UI 模块，不得有任何一次「中文词典读取」。
//
// 背景：ESM 的导入求值先于模块体，ui/app.ts 的 setLanguage() 在模块体里；而业务模块若在
// 顶层写了 `const X = { a: t('…') }`，t() 会在语言切换前跑完，值被固化进常量对象，
// 之后切到英文也仍是中文（DSHBOTS-300 实测：审批卡状态 pill、轨迹标签、斜杠命令说明）。
// 另有 en 缺键时 t() 会回退读中文词典——同样表现为英文界面露中文。
//
// 守门口径：以 data-dsh-language="en" 加载 ui/app.js（浏览器真实入口），给中文词典的每个
// 属性装 getter 记录读取；加载过程中只要读过一次中文词典就判红。
// 英文模式下正常取值只读 en 词典（i18n.js 的 t() 先查当前语言），故中文读取必然有问题。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))

function installDomStubs() {
  const noop = () => {}
  const el = () => ({
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, dataset: {}, appendChild: noop, remove: noop,
    innerHTML: '', textContent: '', hidden: false, focus: noop, blur: noop,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  })
  globalThis.location = { search: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' }
  globalThis.document = {
    getElementById: () => el(),
    createElement: () => el(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    body: el(),
    hidden: false,
    documentElement: {
      // 关键：以英文环境加载，模块顶层若固化文案，这里会读到中文词典。
      dataset: { dshLanguage: 'en' },
      style: { setProperty: noop },
      lang: 'en',
      setAttribute: noop, removeAttribute: noop, getAttribute: () => null,
    },
    activeElement: null,
  } as unknown as Document
  globalThis.window = globalThis
  globalThis.addEventListener = noop as unknown as typeof globalThis.addEventListener
  globalThis.matchMedia = (() => ({ matches: false, addEventListener: noop })) as unknown as typeof globalThis.matchMedia
  globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => setTimeout(fn, 0)) as typeof globalThis.requestAnimationFrame
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof globalThis.fetch
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } } as unknown as typeof MutationObserver
  globalThis.localStorage = { getItem: () => null, setItem: noop } as unknown as Storage
  globalThis.alert = noop as unknown as typeof globalThis.alert
  globalThis.confirm = (() => true) as unknown as typeof globalThis.confirm
}

test('英文环境加载 UI 模块时不得读取中文词典（顶层固化 / 英文缺键会露中文）', async () => {
  installDomStubs()
  const i18n = await import(pathToFileURL(join(root, 'ui/modules/i18n.js')).href)
  const zhDict = (await import(pathToFileURL(join(root, 'ui/i18n/zh.js')).href)).default as Record<string, string>

  const reads: string[] = []
  for (const key of Object.keys(zhDict)) {
    const original = Object.getOwnPropertyDescriptor(zhDict, key)!
    Object.defineProperty(zhDict, key, {
      enumerable: true,
      configurable: true,
      get() {
        reads.push(`${key}（当时语言 ${i18n.getLanguage()}）`)
        return original.value
      },
    })
  }

  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  globalThis.setInterval = (() => 0) as unknown as typeof globalThis.setInterval
  globalThis.setTimeout = (() => 0) as unknown as typeof globalThis.setTimeout
  try {
    await import(pathToFileURL(join(root, 'ui/app.js')).href)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.setTimeout = realSetTimeout
  }

  assert.equal(i18n.getLanguage(), 'en', '加载后语言应为 en（否则本用例的判定前提不成立）')
  assert.deepEqual(reads, [], `英文环境加载 UI 模块时读了中文词典：\n${reads.join('\n')}`)
})
