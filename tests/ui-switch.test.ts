import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installHttp, OFFICIAL_UI_SWITCH_ROWS } from '../src/http.js'

// 原生界面 ⇄ 团队工作台双向切换的入口约束。宿主的 index 注入机制要求：
// style 文本不得包含 `</style>`，script/html 文本不得包含 `</script>`，
// 否则会提前闭合元素。这里只注入 style + html，两行都必须满足。
test('official UI switch rows satisfy host injection constraints', () => {
  assert.equal(OFFICIAL_UI_SWITCH_ROWS.length, 2)
  const [style, html] = OFFICIAL_UI_SWITCH_ROWS
  assert.equal(style.kind, 'style')
  assert.ok(!style.text.includes('</style'))
  assert.equal(html.kind, 'html')
  assert.equal(html.placement, 'body')
  assert.ok(!html.html.includes('</script'))
  assert.match(html.html, /href="\/api\/dsh-team\/ui"/)
})

// 假 ctx：只实现 installHttp 触碰到的宿主面。
function fakeCtx({ admitted = true } = {}) {
  const fetchRoutes = []
  const webRoutes = []
  const listeners = new Map()
  const ctx = {
    connection: {
      fetch: { register: (def) => { fetchRoutes.push(def); return () => {} } },
      admit: () => (admitted ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 }),
    },
    webServer: {
      register: (route) => { webRoutes.push(route); return () => {} },
    },
    get: () => ({ protocol: 'http:' }),
    on: (name, cb) => {
      const list = listeners.get(name) ?? []
      list.push(cb)
      listeners.set(name, list)
      return () => {}
    },
    effect: () => () => {},
  }
  return { ctx, fetchRoutes, webRoutes, listeners }
}

test('installHttp registers switch entry into host index injection', () => {
  const { ctx, listeners } = fakeCtx()
  installHttp(ctx, { localUserId: 'u1' }, { info() {}, warn() {}, error() {} })
  const handlers = listeners.get('webserver/index-inject') ?? []
  assert.equal(handlers.length, 1)
  const table = []
  for (const handler of handlers) handler(table)
  assert.deepEqual(table, OFFICIAL_UI_SWITCH_ROWS)
})

// 宿主 0.2.3 起 remote-connection 占用精确路由 `/`，插件再注册同名路由会让
// 整个插件加载失败。首页直达改为 webserver/request waterfall 拦截。
async function runRootRequest({ method = 'GET', url = '/', admitted = true } = {}) {
  const { ctx, listeners } = fakeCtx({ admitted })
  installHttp(ctx, { localUserId: 'u1' }, { info() {}, warn() {}, error() {} })
  const handlers = listeners.get('webserver/request') ?? []
  const request = { method, url, headers: { host: '127.0.0.1:3080' } }
  const headers: { status?: number; location?: string } = {}
  let ended = false
  let nexted = false
  const res = {
    writeHead: (status, extra) => { headers.status = status; headers.location = extra?.location },
    end: () => { ended = true },
  }
  const next = () => { nexted = true }
  for (const handler of handlers) await handler(request, res, next)
  return { headers, ended, nexted }
}

test('installHttp keeps UI routes and does not claim the root route', () => {
  const { ctx, fetchRoutes, webRoutes } = fakeCtx()
  installHttp(ctx, { localUserId: 'u1' }, { info() {}, warn() {}, error() {} })
  const paths = fetchRoutes.map((route) => route.path)
  assert.ok(paths.includes('/api/dsh-team/ui'))
  assert.ok(paths.includes('/api/dsh-team/api'))
  // `/` 归宿主所有：插件既不能注册精确路由，也不能注册同名前缀路由。
  assert.equal(webRoutes.find((route) => route.path === '/'), undefined)
})

test('root request redirects an admitted owner into the workbench', async () => {
  const { headers, ended, nexted } = await runRootRequest()
  assert.equal(headers.status, 302)
  assert.equal(headers.location, '/api/dsh-team/ui')
  assert.ok(ended)
  assert.equal(nexted, false)
})

test('root request is handed back to the host for token exchange and login', async () => {
  for (const url of ['/?token=abc', '/?login=qr']) {
    const { headers, nexted } = await runRootRequest({ url })
    assert.equal(nexted, true, `${url} 应交回宿主`)
    assert.equal(headers.status, undefined)
  }
})

test('root request is handed back to the host when the caller is not admitted', async () => {
  const { headers, ended, nexted } = await runRootRequest({ admitted: false })
  assert.equal(nexted, true)
  assert.equal(ended, false)
  assert.equal(headers.status, undefined)
})
