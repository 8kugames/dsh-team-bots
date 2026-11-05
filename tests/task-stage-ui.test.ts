import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

// DSHBOTS-137（工单七态卡 C）UI 接线锁：任务卡与详情的 stage chip 消费 taskView 下发的
// stage/stageLabel（后端 task-stage 纯函数唯一口径），不从 latestRun.status 拼映射；
// 「在等人」的 stage 用暖色强调与机器态区分；state 轮询复用 taskView 现有数据，不新增查询。

const appSource = readUiSource()
const stylesSource = await uiStylesSource()
const systemSource = readFileSync(fileURLToPath(new URL('../src/services/system.js', import.meta.url)), 'utf8')

test('任务卡 stage chip：文案走 stageLabel，「在等人」挂强调类，终态不渲染', () => {
  // chip 文案唯一来源是 taskView 下发的 stageLabel（后端七态查表）。
  assert.match(appSource, /const runLabel = ended \? '' : task\.stageLabel \?\? ''/)
  // person 档（等待你回答/等待验收/需要你处理/等人处理）挂强调类，机器态保持中性。
  assert.match(
    appSource,
    /class="task-run-label\$\{stage\.stage === 'person' \? ' task-stage-person' : ''\}"/,
    'stage chip 必须按 stage 挂 person 强调类',
  )
  // 终态一律不渲染运行点与 chip（ended 语义由后端收死）。
  assert.match(appSource, /\$\{!ended && run \? runDot\(run\.status\) : ''\}/)
  assert.doesNotMatch(appSource, /const runLabel = run \? \(\{/, '不得再用 latestRun.status 映射拼运行文案')
})

test('任务详情 modal 徽标走同一标签口径，ended 空槽由终态时间补位', () => {
  assert.match(appSource, /badge: task\.stageLabel \? esc\(task\.stageLabel\) : endAt \? esc\(/)
})

test('person 强调样式复用既有色 token：不新增色值', () => {
  assert.match(
    stylesSource,
    /\.task-card-foot \.task-run-label\.task-stage-person \{\s*\n\s*color: var\(--star\);/,
    'person chip 颜色必须走 var(--star) 既有 token',
  )
})

test('state 轮询透出：任务视图经 taskView 组装，stage 随现有数据下发、不新增查询', () => {
  assert.match(systemSource, /\.map\(task => this\.taskView\(task\)\)/, 'state 的任务列表必须走 taskView（stage/stageLabel 已在其中）')
})
