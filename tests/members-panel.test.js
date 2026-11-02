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

test('概览卡位置在「项目总监」panel 正下方、「活跃任务」之前', () => {
  const idxOwner = chatSide.indexOf('<h3>项目总监</h3>')
  const idxMembers = chatSide.indexOf('${renderChatMembersCard()}')
  const idxTasks = chatSide.indexOf('<h3>活跃任务</h3>')
  assert.ok(idxOwner >= 0 && idxMembers >= 0 && idxTasks >= 0, '右栏三处都要在')
  assert.ok(idxOwner < idxMembers, '成员卡在项目总监卡之后')
  assert.ok(idxMembers < idxTasks, '成员卡在活跃任务卡之前')
  assert.equal(chatSide.match(/renderChatMembersCard\(\)/g).length, 1, '成员卡只有一张')
})

test('概览卡有标题、成员计数与稳定标记', () => {
  assert.match(cardBody, /<div class="side-card members-overview" data-members-overview>/, '卡片带 side-card 类与 data-members-overview 标记')
  assert.match(cardBody, /<div class="side-card-head"><h3>项目成员<\/h3><span>\$\{memberList\.length\}<\/span><\/div>/, '标题「项目成员」+ 成员计数（剔除总监后的口径）')
})

test('概览卡数据源与「成员」tab 同一张成员表', () => {
  assert.match(cardFn, /project\?\.members \?\? \[\]/, '成员来自当前项目成员表')
  assert.match(cardFn, /memberList\.map\(member =>/, '按成员逐行渲染')
})

test('成员行剔除总监：总监只在「项目总监」panel 出现一次', () => {
  assert.match(cardFn, /members\.filter\(member => member\.id !== project\?\.owner_bot_id && member\.member_role !== 'owner'\)/, '成员行过滤掉总监')
  assert.ok(!cardBody.includes('pill violet'), '成员卡内不再出现「总监」标签')
  assert.ok(!cardFn.includes('isOwner'), '成员卡不再自行判定并渲染总监行')
})

test('每行是头像 + 两行式信息 + 状态点', () => {
  assert.match(cardBody, /avatar\(bot, 'sm'\)/, '每行带头像')
  assert.match(cardBody, /<strong>\$\{esc\(bot\.name\)\}<\/strong>/, '每行有名称')
  assert.match(cardBody, /class="member-role"/, '每行有角色标签')
  assert.match(cardBody, /runDotHtml\(dot\)/, '每行有状态点')
  assert.match(cardFn, /memberRunDot\(member\)/, '状态点与「成员」tab 同一口径')
})

test('行样式是成员两行式 .member-info：名称+角色 / 模型小字', () => {
  assert.match(cardBody, /<div class="member-info">/, '复用成员两行式容器')
  assert.match(cardBody, /<span class="member-name-line">[\s\S]*?class="member-role"/, '第一行：名称 + 角色标签')
  assert.match(cardBody, /<span class="member-model">\$\{esc\(modelLine\)\}<\/span>/, '第二行：模型小字')
  assert.match(cardFn, /const modelRef = member\.modelRef \?\? bot\.modelRef \?\? bot\.model \?\? null/, '模型取成员/Bot 的 modelRef')
  assert.match(cardFn, /const modelLine = modelRef \? String\(modelRef\) : '未配置模型'/, '缺配置时兜底「未配置模型」')
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

// DSHBOTS-52：成员 tab 改卡片式（用户 m_fd1b36）——成员行列表改为卡片网格，单卡宽高比锁定
// 0.618:1（宽:高，竖向黄金比），上头像 / 中名称+角色 / 下状态点与用量合计；总监卡保留 violet 标识；
// busy 状态点沿用 run-dot 语义不变色；悬停/焦点给轻量描边；移除操作收进卡片角标（hover 显出）。
const cardCss = /\.member-card \{([\s\S]*?)\n\}/.exec(css)?.[1]
assert.ok(cardCss, '找不到 .member-card 样式块')
const gridCss = /\.members-grid \{([\s\S]*?)\n\}/.exec(css)?.[1]
assert.ok(gridCss, '找不到 .members-grid 样式块')

test('成员列表改为卡片网格，不再是行列表', () => {
  assert.match(membersFn, /<div class="members-grid">/, '成员区是卡片网格容器')
  assert.match(membersFn, /<div class="member-card/, '每个成员一张卡片')
  assert.ok(!membersFn.includes('list-row'), '成员页不再渲染 list-row 行列表')
  assert.ok(!membersFn.includes('list-card'), '成员页不再用 list-card 包裹行列表')
  assert.match(gridCss, /display:\s*grid/, '容器是 grid 布局')
  assert.match(gridCss, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(/, '列宽自适应（auto-fill + minmax）')
})

test('单卡宽高比锁定 0.618:1，内容不足不撑破', () => {
  assert.match(cardCss, /aspect-ratio:\s*0\.618/, '卡片 aspect-ratio: 0.618（宽:高 = 0.618:1）')
  assert.match(cardCss, /overflow:\s*hidden/, '内容装不下时以卡片为准，不撑破卡片')
})

test('卡片信息布局：上头像、中名称+角色、下状态点与用量', () => {
  const topIdx = membersFn.indexOf('member-card-top')
  const midIdx = membersFn.indexOf('member-card-mid')
  const footIdx = membersFn.indexOf('member-card-foot')
  assert.ok(topIdx > 0 && midIdx > topIdx && footIdx > midIdx, '头像 → 名称/角色 → 状态与用量，三段从上到下')
  assert.match(membersFn, /member-card-top">\$\{avatar\(bot, 'lg'\)\}/, '顶部是头像')
  assert.match(membersFn, /member-card-name"><strong>\$\{esc\(bot\.name\)\}<\/strong>/, '中部是名称')
  assert.match(membersFn, /class="member-role"/, '中部有角色标签')
  assert.match(membersFn, /member-card-foot[\s\S]*?runDotHtml\(dot\)/, '底部有状态点')
  assert.match(membersFn, /member-card-foot[\s\S]*?合计 <strong>\$\{formatNumber\(tokens\)\}<\/strong> tokens/, '底部有 token 合计')
  assert.match(membersFn, /member-card-foot[\s\S]*?formatCost\(Number\(member\.usage_cost \?\? 0\)\)/, '底部有 cost 合计')
})

test('总监卡保留 violet 标识，且不渲染移除按钮', () => {
  assert.match(membersFn, /isOwner \? '<span class="pill violet">总监<\/span>'/, '总监用 violet 标签')
  assert.match(membersFn, /\$\{isOwner \? '' : `<button class="member-card-remove"/, '移除按钮只给非总监卡')
})

test('busy 状态点沿用 run-dot 语义且不改色', () => {
  assert.match(membersFn, /memberRunDot\(member\)/, '状态点仍走 memberRunDot')
  assert.match(membersFn, /runDotHtml\(dot\)/, '状态点仍用 runDotHtml 输出')
  assert.match(source, /function runDotHtml\(dot\)[\s\S]*?<span class="run-dot \$\{dot\.cls\}" data-status="\$\{dot\.status\}"/, 'run-dot 的类与 data-status 语义未变')
  // 颜色类只允许原有四类，成员页不新增状态点配色。
  assert.ok(!/run-dot\s+(red|blue|green|yellow|violet|amber)/.test(membersFn), '卡片不新增状态点配色类')
  assert.match(css, /\.run-dot\.running \{[\s\S]*?background: var\(--star\)|\.run-dot\.running \{[\s\S]*?background: var\(--amber\)/, '运行中仍用既有配色变量')
})

test('悬停/焦点态给轻量描边', () => {
  const hoverRule = /\.member-card:hover,\s*\n\s*\.member-card:focus-within \{([\s\S]*?)\n\}/.exec(css)?.[1]
  assert.ok(hoverRule, '找不到 .member-card:hover / :focus-within 规则')
  assert.match(hoverRule, /border-color:/, '悬停/焦点改描边色')
  assert.match(hoverRule, /box-shadow:/, '悬停/焦点有轻量外描边')
})

test('移除操作收进卡片角标，hover 才显出', () => {
  const removeCss = /\.member-card-remove \{([\s\S]*?)\n\}/.exec(css)?.[1]
  assert.ok(removeCss, '找不到 .member-card-remove 样式')
  assert.match(removeCss, /position:\s*absolute/, '角标绝对定位在卡片角上')
  assert.match(removeCss, /opacity:\s*0/, '默认隐藏')
  assert.match(css, /\.member-card:hover \.member-card-remove,\s*\n\s*\.member-card:focus-within \.member-card-remove \{[\s\S]*?opacity:\s*1/, 'hover/聚焦时显出')
})

test('小屏少列：窄屏收成两列，超窄屏退到单列', () => {
  assert.match(css, /@media \(max-width: 430px\) \{\s*\n\s*\.members-grid \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, '≤430px 两列')
  assert.match(css, /@media \(max-width: 340px\) \{\s*\n\s*\.members-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/, '≤340px 单列')
})

test('卡片宽度有上限，宽屏下不被拉成巨型卡', () => {
  assert.match(cardCss, /max-width:\s*236px/, '卡片最大宽度封顶')
  assert.match(gridCss, /justify-items:\s*center/, '卡片在列内居中')
})

test('卡片样式只用主题变量，明暗两套都成立', () => {
  const nameCss = /\.member-card-name \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  const footCss = /\.member-card-foot \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  const colorProps = [...cardCss, nameCss, footCss].join('\n').match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []
  assert.deepEqual(colorProps, [], '卡片样式不写死颜色，全部走主题变量')
  assert.match(cardCss, /var\(--surface\)/, '卡片底色用主题 surface')
  assert.match(cardCss, /var\(--line\)/, '卡片描边用主题 line')
  assert.match(nameCss, /var\(--ink\)/, '名称文字色用主题 ink')
  assert.match(footCss, /var\(--ink-3\)/, '底部小字用主题 ink-3')
})
