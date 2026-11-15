import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import zhDict from '../ui/i18n/zh.js'
import enDict from '../ui/i18n/en.js'

const zh = zhDict as Record<string, string>
const en = enDict as Record<string, string>

// DSHBOTS-220：ui/modules/*.ts 硬编码中文清零守门；DSHBOTS-300 起覆盖 ui/app.ts 与 ui/index.html
// （此前只有 ui/modules 在扫描范围内，app.ts 的硬编码中文与 index.html 的静态文案都漏了）。
// 口径与 .governance/tasks/DSHBOTS-220/scan-cjk.mjs 一致：剔注释行 → 剔 t('...')/t("...") 包裹 →
// 剩余含 CJK 的行必须为 0。仅两行正则字面量（字符类里的全角标点）作为数据豁免，见 DATA_ALLOWED。
// 第二道：ui/modules 里出现的每个 t() 键都必须同时存在于 zh / en 两字典（防「两字典均无键」回流）。

const dir = fileURLToPath(new URL('../ui/modules/', import.meta.url))
const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()
const appFile = fileURLToPath(new URL('../ui/app.ts', import.meta.url))
const htmlFile = fileURLToPath(new URL('../ui/index.html', import.meta.url))
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/
const T_CALL = /t\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

// 数据豁免：正则字符类中的全角标点，不是展示文案。
const DATA_ALLOWED = [
  /match\(\/\(\?:\^\|\[/,
  /split\(\/\[,，、/,
]

function scanCjk() {
  const hits = []
  const scan = (file, path) => {
    const lines = readFileSync(path, 'utf8').split('\n')
    let inBlock = false
    lines.forEach((raw, i) => {
      let line = raw
      if (inBlock) {
        const end = line.indexOf('*/')
        if (end === -1) return
        line = line.slice(end + 2)
        inBlock = false
      }
      line = line.replace(/\/\*[\s\S]*?\*\//g, '')
      if (/\/\*/.test(line)) inBlock = true
      const lc = line.indexOf('//')
      if (lc !== -1) line = line.slice(0, lc)
      line = line.replace(T_CALL, 't()')
      if (CJK.test(line)) hits.push({ file, n: i + 1, text: raw.trim() })
    })
  }
  for (const file of files) scan(file, join(dir, file))
  scan('app.ts', appFile)
  return hits
}

test('ui/modules 与 ui/app.ts 非 t() 包裹的 CJK 行为 0（数据正则除外）', () => {
  const hits = scanCjk().filter((h) => !DATA_ALLOWED.some((re) => re.test(h.text)))
  assert.deepEqual(
    hits,
    [],
    `ui 源码仍有硬编码中文：\n${hits.map((h) => `${h.file}:${h.n}: ${h.text}`).join('\n')}`,
  )
})

// index.html 是静态页：只有 skip-link 与 boot-copy 两处中文，启动时由 ui/app.ts 用
// t('a11y.skipToContent') / t('boot.connecting') 替换（见 app.ts 的 boot 段）。除这两处外
// 不得再有中文；豁免只认这两个元素本身，且必须真的存在（防豁免失效或文案被漏译）。
const HTML_RUNTIME_REPLACED = [
  { re: /<a class="skip-link"[^>]*>[\s\S]*?<\/a>/, key: 'a11y.skipToContent' },
  { re: /<div class="boot-copy">[\s\S]*?<\/div>/, key: 'boot.connecting' },
]

test('ui/index.html 除启动时替换的两处外不得有中文', () => {
  const html = readFileSync(htmlFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  for (const { re, key } of HTML_RUNTIME_REPLACED) {
    assert.match(html, re, `index.html 缺少启动时替换的元素（对应 ${key}）`)
    assert.ok(zh[key] && en[key], `${key} 必须在 zh / en 字典里都有`)
  }
  let rest = html
  for (const { re } of HTML_RUNTIME_REPLACED) rest = rest.replace(re, '')
  const hits = rest.split('\n').map((text, i) => ({ n: i + 1, text: text.trim() })).filter((h) => CJK.test(h.text))
  assert.deepEqual(hits, [], `ui/index.html 仍有未翻译的中文：\n${hits.map((h) => `${h.n}: ${h.text}`).join('\n')}`)
})

test('data 豁免清单只覆盖真实存在的正则行（防白名单失效）', () => {
  const hits = scanCjk()
  assert.equal(hits.length, DATA_ALLOWED.length, `CJK 残留行数变化，需重核数据豁免：${JSON.stringify(hits)}`)
  for (const h of hits) assert.ok(DATA_ALLOWED.some((re) => re.test(h.text)), `未豁免的 CJK 行：${h.file}:${h.n}: ${h.text}`)
})

test('zh / en 两字典键集对齐且值非空', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.ok(zhKeys.length > 500, `字典键数异常偏少：${zhKeys.length}`)
  assert.deepEqual(zhKeys, enKeys, 'zh / en 字典键集不一致')
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', `zh 值类型异常：${key}`)
    assert.equal(typeof en[key], 'string', `en 值类型异常：${key}`)
    assert.ok(zh[key].length > 0 && en[key].length > 0, `字典值为空：${key}`)
  }
})
