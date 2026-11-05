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
function fakeCtx() {
  const fetchRoutes = []
  const webRoutes = []
  const listeners = new Map()
  const ctx = {
    connection: {
      fetch: { register: (def) => { fetchRoutes.push(def); return () => {} } },
      requestRejection: () => undefined,
      authenticatedUrl: (url) => url,
      authorizeIndex: () => true,
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

test('installHttp keeps UI routes and authenticated home redirect', async () => {
  const { ctx, fetchRoutes, webRoutes } = fakeCtx()
  installHttp(ctx, { localUserId: 'u1' }, { info() {}, warn() {}, error() {} })
  const paths = fetchRoutes.map((route) => route.path)
  assert.ok(paths.includes('/api/dsh-team/ui'))
  assert.ok(paths.includes('/api/dsh-team/api'))

  const home = webRoutes.find((route) => route.kind === 'exact' && route.path === '/')
  assert.ok(home, 'home handler registered')
  const headers: { status?: number; location?: string } = {}
  let ended = false
  await home.handler({ url: '/', headers: { host: '127.0.0.1:1' } }, {
    writeHead: (status, extra) => { headers.status = status; headers.location = extra?.location },
    end: () => { ended = true },
  })
  assert.equal(headers.status, 302)
  assert.equal(headers.location, '/api/dsh-team/ui')
  assert.ok(ended)
})
