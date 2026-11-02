// DSHBOTS-28：bot 单聊页升级为「调度页」的 UI 断言。
// 沿用读源码断言的先例（tests/typing-status.test.js 风格）：ui/app.js 是浏览器 IIFE，
// 单测里跑不起来，就锁住关键文案、结构与数据接线。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')

test('① 更名：导航首 tab、侧卡与入口按钮都改成「调度」口径', () => {
  assert.match(source, /\['chat', '调度', 'message'\]/, '单聊导航首 tab 应显示「调度」')
  assert.match(source, /<h3>调度对象<\/h3>/, '侧卡标题应为「调度对象」')
  assert.match(source, /<h3>最近调度运行<\/h3>/, '运行侧卡标题应为「最近调度运行」')
  assert.match(source, /还没有调度运行。/, '运行侧卡空态应为「还没有调度运行。」')
  assert.match(source, /调度 · @\$\{soloBot\.name\}/, '页面标题应带「调度」前缀')
  assert.match(source, /data-action="solo-bot" data-bot-id="\$\{attr\(bot\.id\)\}" title="打开该 Bot 的调度页">调度</, 'Bots 页入口按钮文案应为「调度」')
  assert.doesNotMatch(source, /<h3>单聊对象<\/h3>/, '旧文案「单聊对象」不应残留')
  assert.doesNotMatch(source, /<h3>最近单聊运行<\/h3>/, '旧文案「最近单聊运行」不应残留')
})

test('② 三块列表卡与空态文案齐备：在办 / 待办 / 正在调度', () => {
  assert.match(source, /<h3>在办任务<\/h3>/)
  assert.match(source, /<h3>待办任务<\/h3>/)
  assert.match(source, /<h3>正在调度<\/h3>/)
  assert.match(source, /没有在办任务。/, '在办空态文案')
  assert.match(source, /没有待办任务。/, '待办空态文案')
  assert.match(source, /当前没有运行中的调度。/, '调度运行空态文案')
})

test('③ 列表数据取自 dispatch 段，且按 bot 隔离不串台', () => {
  assert.match(source, /state\.data\?\.dispatch\?\.botId === bot\.id \? state\.data\.dispatch : null/, '只认当前 bot 的 dispatch 段')
  assert.match(source, /dispatch\?\.tasks\?\.active \?\? \[\]/)
  assert.match(source, /dispatch\?\.tasks\?\.pending \?\? \[\]/)
  assert.match(source, /dispatch\?\.runs \?\? \[\]/)
})

test('④ 任务行点击跳到该项目的任务页，nav 动作支持带 projectId', () => {
  assert.match(source, /data-action="nav" data-view="tasks" data-project-id="\$\{attr\(task\.project_id/)
  assert.match(source, /const navProjectId = target\.dataset\.projectId/, 'nav 动作应读取 dataset.projectId')
  assert.match(source, /state\.chatMode = 'group'/, '跳项目任务页时切回群聊上下文')
  assert.match(source, /state\.projectId = navProjectId/)
})

test('⑤ 运行行复用 run-clock 与 duration，且调度视图不新增定时器', () => {
  assert.match(source, /class="run-clock" data-started="\$\{attr\(started\)\}">\$\{duration\(started\)\}/, '运行时长复用 run-clock/duration')
  assert.match(source, /const RUN_KIND = \{/, '运行类型名应有中文映射')
  const dispatchBlock = source.slice(source.indexOf('function dispatchTaskRow'), source.indexOf('function renderSoloChat'))
  assert.ok(dispatchBlock.length > 0, '应能定位到调度列表渲染区块')
  assert.doesNotMatch(dispatchBlock, /setInterval|setTimeout/, '调度列表不得新增定时器（沿用 2.8s poll）')
  assert.match(source, /setInterval\(\(\) => \{ void poll\(\) \}, 2800\)/, '仍沿用既有 2.8s 轮询')
})

test('⑥ 子智能体只做空态占位，不造假数据', () => {
  assert.match(source, /子智能体能力待接入（依赖 DSHBOTS-27）。/, '子智能体卡应给出明确的待接入文案与依赖号')
  const card = /<h3>子智能体<\/h3><\/div>\s*<div class="faint">子智能体能力待接入（依赖 DSHBOTS-27）。<\/div>/.exec(source)
  assert.ok(card, '子智能体卡应是纯占位：标题 + 一行说明，没有列表')
  assert.doesNotMatch(source, /subagent/i, '不得出现编造的子智能体数据字段')
})
