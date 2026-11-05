// usage.js —— 用量域（DSHBOTS-121/56）：时间窗快照、用量页与全局视图的用量面板。
// 时间窗状态（usageWindowKey/Cache/Loading/Request）只服务本域，随本文件迁移；
// 切换窗口的入口逻辑 switchUsageWindow 一并迁入（原在 app.js 的 click 委托里）。
import { state, NAV, RUN_STATUS, labelText } from './state.js'
import { icon } from './icons.js'
import { CURRENCY_SYMBOL, attr, botById, costValue, esc, formatCost, formatNumber, pageProject, runDot, timeAgo, toast } from './util.js'
import { api } from './api.js'
import { t } from './i18n.js'
import { renderUsageGlobal, renderUsageDomain, renderUsageSolo } from './settings.js'
import { pageHead, pageSection } from './page-shell.js'
import { render } from '../app.js'

// 用量时间窗（DSHBOTS-121）：今日 / 7 日 / 30 日 / 至今 四档。
// 窗口状态放在模块里（不进全局 state）：只影响用量页，切换后按需向后端取该窗口快照。
let usageWindowKey = '30d'
let usageWindowCache = null
let usageWindowLoading = false
let usageWindowRequest = 0

const USAGE_WINDOWS = [
  { key: 'today', label: '今日' },
  { key: '7d', label: '7 日' },
  { key: '30d', label: '30 日' },
  { key: 'all', label: '至今' },
]

// 时间窗取数上下文：跟页面口径一致——全局不带项目，单聊带 bot，本群带项目。
function usageWindowContext() {
  const project = pageProject()
  const mode = usageMode()
  return {
    projectId: mode === 'domain' && project ? project.id : null,
    soloBotId: mode === 'solo' ? (state.soloBotId ?? null) : null,
  }
}

// 已取到的窗口快照：窗口键与口径都要对得上才算命中，否则回落到 state 里的默认快照。
// 只有用量页用窗口快照，侧栏徽标等其它视图仍读 state 的统一口径。
function usageWindowData() {
  if (!usageWindowCache) return null
  if (state.view !== 'usage') return null
  const ctx = usageWindowContext()
  if (usageWindowCache.key !== usageWindowKey) return null
  if (usageWindowCache.projectId !== ctx.projectId) return null
  if (usageWindowCache.soloBotId !== ctx.soloBotId) return null
  return usageWindowCache.data
}

// 当前窗口的一句话口径说明。
function usageWindowText(usage) {
  const window = usage?.window ?? null
  if (!window) return t('usage.windowTextFallback', { days: Number(usage?.days ?? 30) || 30 })
  if (window.key === 'today') return t('usage.windowTextToday')
  if (window.key === '7d') return t('usage.windowText7d')
  if (window.key === '30d') return t('usage.windowText30d')
  return t('usage.windowTextAll')
}

// 按日面板的标题与说明：跟当前时间窗走；没有窗口信息时回落到旧的 14 天口径。
function usageDayPanelMeta(usage) {
  const key = String(usage?.window?.key ?? '')
  if (key === 'today') return { title: t('usage.dayTitleToday'), note: '产品时区（Asia/Shanghai）当日 0 点起。' }
  if (key === '7d') return { title: t('usage.dayTitle7d'), note: '按产品时区（Asia/Shanghai）日历日分组。' }
  if (key === '30d') return { title: t('usage.dayTitle30d'), note: '按产品时区（Asia/Shanghai）日历日分组。' }
  if (key === 'all') return { title: t('usage.dayTitle30d'), note: '汇总全部历史；日历图只画最近 30 天，更早的调用计入上方汇总。' }
  return { title: '', note: '' }
}

function usageDayTitle(usage) {
  return usageDayPanelMeta(usage).title || t('近 14 天')
}

function usageSnapshot() {
  const raw = usageWindowData() ?? state.data?.usage ?? {}
  const tiers = raw.scopeTiers ?? null
  const legacy = tiers ? null : (raw.scope && typeof raw.scope === 'object' ? raw.scope : null)
  const global = raw.global ?? legacy?.global ?? {}
  const project = raw.project ?? legacy?.project ?? null
  const solo = raw.solo ?? null
  const scope = typeof raw.scope === 'string' ? raw.scope : (project ? 'project' : 'global')
  return { ...raw, tiers, global, project, solo, scope }
}

