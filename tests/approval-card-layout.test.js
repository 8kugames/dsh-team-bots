// DSHBOTS-173：审批卡片整行化 + 审批按钮右对齐。
// 口径：读线上同一份 CSS 汇总（tests/ui-styles-source.js，与 readUiStyles 同函数同顺序），
// 断言「卡片占满消息行可用宽度」与「双按钮贴右」两条规格；同时钉住两处不该动的行
// （倒计时行/进度条行保持左对齐）与本卡范围外的东西（提问卡片仍是 480px 小卡）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uiStylesSource } from './ui-styles-source.js'

const css = await uiStylesSource()

// 取某个选择器的规则块正文（多条选择器同块时按逗号切第一条命中）。
const ruleBody = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `CSS 里找不到规则块：${selector}`)
  return match[1]
}

test('审批卡整行化：解除 480px 上限，占满消息行可用宽度', () => {
  const card = ruleBody('.approval-card')
  assert.doesNotMatch(card, /max-width:\s*480px/, '审批卡不得再停在 480px 小卡上限')
  assert.match(card, /max-width:\s*100%/, '审批卡上限放开为 100%（占满消息行）')
  // 压过基线 .message-body-wrap 的 max-width: min(640px, 82%) 与窄屏 88% 覆盖：
  // 那两条同为单类选择器且排在本文件之后，只能靠双类选择器提特异性压住。
  const wide = ruleBody('.message-body-wrap.approval-card')
  assert.match(wide, /width:\s*100%/, '整行宽度：width 100%')
  assert.match(wide, /max-width:\s*100%/, '整行宽度：max-width 100%（压过 .message-body-wrap 的 82%/88%）')
  // 窄屏不出横向滚动：min-width 不能把卡片顶出容器。
  assert.match(wide, /min-width:\s*min\(240px, 100%\)/, 'min-width 取 min(240px, 100%)，容器更窄时收缩不溢出')
})

test('审批按钮右对齐：.approval-actions 贴行右缘', () => {
  const actions = ruleBody('.approval-actions')
  assert.match(actions, /display:\s*flex/, '按钮行仍是 flex')
  assert.match(actions, /gap:\s*8px/, '按钮间距保持 8px')
  assert.match(actions, /justify-content:\s*flex-end/, '审批按钮右对齐')
})

test('倒计时行与进度条行不随按钮行一起右对齐', () => {
  assert.doesNotMatch(ruleBody('.approval-countdown'), /justify-content/, '倒计时行保持左对齐，不动')
  assert.doesNotMatch(ruleBody('.approval-progress'), /justify-content/, '进度条行保持左对齐，不动')
})

test('本卡只动审批卡：提问卡片仍是 480px 小卡', () => {
  const question = ruleBody('.question-card')
  assert.match(question, /max-width:\s*480px/, '提问卡片不在本卡范围，保持原宽度上限')
})
