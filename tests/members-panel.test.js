import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// DSHBOTS-49：群聊右栏恢复「项目成员」只读概览卡（用户 m_6d43b5 要求恢复 D-5 删掉的面板）。
// 锁定三件事：①卡片结构与数据源；②只读——卡内没有任何写操作控件（防回退到旧版复选框全量提交）；
// ③管理入口指向「成员」tab。

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')

// 群聊右栏（aside.chat-side 里含「活跃任务」的那一个）
const chatSide = [...source.matchAll(/<aside class="chat-side">([\s\S]*?)<\/aside>/g)]
  .map(m => m[1])
  .find(block => block.includes('活跃任务'))
assert.ok(chatSide, '找不到群聊右栏 aside.chat-side')

// 概览卡的模板函数体（只取模板字符串内部，避免把函数外的代码算进来）
const cardFn = /function renderChatMembersCard\(\)\s*\{[\s\S]*?\n  \}/.exec(source)?.[0]
assert.ok(cardFn, '找不到 renderChatMembersCard()')
const cardBody = /return `([\s\S]*?)`\n  \}/.exec(cardFn)?.[1]
assert.ok(cardBody, '找不到 renderChatMembersCard() 的模板字符串')

test('群聊右栏渲染「项目成员」概览卡', () => {
  assert.match(chatSide, /\$\{renderChatMembersCard\(\)\}/, '右栏要渲染成员概览卡')
})

test('概览卡有标题、成员计数与稳定标记', () => {
  assert.match(cardBody, /<div class="side-card members-overview" data-members-overview>/, '卡片带 side-card 类与 data-members-overview 标记')
  assert.match(cardBody, /<div class="side-card-head"><h3>项目成员<\/h3><span>\$\{members\.length\}<\/span><\/div>/, '标题「项目成员」+ 成员计数')
})

