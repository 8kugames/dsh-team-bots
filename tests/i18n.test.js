// tests/i18n.test.js —— DSHBOTS-120 Phase 1：locale 读取链、t() 行为与注入接线。
// 三层：①src/services/locale.js 纯函数 + 三级兜底（临时 dshHome，不碰真实 ~/.dsh）；
// ②ui/modules/i18n.js 的 t() 插值/回退；③http.js / index.html / system.js / app.js 注入接线守门。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clampLocaleId,
  localePreferenceFromLoader,
  localePreferenceFromPatchYml,
  resolveDshUiLanguage,
} from '../src/services/locale.js'
import { t, setLanguage, getLanguage, normalizeLanguage } from '../ui/modules/i18n.js'
import zh from '../ui/i18n/zh.js'
import en from '../ui/i18n/en.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

// —— ① clampLocaleId：BCP47 前缀收敛，非法/空 → null（=无显式设定） ——
test('clampLocaleId：en*/zh* 前缀收敛，其余 null', () => {
  assert.equal(clampLocaleId('en'), 'en')
  assert.equal(clampLocaleId('en-US'), 'en')
  assert.equal(clampLocaleId('  ZH-CN '), 'zh')
  assert.equal(clampLocaleId('zh'), 'zh')
  assert.equal(clampLocaleId('fr'), null)
  assert.equal(clampLocaleId(''), null)
  assert.equal(clampLocaleId(null), null)
  assert.equal(clampLocaleId(undefined), null)
})

// —— ② patch 文件静态扫描：真实 profile 片段（引号值/多插件条目/无 preference） ——
test('localePreferenceFromPatchYml：命中 locale 条目的 preference', () => {
  const yml = [
    '- id: web-server',
    '  name: "@deepseek-ai/dsh-web-server"',
    '  config:',
    '    port: 8080',
    '- id: locale',
    '  name: "@deepseek-ai/dsh-client-locale"',
    '  config:',
    '    preference: en',
    '- id: other',
    '  name: "@example/other"',
    '  config:',
    '    preference: zh',
  ].join('\n')
  assert.equal(localePreferenceFromPatchYml(yml), 'en')
  // 值带引号同样剥掉；首个 preference 生效。
  assert.equal(localePreferenceFromPatchYml(yml.replace('preference: en', "preference: 'zh'")), 'zh')
  // 没有 locale 条目 → null；条目存在但没有 preference → null。
  assert.equal(localePreferenceFromPatchYml('- id: web-server\n  name: "@deepseek-ai/dsh-web-server"'), null)
  assert.equal(localePreferenceFromPatchYml('- id: locale\n  name: "@deepseek-ai/dsh-client-locale"\n  config:\n    auto: true'), null)
  assert.equal(localePreferenceFromPatchYml(''), null)
})

// —— ③ loader 直读：entries() 优先、fiber.config 活值优先于 options 原始值 ——
test('localePreferenceFromLoader：fiber 活配置优先，store 兜底，无条目 null', () => {
  const entry = {
    options: { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh' } },
    fiber: { config: { preference: 'en' } },
  }
  assert.equal(localePreferenceFromLoader({ entries: () => [entry] }), 'en')
  const optionsOnly = { options: { id: 'locale', config: { preference: 'zh' } } }
  assert.equal(localePreferenceFromLoader({ entries: () => [optionsOnly] }), 'zh')
  // store 形态（Dict extends Map）：values() 迭代同样命中；按包名兜底命中。
  const byName = { options: { id: 'x', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'en' } } }
  assert.equal(localePreferenceFromLoader({ store: new Map([['x', byName]]) }), 'en')
  assert.equal(localePreferenceFromLoader({ entries: () => [{ options: { id: 'other' } }] }), null)
  assert.equal(localePreferenceFromLoader(null), null)
})

