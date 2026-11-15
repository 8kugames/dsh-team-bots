// tests/sidebar-bubbles.test.ts —— DSHBOTS-339：用户需办气泡 + 顶部条按处理者分流守门。
// owner 口径：①「需要你处理」顶部条撤除——总监处理项（待验收/滞留卡）与运维项（投递失败/
// 通道异常）不在顶部弹；②用户干预项（问答/提权审批/进化审批）收敛为侧栏「总览bots」上方
// 气泡，全 0 不渲染（Quiet by default），点击复用顶部审批/提问窄条展开与进化页导航；
// ③设置变更历史卡撤除（当前无消费场景，audit 底账照记、只删读模型）。
// 前端用例沿用仓库先例：源码断言（app.ts/settings.ts 单一来源）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('..', import.meta.url))
const appSource = readFileSync(join(here, 'ui', 'app.ts'), 'utf8')
const cardsSource = readFileSync(join(here, 'ui', 'modules', 'cards.ts'), 'utf8')
const settingsSource = readFileSync(join(here, 'ui', 'modules', 'settings.ts'), 'utf8')
const systemSource = readFileSync(join(here, 'src', 'services', 'system.ts'), 'utf8')

test('顶部 needs-attention 条撤除：banner 函数/挂载/显隐条件全链不在', () => {
  assert.doesNotMatch(cardsSource, /attentionBannerView|attention-banner/, 'cards.ts 标记块与导出撤除')
  assert.doesNotMatch(appSource, /attentionBannerView|needsAttention/, 'app.ts 挂载与消费撤除')
  assert.doesNotMatch(settingsSource, /attention-banner/, 'settings 页无残留')
})

test('侧栏气泡：三类用户干预项计数 + 点击复用既有通道 + 总览bots 上方', () => {
  assert.match(cardsSource, /sidebar\.bubbleApprovals[\s\S]*?toggle-approvals/, '提权审批气泡 → 顶部审批窄条展开')
  assert.match(cardsSource, /sidebar\.bubbleQuestions[\s\S]*?toggle-questions/, '问答气泡 → 顶部提问窄条展开')
  assert.match(cardsSource, /sidebar\.bubbleProposals[\s\S]*?data-view="evolution"/, '进化审批气泡 → 进化页')
  assert.match(cardsSource, /\.filter\(item => item\.count > 0\)/, 'Quiet by default：全 0 不渲染')
  assert.match(appSource, /sidebarUserNeedsView\(\{ approvals: pendingApprovals\.count, questions: pendingQuestions\.count, proposals: pendingProposals\(\) \}\)/, 'app.ts 挂气泡助手')
  // 气泡块必须位于「总览bots」按钮之前（同一模板内先渲染）。
  const bubblesAt = appSource.indexOf('sidebarUserNeedsView')
  const botsAt = appSource.indexOf('data-view="bots-overview"')
  assert.ok(bubblesAt > 0 && botsAt > bubblesAt, '气泡在总览bots 上方')
  // 总监/运维项不再出现在气泡（气泡数组只有三类）。
  assert.doesNotMatch(cardsSource, /bubble(?:Stale|Reviews|Outbox|Wechat)/, '总监/运维项不进气泡')
  // 旧提案红点撤除（气泡承担同一信号）。
  assert.doesNotMatch(appSource, /sidebar\.pendingProposals/, '总览bots 按钮上的旧红点撤除')
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
  // state 不再透出（UI 已不消费）。
  assert.doesNotMatch(systemSource, /needsAttention: this\.needsAttentionView\(\),\n      settings:/, 'state 不重复透出')
})