test('概览卡数据源与「成员」tab 同一张成员表', () => {
  assert.match(cardFn, /project\?\.members \?\? \[\]/, '成员来自当前项目成员表')
  assert.match(cardFn, /members\.map\(member =>/, '按成员逐行渲染')
})

test('每行是头像 + 名称 + 角色标签 + 状态点', () => {
  assert.match(cardBody, /avatar\(bot, 'sm'\)/, '每行带头像')
  assert.match(cardBody, /<strong>\$\{esc\(bot\.name\)\}<\/strong>/, '每行有名称')
  assert.match(cardBody, /class="member-role"/, '每行有角色标签')
  assert.match(cardBody, /runDotHtml\(dot\)/, '每行有状态点')
  assert.match(cardFn, /memberRunDot\(member\)/, '状态点与「成员」tab 同一口径')
})

test('总监行保留 violet 标识', () => {
  assert.match(cardBody, /isOwner \? '<span class="pill violet">总监<\/span>'/, '总监用 violet 标签')
  assert.match(cardFn, /member\.member_role === 'owner' \|\| member\.id === project\.owner_bot_id/, '总监判定与「成员」tab 一致')
})

test('概览卡是只读的：没有任何写操作控件', () => {
  const forbidden = ['add-member', 'remove-member', 'type="checkbox"', '<input', '<select', 'type="submit"', 'save-member', 'update-member']
  for (const token of forbidden) {
    assert.ok(!cardBody.includes(token), `概览卡不应出现写操作控件：${token}`)
  }
  // 唯一的交互是跳转到「成员」tab，不是保存。
  const actions = [...cardBody.matchAll(/data-action="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual([...new Set(actions)], ['nav'], '概览卡内只允许导航动作')
})

test('概览卡底部提示管理入口在「成员」标签页', () => {
  assert.match(cardBody, /管理成员请前往/, '底部有一行提示文案')
  assert.match(cardBody, /data-action="nav" data-view="members"/, '提示可直接链到 members 视图')
})

test('概览卡样式对齐现有 side-card 视觉规格', () => {
  assert.match(css, /\.members-overview \.side-row\s*\{/, '成员行有专属样式')
  assert.match(css, /\.side-card-foot\s*\{/, '底部提示行有样式')
  assert.match(css, /\.side-link\s*\{/, '底部链接有样式')
})

// DSHBOTS-50：成员邀请改为弹窗选人（用户 m_6b76a2 要求去掉下拉默认填充）。
// 锁定五件事：①成员页只剩一个「邀请加入」按钮，没有内联下拉；
// ②弹窗只列未入项目且 status=active 的 bot，单选（radio）后确认提交 add_member；
// ③无可选 bot 时给空态文案，不给提交动作；④未选人时提交零变更；
// ⑤弹窗复用现有 modal 骨架（close-modal / 遮罩 / ESC），关闭即零变更。
const membersFn = /function renderMembers\(\)\s*\{[\s\S]*?\n {2}\}/.exec(source)?.[0]
assert.ok(membersFn, '找不到 renderMembers()')
const inviteModalFn = /function modalInviteMember\(\)\s*\{[\s\S]*?\n {2}\}/.exec(source)?.[0]
assert.ok(inviteModalFn, '找不到 modalInviteMember()')
const inviteSubmit = /if \(type === 'invite-member'\) \{[\s\S]*?\n {6}\}/.exec(source)?.[0]
assert.ok(inviteSubmit, '找不到 invite-member 表单提交分支')

test('成员页只有「邀请加入」按钮，没有内联下拉', () => {
  assert.match(membersFn, /data-action="open-invite-member"/, '成员页有「邀请加入」按钮')
  assert.ok(!membersFn.includes('<select'), '成员页不再有内联下拉')
  assert.ok(!membersFn.includes('invite-bot'), '成员页不再有 invite-bot 下拉')
  assert.ok(!source.includes('data-action="add-member"'), '旧的 add-member 直提动作已移除')
})

test('邀请按钮打开选人弹窗，弹窗挂在现有 modal 通道上', () => {
  assert.match(source, /case 'open-invite-member':[\s\S]{0,80}?openModal\(\{ type: 'invite-member'/, '点击按钮打开 invite-member 弹窗')
  assert.match(source, /case 'invite-member': return modalInviteMember\(\)/, 'renderModal 分支渲染 invite-member')
  assert.match(inviteModalFn, /modalShell\(\{/, '弹窗复用 modalShell 骨架')
})

test('候选只含未入本项目且 status 正常的 bot', () => {
  assert.match(inviteModalFn, /bot\.status === 'active' && !memberIds\.has\(bot\.id\)/, '候选过滤条件：active 且不在项目里')
  assert.match(inviteModalFn, /memberIds = new Set\(\(project\.members \?\? \[\]\)\.map\(member => member\.id\)\)/, '项目成员集合来自 project.members')
})

test('弹窗内是头像+名称+角色的单选列表', () => {
  assert.match(inviteModalFn, /<input type="radio" name="botId"/, '用 radio 做单选')
  assert.match(inviteModalFn, /avatar\(bot, 'sm'\)/, '每个候选带头像')
  assert.match(inviteModalFn, /<strong>\$\{esc\(bot\.name\)\}<\/strong>/, '每个候选有名称')
  assert.match(inviteModalFn, /class="member-role"/, '每个候选有角色标签')
})

test('确认按钮走 add_member；未选人时零变更', () => {
  assert.match(inviteModalFn, /data-form="invite-member"/, '弹窗表单声明 invite-member')
  assert.match(inviteModalFn, /type="submit" form="modal-form" id="invite-member-submit"/, '确认按钮提交 modal-form')
  assert.match(inviteSubmit, /if \(!botId\) \{[\s\S]*?return\n/, '未选人不提交')
  assert.match(inviteSubmit, /await api\('add_member', \{ projectId: activeProject\(\)\?\.id, botId \}\)/, '确认后调用 add_member')
})

test('无可选 bot 时给空态文案且没有提交动作', () => {
  assert.match(inviteModalFn, /所有可用 Bot 都已在项目中/, '空态文案')
  const emptyBranch = /if \(candidates\.length === 0\) \{[\s\S]*?\n {4}\}/.exec(inviteModalFn)?.[0]
  assert.ok(emptyBranch, '找不到空态分支')
  assert.ok(!emptyBranch.includes('type="submit"'), '空态不给提交按钮')
  assert.ok(!emptyBranch.includes('add_member'), '空态不发 add_member')
})

test('弹窗关闭/取消/遮罩/ESC 都是零变更', () => {
  assert.match(inviteModalFn, /data-action="close-modal"/, '取消按钮复用 close-modal')
  assert.match(source, /function modalShell\([\s\S]*?data-action="modal-backdrop"/, '遮罩点击复用 modal-backdrop')
  assert.match(source, /if \(event\.key === 'Escape' && state\.modal\) \{\s*\n\s*closeModal\(\)/, 'ESC 走现有 closeModal')
  // 关闭路径上不得有写操作。
  assert.ok(!/case 'close-modal'[\s\S]{0,200}add_member/.test(source), '关闭动作不触发 add_member')
})