// —— ④ 三级兜底编排：loader > patch 文件 > 'auto'（临时目录，不碰真实 ~/.dsh） ——
test('resolveDshUiLanguage：loader 优先、文件兜底、缺省 auto、非法值不采信', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-i18n-'))
  const profiles = join(home, 'profiles', 'team-bots')
  mkdirSync(profiles, { recursive: true })
  const patchPath = join(profiles, 'cordis.patch.yml')
  try {
    writeFileSync(patchPath, '- id: locale\n  name: "@deepseek-ai/dsh-client-locale"\n  config:\n    preference: en\n')
    // loader 命中时文件不读：loader=zh，文件=en → zh。
    assert.equal(await resolveDshUiLanguage({ loader: { entries: () => [{ options: { id: 'locale', config: { preference: 'zh' } } }] }, dshHome: home }), 'zh')
    // loader 不可达 → 文件兜底。
    assert.equal(await resolveDshUiLanguage({ dshHome: home }), 'en')
    // 文件值非法（fr）→ 不采信 → auto。
    writeFileSync(patchPath, '- id: locale\n  name: "@deepseek-ai/dsh-client-locale"\n  config:\n    preference: fr\n')
    assert.equal(await resolveDshUiLanguage({ dshHome: home }), 'auto')
    // 文件不存在 → auto。
    rmSync(patchPath)
    assert.equal(await resolveDshUiLanguage({ dshHome: home }), 'auto')
    assert.equal(await resolveDshUiLanguage({}), 'auto')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// —— ⑤ t()：插值、双语切换、缺 key 回退 ——
test('t()：${name} 插值与中英切换', () => {
  setLanguage('zh')
  assert.equal(getLanguage(), 'zh')
  assert.equal(t('common.more', { count: 3 }), '还有 3 条')
  assert.equal(t('toast.copied'), '已复制')
  setLanguage('en')
  assert.equal(getLanguage(), 'en')
  assert.equal(t('toast.copied'), 'Copied')
  const more = t('common.more', { count: 3 })
  assert.ok(!more.includes('${'), '插值后不应残留 ${count} 占位')
  assert.ok(more.includes('3'), '插值后的计数应出现')
  setLanguage('zh')
})

test('t()：缺 params 的插值名保留占位；两不存在的 key 回退 key 本身并 console.warn', () => {
  setLanguage('zh')
  assert.equal(t('common.more', {}), '还有 ${count} 条')
  const warns = []
  const original = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  try {
    assert.equal(t('no.such.key'), 'no.such.key')
    assert.ok(warns.some(line => line.includes('missing key: no.such.key')), '缺 key 应 console.warn 留痕')
    // 当前语言缺 key（人为摘一个）→ 回退中文原文并 warn。
    const saved = en['toast.copied']
    delete en['toast.copied']
    setLanguage('en')
    assert.equal(t('toast.copied'), '已复制')
    assert.ok(warns.some(line => line.includes('fallback to zh')), '回退中文应 warn 留痕')
    en['toast.copied'] = saved
  } finally {
    console.warn = original
    setLanguage('zh')
  }
})

test('normalizeLanguage：auto/空跟随 navigator 前缀，非法缺省 zh', () => {
  assert.equal(normalizeLanguage('en'), 'en')
  assert.equal(normalizeLanguage('en-GB'), 'en')
  assert.equal(normalizeLanguage('zh-CN'), 'zh')
  assert.equal(normalizeLanguage('fr'), 'zh')
  // auto/空 = 跟随浏览器语言：Node ≥21 自带 navigator（通常 en-US）→ en；无 navigator → zh。
  const navLang = String(globalThis.navigator?.language ?? '').toLowerCase()
  assert.equal(normalizeLanguage('auto'), navLang.startsWith('en') ? 'en' : 'zh')
  assert.equal(normalizeLanguage(''), navLang.startsWith('en') ? 'en' : 'zh')
})

// —— ⑥ 注入接线守门：服务端注入点 + 客户端启动接线 ——
test('注入接线：http.js {{language}} 占位与 i18n 模块路由', () => {
  const http = read('src/http.js')
  assert.match(http, /replaceAll\('\{\{language\}\}', language\)/, 'page() 应注入 {{language}}')
  assert.match(http, /resolveUiLanguage\(\{\s*loader: ctx\.get\('loader'\)/, '经 resolveUiLanguage 收敛（页面保存值 > 宿主解析）')
  assert.match(http, /effectiveUiLanguage\(service\.config/, '页面保存值经 effectiveUiLanguage 读取')
  assert.match(http, /modules\/i18n\.js', \['GET'\], moduleScript\('i18n\.js'\)/, 'ui/modules/i18n.js 应有模块路由')
  assert.match(http, /i18n\/zh\.js', \['GET'\], i18nDict\('zh\.js'\)/, 'ui/i18n/zh.js 应有路由')
  assert.match(http, /i18n\/en\.js', \['GET'\], i18nDict\('en\.js'\)/, 'ui/i18n/en.js 应有路由')
})

test('注入接线：index.html data-dsh-language 与 system.js state.language 同源透传', () => {
  const html = read('ui/index.html')
  assert.match(html, /data-dsh-language="\{\{language\}\}"/, 'html 标签应带 language 占位')
  const sys = read('src/services/system.js')
  assert.match(sys, /language: await resolveUiLanguage\(/, 'state() 顶层应透传 language')
  assert.match(sys, /effectiveUiLanguage\(this\.config/, '页面保存值经 effectiveUiLanguage 读取')
})

test('注入接线：app.js boot 接线与热切换 syncLanguage', () => {
  const app = read('ui/app.js')
  assert.match(app, /import \{ t, setLanguage \} from '\.\/modules\/i18n\.js'/, 'app.js 应引入 i18n')
  assert.match(app, /document\.documentElement\.dataset\.dshLanguage/, 'boot 阶段应读注入的 data-dsh-language')
  assert.match(app, /function syncLanguage\(\)/, '应有 syncLanguage 热切换函数')
  assert.match(app, /toast\(t\('toast\.languageSwitched'\), 'success'\)/, '语言变化应有轻提示')
})

// —— ⑦ 字典完整性：zh/en key 集合一致、规模达标、zh 值非空 ——
test('字典完整性：zh/en key 一一对应且 ≥150 项，zh 值非空', () => {
  const zhKeys = Object.keys(zh)
  const enKeys = Object.keys(en)
  assert.ok(zhKeys.length >= 150, `字典应 ≥150 项（实际 ${zhKeys.length}）`)
  assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), 'zh 与 en 的 key 集合应完全一致')
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, 'string', `zh[${key}] 应为字符串`)
    assert.ok(value.length > 0, `zh[${key}] 不应为空文案`)
  }
})

// —— ⑧ 字典占位守门（DSHBOTS-147）：t() 只替换 ${\w+}，占位写成别的形态（如 @{name}）永远原样渲染 ——
test('字典守门：全字典不得出现 @{ 占位形态（t() 不认，会原样渲染成字面量）', () => {
  // 源文件层面：连注释里也不许再出现 @{，避免错误形态被复制。
  for (const rel of ['ui/i18n/zh.js', 'ui/i18n/en.js']) {
    assert.ok(!read(rel).includes('@{'), `${rel} 全文件不得出现 @{ 占位形态`)
  }
  // 值层面：逐条扫描两本字典的运行时内容。
  for (const [lang, dict] of [['zh', zh], ['en', en]]) {
    for (const [key, value] of Object.entries(dict)) {
      assert.ok(!value.includes('@{'), `${lang}[${key}] 占位不得写成 @{…} 形态`)
    }
  }
})

test('字典守门：插值占位必须是 ${\\w+} 形态，与 t() 的正则一致', () => {
  for (const [lang, dict] of [['zh', zh], ['en', en]]) {
    for (const [key, value] of Object.entries(dict)) {
      for (const placeholder of value.matchAll(/\$\{([^}]*)\}/g)) {
        assert.match(placeholder[1], /^\w+$/, `${lang}[${key}] 占位名须为 \\w+（实际 "${placeholder[1]}"），t() 的 /\\$\\{(\\w+)\\}/ 替换不到`)
      }
    }
  }
})

test('字典守门：用户实证的三键 t() 实测插值成功，无 @{ 残留', () => {
  // viewTitle.dispatch / config / usageSolo 曾整键写成 @{name} 原样渲染（DSHBOTS-147 问题①）。
  for (const lang of ['zh', 'en']) {
    setLanguage(lang)
    for (const key of ['viewTitle.dispatch', 'viewTitle.config', 'viewTitle.usageSolo']) {
      const rendered = t(key, { name: 'x' })
      assert.ok(rendered.includes('x'), `${lang} ${key} 应完成 name 插值（实际 "${rendered}"）`)
      assert.ok(!rendered.includes('@{'), `${lang} ${key} 不应残留 @{name} 字面量（实际 "${rendered}"）`)
    }
  }
  setLanguage('zh')
})
