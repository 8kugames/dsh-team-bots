// 架构守门合集（原 tasks-split / ui-modules-split / styles-split / i18n-split 合并，
// 事故驱动防线 D-15/D-159/D-160/D-233/D-265，断言逐条保留，只收敛文件壳。）
import { UI_STYLE_PARTS, readUiStyles } from '../src/http.js'
import en from '../ui/i18n/en.js'
import enChat from '../ui/i18n/en/chat.js'
import enCommon from '../ui/i18n/en/common.js'
import enNav from '../ui/i18n/en/nav.js'
import enSettings from '../ui/i18n/en/settings.js'
import enTasks from '../ui/i18n/en/tasks.js'
import enUsage from '../ui/i18n/en/usage.js'
import enWechat from '../ui/i18n/en/wechat.js'
import enSession from '../ui/i18n/en/session.js'
import zh from '../ui/i18n/zh.js'
import zhChat from '../ui/i18n/zh/chat.js'
import zhCommon from '../ui/i18n/zh/common.js'
import zhNav from '../ui/i18n/zh/nav.js'
import zhSettings from '../ui/i18n/zh/settings.js'
import zhTasks from '../ui/i18n/zh/tasks.js'
import zhUsage from '../ui/i18n/zh/usage.js'
import zhWechat from '../ui/i18n/zh/wechat.js'
import zhSession from '../ui/i18n/zh/session.js'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ══ 原 tasks-split.test.ts ══
{
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SLICES = ['tasks', 'task-dispatch', 'task-runs']

function lines(rel: string) {
  return readFileSync(join(root, rel), 'utf8').split('\n').length
}

test('src/services/tasks*.ts 每个切片 <800 行（800 行铁律）', () => {
  for (const name of SLICES) {
    const n = lines(`src/services/${name}.ts`)
    assert.ok(n < 800, `${name}.ts ${n} 行，超过 800 行铁律`)
  }
})

test('编译产物 src/services/tasks*.js 每个切片 <800 行（行数守门口径）', () => {
  for (const name of SLICES) {
    const n = lines(`src/services/${name}.js`)
    assert.ok(n < 800, `${name}.js ${n} 行，超过 800 行铁律`)
  }
})

test('方法体不跨文件重复定义（搬迁不是复制）', () => {
  const seen = new Map()
  for (const name of SLICES) {
    const source = readFileSync(join(root, `src/services/${name}.ts`), 'utf8')
    for (const match of source.matchAll(/^  (?:async )?([A-Za-z_][A-Za-z0-9_]*)\(/gm)) {
      const method = match[1]
      assert.ok(!seen.has(method), `方法 ${method} 同时出现在 ${seen.get(method)} 与 ${name}.ts`)
      seen.set(method, name)
    }
  }
})
}


// ══ 原 ui-modules-split.test.ts ══
{
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modulesDir = join(root, 'ui/modules')
const MODULES = readdirSync(modulesDir).filter((name) => name.endsWith('.js')).sort()

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
  } as unknown as Document
  globalThis.window = {
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    location: { search: '', href: 'http://localhost/' },
    confirm: () => true,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  } as unknown as Window & typeof globalThis
  globalThis.localStorage = globalThis.window.localStorage
  globalThis.location = globalThis.window.location
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
  globalThis.HTMLImageElement = (class {}) as unknown as typeof HTMLImageElement
  globalThis.HTMLElement = (class {}) as unknown as typeof HTMLElement
  globalThis.Element = (class {}) as unknown as typeof Element
  globalThis.Image = (class {}) as unknown as typeof Image
}

