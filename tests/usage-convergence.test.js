import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'

// DSHBOTS-56 用量信息架构：侧栏入口纯全局（与群聊/单聊上下文零耦合），
// 群聊/单聊 NAV 各自恢复「用量」tab（内容严格限本群/本 bot）。读源码断言（与 workbench-ia 同模式）。
const source = readUiSource()
// NAV/SOLO_NAV 已拆到 modules/state.js（DSHBOTS-15），从模块源码读取。
const stateSource = readFileSync(fileURLToPath(new URL('../ui/modules/state.js', import.meta.url)), 'utf8')

const NAV = /const NAV = \[([\s\S]*?)\n\]/.exec(stateSource)?.[1] ?? ''
const SOLO_NAV = /const SOLO_NAV = \[([\s\S]*?)\n\]/.exec(stateSource)?.[1] ?? ''

// 取某个函数的源码片段（函数体统一两空格缩进收尾）。
function fnBody(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `缺少函数 ${name}`)
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `函数 ${name} 未正常收尾`)
  return source.slice(start, end)
}

test('① 群聊 NAV 与单聊 NAV 均恢复 usage tab', () => {
  assert.match(NAV, /\['usage', '用量', 'chart'\]/, '群聊 NAV 应有「用量」tab')
  assert.match(SOLO_NAV, /\['usage', '用量', 'chart'\]/, '单聊 NAV 应有「用量」tab')
  assert.match(source, /case 'usage': return renderUsage\(\)/, 'render 路由 usage 保留')
})

test('② 侧栏「用量统计」入口固定为全局视图（与上下文零耦合）', () => {
  const idxUsage = source.indexOf("<span>${t('sidebar.usage')}</span>")
  const idxGlobal = source.indexOf("<span>${t('sidebar.globalConfig')}</span>")
  assert.ok(idxUsage >= 0 && idxGlobal >= 0 && idxUsage < idxGlobal, '用量统计在全局配置上方')
  assert.match(
    source,
    /data-action="nav" data-view="usage" data-usage-mode="global"/,
    '侧栏入口带 data-usage-mode="global"',
  )
  // D-9 的上下文收敛默认值必须已经移除。
  assert.ok(!/state\.usageScope = inSoloContext\(\)/.test(source), '不再按上下文选默认口径')
  assert.ok(!/data-scope="solo"/.test(source), '全局视图口径切换不含 solo')
  assert.match(source, /state\.usageMode = target\.dataset\.usageMode === 'solo'/, '入口按 data-usage-mode 决定三态')
})

test('③ 全局视图四类统计齐全（汇总 + 分模型 + 分 Bot + 分项目）', () => {
  const body = fnBody('renderUsageGlobal')
  assert.match(body, /usage\.tiers\?\.global/, '全局视图只取全局口径数据')
  assert.match(body, /分模型/, '有分模型统计')
  assert.match(body, /分 Bot/, '有分 Bot 统计')
  assert.match(body, /分项目/, '有分项目统计')
  assert.match(body, /usageDayPanel\(days\)/, '有按日统计')
  assert.match(fnBody('usageDayPanel'), /近 14 天/, '按日面板标题存在')
  // 口径切换只保留四类：全局 / 按模型 / 按bot / 按项目。
  for (const scope of ['global', 'model', 'bot', 'project']) {
    assert.match(body, new RegExp(`data-scope="${scope}"`), `口径切换含 ${scope}`)
  }
  assert.equal((body.match(/data-action="usage-scope"/g) ?? []).length, 4, '口径切换只有四个选项')
  // 全局视图不展示运行记录：state.data.runs 按上下文收敛，全局口径下会算错。
  assert.ok(!body.includes('运行记录'), '全局视图不展示运行记录')
})

test('④ 群聊「用量」tab 内容严格限本群', () => {
  const body = fnBody('renderUsageDomain')
  assert.match(body, /const totals = usage\.project \?\? \{\}/, '本群汇总取 usage.project')
  assert.match(body, /usage\.tiers\?\.project/, '本群分组取 scopeTiers.project')
  assert.match(body, /本群分模型/, '本群分模型面板')
  assert.match(body, /本群各 Bot/, '本群各 bot 面板')
  assert.ok(!body.includes('data-action="usage-scope"'), '本群 tab 不带全局口径切换')
  assert.ok(!body.includes('usage.tiers?.global'), '本群 tab 不取全局分组数据')
})

