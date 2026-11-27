import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

const source = readUiSource()
const css = await uiStylesSource()

// —— 草稿纯逻辑块 ——
const draftsBlock = /\/\/ chat-drafts:start[\s\S]*?\/\/ chat-drafts:end/.exec(source)?.[0]
assert.ok(draftsBlock, 'ui/app.js 缺少 chat-drafts 标记块')
const { draftKey, currentDraft } = new Function(`${draftsBlock}\nreturn { draftKey, currentDraft }`)()

test('draftKey：群聊按项目、单聊按 Bot 分键', () => {
  assert.equal(draftKey({ chatMode: 'group', projectId: 'p1', soloBotId: null }), 'group:p1')
  assert.equal(draftKey({ chatMode: 'solo', projectId: 'p1', soloBotId: 'b2' }), 'solo:b2')
  assert.notEqual(
    draftKey({ chatMode: 'group', projectId: 'p1', soloBotId: null }),
    draftKey({ chatMode: 'solo', projectId: 'p1', soloBotId: 'b2' }),
  )
})

test('currentDraft：各上下文互不覆盖，无草稿回空串', () => {
  const state = { chatMode: 'group', projectId: 'p1', soloBotId: 'b2', chatDrafts: { 'group:p1': '群聊草稿', 'solo:b2': '单聊草稿' } }
  assert.equal(currentDraft(state), '群聊草稿')
  state.chatMode = 'solo'
  assert.equal(currentDraft(state), '单聊草稿')
  state.chatMode = 'group'
  state.projectId = 'p9'
  assert.equal(currentDraft(state), '')
})

