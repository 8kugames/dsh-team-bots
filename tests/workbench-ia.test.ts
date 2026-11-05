import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'

// DSHBOTS-5 工作台信息架构改造：读源码断言（与 terminal-ui.test.js 同模式）。
const source = readUiSource()
// NAV/SOLO_NAV 已拆到 modules/state.js（DSHBOTS-15），从模块源码读取。
const stateSource = readFileSync(fileURLToPath(new URL('../ui/modules/state.js', import.meta.url)), 'utf8')

const NAV = /const NAV = \[([\s\S]*?)\n\]/.exec(stateSource)?.[1] ?? ''
const SOLO_NAV = /const SOLO_NAV = \[([\s\S]*?)\n\]/.exec(stateSource)?.[1] ?? ''

// ① 项目导航：bots 改「成员」members，群聊侧栏「项目成员」面板移除，设置页成员 checkbox 移除。
test('① 项目导航 bots → members 成员 tab', () => {
  assert.match(NAV, /\['members', 'users'\]/, 'NAV 应有成员 tab')
  assert.ok(!/\['bots',/.test(NAV), 'NAV 不应再有 bots tab')
  assert.match(source, /case 'members':\s*\n?\s*return renderMembers\(\)/, 'render 路由 case members → renderMembers')
  assert.match(source, /function renderMembers\(\)/, 'renderMembers 函数存在')
})

test('① 成员 tab：邀请走弹窗选人 + 移除动作 + busy 徽标 + 用量合计', () => {
  assert.ok(!source.includes('id="invite-bot"'), '不再有邀请下拉 select#invite-bot（DSHBOTS-50 改为弹窗选人）')
  assert.match(source, /data-action="open-invite-member"/, '邀请按钮 open-invite-member（打开选人弹窗）')
  assert.match(source, /data-action="remove-member"/, '移除按钮 remove-member')
  assert.match(source, /member\.member_role === 'owner' \|\| member\.id === project\.owner_bot_id[\s\S]*?<span class="pill violet">\$\{t\("总监"\)\}<\/span>/, '总监行 violet pill')
  assert.match(source, /member\.busy \? t\("任务中"\) : t\("空闲中"\)/, '任务中/空闲中徽标')
  assert.match(source, /formatCost\(Number\(member\.usage_cost \?\? 0\)\)/, 'cost 合计用 formatCost')
})

test('① 群聊侧栏与设置页的项目成员面板已移除', () => {
  const chatSide = [...source.matchAll(/<aside class="chat-side">([\s\S]*?)<\/aside>/g)]
    .map(m => m[1])
    .find(block => block.includes("t('card.activeTasks')"))
  assert.ok(chatSide, '找不到群聊右栏')
  assert.ok(!chatSide.includes("<h3>${t('card.projectMembers')}</h3>"), '群聊右栏不再有项目成员卡')
  // 设置表单：成员 checkbox 与全量提交一并移除，防空数组清空成员（新建项目弹窗保留全量语义，不在此列）
  const settingsForm = /<form id="project-settings-form"[\s\S]*?<\/form>/.exec(source)?.[0] ?? ''
  assert.ok(settingsForm, '找不到设置表单')
  assert.ok(!settingsForm.includes('memberIds'), '设置表单不再有成员 checkbox')
  const saveProject = /if \(type === 'save-project'\) \{[\s\S]*?\n {6}\}/.exec(source)?.[0] ?? ''
  assert.ok(saveProject && !saveProject.includes('memberIds'), 'save-project 不再提交 memberIds（增量 add/remove_member 替代）')
})

// ② 总览bots 挂侧栏全局配置上方、进化从项目 NAV 移除、记忆随上下文收敛。
test('② 项目 NAV 无进化；单聊 NAV 保留进化', () => {
  assert.ok(!/\['evolution',/.test(NAV), '项目 NAV 不应再有进化 tab')
  assert.match(SOLO_NAV, /\['evolution', 'branch'\]/, '单聊 NAV 保留进化（逐个审批）')
})

test('② 侧栏「总览bots」入口在全局配置上方，带待审红点', () => {
  const idxOverview = source.indexOf('data-view="bots-overview"')
  const idxGlobal = source.indexOf("<span>${t('sidebar.globalConfig')}</span>")
  assert.ok(idxOverview >= 0, '侧栏应有总览bots按钮')
  assert.ok(idxGlobal >= 0 && idxOverview < idxGlobal, '总览bots在全局配置上方')
  assert.match(source, /case 'bots-overview': return renderBotsOverview\(\)/, 'render 路由 bots-overview')
  assert.match(source, /pendingProposals\(\) > 0 \? `<span class="red-dot"/, '有待审提案时红点')
  assert.match(source, /case 'batch-decide-proposals':/, '批量审批 handler 存在')
})

test('② 单聊进化只显示该 bot 提案', () => {
  assert.match(source, /inSoloContext\(\) \? proposals\.filter\(item => item\.bot_id === state\.soloBotId\) : proposals/, '单聊按 bot_id 过滤')
})

test('② 记忆随上下文收敛：无作用域筛选、无团队记忆', () => {
  assert.ok(!source.includes('id="memory-filter"'), '记忆页不再有作用域筛选下拉')
  assert.ok(!/value="team"[^>]*>团队记忆/.test(source), '不再有「团队记忆」选项')
  assert.ok(!source.includes("'团队记忆'"), '不再有团队记忆标题字面量')
  assert.ok(!source.includes('memoryFilter'), 'memoryFilter 状态与监听一并移除')
  const memoryFn = /function renderMemory\(\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? ''
  assert.match(memoryFn, /const memories = state\.data\?\.memories \?\? \[\]/, '直接使用服务端按上下文收敛后的列表')
})

test('② system.js：记忆查询按上下文收敛、提案全量', () => {
  const sysSource = readFileSync(fileURLToPath(new URL('../src/services/system.js', import.meta.url)), 'utf8')
  const projectCtx = /if \(project\) \{[\s\S]*?\n {4}\}/.exec(sysSource)?.[0] ?? ''
  assert.ok(projectCtx, '找不到项目上下文块')
  assert.ok(!projectCtx.includes("scope_type = 'team'"), '项目上下文记忆不再并入团队 scope')
  assert.ok(!projectCtx.includes('botFilter'), '项目上下文记忆不再并入成员 bot scope')
  assert.match(projectCtx, /SELECT \* FROM proposals ORDER BY created_at DESC LIMIT 100/, '项目上下文提案改为全量')
  const soloCtx = /if \(soloBot\) \{[\s\S]*?\n {6}\}/.exec(sysSource)?.[0] ?? ''
  assert.ok(soloCtx, '找不到单聊上下文块')
  assert.ok(!soloCtx.includes("scope_type = 'team'"), '单聊记忆不再并入团队 scope')
  assert.match(soloCtx, /scope_type = 'bot' AND scope_id = \?/, '单聊记忆仅该 bot scope')
})

// DSHBOTS-77 定下侧栏状态行「全局口径、不随上下文跳变」；DSHBOTS-105 把计数从 activeRuns（一切运行）
// 切到 activeTasks（任务 in_progress），单聊头部等其余「运行中」文案不在此列。
test('DSHBOTS-105 侧栏状态行读全局 activeTasks，不随上下文分支', () => {
  const shell = /function renderShell\(\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? ''
  assert.ok(shell, '找不到 renderShell')
  assert.match(shell, /const activeTasks = Number\(data\?\.activeTasks \?\? 0\)/, '状态行任务数读全局字段 activeTasks，无上下文分支')
  assert.ok(!shell.includes('soloRuns'), 'renderShell 不再按单聊/群聊分别数运行')
  assert.match(shell, /class="dot \$\{activeTasks \? 'amber' : ''\}"/, '状态点判空与文案读同一全局变量')
  assert.match(shell, /\$\{activeTasks \? t\('sidebar\.tasksActive', \{ count: activeTasks \}\) : t\('sidebar\.idle'\)\}/, '状态行文案用任务口径')
  assert.match(shell, /const projectRunning = project\?\.stats\?\.running \?\? 0/, 'topbar 运行数拆回项目口径')
  assert.match(shell, /<b>\$\{projectRunning\}<\/b> \$\{projectRunning === 1/, 'topbar-meta 读项目口径变量')
})

// DSHBOTS-105 后端：state 顶层新增 activeTasks（tasks 表 in_progress 计数），activeRuns 原样保留。
test('DSHBOTS-105 state 顶层输出 activeTasks 任务计数，activeRuns 保留', () => {
  const sysSource = readFileSync(fileURLToPath(new URL('../src/services/system.js', import.meta.url)), 'utf8')
  const stateFn = /async state\(projectId, soloBotId = null\) \{[\s\S]*?\n {2}\},/.exec(sysSource)?.[0] ?? ''
  assert.ok(stateFn, '找不到 system.js state()')
  assert.match(stateFn, /activeRuns: Number\(this\.store\.get\("SELECT COUNT\(\*\) AS count FROM runs WHERE status IN \('queued', 'running'\)"\)\?\.count \?\? 0\)/, 'activeRuns 全库活跃运行计数保留')
  assert.match(stateFn, /activeTasks: Number\(this\.store\.get\("SELECT COUNT\(\*\) AS count FROM tasks WHERE status = 'in_progress'"\)\?\.count \?\? 0\)/, 'activeTasks 为 tasks 表 in_progress 计数')
})

// DSHBOTS-223 待审批提案逐条审批：每条提案可展开看完整内容（rationale/payload/evaluation），
// 各自带 通过/拒绝 按钮（复用既有 decide-proposal 动作），与「全部通过并应用 / 全部拒绝」批量入口并存。
test('DSHBOTS-223 待审批提案逐条展开 + 单条通过/拒绝 + 批量入口并存', () => {
  const overviewFn = /function renderBotsOverview\(\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? ''
  assert.ok(overviewFn, '找不到 renderBotsOverview')
  assert.match(overviewFn, /<details class="proposal-item"\$\{panelAttrs\(state, `proposal-row:\$\{item\.id\}`\)\}>/, '每条提案为可展开 details，展开态走 panelAttrs 通道')
  assert.match(overviewFn, /summary class="list-row"/, '折叠头复用 list-row 版式')
  assert.match(overviewFn, /item\.rationale \? `<div class="list-desc">\$\{esc\(item\.rationale\)\}<\/div>`/, '展开体含 rationale')
  assert.match(overviewFn, /proposalPreview\(item\)/, '展开体含 payload 完整内容（instructions 等）')
  assert.match(overviewFn, /item\.evaluation \? [\s\S]*?evaluationText\(item\.evaluation\)/, '展开体含 evaluation')
  assert.match(overviewFn, /data-action="decide-proposal" data-proposal-id="\$\{attr\(item\.id\)\}" data-decision="approved"/, '单条通过按钮（逐条）')
  assert.match(overviewFn, /data-action="decide-proposal" data-proposal-id="\$\{attr\(item\.id\)\}" data-decision="rejected"/, '单条拒绝按钮（逐条）')
  assert.match(overviewFn, /data-action="batch-decide-proposals" data-bot-id="\$\{attr\(botId\)\}" data-decision="approved"/, '批量通过入口保留')
  assert.match(overviewFn, /data-action="batch-decide-proposals" data-bot-id="\$\{attr\(botId\)\}" data-decision="rejected"/, '批量拒绝入口保留')
  const eventsSource = readFileSync(fileURLToPath(new URL('../ui/modules/events-click.js', import.meta.url)), 'utf8')
  assert.match(eventsSource, /case 'decide-proposal': \{[\s\S]*?await api\('decide_proposal', \{ proposalId: target\.dataset\.proposalId, decision \}\)/, '单条按钮复用 decide-proposal 路由到 decide_proposal API')
})
