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

test('群聊右栏顺序：工作区前置到项目总监上方', () => {
  const idxWorkspace = chatSide.indexOf('<h3>工作区</h3>')
  const idxOwner = chatSide.indexOf('<h3>项目总监</h3>')
  const idxMembers = chatSide.indexOf('<h3>项目成员</h3>')
  const idxTasks = chatSide.indexOf('<h3>活跃任务</h3>')
  assert.ok(idxWorkspace >= 0 && idxOwner >= 0 && idxMembers >= 0 && idxTasks >= 0, '右栏四张卡都要在')
  assert.ok(idxWorkspace < idxOwner, '工作区必须在项目总监之前')
  assert.ok(idxOwner < idxMembers, '项目总监在项目成员之前')
  assert.ok(idxMembers < idxTasks, '项目成员在活跃任务之前')
  assert.equal(chatSide.match(/<h3>工作区<\/h3>/g).length, 1, '工作区卡只有一张，不能重复出现')
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
