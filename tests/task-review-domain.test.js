// DSHBOTS-149：验收/退回与核验委派域的边界守卫。
// 与 tests/task-stage.test.js 同款手法——防双真值、防回退：这些方法只允许住在
// src/services/task-review.js，tasks.js 不得再出现同名方法定义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readSource = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const tasksSource = readSource('../src/services/tasks.js')
const reviewSource = readSource('../src/services/task-review.js')

const REVIEW_METHODS = [
  'reviewFromBot',
  'applyReview',
  'taskReviewDelegate',
  'taskUpdateScopes',
  'spawnReviewDelegate',
  'autoReviewDelegateEnabled',
]

test('验收/退回与核验委派域唯一实现：方法定义住在 task-review.js', () => {
  for (const name of REVIEW_METHODS) {
    assert.match(reviewSource, new RegExp(`\\n  (async )?${name}\\s*\\(`), `${name} 应在 task-review.js 有方法定义`)
    assert.doesNotMatch(tasksSource, new RegExp(`\\n  (async )?${name}\\s*\\(`), `tasks.js 不得再定义 ${name}`)
  }
})

test('task-review.js 只通过 this 调用任务域方法，不反向依赖 tasks.js 的模块内符号', () => {
  // 拆分后跨文件只能走原型方法（this.*），不得 import tasks.js 的内部常量/函数。
  assert.doesNotMatch(reviewSource, /from '\.\/tasks\.js'/)
  assert.doesNotMatch(reviewSource, /from '\.\.\/services\/tasks\.js'/)
})
