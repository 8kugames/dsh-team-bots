// Local preview only. It uses a fake DSH runtime and has no authentication.
// Production is the DSH plugin in index.js served by `dsh web`.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { openDatabase } from '../src/db.js'
import { handleAction } from '../src/api.js'
import { TeamService } from '../src/service.js'
import { recordUsage } from '../src/usage.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.PORT || 4317)
const CONFIG = resolveConfig({
  workspace: join(ROOT, '.dev', 'workspace'),
  dataDir: join(ROOT, '.dev', 'data'),
  seedOwnerName: 'Chief',
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
    return { native: true, profile: 'bots', version: '0.2.1-rc.5', toolCount: 24, modelProviderCount: 2 }
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
          ? `已完成「${task.title}」。\n\n变更摘要：\n- 在 ${project.slug} 工作区完成实现与自检\n- 更新了相关入口与配置\n- 验证路径与错误分支\n\n验收建议：检查任务面板状态并查看运行输出。`
          : `收到。当前项目「${project.name}」的群聊、任务和共享技能都已就绪。需要我拆分下一批工作吗？`,
        error: null,
      })
    }, 300)
    return `preview-session-${run.id}`
  }
  async cancelRun() { return true }
}

async function seed(service, runtime) {
  const store = service.store
  const existing = store.get('SELECT id FROM projects LIMIT 1')
  if (existing) return
  const chief = store.get("SELECT * FROM bots WHERE name = 'Chief'")
  const builder = await service.createBot({
    name: 'Builder', role: '开发', color: 'blue', provider: 'deepseek', model: 'deepseek-flash', effort: 'high',
    instructions: '你负责实现与验证。先读现有结构，再做最小可行修改，最后给出变更和验证结果。',
  })
  const reviewer = await service.createBot({
    name: 'Reviewer', role: '审查', color: 'violet', provider: 'anthropic', model: 'claude-sonnet', effort: 'high',
    instructions: '你负责代码审查、风险识别和验收。优先找正确性、安全和可维护性问题。',
  })
  const project =   await service.createProject({
    name: 'DSH Team OS', key: 'DSH', ownerBotId: chief.id, memberIds: [builder.id, reviewer.id],
    description: '面向团队的多 Bot 协作空间：项目群聊、Linear 风格任务、记忆、共享技能与用量统计。',
  }, { type: 'system', id: 'system' })
  await service.sendMessage(project.id, '先确认今天的交付范围：群聊、任务面板、记忆和用量统计。')
  await new Promise(resolve => setTimeout(resolve, 500))
  const t1 = await service.createTask({
    projectId: project.id, title: '实现项目群聊与任务面板', description: '完成群聊 @ 路由、任务状态机和任务详情抽屉。验收：用户可在群聊创建任务，任务运行结果写回群聊。',
    assigneeBotId: builder.id, priority: 'high', autoStart: true, postCard: true,
  }, { type: 'user', id: service.localUserId })
  await new Promise(resolve => setTimeout(resolve, 600))
  const t2 = await service.createTask({
    projectId: project.id, title: '审查记忆作用域隔离', description: '验证 Bot 记忆、项目记忆不会跨项目泄漏，检查敏感信息过滤。',
    assigneeBotId: reviewer.id, priority: 'high', autoStart: false, postCard: true,
  }, { type: 'user', id: service.localUserId })
  await service.updateTask(t2.id, { status: 'todo' }, { type: 'user', id: service.localUserId }).catch(() => {})
  const t3 = await service.createTask({
    projectId: project.id, title: '补齐 Docker 部署与健康检查', description: '固定 DSH 版本、挂载 /data 与 /workspace、验证 UI 路由和持久化。',
    assigneeBotId: builder.id, priority: 'medium', autoStart: false, postCard: true,
  }, { type: 'user', id: service.localUserId })
  await service.updateTask(t3.id, { status: 'in_progress' }, { type: 'user', id: service.localUserId }).catch(() => {})
  const t4 = await service.createTask({
    projectId: project.id, title: '设计共享技能版本发布流程', description: '技能提案 → 审批 → 写入 /workspace/.agents/skills/{slug}/SKILL.md，并保留历史版本。',
    priority: 'low', autoStart: false, postCard: true,
  }, { type: 'user', id: service.localUserId })
  await service.addComment(t1.id, '页面交互已联调，等待最后一次视觉检查。', { type: 'bot', id: builder.id })
  await service.createMemory({
    scopeType: 'project', scopeId: project.id, topic: '当前交付目标', content: '优先保证群聊、任务、记忆和用量四条链路的闭环，再补审美和移动端适配。',
    source: 'preview', createdBy: 'system',
  })
  await service.createProposal({
    kind: 'bot_update', botId: builder.id, projectId: project.id,
    title: '让 Builder 在提交前固定执行路径与回归检查',
    rationale: '最近两次交付都遗漏了路径校验，应该在角色指令里加入固定检查清单。',
    payload: { instructions: '实现功能前先读相关文件。完成后必须验证路径校验、错误分支和至少一个真实调用。' },
    evaluation: '用三个历史任务回放，检查是否仍出现路径遗漏。',
  }, { type: 'user', id: service.localUserId })
  await mkdir(join(CONFIG.skillRoot, 'skills', 'release-check'), { recursive: true })
  await writeFile(join(CONFIG.skillRoot, 'skills', 'release-check', 'SKILL.md'), `---\nname: release-check\ndescription: Verify release readiness, migrations and rollback\nversion: 1.0.0\n---\n\n# Release check\n\n1. Verify configuration and migrations.\n2. Run smoke tests.\n3. Record rollback steps.\n`, 'utf8')
  await mkdir(join(CONFIG.skillRoot, 'skills', 'code-review'), { recursive: true })
  await writeFile(join(CONFIG.skillRoot, 'skills', 'code-review', 'SKILL.md'), `---\nname: code-review\ndescription: Review changes for correctness, security and maintainability\nversion: 1.2.0\n---\n\n# Code review\n\nPrioritize correctness, then security, then maintainability.\n`, 'utf8')
  service.syncSkillsNow().catch(() => {})
}

async function main() {
  await mkdir(dirname(CONFIG.dbPath), { recursive: true })
  const store = openDatabase(CONFIG.dbPath)
  const service = new TeamService({ store, config: CONFIG, logger: console })
  const runtime = new PreviewRuntime(service)
  service.attachRuntime(runtime)
  await service.initialize()
  service.start()
  await seed(service, runtime)
  await new Promise(resolve => setTimeout(resolve, 900))

  const send = (res, status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui')) {
        return send(res, 200, 'text/html; charset=utf-8', await readFile(join(ROOT, 'ui', 'index.html')))
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
  server.listen(PORT, '127.0.0.1', () => console.log(`DSHBots preview: http://127.0.0.1:${PORT}`))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
