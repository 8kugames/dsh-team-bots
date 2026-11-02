import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// DSHBOTS-9 用量收敛：群聊/单聊用量 tab 移除、侧栏「用量统计」入口、单聊口径。读源码断言（与 workbench-ia 同模式）。
const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')

const NAV = /const NAV = \[([\s\S]*?)\n {2}\]/.exec(source)?.[1] ?? ''
const SOLO_NAV = /const SOLO_NAV = \[([\s\S]*?)\n {2}\]/.exec(source)?.[1] ?? ''

test('① 项目 NAV 与单聊 NAV 均无 usage tab', () => {
  assert.ok(!/\['usage',/.test(NAV), '项目 NAV 不应有用量 tab')
  assert.ok(!/\['usage',/.test(SOLO_NAV), '单聊 NAV 不应有用量 tab')
  assert.match(source, /case 'usage': return renderUsage\(\)/, 'render 路由 usage 保留（侧栏入口使用）')
})

test('② 侧栏「用量统计」入口在全局配置上方（与总览bots同视觉族）', () => {
  const idxUsage = source.indexOf('<span>用量统计</span>')
  const idxGlobal = source.indexOf('<span>全局配置</span>')
  const idxOverview = source.indexOf('data-view="bots-overview"')
  assert.ok(idxUsage >= 0, '侧栏应有用量统计按钮')
  assert.ok(idxGlobal >= 0 && idxUsage < idxGlobal, '用量统计在全局配置上方')
  assert.ok(idxOverview >= 0 && idxOverview < idxUsage, '总览bots 在用量统计上方（同族顺序）')
  assert.match(source, /data-action="nav" data-view="usage"/, '用量统计入口走 nav data-view=usage')
})

test('③ 用量口径随上下文收敛：进入时定默认口径 + solo 口径渲染', () => {
  assert.match(
    source,
    /state\.usageScope = inSoloContext\(\) && state\.soloBotId && state\.data\?\.usage\?\.solo[\s\S]*?pageProject\(\) && state\.data\?\.usage\?\.project/,
    'nav 进入用量页按上下文选默认口径',
  )
  assert.match(source, /data-scope="solo"/, '口径切换含 solo 按钮')
  assert.match(source, /if \(scope === 'solo'\) return usage\.solo \?\? \{\}/, 'usageTotals 支持 solo 口径')
  assert.match(source, /scope === 'solo' \? usage\.tiers\?\.solo/, '分组明细取 scopeTiers.solo')
  assert.match(source, /run\.bot_id === state\.soloBotId && run\.project_id === null/, 'solo 运行记录=该 bot 项目外 run')
  assert.match(source, /口径：\$\{esc\(soloBot/, 'solo 口径说明文案存在')
})

test('④ 单聊口径 CSV 导出走 soloBotId', () => {
  assert.match(source, /if \(state\.usageScope === 'solo' && state\.soloBotId\) payload\.soloBotId = state\.soloBotId/, '导出带 soloBotId')
  const apiSource = readFileSync(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8')
  assert.match(apiSource, /soloBotId: payload\.soloBotId \?\? null/, 'export_usage_csv 透传 soloBotId')
})

test('⑤ 服务端单聊口径：system.state 传 soloBotId，usage.js 过滤项目外', () => {
  const sysSource = readFileSync(fileURLToPath(new URL('../src/services/system.js', import.meta.url)), 'utf8')
  assert.match(sysSource, /soloBotId: soloBotId \?\? null/, 'state 的 usageSnapshot 携带 soloBotId')
  const usageSource = readFileSync(fileURLToPath(new URL('../src/usage.js', import.meta.url)), 'utf8')
  assert.match(usageSource, /if \(scope\.soloBotId\) \{[\s\S]*?u\.bot_id = \?', 'u\.project_id IS NULL/, 'solo 口径过滤：该 bot 且项目外')
})