test('每个 ui/modules/*.js 可被真实 ESM 求值（顶层零 app.js 局部符号）', async () => {
  installDomStubs()
  // app.js 顶层 void init() 会挂定时器；测试进程内禁用，避免悬挂。
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval
  globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout
  try {
    for (const name of MODULES) {
      const mod = await import(pathToFileURL(join(modulesDir, name)).href)
      assert.ok(mod, `${name} 应可求值`)
    }
    // app.js 是本轮拆分的宿主，单独再确认一次可求值。
    const app = await import(pathToFileURL(join(root, 'ui/app.js')).href)
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

test('ui/app.js 行数 <800（本卡验收线，拆分后不得回涨）', () => {
  const lines = readFileSync(join(root, 'ui/app.js'), 'utf8').split('\n').length
  assert.ok(lines < 800, `ui/app.js ${lines} 行，超过 800 行铁律`)
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

function blankNonCode(src) {
  const out = src.split('')
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      let j = i
      while (j < src.length && src[j] !== '\n') j += 1
      blank(i, j)
      i = j
    } else if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j += 1
      blank(i, Math.min(j + 2, src.length))
      i = Math.min(j + 2, src.length)
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1
        if (src[j] === '\n') break
        j += 1
      }
      blank(i, Math.min(j + 1, src.length))
      i = Math.min(j + 1, src.length)
    } else {
      i += 1
    }
  }
  return out.join('')
}

test('跨切片调用必须有对应 import（防拆分漏 import 的 ReferenceError）', () => {
  const provided = new Set()
  const sources = new Map()
  for (const name of MODULES) {
    const src = readFileSync(join(modulesDir, name), 'utf8')
    sources.set(name, src)
    for (const m of src.matchAll(/^export \{([^}]*)\}/gm)) {
      m[1].split(',').forEach((part) => {
        const binding = part.trim().split(/\s+as\s+/).pop().trim()
        if (binding) provided.add(binding)
      })
    }
    for (const m of src.matchAll(/^export (?:async )?function\s+(\w+)/gm)) provided.add(m[1])
  }
  for (const m of readFileSync(join(root, 'ui/app.js'), 'utf8').matchAll(/^export \{([^}]*)\}/gm)) {
    m[1].split(',').forEach((part) => {
      const binding = part.trim()
      if (binding) provided.add(binding)
    })
  }
  assert.ok(provided.size > 0, '应能收集到切片导出')

  for (const [name, raw] of sources) {
    const src = blankNonCode(raw)
    const imported = new Set()
    for (const m of src.matchAll(/import\s+(?:\{([^}]*)\}|(\w+))(?:\s*,\s*\{([^}]*)\})?\s+from/g)) {
      for (const group of [m[1], m[3]]) {
        if (group) {
          group.split(',').forEach((part) => {
            const binding = part.trim().split(/\s+as\s+/).pop().trim()
            if (binding) imported.add(binding)
          })
        }
      }
      if (m[2]) imported.add(m[2])
    }
    const local = new Set()
    for (const m of src.matchAll(/(?:function\s*\*?|class|const|let|var)\s+(\w+)/g)) local.add(m[1])
    const missing = new Set()
    for (const m of src.matchAll(/(?:^|[^\w$.'"])(\w+)\s*\(/g)) {
      const callee = m[1]
      if (provided.has(callee) && !imported.has(callee) && !local.has(callee)) missing.add(callee)
    }
    assert.deepEqual(
      [...missing],
      [],
      `${name} 调用了其它切片导出的 ${[...missing].join(', ')} 却没有 import——运行到该分支会 ReferenceError`,
    )
  }
})
}


// ══ 原 styles-split.test.ts ══
{
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CSS_MIME = 'text/css; charset=utf-8'

test('UI_STYLE_PARTS 与 ui/styles 目录一致：无孤儿、无缺件、无重复', async () => {
  const dirEntries = (await readdir(join(ROOT, 'ui', 'styles'))).filter((f) => f.endsWith('.css'))
  const listed = UI_STYLE_PARTS.map((p) => p.split('/').pop())
  assert.equal(new Set(listed).size, listed.length, 'UI_STYLE_PARTS 存在重复项')
  for (const f of dirEntries) {
    assert.ok(listed.includes(f), `ui/styles/${f} 不在 UI_STYLE_PARTS（孤儿文件）`)
  }
  for (const p of UI_STYLE_PARTS) {
    const info = await stat(join(ROOT, 'ui', p))
    assert.ok(info.size > 0, `${p} 是空文件`)
  }
})

test('ui/styles/*.css 每文件 <800 行（800 行铁律）', async () => {
  const dir = join(ROOT, 'ui', 'styles')
  const files = (await readdir(dir)).filter((x) => x.endsWith('.css'))
  assert.ok(files.length > 0, 'ui/styles 目录为空')
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf8')
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    assert.ok(lines < 800, `ui/styles/${f} ${lines} 行，超出 800 行铁律`)
  }
})

test('styles 路由双端口径一致：共用 readUiStyles、MIME 精确、入口单 link', async () => {
  const http = await readFile(join(ROOT, 'src/http.js'), 'utf8')
  const dev = await readFile(join(ROOT, 'scripts/dev-server.mjs'), 'utf8')
  const html = await readFile(join(ROOT, 'ui/index.html'), 'utf8')
  // 线上 styles() 与预览分支都必须走 readUiStyles 汇总（不是各读各的文件）。
  assert.match(
    http,
    /const styles = async \(\) => response\(await readUiStyles\(\), 'text\/css; charset=utf-8'\)/,
  )
  assert.match(dev, new RegExp(`styles\\.css'[\\s\\S]{0,140}?send\\(res, 200, '${CSS_MIME}', await readUiStyles\\(\\)`))
  // 预览不得残留单文件直读旧路径（绕过汇总即双侧漂移风险）。
  assert.ok(!dev.includes("readFile(join(ROOT, 'ui', 'styles.css')"), 'dev-server 不得绕过汇总直读 styles.css')
  // 路由与入口零改动：仍是一条 route + index.html 单 link（版本参数防缓存漂移）。
  assert.ok(http.includes("route('/api/dsh-team/styles.css'"), '线上 styles 路由缺失')
  const links = html.match(/styles\.css/g) ?? []
  assert.equal(links.length, 1, 'index.html 应只有一处 styles.css 引用')
  assert.match(html, /<link rel="stylesheet" href="\/api\/dsh-team\/styles\.css\?v=\{\{assetVersion\}\}">/)
  // 缓存语义不变：走 response() 默认 no-store（与拆分前一致）。
  assert.match(http, /'cache-control': 'no-store'/)
})

