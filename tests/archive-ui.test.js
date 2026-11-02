// DSHBOTS-10：群聊归档改造的 UI 断言（读源码断言风格，先例 tests/dispatch-ui.test.js）。
// ui/app.js 是浏览器 IIFE 单测跑不起来，锁住抽屉结构、两层确认弹窗、按钮标记与样式接线。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')

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
  assert.match(source, /data-action="reopen-project" data-project-id="\$\{attr\(item\.id\)\}"/, '归档条目应有「再开」操作')
  assert.match(source, /data-action="remove-tracking-open" data-project-id="\$\{attr\(item\.id\)\}" data-project-name="\$\{attr\(item\.name\)\}"/, '归档条目应有「移除追踪」入口')
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
})

test('⑤ 样式：抽屉操作与移除弹窗列表，颜色只用既有 token', () => {
  assert.match(css, /\.tree-item-actions \{/, '抽屉条目操作容器样式')
  assert.match(css, /\.tree-act\.danger:hover \{/, '移除操作 hover 应有 danger 态')
  assert.match(css, /color-mix\(in srgb, var\(--danger\) 12%, transparent\)/, 'danger 态背景应从 --danger token 派生，不引新色相')
  assert.match(css, /\.remove-tracking-list \{/, '移除追踪后果列表样式')
})
