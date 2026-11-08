// DSHBOTS-145：会话结转（单 bot 聊天会话超阈值后结转新会话并注入 bot 自写摘要）。
// 覆盖：阈值未触发/触发、摘要未就绪继续复用旧会话（含幂等补排）、摘要就绪删旧绑定走新建、
// 新会话首轮提示词注入摘要一次且清零后不重复注入、0=关闭、task 亲和不结转、dm 落控制面单绑定、
// 摘要运行路由回旧会话、finishRun 成功落库/失败留痕、单聊（无项目）结转、
// 支撑索引迁移幂等、executeRun→摘要提示词→finishRun→下次复用开新会话的完整链路、
// 消费闸（DSHBOTS-213）：非结转顶替会话的普通轮次不得消费摘要，阈值再触发直接结转不重排。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig, rolloverPendingKey, rolloverSummaryKey } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { ensureRolloverSchema, ROLLOVER_MIGRATION } from '../src/services/rollover-schema.js'

const logger = { info() {}, warn() {}, error() {} }
const TURNS = 3

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup({ turns = TURNS } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-rollover-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 30_000, sessionRolloverTurns: turns,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

const cleanup = async ({ root, store, service }) => {
  try { service.started = false } catch {}
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

// 捕获版最小宿主替身：录下每次下发的提示词，并给出可控的新建会话 id。
const captureHost = (sink) => {
  const created = []
  return {
    created,
    sessionController: {
      resolveAgent: async () => ({}),
      selectModel: async () => ({}),
      create: async () => {
        const sessionId = `sess-new-${created.length + 1}`
        created.push(sessionId)
        return { sessionId }
      },
      prompt: async (request) => { sink.push(request.content.map(part => part.text ?? '').join('\n')) },
      cancel: async () => {},
    },
  }
}

const newRuntime = (ctx, config, store) => new DshRuntime({ ctx, config, store, logger })

async function primeProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Rollover', key: 'RLV', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project }
}

// 种子绑定默认即 bot 的 kind='bot' 控制面绑定（DSHBOTS-289 收敛后唯一活跃车道）。
const bindSession = (store, { botId, projectId, sessionId, kind = 'bot', taskId = null }) => {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    sessionId, botId, projectId, kind, taskId, new Date().toISOString(),
  )
}

// 轮次口径 = runs 表按 session_id 的 COUNT(*)（不限 status），直接落库模拟历史运行。
const seedRuns = (store, { projectId, botId, sessionId, count, kind = 'chat', taskId = null }) => {
  const at = new Date().toISOString()
  for (let i = 0; i < count; i += 1) {
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, session_id, queued_at)
       VALUES (?, ?, ?, ?, ?, 'read', 'test', 'succeeded', 1, ?, ?, ?)`,
      `run_seed_${sessionId}_${i}`, projectId, botId, taskId, kind, `seed:${sessionId}:${i}`, sessionId, at,
    )
  }
}

const rolloverRuns = (store) => store.all("SELECT * FROM runs WHERE kind = 'rollover_summary'")

// 播种会话当前上下文规模（P2）：input+cache_read 之和即 sessionContextTokens 的取值。
const seedUsage = (store, { sessionId, ctx: tokens, occurredAt }) => {
  const run = store.get('SELECT id FROM runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1', sessionId)
  if (!run) throw new Error('seedUsage 需要会话上已有运行行')
  store.run(
    `INSERT INTO usage_events(id, source_key, run_id, input_tokens, cache_read_tokens, output_tokens, occurred_at, created_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    `use_seed_${sessionId}_${occurredAt}`, `seedusage:${sessionId}:${occurredAt}`, run.id, tokens, occurredAt, occurredAt,
  )
}

test('阈值未触发：轮数低于阈值时复用旧会话，且不排摘要运行', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS - 1 })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })

    assert.equal(sessionId, 'sess-old', '低于阈值应复用旧会话')
    assert.equal(rolloverRuns(ctx.store).length, 0, '低于阈值不得排摘要运行')
  } finally {
    await cleanup(ctx)
  }
})