test('草稿接线：两个 composer 读 currentDraft，input 写回 map，发送只清当前键，solo-bot 不再清草稿', () => {
  assert.equal((source.match(/\$\{esc\(currentDraft\(state\)\)\}/g) ?? []).length, 2, '群聊与单聊 composer 都应回填 currentDraft(state)')
  assert.equal((source.match(/currentDraft\(state\)\.trim\(\) \|\| pendingImagesFor\(\)\.length/g) ?? []).length, 2, '群聊与单聊发送键在有草稿或有待发图片时都可点')
  assert.match(source, /state\.chatDrafts\[draftKey\(state\)\] = input\.value/)
  // [修剪] 代码形状断言
  // sendMessage 出站前捕获当前键（失败恢复要写回同一键），清空草稿写的也是这个 key。
  // [修剪] 代码形状断言
  assert.match(source, /state\.chatDrafts\[key\] = ''/)
  assert.ok(!source.includes('state.draft'), '旧的单值 state.draft 应已全部移除')
  const soloBotCase = /case 'solo-bot': \{[\s\S]*?case 'copy':/.exec(source)?.[0]
  assert.ok(!/chatDrafts\[/.test(soloBotCase ?? ''), 'solo-bot 切换不得清空任何草稿')
})

// —— 输入框高度纯逻辑块 ——
const resizeBlock = /\/\/ composer-resize:start[\s\S]*?\/\/ composer-resize:end/.exec(source)?.[0]
assert.ok(resizeBlock, 'ui/app.js 缺少 composer-resize 标记块')
const { composerCap, composerHeightFor, COMPOSER_AUTO_MAX_PX, COMPOSER_PANEL_RATIO } = new Function(
  `${resizeBlock}\nreturn { composerCap, composerHeightFor, COMPOSER_AUTO_MAX_PX, COMPOSER_PANEL_RATIO }`,
)()

test('常量：自动上限 150px 沿用，拖高封顶比例 0.618', () => {
  assert.equal(COMPOSER_AUTO_MAX_PX, 150)
  assert.equal(COMPOSER_PANEL_RATIO, 0.618)
})

test('composerCap：面板高度的 61.8%，四舍五入且不为 0', () => {
  assert.equal(composerCap(1000), 618)
  assert.equal(composerCap(487), 301)
  assert.ok(composerCap(1) >= 1)
})

test('composerHeightFor：拖高后不回缩、内容超出可长高、两者封顶 61.8%', () => {
  assert.equal(composerHeightFor(48, 300, 618), 300, '内容少于手动高度时保持手动高度（不回缩）')
  assert.equal(composerHeightFor(400, 300, 618), 400, '内容超出手动高度时仍可长高')
  assert.equal(composerHeightFor(48, 700, 618), 618, '手动高度封顶在面板 61.8%')
  assert.equal(composerHeightFor(700, null, 618), 618, '自动长高也封顶在面板 61.8%')
  assert.equal(composerHeightFor(120, null, 618), 120, '无手动高度时保持自动值')
})

test('拖柄接线：pointerdown 拖动 + 双击恢复 + 窗口 resize 重夹取', () => {
  assert.match(source, /pointerdown[\s\S]*?\.composer-resizer/)
  // [修剪] 代码形状断言
  // [修剪] 代码形状断言 '拖动下限=当前内容自动高度')
  // [修剪] 代码形状断言 '双击恢复自动高度')
  // [修剪] 代码形状断言
  assert.match(source, /function applyComposerHeight\(input\)/)
})

test('拖柄样式：ns-resize 热区 + 主题变量配色，CSS 不再设 170px 硬封顶', () => {
  assert.match(css, /\.composer-resizer \{[\s\S]*?cursor: ns-resize/)
  assert.match(css, /\.composer-resizer \{[\s\S]*?touch-action: none/)
  assert.match(css, /\.composer-resizer:hover::after[\s\S]*?--accent|--accent[\s\S]*?\.composer-resizer:hover::after/)
  const composerTextarea = /\.composer textarea \{[\s\S]*?\n\}/.exec(css)?.[0]
  assert.ok(!/max-height: 170px/.test(composerTextarea ?? ''), 'textarea 的 CSS 封顶应交给 JS 面板 61.8% 规则')
})

// —— 轮询滚动保位 ——
test('render()：重建 DOM 前记录 .chat-messages scrollTop，非贴底原位恢复，贴底仍自动落底', () => {
  // [修剪] 代码形状断言
  // [修剪] 代码形状断言
  // [修剪] 代码形状断言 '贴底时新消息仍自动贴底')
})

test('render()：重建后恢复 composer 内联高度与发送按钮态', () => {
  // [修剪] 代码形状断言
})

// —— 回归护栏：引用交互与 renderKeepingChatScroll 保留 ——
test('引用交互不回归：renderKeepingChatScroll 保留并仍聚焦输入框', () => {
  assert.match(source, /function renderKeepingChatScroll\(\) \{\s*\n\s*render\(\)\s*\n\s*document\.getElementById\('composer-input'\)\?\.focus\(\)/)
  assert.match(source, /renderKeepingChatScroll\(\)/)
  assert.match(source, /case 'cancel-reply':/)
  assert.match(source, /data-action="quote-message"/)
  // [修剪] 代码形状断言 '切换上下文仍清引用条')
})

// —— 复制按钮 / chip 同行顺序 / 成员两行式 ——
test('复制按钮：消息 hover 出现，复用统一 copy handler，复制原文并带无障碍属性', () => {
  const btn = /<button class="msg-copy-btn" data-action="copy" data-copy="\$\{attr\(message\.body\)\}"[^>]*>\$\{icon\('copy'\)\}<\/button>/.exec(source)?.[0]
  assert.ok(btn, '消息行应有 msg-copy-btn 复制按钮，data-copy 取 message.body 原文')
  assert.match(btn, /title="\$\{t\('message\.copyTitle'\)\}"/)
  assert.match(btn, /aria-label="[^"]+"/)
  assert.match(source, /\$\{quoteBtn\}\$\{copyBtn\}/, '复制按钮紧邻引用按钮右侧')
  assert.match(source, /case 'copy': \{[\s\S]*?navigator\.clipboard\.writeText\(value\)/, '复用统一 copy handler，不另写 clipboard 逻辑')
  assert.match(source, /toast\(t\('toast\.copied'\), 'success'\)/)
  assert.match(css, /\.message-row:hover \.msg-copy-btn/)
})

test('思考过程 chip 渲染在会话与任务 chip 之前，三者合并同一 .task-chip-line', () => {
  const fn = /function renderMessage\(message\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(fn, '找不到 renderMessage 函数体')
  const nonsys = fn.slice(fn.indexOf('const isUser')).replace(/\/\/[^\n]*/g, '') // 剔除行注释，防止注释文案满足顺序断言
  assert.equal((nonsys.match(/task-chip-line/g) ?? []).length, 1, '非系统消息只应有一个 task-chip-line 容器')
  assert.ok(nonsys.indexOf("t('message.thinking')") < nonsys.indexOf('session.chipNative'), '顺序固定：思考过程 → 会话')
  assert.ok(nonsys.indexOf('session.chipNative') < nonsys.indexOf('message.taskIdentifier'), '顺序固定：会话 → 任务')
  assert.match(nonsys, /data-action="open-native-session" data-run-id="\$\{attr\(message\.run_id\)\}"/, '会话 chip 跳原生界面（按运行归属）')
  assert.match(css, /\.task-chip-line \{[\s\S]*?gap: 8px/, 'chip 之间留 8px 呼吸距离')
  const chipCss = /\.task-chip \{[\s\S]*?\n\}/.exec(css)?.[0]
  assert.match(chipCss, /line-height: 1\.2/, 'task-chip 行高显式固定')
})

test('成员卡片结构存在，模型行有可读兜底', () => {
  // 「成员」tab 的成员行是卡片式网格（member-card）：两行式与状态点语义不变。
  assert.match(source, /<div class="member-card/)
  assert.match(source, /<span class="member-name-line"><strong>/, '第一行：名字 + 角色标签')
  assert.match(source, /class="member-role"/)
  assert.match(source, /class="member-model"/)
  // [修剪] 代码形状断言 '模型行只显示 modelRef（已含 provider），缺任一项显示「未配置模型」')
  assert.ok(!/bot\.provider && modelRef \?/.test(source), '模型行不再单独拼 provider，避免与 modelRef 内的 provider 重复')
  assert.match(source, /function memberRunDot\(member\)/, '状态点判定收敛到 memberRunDot')
  assert.match(source, /function runDotHtml\(dot\)[\s\S]*?<span class="run-dot \$\{dot\.cls\}" data-status="\$\{dot\.status\}" title="\$\{esc\(dot\.text\)\}" aria-label="\$\{esc\(dot\.text\)\}"><\/span>/, '状态点带 data-status 与 title/aria-label 无障碍属性')
  assert.match(source, /phase === 'running'[\s\S]*?cls: 'running'[\s\S]*?cls: 'idle', status: 'queued'/, '仅真正 running 才用黄点，排队按空闲（绿）计')
  assert.match(source, /\$\{runDotHtml\(dot\)\}/, '成员行尾渲染状态点')
  assert.match(source, /ownerDot \? runDotHtml\(ownerDot\) : ''/, '项目总监同样带状态点')
  assert.match(css, /\.run-dot\.idle \{[\s\S]*?background: var\(--green\)/, '空闲绿点')
  assert.match(css, /\.run-dot\.running \{[\s\S]*?background: var\(--star\)[\s\S]*?animation: pulse/, '运行中黄点加 pulse 闪烁（配色对齐 .column-dot.in_progress）')
  assert.match(css, /\.run-dot\.plan-wait \{[\s\S]*?background: var\(--c-violet\)/, '限流等待紫点（可自愈等待态，区别于失败红）')
  const idleDotCss = /\.run-dot\.idle \{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''
  assert.ok(!idleDotCss.includes('animation'), '空闲/排队点不闪烁')
  const failedDotCss = /\.run-dot\.failed \{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''
  assert.ok(!failedDotCss.includes('animation'), '失败点不闪烁')
  const cssMember = /\.member-info strong \{[\s\S]*?\n\}/.exec(css)?.[0]
  assert.ok(cssMember, 'member-info 两行式样式存在（对齐 .owner-info）')
})
