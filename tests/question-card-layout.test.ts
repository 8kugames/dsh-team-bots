// DSHBOTS-190：提问卡片样式对齐审批卡片（D-173 整行化 + D-180 右对齐）。
// 口径与 tests/approval-card-layout.test.js 对称：读线上同一份 CSS 汇总（tests/ui-styles-source.js），
// 断言「卡片占满消息行可用宽度」「提交按钮与 pill 贴右缘」两组规格；同时钉住不该跟着右对的行
// （倒计时行/进度条行保持左对齐）。改动全部为布局属性，不引用颜色变量，与明暗主题正交。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uiStylesSource } from './ui-styles-source.js'

const css = await uiStylesSource()

// 取某个选择器的规则块正文（与 approval-card-layout.test.js 同一份实现）。
const ruleBody = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `CSS 里找不到规则块：${selector}`)
  return match[1]
}

test('提问卡整行化：解除 480px 上限，占满消息行可用宽度（对齐审批卡 D-173）', () => {
  const card = ruleBody('.question-card')
  assert.doesNotMatch(card, /max-width:\s*480px/, '提问卡不得再停在 480px 小卡上限')
  assert.match(card, /max-width:\s*100%/, '提问卡上限放开为 100%（占满消息行）')
  // 压过基线 .message-body-wrap 的 max-width: min(640px, 82%) 与窄屏 88% 覆盖：
  // 单类选择器压不住排在其后的基线，必须双类选择器提特异性（与审批卡同手法）。
  const wide = ruleBody('.message-body-wrap.question-card')
  assert.match(wide, /width:\s*100%/, '整行宽度：width 100%')
  assert.match(wide, /max-width:\s*100%/, '整行宽度：max-width 100%（压过 .message-body-wrap 的 82%/88%）')
  assert.match(wide, /min-width:\s*min\(240px, 100%\)/, 'min-width 取 min(240px, 100%)，容器更窄时收缩不溢出')
})

test('提问按钮右对齐：.question-actions 提交按钮贴行右缘（对齐 D-173 审批按钮）', () => {
  const actions = ruleBody('.question-actions')
  assert.match(actions, /display:\s*flex/, '按钮行仍是 flex')
  assert.match(actions, /gap:\s*8px/, '按钮间距保持 8px')
  assert.match(actions, /justify-content:\s*flex-end/, '提交按钮右对齐')
})

test('提问 pill 行右对齐：.question-foot 已答徽章贴行右缘（对齐 D-180 审批 foot）', () => {
  const foot = ruleBody('.question-foot')
  assert.match(foot, /display:\s*flex/, 'pill 行仍是 flex')
  assert.match(foot, /justify-content:\s*flex-end/, '已答 pill 右对齐')
})

test('倒计时行与进度条行不随按钮行一起右对齐', () => {
  assert.doesNotMatch(ruleBody('.question-countdown'), /justify-content/, '倒计时行保持左对齐，不动')
  assert.doesNotMatch(ruleBody('.question-progress'), /justify-content/, '进度条行保持左对齐，不动')
})
