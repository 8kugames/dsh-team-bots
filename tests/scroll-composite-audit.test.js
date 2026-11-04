// DSHBOTS-187 守门：全仓「filter 祖先 × 滚动容器」组合审计锁。
// 机制背景（DSHBOTS-166 CDP Tracing 真 GPU 取证）：滚动容器未合成 → 滚动走主线程 →
// 滚动期祖先链被反复重录（实测约三成主帧）→ 带 backdrop-filter 的祖先表面随之重算
// 重栅格 = 肉眼闪烁。滤镜只是被重录的可见性放大器，不是重录的原因。
// 修复口径（D-166 反证背书）：只提升滚动容器（will-change: transform），绝不提升
// filter 元素自身——提升遮罩会使 Paint 面积暴涨 10 倍。
// 本文件与 modal-scroll-stability.test.js（D-154/D-166 的 modal 交互口径 8 例）互不
// 重叠：那侧锁单个弹窗的行为，这侧锁全仓组合面——任何新 CSS 想引入「带滤镜的
// fixed/sticky 表面」或「新的滚动容器」，都必须先在这里登记并过审。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_STYLE_PARTS } from '../src/http.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// —— 登记表：DSHBOTS-187 全仓审计结论（2026-11-04）。改 CSS 前先到这里登记/重审 ——
// verdict 取值：
//   promoted            命中组合（filter 祖先后代滚动容器），已提升 will-change: transform
//   covered             在 .modal-body（D-166 提升点）合成层内，无需自身提升
//   structure-avoided   DOM 结构上滚动容器不在 filter 子树（互为兄弟）
//   no-filter-ancestor  祖先链无 filter 元素，组合不成立
//   leaf                filter 元素无后代（img 叶子）
//   no-scroll-descendant filter 元素无滚动后代
const FILTER_ELEMENTS = [
  { file: 'modal.css', sel: '.modal-backdrop', verdict: 'no-scroll-descendant-unpromoted', note: '后代滚动容器全部经 .modal-body 合成层覆盖（D-166；review.md rev166j：滚动期 .modal-backdrop 已不在 Paint 名单）' },
  { file: 'chat-images.css', sel: '.image-viewer-backdrop', verdict: 'structure-avoided', note: '与 .image-viewer-panel 互为兄弟，滚动容器 .image-viewer-body 在 panel 内（composer.js:451-458 模板）' },
  { file: 'main.css', sel: '.main-head', verdict: 'no-scroll-descendant-unpromoted', note: '子树 3 个滚动容器 .tabbar/.approval-menu/.question-menu 均已各自提升（D-187）；顶栏自身保持不提升' },
  { file: 'global-config.css', sel: '.global-nav', verdict: 'no-scroll-descendant-unpromoted', note: '后代仅 4 个锚链接（settings.js renderGlobal），无滚动容器；自身保持不提升' },
  { file: 'chat-images.css', sel: '.msg-image-tile:hover .msg-image-thumb', verdict: 'leaf', note: 'img 叶子元素，无后代' },
]

const SCROLL_CONTAINERS = [
  { file: 'modal.css', sel: '.modal-body', verdict: 'promoted', note: 'D-166 修复本体（滚动期遮罩不再被重录）' },
  { file: 'modal.css', sel: '.run-output', verdict: 'covered', note: '渲染在 .modal-body 内' },
  { file: 'modal.css', sel: '.detail-pre', verdict: 'covered', note: '渲染在 .modal-body 内' },
  { file: 'settings.css', sel: '.check-list', verdict: 'covered', note: '唯一落点 modal-forms.js 新建项目表单，在 .modal-body 内' },
  { file: 'chat.css', sel: ':is(.message-bubble,.comment-body) pre', verdict: 'covered', note: '双上下文：comment-body 弹窗侧被 .modal-body 覆盖；message-bubble 聊天侧祖先链无 filter' },
  { file: 'chat.css', sel: ':is(.message-bubble,.comment-body) table', verdict: 'covered', note: '同上' },
  { file: 'chat.css', sel: '.chat-messages', verdict: 'no-filter-ancestor', note: '聊天页主列，祖先链无 filter' },
  { file: 'chat-images.css', sel: '.image-viewer-body', verdict: 'structure-avoided', note: '在 .image-viewer-panel 内，与 backdrop 互为兄弟' },
  { file: 'chat-images.css', sel: '.composer-ac', verdict: 'no-filter-ancestor', note: '输入联想面板，祖先链无 filter' },
  { file: 'chat-images.css', sel: '.chat-side', verdict: 'no-filter-ancestor', note: '聊天侧栏，祖先链无 filter' },
  { file: 'wide.css', sel: '.tree-list', verdict: 'no-filter-ancestor', note: '宽屏模式下 .sidebar（sticky 无 filter）内' },
  { file: 'wide.css', sel: '.subpanel-body', verdict: 'no-filter-ancestor', note: '宽屏子面板，祖先链无 filter' },
  { file: 'terminal.css', sel: '.terminal-output', verdict: 'no-filter-ancestor', note: '终端面板，祖先链无 filter' },
  { file: 'terminal.css', sel: '.terminal-history', verdict: 'no-filter-ancestor', note: '终端历史，祖先链无 filter' },
  { file: 'cards.css', sel: '.proposal-body', verdict: 'no-filter-ancestor', note: 'tasks.js 页面内容卡内，祖先链无 filter' },
  { file: 'frame.css', sel: '.tree', verdict: 'no-filter-ancestor', note: '.sidebar（sticky 无 filter）内' },
  { file: 'chat-cards.css', sel: '.approval-menu', verdict: 'promoted', note: 'D-187：经 .approval-banner 渲染在 .main-head（backdrop-filter）子树' },
  { file: 'chat-cards.css', sel: '.question-menu', verdict: 'promoted', note: 'D-187：经 .question-banner 渲染在 .main-head（backdrop-filter）子树' },
  { file: 'main.css', sel: '.tabbar', verdict: 'promoted', note: 'D-187：.main-head（backdrop-filter）子树内的横向滚动' },
]

