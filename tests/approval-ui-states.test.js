// DSHBOTS-108：审批卡片视觉规格 V2——五态（pending/allowed/rejected/timeout/cancelled）。
// 前端用例沿用仓库两条先例：读源断言（tests/helpers/ui-sources.js）+ 标记块 new Function 执行
// （tests/desktop-notify.test.js）。执行的是真实源码，不是把实现复制一份到测试里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { readUiSource } from './helpers/ui-sources.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const uiSource = readUiSource()
const stylesSource = readFileSync(join(root, 'ui', 'styles.css'), 'utf8')
const utilSource = readFileSync(join(root, 'ui', 'modules', 'util.js'), 'utf8')

const markerBlock = (name) => {
  const match = uiSource.match(new RegExp(`// ===== ${name}:start[\\s\\S]*?// ===== ${name}:end =====`))
  assert.ok(match, `${name} 标记块必须存在`)
  return match[0]
}

// 沙箱依赖：formatTime 取 util.js 真实实现（与前端同一份时区格式化），
// esc/attr/icon 用与前端同口径的最小桩。
const formatTimeSource = utilSource.match(/export function formatTime\(value\) \{[\s\S]*?\n\}/)[0].replace(/^export /, '')
const formatTime = new Function(`${formatTimeSource}\nreturn formatTime`)()
const iconStub = (name, cls = '') => `<svg class="${cls}" data-icon="${name}"></svg>`
const escStub = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const v2 = new Function('icon', 'esc', 'attr', 'formatTime', `${formatTimeSource}
${markerBlock('approval-ux')}
${markerBlock('approval-v2')}
return {
  APPROVAL_STATUS,
  APPROVAL_STATE_ICON,
  approvalCardMarkup,
  approvalIcon,
  formatApprovalCountdown,
  approvalProgressRatio,
  approvalPath,
}`)(iconStub, escStub, escStub, formatTime)

const baseApproval = {
  id: 'ap-1',
  botName: 'artist',
  tool_name: 'bash',
  status: 'pending',
  created_at: '2026-11-03T11:00:00.000Z',
  expires_at: '2026-11-03T11:10:00.000Z',
  remainingMs: 598_000,
  display_reason: '需要写入 /Users/silesjian/Desktop/Tools/DSHBots/ui/app.js 的审批卡片实现',
}

const markupOf = (status, extra = {}) => v2.approvalCardMarkup({
  ...baseApproval,
  status,
  ...extra,
})

test('五态状态类名：图标徽章与 pill 各有稳定的状态类', () => {
  const cases = [
    ['pending', 'is-pending', null],
    ['allowed', 'is-allowed', 'is-allowed'],
    ['rejected', 'is-rejected', 'is-rejected'],
    ['timeout', 'is-timeout', 'is-muted'],
    ['cancelled', 'is-cancelled', 'is-muted'],
  ]
  for (const [status, iconClass, pillClass] of cases) {
    const html = markupOf(status, { decided_at: status === 'pending' ? null : '2026-11-03T11:01:00.000Z' })
    assert.match(html, new RegExp(`class="approval-icon ${iconClass}"`), `${status} 图标类名`)
    if (pillClass) assert.match(html, new RegExp(`class="approval-pill ${pillClass}"`), `${status} pill 类名`)
    else assert.doesNotMatch(html, /approval-pill/, 'pending 不出 pill')
    assert.match(html, /data-approval-status="\$\{attr\(approval\.status\)\}"|data-approval-status=/, '状态仍挂在卡片根节点')
  }
  // 图标语义映射：pending 盾牌、allowed 对勾、rejected 叉、timeout 时钟、cancelled 禁止。
  assert.deepEqual(v2.APPROVAL_STATE_ICON, {
    pending: 'shield', allowed: 'check', rejected: 'close', timeout: 'clock', cancelled: 'ban',
  })
  // shield / ban 不在既有图标表里 → 走 approval-v2 块内联路径；check / clock 走图标表。
  assert.match(v2.approvalIcon('shield'), /class="approval-glyph"/, 'shield 内联路径')
  assert.match(v2.approvalIcon('ban'), /class="approval-glyph"/, 'ban 内联路径')
  assert.match(v2.approvalIcon('check'), /data-icon="check"/, 'check 走图标表')
})

