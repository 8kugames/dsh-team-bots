// Local preview only. It uses a fake DSH runtime and has no authentication.
// Production is the DSH plugin in index.js served by `dsh web`.
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { openDatabase } from '../src/db.js'
import { handleAction } from '../src/api.js'
import { TeamService } from '../src/service.js'
import { recordUsage } from '../src/usage.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.PORT || 4317)
// 静态切片（DSHBOTS-127）：路径与 MIME 与线上 src/http.js 对齐。
// i18n 字典是 ES 模块图的一环（ui/modules/i18n.js 相对导入 ../i18n/<lang>.js →
// /api/dsh-team/i18n/<lang>.js），缺这条路由时 app.js 模块图 404 加载失败，
// 预览页会一直卡在 boot screen「正在连接团队空间」（线上有这些路由，故只在预览复现）。
const STATIC_SLICES = new Map([
  ['/api/dsh-team/i18n/zh.js', 'ui/i18n/zh.js'],
  ['/api/dsh-team/i18n/en.js', 'ui/i18n/en.js'],
  ['/api/dsh-team/vendor/marked.js', 'vendor/marked/marked.umd.js'],
  ['/api/dsh-team/vendor/purify.min.js', 'vendor/dompurify/purify.min.js'],
])
const ASSET_VERSION = String(createRequire(import.meta.url)('../package.json').version ?? '0')
const CONFIG = resolveConfig({
  workspace: join(ROOT, '.dev', 'workspace'),
  dataDir: join(ROOT, '.dev', 'data'),
  schedulerIntervalMs: 80,
  runTimeoutMs: 120_000,
  maxConcurrentRuns: 3,
})

class PreviewRuntime {
  constructor(service) {
    this.service = service
    this.models = [
      { ref: 'deepseek/deepseek-flash', provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-flash', name: 'DeepSeek Flash', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
      { ref: 'anthropic/claude-sonnet', provider: 'anthropic', providerName: 'Anthropic', model: 'claude-sonnet', name: 'Claude Sonnet', efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' },
    ]
  }
  setCompletionHandler(handler) { this.handler = handler }
  capabilityInfo() {
    return { native: true, profile: 'team-bots', version: '0.2.1-rc.5', toolCount: 24, modelProviderCount: 2 }
  }
  async catalog() { return this.models }
  async validateBotConfig() {}
  async startRun({ run, bot, task, project }) {
    recordUsage(this.service.store, {
      sourceKey: `preview:${run.id}`,
      run, provider: bot.provider, model: bot.model,
      usage: { inputTokens: 1280 + Math.floor(Math.random() * 900), outputTokens: 340 + Math.floor(Math.random() * 260), cacheReadTokens: 220 },
    })
    setTimeout(() => {
      this.handler({
        runId: run.id,
        status: 'succeeded',
        output: task
          ? `已完成「${task.title}」。\n\n变更摘要：\n- 在 ${project?.slug ?? '项目'} 工作区完成实现与自检\n- 更新了相关入口与配置\n- 验证路径与错误分支\n\n验收建议：检查任务面板状态并查看运行输出。`
          : `收到。${project ? `当前项目「${project.name}」的` : ''}群聊、任务和共享技能都已就绪。需要我拆分下一批工作吗？`,
        error: null,
      })
    }, 300)
    return `preview-session-${run.id}`
  }
  async cancelRun() { return true }
  async steer() { return true }
}

async function main() {
  await mkdir(dirname(CONFIG.dbPath), { recursive: true })
  const store = openDatabase(CONFIG.dbPath)
  const service = new TeamService({ store, config: CONFIG, logger: console })
  const runtime = new PreviewRuntime(service)
  service.attachRuntime(runtime)
  await service.initialize()
  service.start()

  const send = (res, status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui' || url.pathname === '/index.html')) {
        const html = await readFile(join(ROOT, 'ui', 'index.html'), 'utf8')
        // {{language}}：预览没有 DSH 宿主的语言设定，按线上兜底语义注入 'auto'（客户端按 navigator 解析）。
        return send(res, 200, 'text/html; charset=utf-8', html
          .replaceAll('{{assetVersion}}', ASSET_VERSION)
          .replaceAll('{{language}}', 'auto'))
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh-team/styles.css') {
        return send(res, 200, 'text/css; charset=utf-8', await readFile(join(ROOT, 'ui', 'styles.css')))
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/dsh-team/fonts/')) {
        const font = url.pathname.slice('/api/dsh-team/fonts/'.length)
        if (!/^inter-(400|500|600)\.woff2$/.test(font)) return send(res, 404, 'text/plain', 'Not found')
        return send(res, 200, 'font/woff2', await readFile(join(ROOT, 'ui', 'fonts', font)))
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh-team/app.js') {
        return send(res, 200, 'text/javascript; charset=utf-8', await readFile(join(ROOT, 'ui', 'app.js')))
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/dsh-team/modules/')) {
        const mod = url.pathname.slice('/api/dsh-team/modules/'.length)
        if (!/^[\w-]+\.js$/.test(mod)) return send(res, 404, 'text/plain', 'Not found')
        return send(res, 200, 'text/javascript; charset=utf-8', await readFile(join(ROOT, 'ui', 'modules', mod)))
      }
      if (req.method === 'GET') {
        const slice = STATIC_SLICES.get(url.pathname)
        if (slice) return send(res, 200, 'text/javascript; charset=utf-8', await readFile(join(ROOT, slice)))
      }
      const fontMatch = req.method === 'GET' && url.pathname.match(/^\/api\/dsh-team\/fonts\/inter-(400|500|600)\.woff2$/)
      if (fontMatch) {
        return send(res, 200, 'font/woff2', await readFile(join(ROOT, 'ui', 'fonts', `inter-${fontMatch[1]}.woff2`)))
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-team/api') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const body = JSON.parse(raw || '{}')
        try {
          const data = await handleAction(service, body.action, body.payload ?? {}, { type: 'user', id: service.localUserId })
          return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, data }))
        } catch (error) {
          return send(res, error.status || 500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: { code: error.code ?? 'INTERNAL', message: error.message } }))
        }
      }
      return send(res, 404, 'text/plain', 'Not found')
    } catch (error) {
      console.error(error)
      return send(res, 500, 'text/plain', String(error))
    }
  })
  server.listen(PORT, '127.0.0.1', () => console.log(`DSH Team Bots preview: http://127.0.0.1:${PORT}`))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
