// DSHBOTS-149：用量「对账 / 留存 / 导出」域的边界守卫。
// 与 tests/task-review-domain.test.js 同款手法——防双真值、防回退：这些函数只允许住在
// src/usage-reconcile.js，usage.js 不得再出现同名定义；同时把 800 行铁律钉在测试里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readSource = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const usageSource = readSource('../src/usage.js')
const reconcileSource = readSource('../src/usage-reconcile.js')

const RECONCILE_FUNCTIONS = [
  'toMillis',
  'setPrice',
  'monthUsageForProject',
  'monthUsageGlobal',
  'reconcileUsage',
  'applyRetention',
  'csvCell',
  'exportUsageCsv',
]

test('对账/留存/导出域唯一实现：函数定义住在 usage-reconcile.js', () => {
  for (const name of RECONCILE_FUNCTIONS) {
    assert.match(reconcileSource, new RegExp(`\\n(export )?function ${name}\\s*\\(`), `${name} 应在 usage-reconcile.js 有定义`)
    assert.doesNotMatch(usageSource, new RegExp(`\\n(export )?function ${name}\\s*\\(`), `usage.js 不得再定义 ${name}`)
  }
})

test('usageSnapshot 依赖的对账摘要留在 usage.js，避免与对账域循环依赖', () => {
  // usageSnapshot 直接调用 reconciliationSummary；把它留在 usage.js，两个模块之间才是单向依赖。
  assert.match(usageSource, /\nexport function reconciliationSummary\(store\) \{/, 'reconciliationSummary 应留在 usage.js')
  assert.doesNotMatch(reconcileSource, /\nexport function reconciliationSummary\(store\) \{/, 'usage-reconcile.js 不得重复定义 reconciliationSummary')
  assert.match(reconcileSource, /from '\.\/usage\.js'/, 'usage-reconcile.js 复用 usage.js 的聚合/窗口/过滤口径')
})

test('800 行铁律：本卡拆分涉及的模块均低于 800 行', () => {
  const LIMIT = 800
  const files = [
    '../src/services/runs.js',
    '../src/services/run-finish.js',
    '../src/services/tasks.js',
    '../src/services/task-review.js',
    '../src/usage.js',
    '../src/usage-reconcile.js',
  ]
  for (const path of files) {
    const lines = readSource(path).split('\n').length
    assert.ok(lines < LIMIT, `${path} 当前 ${lines} 行，超过 ${LIMIT} 行上限，需继续拆分`)
  }
})
