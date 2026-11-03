import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// DSHBOTS-5 工作台信息架构改造：读源码断言（与 terminal-ui.test.js 同模式）。
const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
// NAV/SOLO_NAV 已拆到 modules/state.js（DSHBOTS-15），从模块源码读取。
const stateSource = readFileSync(fileURLToPath(new URL('../ui/modules/state.js', import.meta.url)), 'utf8')

const NAV = /const NAV = \[([\s\S]*?)\n\]/.exec(stateSource)?.[1] ?? ''
const SOLO_NAV = /const SOLO_NAV = \[([\s\S]*?)\n\]/.exec(stateSource)?.[1] ?? ''

// ① 项目导航：bots 改「成员」members，群聊侧栏「项目成员」面板移除，设置页成员 checkbox 移除。
test('① 项目导航 bots → members 成员 tab', () => {
  assert.match(NAV, /\['members', '成员', 'users'\]/, 'NAV 应有成员 tab')
  assert.ok(!/\['bots',/.test(NAV), 'NAV 不应再有 bots tab')
  assert.match(source, /case 'members':\s*\n?\s*return renderMembers\(\)/, 'render 路由 case members → renderMembers')
  assert.match(source, /function renderMembers\(\)/, 'renderMembers 函数存在')
})

test('① 成员 tab：邀请走弹窗选人 + 移除动作 + busy 徽标 + 用量合计', () => {
  assert.ok(!source.includes('id="invite-bot"'), '不再有邀请下拉 select#invite-bot（DSHBOTS-50 改为弹窗选人）')
  assert.match(source, /data-action="open-invite-member"/, '邀请按钮 open-invite-member（打开选人弹窗）')
  assert.match(source, /data-action="remove-member"/, '移除按钮 remove-member')
  assert.match(source, /member\.member_role === 'owner' \|\| member\.id === project\.owner_bot_id[\s\S]*?<span class="pill violet">总监<\/span>/, '总监行 violet pill')
  assert.match(source, /member\.busy \? '任务中' : '空闲中'|member\.busy \? "任务中" : "空闲中"|busy \? '任务中' : '空闲中'/, '任务中/空闲中徽标')
  assert.match(source, /formatCost\(Number\(member\.usage_cost \?\? 0\)\)/, 'cost 合计用 formatCost')
})

test('① 群聊侧栏与设置页的项目成员面板已移除', () => {
  const chatSide = [...source.matchAll(/<aside class="chat-side">([\s\S]*?)<\/aside>/g)]
    .map(m => m[1])
    .find(block => block.includes('活跃任务'))
  assert.ok(chatSide, '找不到群聊右栏')
  assert.ok(!chatSide.includes('<h3>项目成员</h3>'), '群聊右栏不再有项目成员卡')
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
  assert.match(SOLO_NAV, /\['evolution', '进化', 'branch'\]/, '单聊 NAV 保留进化（逐个审批）')
})

test('② 侧栏「总览bots」入口在全局配置上方，带待审红点', () => {
  const idxOverview = source.indexOf('data-view="bots-overview"')
  const idxGlobal = source.indexOf('<span>全局配置</span>')
  assert.ok(idxOverview >= 0, '侧栏应有总览bots按钮')
  assert.ok(idxGlobal >= 0 && idxOverview < idxGlobal, '总览bots在全局配置上方')
  assert.match(source, /case 'bots-overview': return renderBotsOverview\(\)/, 'render 路由 bots-overview')
  assert.match(source, /pendingProposals\(\) > 0 \? '<span class="red-dot"/, '有待审提案时红点')
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
  const memoryFn = /function renderMemory\(\) \{[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? ''
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

// DSHBOTS-77 侧栏状态行运行数全局口径：读 state 载荷的 activeRuns（全库 queued+running），
// 不随群聊/单聊上下文跳变；topbar-meta 的运行数仍是当前项目口径。
test('DSHBOTS-77 侧栏状态行读全局 activeRuns，不随上下文分支', () => {
  const shell = /function renderShell\(\) \{[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? ''
  assert.ok(shell, '找不到 renderShell')
  assert.match(shell, /const running = Number\(data\?\.activeRuns \?\? 0\)/, '状态行运行数读全局字段 activeRuns，无上下文分支')
  assert.ok(!shell.includes('soloRuns'), 'renderShell 不再按单聊/群聊分别数运行')
  assert.match(shell, /class="dot \$\{running \? 'amber' : ''\}"/, '状态点判空与文案读同一全局变量')
  assert.match(shell, /\$\{running \? `\$\{running\} 个运行中` : '团队空闲'\}/, '状态行文案保持全局口径')
  assert.match(shell, /const projectRunning = project\?\.stats\?\.running \?\? 0/, 'topbar 运行数拆回项目口径')
  assert.match(shell, /<b>\$\{projectRunning\}<\/b> 运行中/, 'topbar-meta 读项目口径变量')
  const sysSource = readFileSync(fileURLToPath(new URL('../src/services/system.js', import.meta.url)), 'utf8')
  const stateFn = /async state\(projectId, soloBotId = null\) \{[\s\S]*?\n {2}\},/.exec(sysSource)?.[0] ?? ''
  assert.ok(stateFn, '找不到 system.js state()')
  assert.match(stateFn, /activeRuns: Number\(this\.store\.get\("SELECT COUNT\(\*\) AS count FROM runs WHERE status IN \('queued', 'running'\)"\)\?\.count \?\? 0\)/, 'state 载荷输出全库活跃运行计数')
})
