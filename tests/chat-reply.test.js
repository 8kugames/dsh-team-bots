import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

class FakeRuntime {
  constructor(service) {
    this.service = service
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
    this.started = []
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return this.models }

  async validateBotConfig() {}

  async startRun({ run, bot }) {
    this.started.push({ id: run.id, kind: run.kind, botId: run.bot_id })
    setImmediate(() => {
      void this.handler({
        runId: run.id,
        status: 'succeeded',
        output: run.kind === 'chat' ? `Reply from ${bot.name}.` : 'Done.',
        error: null,
      })
    })
    return `session-${run.id}`
  }

  async cancelRun() { return true }
}

async function closeQuietly(store, timeout = 2000) {
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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reply-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`)
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new FakeRuntime(service))
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

async function replySetup() {
  const env = await setup()
  const { store, service } = env
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const builder = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({
    name: 'Reply Project', key: 'REPLY', ownerBotId: director.id, memberIds: [builder.id],
  })
  return { ...env, director, builder, project }
}

test('replyTo 落库并出现在消息视图的 reply_to 字段', async () => {
  const { root, store, service, builder, project } = await replySetup()
  try {
    const botMessageId = service.insertMessage({ projectId: project.id, senderType: 'bot', senderId: builder.id, body: '这是 Bot 的原始回答' })
    const actor = { type: 'user', id: 'u1' }
    const result = await service.sendMessage(project.id, '针对这条再补充一下', actor, botMessageId)
    const row = store.get('SELECT * FROM messages WHERE id = ?', result.messageId)
    assert.equal(row.reply_to_id, botMessageId)

    const state = await service.state(project.id)
    const sent = state.messages.find(message => message.id === result.messageId)
    assert.equal(sent.reply_to.id, botMessageId)
    assert.equal(sent.reply_to.sender_name, 'Builder')
    assert.equal(sent.reply_to.excerpt, '这是 Bot 的原始回答')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('replyTo 指向不存在或跨项目的消息时返回 400，命令路径忽略引用参数', async () => {
  const { root, store, service, builder, project } = await replySetup()
  try {
    const actor = { type: 'user', id: 'u1' }
    await assert.rejects(
      () => service.sendMessage(project.id, '回复一条不存在的消息', actor, 'msg_nonexistent'),
      /引用的消息不存在/,
    )

    // 跨项目：另一个项目的消息 id 同样拒绝。
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const other = await service.createProject({ name: 'Other', key: 'OTHER', ownerBotId: director.id })
    const otherMessageId = service.insertMessage({ projectId: other.id, senderType: 'bot', senderId: builder.id, body: '别的项目的消息' })
    await assert.rejects(
      () => service.sendMessage(project.id, '跨项目引用', actor, otherMessageId),
      /引用的消息不存在/,
    )

    // /remember 命令路径不走引用校验：即使 replyTo 是悬空 id 也不报错。
    const remembered = await service.sendMessage(project.id, '/remember 先写测试', actor, 'msg_nonexistent')
    assert.ok(remembered.messageId)
    assert.equal(remembered.memory, true)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('无显式 @mention 回复 bot 消息时定向到该 bot 而非总监', async () => {
  const { root, store, service, builder, project } = await replySetup()
  try {
    const botMessageId = service.insertMessage({ projectId: project.id, senderType: 'bot', senderId: builder.id, body: 'Bot 的上一轮回答' })
    const actor = { type: 'user', id: 'u1' }
    const result = await service.sendMessage(project.id, '这条再展开讲讲', actor, botMessageId)
    assert.deepEqual(result.runBots, [builder.id])

    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    assert.notEqual(result.runBots[0], director.id)

    const row = store.get('SELECT * FROM messages WHERE id = ?', result.messageId)
    assert.equal(row.reply_to_id, botMessageId)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('显式 @mention 优先于引用定向，引用仍落库作上下文', async () => {
  const { root, store, service, director, builder, project } = await replySetup()
  try {
    const botMessageId = service.insertMessage({ projectId: project.id, senderType: 'bot', senderId: builder.id, body: 'Bot 的上一轮回答' })
    const actor = { type: 'user', id: 'u1' }
    const result = await service.sendMessage(project.id, '@director 帮忙看看这个回答', actor, botMessageId)
    assert.deepEqual(result.runBots, [director.id])

    const row = store.get('SELECT * FROM messages WHERE id = ?', result.messageId)
    assert.equal(row.reply_to_id, botMessageId)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('reply_to.excerpt 截断到 120 字', async () => {
  const { root, store, service, builder, project } = await replySetup()
  try {
    const longBody = '长'.repeat(300)
    const botMessageId = service.insertMessage({ projectId: project.id, senderType: 'bot', senderId: builder.id, body: longBody })
    const actor = { type: 'user', id: 'u1' }
    const result = await service.sendMessage(project.id, '收到', actor, botMessageId)
    const state = await service.state(project.id)
    const sent = state.messages.find(message => message.id === result.messageId)
    assert.equal(sent.reply_to.excerpt.length, 120)
    assert.equal(sent.reply_to.excerpt, '长'.repeat(120))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('chat 运行提示词包含引用上下文行（含 m_ 短 id 与 200 字摘要）', async () => {
  const { root, store, service, config, builder, project } = await replySetup()
  try {
    const longBody = `引用正文开始。${'细节'.repeat(120)}引用正文结束。`
    const botMessageId = service.insertMessage({ projectId: project.id, senderType: 'bot', senderId: builder.id, body: longBody })
    const actor = { type: 'user', id: 'u1' }
    const result = await service.sendMessage(project.id, '接着这条说', actor, botMessageId)
    const userMessage = store.get('SELECT * FROM messages WHERE id = ?', result.messageId)

    const runtime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
    const botRow = store.get('SELECT * FROM bots WHERE id = ?', builder.id)
    const projectRow = store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const prompt = runtime.promptFor({ run: { kind: 'chat' }, bot: botRow, project: projectRow, task: null, chatMessage: userMessage })

    assert.ok(prompt.includes('用户引用了 Builder 的消息'), '提示词应包含引用行')
    assert.ok(prompt.includes(`[m_${botMessageId.slice(-6)}]`), '引用行应带 m_ 短 id 供 team_recall')
    // Recent context 也会带同一条消息（前 240 字），因此只对引用行本身断言 200 字截断。
    const quoteExcerpt = /用户引用了 Builder 的消息 \[m_\w+\]：(.*)/.exec(prompt)?.[1]
    assert.equal(quoteExcerpt, longBody.slice(0, 200), '引用行摘要应恰为正文前 200 字')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

// UI 按 tests/ac.test.js 的读源码断言先例：引用按钮、引用条、气泡引用块的关键标记存在。
test('UI 源码包含引用回复的关键标记', () => {
  const appSource = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
  const styleSource = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')

  // hover 引用按钮 + 点击动作
  assert.ok(appSource.includes('msg-quote-btn'), '消息行应有 hover 引用按钮')
  assert.ok(appSource.includes("case 'quote-message'"), '点击应有 quote-message 动作')
  // composer 引用条 + 取消
  assert.ok(appSource.includes('reply-bar'), 'composer 上方应有引用条')
  assert.ok(appSource.includes("case 'cancel-reply'"), '引用条应有取消动作')
  // 气泡引用块
  assert.ok(appSource.includes('msg-quote'), '气泡顶部应有引用块')
  assert.ok(appSource.includes('↩ '), '引用块应带 ↩ 前缀')
  // 发送 payload 带引用，成功后清除
  assert.ok(appSource.includes('replyTo: state.replyTo.id'), '发送 payload 应带 replyTo')
  assert.ok(/state\.replyTo = null/.test(appSource), '发送/取消后应清除引用状态')
  // Esc 取消引用
  assert.ok(/Escape' && state\.replyTo/.test(appSource), 'Esc 应能取消引用条')

  // 样式：引用条与引用块均有明暗主题共用变量的样式
  for (const marker of ['.reply-bar', '.reply-bar-cancel', '.msg-quote', '.msg-quote-btn', '.message-row.user .msg-quote']) {
    assert.ok(styleSource.includes(marker), `styles.css 缺少 ${marker}`)
  }
})
