import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

class ManualRuntime { declare started: any[]; declare pendingRuns: any; declare handler: any;
  constructor() {
    this.started = []
    this.pendingRuns = new Map()
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  async startRun({ run, chatMessage }) {
    this.started.push({ runId: run.id, botId: run.bot_id, kind: run.kind, mode: run.mode, chatMessage: chatMessage?.body ?? null })
    this.pendingRuns.set(run.id, run)
    return `session-${run.id}`
  }

  async steer() { return true }

  async cancelRun() { return true }

  complete(runId, status = 'succeeded', output = 'done', error = null) {
    this.pendingRuns.delete(runId)
    return this.handler({ runId, status, output, error })
  }
}

async function soloSetup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-solo-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  return { root, store, service, runtime, config, director, dev }
}

async function closeQuietly(store, timeout = 2000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
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

test('初始化为每个 bot 建好 _the_bots 下的专属目录', async () => {
  const { root, store, service, config, director, dev } = await soloSetup()
  try {
    const botsHome = join(config.workspace, '_the_bots')
    for (const bot of [director, dev]) {
      assert.ok(bot.solo_dir, `${bot.name} 应有 solo_dir`)
      const dir = await stat(join(botsHome, bot.solo_dir))
      assert.ok(dir.isDirectory())
    }
    const view = service.botView(dev)
    assert.equal(view.soloDir, dev.solo_dir)
    assert.ok(view.soloWorkspace.endsWith(join('_the_bots', dev.solo_dir)))

    // 新建 bot 立即分到目录
    const artist = await service.createBot({ name: 'Painter', role: '美术', provider: 'fake', model: 'model-b' })
    const row = store.get('SELECT * FROM bots WHERE id = ?', artist.id)
    assert.ok(row.solo_dir)
    assert.ok((await stat(join(botsHome, row.solo_dir))).isDirectory())
    // 目录名不冲突
    assert.notEqual(row.solo_dir, director.solo_dir)
    assert.notEqual(row.solo_dir, dev.solo_dir)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('单聊消息走 solo_chat 运行并回写单聊消息', async () => {
  const { root, store, service, runtime, dev } = await soloSetup()
  try {
    const result = await service.sendSoloMessage(dev.id, '单独问你一个问题')
    assert.ok(result.messageId)
    assert.equal(result.runBot, dev.id)

    const run = store.get("SELECT * FROM runs WHERE kind = 'solo_chat'")
    assert.ok(run, '应产生 solo_chat 运行')
    assert.equal(run.project_id, null)
    assert.equal(run.bot_id, dev.id)
    assert.equal(run.mode, 'write')
    assert.equal(run.trigger_ref, result.messageId)

    service.started = true
    await service.tick()
    assert.equal(runtime.started.length, 1)
    assert.equal(runtime.started[0].kind, 'solo_chat')
    assert.equal(runtime.started[0].chatMessage, '单独问你一个问题')

    await runtime.complete(run.id, 'succeeded', '这是单聊回复。')
    const reply = store.get("SELECT * FROM solo_messages WHERE sender_type = 'bot'")
    assert.ok(reply)
    assert.equal(reply.body, '这是单聊回复。')
    assert.equal(reply.run_id, run.id)
    const finished = store.get('SELECT * FROM runs WHERE id = ?', run.id)
    assert.equal(finished.status, 'succeeded')

    // 失败也要落一条系统可见的回复
    const second = await service.sendSoloMessage(dev.id, '再问一次')
    await service.tick()
    const failing = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND status = 'running'")
    await runtime.complete(failing.id, 'failed', '', { code: 'X', message: 'boom' })
    const failReply = store.get('SELECT * FROM solo_messages WHERE run_id = ?', failing.id)
    // DSHBOTS-267：失败只落白名单类别+摘要，原始错误串 boom 不透传。
    assert.match(failReply.body, /运行失败（未知）：/)
    assert.doesNotMatch(failReply.body, /boom/)
    assert.equal(second.messageId, failing.trigger_ref)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('单聊 /clear 与 /remember：清空会话与写 bot 记忆', async () => {
  const { root, store, service, runtime, dev } = await soloSetup()
  try {
    await service.sendSoloMessage(dev.id, '第一条')
    await service.sendSoloMessage(dev.id, '/remember Builder 偏好中文回复')
    const memory = store.get("SELECT * FROM memories WHERE scope_type = 'bot' AND scope_id = ?", dev.id)
    assert.ok(memory)
    assert.match(memory.content, /中文回复/)
    assert.equal(memory.source, 'chat-command')
    const notice = store.all("SELECT * FROM solo_messages WHERE sender_type = 'system'")
    assert.equal(notice.length, 1)
    assert.match(notice[0].body, /记忆/)

    const cleared = await service.sendSoloMessage(dev.id, '/clear')
    assert.ok(cleared.cleared >= 2)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM solo_messages').n, 0)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('state 携带 solo 段：单聊消息、运行与 bot 视图', async () => {
  const { root, store, service, runtime, director, dev } = await soloSetup()
  try {
    const project = await service.createProject({ name: 'Mix', key: 'MIX', ownerBotId: director.id, memberIds: [dev.id] })
    await service.sendSoloMessage(dev.id, '你好')
    service.started = true
    await service.tick()
    const run = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND status = 'running'")
    await runtime.complete(run.id, 'succeeded', '收到')

    const view = await service.state(project.id, dev.id)
    assert.equal(view.solo.bot.id, dev.id)
    assert.equal(view.solo.bot.soloDir, dev.solo_dir)
    assert.equal(view.solo.messages.length, 2)
    assert.equal(view.solo.messages[0].body, '你好')
    assert.equal(view.solo.messages[0].senderName, view.me.name)
    assert.equal(view.solo.messages[1].senderName, 'Builder')
    assert.equal(view.solo.runs.length, 1)
    assert.equal(view.solo.runs[0].kind, 'solo_chat')
    assert.equal(view.solo.runs[0].project_id, null)
    // 群聊段不受影响
    assert.equal(view.project.id, project.id)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('单聊与同 Bot 群聊互不阻塞、同 Bot 单聊合批、跨 Bot 单聊并行（DSHBOTS-219 分身通道）', async () => {
  const { root, store, service, runtime, director, dev } = await soloSetup()
  try {
    const project = await service.createProject({ name: 'Mix', key: 'MIX', ownerBotId: director.id, memberIds: [dev.id] })
    await service.createTask({ projectId: project.id, title: '长任务', assigneeBotId: dev.id, autoStart: true })
    await service.sendSoloMessage(dev.id, '单聊插个问题')
    await service.sendSoloMessage(dev.id, '单聊第二条')
    await service.sendMessage(project.id, '@Builder 群里也回一句')
    await service.sendSoloMessage(director.id, '和总监单独聊聊')

    service.started = true
    await service.tick()
    const running = store.all("SELECT * FROM runs WHERE status = 'running'")
    const kinds = running.map(row => `${row.kind}:${row.bot_id}`)
    // 任务运行（写锁在项目）+ Builder 单聊（第一条）+ 总监单聊可同时跑
    assert.ok(kinds.includes(`task:${dev.id}`), running.map(r => r.kind).join(','))
    assert.ok(kinds.includes(`solo_chat:${dev.id}`))
    assert.ok(kinds.includes(`solo_chat:${director.id}`))
    // 分身通道（DSHBOTS-219）：同一 bot 的群聊回复不再被单聊占道——即使单聊还挂着，群聊照常启动
    assert.ok(kinds.includes(`chat:${dev.id}`), '单聊运行期间群聊回复应并行启动')
    // DSHBOTS-231 合批：同 bot 第二条单聊在首条领取时合并进同一轮上下文，不再单独排队。
    const queued = store.all("SELECT * FROM runs WHERE status = 'queued'")
    assert.ok(!queued.some(row => row.kind === 'solo_chat' && row.bot_id === dev.id), '同 bot 第二条单聊应被合并，不再排队')
    const devSolo = running.find(row => row.kind === 'solo_chat' && row.bot_id === dev.id)
    assert.equal(JSON.parse(devSolo.merged_messages).length, 1, '首条单聊运行应携带被合并的第二条消息')

    await runtime.complete(devSolo.id, 'succeeded', '单聊回复')
    await service.tick()
    const secondSolo = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND bot_id = ? AND status = 'running'", dev.id)
    assert.ok(!secondSolo, '第二条单聊已合并进首条运行，不再单独启动')
    await runtime.complete(running.find(row => row.kind === 'solo_chat' && row.bot_id === director.id).id, 'succeeded', '好')
    await runtime.complete(store.get("SELECT * FROM runs WHERE kind = 'chat' AND status = 'running'").id, 'succeeded', '群聊回复')
    await runtime.complete(store.get("SELECT * FROM runs WHERE kind = 'task' AND status = 'running'").id, 'succeeded', 'done')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('单聊会话：身份提示词、运行提示词与 recall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-solo-prompt-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0 })
  const store = openDatabase(config.dbPath)
  try {
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, solo_dir, created_at, updated_at)
       VALUES ('b1', 'Builder', '开发', 'Build things.', 'blue', 'active', 0, 'builder', ?, ?)`, now, now,
    )
    store.run(
      `INSERT INTO memories(scope_type, scope_id, topic, content, status, created_by, created_at, updated_at)
       VALUES ('bot', 'b1', '偏好', '回复保持简短', 'active', 'user:user_local', ?, ?)`, now, now,
    )
    store.run(
      'INSERT INTO solo_messages(id, bot_id, sender_type, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      'msg_000123', 'b1', 'user', 'user_local', '之前那条消息', now,
    )
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES ('sess-solo', 'b1', NULL, 'solo', NULL, ?)",
      now,
    )
    const runtime = new DshRuntime({ ctx: {}, config, store, logger: { warn() {} } as DshLogger })

    const identity = runtime.systemPromptFor({ agent: { id: 'sess-solo' } })
    assert.match(identity, /Solo conversation/)
    assert.match(identity, /_the_bots\/builder/)
    assert.doesNotMatch(identity, /Long-term memory/, '记忆块不再进 system 区')
    assert.doesNotMatch(identity, /回复保持简短/, '记忆内容不再出现在身份段')
    assert.doesNotMatch(identity, /team_assign_task to hand/)

    // 记忆块改走宿主 runtime-context 通道（历史尾部 user 快照），单聊会话仍可见
    const memoryContext = runtime.memoryContextFor({ agent: { id: 'sess-solo' } })
    assert.match(memoryContext, /Long-term memory/)
    assert.match(memoryContext, /回复保持简短/)

    const run = { kind: 'solo_chat', bot_id: 'b1' }
    const prompt = runtime.promptFor({ run, bot: store.get('SELECT * FROM bots WHERE id = ?', 'b1'), chatMessage: { body: '新消息' } } as any)
    assert.match(prompt, /Solo message/)
    assert.match(prompt, /新消息/)
    assert.match(prompt, /m_000123/)
    assert.match(prompt, /one-on-one/)

    const service = new TeamService({ store, config, logger: { warn() {} } as DshLogger })
    const recalled = service.recall('sess-solo', 'm_000123')
    assert.match(recalled, /之前那条消息/)
    assert.throws(() => service.recall('sess-solo', 'c_abc123'), /只支持展开 m_ 消息引用/)
    assert.throws(
      () => service.rememberFromBot('sess-solo', { scope: 'project', topic: 'x', content: 'y' }),
      /只能写 bot 或 team 记忆/,
    )
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('runs 与 session_bindings 的 project_id 迁移为可空', async () => {
  const { root, store } = await soloSetup()
  try {
    const runsInfo = store.all('PRAGMA table_info(runs)')
    const bindingsInfo = store.all('PRAGMA table_info(session_bindings)')
    assert.equal(runsInfo.find(column => column.name === 'project_id').notnull, 0)
    assert.equal(bindingsInfo.find(column => column.name === 'project_id').notnull, 0)
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
       VALUES ('r-solo', NULL, (SELECT id FROM bots LIMIT 1), 'solo_chat', 'write', 'mention', 'queued', 1, 'k-solo', ?)`, now,
    )
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES ('s-solo', (SELECT id FROM bots LIMIT 1), NULL, 'solo', NULL, ?)",
      now,
    )
    // DSHBOTS-285：solo 车道唯一索引已退役，车道行可共存（历史/过渡态），不再被拒
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES ('s-solo2', (SELECT id FROM bots LIMIT 1), NULL, 'solo', NULL, ?)",
      now,
    )
    // 收敛不变量：每 bot 恰一条 kind='bot' 活跃绑定
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias) VALUES ('s-bot', (SELECT id FROM bots LIMIT 1), NULL, 'bot', NULL, ?, 0)",
      now,
    )
    assert.throws(() => store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias) VALUES ('s-bot2', (SELECT id FROM bots LIMIT 1), NULL, 'bot', NULL, ?, 0)",
      now,
    ))
    assert.equal(store.all('PRAGMA foreign_key_check').length, 0)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
