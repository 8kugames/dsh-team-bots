// DSHBOTS-333 守门：飞书传输层换进程内官方 SDK（@larksuiteoapi/node-sdk）。
// ①连接建立（WSClient 长连接就绪 → phase=ready，generation 换代）；②SDK 形状事件
// （顶层 sender/message）到达到 handleEventLine；③出站 reply 带 uuid（= outbox 行 id）；
// ④凭据缺失 → unbound（文案只提应用凭据，不提 lark-cli）；⑤gone 判定按 SDK 错误码
// 230011/2300xx；⑥源码锚：src/feishu 不再 spawn 子进程、不提 lark-cli。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FeishuChannel, FeishuError, isGone, isConnLimit, parseInboundEvent, toFeishuError } from '../src/feishu/channel.js'
import { FeishuStore } from '../src/feishu/store.js'

/** SDK 形状的 im.message.receive_v1 事件（EventDispatcher 回调：sender/message 在顶层）。 */
function sdkEvent({ messageId, chatType = 'p2p', chatId = null, sender = 'ou_admin', text = '你好', mentions = [], rootId = null }) {
  return {
    schema: '2.0',
    event_type: 'im.message.receive_v1',
    event_id: `eid_${messageId}`,
    sender: { sender_id: { open_id: sender }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: chatType,
      message_type: 'text',
      content: JSON.stringify({ text }),
      mentions,
      ...(rootId ? { root_id: rootId } : {}),
    },
  }
}

/** 传输层全 stub：记录 reply 调用与事件投递，不碰网络。 */
function transportStub({ botId = 'ou_bot123', appId = 'cli_test123', replyFail = null } = {}) {
  const calls = { botInfo: 0, replies: [], events: [], stopped: 0 }
  let hooks = null
  const transport = {
    async botInfo() {
      calls.botInfo += 1
      return { appId, botId, brand: 'feishu' }
    },
    async reply(messageId, text, uuid) {
      calls.replies.push({ messageId, text, uuid })
      if (replyFail) throw replyFail
      return { messageId: `om_${calls.replies.length}` }
    },
    async startEvents(next) {
      hooks = next
      next.onReady?.()
    },
    stop() {
      calls.stopped += 1
    },
  }
  return { transport, calls, hooks: () => hooks }
}

