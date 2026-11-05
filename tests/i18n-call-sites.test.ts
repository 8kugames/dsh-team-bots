// DSHBOTS-246：i18n 调用点守门——ui 内 t("字面量") 实参必须已在词典注册。
// 背景：既有结构守门（tests/i18n-split.test.ts）只查词典内部 zh/en 键集一致，不查调用点；
// DSHBOTS-241 关单后新增 UI 代码绕过守门引入字面量，英文环境回退中文原文并 console.warn。
// 本测试扫描 ui 源码（排除词典目录与 .js 产物），对「纯字面量实参」断言已注册；
// 动态键（t('prefix' + var)、t(`${prefix}${key}`)）不是字面量，跳过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import zh from '../ui/i18n/zh.js'

const UI = join(fileURLToPath(new URL('..', import.meta.url)), 'ui')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'i18n') continue
      out.push(...tsFiles(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out.sort()
}

// 捕获闭合引号后的下一个字符：是 ) 或 , → 纯字面量实参（必须注册）；是 + → 动态拼接（跳过）。
const CALL = /\bt\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*([),+]?)/g

test('i18n 调用点守门：ui 内 t() 纯字面量实参必须已注册（DSHBOTS-246）', () => {
  const missing: string[] = []
  for (const file of tsFiles(UI)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(CALL)) {
      const [, quote, key, tail] = match
      if (tail === '+') continue
      if (key.includes('${')) continue
      if (Object.prototype.hasOwnProperty.call(zh, key)) continue
      const line = source.slice(0, match.index).split('\n').length
      missing.push(`${file.slice(UI.length + 1)}:${line} ${JSON.stringify(key)}`)
    }
  }
  assert.deepEqual(missing, [], `t() 实参缺键（英文环境会回退中文）：\n${missing.join('\n')}`)
})