function usageTotals(scope = state.usageScope) {
  const usage = usageSnapshot()
  if (scope === 'project') return usage.project ?? usage.global ?? {}
  if (scope === 'solo') return usage.solo ?? {}
  return usage.global ?? {}
}

function formatAmount(value) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return '0.00'
  if (n === 0) return '0.00'
  if (Math.abs(n) < 0.01) return n.toFixed(4)
  return n.toFixed(2)
}

// 用量页成本口径（DSHBOTS-81）：预算币种用符号式（¥42.64），其余币种进副行，
// 同页不再混排「CNY 42.64」与「¥0.11」两种写法；小数位规则与全站 formatCost 一致。
function usageCurrency(usage) {
  return String(usage?.currency ?? 'CNY').toUpperCase() || 'CNY'
}

function usageCostParts(totals, currency) {
  const map = totals?.costByCurrency
  const codes = map && typeof map === 'object' ? Object.keys(map).sort() : []
  const budget = String(currency || 'CNY').toUpperCase()
  const primary = codes.includes(budget) ? budget : (codes[0] ?? null)
  if (!primary && (totals?.cost === null || totals?.cost === undefined)) {
    return { code: null, symbol: '', amount: null, others: [] }
  }
  const code = primary ?? budget
  return {
    code,
    symbol: CURRENCY_SYMBOL[code] ?? `${code} `,
    amount: primary ? Number(map[primary] ?? 0) : Number(totals.cost ?? 0),
    others: codes.filter(code2 => code2 !== code).map(code2 => ({ code: code2, amount: Number(map[code2] ?? 0) })),
  }
}

// 成本文本：符号 + 金额；多币种时主币种在前，其余币种跟在后面（不再用 'CNY x / USD y'）。
function usageCostText(totals, currency) {
  const parts = usageCostParts(totals, currency)
  if (!parts.code) return t('usage.costUnconfigured')
  const main = `${parts.symbol.trim()}${formatAmount(parts.amount)}`
  if (!parts.others.length) return main
  return `${main} + ${parts.others.map(other => `${other.code} ${formatAmount(other.amount)}`).join(' + ')}`
}

// 成本单元格只放主币种金额（保证列宽固定不折行），完整多币种金额进 title。
function usageCostPrimaryText(totals, currency) {
  const parts = usageCostParts(totals, currency)
  if (!parts.code) return t('usage.costUnconfigured')
  return formatCost(parts.amount, parts.code)
}

async function exportUsageCsv() {
  const usage = usageSnapshot()
  const project = pageProject()
  const payload: Record<string, unknown> = { days: usage.days ?? 30, window: usageWindowKey }
  // 导出口径跟随当前页面口径（DSHBOTS-56）：
  // global=全局明细（不带任何过滤）；domain=本群明细；solo=该 Bot 的项目外明细。
  const mode = usageMode()
  if (mode === 'domain' && project) payload.projectId = project.id
  if (mode === 'solo' && state.soloBotId) payload.soloBotId = state.soloBotId
  const result = await api('export_usage_csv', payload)
  const csv = String(result?.csv ?? '')
  if (!csv) throw new Error(t('usage.exportEmpty'))
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = result?.filename || 'usage.csv'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast(t('usage.exported'), 'success')
}

// 用量页三态（DSHBOTS-56）：侧栏入口=全局视图（与群聊/单聊上下文零耦合）；
// 群聊 NAV 的「用量」tab=本群口径；单聊 NAV 的「用量」tab=本 bot 口径。
function usageMode() {
  return state.usageMode === 'domain' || state.usageMode === 'solo' ? state.usageMode : 'global'
}

// 页面标题区分三态：全局用量 / 本群用量 / 本 Bot 用量。
function usageViewTitle() {
  if (usageMode() === 'domain') {
    const project = pageProject()
    return project ? t('viewTitle.usageDomain', { name: project.name }) : t('viewTitle.usageDomainFallback')
  }
  if (usageMode() === 'solo') {
    const soloBot = botById(state.soloBotId)
    return soloBot ? t('viewTitle.usageSolo', { name: soloBot.name }) : t('viewTitle.usageSoloFallback')
  }
  return t('viewTitle.usageGlobal')
}