test('拼接零漂移：readUiStyles 输出与按表独立读取一致且花括号平衡', async () => {
  const served = await readUiStyles()
  const expected = (
    await Promise.all(UI_STYLE_PARTS.map((p) => readFile(join(ROOT, 'ui', p), 'utf8')))
  ).join('')
  assert.equal(served, expected)
  // 切割不得截断规则块。
  assert.equal((served.match(/{/g) ?? []).length, (served.match(/}/g) ?? []).length)
})

test('终态：巨石 styles.css 已删，顺序表不再引用，首尾域正确', async () => {
  // 5626 行巨石必须由 ui/styles/* 完全取代（过渡态 ['styles.css', ...] 不允许回潮）。
  await assert.rejects(stat(join(ROOT, 'ui', 'styles.css')), /ENOENT/, 'ui/styles.css 应已删除')
  assert.ok(!UI_STYLE_PARTS.includes('styles.css'), 'UI_STYLE_PARTS 不得再引用 styles.css')
  assert.equal(UI_STYLE_PARTS[0], 'styles/base.css', 'base 域必须最前（变量声明）')
  assert.equal(UI_STYLE_PARTS.at(-1), 'styles/terminal.css', 'terminal 域必须最后')
})

test('全局配置页视觉域已登记、层叠顺序正确、且不写死色值', async () => {
  const idx = UI_STYLE_PARTS.indexOf('styles/global-config.css')
  assert.ok(idx > 0, 'ui/styles/global-config.css 未登记进 UI_STYLE_PARTS')
  assert.equal(UI_STYLE_PARTS[idx - 1], 'styles/settings.css', 'global-config 域必须紧跟 settings 域')
  const css = await readFile(join(ROOT, 'ui', 'styles', 'global-config.css'), 'utf8')
  // DSHBOTS-197：迁移完成后「计划迁移」标注（.g-move-note）随之退役，不再要求存在。
  for (const selector of ['.global-page', '.global-head', '.global-nav', '.gsec', '.gsec-body', '.g-slot']) {
    assert.ok(css.includes(selector), `global-config.css 缺少 ${selector}`)
  }
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), 'global-config.css 不得写死色值（明暗双主题必须走 token）')
})
}


// ══ 原 i18n-split.test.ts ══
{
const I18N = join(fileURLToPath(new URL('..', import.meta.url)), 'ui', 'i18n')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

test('ui/i18n 每个切片 ≤800 行（800 行铁律）', () => {
  const files = tsFiles(I18N)
  assert.ok(files.length >= 14, `i18n 切片数量异常：${files.length}`)
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n').length
    assert.ok(lines <= 800, `${file} ${lines} 行，超过 800 行铁律`)
  }
})

test('聚合入口键集 = 各域切片键集之并，且 zh/en 一致', () => {
  const groups: Array<[string, Record<string, string>, Record<string, string>[]]> = [
    ['zh', zh, [zhCommon, zhNav, zhChat, zhTasks, zhUsage, zhSettings, zhWechat, zhSession]],
    ['en', en, [enCommon, enNav, enChat, enTasks, enUsage, enSettings, enWechat, enSession]],
  ]
  const sets: Record<string, string[]> = {}
  for (const [lang, agg, domains] of groups) {
    const union = new Set<string>()
    for (const dict of domains) {
      for (const key of Object.keys(dict)) {
        assert.ok(!union.has(key), `${lang} 域切片键重叠：${key}`)
        union.add(key)
      }
    }
    const aggKeys = Object.keys(agg)
    assert.deepEqual([...union].sort(), aggKeys.sort(), `${lang} 聚合入口键集与域切片并集不一致`)
    sets[lang] = aggKeys
  }
  assert.deepEqual(sets.zh.sort(), sets.en.sort(), 'zh/en 键集不一致')
  assert.ok(sets.zh.length >= 1000, `字典键数异常偏少：${sets.zh.length}`)
})
}
