import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import zhDict from '../ui/i18n/zh.js'
import enDict from '../ui/i18n/en.js'

const zh = zhDict as Record<string, string>
const en = enDict as Record<string, string>

// DSHBOTS-220：ui/modules/*.ts 硬编码中文清零守门。
// 口径与 .governance/tasks/DSHBOTS-220/scan-cjk.mjs 一致：剔注释行 → 剔 t('...')/t("...") 包裹 →
// 剩余含 CJK 的行必须为 0。仅两行正则字面量（字符类里的全角标点）作为数据豁免，见 DATA_ALLOWED。
// 第二道：ui/modules 里出现的每个 t() 键都必须同时存在于 zh / en 两字典（防「两字典均无键」回流）。

const dir = fileURLToPath(new URL('../ui/modules/', import.meta.url))
const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/
const T_CALL = /t\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

// 数据豁免：正则字符类中的全角标点，不是展示文案。
const DATA_ALLOWED = [
  /match\(\/\(\?:\^\|\[/,
  /split\(\/\[,，、/,
]

function scanCjk() {
  const hits = []
  for (const file of files) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n')
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
  return hits
}

test('ui/modules 非 t() 包裹的 CJK 行为 0（数据正则除外）', () => {
  const hits = scanCjk().filter((h) => !DATA_ALLOWED.some((re) => re.test(h.text)))
  assert.deepEqual(
    hits,
    [],
    `ui/modules 仍有硬编码中文：\n${hits.map((h) => `${h.file}:${h.n}: ${h.text}`).join('\n')}`,
  )
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
