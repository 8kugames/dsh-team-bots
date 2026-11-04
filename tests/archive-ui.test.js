// DSHBOTS-10：群聊归档改造的 UI 断言（读源码断言风格，先例 tests/dispatch-ui.test.js）。
// ui/app.js 是浏览器 IIFE 单测跑不起来，锁住抽屉结构、两层确认弹窗、按钮标记与样式接线。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

const source = readUiSource()
const css = await uiStylesSource()

test('① 侧栏树尾「已归档」抽屉：默认收起 + 计数徽标', () => {
  assert.match(source, /tree: \{ chats: true, bots: true, archived: false \}/, 'tree 状态应含 archived:false 默认收起')
  assert.match(source, /data-action="toggle-tree" data-tree="archived"/, '抽屉应有 toggle-tree 通用分发')
  assert.match(source, /<span class="tree-count">\$\{archivedChats\.length\}<\/span>/, '抽屉头应有计数徽标')
  assert.match(source, /const archivedChats = chats\.filter\(item => item\.status !== 'active'\)/, '归档项应按 status 过滤')
})

test('② 抽屉条目：群聊组只列 active，归档项收进抽屉并带操作', () => {
  assert.match(source, /const activeChats = chats\.filter\(item => item\.status === 'active'\)/, '群聊组只列 active 项目')
  assert.match(source, /activeChats\.map\(item =>/, '群聊列表应遍历 activeChats')
  assert.match(source, /archivedChats\.map\(item =>/, '抽屉列表应遍历 archivedChats')
  // DSHBOTS-44：抽屉条目只负责选中，「再开 / 移除追踪」移入项目设置的「项目状态」卡内。
  assert.doesNotMatch(source, /tree-item-actions/, '抽屉条目不再挂逐项操作按钮')
  assert.doesNotMatch(source, /class="tree-act/, '抽屉不再渲染 tree-act 小按钮')
})

test('③ 移除追踪两层确认：后果弹窗 + 复选框默认不勾 + 输入项目名门禁', () => {
  assert.match(source, /case 'remove-tracking': return modalRemoveTracking\(\)/, 'renderModal 应分发 remove-tracking')
  assert.match(source, /<input type="checkbox" id="remove-tracking-purge">/, '复选框不带 checked，默认不勾')
  assert.match(source, /id="remove-tracking-name" name="confirmName"/, '第二步应输入项目名 confirmName')
  assert.match(source, /submitBtn\.disabled = el\.value !== state\.modal\?\.name/, '项目名不一致时执行按钮保持禁用')
  assert.match(source, /id="remove-tracking-submit" disabled>/, '执行按钮初始禁用')
  assert.match(source, /api\('remove_project_tracking', \{\s*projectId: payload\.projectId,\s*confirmName: payload\.confirmName,\s*purgeWorkdir: payload\.purge === '1',/, '提交应带 confirmName 与 purgeWorkdir')
})

test('④ 再开与归档按钮：接线 + 警告色右对齐', () => {
  assert.match(source, /case 'reopen-project': \{/, 'action 分发应有 reopen-project')
  assert.match(source, /await api\('reopen_project', \{ projectId: target\.dataset\.projectId \}\)/, '再开应调 reopen_project')
  assert.match(source, /class="btn small danger" type="button" data-action="archive-project"/, '设置页归档按钮应为 danger 警告色')
  assert.match(source, /justify-content:flex-end/, '归档按钮行应右对齐')
  // 「项目状态」卡内按状态分流：进行中给归档，已归档给再开 + 移除追踪。
  assert.match(source, /data-action="remove-tracking-open" data-project-id="\$\{attr\(project\.id\)\}" data-project-name="\$\{attr\(project\.name\)\}"/, '已归档项目的「移除追踪」应在项目状态卡内')
  assert.match(source, /data-action="reopen-project" data-project-id="\$\{attr\(project\.id\)\}">项目再开</, '已归档项目的「项目再开」应在项目状态卡内')
})

test('⑤ 样式：抽屉操作与移除弹窗列表，颜色只用既有 token', () => {
  assert.doesNotMatch(css, /\.tree-act/, '抽屉小按钮样式应随操作搬走一并删除，不留死 CSS')
  assert.match(css, /\.remove-tracking-list \{/, '移除追踪后果列表样式')
})
