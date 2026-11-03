// DSHBOTS-109 大 PNG 入库/上传前转 JPEG：阈值可配、失败回退原图。
// 转码成功路径用注入的假 sharp 覆盖（仓库依赖树里没有 sharp，不为此引入）；
// 回退路径（无 sharp / 转码失败）走真实链路 sendMessage / steer 验证不阻塞发送。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import {
  convertImagesForUpload,
  prepareImagesForStorage,
  PNG_JPEG_MAX_EDGE,
  PNG_JPEG_QUALITY,
} from '../src/services/message-images.js'

// 假 sharp 工厂：记录调用、按配置返回固定 JPEG 缓冲或抛错。
function fakeSharpFactory({ jpegBuffer, error = null } = {}) {
  const calls = []
  const factory = () => buffer => {
    calls.push({ input: buffer })
    return {
      rotate() { calls.push({ rotate: true }); return this },
      resize(options) { calls.push({ resize: options }); return this },
      flatten(options) { calls.push({ flatten: options }); return this },
      jpeg(options) { calls.push({ jpeg: options }); return this },
      async toBuffer() {
        if (error) throw error
        return jpegBuffer
      },
    }
  }
  factory.calls = calls
  return factory
}

const THRESHOLD = 512 * 1024
// 600KB 的合法 base64（内容不必是真图：校验层不做魔数检查）。
const BIG_PNG_DATA = Buffer.alloc(600 * 1024).toString('base64')
const BIG_PNG_BYTES = 600 * 1024
const SMALL_PNG_DATA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

test('超阈值 PNG 被转成 JPEG：MIME 变 jpeg、体积变小、走 resize/flatten/jpeg 链', async () => {
  const jpegBuffer = Buffer.alloc(120 * 1024, 0x7e)
  const factory = fakeSharpFactory({ jpegBuffer })
  const images = await prepareImagesForStorage(
    [{ mediaType: 'image/png', data: BIG_PNG_DATA, name: 'shot.png' }],
    THRESHOLD, null, factory,
  )
  assert.equal(images.length, 1)
  assert.equal(images[0].mediaType, 'image/jpeg')
  assert.equal(images[0].bytes, jpegBuffer.length)
  assert.equal(images[0].data, jpegBuffer.toString('base64'))
  assert.equal(images[0].name, 'shot.png')
  // 管线参数：最长边 2048、不放大、白底压平、质量 85。
  assert.deepEqual(factory.calls.find(c => c.resize)?.resize, {
    width: PNG_JPEG_MAX_EDGE, height: PNG_JPEG_MAX_EDGE, fit: 'inside', withoutEnlargement: true,
  })
  assert.deepEqual(factory.calls.find(c => c.jpeg)?.jpeg, { quality: PNG_JPEG_QUALITY })
  assert.ok(factory.calls.find(c => c.flatten)?.flatten)
})

test('小 PNG 不转：阈值以下的 png 原样保留，解码器根本不被调用', async () => {
  const factory = fakeSharpFactory({ jpegBuffer: Buffer.alloc(10) })
  const images = await prepareImagesForStorage(
    [{ mediaType: 'image/png', data: SMALL_PNG_DATA }],
    THRESHOLD, null, factory,
  )
  assert.equal(images[0].mediaType, 'image/png')
  assert.equal(images[0].bytes, 8)
  assert.equal(images[0].data, SMALL_PNG_DATA)
  assert.equal(factory.calls.length, 0)
})

test('转码失败回退原图：sharp 抛错时保留原 PNG，不向外抛', async () => {
  const factory = fakeSharpFactory({ error: new Error('bad png') })
  const images = await prepareImagesForStorage(
    [{ mediaType: 'image/png', data: BIG_PNG_DATA }],
    THRESHOLD, null, factory,
  )
  assert.equal(images[0].mediaType, 'image/png')
  assert.equal(images[0].bytes, BIG_PNG_BYTES)
  assert.equal(images[0].data, BIG_PNG_DATA)
})

test('环境无 sharp（工厂返回 null）时超阈值 PNG 也原样返回', async () => {
  const images = await convertImagesForUpload(
    [{ mediaType: 'image/png', data: BIG_PNG_DATA, bytes: BIG_PNG_BYTES }],
    THRESHOLD, null, () => null,
  )
  assert.equal(images[0].mediaType, 'image/png')
  assert.equal(images[0].data, BIG_PNG_DATA)
})

test('gif / webp 超阈值也不动：动图与透明语义保留', async () => {
  const factory = fakeSharpFactory({ jpegBuffer: Buffer.alloc(10) })
  const images = await prepareImagesForStorage([
    { mediaType: 'image/gif', data: BIG_PNG_DATA },
    { mediaType: 'image/webp', data: BIG_PNG_DATA },
  ], THRESHOLD, null, factory)
  assert.equal(images[0].mediaType, 'image/gif')
  assert.equal(images[1].mediaType, 'image/webp')
  assert.equal(factory.calls.length, 0)
})