async function setup({ admin = 'ou_admin', bot = 'ou_bot123', app = 'cli_test123', config = null, transport = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-transport-'))
  await mkdir(join(root, 'data'), { recursive: true })
  const store = await new FeishuStore(join(root, 'data', 'feishu-channel.sqlite')).open()
  if (bot) store.saveBot({ botId: bot, appId: app })
  if (admin) store.saveAdminOu(admin)
  const lines = []
  const triggers = []
  const counter = { chats: 0 }
  const service = {
    recordFeishuTrigger: event => triggers.push(event),
    feishuChat: async () => {
      counter.chats += 1
      return { director: { id: 'b1', name: 'director' }, messageId: 'm1', firstContact: counter.chats === 1 }
    },
  }
  const channel = new FeishuChannel({
    store,
    config: config ?? { feishu: { enabled: true, appId: 'cli_test123', appSecret: 'secret-sentinel' } },
    log: { info: text => lines.push(String(text)), warn: text => lines.push(String(text)), error: () => {} },
    transport,
    batchWindowMs: 60_000,
  })
  channel.setService(service)
  const cleanup = async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
  return { root, store, lines, triggers, counter, service, channel, cleanup }
}

test('① 连接建立：长连接就绪即 phase=ready，generation 换代一次', async () => {
  const stub = transportStub()
  const s = await setup({ transport: stub.transport })
  try {
    await s.channel.start()
    assert.equal(s.channel.phase, 'ready')
    assert.equal(s.channel.error, null)
    assert.equal(stub.calls.botInfo, 1)
    assert.equal(s.channel.consumeGeneration, 1, '长连接就绪应换代 generation')
    const state = s.store.getState()
    assert.equal(state.bot_id, 'ou_bot123')
    assert.equal(state.app_id, 'cli_test123')
  } finally {
    await s.cleanup()
  }
})

test('② 事件到达：SDK 形状事件（顶层 sender/message）进入入站模型并起 turn', async () => {
  const stub = transportStub()
  const s = await setup({ transport: stub.transport })
  try {
    await s.channel.start()
    // 长连接回调投递 SDK 形状事件 → 入站模型解析
    stub.hooks().onEvent(sdkEvent({ messageId: 'om_1', sender: 'ou_admin', text: '查状态' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(s.counter.chats, 1, '管理员私聊应起 turn')
    assert.equal(stub.calls.replies.length, 1)
    assert.equal(stub.calls.replies[0].messageId, 'om_1')
    // SDK 形状解析：sender/message 在顶层
    const parsed = parseInboundEvent(sdkEvent({ messageId: 'om_2', chatType: 'group', chatId: 'oc_1', sender: 'ou_x' }))
    assert.equal(parsed.messageId, 'om_2')
    assert.equal(parsed.chatType, 'group')
    assert.equal(parsed.senderOpenId, 'ou_x')
  } finally {
    await s.cleanup()
  }
})

test('②b JSON 行入口：handleEventLine 与 SDK 事件对象同形同效', async () => {
  const stub = transportStub()
  const s = await setup({ transport: stub.transport })
  try {
    await s.channel.start()
    await s.channel.handleEventLine(JSON.stringify(sdkEvent({ messageId: 'om_line', sender: 'ou_admin' })), s.channel.consumeGeneration)
    assert.equal(s.counter.chats, 1)
    assert.equal(stub.calls.replies.length, 1)
  } finally {
    await s.cleanup()
  }
})

test('③ 出站：每条 reply 带 uuid（= outbox 行 id），收据键去重', async () => {
  const stub = transportStub()
  const s = await setup({ transport: stub.transport })
  try {
    await s.channel.start()
    await s.store.saveReplyMessageId('om_target', 'ou_admin')
    s.channel.notify('第一条', { receiptKey: 'r1' })
    s.channel.notify('第二条', { receiptKey: 'r2' })
    s.channel.notify('第二条重复推送', { receiptKey: 'r2' })
    const pending = s.store.pendingOutbox()
    assert.equal(pending.length, 2)
    await s.channel.flushOutbox()
    assert.equal(stub.calls.replies.length, 2)
    const uuids = stub.calls.replies.map(item => item.uuid)
    assert.deepEqual(uuids.sort(), pending.map(row => String(row.id)).sort(), 'uuid 集合 = outbox 行 id 集合')
    assert.equal(s.store.pendingOutbox().length, 0)
  } finally {
    await s.cleanup()
  }
})

test('④ 凭据缺失：phase=unbound，提示只讲应用凭据（不提 lark-cli）', async () => {
  const stub = transportStub()
  const s = await setup({
    config: { feishu: { enabled: true, appId: '', appSecret: '' } },
    transport: stub.transport,
  })
  try {
    await s.channel.start()
    assert.equal(s.channel.phase, 'unbound')
    assert.match(String(s.channel.error), /未配置飞书应用凭据/)
    assert.doesNotMatch(String(s.channel.error), /lark-cli/)
    assert.equal(stub.calls.botInfo, 0, '缺凭据时不得发起任何接口调用')
  } finally {
    await s.cleanup()
  }
})

test('⑤ gone 判定按 SDK 错误码：230011 与 2300xx not found 算 gone', async () => {
  assert.ok(isGone(new FeishuError('message withdrawn by user', 230011)))
  assert.ok(isGone(new FeishuError('230099 not found', 230099)))
  assert.ok(!isGone(new FeishuError('timeout', undefined)))
  assert.ok(!isGone(new FeishuError('bad request', 99991663)))
  // 连接数冲突信号：SDK 报错文案带 1000040350
  assert.ok(isConnLimit(new Error('pullConnectConfig failed: code=1000040350, msg=exceed conn limit')))
  assert.ok(!isConnLimit(new Error('network unreachable')))
  // SDK 抛错归一：axios 响应体里的业务码要被取出来（gone 判定才成立）
  const gone = toFeishuError({ response: { data: { code: 230011, msg: 'message withdrawn' } } })
  assert.equal(gone.code, 230011)
  assert.ok(isGone(gone))
  const authError = toFeishuError({ message: 'failed to get tenant_access_token, code: 10014' })
  assert.equal(authError.code, 10014)
  const netError = toFeishuError(new Error('socket hang up'))
  assert.equal(netError.code, undefined)
})

test('⑤b gone 的出站不重试：目标消息撤回即废弃', async () => {
  const stub = transportStub({ replyFail: new FeishuError('message withdrawn by user', 230011) })
  const s = await setup({ transport: stub.transport })
  try {
    await s.channel.start()
    await s.store.saveReplyMessageId('om_target', 'ou_admin')
    s.channel.notify('要发的内容', { receiptKey: 'g1' })
    const [row] = s.store.pendingOutbox()
    await s.channel.flushOutbox()
    assert.equal(stub.calls.replies.length, 1, 'gone 不重试')
    const after = s.store.db.prepare('SELECT attempts, gave_up_at, last_error, sent_at FROM outbox WHERE id = ?').get(row.id)
    assert.equal(after.attempts, 0)
    assert.ok(after.gave_up_at)
    assert.equal(after.last_error, 'gone')
  } finally {
    await s.cleanup()
  }
})

test('⑥ 源码锚：src/feishu 不再 spawn 子进程、不提 lark-cli', () => {
  const dir = fileURLToPath(new URL('../src/feishu/', import.meta.url))
  const files = readdirSync(dir).filter(name => name.endsWith('.ts'))
  assert.ok(files.length >= 4)
  for (const name of files) {
    const source = readFileSync(join(dir, name), 'utf8')
    assert.doesNotMatch(source, /spawn\(/, `${name} 不得 spawn 子进程`)
    assert.doesNotMatch(source, /lark-cli|DSH_BOTS_FEISHU_CLI/i, `${name} 不得再依赖 lark-cli`)
    assert.doesNotMatch(source, /createServer|\.listen\s*\(/, `${name} 不得出现 HTTP server 监听`)
  }
  // SDK 依赖在 package.json 里声明为运行时依赖
  const pkg = JSON.parse(readFileSync(join(fileURLToPath(new URL('../', import.meta.url)), 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies?.['@larksuiteoapi/node-sdk'], 'package.json 需声明 @larksuiteoapi/node-sdk 运行时依赖')
})