// 用量行内容：名称 / 条形 / tokens / 调用 / 成本 五列。
// 数值列等宽右对齐、单位只出现在表头，行内不塞「次」「CNY」等后缀，杜绝折行。
function usageRowCells(item, label, hint, max, currency) {
  const tokens = Number(item.totalTokens ?? 0)
  const calls = Number(item.calls ?? 0)
  const ratio = tokens > 0 ? Math.min(100, (tokens / (max || 1)) * 100) : 0
  const unpriced = Number(item.unpricedCalls ?? 0)
  const fill = tokens > 0 ? `<span class="usage-fill${unpriced > 0 ? ' partial' : ''}" style="width:${ratio}%"></span>` : ''
  const cost = usageCostPrimaryText(item, currency)
  const costFull = usageCostText(item, currency)
  const costTitle = unpriced > 0 ? `${costFull}${t('usage.partialCostSuffix', { count: unpriced })}` : costFull
  return `<span class="usage-col-name" title="${attr(label + hint)}">${esc(label)}</span>
    <span class="usage-track">${fill}</span>
    <span class="usage-col-num">${formatNumber(tokens)}</span>
    <span class="usage-col-num">${formatNumber(calls)}</span>
    <span class="usage-col-num" title="${attr(costTitle)}">${esc(cost)}</span>`
}

function usageBarRow(item, label, max, currency, hint = '') {
  return `<div class="usage-row">${usageRowCells(item, label, hint, max, currency)}</div>`
}

// 分 bot 行：drillable=true 时可点击查看该 bot 的运行记录。
function usageBotRow(item, max, drillable, currency) {
  const botId = item.botId ?? item.id ?? ''
  const name = String(item.name ?? botById(botId)?.name ?? '').trim() || t('usage.unknownBot')
  const cells = usageRowCells(item, name, '', max, currency)
  if (!drillable) return `<div class="usage-row">${cells}</div>`
  const active = state.usageBot === botId
  return `<button type="button" class="usage-row usage-row-action${active ? ' active' : ''}" data-action="usage-drill" data-bot-id="${attr(botId)}" aria-pressed="${active}" title="${t('usage.drillTitle')}">${cells}</button>`
}

// 分项目行：行首只显示项目名/项目 key，不再回落到 prj_ raw id（D-67 P1-6），原始 id 只进 title。
function usageProjectRow(item, max, currency) {
  const label = String(item.name ?? item.key ?? '').trim() || t('未命名项目')
  const hint = item.projectId ? ` · ${item.projectId}` : ''
  return usageBarRow(item, label, max, currency, hint)
}

// 分布列表面板：表头给出列名与单位，行内只放数值。
function usageListPanel(title, rows, nameLabel) {
  return `<div class="card usage-panel">
    <div class="card-head"><h3>${esc(title)}</h3><span class="meta">${t('usage.count', { count: rows.length })}</span></div>
    ${rows.length === 0 ? `<div class="faint">${t('usage.empty')}</div>` : `<div class="usage-list">
      <div class="usage-list-head">
        <span class="usage-col-name">${esc(nameLabel)}</span>
        <span class="usage-col-bar">${t('tokens 占比')}</span>
        <span class="usage-col-num">${t('tokens')}</span>
        <span class="usage-col-num">${t('调用')}</span>
        <span class="usage-col-num">${t('成本')}</span>
      </div>
      ${rows.join('')}
    </div>
    <div class="usage-legend">
      <span class="usage-legend-item"><i class="usage-swatch"></i>${t('usage.legendPriced')}</span>
      <span class="usage-legend-item"><i class="usage-swatch star"></i>${t('usage.legendPartial')}</span>
      <span class="usage-legend-item"><i class="usage-swatch empty"></i>${t('usage.legendZero')}</span>
    </div>`}
  </div>`
}

function usageRunRow(run) {
  return `<div class="run-row">
    <div class="run-row-top">${runDot(run.status)}<strong class="mono">${esc(String(run.id ?? '').slice(0, 8))}</strong><span>${esc(labelText(RUN_STATUS, run.status, 'runStatus.'))}</span><span style="margin-left:auto">${esc(timeAgo(run.queued_at))}</span></div>
    <div class="run-row-meta"><span>${esc(run.kind || '—')}</span><span>${formatNumber(Number(run.usage_input ?? 0) + Number(run.usage_output ?? 0))} tok</span>${run.usage_cost !== null && run.usage_cost !== undefined ? `<span>${formatCost(run.usage_cost)}</span>` : ''}</div>
  </div>`
}

// 同一模型名可能分属不同 provider（src/usage.js 按 provider+model 分组），用暗色标签区分。
function usageModelCell(item) {
  const provider = String(item.provider ?? '').trim()
  const model = String(item.model ?? '').trim() || t('usage.unknownModel')
  const tag = provider ? `<span class="usage-tag">${esc(provider)}</span>` : ''
  return `${tag}<span class="usage-model-name" title="${attr(model)}">${esc(model)}</span>`
}

