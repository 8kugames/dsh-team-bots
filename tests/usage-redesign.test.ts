import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

// DSHBOTS-81 用量统计页重设计：群聊 / 单聊 / 全局三态共用一套视觉骨架。
// 读源码断言（与 usage-convergence 同模式），锁住：标题层级、KPI 口径、数值列对齐、
// 成本写法统一、窗口口径单一、项目行不露 raw id、只用既有 token。
const source = readUiSource()
const css = await uiStylesSource()
// 用量页新增样式块（骨架 + 列表 + 图例），断言只在这一段内做，避免整份 CSS 进失败输出。
const usageCss = css.slice(css.indexOf('/* 用量页骨架'), css.indexOf('.day-bars'))

function fnBody(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `缺少函数 ${name}`)
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `函数 ${name} 未正常收尾`)
  return source.slice(start, end)
}

const VIEWS = ['renderUsageGlobal', 'renderUsageDomain', 'renderUsageSolo']

test('① 三态共用同一套页面骨架（页头 + 序号分组 + 说明副行）', () => {
  for (const fn of VIEWS) {
    const body = fnBody(fn)
    assert.match(body, /usagePageHead\(usage,/, `${fn} 应走统一页面头`)
    assert.ok((body.match(/usageSection\(/g) ?? []).length >= 2, `${fn} 至少两个分组`)
    assert.match(body, /t\('usage\.overview'\)/, `${fn} 应有总览分组`)
    assert.match(body, /t\('usage\.distTitle/, `${fn} 应有分布明细分组`)
  }
  // 分组标题是真实标题（H3，与全局配置页同一层级），不是灰字 caption。
  assert.match(fnBody('pageSection'), /<h3 class="gsec-title" id="\$\{id\}-title">/, '分组标题用 H3')
  assert.match(fnBody('pageSection'), /<p class="gsec-desc">/, '分组标题带说明副行')
  assert.match(fnBody('pageSection'), /<span class="gsec-index mono">\$\{index\}<\/span>/, '分组带序号')
  assert.match(fnBody('pageSection'), /aria-labelledby="\$\{id\}-title"/, '分组与标题 aria 关联')
  // 顶栏 H1 不再被 caption 复述。
  assert.ok(!source.includes('本群用量 · '), '不再渲染与 H1 重复的本群 caption')
  assert.ok(!source.includes('本 Bot 用量 · '), '不再渲染与 H1 重复的单聊 caption')
})

test('② KPI 四卡口径写清，且不再有错名卡与假窗口卡', () => {
  const body = fnBody('usageMetricCards')
  assert.match(body, /总 tokens（/, '有总 tokens 卡')
  assert.match(body, /调用次数（/, '有调用次数卡')
  assert.match(body, /总成本（/, '有总成本卡')
  assert.match(body, /日均 tokens（/, '有日均 tokens 卡')
  assert.ok(!body.includes('模型调用'), '不再有名不副实的「模型调用」卡')
  assert.ok(!body.includes('统计窗口'), '不再有常量占位的统计窗口卡')
  // 窗口口径来自服务端真实值，不是写死的常量。
  assert.match(body, /Number\(usage\.days \?\? 30\)/, '窗口天数取服务端 usage.days')
  // DSHBOTS-121：窗口口径从写死的「近 N 天」常量改成四档可切换（今日 / 7 日 / 30 日 / 至今）。
  assert.match(fnBody('usagePageHead'), /汇总窗口/, '页面头单一声明汇总窗口')
  assert.match(fnBody('usagePageHead'), /data-action="usage-window"/, '页面头提供四档时间窗切换')
})

test('③ 成本写法统一为符号式，同页不再混排 CNY 与 ¥', () => {
  assert.ok(!source.includes('function costSplit('), '旧的 costSplit（CNY 42.64 写法）已移除')
  assert.match(fnBody('usageCostText'), /formatAmount/, '成本文本走统一小数位规则')
  assert.match(fnBody('usageCostPrimaryText'), /formatCost\(parts\.amount, parts\.code\)/, '单元格成本用全站 formatCost 符号式')
  // 表格与列表单元格只放主币种金额，完整多币种金额进 title，避免列宽被撑开折行。
  assert.match(fnBody('usageRowCells'), /usageCostPrimaryText\(item, currency\)/, '列表成本单元格用主币种金额')
  assert.match(fnBody('usageModelPanel'), /title="\$\{attr\(usageCostText\(item, currency\)\)\}"/, '模型表成本列完整金额进 title')
})

test('④ 分布列表：五列等宽、数值右对齐、行内不折行', () => {
  const body = fnBody('usageListPanel')
  for (const label of ['tokens 占比', 'tokens', '调用', '成本']) {
    assert.ok(body.includes(label), `表头应有「${label}」列`)
  }
  const row = fnBody('usageRowCells')
  assert.ok(!row.includes('次<'), '行内不再带「次」后缀')
  assert.ok(!row.includes('CNY '), '行内不再用 CNY 代码式金额')
  // 样式：数值列固定宽度 + 右对齐 + 等宽数字。
  assert.match(usageCss, /\.usage-col-num \{[^}]*text-align: right;/, '数值列右对齐')
  assert.match(usageCss, /\.usage-col-num \{[^}]*font-variant-numeric: tabular-nums;/, '数值列用等宽数字')
  assert.match(
    usageCss,
    /\.usage-list-head,\s*\.usage-row \{[^}]*grid-template-columns:[^;]*;/,
    '表头与数据行共用同一套列宽定义',
  )
  assert.match(usageCss, /\.usage-col-num \{[^}]*white-space: nowrap;/, '数值单元格不折行')
  assert.match(usageCss, /\.usage-col-name \{[^}]*white-space: nowrap;/, '名称列省略号截断而非折行')
})

test('⑤ 条形有语义：零用量不画假条，未计价调用用琥珀色', () => {
  const row = fnBody('usageRowCells')
  assert.match(row, /tokens > 0 \? `/, '零用量不画条形')
  assert.ok(!/Math\.max\(2,/.test(row), '不再强制最小 2% 假条')
  assert.match(row, /unpriced > 0 \? ' partial'/, '未计价调用用独立样式')
  assert.match(css, /\.usage-fill\.partial \{\s*background: var\(--star\);/, '未计价条形用 --star')
  assert.match(css, /\.usage-fill \{\s*display: block;\s*height: 100%;\s*background: var\(--accent\);/, '正常条形用 --accent')
  // 图例说明色义。
  assert.match(source, /usage-legend/, '列表面板带图例')
})

test('⑥ 成本卡与其余 KPI 卡同字号（不再降级成小字）', () => {
  assert.ok(!/\.metric strong\.metric-cost \{\s*font-size: var\(--fs-title\);/.test(css), '成本卡不再用 18px 降级')
  assert.match(css, /\.metric strong \{\s*display: block;\s*margin-top: 6px;\s*font: 500 2rem\/1\.1 var\(--mono\);/, '四张 KPI 卡共用同一字号字重')
  assert.match(fnBody('usageMetricCards'), /class="metric-cost"/, '成本卡仍标记 metric-cost 以便微调符号')
})

test('⑦ 分项目行首不再泄漏 prj_ raw id', () => {
  const body = fnBody('usageProjectRow')
  assert.match(body, /item\.name \?\? item\.key/, '项目名优先取 name / key')
  assert.match(body, /'未命名项目'/, '缺名回落为可读名称')
  assert.ok(!/usageBarRow\(item, item\.projectId/.test(body), '不把 raw id 当行首标签')
  assert.match(body, /hint = item\.projectId \?/, 'raw id 只进 title 提示')
})

test('⑧ 重设计只使用既有 token，不新增色值', () => {
  const start = css.indexOf('/* 用量页骨架')
  assert.ok(start >= 0, '缺少用量页骨架样式块')
  const end = css.indexOf('.day-bars', start)
  assert.ok(end > start, '用量页骨架样式块未正常收尾')
  const block = css.slice(start, end)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), '样式块不得出现十六进制色值')
  assert.ok(!/rgba?\(/i.test(block), '样式块不得出现 rgb/rgba 字面色值')
  assert.match(block, /var\(--accent\)/, '条形用既有 accent token')
  assert.match(block, /var\(--star\)/, '未计价条形用既有 star token')
})

// DSHBOTS-142 用量页提示文案精简：只保留玩家能据以行动的规则信息，删纯实现口径说明。
// 读源码断言（与本文件同模式）：旧文案不再出现、精简后的文案仍在、每条提示只占一行。
const USAGE_PAGE_FNS = ['usageModelPanel', 'usageDayPanel', 'renderUsageGlobal', 'renderUsageDomain', 'renderUsageSolo']

test('⑨ 用量页提示精简：实现口径说明已删，玩家可据以行动的信息仍在', () => {
  // 已删 / 已改写的旧文案不再出现在源码里。
  for (const gone of [
    '未配置价格的成本不会按 0 计费',
    '按日明细由服务端保留最近 14 天',
    '服务端尚未按口径过滤明细',
    '服务端尚未提供本群口径明细',
    '服务端尚未提供该 Bot 的单聊口径明细',
    '今日口径：产品时区（Asia/Shanghai）当日 0 点起。',
    '滚动 7 天窗口，按产品时区日历日分组。',
    '滚动 30 天窗口，按产品时区日历日分组。',
    '至今窗口汇总全部历史；',
    '下方分组为全局数据',
  ]) {
    assert.ok(!source.includes(gone), `旧文案「${gone}」应已移除`)
  }
  // 精简后的玩家视角文案仍在。
  for (const kept of [
    '未配置价格的调用不计入成本合计；价格按每百万 token 配置。',
    '日历图只画最近 14 天，更早的调用计入上方汇总。',
    '下方分组明细暂不可用，上方汇总仍按本群统计。',
    '该 Bot 的单聊明细暂不可用。',
    '产品时区（Asia/Shanghai）当日 0 点起。',
    '按产品时区（Asia/Shanghai）日历日分组。',
    '汇总全部历史；日历图只画最近 30 天，更早的调用计入上方汇总。',
  ]) {
    assert.ok(source.includes(kept), `精简文案「${kept}」应保留`)
  }
  // 对账不一致提示可据以行动（数据可能不完整），保留不动。
  assert.ok(source.includes('数据可能不完整'), '对账不一致提示应保留')
  // 全局视图不再挂「服务端尚未按口径过滤」这类开发元信息（该视图本来就展示全局数据）。
  assert.ok(!fnBody('renderUsageGlobal').includes('usage.legacy'), '全局视图不再渲染 legacy 实现说明')
  // 本群 / 单聊视图的分组面板回落的是空数组（tier?.byModel ?? []），不是全局数据，
  // 因此提示不得声称「下方分组为全局数据」——那会让玩家以为看到的是全局口径。
  assert.match(fnBody('renderUsageDomain'), /tier \? '' :/, '本群提示按本群 tier 判定')
  assert.match(fnBody('renderUsageSolo'), /usage\.solo && tier \? ''/, '单聊提示按单聊 tier 判定')
})

test('⑩ 用量页每条提示只占一行，不堆解释', () => {
  for (const fn of USAGE_PAGE_FNS) {
    const body = fnBody(fn)
    const opened = body.split('<div class="usage-note">').length - 1
    const notes = [...body.matchAll(/<div class="usage-note">(.*?)<\/div>/g)].map((m) => m[1])
    assert.equal(notes.length, opened, `${fn} 的提示不应跨行渲染`)
    for (const note of notes) {
      const text = note.replace(/\$\{[^}]*\}/g, '').trim()
      if (!text) continue
      assert.ok(!text.includes('\n'), `${fn} 的提示不应换行`)
      assert.ok((text.match(/。/g) ?? []).length <= 1, `${fn} 的提示只保留一句：${text}`)
      assert.ok(text.length <= 40, `${fn} 的提示不超过 40 字：${text}`)
      // 本群 / 单聊视图的分组面板回落的是空数组（tier?.byModel ?? []），不是全局数据，
      // 提示若声称「全局数据」即为不实口径。
      assert.ok(!text.includes('全局数据'), `${fn} 的提示不得声称分组是全局数据：${text}`)
    }
  }
  // 按日面板的兜底说明（meta.note 缺失时）同样是一句话。
  const fallback = '日历图只画最近 14 天，更早的调用计入上方汇总。'
  assert.equal((fallback.match(/。/g) ?? []).length, 1, '兜底说明只保留一句')
  assert.ok(fallback.length <= 40, '兜底说明不超过 40 字')
  // 四档时间窗的说明同样是一句话，且不重复页面头已声明的窗口标签。
  const meta = fnBody('usageDayPanelMeta')
  const windowNotes = [...meta.matchAll(/note: t\("([^"]*)"\)/g)].map((m) => m[1]).filter(Boolean)
  assert.equal(windowNotes.length, 4, '四档时间窗各有一条说明')
  for (const note of windowNotes) {
    assert.equal((note.match(/。/g) ?? []).length, 1, `窗口说明只保留一句：${note}`)
    assert.ok(note.length <= 40, `窗口说明不超过 40 字：${note}`)
  }
  assert.ok(!windowNotes.some((n) => n.includes('滚动 7 天窗口') || n.includes('滚动 30 天窗口')), '窗口说明不重复页面头的窗口标签')
})