test('⑤ 单聊「用量」tab 内容严格限本 bot', () => {
  const body = fnBody('renderUsageSolo')
  assert.match(body, /const totals = usage\.solo \?\? \{\}/, '本 bot 汇总取 usage.solo')
  assert.match(body, /usage\.tiers\?\.solo/, '本 bot 分组取 scopeTiers.solo')
  assert.match(body, /该 Bot 分模型/, '本 bot 分模型面板')
  assert.ok(!body.includes('data-action="usage-scope"'), '单聊 tab 不带全局口径切换')
  assert.match(body, /run\.project_id \?\? null\) === null/, '单聊运行记录只取项目外 run')
})

test('⑥ CSV 导出口径跟随页面口径', () => {
  assert.match(source, /const mode = usageMode\(\)/, '导出按当前页面口径')
  assert.match(source, /if \(mode === 'domain' && project\) payload\.projectId = project\.id/, '本群导出带 projectId')
  assert.match(source, /if \(mode === 'solo' && state\.soloBotId\) payload\.soloBotId = state\.soloBotId/, '单聊导出带 soloBotId')
  assert.ok(!/state\.usageScope === 'solo'/.test(source), '导出不再按全局口径字段判断')
  const apiSource = readFileSync(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8')
  assert.match(apiSource, /soloBotId: payload\.soloBotId \?\? null/, 'export_usage_csv 透传 soloBotId')
})

test('⑦ 三态分派与标题区分', () => {
  assert.match(
    source,
    /function renderUsage\(\) \{[\s\S]*?usageMode\(\) === 'domain'[\s\S]*?renderUsageDomain\(\)[\s\S]*?usageMode\(\) === 'solo'[\s\S]*?renderUsageSolo\(\)[\s\S]*?renderUsageGlobal\(\)/,
    'renderUsage 按三态分派',
  )
  assert.match(source, /state\.view === 'usage' \? usageViewTitle\(\)/, '标题按用量口径区分')
  assert.match(source, /t\('viewTitle\.usageGlobal'\)/, '全局视图标题')
  assert.match(source, /t\('viewTitle\.usageDomainFallback'\)/, '本群视图标题')
  assert.match(source, /t\('viewTitle\.usageSoloFallback'\)/, '单聊视图标题')
})

test('⑧ 服务端口径：全局 / 本群 / 单聊三套 tier 齐备', () => {
  const usageSource = readFileSync(fileURLToPath(new URL('../src/usage.js', import.meta.url)), 'utf8')
  assert.match(
    usageSource,
    /scopeTiers: \{ global: globalTiers, project: projectTiers, solo: soloTiers \}/,
    '三套 scopeTiers 齐备（群内分 bot 走 scopeTiers.project.byBot）',
  )
  assert.match(usageSource, /if \(scope\.soloBotId\) \{[\s\S]*?u\.bot_id = \?', 'u\.project_id IS NULL/, 'solo 口径过滤：该 bot 且项目外')
  const sysSource = readFileSync(fileURLToPath(new URL('../src/services/system.js', import.meta.url)), 'utf8')
  assert.match(sysSource, /soloBotId: soloBotId \?\? null/, 'state 的 usageSnapshot 携带 soloBotId')
})

test('⑨ 全局口径用量页按全局页处理（不渲染项目 tab）', () => {
  assert.match(
    source,
    /const GLOBAL_VIEWS = new Set\(\['global', 'bots-overview', 'channel', 'secrets'\]\)/,
    '全局一级视图集合含迁移新增的通道/密钥页',
  )
  assert.match(
    source,
    /const isGlobal = GLOBAL_VIEWS\.has\(state\.view\) \|\| \(state\.view === 'usage' && usageMode\(\) === 'global'\)/,
    'isGlobal 认全局口径用量页',
  )
  assert.match(source, /\$\{isGlobal \? '' : `<div class="tabbar"/, '项目 tabbar 渲染受 isGlobal 抑制')
})
