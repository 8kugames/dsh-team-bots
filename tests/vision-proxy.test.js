// tests/vision-proxy.test.js —— DSHBOTS-112：读图代理产品化护栏。
// 主模型无视觉（发送前预判 modalities 无 image，或宿主报 does not support image input）
// 时自动派生 kind='vision'、mode='read' 只读转写运行；代理未配置/转写失败只审计
// 降级、按现状报错；同消息幂等不双派。
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
  isImageUnsupportedError,
  visionProxyTarget,
  considerVisionProxy,
  spawnVisionProxyRun,
  maybeSpawnVisionAfterFailure,
} from '../src/services/vision-proxy.js'

// 1x1 红色 PNG（70 字节）：走真实图片校验/落库链路。
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const imageInput = () => [{ mediaType: 'image/png', data: TINY_PNG }]

// 可控 modalities 的运行时：默认挂起全部运行供状态断言；auto=true 时全部自动收尾
// （vision 按 failVision 成功转写/失败，其余运行一律成功回 'ok'）——同 bot 运行经
// claimKey 严格串行，不自动收尾前一条，vision 派生运行就永远轮不到执行。
class ModalitiesRuntime {
  constructor(modalities, { failVision = false, auto = false } = {}) {
    this.modalities = modalities
    this.failVision = failVision
    this.auto = auto
  }
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) {
    const autoVision = run.kind === 'vision' && (this.auto || this.modalities === undefined)
    if (!(this.auto || autoVision)) return 'session-hold'
    const fail = run.kind === 'vision' && this.failVision
    setImmediate(() => {
      void this.handler({
        runId: run.id,
        status: fail ? 'failed' : 'succeeded',
        output: run.kind === 'vision'
          ? (fail ? '' : '图片 1\n【类型】界面截图\n【主体】构建失败的任务列表\n【文字】DSHBOTS-112 FAILED at tests/vision-proxy.test.js:31')
          : 'ok',
        error: fail ? { code: 'MODEL_ERROR', message: 'upstream boom' } : null,
      })
    })
    return `session-${run.id}`
  }
  async steer() { return true }
  async cancelRun() { return true }
  get ctx() {
    return { llm: { resolveModelInfo: async () => ({ inputModalities: this.modalities }) } }
  }
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timeout waiting for condition')
}

