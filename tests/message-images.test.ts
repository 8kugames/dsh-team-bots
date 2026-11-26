// DSHBOTS-36 聊天图片输入：落库、校验、runtime 组装与读取鉴权。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { handleAction } from '../src/api.js'
import { normalizeImageInputs } from '../src/services/message-images.js'

// 1x1 PNG 的字节片段（不做魔数校验，只验证白名单与体积口径）。
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

// assert.rejects 断言谓词收到的 error（AppError 的 code/message 消费面）。
type RejectError = { code?: string; message?: string }

class FakeRuntime {
  declare models: Array<{
    ref: string; provider: string; providerName: string; model: string; name: string;
    efforts: Array<{ id: string; name: string }>; defaultEffort: string;
  }>
  declare started: Array<{ id: string; kind: string; botId: string }>
  declare handler: (result: { runId: string; status: string; output: string; error: unknown }) => void

  constructor() {
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
      void this.handler({ runId: run.id, status: 'succeeded', output: 'ok', error: null })
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`)
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new FakeRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const builder = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({
    name: 'Image Project', key: 'IMG', ownerBotId: director.id, memberIds: [builder.id],
  })
  return { root, store, service, config, director, builder, project }
}

const actor = () => ({ type: 'user', id: 'u1' })

test('send_message 带图片：图片单独落 message_images，正文不含 base64', async () => {
  const { root, store, service, project } = await setup()
  try {
    const result = await service.sendMessage(project.id, '看看这张图', actor(), null, [
      { mediaType: 'image/png', data: PNG_BASE64, name: 'shot.png' },
    ])
    assert.ok(result.messageId)

    const row = service.groupChatStore(project.id).get('SELECT * FROM messages WHERE id = ?', result.messageId)
    assert.equal(row.body, '看看这张图')
    assert.ok(!row.body.includes(PNG_BASE64))

    const imageRows = service.groupChatStore(project.id).all('SELECT * FROM message_images WHERE message_id = ?', result.messageId)
    assert.equal(imageRows.length, 1)
    assert.equal(imageRows[0].media_type, 'image/png')
    assert.equal(imageRows[0].name, 'shot.png')
    assert.equal(imageRows[0].bytes, 8)
    assert.equal(imageRows[0].data, PNG_BASE64)
    assert.equal(imageRows[0].project_id, project.id)

    // 消息视图带图片元数据，但不含 base64。
    const view = service.messageView(row)
    assert.equal(view.images.length, 1)
    assert.deepEqual(Object.keys(view.images[0]).sort(), ['bytes', 'id', 'mediaType', 'name'])
    assert.equal(view.images[0].mediaType, 'image/png')
    assert.equal(view.images[0].bytes, 8)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('图片校验：超 5MB / 第 5 张 / 非白名单 MIME / 非法 base64 一律 400', async () => {
  const { root, store, service, project } = await setup()
  try {
    const oversize = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')
    await assert.rejects(
      () => service.sendMessage(project.id, '太大了', actor(), null, [{ mediaType: 'image/png', data: oversize }]),
      error => (error as RejectError).code === 'BAD_REQUEST' && /不能超过 5MB/.test((error as RejectError).message),
    )

    const five = Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: PNG_BASE64 }))
    await assert.rejects(
      () => service.sendMessage(project.id, '五张', actor(), null, five),
      error => (error as RejectError).code === 'BAD_REQUEST' && /最多 4 张/.test((error as RejectError).message),
    )

    await assert.rejects(
      () => service.sendMessage(project.id, 'SVG 不放行', actor(), null, [{ mediaType: 'image/svg+xml', data: PNG_BASE64 }]),
      error => (error as RejectError).code === 'BAD_REQUEST' && /不支持的图片类型/.test((error as RejectError).message),
    )

    await assert.rejects(
      () => service.sendMessage(project.id, '坏 base64', actor(), null, [{ mediaType: 'image/png', data: 'not base64!!' }]),
      error => (error as RejectError).code === 'BAD_REQUEST' && /base64/.test((error as RejectError).message),
    )

    // 校验失败不留任何行。
    assert.equal(Number(service.groupChatStore(project.id).get('SELECT COUNT(*) AS n FROM message_images')?.n ?? 0), 0)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('base64 严格判定：字母表外字符、补位位置与数量', () => {
  // 合法串另需长度是 4 的倍数，由 normalizeImageData 的第二条卡住。
  const cases = [
    ['AAAA', true], ['AAA=', true], ['AA==', true],
    ['', false], ['=', false], ['==', false], ['====', false], ['A===', false],
    ['AA=A', false], ['A=AA', false], ['=AAA', false], ['AAAA=', false],
    ['AA A=', false], ['AA-A=', false], ['AA_A=', false], ['中文==', false], ['AAAA\nAAAA', false],
  ]
  for (const [data, valid] of cases) {
    const attempt = () => normalizeImageInputs([{ mediaType: 'image/png', data }])
    if (valid) assert.doesNotThrow(attempt, JSON.stringify(data))
    else assert.throws(attempt, (error: RejectError) => error.code === 'BAD_REQUEST', JSON.stringify(data))
  }
})

test('大图校验不经过正则：MB 级 base64 不抛栈溢出，照常落库', async () => {
  const { root, store, service, project } = await setup()
  // 宿主里带量词的 base64 正则在 MB 级输入上抛过 RangeError: Maximum call stack size exceeded；
  // 这里让一切跑在百万字符级输入上的 RegExp#test 抛同样的错，断言发送链路不依赖它。
  const originalTest = RegExp.prototype.test
  RegExp.prototype.test = function (string) {
    if (String(string).length > 1_000_000) throw new RangeError('Maximum call stack size exceeded')
    return originalTest.call(this, string)
  }
  try {
    const big = Buffer.alloc(4 * 1024 * 1024, 0xff).toString('base64')
    const result = await service.sendMessage(project.id, '大图', actor(), null, [{ mediaType: 'image/jpeg', data: big }])
    const rows = service.groupChatStore(project.id).all('SELECT bytes, data FROM message_images WHERE message_id = ?', result.messageId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].bytes, 4 * 1024 * 1024)
    assert.equal(rows[0].data, big)
  } finally {
    RegExp.prototype.test = originalTest
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('单聊同样支持图片：solo_messages 走 solo_message_id 分支', async () => {
  const { root, store, service, builder } = await setup()
  try {
    const result = await service.sendSoloMessage(builder.id, '单聊带图', actor(), [
      { mediaType: 'image/jpeg', data: PNG_BASE64 },
    ])
    assert.ok(result.messageId)
    const imageRows = service.soloChatStore(builder.id).all('SELECT * FROM message_images WHERE solo_message_id = ?', result.messageId)
    assert.equal(imageRows.length, 1)
    assert.equal(imageRows[0].bot_id, builder.id)
    assert.equal(imageRows[0].message_id, null)

    const view = service.soloMessageView(service.soloChatStore(builder.id).get('SELECT * FROM solo_messages WHERE id = ?', result.messageId))
    assert.equal(view.images.length, 1)
    assert.equal(view.images[0].mediaType, 'image/jpeg')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('get_message_image：用户取得到 base64，bot 越权被拒，id 不存在 404', async () => {
  const { root, store, service, project, builder } = await setup()
  try {
    const sent = await service.sendMessage(project.id, '取图', actor(), null, [
      { mediaType: 'image/png', data: PNG_BASE64, name: 'a.png' },
    ])
    const imageId = service.messageView(service.groupChatStore(project.id).get('SELECT * FROM messages WHERE id = ?', sent.messageId)).images[0].id

    const image = await handleAction(service, 'get_message_image', { imageId }, actor())
    assert.equal(image.mediaType, 'image/png')
    assert.equal(image.data, PNG_BASE64)
    assert.equal(image.bytes, 8)
    assert.equal(image.name, 'a.png')

    // bot 走工具通道取图一律拒绝。
    await assert.rejects(
      () => handleAction(service, 'get_message_image', { imageId }, { type: 'bot', id: builder.id }),
      error => (error as RejectError).code === 'FORBIDDEN',
    )
    await assert.rejects(
      () => handleAction(service, 'get_message_image', { imageId: 'img_nonexistent' }, actor()),
      error => (error as RejectError).code === 'NOT_FOUND',
    )
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('steer 组装 content：带图片时有 image 分片，不带图片时与原行为一致', async () => {
  const { root, store, service, config } = await setup()
  try {
    const calls = []
    const runtime = new DshRuntime({
      ctx: { sessionController: { prompt: async (arg) => { calls.push(arg) } } },
      config,
      store,
      logger: { info() {}, warn() {}, error() {} },
      chatStores: { forRun: run => service.runChatStore(run) },
    })

    await runtime.steer('sess-1', '看下这张', [{ mediaType: 'image/png', data: PNG_BASE64, name: 'a.png' }])
    assert.deepEqual(calls[0].content, [
      { type: 'text', text: '看下这张' },
      { type: 'image', mediaType: 'image/png', data: PNG_BASE64, name: 'a.png' },
    ])

    // 不带图片：content 与从前逐字段一致（只有一条 text 分片）。
    await runtime.steer('sess-2', '纯文字')
    assert.deepEqual(calls[1].content, [{ type: 'text', text: '纯文字' }])
    assert.equal(calls[1].content.length, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('新会话首条 prompt 带图片分片', async () => {
  const { root, store, service, config, director, project } = await setup()
  try {
    const sent = await service.sendMessage(project.id, '这张图里有啥', actor(), null, [
      { mediaType: 'image/png', data: PNG_BASE64 },
    ])
    const chatMessage = service.groupChatStore(project.id).get('SELECT * FROM messages WHERE id = ?', sent.messageId)

    const calls = []
    const runtime = new DshRuntime({
      ctx: {
        sessionController: {
          create: async () => ({ sessionId: 'sess-img' }),
          resolveAgent: async () => ({ agent: { session: {} } }),
          selectModel: async () => ({ selected: {} }),
          prompt: async (arg) => { calls.push(arg) },
        },
      },
      config,
      store,
      logger: { info() {}, warn() {}, error() {} },
      chatStores: { forRun: run => service.runChatStore(run) },
    })

    const bot = store.get('SELECT * FROM bots WHERE id = ?', director.id)
    // 争用口径 A（DSHBOTS-289）：sendMessage 已同步给 director 排上 chat 运行，等
    // FakeRuntime 自动收尾腾出 bot 槽，再播种本用例的 runs 行（同 bot 第二条活跃
    // 行会撞 one_active_run_per_bot）。
    const drainDeadline = Date.now() + 2000
    while (Date.now() < drainDeadline) {
      const active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
      if (active === 0) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, idempotency_key, queued_at)
       VALUES ('run-img', ?, ?, 'chat', 'write', 'chat_message', ?, 'running', 'img-test-key', ?)`,
      project.id, director.id, sent.messageId, new Date().toISOString(),
    )
    const run = store.get('SELECT * FROM runs WHERE id = ?', 'run-img')
    await runtime.startRun({ run, bot, project, task: null, chatMessage, sessionKind: 'project' })

