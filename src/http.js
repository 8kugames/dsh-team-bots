import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from './errors.js'
import { handleAction } from './api.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI = join(HERE, '..', 'ui')
const MAX_BODY = 2 * 1024 * 1024

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
  const route = (path, methods, handler, requestBody = 'buffered') => {
    ctx.effect(() => ctx.connection.fetch.register({
      path,
      methods,
      ...(methods.includes('POST') ? { requestBody } : {}),
      fetch: request => handler(request),
    }), `dsh-team: route ${path}`)
  }

  const page = async () => response(await readFile(join(UI, 'index.html'), 'utf8'), 'text/html; charset=utf-8')
  const script = async () => response(await readFile(join(UI, 'app.js'), 'utf8'), 'text/javascript; charset=utf-8')
  const styles = async () => response(await readFile(join(UI, 'styles.css'), 'utf8'), 'text/css; charset=utf-8')
  const font = (weight) => async () => response(
    await readFile(join(UI, 'fonts', `inter-${weight}.woff2`)),
    'font/woff2', 200, { 'cache-control': 'public, max-age=604800' },
  )

  route('/api/dsh-team', ['GET'], page, 'none')
  route('/api/dsh-team/', ['GET'], page, 'none')
  route('/api/dsh-team/ui', ['GET'], page, 'none')
  route('/api/dsh-team/app.js', ['GET'], script, 'none')
  route('/api/dsh-team/styles.css', ['GET'], styles, 'none')
  for (const font of ['inter-400.woff2', 'inter-500.woff2', 'inter-600.woff2']) {
    route(`/api/dsh-team/fonts/${font}`, ['GET'], async () => response(
      await readFile(join(UI, 'fonts', font)),
      'font/woff2',
    ), 'none')
  }
  route('/api/dsh-team/fonts/inter-400.woff2', ['GET'], font('400'), 'none')
  route('/api/dsh-team/fonts/inter-500.woff2', ['GET'], font('500'), 'none')
  route('/api/dsh-team/fonts/inter-600.woff2', ['GET'], font('600'), 'none')

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
}
