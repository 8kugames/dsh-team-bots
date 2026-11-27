// tests/sidebar-bubbles.test.ts —— 用户需办入口按处理者分流守门。
// owner 口径：①「需要你处理」顶部条撤除——总监处理项（待验收/滞留卡）与运维项（投递失败/
// 通道异常）不在顶部弹；②用户干预项（提权审批/问答/进化审批）与总监 @owner 事项收敛为侧栏
// 群聊列表上方的常驻「收件箱」入口，点击进收件箱页统一处理，顶部审批/提问窄条随之撤除；
// ③设置变更历史卡撤除（当前无消费场景，audit 底账照记、只删读模型）。
// 前端用例沿用仓库先例：源码断言（app.ts/inbox.ts/settings.ts 单一来源）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('..', import.meta.url))
const appSource = readFileSync(join(here, 'ui', 'app.ts'), 'utf8')
const cardsSource = readFileSync(join(here, 'ui', 'modules', 'cards.ts'), 'utf8')
const settingsSource = readFileSync(join(here, 'ui', 'modules', 'settings.ts'), 'utf8')
const inboxSource = readFileSync(join(here, 'ui', 'modules', 'inbox.ts'), 'utf8')
const systemSource = readFileSync(join(here, 'src', 'services', 'system.ts'), 'utf8')

test('顶部 needs-attention 条撤除：banner 函数/挂载/显隐条件全链不在', () => {
  assert.doesNotMatch(cardsSource, /attentionBannerView|attention-banner/, 'cards.ts 标记块与导出撤除')
  assert.doesNotMatch(appSource, /attentionBannerView|needsAttention/, 'app.ts 挂载与消费撤除')
  assert.doesNotMatch(settingsSource, /attention-banner/, 'settings 页无残留')
})

test('收件箱入口：群聊列表上方常驻，徽标是四类待办之和，点击进收件箱页', () => {
  assert.match(inboxSource, /approvals: Number\(data\?\.pendingApprovals\?\.count \?\? 0\)/, '提权审批计数')
  assert.match(inboxSource, /questions: Number\(data\?\.pendingQuestions\?\.count \?\? 0\)/, '待回答提问计数')
  assert.match(inboxSource, /proposals: \(data\?\.proposals \?\? \[\]\)\.filter\(item => item\?\.status === 'pending'\)\.length/, '进化审批只计 pending')
  assert.match(inboxSource, /mentions: Number\(data\?\.pendingOwnerMentions\?\.count \?\? 0\)/, '总监 @owner 计未读')
  assert.match(inboxSource, /data-action="nav" data-view="inbox"/, '点击进收件箱页')
  // 入口在群聊列表之前（同一模板内先渲染），且常驻不随待办数隐现。
  const entryAt = appSource.indexOf('${inboxEntryView()}')
  const chatsAt = appSource.indexOf('data-tree="chats"')
  assert.ok(entryAt > 0 && chatsAt > entryAt, '入口在群聊列表上方')
  assert.doesNotMatch(inboxSource, /\.filter\(item => item\.count > 0\)/, '常驻：没有待办也保留入口')
  assert.match(appSource, /case 'inbox': return renderInbox\(\)/, 'render 路由 inbox')
  assert.match(appSource, /'secrets', 'inbox'\]/, '收件箱是全局一级视图')
  // 总监/运维项不进收件箱（分组只有四类）。
  assert.doesNotMatch(inboxSource, /'(stale|reviews|outbox|wechat)'/, '总监/运维项不进收件箱')
  // 旧提案红点撤除（收件箱徽标承担同一信号）。
  assert.doesNotMatch(appSource, /sidebar\.pendingProposals/, '总览bots 按钮上的旧红点撤除')
})

test('顶部审批/提问窄条撤除：收件箱是唯一入口，卡片组件保留给收件箱页复用', () => {
  const clickSource = readFileSync(join(here, 'ui', 'modules', 'events-click.ts'), 'utf8')
  assert.doesNotMatch(cardsSource, /approvalBannerView|questionBannerView|sidebarUserNeedsView/, 'cards.ts 窄条与气泡函数撤除')
  assert.doesNotMatch(appSource, /approvalBannerView|questionBannerView|sidebarUserNeedsView|approvalPanelOpen|questionPanelOpen/, 'app.ts 挂载与展开态撤除')
  assert.doesNotMatch(clickSource, /toggle-approvals|toggle-questions/, '点击分发撤除')
  assert.match(cardsSource, /export \{ renderMessage, renderDirectMessagesCard, toggleDesktopNotify, focusQuestionCard, focusApprovalCard, notifyInbox, ensureNotifyPermission, approvalCardMarkup, questionCardMarkup,/, '卡片组件导出给收件箱页')
  assert.match(clickSource, /case 'focus-approval':/, '收件箱里审批卡跳回会话的入口保留')
  assert.match(clickSource, /case 'focus-question':/, '收件箱里提问卡跳回会话的入口保留')
})

test('设置变更历史卡撤除：读模型/action/视图全链不在，audit 写入保留', () => {
  assert.doesNotMatch(settingsSource, /settingsHistory|renderSettingsHistoryCard|settingsKey\./, 'UI 卡与键撤除')
  assert.doesNotMatch(systemSource, /settingsHistory/, 'state 字段撤除')
  const apiSource = readFileSync(join(here, 'src', 'api.ts'), 'utf8')
  assert.doesNotMatch(apiSource, /settings_history/, 'api 动作撤除')
  // audit 底账照记（updateSettings/prompt_segment 审计写入保留）。
  const coreSource = readFileSync(join(here, 'src', 'services', 'core.ts'), 'utf8')
  assert.match(coreSource, /this\.audit\(actor, 'settings\.update'/, 'audit 写入保留（只删读模型）')
  assert.match(coreSource, /this\.audit\(actor, 'prompt_segment\.update'/, '段保存审计保留')
})

test('health() 的 needsAttention 保留（外部巡检口径，A5 patrol 依赖）', () => {
  assert.match(systemSource, /needsAttentionView\(\)/, '聚合方法保留')
  assert.match(systemSource, /needsAttention: this\.needsAttentionView\(\)/, 'health 下发保留')
  // state 不透出（UI 已不消费）。
  assert.doesNotMatch(systemSource, /needsAttention: this\.needsAttentionView\(\),\n      settings:/, 'state 不重复透出')
})