const STICKY_FIXED = [
  { file: 'base.css', sel: '.skip-link', note: 'fixed，无 filter 无滚动后代' },
  { file: 'toast.css', sel: '#toast-root', note: 'fixed，无 filter 无滚动后代' },
  { file: 'chat-images.css', sel: '.image-viewer', note: 'fixed 容器（backdrop/panel 的父级）' },
  { file: 'modal.css', sel: '.modal-backdrop', note: 'fixed + backdrop-filter（filter 轴已登记）' },
  { file: 'frame.css', sel: '.sidebar', note: 'sticky 无 filter' },
  { file: 'main.css', sel: '.main-head', note: 'sticky + backdrop-filter（filter 轴已登记）' },
  { file: 'global-config.css', sel: '.global-nav', note: 'sticky + backdrop-filter（filter 轴已登记）' },
]

// —— 从服务集 CSS 提取规则（与线上完全同源：UI_STYLE_PARTS + 注释先剥）——
const normSel = (s) => s.replace(/\s+/g, ' ').trim().replace(/\s*,\s*/g, ',')

function splitSelectors(sel) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of sel) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts.map(normSel).filter(Boolean)
}

async function collectRules() {
  const rules = []
  for (const part of UI_STYLE_PARTS) {
    const file = part.split('/').pop()
    const css = await readFile(join(ROOT, 'ui', part), 'utf8')
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const sel of splitSelectors(m[1])) {
        if (sel.startsWith('@')) continue
        rules.push({ file, sel, body: m[2] })
      }
    }
  }
  return rules
}

const isFilterRule = (body) =>
  /(?:^|[\s;])(?:-webkit-)?backdrop-filter\s*:/.test(body) || /(?:^|[\s;])filter\s*:/.test(body)
const isScrollRule = (body) => /overflow(?:-x|-y)?\s*:\s*(?:auto|scroll)\b/.test(body)
const isFixedStickyRule = (body) => /position\s*:\s*(?:fixed|sticky)\b/.test(body)
const key = (e) => `${e.file}:${e.sel}`

function assertSameRegistry(detected, registry, axis, hint) {
  const det = new Set(detected)
  const reg = new Set(registry)
  const extra = detected.filter((k) => !reg.has(k)).sort()
  const missing = registry.filter((k) => !det.has(k)).sort()
  assert.deepEqual(
    extra,
    [],
    `${axis}出现未登记选择器：\n${extra.join('\n')}\n${hint}`,
  )
  assert.deepEqual(
    missing,
    [],
    `${axis}登记项已不存在于 CSS（删除/改名选择器须同步清理登记表）：\n${missing.join('\n')}`,
  )
}

test('filter 轴登记表一致：新增 filter/backdrop-filter 选择器必须先登记过审', async () => {
  const rules = await collectRules()
  const detected = rules.filter((r) => isFilterRule(r.body)).map(key)
  assertSameRegistry(
    detected,
    FILTER_ELEMENTS.map(key),
    'filter 轴',
    '带 filter/backdrop-filter 的元素若同时是 fixed/sticky 或含滚动后代，即命中 D-166 闪烁机制：先审计组合，命中则给滚动容器加 will-change: transform（勿提升 filter 元素自身），再登记。',
  )
})

