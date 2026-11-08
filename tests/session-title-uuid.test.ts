// tests/session-title-uuid.test.ts —— DSHBOTS-315 会话显示名后缀守门。
// bot 级会话在宿主会话列表里的显示名来源是 sessionTitle.rename：后缀从「控制面」
// （中文生造词，用户看不懂）改为 8 位小写 hex uuid 前缀（与宿主其他 uuid 形态一致）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { sessionMethods } from '../src/services/runtime/session.js'

// 会话创建镜像：sessionId 固定为真 uuid 形态（首段 8 位小写 hex），rename 记录参数。
class SessionTitleRuntime {
  declare store: any
  declare config: any
  declare ctx: any
  declare logger: any
  declare renames: Array<{ title: string }>
  declare sessionCreates: Map<string, any>

  constructor(config: any, store: any) {
    this.config = config
    this.store = store
    this.logger = { info() {}, warn() {}, error() {} }
    this.renames = []
    this.sessionCreates = new Map()
    this.ctx = {
      sessionController: {
        // 生产形态：宿主会话 id 带 session- 前缀（裸 uuid 夹具曾让 slice(0,8) 取到
        // 字面量 "session-" 的缺陷从守门眼皮下滑过）。
        create: async () => ({ sessionId: 'session-a1b2c3d4-5678-4abc-8def-0123456789ab' }),
        resolveAgent: async () => ({ agent: { session: { id: 'live' } } }),
        selectModel: async () => ({}),
      },
      sessionTitle: {
        rename: (_session: any, title: string) => { this.renames.push({ title }) },
      },
    }
  }

  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  sessionBusy() { return false }
  async selectModel() {}
  async defaultAgentPreset() { return {} }
  applyFilePolicy() {}
  shouldRolloverSession() { return false }
  maybeCompactSession() {}
  taskAffinityBinding(task: any) { return sessionMethods.taskAffinityBinding.call(this, task) }
  ensureBotBinding(bot: any, project: any, opts: any) { return sessionMethods.ensureBotBinding.call(this, bot, project, opts) }
  retireBinding(sessionId: string) { return sessionMethods.retireBinding.call(this, sessionId) }
}

test('bot 会话显示名后缀 = 8 位 hex uuid 前缀（非「控制面」生造词）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-title-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  try {
    // 真 bot/project 行（session_bindings 有 FK 指向 bots/projects）。
    const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
    const rt = new SessionTitleRuntime(config, store)
    service.attachRuntime(rt as any)
    await service.initialize()
    service.started = false
    const bot = await service.createBot({ name: 'TitleBot', role: '运维', instructions: 'Op.', provider: 'fake', model: 'm' })
    const project = await service.createProject({ name: 'Proj', key: 'PRJ' })
    await rt.ensureBotBinding(bot, project, {})
    assert.equal(rt.renames.length, 1, '建会话时 rename 一次')
    const title = rt.renames[0].title
    assert.match(title, /^TitleBot · [0-9a-f]{8}$/, '显示名 = <bot 名> · <8 位小写 hex>')
    assert.doesNotMatch(title, /控制面/, '不得再出现「控制面」生造词')
    assert.doesNotMatch(title, /session-/, '不得截到 id 的 session- 前缀字面量')
    assert.equal(title.split('· ')[1], 'a1b2c3d4', '后缀 = 剥离 session- 前缀后的 uuid 前 8 位')
  } finally {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
})