test('pending 文案：倒计时、进度条、双按钮、角色名加粗 + 请求提权', () => {
  const html = markupOf('pending')
  assert.match(html, /剩余 9 分 58 秒/, '倒计时口径「剩余 X 分 Y 秒」')
  assert.match(html, /class="approval-clock"/, '倒计时挂 .approval-clock')
  assert.match(html, /class="approval-progress"/, '横向进度条')
  assert.match(html, /style="width:100%"/, '剩余比例写进进度条宽度')
  assert.match(html, /data-decision="allow"/, '允许一次按钮')
  assert.match(html, /data-decision="reject"/, '拒绝按钮')
  assert.match(html, />允许一次</, '按钮文案「允许一次」')
  assert.match(html, />拒绝</, '按钮文案「拒绝」')
  assert.match(html, /<strong>artist<\/strong><span class="approval-ask">请求提权<\/span>/, '角色名加粗 + 请求提权灰字')
  assert.match(html, /class="approval-chip mono">bash</, '工具名等宽 chip')
  assert.match(html, /class="approval-chip mono approval-chip-path"[^>]*>\/Users\/silesjian\/Desktop\/Tools\/DSHBots\/ui\/app\.js</, '路径等宽 chip')
  // 卡片根节点类名保持不变（tests/desktop-notify.test.js 依赖该串），状态类只落在内层。
  assert.match(html, /class="message-body-wrap approval-card"/)
  assert.doesNotMatch(html, /approval-card is-/)
})

test('已决四态：无倒计时无按钮，正文走已决排版', () => {
  for (const status of ['allowed', 'rejected', 'timeout', 'cancelled']) {
    const html = markupOf(status, { decided_at: '2026-11-03T11:01:00.000Z' })
    assert.doesNotMatch(html, /approval-countdown/, `${status} 无倒计时`)
    assert.doesNotMatch(html, /approval-progress/, `${status} 无进度条`)
    assert.doesNotMatch(html, /data-action="approval-decide"/, `${status} 无按钮`)
    assert.match(html, /class="approval-summary">/, `${status} 保留正文段`)
    assert.match(html, /需要写入 \/Users\/silesjian/, `${status} 保留摘要文案`)
  }
})

test('已决 pill 文案：allowed 带时间戳，其余三态只出标签', () => {
  const allowed = markupOf('allowed', { decided_at: '2026-11-03T11:01:00.000Z' })
  assert.match(allowed, /已允许一次 \d{2}\/\d{2} \d{2}:\d{2}/, 'allowed pill 带 MM/DD HH:MM')
  assert.match(markupOf('rejected', { decided_at: '2026-11-03T11:01:00.000Z' }), /<span class="approval-pill is-rejected"[^>]*>已拒绝<\/span>/)
  assert.match(markupOf('timeout', { decided_at: '2026-11-03T11:01:00.000Z' }), /<span class="approval-pill is-muted"[^>]*>已超时<\/span>/)
  assert.match(markupOf('cancelled', { decided_at: '2026-11-03T11:01:00.000Z' }), /<span class="approval-pill is-muted"[^>]*>已取消<\/span>/)
  // 状态标签表与既有文案一致。
  assert.deepEqual(v2.APPROVAL_STATUS, {
    pending: '等待审批', allowed: '已允许一次', rejected: '已拒绝', timeout: '已超时', cancelled: '已取消',
  })
})

test('倒计时与进度条口径：剩余越多条越长，临期转短', () => {
  assert.equal(v2.formatApprovalCountdown(598_000), '剩余 9 分 58 秒')
  assert.equal(v2.formatApprovalCountdown(60_000), '剩余 1 分 0 秒')
  assert.equal(v2.formatApprovalCountdown(42_000), '剩余 42 秒')
  assert.equal(v2.formatApprovalCountdown(0), '剩余 0 秒')
  assert.equal(v2.formatApprovalCountdown(-5), '剩余 0 秒')
  assert.equal(v2.approvalProgressRatio(300_000, 600_000), 0.5)
  assert.equal(v2.approvalProgressRatio(598_000, 600_000), 598_000 / 600_000)
  assert.equal(v2.approvalProgressRatio(700_000, 600_000), 1, '夹在 0–1')
  assert.equal(v2.approvalProgressRatio(-5, 600_000), 0)
  assert.equal(v2.approvalProgressRatio(300_000, 0), 0, '窗口长度缺失时不画进度')
  // 路径 chip：绝对路径与带扩展名的相对路径都能取到，纯词取不到。
  assert.equal(v2.approvalPath('改 /Users/x/y/app.js 的第 3 行'), '/Users/x/y/app.js')
  assert.equal(v2.approvalPath('改 ui/app.js'), 'ui/app.js')
  assert.equal(v2.approvalPath('读文件'), '')
})

