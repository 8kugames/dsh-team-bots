// DSHBOTS-126：紧急任务豁免许可（priority='urgent' 无视排队立即施工，产品化而非口头指令）。
// 覆盖：任务提示词 urgent 注入豁免指令 / 非 urgent 零注入；
// urgent 新卡对同写范围拒单守卫放行 + 创建消息报备共用车道；
// 非 urgent 同写范围仍拒单（文案保留 + 豁免入口可见）；urgent 无重复卡时不误报共用车道。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

// assert.rejects 校验回调收到的业务错误形态（AppError 的本地结构视图，仅类型用）。
interface RejectError { status: number; code: string; message: string }

// startRun 只记账不回调完成：任务 run 停在 running，任务停在 in_progress（在办状态），
// 使同写范围守卫的后一张派单稳定命中「已存在在办卡」分支。
class HoldingRuntime {
  declare started: { id: string; kind: string; taskId: string | null }[]

  constructor() {
    this.started = []
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) {
    this.started.push({ id: run.id, kind: run.kind, taskId: run.task_id ?? null })
    return `session-${run.id}`
  }
  async cancelRun() { return true }
}

// schedulerIntervalMs 拉满（resolveConfig 上限 30s）：定时 tick 不掺和，时序只由显式 tick 驱动。
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-urgent-exempt-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

async function seedProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({ name: 'Gate', key: 'GATE', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project, gate: project }
}

function ownerSession(store, director, project, sessionId) {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return sessionId
}

async function closeQuietly(service, store, timeout = 500) {
  // HoldingRuntime 的运行永不自然结束：先取消在跑/排队运行（不改任务状态），否则只能等超时。
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try {
      await service.cancelRunInternal(run.id, false)
    } catch {}
  }
  const started = Date.now()
  while (Date.now() - started < timeout) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch {
      break
    }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    store.close()
  } catch {}
}