function usageModelPanel(byModel, title, headerExtra = '', currency = 'CNY') {
  return `<div class="card usage-panel">
    <div class="card-head"><h3>${esc(title)}</h3>${headerExtra || `<span class="meta">${t('usage.count', { count: byModel.length })}</span>`}</div>
    ${byModel.length === 0 ? `<div class="faint">${t('usage.empty')}</div>` : `<table class="usage-table"><thead><tr><th class="eyebrow mono">${t('模型')}</th><th class="eyebrow mono num">${t('调用')}</th><th class="eyebrow mono num">${t('tokens')}</th><th class="eyebrow mono num">${t('成本')}</th></tr></thead><tbody>${byModel.map(item => `<tr><td class="usage-model-cell">${usageModelCell(item)}</td><td class="mono num">${formatNumber(item.calls)}</td><td class="mono num">${formatNumber(item.totalTokens)}</td><td class="mono num" title="${attr(usageCostText(item, currency))}">${esc(usageCostPrimaryText(item, currency))}</td></tr>`).join('')}</tbody></table>`}
    <div class="usage-note">${t('未配置价格的调用不计入成本合计；价格按每百万 token 配置。')}</div>
  </div>`
}

// 四张 KPI 卡：同字重同字号（成本卡不再降级成小字），标签写清口径。
function usageMetricCards(totals, scopeLabel, usage) {
  const currency = usageCurrency(usage)
  const cost = usageCostParts(totals, currency)
  const windowDays = Number(usage.days ?? 30) || 30
  // 日均按实际跨度折算：今日=1 天，7/30 日=窗口天数，至今=全部历史跨度（后端给 spanDays）。
  const spanDays = Number(usage.window?.spanDays ?? windowDays) || windowDays
  const totalTokens = Number(totals.totalTokens ?? 0)
  const calls = Number(totals.calls ?? 0)
  const dailyTokens = spanDays > 0 ? totalTokens / spanDays : 0
  const perCall = calls > 0 ? totalTokens / calls : 0
  const costValue = cost.code
    ? `<span class="unit">${esc(cost.symbol.trim())}</span>${esc(formatAmount(cost.amount))}`
    : t('usage.costUnconfigured')
  const costMeta = [
    ...cost.others.map(other => t('usage.costOther', { code: other.code, amount: formatAmount(other.amount) })),
    usage.priceCount ? t('usage.priceRules', { count: usage.priceCount }) : t('usage.priceMissing'),
  ].join(' · ')
  return `<div class="metric-grid">
    <div class="card metric">
      <span class="metric-label">${t('总 tokens（${scope}）', { scope: scopeLabel })}</span>
      <strong>${formatNumber(totalTokens)}</strong>
      <small class="mono">${t('usage.totalTokensMeta', { input: formatNumber(totals.inputTokens), output: formatNumber(totals.outputTokens), cache: formatNumber(totals.cacheReadTokens) })}</small>
    </div>
    <div class="card metric">
      <span class="metric-label">${t('调用次数（${scope}）', { scope: scopeLabel })}</span>
      <strong>${formatNumber(calls)}</strong>
      <small class="mono">${t('usage.perCall', { value: formatNumber(perCall) })}</small>
    </div>
    <div class="card metric">
      <span class="metric-label">${t('总成本（${scope}）', { scope: scopeLabel })}</span>
      <strong class="metric-cost">${costValue}</strong>
      <small class="mono">${esc(costMeta)}</small>
    </div>
    <div class="card metric">
      <span class="metric-label">${t('日均 tokens（${scope}）', { scope: scopeLabel })}</span>
      <strong>${formatNumber(dailyTokens)}</strong>
      <small class="mono">${t('usage.dailyMeta', { days: spanDays })}</small>
    </div>
  </div>`
}

