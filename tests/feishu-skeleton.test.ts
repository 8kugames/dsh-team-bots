// DSHBOTS-333 守门：飞书通道骨架（传输层全 stub，走进程内官方 SDK 接口）。
// ①secret 不出现在 DSHBOTS 库/日志/env；②每条出站带 uuid=outbox 行 id；
// ③outbox 3 次上限后废弃不补发；④绑定失败 phase='unbound' 不 crash；
// ⑤不监听任何公网端口（无 webhook server 源码锚）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, rm, readFile as readFileAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { openDatabase } from '../src/db.js'
import { TeamService } from '../src/service.js'
import { FeishuChannel, FeishuError, isGone, isRetryable } from '../src/feishu/channel.js'
import { FeishuStore } from '../src/feishu/store.js'
import { outboundChunks } from '../src/feishu/format.js'

// 凭据哨兵：app secret 出现在配置里，但 DSHBOTS 不得落库/落日志。
const SECRET = 'feishu-secret-sentinel-9f3a2b'
const APP_ID = 'cli_test123'

/** 传输层桩：记录全部调用；replyFail 控制出站失败；botFail 控制身份自检失败。 */
function transportStub({ botFail = null, replyFail = null, botId = 'ou_bot123' } = {}) {
  const calls = { botInfo: 0, replies: [] }
  const transport = {
    async botInfo() {
      calls.botInfo += 1
      if (botFail) throw botFail
      return { appId: APP_ID, botId, brand: 'feishu' }
    },
    async reply(messageId, text, uuid) {
      calls.replies.push({ messageId, text, uuid })
      if (replyFail) throw replyFail
      return { messageId: 'om_sent' }
    },
    async startEvents({ onReady }) {
      onReady?.()
    },
    stop() {},
  }
  const replies = () => calls.replies
  return { calls, replies, transport }
}