test('转出来不小于原图时保留原 PNG（白转不如不转）', async () => {
  const factory = fakeSharpFactory({ jpegBuffer: Buffer.alloc(BIG_PNG_BYTES) })
  const images = await prepareImagesForStorage(
    [{ mediaType: 'image/png', data: BIG_PNG_DATA }],
    THRESHOLD, null, factory,
  )
  assert.equal(images[0].mediaType, 'image/png')
  assert.equal(images[0].bytes, BIG_PNG_BYTES)
})

test('阈值为 0 时关闭转换，大小 PNG 都原样', async () => {
  const images = await convertImagesForUpload(
    [{ mediaType: 'image/png', data: BIG_PNG_DATA, bytes: BIG_PNG_BYTES }],
    0, null, fakeSharpFactory({ jpegBuffer: Buffer.alloc(10) }),
  )
  assert.equal(images[0].mediaType, 'image/png')
})

test('config：阈值默认 512KB，env 可覆盖，非法 env 回退默认', () => {
  const had = process.env.DSH_TEAM_IMAGE_PNG_JPEG_THRESHOLD_BYTES
  try {
    delete process.env.DSH_TEAM_IMAGE_PNG_JPEG_THRESHOLD_BYTES
    assert.equal(resolveConfig({}).imagePngJpegThresholdBytes, 512 * 1024)
    process.env.DSH_TEAM_IMAGE_PNG_JPEG_THRESHOLD_BYTES = '1024'
    assert.equal(resolveConfig({}).imagePngJpegThresholdBytes, 1024)
    process.env.DSH_TEAM_IMAGE_PNG_JPEG_THRESHOLD_BYTES = 'not-a-number'
    assert.equal(resolveConfig({}).imagePngJpegThresholdBytes, 512 * 1024)
  } finally {
    if (had === undefined) delete process.env.DSH_TEAM_IMAGE_PNG_JPEG_THRESHOLD_BYTES
    else process.env.DSH_TEAM_IMAGE_PNG_JPEG_THRESHOLD_BYTES = had
  }
})

// ── 真实链路：sendMessage / steer 在无（可用）sharp 时回退原图、不阻塞发送 ──
// 测试数据不是合法图片：即使环境里解析到真 sharp，解码也会失败走回退，断言依旧成立。

class FakeRuntime {
  constructor() {
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return this.models }
  async validateBotConfig() {}
  async startRun({ run }) {
    setImmediate(() => { void this.handler({ runId: run.id, status: 'succeeded', output: 'ok', error: null }) })
    return `session-${run.id}`
  }
  async cancelRun() { return true }
}

async function setupService() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-imgconv-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  await writeFile(join(workspace, '.agents', 'skills', 'noop'), '')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new FakeRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const project = await service.createProject({
    name: 'Conv Project', key: 'CNV', ownerBotId: director.id, memberIds: [],
  })
  return { root, store, service, config, project }
}

async function teardown(root, store) {
  // 等待 sendMessage 触发的后台 run 排空再关库（仿 message-images.test.js 的 closeQuietly）。
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2000) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch { break }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

test('sendMessage：超阈值 PNG 无解码能力时原样落库，消息发送不阻塞', async () => {
  const { root, store, service, project } = await setupService()
  try {
    const result = await service.sendMessage(project.id, '大图', { type: 'user', id: 'u1' }, null, [
      { mediaType: 'image/png', data: BIG_PNG_DATA, name: 'big.png' },
    ])
    assert.ok(result.messageId)
    const row = store.get('SELECT * FROM message_images WHERE message_id = ?', result.messageId)
    assert.equal(row.media_type, 'image/png')
    assert.equal(row.bytes, BIG_PNG_BYTES)
    assert.equal(row.data, BIG_PNG_DATA)
  } finally {
    await teardown(root, store)
  }
})

test('steer：超阈值 PNG 无解码能力时 image 分片原样投递', async () => {
  const { root, store, config } = await setupService()
  try {
    const calls = []
    const runtime = new DshRuntime({
      ctx: { sessionController: { prompt: async arg => { calls.push(arg) } } },
      config,
      store,
      logger: { info() {}, warn() {}, error() {} },
    })
    await runtime.steer('sess-conv', '看这张大图', [{ mediaType: 'image/png', data: BIG_PNG_DATA, bytes: BIG_PNG_BYTES }])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].content, [
      { type: 'text', text: '看这张大图' },
      { type: 'image', mediaType: 'image/png', data: BIG_PNG_DATA },
    ])
  } finally {
    await teardown(root, store)
  }
})
