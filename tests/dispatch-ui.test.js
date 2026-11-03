// DSHBOTS-28：bot 单聊页升级为「调度页」的 UI 断言。
// 沿用读源码断言的先例（tests/typing-status.test.js 风格）：ui/app.js 是浏览器 IIFE，
// 单测里跑不起来，就锁住关键文案、结构与数据接线。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'

const source = readUiSource()

test('① 更名：导航首 tab、侧卡与入口按钮都改成「调度」口径', () => {
  assert.match(source, /\['chat', '调度', 'message'\]/, '单聊导航首 tab 应显示「调度」')
  assert.match(source, /<h3>\$\{t\('solo\.dispatchTarget'\)\}<\/h3>/, '侧卡标题应为「调度对象」')
  assert.match(source, /<h3>\$\{t\('solo\.recentRuns'\)\}<\/h3>/, '运行侧卡标题应为「最近调度运行」')
  assert.match(source, /t\('solo\.noRuns'\)/, '运行侧卡空态应为「还没有调度运行。」')
  assert.match(source, /t\('viewTitle\.dispatch', \{ name: soloBot\.name \}\)/, '页面标题应带「调度」前缀')
  assert.match(source, /data-action="solo-bot" data-bot-id="\$\{attr\(bot\.id\)\}" title="打开该 Bot 的调度页">调度</, 'Bots 页入口按钮文案应为「调度」')
  assert.doesNotMatch(source, /<h3>单聊对象<\/h3>/, '旧文案「单聊对象」不应残留')
  assert.doesNotMatch(source, /<h3>最近单聊运行<\/h3>/, '旧文案「最近单聊运行」不应残留')
})

test('② 三块列表卡与空态文案齐备：在办 / 待办 / 正在调度', () => {
  assert.match(source, /<h3>\$\{t\('solo\.activeTasks'\)\}<\/h3>/)
  assert.match(source, /<h3>\$\{t\('solo\.pendingTasks'\)\}<\/h3>/)
  assert.match(source, /<h3>\$\{t\('solo\.dispatching'\)\}<\/h3>/)
  assert.match(source, /t\('solo\.noActive'\)/, '在办空态文案')
  assert.match(source, /t\('solo\.noPending'\)/, '待办空态文案')
  assert.match(source, /t\('solo\.noDispatching'\)/, '调度运行空态文案')
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

test('⑥ 子智能体卡如实描述内置能力，不造假数据', () => {
  // DSHBOTS-120 起文案进字典：接线在 app.js（t 调用），实质内容锁在 zh/en 字典值里。
  const zhDict = readFileSync(fileURLToPath(new URL('../ui/i18n/zh.js', import.meta.url)), 'utf8')
  const enDict = readFileSync(fileURLToPath(new URL('../ui/i18n/en.js', import.meta.url)), 'utf8')
  assert.match(zhDict, /bot 会话已内置 subagent \/ subagent_fork \/ workflow 工具/, '中文字典应如实描述已内置的子智能体工具')
  assert.match(enDict, /subagent \/ subagent_fork \/ workflow/, '英文字典同样如实描述')
  const card = /<h3>\$\{t\('solo\.subagents'\)\}<\/h3><\/div>\s*<div class="faint">\$\{t\('solo\.subagentsBody'\)\}<\/div>/.exec(source)
  assert.ok(card, '子智能体卡应保持标题 + 一行说明的结构，没有列表')
  assert.doesNotMatch(source, /待接入/, '不得再出现「待接入」占位文案')
  assert.doesNotMatch(source, /依赖 DSHBOTS-27/, '不得再出现依赖号占位文案')
})