    assert.equal(calls.length, 1)
    const content = calls[0].content
    assert.equal(content[0].type, 'text')
    assert.deepEqual(content[1], { type: 'image', mediaType: 'image/png', data: PNG_BASE64 })
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('消息行被删除时图片行随 FK 级联一起消失（覆盖留存清理路径）', async () => {
  const { root, store, service, project } = await setup()
  try {
    const sent = await service.sendMessage(project.id, '待清理', actor(), null, [
      { mediaType: 'image/png', data: PNG_BASE64 },
    ])
    assert.equal(Number(service.groupChatStore(project.id).get('SELECT COUNT(*) AS n FROM message_images')?.n ?? 0), 1)

    // 留存清理（src/usage.js 的按天删旧消息）走的是直接删 messages 行，
    // 图片行靠 message_images 的 ON DELETE CASCADE 跟随。
    service.groupChatStore(project.id).run('DELETE FROM messages WHERE id = ?', sent.messageId)
    assert.equal(Number(service.groupChatStore(project.id).get('SELECT COUNT(*) AS n FROM message_images')?.n ?? 0), 0)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('不带 images 时消息视图的图片字段是空数组，清空历史会连带删图', async () => {
  const { root, store, service, project } = await setup()
  try {
    const plain = await service.sendMessage(project.id, '纯文字消息', actor())
    const plainView = service.messageView(service.groupChatStore(project.id).get('SELECT * FROM messages WHERE id = ?', plain.messageId))
    assert.deepEqual(plainView.images, [])

    const withImage = await service.sendMessage(project.id, '带图消息', actor(), null, [
      { mediaType: 'image/png', data: PNG_BASE64 },
    ])
    assert.equal(Number(service.groupChatStore(project.id).get('SELECT COUNT(*) AS n FROM message_images')?.n ?? 0), 1)

    service.clearChatHistory(project.id, actor())
    assert.equal(Number(service.groupChatStore(project.id).get('SELECT COUNT(*) AS n FROM message_images')?.n ?? 0), 0)
    assert.equal(Number(service.groupChatStore(project.id).get('SELECT COUNT(*) AS n FROM messages WHERE project_id = ?', project.id)?.n ?? 0), 0)
    assert.ok(withImage.messageId)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('纯图片消息：正文可为空，但正文与图片不能同时为空', async () => {
  const { root, store, service, project } = await setup()
  try {
    const imageOnly = await service.sendMessage(project.id, '', actor(), null, [
      { mediaType: 'image/png', data: PNG_BASE64 },
    ])
    assert.ok(imageOnly.messageId)
    assert.equal(service.groupChatStore(project.id).get('SELECT body FROM messages WHERE id = ?', imageOnly.messageId).body, '')

    await assert.rejects(
      () => service.sendMessage(project.id, '', actor(), null, []),
      error => (error as RejectError).code === 'BAD_REQUEST' && /消息不能为空/.test((error as RejectError).message),
    )
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('image_offload=1 的运行不下发图片分片（续答运行口径）', async () => {
  const { root, store, service, config, director, project } = await setup()
  try {
    const sent = await service.sendMessage(project.id, '这张图里有啥', actor(), null, [
      { mediaType: 'image/png', data: PNG_BASE64 },
    ])
    const chatMessage = service.groupChatStore(project.id).get('SELECT * FROM messages WHERE id = ?', sent.messageId)
    const calls = []
    const runtime = new DshRuntime({
      ctx: {
        sessionController: {
          create: async () => ({ sessionId: 'sess-img-offload' }),
          resolveAgent: async () => ({ agent: { session: {} } }),
          selectModel: async () => ({ selected: {} }),
          prompt: async (arg) => { calls.push(arg) },
        },
      },
      config,
      store,
      logger: { info() {}, warn() {}, error() {} },
      chatStores: { forRun: run => service.runChatStore(run) },
    })
    const bot = store.get('SELECT * FROM bots WHERE id = ?', director.id)
    // 争用口径 A：等 sendMessage 排上的 chat 运行收尾腾出 bot 槽再播种本用例运行。
    const drainDeadline = Date.now() + 2000
    while (Date.now() < drainDeadline) {
      const active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')")?.n ?? 0)
      if (active === 0) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, image_offload, queued_at)
       VALUES ('run-img-offload', ?, ?, 'chat', 'read', 'chat_message', ?, 'running', 1, 'img-offload-key', 1, ?)`,
      project.id, director.id, sent.messageId, new Date().toISOString(),
    )
    const run = store.get('SELECT * FROM runs WHERE id = ?', 'run-img-offload')
    await runtime.startRun({ run, bot, project, task: null, chatMessage, sessionKind: 'project' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].content.length, 1, '续答运行不带 image 分片')
    assert.equal(calls[0].content[0].type, 'text')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
