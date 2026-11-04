import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from './errors.js'
import { handleAction } from './api.js'
import { resolveUiLanguage } from './services/locale.js'
import { effectiveUiLanguage } from './config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI = join(HERE, '..', 'ui')
const VENDOR = join(HERE, '..', 'vendor')
// API 请求体上限：聊天图片输入（单图 5MB、单条 4 张）走同一个 JSON 端点，
// base64 编码膨胀约 4/3，取 32MB 覆盖「4 张 × 5MB」的最大消息。
const MAX_BODY = 32 * 1024 * 1024
// 交付产物文件的单文件响应上限，超出返回 413。
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
// 聊天图片通道的单文件上限，任务口径 10MB；MIME 白名单与防穿越在 service.chatFile。
const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024
const ARTIFACT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

// 静态资源 URL 的版本参数由 package.json 注入，避免手写版本号与包版本漂移。
const ASSET_VERSION = String(createRequire(import.meta.url)('../package.json').version ?? '0')

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  // default-src 里放开 blob:：CSV 导出用 Blob URL 交给浏览器下载；
  // script-src 仍是 'self'，blob: 无法被当成脚本执行。
  // img-src 同样放开 blob:：待发图片缩略图用 URL.createObjectURL 做 base64 不进 DOM 的预览。
  'Content-Security-Policy': "default-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
}

// 注入宿主原生 Web 界面（fallback SPA）的切换入口。原生界面没有指向本插件
// 的链接，通过宿主的 `webserver/index-inject` 结构化注入机制补一个固定胶囊
// 入口；与工作台侧栏里指向 /index.html（原生界面在 fallback seat 上的稳定
// 入口，/ 已被本插件占据）的返回链接构成双向自由切换。本项目自己的 UI
// 不走宿主 renderIndex，不会看到这个入口。
export const OFFICIAL_UI_SWITCH_ROWS = [
  {
    kind: 'style',
    text: [
      '.dsh-team-switch{position:fixed;right:16px;bottom:16px;z-index:99999;display:inline-flex;align-items:center;gap:7px;padding:9px 14px;border-radius:999px;text-decoration:none;cursor:pointer;font:500 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#24272f;background:rgba(255,255,255,.86);border:1px solid rgba(15,23,42,.14);box-shadow:0 4px 16px rgba(15,23,42,.14);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:transform .12s ease,box-shadow .12s ease}',
      '.dsh-team-switch svg{width:14px;height:14px;opacity:.75}',
      '.dsh-team-switch:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(15,23,42,.2);color:#24272f}',
      '.dsh-team-switch:focus-visible{outline:2px solid #7287fd;outline-offset:2px}',
      '@media (prefers-color-scheme:dark){.dsh-team-switch{color:#e6e8ee;background:rgba(24,26,31,.86);border-color:rgba(255,255,255,.14);box-shadow:0 4px 16px rgba(0,0,0,.4)}.dsh-team-switch:hover{color:#e6e8ee;box-shadow:0 6px 20px rgba(0,0,0,.5)}}',
    ].join('\n'),
  },
  {
    kind: 'html',
    placement: 'body',
    html: '<a class="dsh-team-switch" href="/api/dsh-team/ui" title="切换到 DSH Team Bots 团队工作台" aria-label="切换到 DSH Team Bots 团队工作台"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h13l-3.5-3.5"/><path d="M20 17H7l3.5 3.5"/></svg><span>团队工作台</span></a>',
  },
]

// ui/styles.css 组件域拆分（DSHBOTS-160）：5626 行巨石按 Section 域拆到 ui/styles/*.css，
// 每文件 <800 行。本表是拼接顺序的唯一真源（线上 installHttp 与 scripts/dev-server.js
// 共用同一 readUiStyles），顺序即层叠语义——base 的变量声明在最前、wide 的媒体覆盖在
// 后，不得重排。
export const UI_STYLE_PARTS = [
  'styles/base.css',
  'styles/boot.css',
  'styles/frame.css',
  'styles/main.css',
  'styles/buttons.css',
  'styles/surfaces.css',
  'styles/avatars.css',
  'styles/chat.css',
  'styles/chat-cards.css',
  'styles/chat-composer.css',
  'styles/chat-images.css',
  'styles/tasks.css',
  'styles/cards.css',
  'styles/usage.css',
  'styles/settings.css',
  'styles/modal.css',
  'styles/toast.css',
  'styles/a11y.css',
  'styles/wide.css',
  'styles/terminal.css',
]