function captureLog() {
  const lines: string[] = []
  return {
    lines,
    logger: {
      info: text => lines.push(String(text)),
      warn: text => lines.push(String(text)),
      error: text => lines.push(String(text)),
    },
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-skeleton-'))
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  const store = await new FeishuStore(join(dataDir, 'feishu-channel.sqlite')).open()
  const config = { feishu: { enabled: true, appId: APP_ID, appSecret: SECRET }, wechat: { enabled: false } }
  return { root, store, config }
}

/** 扫描 sqlite 主文件与 WAL/SHM 侧文件的原始字节，找哨兵 secret。 */
async function scanFiles(paths, needle) {
  const hits = []
  for (const base of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        const bytes = await readFileAsync(base + suffix)
        if (bytes.includes(Buffer.from(needle))) hits.push(base + suffix)
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  return hits
}

test('配置段：DSH_BOTS_FEISHU 开关与凭据注入（config > env），feishuDbPath 默认值', () => {
  const base = resolveConfig({ workspace: '/tmp/w', dataDir: '/tmp/d' })
  assert.equal(base.feishu.enabled, false)
  assert.equal(base.feishu.appId, '')
  assert.equal(base.feishu.appSecret, '')
  assert.equal(base.feishuDbPath, join('/tmp/d', 'feishu-channel.sqlite'))
  const prevEnabled = process.env.DSH_BOTS_FEISHU
  const prevId = process.env.DSH_BOTS_FEISHU_APP_ID
  const prevSecret = process.env.DSH_BOTS_FEISHU_APP_SECRET
  try {
    process.env.DSH_BOTS_FEISHU = '1'
    process.env.DSH_BOTS_FEISHU_APP_ID = 'cli_env'
    process.env.DSH_BOTS_FEISHU_APP_SECRET = 'env-secret'
    const on = resolveConfig({ workspace: '/tmp/w', dataDir: '/tmp/d' })
    assert.equal(on.feishu.enabled, true)
    assert.equal(on.feishu.appId, 'cli_env')
    assert.equal(on.feishu.appSecret, 'env-secret')
    // config 注入优先于 env（cordis.patch.yml 与开关同路径）
    const injected = resolveConfig({
      workspace: '/tmp/w', dataDir: '/tmp/d',
      feishuEnabled: true, feishuAppId: 'cli_injected', feishuAppSecret: 'injected-secret',
    })
    assert.equal(injected.feishu.enabled, true)
    assert.equal(injected.feishu.appId, 'cli_injected')
    assert.equal(injected.feishu.appSecret, 'injected-secret')
  } finally {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    restore('DSH_BOTS_FEISHU', prevEnabled)
    restore('DSH_BOTS_FEISHU_APP_ID', prevId)
    restore('DSH_BOTS_FEISHU_APP_SECRET', prevSecret)
  }
})

test('绑定成功：落 bot 身份进 ready；secret 不落库不落日志（守门①④）', async () => {
  const { root, store, config } = await setup()
  const { logger, lines } = captureLog()
  const envKeysBefore = Object.keys(process.env).sort().join(',')
  const stub = transportStub()
  const channel = new FeishuChannel({ store, config, log: logger, transport: stub.transport })
  await channel.start()
  assert.equal(channel.phase, 'ready')
  const state = store.getState()
  assert.equal(state.bot_id, 'ou_bot123')
  assert.equal(state.app_id, APP_ID)
  assert.equal(state.brand, 'feishu')
  assert.equal(stub.calls.botInfo, 1)
  // 守门①：secret 哨兵不出现在库文件字节、日志行、进程 env
  store.close()
  assert.deepEqual(await scanFiles([join(root, 'data', 'feishu-channel.sqlite')], SECRET), [])
  assert.ok(lines.every(line => !line.includes(SECRET)))
  assert.equal(Object.keys(process.env).sort().join(','), envKeysBefore)
  // 库文件权限 0600（属主读写）
  const mode = statSync(join(root, 'data', 'feishu-channel.sqlite')).mode & 0o7777
  assert.equal(mode, 0o600)
  await rm(root, { recursive: true, force: true })
})

test('绑定失败：phase=unbound 不 crash（守门④）', async () => {
  const { root, store, config } = await setup()
  const { logger } = captureLog()
  const cases = [
    { botFail: new FeishuError('app not found', 99991663) },
    { botFail: new FeishuError('bot/v3/info 未返回 open_id（feishuNoBot）') },
    { botFail: new Error('network unreachable') },
  ]
  for (const canned of cases) {
    const stub = transportStub(canned)
    const channel = new FeishuChannel({ store, config, log: logger, transport: stub.transport })
    await channel.start() // 不得抛出
    assert.equal(channel.phase, 'unbound')
    assert.ok(channel.error)
    assert.equal(store.getState()?.bot_id ?? null, null, '绑定失败不得落 bot 身份')
  }
  // 凭据缺失同样进 unbound
  const channel = new FeishuChannel({ store, config: { feishu: { enabled: true, appId: '', appSecret: '' } }, log: logger })
  await channel.start()
  assert.equal(channel.phase, 'unbound')
  assert.match(String(channel.error), /未配置飞书应用凭据/)
  store.close()
  await rm(root, { recursive: true, force: true })
})

test('出站：每条带 uuid=outbox 行 id，收据键去重（守门②）', async () => {
  const { root, store, config } = await setup()
  const { logger } = captureLog()
  const stub = transportStub()
  const channel = new FeishuChannel({ store, config, log: logger, transport: stub.transport, batchWindowMs: 60_000 })
  await channel.start()
  await store.saveReplyMessageId('om_target', 'ou_admin')
  channel.notify('第一条', { receiptKey: 'r1' })
  channel.notify('第二条', { receiptKey: 'r2' })
  channel.notify('第三条', { receiptKey: 'r3' })
  channel.notify('第二条重复推送', { receiptKey: 'r2' }) // 同收据键被吸收
  const pending = store.pendingOutbox()
  assert.equal(pending.length, 3)
  const byKey = Object.fromEntries(pending.map(row => [row.receipt_key, row]))
  assert.equal(byKey.r2.text, '第二条')
  await channel.flushOutbox()
  const sent = stub.replies()
  assert.equal(sent.length, 3)
  const seenKeys = new Set()
  for (const item of sent) {
    assert.equal(item.messageId, 'om_target')
    assert.match(String(item.uuid), /^\d+$/)
    seenKeys.add(item.uuid)
  }
  // 幂等键集合 = outbox 行 id 集合，一一对应
  assert.deepEqual([...seenKeys].sort(), pending.map(row => String(row.id)).sort())
  assert.equal(store.pendingOutbox().length, 0)
  for (const row of pending) {
    const done = store.db.prepare('SELECT sent_at FROM outbox WHERE id = ?').get(row.id)
    assert.ok(done.sent_at)
  }
  // gone 判定单元：撤回/2300xx not found 算 gone，其余不算
  assert.ok(isGone(new FeishuError('message withdrawn by user', 230011)))
  assert.ok(isGone(new FeishuError('230099 not found', 230099)))
  assert.ok(!isGone(new FeishuError('timeout', undefined)))
  assert.ok(!isGone(new FeishuError('bad request', 99991663)))
  store.close()
  await rm(root, { recursive: true, force: true })
})

test('gone：目标消息已撤回的回复立即废弃，不重试', async () => {
  const { root, store, config } = await setup()
  const { logger } = captureLog()
  const stub = transportStub({ replyFail: new FeishuError('message withdrawn by user', 230011) })
  const channel = new FeishuChannel({ store, config, log: logger, transport: stub.transport, batchWindowMs: 60_000 })
  await channel.start()
  await store.saveReplyMessageId('om_target', 'ou_admin')
  channel.notify('要发的内容', { receiptKey: 'g1' })
  const [row] = store.pendingOutbox()
  await channel.flushOutbox()
  assert.equal(stub.replies().length, 1)
  const after = store.db.prepare('SELECT attempts, gave_up_at, last_error, sent_at FROM outbox WHERE id = ?').get(row.id)
  assert.equal(after.attempts, 0)
  assert.ok(after.gave_up_at)
  assert.equal(after.last_error, 'gone')
  assert.equal(after.sent_at, null)
  // 废弃后不再补发
  await channel.flushOutbox()
  assert.equal(stub.replies().length, 1)
  store.close()
  await rm(root, { recursive: true, force: true })
})

test('重试上限：3 次可重试失败后废弃不补发；不可重试立即废弃（守门③）', async () => {
  const { root, store, config } = await setup()
  const { logger } = captureLog()
  const stub = transportStub({ replyFail: new FeishuError('local timeout', undefined) })
  const channel = new FeishuChannel({ store, config, log: logger, transport: stub.transport, batchWindowMs: 60_000 })
  await channel.start()
  await store.saveReplyMessageId('om_target', 'ou_admin')
  channel.notify('重试链路消息', { receiptKey: 'k1' })
  const [row] = store.pendingOutbox()
  assert.ok(isRetryable(new FeishuError('local timeout', undefined)))
  assert.ok(!isRetryable(new FeishuError('bad request', 99991663)))
  for (let round = 0; round < 5; round++) await channel.flushOutbox()
  // 3 次尝试后废弃：第 4/5 轮不再发送
  assert.equal(stub.replies().length, 3)
  const after = store.db.prepare('SELECT attempts, gave_up_at, sent_at FROM outbox WHERE id = ?').get(row.id)
  assert.equal(after.attempts, 3)
  assert.ok(after.gave_up_at)
  assert.equal(after.sent_at, null)
  assert.equal(store.pendingOutbox().length, 0)
  store.close()
  await rm(root, { recursive: true, force: true })
})

test('无回复目标：条目保留待发不报错（等待入站绑定锚点）', async () => {
  const { root, store, config } = await setup()
  const { logger } = captureLog()
  const stub = transportStub()
  const channel = new FeishuChannel({ store, config, log: logger, transport: stub.transport, batchWindowMs: 60_000 })
  await channel.start()
  channel.notify('管理员还没说过话', { receiptKey: 'n1' })
  await channel.flushOutbox()
  assert.equal(stub.replies().length, 0)
  assert.equal(store.pendingOutbox().length, 1)
  store.close()
  await rm(root, { recursive: true, force: true })
})

test('markdown 分块：超长文本按段边界切块且每块不超上限', () => {
  const paragraph = '段落'.repeat(50) // 100 字符/段
  const long = Array.from({ length: 60 }, (_, i) => `# 标题${i}\n\n${paragraph}`).join('\n\n')
  const chunks = outboundChunks(long)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 4000, `块长 ${chunk.length}`)
  assert.equal(chunks.join('\n\n').replace(/\n\n+/g, '\n\n'), long.replace(/\n\n+/g, '\n\n'))
  assert.deepEqual(outboundChunks('   '), [])
  assert.deepEqual(outboundChunks('短文本'), ['短文本'])
})

test('守门⑤：不监听任何公网端口（src/feishu 无 webhook server 源码锚）', () => {
  const dir = fileURLToPath(new URL('../src/feishu/', import.meta.url))
  const files = readdirSync(dir).filter(name => name.endsWith('.ts'))
  assert.ok(files.length >= 4)
  for (const name of files) {
    const source = readFileSync(join(dir, name), 'utf8')
    assert.doesNotMatch(source, /createServer|\.listen\s*\(/, `${name} 不得出现 HTTP server 监听`)
  }
})

test('服务挂载：feishu.enabled 时 core 动态挂载，绑定失败仅 unbound 不拖垮工作台（守门①④）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-mount-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir,
    skillRoot: join(workspace, '.agents'),
    schedulerIntervalMs: 30_000,
    modelCacheMs: 0,
    feishuEnabled: true,
    // 不配应用凭据：缺凭据路径——start 必须吞掉进 unbound
  })
  assert.equal(config.feishu.enabled, true)
  class HoldingRuntime {
    setCompletionHandler() {}
    setMask() {}
    async catalog() { return [] }
    async validateBotConfig() {}
    approvalsAttach() {}
    questionsAttach() {}
  }
  const store = openDatabase(config.dbPath)
  const { logger, lines } = captureLog()
  const service = new TeamService({ store, config, logger })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize() // 不 crash 即守门④
  assert.ok(service.feishu, 'feishu.enabled 时 core 应挂载 FeishuChannel')
  assert.equal(service.feishu.phase, 'unbound')
  service.started = true
  await service.stop()
  // 守门①：主库/飞书库字节与日志都不含 secret 哨兵（本路径本就无 secret 材料）
  assert.deepEqual(await scanFiles([config.dbPath, config.feishuDbPath], SECRET), [])
  assert.ok(lines.every(line => !line.includes(SECRET)))
  await rm(root, { recursive: true, force: true })
})