const cleanup = async ({ root, store }) => {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const taskRow = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

const taskMessages = (store, taskId) =>
  store.all('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at', taskId)

test('提示词注入：urgent 任务卡注入豁免指令（车道豁免 + git status 现场纪律），非 urgent 零注入', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await seedProject(ctx.service, ctx.store)
    const runtime = new DshRuntime({ ctx: null, config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    const botRow = ctx.store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const projectRow = ctx.store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const actor = ctx.service.actor()
    const urgent = await ctx.service.createTask({ projectId: project.id, title: '紧急修复', priority: 'urgent', writeScopes: ['src/a.js'] }, actor)
    const high = await ctx.service.createTask({ projectId: project.id, title: '高优任务', priority: 'high', writeScopes: ['src/b.js'] }, actor)
    const medium = await ctx.service.createTask({ projectId: project.id, title: '普通任务', writeScopes: ['src/c.js'] }, actor)

    const promptOf = (row) => runtime.promptFor({ run: { kind: 'task' }, bot: botRow, project: projectRow, task: row })
    const urgentPrompt = promptOf(taskRow(ctx.store, urgent.id))
    assert.match(urgentPrompt, /# Urgent exemption/, 'urgent 卡应有豁免段标题')
    assert.match(urgentPrompt, /exempt from lane queuing discipline/, '应注入用户口径的豁免声明')
    assert.match(urgentPrompt, /start immediately/, '应指示立即开工')
    assert.match(urgentPrompt, /git status/, '应注入现场纪律：先 git status 记录现场')
    assert.match(urgentPrompt, /never add\/checkout\/stash others' changes/, '应注入只圈本卡文件的提交纪律')

    for (const row of [taskRow(ctx.store, high.id), taskRow(ctx.store, medium.id)]) {
      const prompt = promptOf(row)
      assert.ok(!prompt.includes('# Urgent exemption'), '非 urgent 不得注入豁免段')
      assert.ok(!prompt.includes('exempt from lane queuing discipline'), '非 urgent 不得出现豁免文案')
    }
  } finally {
    await cleanup(ctx)
  }
})

test('urgent 新卡对同写范围拒单守卫放行：落卡带 priority、run 入队、创建消息报备与在办卡共用车道', async () => {
  const ctx = await setup()
  try {
    const { director, gate } = await seedProject(ctx.service, ctx.store)
    const sessionId = ownerSession(ctx.store, director, gate, 'sess-gate')
    const first = await ctx.service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '第一张小卡', description: '做点事。', write_scopes: ['src/a.js'],
    })
    assert.equal(first.identifier, 'GATE-1')

    // 第一张卡的 run 已在跑（HoldingRuntime 挂起），任务转 in_progress——此时同写范围新卡本应 409。
    await ctx.service.tick()

    const urgent = await ctx.service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '紧急插队卡', description: '生产事故修复。', write_scopes: ['src/a.js'],
      priority: 'urgent',
    })
    assert.equal(urgent.identifier, 'GATE-2', 'urgent 豁免拒单守卫，第二张卡应创建成功')
    assert.equal(taskRow(ctx.store, urgent.id).priority, 'urgent', 'priority=urgent 应落卡（回读核验，不信透传）')

    // 豁免放行 ≠ 静默并行：创建消息必须报备与哪张在办卡共用车道。
    const bodies = taskMessages(ctx.store, urgent.id).map(message => message.body)
    assert.ok(
      bodies.some(body => body.includes('紧急豁免：与在办卡 GATE-1 共用写范围车道，立即开工')),
      `创建消息应报备共用车道，实际消息：${JSON.stringify(bodies)}`,
    )

    // 立即施工：urgent 卡的 run 已入队（排队或已开跑，均在办）。
    await ctx.service.tick()
    const run = ctx.store.get("SELECT * FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", urgent.id)
    assert.ok(run, 'urgent 卡派单后应有在办 run（入队或开跑）')
  } finally {
    await closeQuietly(ctx.service, ctx.store)
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('非 urgent 同写范围派单仍拒单：409 原文案保留，且拒绝消息可见 urgent 豁免入口', async () => {
  const ctx = await setup()
  try {
    const { director, gate } = await seedProject(ctx.service, ctx.store)
    const sessionId = ownerSession(ctx.store, director, gate, 'sess-gate')
    await ctx.service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '第一张小卡', write_scopes: ['src/a.js'],
    })
    await ctx.service.tick()
    await assert.rejects(
      () => ctx.service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '第二张小卡', write_scopes: ['src/a.js'],
        priority: 'high',
      }),
      (error) => {
        assert.equal((error as RejectError).status, 409)
        assert.equal((error as RejectError).code, 'CONFLICT')
        assert.match((error as RejectError).message, /已存在同写范围任务 GATE-1/)
        assert.match((error as RejectError).message, /重派原任务/)
        assert.match((error as RejectError).message, /priority=urgent.*豁免此拦截/, '拒绝消息应指明 urgent 豁免入口')
        return true
      },
    )
    assert.equal(
      Number(ctx.store.get('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?', gate.id)?.n ?? 0),
      1,
      '拒单不落第二张卡',
    )
  } finally {
    await closeQuietly(ctx.service, ctx.store)
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('urgent 无重复卡：正常创建不误报共用车道，消息保持原样', async () => {
  const ctx = await setup()
  try {
    const { director, gate } = await seedProject(ctx.service, ctx.store)
    const sessionId = ownerSession(ctx.store, director, gate, 'sess-gate')
    const urgent = await ctx.service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '唯一紧急卡', write_scopes: ['src/only.js'],
      priority: 'urgent',
    })
    assert.equal(urgent.identifier, 'GATE-1')
    const bodies = taskMessages(ctx.store, urgent.id).map(message => message.body)
    assert.ok(
      bodies.some(body => body.startsWith('任务 GATE-1 已创建')),
      `应有创建消息，实际消息：${JSON.stringify(bodies)}`,
    )
    assert.ok(
      bodies.every(body => !body.includes('共用写范围车道')),
      '无在办同范围卡时不得误报共用车道',
    )
  } finally {
    await closeQuietly(ctx.service, ctx.store)
    await rm(ctx.root, { recursive: true, force: true })
  }
})
