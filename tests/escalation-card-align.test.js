// DSHBOTS-180：提权请求卡（审批卡骨架，cards.js .approval-ask「请求提权」）结果 badge 右对齐，
// 对齐 D-173 审批卡按钮行口径。口径：读线上同一份 CSS 汇总（tests/ui-styles-source.js，
// 与 readUiStyles 同函数同顺序）；范围外保护：badge 自身规则不被顺带动。
// DSHBOTS-190 起提问卡页脚已右对齐（口径移交 tests/question-card-layout.test.js 锁定）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { uiStylesSource } from './ui-styles-source.js'

const css = await uiStylesSource()
const cardsSource = readFileSync(new URL('../ui/modules/cards.js', import.meta.url), 'utf8')

// 取某个选择器的规则块正文（与 tests/approval-card-layout.test.js 同规则，多条选择器同块按第一条命中）。
const ruleBody = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `CSS 里找不到规则块：${selector}`)
  return match[1]
}

test('提权请求卡按钮行右对齐保留：.approval-actions 贴行右缘（D-173 先例不回退）', () => {
  const actions = ruleBody('.approval-actions')
  assert.match(actions, /display:\s*flex/, '按钮行仍是 flex')
  assert.match(actions, /gap:\s*8px/, '按钮间距保持 8px')
  assert.match(actions, /justify-content:\s*flex-end/, '按钮行右对齐保留')
})

test('结果 badge 行右对齐：.approval-foot 贴行右缘，只动对齐不动其余', () => {
  const foot = ruleBody('.approval-foot')
  assert.match(foot, /display:\s*flex/, 'badge 行仍是 flex')
  assert.match(foot, /align-items:\s*center/, '垂直居中保持')
  assert.match(foot, /gap:\s*8px/, '子项间距保持 8px')
  assert.match(foot, /justify-content:\s*flex-end/, 'badge 行右对齐（本卡新增）')
})

test('骨架前提：badge 与按钮行互斥渲染，badge 是已决态单独一行（cards.js 取证）', () => {
  // pending 渲染 .approval-actions（双按钮），已决四态渲染 .approval-foot（状态 pill）——
  // badge 单独行右端即 .approval-foot 行右端，与按钮行同排口径无需合并容器。
  assert.match(cardsSource, /<div class="approval-actions">/, 'pending 态按钮行容器存在')
  assert.match(cardsSource, /<div class="approval-foot"><span class="approval-pill /, '已决态 badge 行容器存在且 pill 为其唯一子项')
  assert.match(cardsSource, /<\/div>`\s*\n\s*:\s*`<div class="approval-foot">/, 'foot 是 pending 三元的 else 支：badge 与按钮行互斥渲染，badge 单独行右端')
})

test('范围外不受影响：badge 自身规则保持原样', () => {
  // 提问卡页脚自 DSHBOTS-190 起右对齐（与审批卡口径对齐），由 question-card-layout.test.js 锁定。
  assert.doesNotMatch(ruleBody('.approval-pill'), /justify-content/, 'badge 自身是 inline-flex 内容标签，不承担行对齐')
})
