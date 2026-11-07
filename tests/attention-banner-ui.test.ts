// tests/attention-banner-ui.test.ts —— A2/DSHBOTS-322：needs-attention 顶部收口 UI 守门。
// 前端用例沿用仓库先例：读源断言（tests/helpers/ui-sources.js）+ 标记块 new Function 执行
// （执行的是真实源码）。守门三点：① Quiet by default——计数全 0/缺数据时整条返回空串；
// ② 有待办/系统问题时按类渲染 chips 且跳转视图正确；③ app.ts 已挂载（漏挂即整条不可见）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'

const uiSource = readUiSource()

const markerBlock = (name) => {
  const match = uiSource.match(new RegExp(`// ===== ${name}:start[\\s\\S]*?// ===== ${name}:end =====`))
  assert.ok(match, `${name} 标记块必须存在`)
  return match[0]
}

// 沙箱依赖：t 原样返回键（断言以键文本命中），esc 原样返回；approvalBadgeText 取 cards.js
// 真实实现（与前端同一份 99+ 封顶逻辑）。
const badgeSource = uiSource.match(/const approvalBadgeText = \(count\) => [^\n]+/)[0]
const build = () => new Function('t', 'esc', `${badgeSource}
${markerBlock('attention-banner')}
return { attentionBannerView, attentionBannerChips }`)(
  (key) => String(key),
  (value) => String(value ?? ''),
)

test('Quiet by default：空聚合/缺数据返回空串', () => {
  const { attentionBannerView } = build()
  assert.equal(attentionBannerView(undefined), '')
  assert.equal(attentionBannerView({}), '')
  assert.equal(attentionBannerView({ needsYou: { approvals: 0, questions: 0, reviews: 0, stale: 0 }, issues: [] }), '')
})

test('有待办/系统问题时按类渲染 chips 并跳转对应视图', () => {
  const { attentionBannerView } = build()
  const html = attentionBannerView({
    needsYou: { approvals: 2, questions: 1, reviews: 3, stale: 1 },
    issues: [
      { kind: 'outbox_failed', count: 4, since: '2026-11-07T00:00:00.000Z' },
      { kind: 'wechat_channel', phase: 'needs_reauth', message: null },
    ],
  })
  // 待验收/滞留卡 → 任务板；投递失败 → 全局设置页；通道异常 → 通道页。
  assert.match(html, /data-action="nav" data-view="tasks"/)
  assert.match(html, /data-action="nav" data-view="global"/)
  assert.match(html, /data-action="nav" data-view="channel"/)
  assert.match(html, /待验收/)
  assert.match(html, /滞留卡/)
  assert.match(html, /投递失败/)
  assert.match(html, /通道异常/)
  assert.match(html, /需要你处理/)
  assert.match(html, />3</) // 待验收计数
  assert.match(html, /99\+|>4</) // 投递失败计数
  // 反双真值：待审/待答已有专属窄条，本条不渲染这两类。
  assert.doesNotMatch(html, /待处理审批|待回答提问/)
})

test('app.ts 已挂载 attentionBannerView 并纳入 main-head 显隐条件', () => {
  assert.match(uiSource, /attentionBannerView\(needsAttention\)/)
  assert.match(uiSource, /showMainHead = [^]*attentionBannerView\(needsAttention\) !== ''/)
})
