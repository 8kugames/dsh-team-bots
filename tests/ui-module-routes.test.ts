// 模块切片路由覆盖锁：ui 侧被 import 的每个 ES 模块切片都必须在 src/http.js 有精确路由。
// 背景：bridge 路由是精确路径（无前缀兜底），漏注册 = 浏览器模块图加载失败 → app.js
// 永不执行 → 工作台卡在「正在连接团队空间」。预览服 scripts/dev-server.mjs 按前缀兜底，
// 预览期看不出来，只在线上炸；本锁把「新增切片必须注册路由」变成可检索的断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, posix, dirname } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const UI = join(ROOT, 'ui')
const MODULES_DIR = join(UI, 'modules')
const I18N_DIR = join(UI, 'i18n')
const http = readFileSync(join(ROOT, 'src/http.js'), 'utf8')

// app.js 挂在 /api/dsh-team/，modules/*.js 挂在 /api/dsh-team/modules/，
// i18n/*.js 挂在 /api/dsh-team/i18n/ —— 浏览器按 import 说明符相对解析，与服务端路由同构。
const ROUTE_PREFIX = '/api/dsh-team'

// 收集 ui 侧全部相对 import 目标 → 其浏览器 URL 路径。
function collectImportedSlices() {
  const sources = [
    { file: 'app.js', urlPath: 'app.js', source: readFileSync(join(UI, 'app.js'), 'utf8') },
    ...readdirSync(MODULES_DIR)
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => ({
        file: `modules/${name}`,
        urlPath: `modules/${name}`,
        source: readFileSync(join(MODULES_DIR, name), 'utf8'),
      })),
    // DSHBOTS-233：词表按域拆分后，i18n 聚合入口相对导入域切片，同样纳入覆盖锁。
    ...readdirSync(I18N_DIR)
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => ({
        file: `i18n/${name}`,
        urlPath: `i18n/${name}`,
        source: readFileSync(join(I18N_DIR, name), 'utf8'),
      })),
  ]
  const slices = new Map()
  for (const { file, urlPath, source } of sources) {
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = posix.normalize(posix.join(dirname(urlPath), match[1]))
      if (!slices.has(target)) slices.set(target, new Set())
      slices.get(target).add(file)
    }
  }
  return slices
}

test('ui 侧每个被 import 的切片都有 src/http.js 精确路由', () => {
  const slices = collectImportedSlices()
  assert.ok(slices.size > 0, '未收集到任何 import 目标，解析逻辑本身失效')
  const missing = []
  for (const [target, importers] of slices) {
    const route = `${ROUTE_PREFIX}/${target}`
    if (!http.includes(`route('${route}', ['GET']`)) missing.push(`${route}（被 ${[...importers].join('、')} import）`)
  }
  assert.deepEqual(missing, [], `缺少模块路由：${missing.join('；')}。漏注册即模块图断裂 → app.js 永不执行 → 卡在「正在连接团队空间」`)
})

test('模块路由指向的切片文件真实存在', () => {
  for (const target of collectImportedSlices().keys()) {
    assert.ok(existsSync(join(UI, target)), `路由切片不存在：${target}`)
  }
})

test('ui/modules 下每个切片文件都有对应路由（防新增切片漏注册）', () => {
  const missing = readdirSync(MODULES_DIR)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => !http.includes(`route('${ROUTE_PREFIX}/modules/${name}', ['GET']`))
  assert.deepEqual(missing, [], `缺少模块路由：${missing.join('、')}`)
})
