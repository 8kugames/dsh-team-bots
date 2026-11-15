// DSHBOTS-333 守门：入站事件消费（传输层全 stub，进程内官方 SDK 接口）。
// ①重复 (appId,message_id) 不重复起 turn（LRU 去重）；②TOFU 首私聊者成 owner 并持久化、
// 非 owner 私聊丢弃留痕；③群聊无 @ 不起 turn、非 owner @bot 60s 冷却礼貌回应；
// ④lane 编码形态；⑤generation 旧轮次整体丢弃；⑥同幂等键超时有界重试幂等；
// ⑦exceed_conn_limit 冲突信号 → phase 广播 conflict。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeishuChannel, FeishuError, INBOUND_DEDUP_TTL_MS, parseInboundEvent, laneOf, stripMentionPlaceholders, isConnLimit } from '../src/feishu/channel.js'
import { FeishuStore } from '../src/feishu/store.js'

/** SDK 形状的 im.message.receive_v1 事件（EventDispatcher 回调：sender/message 在顶层）。 */
function inboundEvent({ messageId, chatType = 'p2p', chatId = null, sender = 'ou_admin', text = '你好', mentions = [], rootId = null }) {
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

/** 传输层桩：记录 reply 调用；事件通过 hooks.onEvent 投递。 */
function transportStub() {
  const calls = { botInfo: 0, replies: [] }
  let hooks = null
  const transport = {
    async botInfo() {
      calls.botInfo += 1
      return { appId: 'cli_test123', botId: 'ou_bot123', brand: 'feishu' }
    },
    async reply(messageId, text, uuid) {
      calls.replies.push({ messageId, text, uuid })
      return { messageId: 'om_sent' }
    },
    async startEvents(next) {
      hooks = next
    },
    stop() {},
  }
  const replies = () => calls.replies
  return { calls, replies, transport, hooks: () => hooks }
}

async function setup({ admin = 'ou_admin', bot = 'ou_bot123', app = 'cli_test123' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-inbound-'))
  await mkdir(join(root, 'data'), { recursive: true })
  const store = await new FeishuStore(join(root, 'data', 'feishu-channel.sqlite')).open()
  if (bot) store.saveBot({ botId: bot, appId: app })
  if (admin) store.saveAdminOu(admin)
  const stub = transportStub()
  const triggers = []
  const counter = { chats: 0 }
  const lines = []
  const service = {
    recordFeishuTrigger: event => {
      triggers.push(event)
    },
    feishuChat: async () => {
      counter.chats += 1
      return { director: { id: 'b1', name: 'director' }, messageId: 'm1', firstContact: counter.chats === 1 }
    },
  }
  const channel = new FeishuChannel({
    store,
    config: { feishu: { enabled: true, appId: 'cli_test123', appSecret: 'secret-sentinel' } },
    log: { info: text => lines.push(String(text)), warn: text => lines.push(String(text)), error: () => {} },
    transport: stub.transport,
  })
  channel.setService(service)
  // 测试直接驱动 handleEventLine：generation 对齐当前连接轮次（模拟已就绪的长连接）
  channel.consumeGeneration = 1
  const cleanup = async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
  return { root, store, stub, triggers, counter, lines, service, channel, cleanup }
}

test('① 重复 (appId,message_id) 不重复起 turn；TTL 过期后同 id 可再处理', async () => {
  const s = await setup()
  try {
    const line = JSON.stringify(inboundEvent({ messageId: 'om_1' }))
    await s.channel.handleEventLine(line, 1)
    await s.channel.handleEventLine(line, 1)
    assert.equal(s.counter.chats, 1, 'turn 只应起一次')
    assert.equal(s.stub.replies().length, 1, '回复只应发一次')
    assert.ok(s.triggers.some(t => t.disposition === 'duplicate' && t.route === 'lru'))
    // TTL 过期：同 id 重新按新事件处理（首触后 director 对话静默直达，回复不再即时发）
    s.channel.inboundSeen.set('cli_test123:om_1', Date.now() - INBOUND_DEDUP_TTL_MS - 1)
    await s.channel.handleEventLine(line, 1)
    assert.equal(s.counter.chats, 2)
    assert.equal(s.stub.replies().length, 1)
  } finally {
    await s.cleanup()
  }
})

test('② TOFU：首私聊者成 owner 并按 bot-app 持久化；非 owner 私聊丢弃留痕', async () => {
  const s = await setup({ admin: null })
  try {
    assert.equal(s.store.getState()?.admin_ou_id ?? null, null)
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_first', sender: 'ou_first' })), 1)
    assert.equal(s.store.getState()?.admin_ou_id, 'ou_first')
    assert.equal(s.stub.replies().length, 1)
    assert.match(String(s.stub.replies()[0].text), /已绑定为本团队管理员/)
    assert.equal(s.store.getState()?.reply_message_id, 'om_first', '回复锚点挂到 owner 首条消息')
    assert.ok(s.triggers.some(t => t.disposition === 'handled' && t.route === 'tofu'))
    // 非 owner 私聊：丢弃留痕，不起 turn 不回复
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_other', sender: 'ou_other' })), 1)
    assert.equal(s.counter.chats, 0)
    assert.equal(s.stub.replies().length, 1)
    assert.ok(s.triggers.some(t => t.disposition === 'filtered' && t.route === 'non-admin'))
  } finally {
    await s.cleanup()
  }
})

test('③ 群聊：无 @ 不起 turn；非 owner @bot 冷却礼貌回应；owner @bot 剥占位符起 turn', async () => {
  const s = await setup()
  try {
    const mention = [{ key: '@_user_1', id: { open_id: 'ou_bot123' } }]
    // 群聊绝不 TOFU：无 @ 直接过滤
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_g1', chatType: 'group', chatId: 'oc_1', sender: 'ou_stranger' })), 1)
    assert.equal(s.counter.chats, 0)
    assert.equal(s.stub.replies().length, 0)
    assert.ok(s.triggers.some(t => t.route === 'no-mention'))
    // 非 owner @bot：礼貌回应一次（锚定该消息），不起 turn
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_g2', chatType: 'group', chatId: 'oc_1', sender: 'ou_stranger', text: '@_user_1 帮我查状态', mentions: mention })), 1)
    assert.equal(s.counter.chats, 0)
    assert.equal(s.stub.replies().length, 1)
    assert.equal(s.stub.replies()[0].messageId, 'om_g2')
    assert.match(String(s.stub.replies()[0].text), /仅管理员可用/)
    // 同发送者 60s 冷却内再 @：不再回应
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_g3', chatType: 'group', chatId: 'oc_1', sender: 'ou_stranger', text: '@_user_1 再问一次', mentions: mention })), 1)
    assert.equal(s.stub.replies().length, 1)
    assert.ok(s.triggers.some(t => t.route === 'cooldown'))
    // owner @bot：剥掉 @占位符后正常起 turn，回复锚定该消息
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_g4', chatType: 'group', chatId: 'oc_1', sender: 'ou_admin', text: '@_user_1 帮我跑个分析', mentions: mention })), 1)
    assert.equal(s.counter.chats, 1)
    assert.equal(s.stub.replies()[1].messageId, 'om_g4')
    assert.equal(s.store.getState()?.reply_message_id, 'om_g4')
    // 占位符剥离单元
    assert.equal(stripMentionPlaceholders('@_user_1 你好 世界'), '你好 世界')
  } finally {
    await s.cleanup()
  }
})

test('④ lane 编码：群 g/{chatId}[/{threadId}]，p2p 用 open_id；留痕 peer_id 记 lane', async () => {
  const s = await setup()
  try {
    assert.equal(laneOf(parseInboundEvent(inboundEvent({ messageId: 'om_a', chatType: 'group', chatId: 'oc_1', sender: 'ou_x' }))), 'g/oc_1')
    assert.equal(laneOf(parseInboundEvent(inboundEvent({ messageId: 'om_b', chatType: 'group', chatId: 'oc_1', sender: 'ou_x', rootId: 'om_root' }))), 'g/oc_1/om_root')
    assert.equal(laneOf(parseInboundEvent(inboundEvent({ messageId: 'om_c', sender: 'ou_p' }))), 'ou_p')
    // 群消息留痕的 peer_id 即 lane 编码
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_d', chatType: 'group', chatId: 'oc_1', sender: 'ou_stranger' })), 1)
    const row = s.triggers.find(t => t.nativeId === 'om_d')
    assert.equal(row?.senderId, 'g/oc_1')
  } finally {
    await s.cleanup()
  }
})

test('⑤ generation 门禁：事件处理中连接换代，旧轮次整体丢弃', async () => {
  const s = await setup()
  try {
    let releaseChat = null
    let chatEnteredResolve = null
    const chatGate = new Promise(resolve => {
      releaseChat = resolve
    })
    const chatEntered = new Promise(resolve => {
      chatEnteredResolve = resolve
    })
    s.channel.setService({
      recordFeishuTrigger: event => {
        s.triggers.push(event)
      },
      feishuChat: async () => {
        chatEnteredResolve()
        await chatGate
        return { director: { id: 'b1', name: 'director' }, messageId: 'm1', firstContact: true }
      },
    })
    const processing = s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_slow' })), 1)
    await chatEntered
    // 事件仍在处理中时新连接建立（generation 换代）
    s.channel.consumeGeneration = 2
    releaseChat()
    await processing
    assert.equal(s.stub.replies().length, 0, '旧轮次的回复不得发出')
    assert.ok(s.triggers.some(t => t.disposition === 'dropped' && t.route === 'stale-generation'))
    assert.notEqual(s.store.getState()?.reply_message_id, 'om_slow', '旧轮次不落回复锚点')
  } finally {
    await s.cleanup()
  }
})

test('⑥ 出站同幂等键超时有界重试：不双发不丢发，幂等取回原 message_id', async () => {
  const s = await setup()
  try {
    await s.store.saveReplyMessageId('om_target', 'ou_admin')
    let attempt = 0
    s.stub.transport.reply = async (messageId, text, uuid) => {
      s.stub.calls.replies.push({ messageId, text, uuid })
      attempt += 1
      if (attempt === 1) throw new FeishuError('local timeout', undefined)
      return { messageId: 'om_original' }
    }
    s.channel.notify('要发的消息', { receiptKey: 'retry1' })
    await s.channel.flushOutbox()
    const replies = s.stub.calls.replies
    assert.equal(replies.length, 2, '超时后同键有界重试一次')
    assert.equal(replies[0].uuid, replies[1].uuid, '两次调用必须同 uuid')
    assert.ok(s.lines.some(line => line.includes('取回原消息 om_original')))
    assert.equal(s.store.pendingOutbox().length, 0, '重试成功后条目标记 sent')
  } finally {
    await s.cleanup()
  }
})

test('⑦ exceed_conn_limit 冲突信号：phase 广播 conflict', async () => {
  const s = await setup()
  try {
    assert.ok(isConnLimit(new Error('pullConnectConfig failed: code=1000040350, msg=exceed conn limit')))
    assert.ok(!isConnLimit(new Error('local timeout')))
    s.channel.phase = 'ready'
    s.channel.onTransportError(new Error('pullConnectConfig failed: code=1000040350, msg=exceed conn limit'))
    assert.equal(s.channel.phase, 'conflict')
    assert.match(String(s.channel.error), /exceed_conn_limit/)
  } finally {
    await s.cleanup()
  }
})
