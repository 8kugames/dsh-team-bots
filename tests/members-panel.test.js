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
