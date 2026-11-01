import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from './errors.js'
import { handleAction } from './api.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI = join(HERE, '..', 'ui')
const MAX_BODY = 2 * 1024 * 1024

// 静态资源 URL 的版本参数由 package.json 注入，避免手写版本号与包版本漂移。
const ASSET_VERSION = String(createRequire(import.meta.url)('../package.json').version ?? '0')

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
}

const response = (body, type, status = 200, extra = {}) => new Response(body, {
  status,
  headers: {
    'content-type': type,
    'cache-control': 'no-store',
    ...SECURITY,
    ...extra,
  },
})

export function installHttp(ctx, service, logger = console) {
  const disposers = []
  const route = (path, methods, handler, requestBody = 'buffered') => {
    disposers.push(ctx.connection.fetch.register({
      path,
      methods,
      requestBody,
      fetch: request => handler(request),
    }))
  }

  const page = async () => {
    const html = await readFile(join(UI, 'index.html'), 'utf8')
    return response(html.replaceAll('{{assetVersion}}', ASSET_VERSION), 'text/html; charset=utf-8')
  }
  const script = async () => response(await readFile(join(UI, 'app.js'), 'utf8'), 'text/javascript; charset=utf-8')
  const styles = async () => response(await readFile(join(UI, 'styles.css'), 'utf8'), 'text/css; charset=utf-8')
  const font = (weight) => async () => response(
    await readFile(join(UI, 'fonts', `inter-${weight}.woff2`)),
    'font/woff2', 200, { 'cache-control': 'public, max-age=604800' },
  )

  // GET 必须保持默认 requestBody:'buffered'：bridge 对非 buffered 模式注入请求体流，
  // GET+body 会抛 TypeError 并被 webserver 兜底成 400。
  route('/api/dsh-team', ['GET'], page)
  route('/api/dsh-team/ui', ['GET'], page)
  route('/api/dsh-team/app.js', ['GET'], script)
  route('/api/dsh-team/styles.css', ['GET'], styles)
  route('/api/dsh-team/fonts/inter-400.woff2', ['GET'], font('400'))
  route('/api/dsh-team/fonts/inter-500.woff2', ['GET'], font('500'))
  route('/api/dsh-team/fonts/inter-600.woff2', ['GET'], font('600'))

  // 首页直达工作台：已登录（有效 cookie）302 进 UI；未登录 302 到携带当前
  // launch token 的 `/`，由宿主 authorizeIndex 完成 token→cookie 兑换（30 天）。
  // 旧世代的失效 token 书签会被换成当前 token 重试一次（自愈）；Host/Origin
  // 拒绝（403）原样返回，不参与自动登录。
  const home = (req, res) => {
    const secure = ctx.get('webServer')?.protocol === 'https:'
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) {
      res.writeHead(302, { 'cache-control': 'no-store', location: '/api/dsh-team/ui' })
      res.end()
      return
    }
    if (rejection !== 401) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    const host = req.headers.host
    if (typeof host !== 'string' || host.length === 0) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('host header required')
      return
    }
    const tokenUrl = ctx.connection.authenticatedUrl(`${secure ? 'https' : 'http'}://${host}/`)
    const incoming = new URL(req.url ?? '/', tokenUrl).searchParams.get('token')
    if (incoming === null) {
      res.writeHead(302, { 'cache-control': 'no-store', location: tokenUrl })
      res.end()
      return
    }
    if (incoming !== new URL(tokenUrl).searchParams.get('token')) {
      res.writeHead(302, { 'cache-control': 'no-store', location: '/' })
      res.end()
      return
    }
    ctx.connection.authorizeIndex(req, res, secure)
  }
  disposers.push(ctx.webServer.register({ kind: 'exact', path: '/', handler: home }))

  route('/api/dsh-team/api', ['POST'], async (request) => {
    try {
      const length = Number(request.headers.get('content-length') ?? 0)
      if (Number.isFinite(length) && length > MAX_BODY) {
        return response(JSON.stringify({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' } }), 'application/json; charset=utf-8', 413)
      }
      let body
      try {
        body = await request.json()
      } catch {
        throw new AppError('BAD_JSON', '请求体必须是 JSON', 400)
      }
      const action = String(body?.action ?? '')
      const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {}
      const actor = { type: 'user', id: service.localUserId }
      const data = await handleAction(service, action, payload, actor)
      return response(JSON.stringify({ ok: true, data }), 'application/json; charset=utf-8')
    } catch (error) {
      const known = error instanceof AppError
      if (!known) logger.error?.('dsh-team: API error: %s', error?.stack ?? error)
      const status = known ? error.status : 500
      const code = known ? error.code : 'INTERNAL'
      const message = known ? error.message : '服务端处理失败'
      return response(JSON.stringify({ ok: false, error: { code, message } }), 'application/json; charset=utf-8', status)
    }
  })

  logger.info?.('team UI: /api/dsh-team/ui')
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch {}
    }
  }, 'dsh-team: fetch routes')
}