test('滚动轴登记表一致：新增滚动容器选择器必须先登记过审', async () => {
  const rules = await collectRules()
  const detected = rules.filter((r) => isScrollRule(r.body)).map(key)
  assertSameRegistry(
    detected,
    SCROLL_CONTAINERS.map(key),
    '滚动轴',
    '新滚动容器若落在任何 filter 元素子树内，即命中 D-166 闪烁机制：给滚动容器加 will-change: transform，并更新 FILTER_ELEMENTS/SCROLL_CONTAINERS 与提升清单。',
  )
})

test('定位轴登记表一致：新增 position:fixed/sticky 选择器必须先登记过审', async () => {
  const rules = await collectRules()
  const detected = rules.filter((r) => isFixedStickyRule(r.body)).map(key)
  assertSameRegistry(
    detected,
    STICKY_FIXED.map(key),
    '定位轴',
    'fixed/sticky 是 filter 表面最爱落的位置：新 fixed/sticky 若要带 backdrop-filter 并含滚动后代，按 D-166 口径只提升滚动容器，并同步三张登记表。',
  )
})

test('命中项保持合成化：提升清单恰好 4 项且规则体含 will-change: transform', async () => {
  const rules = await collectRules()
  const byKey = new Map(rules.map((r) => [key(r), r]))
  const promoted = SCROLL_CONTAINERS.filter((e) => e.verdict === 'promoted')
  assert.deepEqual(
    promoted.map(key).sort(),
    ['chat-cards.css:.approval-menu', 'chat-cards.css:.question-menu', 'main.css:.tabbar', 'modal.css:.modal-body'],
    '提升清单只允许显式增删：新增命中按 D-166 口径提升滚动容器后，须同步此清单；移除提升须回到审计结论。',
  )
  for (const e of promoted) {
    const rule = byKey.get(key(e))
    assert.ok(rule, `${key(e)} 规则缺失`)
    assert.match(
      rule.body,
      /will-change\s*:\s*transform/,
      `${key(e)} 必须保持 will-change: transform：去掉后滚动回到主线程，滚动期祖先链重录会让带 backdrop-filter 的祖先表面重算重栅格（D-166 实证闪烁机制）`,
    )
  }
})

test('filter 元素保持不提升：.modal-backdrop/.main-head/.global-nav 不得自带 will-change', async () => {
  const rules = await collectRules()
  const byKey = new Map(rules.map((r) => [key(r), r]))
  for (const [file, sel] of [
    ['modal.css', '.modal-backdrop'],
    ['main.css', '.main-head'],
    ['global-config.css', '.global-nav'],
  ]) {
    const rule = byKey.get(`${file}:${sel}`)
    assert.ok(rule, `${file} ${sel} 规则缺失`)
    assert.ok(
      !/will-change/.test(rule.body),
      `${file} ${sel} 不得自带 will-change：提升 filter 元素自身会使 Paint 面积暴涨（D-166 反证 10 倍量级），修复口径是只提升其滚动后代`,
    )
  }
})

test('DOM 锚：banner/tabbar 仍在 .main-head 子树、查看器 backdrop 与滚动体仍互为兄弟', async () => {
  const appSrc = await readFile(join(ROOT, 'ui', 'app.js'), 'utf8')
  // 两个 banner 直接内插 .main-head（app.js 渲染主模板），这是 .approval-menu/.question-menu
  // 命中组合的结构前提；若横幅迁出 .main-head，须重审两条 promoted 判定。
  assert.match(
    appSrc,
    /<div class="main-head">\s*\$\{approvalBannerView\(/,
    'approval banner 应仍内插在 .main-head 模板内（.approval-menu 的命中前提）',
  )
  assert.match(appSrc, /\$\{questionBannerView\(pendingQuestions\)\}/, 'question banner 内插缺失')
  assert.match(appSrc, /<div class="tabbar"/, '.tabbar 应仍在 .main-head 模板内（app.js:377）')
  // 图片查看器：backdrop 与 panel 互为兄弟、滚动体在 panel 内——「结构上避开」的结构前提。
  const composerSrc = await readFile(join(ROOT, 'ui', 'modules', 'composer.js'), 'utf8')
  const iBackdrop = composerSrc.indexOf('class="image-viewer-backdrop"')
  const iPanel = composerSrc.indexOf('class="image-viewer-panel"')
  const iBody = composerSrc.indexOf('class="image-viewer-body"')
  assert.ok(iBackdrop >= 0 && iPanel > iBackdrop && iBody > iPanel,
    'image-viewer 模板应保持 backdrop 与 panel 兄弟相邻、滚动体 .image-viewer-body 在 panel 内（composer.js:451-458）；结构变更须重审 structure-avoided 判定')
})
