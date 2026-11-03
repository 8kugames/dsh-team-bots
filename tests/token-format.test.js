import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const utilSource = readFileSync(fileURLToPath(new URL('../ui/modules/util.js', import.meta.url)), 'utf8')
const appSource = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')

// 抽取 format-tokens 标记块：formatNumber 是无依赖纯函数，剥掉 export 后直接求值，做真行为断言。
const block = /\/\/ format-tokens:start[^\n]*\n([\s\S]*?)\/\/ format-tokens:end/.exec(utilSource)?.[1]
assert.ok(block, 'ui/modules/util.js 缺少 format-tokens 标记块（formatNumber）')
const formatNumber = new Function(`${block.replace('export ', '')}\nreturn formatNumber`)()

test('1e9 以上进 b 档：1354.4m 级别显示 1.35b，不再停在 m×1000（DSHBOTS-114）', () => {
  // 卡面示例「1354.4m → 1.32b」按卡面自定十进制档位（1e3→k、1e6→m、1e9→b）算术应为 1.35b：
  // 1_354_400_000 / 1e9 = 1.3544 → toFixed(2) = 1.35；得 1.32 只能走 1024 进位，与十进制档位口径矛盾，按十进制。
  assert.equal(formatNumber(1_354_400_000), '1.35b')
  assert.equal(formatNumber(1_000_000_000), '1.00b')
  assert.equal(formatNumber(13_200_000_000), '13.2b')
  assert.ok(!formatNumber(1_354_400_000).includes('m'), '1e9 以上不得再落在 m 档')
})

test('999k 不进位：不足 1e6 留在 k 档', () => {
  assert.equal(formatNumber(999_000), '999.0k')
  // 档位由原始值决定：k 档内四舍五入可能显示 1000.0k（既有行为，不因本卡改变）。
  assert.equal(formatNumber(999_999), '1000.0k')
})

test('1e12 档：规格只到 b（无 t 档），千亿级仍落在 b 档', () => {
  assert.equal(formatNumber(1_000_000_000_000), '1000.0b')
})

test('既有档位不回归：<1000 原样、k/m 档口径不变', () => {
  assert.equal(formatNumber(0), '0')
  assert.equal(formatNumber(732), '732')
  assert.equal(formatNumber(1_500), '1.50k')
  assert.equal(formatNumber(2_500_000), '2.50m')
  assert.equal(formatNumber(13_500_000), '13.5m')
  assert.equal(formatNumber(999_999_999), '1000.0m')
})

test('展示位统一：app.js 全部经 formatNumber、无独立 k/m 拼接；CSV 导出原始数据不经展示格式化', () => {
  assert.match(appSource, /import \{[^}]*formatNumber[^}]*\} from '\.\/modules\/util\.js'/)
  assert.doesNotMatch(appSource, /\}\s*[km]\b/, 'ui/app.js 不得出现绕开 formatNumber 的模板串 k/m 计数拼接')
  const usageSource = readFileSync(fileURLToPath(new URL('../src/usage.js', import.meta.url)), 'utf8')
  assert.ok(!usageSource.includes('formatNumber'), 'exportUsageCsv 必须直出原始 token 列，不经展示格式化')
})