export const readUiStyles = async () => {
  const parts = await Promise.all(UI_STYLE_PARTS.map((part) => readFile(join(UI, part), 'utf8')))
  return parts.join('')
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
    // {{language}}（DSHBOTS-120）：服务端解析 DSH 宿主语言设定注入 <html data-dsh-language>，
    // 客户端据此选 i18n 字典包（'auto' = 宿主未显式设定，交给浏览器语言）。
    // DSHBOTS-162：页面保存值 zh/en 优先于宿主解析，'auto' 才回落宿主链。
    const language = await resolveUiLanguage({
      loader: ctx.get('loader'),
      dshHome: service?.config?.dshHome,
      profile: process.env.DSH_PROFILE || 'team-bots',
      uiLanguage: service ? effectiveUiLanguage(service.config, key => service.store.setting(key)) : 'auto',
    })
    return response(html
      .replaceAll('{{assetVersion}}', ASSET_VERSION)
      .replaceAll('{{language}}', language), 'text/html; charset=utf-8')
  }
  const script = async () => response(await readFile(join(UI, 'app.js'), 'utf8'), 'text/javascript; charset=utf-8')
  // ES module 切片（DSHBOTS-15）：app.js 的 import 依赖逐文件注册（bridge 路由为精确路径）。
  // 不变量：ui 侧每个被 import 的切片都要有一条精确路由，漏一条 = 浏览器模块图断裂 =
  // app.js 永不执行 = 工作台卡在「正在连接团队空间」。覆盖锁见 tests/ui-module-routes.test.js。
  const moduleScript = (name) => async () => response(
    await readFile(join(UI, 'modules', name)), 'text/javascript; charset=utf-8',
  )
  // i18n 字典切片（DSHBOTS-120）：ui/i18n/ 下的语言包，同样逐文件精确注册。
  const i18nDict = (name) => async () => response(
    await readFile(join(UI, 'i18n', name)), 'text/javascript; charset=utf-8',
  )
  // styles 汇总直出（DSHBOTS-160）：路由、MIME、缓存语义与拆分前完全一致，
  // 仅读取口径改为 readUiStyles 按 UI_STYLE_PARTS 拼接。
  const styles = async () => response(await readUiStyles(), 'text/css; charset=utf-8')
  const font = (weight) => async () => response(
    await readFile(join(UI, 'fonts', `inter-${weight}.woff2`)),
    'font/woff2', 200, { 'cache-control': 'public, max-age=604800' },
  )
  // 聊天 markdown 渲染依赖（vendor 拷贝自 npm 发布包，见各目录 NOTICE）：
  // marked 负责 md→HTML，DOMPurify 负责消毒；app.js 侧二者缺一即回退纯文本，不裸渲染。
  const vendorScript = (name) => async () => response(
    await readFile(join(VENDOR, name)), 'text/javascript; charset=utf-8',
  )

  // GET 必须保持默认 requestBody:'buffered'：bridge 对非 buffered 模式注入请求体流，
  // GET+body 会抛 TypeError 并被 webserver 兜底成 400。
  route('/api/dsh-team', ['GET'], page)
  route('/api/dsh-team/ui', ['GET'], page)
  route('/api/dsh-team/app.js', ['GET'], script)
  route('/api/dsh-team/modules/state.js', ['GET'], moduleScript('state.js'))
  route('/api/dsh-team/modules/icons.js', ['GET'], moduleScript('icons.js'))
  route('/api/dsh-team/modules/util.js', ['GET'], moduleScript('util.js'))
  route('/api/dsh-team/modules/markdown.js', ['GET'], moduleScript('markdown.js'))
  route('/api/dsh-team/modules/api.js', ['GET'], moduleScript('api.js'))
  route('/api/dsh-team/modules/i18n.js', ['GET'], moduleScript('i18n.js'))
  route('/api/dsh-team/modules/typing-linger.js', ['GET'], moduleScript('typing-linger.js'))
  route('/api/dsh-team/modules/cards.js', ['GET'], moduleScript('cards.js'))
  route('/api/dsh-team/modules/usage.js', ['GET'], moduleScript('usage.js'))
  route('/api/dsh-team/modules/settings.js', ['GET'], moduleScript('settings.js'))
  route('/api/dsh-team/modules/composer.js', ['GET'], moduleScript('composer.js'))
  route('/api/dsh-team/modules/tasks.js', ['GET'], moduleScript('tasks.js'))
  route('/api/dsh-team/modules/modal-layer.js', ['GET'], moduleScript('modal-layer.js'))
  route('/api/dsh-team/modules/modal-forms.js', ['GET'], moduleScript('modal-forms.js'))
  route('/api/dsh-team/modules/chat.js', ['GET'], moduleScript('chat.js'))
  route('/api/dsh-team/modules/solo-archive.js', ['GET'], moduleScript('solo-archive.js'))
  route('/api/dsh-team/modules/events-board.js', ['GET'], moduleScript('events-board.js'))
  route('/api/dsh-team/modules/events-click.js', ['GET'], moduleScript('events-click.js'))
  route('/api/dsh-team/modules/events-submit.js', ['GET'], moduleScript('events-submit.js'))
  route('/api/dsh-team/modules/events-misc.js', ['GET'], moduleScript('events-misc.js'))
  route('/api/dsh-team/i18n/zh.js', ['GET'], i18nDict('zh.js'))
  route('/api/dsh-team/i18n/en.js', ['GET'], i18nDict('en.js'))
  route('/api/dsh-team/styles.css', ['GET'], styles)
  route('/api/dsh-team/fonts/inter-400.woff2', ['GET'], font('400'))
  route('/api/dsh-team/fonts/inter-500.woff2', ['GET'], font('500'))
  route('/api/dsh-team/fonts/inter-600.woff2', ['GET'], font('600'))
  route('/api/dsh-team/vendor/marked.js', ['GET'], vendorScript(join('marked', 'marked.umd.js')))
  route('/api/dsh-team/vendor/purify.min.js', ['GET'], vendorScript(join('dompurify', 'purify.min.js')))

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

  const errorResponse = (error) => {
    const known = error instanceof AppError
    if (!known) logger.error?.('dsh-team: API error: %s', error?.stack ?? error)
    const status = known ? error.status : 500
    const code = known ? error.code : 'INTERNAL'
    const message = known ? error.message : '服务端处理失败'
    return response(JSON.stringify({ ok: false, error: { code, message } }), 'application/json; charset=utf-8', status)
  }

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
      return errorResponse(error)
    }
  })

  // 交付产物：清单与文件内容。与 /api/dsh-team/api 同前缀注册，鉴权同样由宿主路由层承担。
  const searchParams = (request) => new URL(request.url, 'http://localhost').searchParams

  route('/api/dsh-team/artifacts', ['GET'], async (request) => {
    try {
      const runId = String(searchParams(request).get('runId') ?? '').trim()
      if (!runId) throw new AppError('BAD_REQUEST', '缺少参数 runId', 400)
      const data = service.listRunArtifacts(runId)
      return response(JSON.stringify({ ok: true, data }), 'application/json; charset=utf-8')
    } catch (error) {
      return errorResponse(error)
    }
  })

  route('/api/dsh-team/artifact-file', ['GET'], async (request) => {
    try {
      const params = searchParams(request)
      const runId = String(params.get('runId') ?? '').trim()
      const relPath = String(params.get('path') ?? '')
      if (!runId || !relPath) throw new AppError('BAD_REQUEST', '缺少参数 runId 或 path', 400)
      const { absolutePath, size } = service.artifactFile(runId, relPath)
      if (size > MAX_ARTIFACT_BYTES) throw new AppError('ARTIFACT_TOO_LARGE', '产物文件超过 5MB 上限', 413)
      const ext = extname(absolutePath).toLowerCase()
      // SVG 可执行脚本，强制以附件下载，不进内联渲染。
      const extra = ext === '.svg'
        ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(absolutePath))}` }
        : {}
      const body = await readFile(absolutePath)
      if (body.byteLength > MAX_ARTIFACT_BYTES) throw new AppError('ARTIFACT_TOO_LARGE', '产物文件超过 5MB 上限', 413)
      return response(body, ARTIFACT_TYPES[ext] ?? 'text/plain; charset=utf-8', 200, extra)
    } catch (error) {
      return errorResponse(error)
    }
  })

  // 聊天图片通道：只读项目工作区 / 单聊 Bot 工作区内的白名单图片（MIME 白名单、
  // 10MB 上限、路径防穿越都在 service.chatFile 里做）。与 /api 同前缀注册，鉴权由
  // 宿主路由层承担；失败走 AppError，不落含查询串的日志。
  route('/api/dsh-team/file', ['GET'], async (request) => {
    try {
      const params = searchParams(request)
      const projectId = String(params.get('projectId') ?? '').trim()
      const soloBotId = String(params.get('soloBotId') ?? '').trim()
      const relPath = String(params.get('path') ?? '')
      if (!relPath) throw new AppError('BAD_REQUEST', '缺少参数 path', 400)
      if (!projectId === !soloBotId) throw new AppError('BAD_REQUEST', 'projectId 与 soloBotId 必须二选一', 400)
      const { absolutePath, size, contentType } = service.chatFile({ projectId, soloBotId, path: relPath })
      if (size > MAX_CHAT_IMAGE_BYTES) throw new AppError('FILE_TOO_LARGE', '图片超过 10MB 上限', 413)
      const body = await readFile(absolutePath)
      if (body.byteLength > MAX_CHAT_IMAGE_BYTES) throw new AppError('FILE_TOO_LARGE', '图片超过 10MB 上限', 413)
      return response(body, contentType)
    } catch (error) {
      return errorResponse(error)
    }
  })

  // 原生界面 → 工作台的入口（见 OFFICIAL_UI_SWITCH_ROWS 注释）。监听器随
  // 插件 context 生命周期自动清理。
  ctx.on?.('webserver/index-inject', (table) => {
    table.push(...OFFICIAL_UI_SWITCH_ROWS)
  })

  logger.info?.('team UI: /api/dsh-team/ui')
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch {}
    }
  }, 'dsh-team: fetch routes')
}