// proxy=true 时注入读图代理配置；runtime 见各用例。
async function setup({ runtime, proxy = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-vision-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(
    join(workspace, '.agents', 'skills', 'review', 'SKILL.md'),
    `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`,
  )
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20,
    ...(proxy ? { visionProxyProvider: 'minimax', visionProxyModel: 'MiniMax-M3.1-Flash' } : {}),
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(runtime ?? new ModalitiesRuntime(['text']))
  await service.initialize()
  // 起真实调度间隔：派生 vision 运行与原 chat 运行同 bot 串行，前者要等后者完结后
  // 由下一拍 interval 领取（sendXxx 内的一次 tick 撞上 bot 槽占用会被跳过）。
  service.start()
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const project = await service.createProject({
    name: 'Vision', key: 'VIS', ownerBotId: director.id, memberIds: [dev.id],
  })
  const promptRuntime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const actor = { type: 'user', id: service.localUserId }
  const visionRuns = () => store.all("SELECT * FROM runs WHERE kind = 'vision' ORDER BY queued_at")
  const close = async () => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')")?.n ?? 0)
      if (active === 0) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    service.stop()
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { root, store, service, director, dev, project, promptRuntime, actor, config, visionRuns, close }
}

test('isImageUnsupportedError：宿主串/pi-ai 串/错误码三种口径都命中，无关错误不误伤', () => {
  assert.ok(isImageUnsupportedError({ message: 'Model "deepseek-chat" does not support image input.' }), '宿主 prompt() 抛错串')
  assert.ok(isImageUnsupportedError({ message: 'minimax does not support image input for model-x' }), 'pi-ai 传输层串')
  assert.ok(isImageUnsupportedError({ code: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: 'x' }), '宿主错误码')
  assert.ok(isImageUnsupportedError({ code: 'session/attachment-invalid', reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: 'x' }), 'RemoteError reason')
  assert.equal(isImageUnsupportedError({ code: 'RATE_LIMIT', message: 'slow down' }), false, '限流不命中')
  assert.equal(isImageUnsupportedError({ message: 'quota exhausted' }), false)
  assert.equal(isImageUnsupportedError(null), false)
})

test('发送前预判：modalities 无 image 的带图消息直接派生 vision 运行（规格升级主路径）', async () => {
  const t = await setup({ runtime: new ModalitiesRuntime(['text']) })
  try {
    const sent = await t.service.sendMessage(t.project.id, '@Builder 看看这张截图', t.actor, null, imageInput())
    const run = await waitFor(() => t.visionRuns()[0])
    assert.equal(run.kind, 'vision')
    assert.equal(run.mode, 'read', '只读转写')
    assert.equal(run.trigger_type, 'vision_proxy')
    assert.equal(run.trigger_ref, sent.messageId, '挂在原消息上')
    assert.equal(run.project_id, t.project.id)
    assert.equal(run.model_provider, 'minimax', '代理模型 provider')
    assert.equal(run.model_model, 'MiniMax-M3.1-Flash', '代理模型 model')
    assert.equal(run.idempotency_key, `vision:${sent.messageId}:${t.dev.id}`)
    assert.ok(
      t.store.get('SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = ?', run.id, 'queued'),
      'run_events 记 queued',
    )
    // 原对话不受派生阻塞：chat_run 照常入列。
    assert.ok(
      t.store.get("SELECT 1 AS ok FROM outbox WHERE idempotency_key = ?", `chat:${sent.messageId}:${t.dev.id}`),
      '原 chat 运行照常派发',
    )
  } finally { await t.close() }
})

test('有 image modality 的模型不派生，消息照常直发', async () => {
  const t = await setup({ runtime: new ModalitiesRuntime(['text', 'image']) })
  try {
    const sent = await t.service.sendMessage(t.project.id, '@Builder 看图', t.actor, null, imageInput())
    // 直接 await 决策入口拿确定性结论（sendMessage 内同一函数 fire-and-forget）。
    const decision = await considerVisionProxy(t.service, { bot: t.dev, message: { id: sent.messageId, project_id: t.project.id } })
    assert.equal(decision, null, '有视觉不派生')
    assert.equal(t.visionRuns().length, 0)
    assert.ok(
      t.store.get("SELECT 1 AS ok FROM outbox WHERE idempotency_key = ?", `chat:${sent.messageId}:${t.dev.id}`),
      '原消息照常派发',
    )
    assert.equal(
      t.store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('vision.fallback','vision.transcribe')").n, 0,
      '不留任何 vision 审计',
    )
  } finally { await t.close() }
})

test('代理未配置：不派生，只审计 vision.fallback（proxy_not_configured），按现状报错不静默', async () => {
  const t = await setup({ runtime: new ModalitiesRuntime(['text']), proxy: false })
  try {
    assert.equal(visionProxyTarget(t.config), null, '双双非空才启用')
    const sent = await t.service.sendMessage(t.project.id, '@Builder 看图', t.actor, null, imageInput())
    const decision = await considerVisionProxy(t.service, { bot: t.dev, message: { id: sent.messageId, project_id: t.project.id } })
    assert.equal(decision, null)
    assert.equal(t.visionRuns().length, 0, '不派生运行')
    const audit = t.store.get("SELECT * FROM audit_log WHERE action = 'vision.fallback'")
    assert.ok(audit, '降级有审计')
    const data = JSON.parse(audit.data_json)
    assert.equal(data.reason, 'proxy_not_configured')
    assert.equal(data.messageId, sent.messageId)
  } finally { await t.close() }
})

test('config 代理模型支持 env 覆盖（DSH_TEAM_VISION_PROXY_PROVIDER/MODEL）', () => {
  process.env.DSH_TEAM_VISION_PROXY_PROVIDER = 'openai'
  process.env.DSH_TEAM_VISION_PROXY_MODEL = 'gpt-4o-mini'
  try {
    const config = resolveConfig({ workspace: '/tmp/ws', dataDir: '/tmp/data' })
    assert.deepEqual(
      visionProxyTarget(config),
      { provider: 'openai', model: 'gpt-4o-mini', ref: 'openai/gpt-4o-mini' },
    )
  } finally {
    delete process.env.DSH_TEAM_VISION_PROXY_PROVIDER
    delete process.env.DSH_TEAM_VISION_PROXY_MODEL
  }
  const bare = resolveConfig({ workspace: '/tmp/ws', dataDir: '/tmp/data' })
  assert.equal(visionProxyTarget(bare), null, '未配置（默认空）= 不启用')
})

test('同消息幂等：重复评估/重复派生/UNIQUE 撞车都只留一条 vision 运行', async () => {
  const t = await setup({ runtime: new ModalitiesRuntime(['text']) })
  try {
    const sent = await t.service.sendMessage(t.project.id, '@Builder 看图', t.actor, null, imageInput())
    const message = { id: sent.messageId, project_id: t.project.id }
    const first = await considerVisionProxy(t.service, { bot: t.dev, message })
    const second = await considerVisionProxy(t.service, { bot: t.dev, message })
    const third = spawnVisionProxyRun(t.service, { bot: t.dev, message })
    assert.ok(first && second && third)
    assert.equal(second.id, first.id, '重复评估幂等')
    assert.equal(third.id, first.id, '重复派生幂等')
    assert.equal(t.visionRuns().length, 1, '只有一条运行行')
    // 失败兜底路径与主动路径同幂等键，也不会双派。
    const reactive = maybeSpawnVisionAfterFailure(t.service, {
      run: { id: 'run_x', kind: 'chat', trigger_ref: sent.messageId, project_id: t.project.id },
      bot: t.dev,
      error: { message: 'Model "model-a" does not support image input.' },
    })
    assert.equal(reactive.id, first.id, '兜底与主动共用幂等键')
    assert.equal(t.visionRuns().length, 1)
  } finally { await t.close() }
})

test('能力声明缺失（modalities undefined）：主动预判不派生，失败后兜底补派生', async () => {
  const t = await setup({ runtime: new ModalitiesRuntime(undefined) })
  try {
    const sent = await t.service.sendMessage(t.project.id, '@Builder 看图', t.actor, null, imageInput())
    const message = { id: sent.messageId, project_id: t.project.id }
    assert.equal(await considerVisionProxy(t.service, { bot: t.dev, message }), null, '声明缺失不冒险派生')
    assert.equal(t.visionRuns().length, 0)
    // 造一条带图失败的 chat 运行走真实 finishRun：错误表明模型无视觉 → 兜底派生 +
    // 按现状落「运行失败：」bot 消息（不静默）。
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at)
       VALUES ('run_chat_fail', ?, ?, 'chat', 'write', 'chat', ?, 'running', 1, 'test:chatfail', ?)`,
      t.project.id, t.dev.id, sent.messageId, new Date().toISOString(),
    )
    await t.service.finishRun({
      runId: 'run_chat_fail',
      status: 'failed',
      output: '',
      error: { code: 'session/attachment-invalid', message: 'Model "model-a" does not support image input.' },
    })
    const vision = t.visionRuns()[0]
    assert.ok(vision, '失败后兜底派生')
    assert.equal(vision.trigger_ref, sent.messageId)
    const failureNotice = t.store.get(
      "SELECT * FROM messages WHERE project_id = ? AND sender_type = 'bot' AND body LIKE '运行失败：%'",
      t.project.id,
    )
    assert.ok(failureNotice, '按现状报「模型不支持图片」（经运行失败消息可见）')
    assert.match(failureNotice.body, /does not support image input/)
  } finally { await t.close() }
})

test('全链路（群聊）：转写成功以「[图片转写]」system 消息写回原消息，原图行不动', async () => {
  const t = await setup({ runtime: new ModalitiesRuntime(['text']) })
  try {
    // 主动派生那条运行停在 running（Hold 语义），手工走真实 finishRun 收尾，聚焦写回链路。
    const sent = await t.service.sendMessage(t.project.id, '@Builder 看图', t.actor, null, imageInput())
    const vision = await waitFor(() => t.visionRuns()[0])
    await t.service.finishRun({
      runId: vision.id,
      status: 'succeeded',
      output: '图片 1\n【类型】界面截图\n【主体】构建失败的任务列表\n【文字】ERROR at src/index.ts:12',
      error: null,
    })
    const writeback = t.store.get(
      "SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '[图片转写]%'",
      t.project.id,
    )
    assert.ok(writeback, 'system 写回消息存在')
    assert.equal(writeback.reply_to_id, sent.messageId, '挂在原消息上')
    assert.match(writeback.body, /【类型】界面截图/)
    assert.equal(writeback.run_id, vision.id)
    // UI 原图照常显示：message_images 行未被动过，且原消息视图带 images。
    const imageRow = t.store.get('SELECT * FROM message_images WHERE message_id = ?', sent.messageId)
    assert.ok(imageRow, '原图行保留')
    const view = t.service.messageView(t.store.get('SELECT * FROM messages WHERE id = ?', sent.messageId))
    assert.equal(view.images.length, 1, '原消息视图仍带图片')
    const audit = t.store.get("SELECT * FROM audit_log WHERE action = 'vision.transcribe'")
    assert.ok(audit, '审计 vision.transcribe')
    assert.equal(JSON.parse(audit.data_json).runId, vision.id)
  } finally { await t.close() }
})

test('全链路（单聊）：无项目 vision 运行可被调度执行，转写写回 solo_messages', async () => {
  // modalities=['text']（无视觉）+ auto：单聊运行先完结让出 bot 槽，代理随后转写。
  const t = await setup({ runtime: new ModalitiesRuntime(['text'], { auto: true }) })
  try {
    const sent = await t.service.sendSoloMessage(t.dev.id, '这张图是什么', t.actor, imageInput())
    const writeback = await waitFor(() => t.store.get(
      "SELECT * FROM solo_messages WHERE bot_id = ? AND sender_type = 'system' AND body LIKE '[图片转写]%'",
      t.dev.id,
    ))
    const vision = t.visionRuns()[0]
    assert.ok(vision, '单聊也派生')
    assert.equal(vision.project_id, null, '单聊 vision 运行不带项目')
    assert.equal(vision.trigger_ref, sent.messageId)
    assert.equal(writeback.run_id, vision.id)
    assert.ok(t.store.get("SELECT * FROM audit_log WHERE action = 'vision.transcribe'"), '审计落库')
    // 原消息图片行照常。
    assert.ok(t.store.get('SELECT * FROM message_images WHERE solo_message_id = ?', sent.messageId))
  } finally { await t.close() }
})

test('转写失败：只审计 vision.fallback，不写回消息、不重试（额度不被刷）', async () => {
  const t = await setup({ runtime: new ModalitiesRuntime(undefined, { failVision: true, auto: true }) })
  try {
    const sent = await t.service.sendSoloMessage(t.dev.id, '看图', t.actor, imageInput())
    // 声明缺失走兜底：手工触发派生（真实入口），随后自动收尾为失败。
    const vision = maybeSpawnVisionAfterFailure(t.service, {
      run: { id: 'run_x', kind: 'solo_chat', trigger_ref: sent.messageId, project_id: null },
      bot: t.dev,
      error: { message: 'Model "model-a" does not support image input.' },
    })
    assert.ok(vision, '兜底派生')
    await waitFor(() => t.store.get('SELECT * FROM runs WHERE id = ? AND status = ?', vision.id, 'failed'))
    const audit = await waitFor(() => t.store.get("SELECT * FROM audit_log WHERE action = 'vision.fallback' AND data_json LIKE '%transcribe_failed%'"))
    assert.ok(audit, '失败有审计')
    assert.equal(
      t.store.get("SELECT COUNT(*) AS n FROM solo_messages WHERE sender_type = 'system' AND body LIKE '[图片转写]%'").n, 0,
      '失败不写回',
    )
    assert.equal(t.visionRuns().length, 1, '失败后不重派（幂等键挡住）')
  } finally { await t.close() }
})

test('转写提示词：中文结构化要求 + 原文引用 + 禁工具，群聊/单聊两态', async () => {
  const t = await setup({ runtime: new ModalitiesRuntime(['text']) })
  try {
    const sent = await t.service.sendMessage(t.project.id, '@Builder 看看这张截图', t.actor, null, imageInput())
    const vision = await waitFor(() => t.visionRuns()[0])
    const chatMessage = t.store.get('SELECT * FROM messages WHERE id = ?', sent.messageId)
    const groupPrompt = t.promptRuntime.promptFor({
      run: vision, bot: t.dev, project: t.project, task: null, chatMessage, sessionId: 's-vision-1',
    })
    assert.match(groupPrompt, /Project: Vision \(VIS\)/)
    assert.ok(groupPrompt.includes('看看这张截图'), '携带原文正文')
    assert.ok(groupPrompt.includes('【类型】') && groupPrompt.includes('【主体】') && groupPrompt.includes('【文字】'), '中文结构化字段')
    assert.ok(groupPrompt.includes('one subsection per image'), '逐张编号')
    assert.ok(groupPrompt.includes('Do not call any tools'), '禁工具')
    // 单聊态：project 为 null，header 退到 one-on-one，不触碰 project.name。
    const soloPrompt = t.promptRuntime.promptFor({
      run: { ...vision, project_id: null }, bot: t.dev, project: null, task: null,
      chatMessage: t.store.get('SELECT * FROM solo_messages WHERE id = ?', 'solo-none-x') ?? { body: '看图', sender_type: 'user', sender_id: 'u1' },
      sessionId: 's-vision-2',
    })
    assert.match(soloPrompt, /one-on-one conversation/, '单聊 header 兜底')
    assert.match(soloPrompt, /Builder \(fake\/model-a\)/, '标注被代理的主模型')
  } finally { await t.close() }
})