test('CSS：五态左侧条与底色按规格取既有 token，未新增色值', () => {
  const css = stylesSource
  assert.match(css, /\.approval-card\[data-approval-status='pending'\] \{ background: color-mix\(in srgb, var\(--accent\) 5%, var\(--surface\)\); \}/, 'pending 卡片底 = accent 5% 混入 surface')
  assert.match(css, /\.approval-card\[data-approval-status='allowed'\] \{ border-left-color: var\(--green\); \}/)
  assert.match(css, /\.approval-card\[data-approval-status='rejected'\] \{ border-left-color: var\(--danger\); \}/)
  assert.match(css, /\.approval-card\[data-approval-status='timeout'\],\s*\.approval-card\[data-approval-status='cancelled'\] \{ border-left-color: var\(--ink-3\); \}/)
  assert.match(css, /\.approval-icon\.is-pending \{ background: var\(--accent-wash\); color: var\(--accent-text\); \}/)
  assert.match(css, /\.approval-icon\.is-allowed \{ background: var\(--green-wash\); color: var\(--green\); \}/)
  assert.match(css, /\.approval-icon\.is-rejected,\s*\.approval-icon\.is-timeout,\s*\.approval-icon\.is-cancelled \{ background: var\(--surface-2\); color: var\(--ink-3\); \}/)
  assert.match(css, /\.approval-pill\.is-allowed::before \{ background: var\(--green\); \}/)
  assert.match(css, /\.approval-pill\.is-rejected::before \{ background: var\(--danger\); \}/)
  assert.match(css, /\.approval-pill\.is-muted::before \{ background: var\(--ink-3\); \}/)
  // 正文：pending --ink，已决 --ink-2。
  assert.match(css, /\.approval-summary \{[^}]*color: var\(--ink-2\)/)
  assert.match(css, /\.approval-card\[data-approval-status='pending'\] \.approval-summary \{ color: var\(--ink\); \}/)
  // 圆角 12 / 6 / 7。
  assert.match(css, /\.approval-card \{[^}]*border-radius: 12px/)
  assert.match(css, /\.approval-icon \{[^}]*border-radius: 6px/)
  assert.match(css, /\.approval-chip \{[^}]*border-radius: 7px/)
  // 字号 15 / 13 / 12。
  assert.match(css, /\.approval-summary \{[^}]*font-size: var\(--fs-body\)/)
  assert.match(css, /\.approval-meta \{[^}]*font-size: var\(--fs-small\)/)
  assert.match(css, /\.approval-chip \{[^}]*font-size: var\(--fs-caption\)/)
  // 审批卡相关段落不得出现字面色值（规格硬约束：只用仓库既有 token）。
  const section = css.slice(css.indexOf('/* 审批卡片'), css.indexOf('/* 跨项目待审入口'))
  assert.ok(section.length > 0, '必须能定位到审批卡 CSS 段')
  assert.doesNotMatch(section, /#[0-9a-f]{3,8}\b/i, '审批卡段不得写死色值')
  assert.doesNotMatch(section, /rgba?\(/i, '审批卡段不得写死 rgba')
})

test('CSS：消息流与通知容器的 img/svg 有尺寸兜底，大图标不占满视口', () => {
  const css = stylesSource
  // 通知容器（toast、待审横幅）：图标与图片都限宽限高，图片保持比例。
  assert.match(css, /:is\(#toast-root, \.toast, \.approval-banner\) svg \{[^}]*max-width: 24px;[^}]*max-height: 24px;/, '通知容器 svg 限宽限高')
  assert.match(css, /:is\(#toast-root, \.toast, \.approval-banner\) img \{[^}]*max-width: 100%;[^}]*max-height: 120px;[^}]*object-fit: contain;/, '通知容器 img 限高 + 保持比例')
  // 消息流：既有 .message-bubble img 规则只管图片，svg 必须另有限高。
  assert.match(css, /:is\(\.message-bubble, \.comment-body, \.message-system\) svg \{[^}]*max-width: 120px;[^}]*max-height: 120px;/, '消息流 svg 限宽限高')
  // 审批卡：新增的面同样兜底。
  assert.match(css, /\.approval-card img \{[^}]*max-width: 100%;[^}]*max-height: 320px;[^}]*object-fit: contain;/, '审批卡 img 限高 + 保持比例')
  assert.match(css, /\.approval-card svg \{[^}]*max-width: 64px;[^}]*max-height: 64px;/, '审批卡 svg 限宽限高')
  // 不许把既有正文图片规则放宽（既有是 max-width: min(100%, 340px)）。
  assert.match(css, /:is\(\.message-bubble, \.comment-body\) img \{[^}]*max-width: min\(100%, 340px\);/, '既有正文图片上限保持不变')
})

test('密钥删除确认文案：不再指向 .team/secrets.env 原路径', () => {
  // DSHBOTS-106 起明文只一次性物化到数据目录，项目工作区不再有明文密钥文件。
  const branch = uiSource.match(/case 'delete-secret': \{[\s\S]*?\n      \}/)?.[0] ?? ''
  assert.ok(branch, '必须能定位 delete-secret 处理分支')
  assert.doesNotMatch(branch, /\.team\/secrets\.env/, '删除确认不再提 .team/secrets.env 原路径')
  assert.match(branch, /删除密钥 \$\{name\}？/, '删除确认保留密钥名')
  assert.match(branch, /一次性运行时副本[^`]*失效/, '删除确认改为说明一次性运行时副本失效')
})