function usageDayPanel(days) {
  const usage = usageSnapshot()
  const meta = usageDayPanelMeta(usage)
  const maxDay = Math.max(1, ...days.map(item => item.totalTokens ?? 0))
  const peak = days.reduce((best, day) => ((day.totalTokens ?? 0) > (best?.totalTokens ?? 0) ? day : best), null)
  // 日期轴标签密度：柱子越多列越窄，标签按固定步长取，否则「MM/DD」会被列宽截成「10」。
  const labelStep = days.length > 20 ? 6 : 3
  return `<div class="card usage-panel">
    <div class="card-head"><h3>${esc(usageDayTitle(usage))}</h3>${peak && peak.totalTokens ? `<span class="meta">${t('usage.dayPeak', { value: formatNumber(peak.totalTokens), day: String(peak.day).slice(5) })}</span>` : ''}</div>
    ${days.length === 0 ? `<div class="faint">${t('usage.dayEmpty')}</div>` : `<div class="day-bars">${days.map(day => `<div class="day-bar${day.totalTokens ? '' : ' zero'}" style="height:${Math.max(3, (day.totalTokens ?? 0) / maxDay * 100)}%" title="${esc(day.day)} · ${formatNumber(day.totalTokens)} tokens"></div>`).join('')}</div><div class="day-axis">${days.map((day, index) => `<span title="${esc(day.day)} · ${formatNumber(day.totalTokens)} tokens">${index === 0 || index === days.length - 1 || index % labelStep === 0 ? esc(String(day.day).slice(5).replace('-', '/')) : ''}</span>`).join('')}</div>`}
    <div class="usage-note">${esc(t(meta.note || '日历图只画最近 14 天，更早的调用计入上方汇总。'))}</div>
  </div>`
}

// 用量页区块：序号 + 标题 + 说明 + 12 列槽位网格，与其余三个一级页共用同一分组语言。
function usageSection(index, id, title, desc, body, headExtra = '') {
  return pageSection({ index, id, title, desc, body, headExtra })
}

// 页面头：标题跟随顶栏口径，右侧操作区放四档时间窗切换与 CSV 导出。
// 时间窗切换（DSHBOTS-121）：今日 / 7 日 / 30 日 / 至今；汇总、分布明细、CSV 导出同窗口。
function usagePageHead(usage, scopeText, exportLabel = '') {
  const windowText = usageWindowText(usage)
  const actions = `
      <div class="usage-window-row">
        <span class="usage-window">${t('汇总窗口')}</span>
        <div class="seg" role="group" aria-label="${t('汇总窗口')}">
          ${USAGE_WINDOWS.map(item => `<button data-action="usage-window" data-window="${item.key}" aria-pressed="${usageWindowKey === item.key}"${usageWindowLoading ? ' disabled' : ''}>${t(item.label)}</button>`).join('')}
        </div>
      </div>
      <div class="btn-row">
        <button class="btn" data-action="export-usage-csv">${icon('download')}${t('usage.exportCsv')}${exportLabel ? `（${esc(exportLabel)}）` : ''}</button>
      </div>`
  return pageHead('USAGE', usageViewTitle(), t('usage.headDesc', { scope: scopeText, window: windowText, loading: usageWindowLoading ? t('usage.loading') : '' }), actions)
}

function renderUsage() {
  if (usageMode() === 'domain') return renderUsageDomain()
  if (usageMode() === 'solo') return renderUsageSolo()
  return renderUsageGlobal()
}

// 全局视图：只用全局口径数据，与当前群聊/单聊上下文零耦合。
// 四个维度（趋势 / 分模型 / 分 Bot / 分项目）始终同时展示，口径切换只调展示顺序。

// 时间窗切换入口（DSHBOTS-121）：按需向后端取该窗口快照，不把四档都塞进 state 轮询。
export async function switchUsageWindow(key) {
  if (!key || key === usageWindowKey) return
  const previousKey = usageWindowKey
  const token = ++usageWindowRequest
  const ctx = usageWindowContext()
  usageWindowKey = key
  usageWindowLoading = true
  usageWindowCache = null
  render()
  try {
    const data = await api('usage_window', { projectId: ctx.projectId, soloBotId: ctx.soloBotId, window: key })
    if (token !== usageWindowRequest) return
    usageWindowCache = { key, projectId: ctx.projectId, soloBotId: ctx.soloBotId, data }
  } catch {
    // 取数失败回到原窗口，页面继续用 state 里的默认口径。
    if (token === usageWindowRequest) usageWindowKey = previousKey
  }
  if (token !== usageWindowRequest) return
  usageWindowLoading = false
  render()
}

export { renderUsage, usageWindowText, usageDayTitle, usageSnapshot, usageTotals, usageCurrency, usageMode, usageViewTitle, usageBotRow, usageProjectRow, usageListPanel, usageRunRow, usageModelPanel, usageMetricCards, usageDayPanel, usageSection, usagePageHead, exportUsageCsv }
