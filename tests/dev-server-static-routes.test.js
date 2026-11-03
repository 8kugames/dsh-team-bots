// 本地预览静态切片与线上路由对齐（DSHBOTS-127）。
// 背景（DSHBOTS-124 预览复现）：scripts/dev-server.js 不提供 /api/dsh-team/i18n/*
// 与 /api/dsh-team/vendor/*，而 ui/modules/i18n.js 以相对路径 import '../i18n/<lang>.js'
// → 浏览器解析成 /api/dsh-team/i18n/<lang>.js，404 让整个 app.js 模块图加载失败，
// 页面停在 boot screen「正在连接团队空间」。线上 src/http.js 有这些路由，故只在预览复现。
// 本文件锁两件事：预览静态切片表的内容，以及它与线上路由不漂移。
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
  const src = await readFile(join(root, 'scripts/dev-server.js'), 'utf8')
  const table = src.match(/const STATIC_SLICES = new Map\(\[([\s\S]*?)\]\)/)
  assert.ok(table, 'scripts/dev-server.js 里找不到 STATIC_SLICES 表')
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
