// DSHBOTS-160 守门：ui/styles.css → ui/styles/*.css 组件域拆分。
// 锁四件事：① 拼接顺序表 UI_STYLE_PARTS 与 ui/styles 目录一致（无孤儿、无缺件、无重复）
// ② ui/styles/*.css 每文件 <800 行（800 行铁律）③ 线上 installHttp 与预览 dev-server
// 共用 readUiStyles 汇总、styles 路由 MIME 精确 'text/css; charset=utf-8'（与 JS MIME
// 守门同口径，不放松）④ 拼接零漂移：readUiStyles 输出与按表独立读取拼接一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_STYLE_PARTS, readUiStyles } from '../src/http.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CSS_MIME = 'text/css; charset=utf-8'

test('UI_STYLE_PARTS 与 ui/styles 目录一致：无孤儿、无缺件、无重复', async () => {
  const dirEntries = (await readdir(join(ROOT, 'ui', 'styles'))).filter((f) => f.endsWith('.css'))
  const listed = UI_STYLE_PARTS.map((p) => p.split('/').pop())
  assert.equal(new Set(listed).size, listed.length, 'UI_STYLE_PARTS 存在重复项')
  for (const f of dirEntries) {
    assert.ok(listed.includes(f), `ui/styles/${f} 不在 UI_STYLE_PARTS（孤儿文件）`)
  }
  for (const p of UI_STYLE_PARTS) {
    const info = await stat(join(ROOT, 'ui', p))
    assert.ok(info.size > 0, `${p} 是空文件`)
  }
})

test('ui/styles/*.css 每文件 <800 行（800 行铁律）', async () => {
  const dir = join(ROOT, 'ui', 'styles')
  const files = (await readdir(dir)).filter((x) => x.endsWith('.css'))
  assert.ok(files.length > 0, 'ui/styles 目录为空')
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf8')
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    assert.ok(lines < 800, `ui/styles/${f} ${lines} 行，超出 800 行铁律`)
  }
})

test('styles 路由双端口径一致：共用 readUiStyles、MIME 精确、入口单 link', async () => {
  const http = await readFile(join(ROOT, 'src/http.js'), 'utf8')
  const dev = await readFile(join(ROOT, 'scripts/dev-server.js'), 'utf8')
  const html = await readFile(join(ROOT, 'ui/index.html'), 'utf8')
  // 线上 styles() 与预览分支都必须走 readUiStyles 汇总（不是各读各的文件）。
  assert.match(
    http,
    /const styles = async \(\) => response\(await readUiStyles\(\), 'text\/css; charset=utf-8'\)/,
  )
  assert.match(dev, new RegExp(`styles\\.css'[\\s\\S]{0,140}?send\\(res, 200, '${CSS_MIME}', await readUiStyles\\(\\)`))
  // 预览不得残留单文件直读旧路径（绕过汇总即双侧漂移风险）。
  assert.ok(!dev.includes("readFile(join(ROOT, 'ui', 'styles.css')"), 'dev-server 不得绕过汇总直读 styles.css')
  // 路由与入口零改动：仍是一条 route + index.html 单 link（版本参数防缓存漂移）。
  assert.ok(http.includes("route('/api/dsh-team/styles.css'"), '线上 styles 路由缺失')
  const links = html.match(/styles\.css/g) ?? []
  assert.equal(links.length, 1, 'index.html 应只有一处 styles.css 引用')
  assert.match(html, /<link rel="stylesheet" href="\/api\/dsh-team\/styles\.css\?v=\{\{assetVersion\}\}">/)
  // 缓存语义不变：走 response() 默认 no-store（与拆分前一致）。
  assert.match(http, /'cache-control': 'no-store'/)
})

test('拼接零漂移：readUiStyles 输出与按表独立读取一致且花括号平衡', async () => {
  const served = await readUiStyles()
  const expected = (
    await Promise.all(UI_STYLE_PARTS.map((p) => readFile(join(ROOT, 'ui', p), 'utf8')))
  ).join('')
  assert.equal(served, expected)
  // 切割不得截断规则块。
  assert.equal((served.match(/{/g) ?? []).length, (served.match(/}/g) ?? []).length)
})

test('终态：巨石 styles.css 已删，顺序表不再引用，首尾域正确', async () => {
  // 5626 行巨石必须由 ui/styles/* 完全取代（过渡态 ['styles.css', ...] 不允许回潮）。
  await assert.rejects(stat(join(ROOT, 'ui', 'styles.css')), /ENOENT/, 'ui/styles.css 应已删除')
  assert.ok(!UI_STYLE_PARTS.includes('styles.css'), 'UI_STYLE_PARTS 不得再引用 styles.css')
  assert.equal(UI_STYLE_PARTS[0], 'styles/base.css', 'base 域必须最前（变量声明）')
  assert.equal(UI_STYLE_PARTS.at(-1), 'styles/terminal.css', 'terminal 域必须最后')
})

// DSHBOTS-184：全局配置页视觉域（ui/styles/global-config.css）必须登记在顺序表里，
// 且只能靠 token 取色——明暗双主题与 Catppuccin 调色板都靠 base.css 的变量覆盖，
// 写死色值等于把主题钉死在这一个文件里。
test('全局配置页视觉域已登记、层叠顺序正确、且不写死色值', async () => {
  const idx = UI_STYLE_PARTS.indexOf('styles/global-config.css')
  assert.ok(idx > 0, 'ui/styles/global-config.css 未登记进 UI_STYLE_PARTS')
  assert.equal(UI_STYLE_PARTS[idx - 1], 'styles/settings.css', 'global-config 域必须紧跟 settings 域')
  const css = await readFile(join(ROOT, 'ui', 'styles', 'global-config.css'), 'utf8')
  for (const selector of ['.global-page', '.global-head', '.global-nav', '.gsec', '.gsec-body', '.g-slot', '.g-move-note']) {
    assert.ok(css.includes(selector), `global-config.css 缺少 ${selector}`)
  }
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), 'global-config.css 不得写死色值（明暗双主题必须走 token）')
})
