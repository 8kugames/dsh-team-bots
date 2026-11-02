import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')

// 群聊页右栏（aside.chat-side 里含「活跃任务」的那一个）
const chatSide = [...source.matchAll(/<aside class="chat-side">([\s\S]*?)<\/aside>/g)]
  .map(m => m[1])
  .find(block => block.includes('活跃任务'))
assert.ok(chatSide, '找不到群聊右栏 aside.chat-side')

test('群聊右栏顺序：工作区 → 项目总监 → 项目成员 → 活跃任务', () => {
  // DSHBOTS-5：项目成员面板移入「成员」tab，右栏收敛为三张卡（工作区/项目总监/活跃任务）。
  // DSHBOTS-49：项目成员以只读概览卡回归右栏（活跃任务卡之后），管理操作仍在「成员」tab。
  // DSHBOTS-55：概览卡按 232f1c8 的双行方案恢复到「项目总监」卡正下方（活跃任务之前）。
  const idxWorkspace = chatSide.indexOf('<h3>工作区</h3>')
  const idxOwner = chatSide.indexOf('<h3>项目总监</h3>')
  const idxTasks = chatSide.indexOf('<h3>活跃任务</h3>')
  const idxMembers = chatSide.indexOf('${renderChatMembersCard()}')
  assert.ok(idxWorkspace >= 0 && idxOwner >= 0 && idxTasks >= 0, '右栏三张卡都要在')
  assert.ok(idxOwner < 0 || idxWorkspace < idxOwner, '工作区必须在项目总监之前')
  assert.ok(idxOwner < idxTasks, '项目总监在活跃任务之前')
  assert.ok(idxMembers > idxOwner, '项目成员概览卡在项目总监卡之后')
  assert.ok(idxMembers < idxTasks, '项目成员概览卡在活跃任务卡之前')
  assert.equal(chatSide.match(/<h3>工作区<\/h3>/g).length, 1, '工作区卡只有一张，不能重复出现')
  assert.equal(chatSide.match(/renderChatMembersCard\(\)/g).length, 1, '项目成员概览卡只有一张，不能重复出现')
})

test('工作区卡内部结构不变（pathCode + 复制按钮）', () => {
  const wsBlock = /<div class="side-card">\s*<div class="side-card-head"><h3>工作区<\/h3><\/div>([\s\S]*?)<\/div>/.exec(chatSide)?.[1]
  assert.ok(wsBlock, '找不到工作区卡内容')
  assert.match(wsBlock, /pathCode\(project\.workspace_path\)/, '工作区仍显示路径')
  assert.match(wsBlock, /data-action="copy"/, '工作区仍保留复制按钮')
})

test('活跃任务上限 9 条，用常量表达', () => {
  assert.match(source, /const CHAT_ACTIVE_TASK_LIMIT = 9\b/, '上限抽成常量 CHAT_ACTIVE_TASK_LIMIT = 9')
  assert.match(source, /const openTasks = \(state\.data\.tasks \?\? \[\]\)\.filter\([\s\S]*?\)\n\s*const open = openTasks\.slice\(0, CHAT_ACTIVE_TASK_LIMIT\)/, '活跃任务列表按常量截断')
  assert.ok(!/slice\(0, 5\)/.test(chatSide), '右栏不再硬编码 5 条')
})

test('活跃任务标题右侧计数仍显示项目在办任务总数', () => {
  assert.match(chatSide, /<h3>活跃任务<\/h3><span>\$\{project\.stats\.openTasks\}<\/span>/, '计数用项目在办任务总数，不随显示上限变化')
})

test('超出上限时提示剩余条数', () => {
  assert.match(source, /openTasks\.length > CHAT_ACTIVE_TASK_LIMIT \? `<div class="faint">还有 \$\{openTasks\.length - CHAT_ACTIVE_TASK_LIMIT\} 条<\/div>` : ''/, '超出部分用「还有 N 条」提示')
})