test('阈值触发且摘要未就绪：幂等补排一条摘要运行，并继续复用旧会话（不阻塞对话）', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })

    assert.equal(sessionId, 'sess-old', '摘要未就绪不得开新会话')
    const queued = rolloverRuns(ctx.store)
    assert.equal(queued.length, 1, '应恰好补排一条摘要运行')
    assert.equal(queued[0].status, 'queued')
    assert.equal(queued[0].mode, 'read', '摘要运行只读')
    assert.equal(queued[0].session_id, 'sess-old', '摘要运行必须复用旧会话')
    assert.equal(queued[0].trigger_ref, 'sess-old')
    assert.equal(queued[0].idempotency_key, 'rollover_summary:sess-old')
    assert.equal(
      ctx.store.all("SELECT type FROM run_events WHERE run_id = ? AND type = 'queued'", queued[0].id).length,
      1,
      '应留 queued 事件',
    )

    const again = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    assert.equal(again, 'sess-old')
    assert.equal(rolloverRuns(ctx.store).length, 1, '摘要运行未结束不得重复排队')
  } finally {
    await cleanup(ctx)
  }
})

test('运行中触发摘要补排（生产断点回归）：bot 自己的运行进行中超阈值，摘要运行必须真实落库', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS })
    // 生产形态：当前运行已被领取（running、session_id 未回填），它的 (bot, project) 占着
    // one_active_run_per_bot 串行域。修复前摘要 INSERT OR IGNORE 被静默吞掉（live 库实测：
    // 索引激活 DSHBOTS-288 之后摘要运行 0 条入队，结转链路整体死亡）。
    ctx.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
       VALUES ('run_current', ?, ?, 'chat', 'read', 'mention', 'running', 1, 'chat:cur:1', ?)`,
      project.id, dev.id, new Date().toISOString(),
    )

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'chat', id: 'run_current' } }), 'sess-old', '摘要未就绪继续复用旧会话')
    const queued = rolloverRuns(ctx.store)
    assert.equal(queued.length, 1, '当前运行占串行域时也必须能排入摘要运行（治理运行豁免串行索引）')
    assert.equal(queued[0].status, 'queued')
    assert.equal(queued[0].session_id, 'sess-old', '摘要运行复用旧会话')
  } finally {
    await cleanup(ctx)
  }
})

test('P2 体积上限：轮数未到但会话上下文超上限同样触发摘要补排；体积不足则纯轮次口径', async () => {
  // 轮数阈值拉高到够不着，只有体积判据（默认 150k）能触发。
  const ctx = await setup({ turns: 999 })
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 3 })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    seedUsage(ctx.store, { sessionId: 'sess-old', ctx: 100_000, occurredAt: '2026-11-08T00:00:00Z' })
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'chat' } }), 'sess-old')
    assert.equal(rolloverRuns(ctx.store).length, 0, '体积低于上限且轮数未到：不触发')

    seedUsage(ctx.store, { sessionId: 'sess-old', ctx: 200_000, occurredAt: '2026-11-08T00:01:00Z' })
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'chat' } }), 'sess-old', '摘要未就绪继续复用旧会话')
    const queued = rolloverRuns(ctx.store)
    assert.equal(queued.length, 1, '上下文超上限即触发摘要补排，不等待轮数阈值')
    assert.equal(queued[0].session_id, 'sess-old')
  } finally {
    await cleanup(ctx)
  }
})

test('摘要就绪后：旧绑定降级为授权别名并新建会话，旧 session 宿主侧不受影响', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS })

    const host = captureHost([])
    const runtime = newRuntime(host, ctx.config, ctx.store)
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'chat' } }), 'sess-old')
    assert.equal(rolloverRuns(ctx.store).length, 1)

    ctx.store.setSetting(rolloverSummaryKey(dev.id, project.id), '旧会话交接：任务 A 完成 80%，未决问题 B。')
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })

    assert.equal(sessionId, 'sess-new-1', '摘要就绪后应开新会话')
    // DSHBOTS-256：旧绑定不再删除，降级为 alias=1 授权别名（旧 session 仍解析到同 bot/项目）。
    assert.equal(ctx.store.get('SELECT * FROM session_bindings WHERE session_id = ?', 'sess-old')?.alias, 1, '旧绑定应降级为授权别名')
    assert.equal(ctx.store.get('SELECT * FROM session_bindings WHERE session_id = ?', 'sess-new-1')?.alias, 0, '新绑定应是活跃绑定')
    assert.deepEqual(host.created, ['sess-new-1'], '只新建一次会话；旧 session 只降级绑定不删宿主会话')
  } finally {
    await cleanup(ctx)
  }
})

test('结转后旧会话 id 仍通过 owner/member 鉴权（DSHBOTS-256）', async () => {
  const ctx = await setup()
  try {
    const { director, dev, project } = await primeProject(ctx.service, ctx.store)
    // 种子总监没有模型，ensureSession 的 selectModel 会拒；补上模型并回读最新行。
    ctx.store.run("UPDATE bots SET provider = 'fake', model = 'model-a' WHERE id = ?", director.id)
    const owner = ctx.store.get('SELECT * FROM bots WHERE id = ?', director.id)
    // 总监会话：结转后旧 id 仍应通过 ownerContextFor。
    bindSession(ctx.store, { botId: owner.id, projectId: project.id, sessionId: 'sess-owner-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: owner.id, sessionId: 'sess-owner-old', count: TURNS })
    // 成员会话：结转后旧 id 仍应通过 memberContextFor，但仍不是总监。
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-dev-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-dev-old', count: TURNS })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    ctx.store.setSetting(rolloverSummaryKey(director.id, project.id), '总监交接摘要。')
    ctx.store.setSetting(rolloverSummaryKey(dev.id, project.id), '成员交接摘要。')
    assert.equal(await runtime.ensureSession(owner, project, { run: { kind: 'chat' } }), 'sess-new-1')
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'chat' } }), 'sess-new-2')

    const ownerOld = ctx.service.ownerContextFor('sess-owner-old')
    assert.equal(ownerOld.project.id, project.id, '旧会话应解析回原项目')
    assert.equal(ownerOld.actor.id, director.id, '旧会话应解析回原 bot')
    assert.equal(ctx.service.ownerContextFor('sess-new-1').project.id, project.id, '新会话同样解析到原项目')

    const memberOld = ctx.service.memberContextFor('sess-dev-old')
    assert.equal(memberOld.project.id, project.id, '成员旧会话应解析回原项目')
    assert.equal(memberOld.bot.id, dev.id, '成员旧会话应解析回原 bot')
    assert.throws(
      () => ctx.service.ownerContextFor('sess-dev-old'),
      /只有项目总监 Bot 可以执行该操作/,
      '成员旧会话不得越权当总监',
    )

    // 二次结转：更早的别名与刚降级的别名都仍解析到同一项目/bot。
    seedRuns(ctx.store, { projectId: project.id, botId: owner.id, sessionId: 'sess-new-1', count: TURNS })
    ctx.store.setSetting(rolloverSummaryKey(owner.id, project.id), '二次交接摘要。')
    assert.equal(await runtime.ensureSession(owner, project, { run: { kind: 'chat' } }), 'sess-new-3')
    assert.equal(ctx.store.get('SELECT * FROM session_bindings WHERE session_id = ?', 'sess-new-1')?.alias, 1, '二次结转后首轮新会话也降级为别名')
    assert.equal(ctx.service.ownerContextFor('sess-owner-old').project.id, project.id, '最早别名仍解析回原项目')
    assert.equal(ctx.service.ownerContextFor('sess-new-1').project.id, project.id, '二次别名仍解析回原项目')
    assert.equal(ctx.service.ownerContextFor('sess-new-3').project.id, project.id, '当前活跃绑定解析回原项目')
  } finally {
    await cleanup(ctx)
  }
})

test('结转别名不跨 bot/项目：未绑定或其他项目的 session 不得被冒用（DSHBOTS-256）', async () => {
  const ctx = await setup()
  try {
    const { director, dev, project } = await primeProject(ctx.service, ctx.store)
    // 单绑定模型（DSHBOTS-289）：同 bot 只有一条 kind='bot' 活跃绑定，跨项目场景改用
    // 两个成员 bot 各占一个项目，结转后各自旧会话仍只能解析回自己的 bot/项目。
    const dev2 = await ctx.service.createBot({ name: 'Builder2', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
    const project2 = await ctx.service.createProject({ name: 'Rollover 其他项目', key: 'RLV2', ownerBotId: director.id, memberIds: [dev2.id] })
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS })
    bindSession(ctx.store, { botId: dev2.id, projectId: project2.id, sessionId: 'sess-old-2' })
    seedRuns(ctx.store, { projectId: project2.id, botId: dev2.id, sessionId: 'sess-old-2', count: TURNS })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    ctx.store.setSetting(rolloverSummaryKey(dev.id, project.id), '项目一交接摘要。')
    ctx.store.setSetting(rolloverSummaryKey(dev2.id, project2.id), '项目二交接摘要。')
    await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    await runtime.ensureSession(dev2, project2, { run: { kind: 'chat' } })

    assert.equal(ctx.service.memberContextFor('sess-old').project.id, project.id, '旧会话不得漂到别的 bot/项目')
    assert.equal(ctx.service.memberContextFor('sess-old-2').project.id, project2.id, '另一 bot/项目的旧会话只解析回本项目')
    assert.throws(
      () => ctx.service.memberContextFor('sess-never-bound'),
      /只有项目群中的 Bot 可以执行该操作/,
      '从未绑定的 session 不得被授权',
    )
    assert.throws(
      () => ctx.service.ownerContextFor('sess-old'),
      /只有项目总监 Bot 可以执行该操作/,
      '成员旧会话在 owner 闸门必须被拒绝',
    )
  } finally {
    await cleanup(ctx)
  }
})

test('新会话首轮提示词注入摘要块一次，清零后不重复注入', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    ctx.store.setSetting(rolloverSummaryKey(dev.id, project.id), '交接摘要正文。')
    // 结转路径开新会话时会写入 pending 标记（见 ensureSession），此处按同口径预置。
    ctx.store.setSetting(rolloverPendingKey(dev.id, project.id), 'sess-new-1')

    const first = runtime.promptFor({ run: { kind: 'chat' }, bot: dev, project, chatMessage: { body: '在吗' }, sessionId: 'sess-new-1' })
    assert.ok(first.includes('# Handoff summary from the previous session'), '首轮应注入摘要块')
    assert.ok(first.includes('交接摘要正文。'), '摘要正文应原样注入')
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, project.id)), '', '注入后应即刻清零')

    const second = runtime.promptFor({ run: { kind: 'chat' }, bot: dev, project, chatMessage: { body: '继续' }, sessionId: 'sess-new-1' })
    assert.ok(!second.includes('# Handoff summary from the previous session'), '清零后不得重复注入')
  } finally {
    await cleanup(ctx)
  }
})

test('消费闸：非结转顶替会话的普通轮次不消费摘要，阈值再触发直接结转不重排摘要运行', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    // 场景还原（生产 11-04 实发）：旧会话摘要已就绪，但绑定已被非结转路径顶替成替身会话。
    ctx.store.setSetting(rolloverSummaryKey(dev.id, project.id), '旧会话交接摘要。')
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-replacement' })

    // 替身会话远低于阈值的普通聊天轮：不得注入、不得清零摘要。
    const ordinary = runtime.promptFor({ run: { kind: 'chat' }, bot: dev, project, chatMessage: { body: '在吗' }, sessionId: 'sess-replacement' })
    assert.ok(!ordinary.includes('# Handoff summary from the previous session'), '非结转顶替会话的普通轮次不得注入摘要')
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, project.id)), '旧会话交接摘要。', '摘要不得被提前清零')

    // 替身会话超阈值后复用：摘要仍在 → 直接结转开新会话，不重排摘要运行。
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-replacement', count: TURNS })
    const rolled = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    assert.equal(rolled, 'sess-new-1', '摘要就绪应直接结转')
    assert.equal(rolloverRuns(ctx.store).length, 0, '不得重排摘要运行')
    assert.equal(ctx.store.setting(rolloverPendingKey(dev.id, project.id)), 'sess-new-1', '结转应登记新会话为注入目标')

    const first = runtime.promptFor({ run: { kind: 'chat' }, bot: dev, project, chatMessage: { body: '继续' }, sessionId: rolled })
    assert.ok(first.includes('旧会话交接摘要。'), '结转新会话首轮应注入摘要')
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, project.id)), '', '注入后应即刻清零')
  } finally {
    await cleanup(ctx)
  }
})

test('0=关闭：阈值 0 时不结转、不排摘要运行', async () => {
  const ctx = await setup({ turns: 0 })
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 999 })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })

    assert.equal(sessionId, 'sess-old', '关闭时应继续复用旧会话')
    assert.equal(rolloverRuns(ctx.store).length, 0, '关闭时不得排摘要运行')
  } finally {
    await cleanup(ctx)
  }
})

test('摘要运行路由回旧会话：ensureSession 直接复用 run.session_id，不新建也不再排摘要', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS })

    const host = captureHost([])
    const runtime = newRuntime(host, ctx.config, ctx.store)
    await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    const summary = rolloverRuns(ctx.store)[0]

    const sessionId = await runtime.ensureSession(dev, project, { run: summary })
    assert.equal(sessionId, 'sess-old', '摘要运行应回到旧会话')
    assert.equal(host.created.length, 0, '摘要运行不得新建会话')
    assert.equal(rolloverRuns(ctx.store).length, 1, '摘要运行自身不得再触发结转')
  } finally {
    await cleanup(ctx)
  }
})

test('finishRun 收尾：成功落 settings 并留 ready 痕，失败留 failed 痕且不写摘要', async () => {
  const ctx = await setup()
  try {
    const { director, dev, project } = await primeProject(ctx.service, ctx.store)
    // 单绑定模型（DSHBOTS-289）：同 bot 只有一条 kind='bot' 活跃绑定，两个摘要运行分属
    // 两个成员 bot 各自的项目控制面会话，success/failed 两分支互不共用 bot 名额。
    const dev2 = await ctx.service.createBot({ name: 'Builder2', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
    const project2 = await ctx.service.createProject({ name: 'Rollover 2', key: 'RL2', ownerBotId: director.id, memberIds: [dev2.id] })
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old-1' })
    bindSession(ctx.store, { botId: dev2.id, projectId: project2.id, sessionId: 'sess-old-2' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old-1', count: TURNS })
    seedRuns(ctx.store, { projectId: project2.id, botId: dev2.id, sessionId: 'sess-old-2', count: TURNS })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    await runtime.ensureSession(dev2, project2, { run: { kind: 'chat' } })
    const [summary1, summary2] = rolloverRuns(ctx.store)

    await ctx.service.finishRun({ runId: summary1.id, status: 'succeeded', output: '交接：进行中任务 X。' })
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, project.id)), '交接：进行中任务 X。')
    assert.equal(
      ctx.store.all("SELECT type FROM run_events WHERE run_id = ? AND type = 'rollover_summary_ready'", summary1.id).length,
      1,
      '成功应留 rollover_summary_ready 事件',
    )

    await ctx.service.finishRun({ runId: summary2.id, status: 'failed', output: '', error: { message: 'boom' } })
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev2.id, project2.id)), null, '失败不得写摘要')
    assert.equal(
      ctx.store.all("SELECT type FROM run_events WHERE run_id = ? AND type = 'rollover_summary_failed'", summary2.id).length,
      1,
      '失败应留 rollover_summary_failed 事件',
    )
  } finally {
    await cleanup(ctx)
  }
})

test('单聊结转：无项目上下文也能排摘要运行、落库并注入', async () => {
  const ctx = await setup({ turns: 2 })
  try {
    const { dev } = await primeProject(ctx.service, ctx.store)
    // 单聊会话即该 bot 的 kind='bot' 控制面绑定（project_id 空），不再有独立 solo 车道行。
    bindSession(ctx.store, { botId: dev.id, projectId: null, sessionId: 'sess-solo' })
    seedRuns(ctx.store, { projectId: null, botId: dev.id, sessionId: 'sess-solo', count: 2, kind: 'solo_chat' })

    const host = captureHost([])
    const runtime = newRuntime(host, ctx.config, ctx.store)
    assert.equal(await runtime.ensureSession(dev, null, { run: { kind: 'solo_chat' } }), 'sess-solo')

    const summary = rolloverRuns(ctx.store)[0]
    assert.equal(summary.project_id, null, '单聊摘要运行不带项目')
    assert.equal(summary.session_id, 'sess-solo')

    await ctx.service.finishRun({ runId: summary.id, status: 'succeeded', output: '单聊交接摘要' })
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, null)), '单聊交接摘要')

    const second = await runtime.ensureSession(dev, null, { run: { kind: 'solo_chat' } })
    assert.equal(second, 'sess-new-1', '摘要就绪后单聊也应开新会话')
    const prompt = runtime.promptFor({ run: { kind: 'solo_chat' }, bot: dev, chatMessage: { body: '在吗' }, sessionId: second })
    assert.ok(prompt.includes('# Handoff summary from the previous session'), '单聊新会话应注入摘要块')
    assert.ok(prompt.includes('单聊交接摘要'))
  } finally {
    await cleanup(ctx)
  }
})

test('并发兜底：同一会话重复补排摘要运行不抛唯一约束错，也不产生第二条', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)

    runtime.enqueueRolloverSummary({ bot: dev, project, sessionId: 'sess-old' })
    assert.doesNotThrow(() => runtime.enqueueRolloverSummary({ bot: dev, project, sessionId: 'sess-old' }), '重复补排不得抛错（否则会带崩当前对话运行）')
    assert.equal(rolloverRuns(ctx.store).length, 1, '重复补排不得产生第二条摘要运行')
  } finally {
    await cleanup(ctx)
  }
})

test('task 与 dm 不再走独立车道：task 亲和回原会话，dm 落控制面单绑定，均不结转', async () => {
  const ctx = await setup({ turns: 1 })
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    // task 半边：kind='task' 绑定 + 带 task_id 的历史运行，未终态任务流量按 runs 归属回原会话。
    const task = await ctx.service.createTask({ projectId: project.id, title: '任务会话', assigneeBotId: dev.id }, ctx.service.actor())
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-task', kind: 'task', taskId: task.id })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-task', count: 50, kind: 'task', taskId: task.id })
    // dm 半边：kind='dm' 车道已删，dm 流量落 bot 的 kind='bot' 控制面绑定；
    // 该绑定无历史轮次，不触发结转。
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-dm' })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'task' }, task }), 'sess-task', '未终态任务按 runs 归属回原会话')
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'dm' } }), 'sess-dm', 'dm 流量应落控制面单绑定')
    assert.equal(rolloverRuns(ctx.store).length, 0, 'task 亲和与 dm 控制面会话均不结转')
  } finally {
    await cleanup(ctx)
  }
})

test('支撑索引迁移幂等：建库后建索引并登记恰一次，重开库不重复登记', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rollover-schema-'))
  try {
    const workspace = join(root, 'workspace')
    const dataDir = join(root, 'data')
    await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
    const config = resolveConfig({
      workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000,
    })
    const store = openDatabase(config.dbPath)
    const hasIndex = () => store.all("PRAGMA index_list('runs')").some(row => row.name === 'runs_session_idx')
    const ledgerCount = () => store.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?', ROLLOVER_MIGRATION).n

    // 建库 SCHEMA（db.js）不含该索引——索引由结转域自管迁移负责。
    assert.equal(hasIndex(), false, '建库 DDL 不含 runs_session_idx')
    ensureRolloverSchema(store)
    assert.equal(hasIndex(), true, '迁移后应有 runs_session_idx')
    assert.equal(ledgerCount(), 1)
    ensureRolloverSchema(store)
    assert.equal(ledgerCount(), 1, '同 store 重跑不得重复登记')

    store.close()
    const reopened = openDatabase(config.dbPath)
    try {
      ensureRolloverSchema(reopened)
      assert.equal(reopened.all("PRAGMA index_list('runs')").some(row => row.name === 'runs_session_idx'), true)
      assert.equal(
        reopened.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?', ROLLOVER_MIGRATION).n,
        1,
        '重开库不重复登记',
      )
    } finally {
      reopened.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('完整链路：executeRun 下发生成摘要提示词 → finishRun 落库 → 下次复用开新会话并注入', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS })

    const prompts = []
    const runtime = newRuntime(captureHost(prompts), ctx.config, ctx.store)
    // 把真实 runtime 挂到 service，executeRun 才会走真实 startRun。
    ctx.service.attachRuntime(runtime)

    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'chat' } }), 'sess-old')
    const summary = rolloverRuns(ctx.store)[0]

    await ctx.service.executeRun(summary.id)
    const pending = runtime.pendingByRun.get(summary.id) as { timer?: ReturnType<typeof setTimeout> } | undefined
    if (pending?.timer) clearTimeout(pending.timer)

    assert.ok(prompts[0]?.includes('# Handoff summary request'), '摘要运行应下发摘要请求提示词')
    assert.ok(!prompts[0]?.includes('# Handoff summary from the previous session'), '旧会话不得注入新会话摘要块')

    await ctx.service.finishRun({ runId: summary.id, status: 'succeeded', output: '交接摘要：进行中任务 Y，未决问题 Z。' })
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, project.id)), '交接摘要：进行中任务 Y，未决问题 Z。')

    const second = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    assert.equal(second, 'sess-new-1', '摘要就绪后应开新会话')
    const chatPrompt = runtime.promptFor({ run: { kind: 'chat' }, bot: dev, project, chatMessage: { body: '继续' }, sessionId: second })
    assert.ok(chatPrompt.includes('交接摘要：进行中任务 Y，未决问题 Z。'), '新会话首轮提示词应注入摘要')
  } finally {
    await cleanup(ctx)
  }
})
