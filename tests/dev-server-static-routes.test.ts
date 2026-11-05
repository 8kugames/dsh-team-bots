// 本地预览静态切片与线上路由对齐（DSHBOTS-127）。
// 背景（DSHBOTS-124 预览复现）：scripts/dev-server.mjs 不提供 /api/dsh-team/i18n/*
// 与 /api/dsh-team/vendor/*，而 ui/modules/i18n.js 以相对路径 import '../i18n/<lang>.js'
// → 浏览器解析成 /api/dsh-team/i18n/<lang>.js，404 让整个 app.js 模块图加载失败，
// 页面停在 boot screen「正在连接团队空间」。线上 src/http.js 有这些路由，故只在预览复现。
// 本文件锁三件事：预览静态切片表的内容、它与线上路由不漂移、静态路由 MIME 不漂移。
// MIME 守门（DSHBOTS-139）：JS 切片 Content-Type 必须精确等于
// 'text/javascript; charset=utf-8'——ES 模块按 Content-Type 判定可执行性，
// 改 MIME 或漏 charset 会让浏览器拒绝执行模块图，页面回退到模块加载失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 线上路径 → 仓库内文件（相对仓库根）
const EXPECTED = {
  '/api/dsh-team/i18n/zh.js': 'ui/i18n/zh.js',
  '/api/dsh-team/i18n/en.js': 'ui/i18n/en.js',
  '/api/dsh-team/vendor/marked.js': 'vendor/marked/marked.umd.js',
  '/api/dsh-team/vendor/purify.min.js': 'vendor/dompurify/purify.min.js',
}

test('dev-server 静态切片表与预期完全一致', async () => {
  const src = await readFile(join(root, 'scripts/dev-server.mjs'), 'utf8')
  const table = src.match(/const STATIC_SLICES = new Map\(\[([\s\S]*?)\]\)/)
  assert.ok(table, 'scripts/dev-server.mjs 里找不到 STATIC_SLICES 表')
  const entries = [...table[1].matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => [m[1], m[2]])
  assert.deepEqual(Object.fromEntries(entries), EXPECTED)
})

test('静态切片指向的仓库文件存在且非空', async () => {
  for (const rel of Object.values(EXPECTED)) {
    const info = await stat(join(root, rel))
    assert.ok(info.size > 0, `${rel} 是空文件`)
  }
})

test('线上 src/http.js 注册了同一批路径（预览与生产不漂移）', async () => {
  const src = await readFile(join(root, 'src/http.js'), 'utf8')
  for (const path of Object.keys(EXPECTED)) {
    assert.ok(src.includes(`route('${path}'`), `src/http.js 缺少路由 ${path}`)
  }
})

const JS_MIME = 'text/javascript; charset=utf-8'
const HTML_MIME = 'text/html; charset=utf-8'

test('JS 路由 Content-Type 精确等于 JS MIME（app.js/modules/静态切片，预览与线上同口径）', async () => {
  const dev = await readFile(join(root, 'scripts/dev-server.mjs'), 'utf8')
  // dev-server 三条 JS 分支逐一定位：路由匹配之后紧跟 send(res, 200, '<content-type>'
  const devBranches = {
    'app.js': /url\.pathname === '\/api\/dsh-team\/app\.js'[\s\S]{0,200}?send\(res, 200, '([^']+)'/,
    'modules': /url\.pathname\.startsWith\('\/api\/dsh-team\/modules\/'\)[\s\S]{0,400}?send\(res, 200, '([^']+)'/,
    '静态切片': /STATIC_SLICES\.get\(url\.pathname\)[\s\S]{0,200}?send\(res, 200, '([^']+)'/,
  }
  for (const [name, re] of Object.entries(devBranches)) {
    const m = dev.match(re)
    assert.ok(m, `scripts/dev-server.mjs ${name} 分支未找到 send 调用`)
    assert.equal(m[1], JS_MIME, `dev-server ${name} 分支 Content-Type 必须精确等于 ${JS_MIME}`)
  }
  // 漏 charset 守门：任何位置出现不带 '; charset=utf-8' 后缀的 text/javascript 即红。
  assert.equal(dev.match(/text\/javascript(?!; charset=utf-8')/g), null,
    'scripts/dev-server.mjs 存在裸 text/javascript（漏 charset）')
  // 线上同口径：src/http.js 四类 JS handler 全部声明该 MIME，且同样不允许裸 text/javascript。
  const http = await readFile(join(root, 'src/http.js'), 'utf8')
  for (const name of ['script', 'moduleScript', 'i18nDict', 'vendorScript']) {
    assert.match(http, new RegExp(`const ${name} =[\\s\\S]{0,300}?text/javascript; charset=utf-8`),
      `src/http.js 的 ${name} handler 未声明 ${JS_MIME}`)
  }
  assert.equal(http.match(/text\/javascript(?!; charset=utf-8')/g), null,
    'src/http.js 存在裸 text/javascript（漏 charset）')
})

test('{{language}} 占位替换路由替换后仍保持精确 MIME（预览与线上同口径）', async () => {
  const dev = await readFile(join(root, 'scripts/dev-server.mjs'), 'utf8')
  // 预览页面分支：占位替换链挂在 send() 的 body 上，Content-Type 不得随改动漂移。
  const devPage = dev.match(/send\(res, 200, '([^']+)', html[\s\S]{0,150}?replaceAll\('\{\{language\}\}', 'auto'\)/)
  assert.ok(devPage, 'scripts/dev-server.mjs 页面分支未找到 {{language}} 替换链')
  assert.equal(devPage[1], HTML_MIME, `dev-server 页面分支 Content-Type 必须精确等于 ${HTML_MIME}`)
  // 线上 page()：同一替换链，MIME 必须与预览一致。
  const http = await readFile(join(root, 'src/http.js'), 'utf8')
  const httpPage = http.match(/replaceAll\('\{\{language\}\}', language\), '([^']+)'\)/)
  assert.ok(httpPage, 'src/http.js page() 未找到 {{language}} 替换链')
  assert.equal(httpPage[1], HTML_MIME, `src/http.js page() Content-Type 必须精确等于 ${HTML_MIME}`)
})
