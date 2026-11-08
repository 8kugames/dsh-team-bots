// DSHBOTS-323 卡②守门：入站事件消费（lark-cli 全 stub，无需真二进制）。
// ①重复 (appId,message_id) 不重复起 turn（LRU 去重）；②TOFU 首私聊者成 owner 并持久化、
// 非 owner 私聊丢弃留痕；③群聊无 @ 不起 turn、非 owner @bot 60s 冷却礼貌回应；
// ④lane 编码形态；⑤generation 旧轮次整体丢弃；⑥同幂等键超时有界重试幂等；
// ⑦exceed_conn_limit 冲突信号识别 → phase 广播 conflict 且停循环。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeishuChannel, CliError, CONSUME_READY_TIMEOUT_MS, INBOUND_DEDUP_TTL_MS, parseInboundEvent, laneOf, stripMentionPlaceholders, isConnLimit } from '../src/feishu/channel.js'
import { FeishuStore } from '../src/feishu/store.js'

/** im.message.receive_v1 schema 2.0 事件体（text 消息的 content 是 JSON 字符串）。 */
function inboundEvent({ messageId, chatType = 'p2p', chatId = null, sender = 'ou_admin', text = '你好', mentions = [], rootId = null }) {
  return {
    schema: '2.0',
    header: { event_id: `eid_${messageId}`, event_type: 'im.message.receive_v1' },
    event: {
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
    },
  }
}

/** lark 执行桩：记录全部调用，im 子命令成功返回空。 */
function larkStub() {
  const calls = []
  const run = async args => {
    calls.push(args)
    return ''
  }
  const replies = () => calls.filter(args => args[0] === 'im' && args[1] === '+messages-reply')
  return { calls, replies, run }
}

/** 入站消费桩：可编程的伪长连接（ready 即回调、exit/fail 结算、重连生成新连接句柄）。 */
function consumeStub() {
  const connections = []
  const spawnConsume = ({ onEvent, onReady, signal, readyTimeoutMs }) => {
    const conn = { onEvent, onReady, signal, readyTimeoutMs, resolve: null, reject: null, done: null }
    conn.done = new Promise((resolve, reject) => {
      conn.resolve = resolve
      conn.reject = reject
    })
    connections.push(conn)
    queueMicrotask(() => conn.onReady?.())
    return conn.done
  }
  return { connections, spawnConsume, current: () => connections[connections.length - 1] }
}

async function setup({ admin = 'ou_admin', bot = 'ou_bot123', app = 'cli_test123' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-inbound-'))
  await mkdir(join(root, 'data'), { recursive: true })
  const store = await new FeishuStore(join(root, 'data', 'feishu-channel.sqlite')).open()
  if (bot) store.saveBot({ cliPath: '/usr/local/bin/lark', botId: bot, appId: app })
  if (admin) store.saveAdminOu(admin)
  const lark = larkStub()
  const consume = consumeStub()
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
    config: { feishu: { enabled: true, cliPath: '/usr/local/bin/lark' } },
    log: { info: text => lines.push(String(text)), warn: text => lines.push(String(text)), error: () => {} },
    runLark: lark.run,
    spawnConsume: consume.spawnConsume,
  })
  channel.setService(service)
  // 测试直接驱动 handleEventLine：generation 对齐当前连接轮次（模拟已就绪的消费连接）
  channel.consumeGeneration = 1
  const cleanup = async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
  return { root, store, lark, consume, triggers, counter, lines, service, channel, cleanup }
}

