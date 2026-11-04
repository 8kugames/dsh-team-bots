import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import {
  USAGE_WINDOW_KEYS,
  USAGE_WINDOW_LABELS,
  resolveUsageWindow,
  usageSnapshot,
} from '../src/usage.js'
import { exportUsageCsv } from '../src/usage-reconcile.js'
import { uiStylesSource } from './ui-styles-source.js'
import { readUiSource } from './helpers/ui-sources.js'

// DSHBOTS-121 用量页时间窗：今日 / 7 日 / 30 日 / 至今 四档。
// 后端口径：今日 = 产品时区（默认 Asia/Shanghai）当日 0 点起；7 日 / 30 日 = 滚动窗口；
// 至今 = 不设下界。窗口起点先换算成 UTC ISO 再与明细的 occurred_at 比较。

const TZ = 'Asia/Shanghai'
// 固定“现在”：2026-11-03 20:00（UTC+8），让边界断言可复现。
const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const DAY_MS = 86_400_000

const source = readUiSource()
const css = await uiStylesSource()
const apiSource = readFileSync(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8')

async function withStore(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-windows-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  try {
    await fn(store)
  } finally {
    try {
      store.close()
    } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

// 造一条用量明细：occurred_at 由测试精确控制（窗口边界的关键）。
function seedEvent(store, { id, occurredAt, tokens = 100, projectId = null, botId = null }) {
  store.run(
    `INSERT INTO usage_events(id, source_key, run_id, project_id, bot_id, task_id, provider, model, purpose,
        currency, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
        input_cost, output_cost, total_cost, occurred_at, created_at)
     VALUES (?, ?, NULL, ?, ?, NULL, 'fake', 'fake-model', 'run', 'CNY', ?, 0, 0, 0, 0, NULL, NULL, NULL, ?, ?)`,
    id, `d121:${id}`, projectId, botId, tokens, occurredAt, occurredAt,
  )
}

function iso(ms) {
  return new Date(ms).toISOString()
}

// 目标时区的挂钟分量（独立于被测实现，用于交叉校验窗口起点）。
function clockIn(timeZone, ms) {
  const parts = {}
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return { ...parts, hour: String(Number(parts.hour) % 24).padStart(2, '0') }
}

test('① 今日窗口：起点是产品时区当日 0 点，快照只含当日明细', async () => {
  const window = resolveUsageWindow('today', { now: NOW, timeZone: TZ })
  assert.equal(window.key, 'today')
  assert.equal(window.label, '今日')
  assert.equal(window.days, 1)
  assert.equal(window.dayCount, 1)
  // 独立校验：窗口起点在目标时区的挂钟必须是当日 00:00。
  const clock = clockIn(TZ, Date.parse(window.since))
  assert.equal(clock.hour, '00', '今日窗口应从本地 0 点起')
  assert.equal(clock.minute, '00')
  assert.equal(clock.day, '03', '起点应是当天的本地日历日')
  assert.equal(clock.month, '11')

  const todayStart = Date.parse(window.since)
  await withStore(store => {
    seedEvent(store, { id: 'today', occurredAt: iso(todayStart + 60 * 60 * 1000), tokens: 120 })
    seedEvent(store, { id: 'yesterday', occurredAt: iso(todayStart - 60 * 60 * 1000), tokens: 999 })

    const snap = usageSnapshot(store, null, 30, { window: 'today', now: NOW, timeZone: TZ })
    assert.equal(snap.window.key, 'today')
    assert.equal(snap.window.spanDays, 1)
    assert.equal(snap.global.calls, 1, '昨日的调用不该进今日窗口')
    assert.equal(snap.global.totalTokens, 120)
    assert.equal(snap.byDay.length, 1, '今日窗口的日历面板只有一根')
    assert.equal(snap.byDay[0].day, '2026-11-03', '日历日按产品时区分组')
  })
})

test('② 滚动窗口：7 日 / 30 日按 now - N 天取起点，超窗明细被排除', async () => {
  const seven = resolveUsageWindow('7d', { now: NOW, timeZone: TZ })
  assert.equal(seven.key, '7d')
  assert.equal(seven.days, 7)
  assert.equal(seven.dayCount, 7)
  assert.equal(seven.since, iso(NOW - 7 * DAY_MS), '7 日窗口是滚动窗口')

  const thirty = resolveUsageWindow('30d', { now: NOW, timeZone: TZ })
  assert.equal(thirty.days, 30)
  assert.equal(thirty.since, iso(NOW - 30 * DAY_MS))

  await withStore(store => {
    seedEvent(store, { id: 'd3', occurredAt: iso(NOW - 3 * DAY_MS), tokens: 300 })
    seedEvent(store, { id: 'd10', occurredAt: iso(NOW - 10 * DAY_MS), tokens: 700 })
    seedEvent(store, { id: 'd40', occurredAt: iso(NOW - 40 * DAY_MS), tokens: 900 })

    const snap7 = usageSnapshot(store, null, 30, { window: '7d', now: NOW, timeZone: TZ })
    assert.equal(snap7.global.calls, 1, '7 日窗口只含 3 天前的明细')
    assert.equal(snap7.global.totalTokens, 300)

    const snap30 = usageSnapshot(store, null, 30, { window: '30d', now: NOW, timeZone: TZ })
    assert.equal(snap30.global.calls, 2, '30 日窗口含 3 天与 10 天前的明细')
    assert.equal(snap30.global.totalTokens, 1000)
    assert.equal(snap30.window.spanDays, 30)
    // 日历面板：7 日窗口画 7 根、30 日窗口画 30 根（含零用量日）。
    assert.ok(snap7.byDay.length <= 7, '7 日窗口的日历根数不超过 7')
    assert.ok(snap30.byDay.length <= 30, '30 日窗口的日历根数不超过 30')
  })
})

test('③ 至今窗口：不设下界，全部历史明细都进汇总，跨度写进 spanDays', async () => {
  const window = resolveUsageWindow('all', { now: NOW, timeZone: TZ })
  assert.equal(window.key, 'all')
  assert.equal(window.label, '至今')
  assert.equal(window.since, null, '至今窗口没有时间下界')
  assert.equal(window.days, null)
  assert.equal(window.dayCount, 30, '至今窗口的日历面板仍封顶 30 根')

  await withStore(store => {
    seedEvent(store, { id: 'old', occurredAt: iso(NOW - 200 * DAY_MS), tokens: 111 })
    seedEvent(store, { id: 'new', occurredAt: iso(NOW - 60 * 60 * 1000), tokens: 222 })

    const snap = usageSnapshot(store, null, 30, { window: 'all', now: NOW, timeZone: TZ })
    assert.equal(snap.global.calls, 2, '至今窗口含全部历史明细')
    assert.equal(snap.global.totalTokens, 333)
    assert.ok(snap.window.spanDays >= 200, 'spanDays 覆盖最早明细到今天的天数')
    // 日历面板只画最近 30 天，更早的调用只进汇总。
    assert.ok(snap.byDay.length <= 30)

    // 导出 CSV 跟随同一窗口：至今导出全部历史。
    const csv = exportUsageCsv(store, { window: 'all' })
    assert.ok(csv.includes(iso(NOW - 200 * DAY_MS)), '至今导出应含最早那条明细')
    const csvToday = exportUsageCsv(store, { window: 'today' })
    assert.ok(!csvToday.includes(iso(NOW - 200 * DAY_MS)), '今日导出不应含历史明细')
  })
})

test('④ 窗口键与元信息：四档齐备、非法键回退 30 日', () => {
  assert.deepEqual(USAGE_WINDOW_KEYS, ['today', '7d', '30d', 'all'])
  assert.deepEqual(USAGE_WINDOW_LABELS, { today: '今日', '7d': '7 日', '30d': '30 日', all: '至今' })
  const fallback = resolveUsageWindow('nope', { now: NOW, timeZone: TZ })
  assert.equal(fallback.key, '30d', '非法窗口键回退 30 日')
  assert.equal(fallback.since, iso(NOW - 30 * DAY_MS))
})

test('⑤ 页面头提供四档时间窗切换，动作走按需取数而非 state 轮询', () => {
  assert.match(source, /const USAGE_WINDOWS = \[/, '四档窗口定义在常量里')
  for (const label of ['今日', '7 日', '30 日', '至今']) {
    assert.ok(source.includes(`label: '${label}'`), `窗口档位含 ${label}`)
  }
  assert.match(source, /data-action="usage-window"/, '页面头有切换按钮')
  assert.match(source, /case 'usage-window':/, '动作分发有 usage-window')
  assert.match(source, /api\('usage_window'/, '切换时按需向后端取该窗口快照')
  assert.match(source, /window: usageWindowKey/, '导出的 CSV 跟随当前窗口')
  // 四档不能塞进 state 轮询：state 里只保留一份默认窗口快照。
  assert.match(apiSource, /'usage_window'/, '服务端登记 usage_window 动作')
  assert.match(apiSource, /service\.usageWindow\(/, 'usage_window 走服务层')
  // 页面头仍然单一声明汇总窗口。
  assert.match(source, /汇总窗口/, '页面头保留汇总窗口声明')
})

test('⑥ 分布明细漏空修复：奇数面板横跨整行，同一行卡片等高', () => {
  assert.match(
    css,
    /\.usage-grid > \.usage-panel:last-child:nth-child\(odd\) \{\s*grid-column: 1 \/ -1;/,
    '奇数个面板时最后一张横跨整行，不留空网格单元',
  )
  assert.match(css, /\.usage-grid \{[^}]*align-items: stretch;/, '同一行的卡片等高')
  assert.match(css, /\.usage-panel \{[^}]*flex-direction: column;/, '卡片内纵向 flex，图例与说明可贴底')
  assert.match(
    css,
    /\.usage-panel > \.usage-legend,\s*\.usage-panel > \.usage-note \{\s*margin-top: auto;/,
    '图例与说明贴到卡片底部，消除下方悬空',
  )
})