test('① 重复 (appId,message_id) 不重复起 turn；TTL 过期后同 id 可再处理', async () => {
  const s = await setup()
  try {
    const line = JSON.stringify(inboundEvent({ messageId: 'om_1' }))
    await s.channel.handleEventLine(line, 1)
    await s.channel.handleEventLine(line, 1)
    assert.equal(s.counter.chats, 1, 'turn 只应起一次')
    assert.equal(s.lark.replies().length, 1, '回复只应发一次')
    assert.ok(s.triggers.some(t => t.disposition === 'duplicate' && t.route === 'lru'))
    // TTL 过期：同 id 重新按新事件处理（首触后 director 对话静默直达，回复不再即时发）
    s.channel.inboundSeen.set('cli_test123:om_1', Date.now() - INBOUND_DEDUP_TTL_MS - 1)
    await s.channel.handleEventLine(line, 1)
    assert.equal(s.counter.chats, 2)
    assert.equal(s.lark.replies().length, 1)
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
    assert.equal(s.lark.replies().length, 1)
    assert.match(String(s.lark.replies()[0][5]), /已绑定为本团队管理员/)
    assert.equal(s.store.getState()?.reply_message_id, 'om_first', '回复锚点挂到 owner 首条消息')
    assert.ok(s.triggers.some(t => t.disposition === 'handled' && t.route === 'tofu'))
    // 非 owner 私聊：丢弃留痕，不起 turn 不回复
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_other', sender: 'ou_other' })), 1)
    assert.equal(s.counter.chats, 0)
    assert.equal(s.lark.replies().length, 1)
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
    assert.equal(s.lark.replies().length, 0)
    assert.ok(s.triggers.some(t => t.route === 'no-mention'))
    // 非 owner @bot：礼貌回应一次（锚定该消息），不起 turn
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_g2', chatType: 'group', chatId: 'oc_1', sender: 'ou_stranger', text: '@_user_1 帮我查状态', mentions: mention })), 1)
    assert.equal(s.counter.chats, 0)
    assert.equal(s.lark.replies().length, 1)
    assert.equal(s.lark.replies()[0][3], 'om_g2')
    assert.match(String(s.lark.replies()[0][5]), /仅管理员可用/)
    // 同发送者 60s 冷却内再 @：不再回应
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_g3', chatType: 'group', chatId: 'oc_1', sender: 'ou_stranger', text: '@_user_1 再问一次', mentions: mention })), 1)
    assert.equal(s.lark.replies().length, 1)
    assert.ok(s.triggers.some(t => t.route === 'cooldown'))
    // owner @bot：剥掉 @占位符后正常起 turn，回复锚定该消息
    await s.channel.handleEventLine(JSON.stringify(inboundEvent({ messageId: 'om_g4', chatType: 'group', chatId: 'oc_1', sender: 'ou_admin', text: '@_user_1 帮我跑个分析', mentions: mention })), 1)
    assert.equal(s.counter.chats, 1)
    assert.equal(s.lark.replies()[1][3], 'om_g4')
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
    assert.equal(s.lark.replies().length, 0, '旧轮次的回复不得发出')
    assert.ok(s.triggers.some(t => t.disposition === 'dropped' && t.route === 'stale-generation'))
    assert.notEqual(s.store.getState()?.reply_message_id, 'om_slow', '旧轮次不落回复锚点')
  } finally {
    await s.cleanup()
  }
})

test('⑥ sendFeishu 同幂等键超时有界重试：不双发不丢发，幂等取回原 message_id', async () => {
  const s = await setup()
  try {
    await s.store.saveReplyMessageId('om_target', 'ou_admin')
    let imAttempt = 0
    const calls = []
    s.channel.runLark = async args => {
      calls.push(args)
      if (args[0] !== 'im') return ''
      imAttempt += 1
      if (imAttempt === 1) throw new CliError('local spawn timeout', undefined)
      return JSON.stringify({ message_id: 'om_original' })
    }
    s.channel.notify('要发的消息', { receiptKey: 'retry1' })
    await s.channel.flushOutbox()
    const replies = calls.filter(args => args[0] === 'im' && args[1] === '+messages-reply')
    assert.equal(replies.length, 2, '超时后同键有界重试一次')
    assert.equal(replies[0][7], replies[1][7], '两次调用必须同 idempotency-key')
    assert.ok(s.lines.some(line => line.includes('取回原消息 om_original')))
    assert.equal(s.store.pendingOutbox().length, 0, '重试成功后条目标记 sent')
  } finally {
    await s.cleanup()
  }
})

test('⑦ exceed_conn_limit 冲突信号：phase 广播 conflict 且不再重连', async () => {
  const s = await setup()
  try {
    assert.ok(isConnLimit(new CliError('exceed_conn_limit: too many consumers', 1000040350)))
    assert.ok(!isConnLimit(new CliError('local spawn timeout', undefined)))
    s.channel.phase = 'ready'
    const loop = s.channel.consumeLoop(new AbortController().signal)
    await Promise.resolve()
    s.consume.current().reject(new CliError('code 1000040350 exceed conn limit', 1000040350))
    await loop
    assert.equal(s.channel.phase, 'conflict')
    assert.match(String(s.channel.error), /exceed_conn_limit/)
    assert.equal(s.consume.connections.length, 1, '确定性冲突不重连')
    assert.equal(s.consume.connections[0].readyTimeoutMs, CONSUME_READY_TIMEOUT_MS)
  } finally {
    await s.cleanup()
  }
})
