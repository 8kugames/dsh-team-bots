import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatStore } from '../src/wechat/store.js'
import { handleCommand, isRetryable, outboundChunks, WechatIlinkError } from '../src/wechat/commands.js'
import { WechatChannel } from '../src/wechat/channel.js'

test('wechat store 持久化凭证、游标、管理员与发件箱', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-store-'))
  const store = await new WechatStore(join(dir, 'w.db')).open()
  try {
    assert.equal(store.getState(), null)
    store.saveCredentials({ token: 't', botId: 'b', userId: 'u', baseUrl: 'https://a.weixin.qq.com' })
    store.saveCursor('c1')
    store.saveAdminPeer('p1')
    const state = store.getState()
    assert.equal(JSON.parse(state.credentials_json).token, 't')
    assert.equal(state.cursor, 'c1')
    assert.equal(state.admin_peer_id, 'p1')
    store.enqueue('hello')
    store.enqueue('world')
    assert.equal(store.pendingOutbox().length, 2)
    store.markSent([store.pendingOutbox()[0].id])
    assert.deepEqual(store.pendingOutbox().map(item => item.text), ['world'])
    store.clearCredentials()
    assert.equal(store.getState().credentials_json, null)
    assert.equal(store.getState().cursor, '')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat commands 帮助、状态与验收路由', async () => {
  assert.ok((await handleCommand({}, '帮助')).includes('状态'))
  assert.ok((await handleCommand({}, '')).includes('可用指令'))
  assert.ok((await handleCommand({}, 'foo')).includes('未识别'))

  const service = {
    stateView() {
      return { projects: [{ key: 'web', name: 'Web', tasks: [
        { number: 3, status: 'in_progress', title: '写登录页' },
        { number: 4, status: 'done', title: '已完成' },
      ] }] }
    },
    taskViewByIdentifier(identifier) {
      return { identifier, status: 'in_progress', title: '写登录页', comments: [] }
    },
    wechatReview(identifier, { decision, comment }) {
      this.seen = { identifier, decision, comment }
      return `已${decision === 'accept' ? '验收' : '驳回'} ${identifier}`
    },
  }
  const state = await handleCommand(service, '状态')
  assert.ok(state.includes('【Web】'))
  assert.ok(state.includes('web-3 [in_progress] 写登录页'))
  assert.ok(!state.includes('web-4'), '完成态任务不应出现在状态列表')

  assert.ok((await handleCommand(service, '详情 web-3')).includes('写登录页'))
  assert.ok((await handleCommand(service, '验收 web-3 干得漂亮')).includes('已验收 web-3'))
  assert.deepEqual(service.seen, { identifier: 'web-3', decision: 'accept', comment: '干得漂亮' })

  assert.ok((await handleCommand(service, '验收 bad-id')).includes('任务号格式'))
  const rejected = await handleCommand(service, '驳回 web-3 首页样式崩了')
  assert.ok(rejected.includes('已驳回 web-3'))
  assert.equal(service.seen.decision, 'return')
  assert.equal(service.seen.comment, '首页样式崩了')
  assert.ok((await handleCommand(service, '驳回 web-3')).includes('必须带理由'))
})

test('wechat outbound 出站规整与重试判定', () => {
  const chunks = outboundChunks(`**粗体** \`code\` ${'长'.repeat(4000)}`)
  assert.ok(chunks.length > 1, '超长文本必须分块')
  for (const chunk of chunks) assert.ok(chunk.length <= 3500)
  assert.ok(!outboundChunks('~~划掉~~')[0].includes('~~'), '删除线噪点应被过滤')
  assert.equal(isRetryable(new Error('x')), true)
  assert.equal(isRetryable(new WechatIlinkError('PROTOCOL_ERROR', 'x', false)), false)
  assert.equal(isRetryable(new WechatIlinkError('TIMEOUT', 'x', true)), true)
})

test('wechat channel 未启用时的状态与推送行为', () => {
  const store = { getState: () => null, enqueue() { throw new Error('不应入队') } }
  const channel = new WechatChannel({ store, config: { wechat: { enabled: false } } })
  assert.equal(channel.status().phase, 'disabled')
  assert.doesNotThrow(() => channel.notify('任务完成'))
  assert.equal(store.enqueued, undefined)
})

test('wechat channel 管理员绑定与指令回复走 sendTo', async () => {
  const sent = []
  const store = await new WechatStore(join(await mkdtemp(join(tmpdir(), 'wechat-ch-')), 'w.db')).open()
  const channel = new WechatChannel({ store, config: { wechat: { enabled: true } } })
  channel.service = {
    stateView: () => ({ projects: [] }),
    taskViewByIdentifier: id => ({ identifier: id, status: 'in_progress', title: 't', comments: [] }),
    wechatReview: async () => 'ok',
  }
  channel.transport = { async sendMessage(request) { sent.push(request) } }
  const message = { senderId: 'p-admin', contextToken: 'ctx-1', clientId: 'c1', text: '绑定' }
  await channel.onInbound(message, channel.transport)
  assert.equal(store.getState().admin_peer_id, 'p-admin')
  assert.ok(sent.at(-1).text.includes('管理员'))
  await channel.onInbound({ ...message, text: '帮助' }, channel.transport)
  assert.ok(sent.at(-1).text.includes('状态'))
  // 未绑定前非管理员消息被忽略
  store.clearCredentials()
  store.saveCursor('')
  await channel.onInbound({ ...message, text: '状态' }, channel.transport)
  store.close()
})

test('wechat channel 扫码授权 begin 与 wait 必须同一 transport 实例', async () => {
  const store = await new WechatStore(join(await mkdtemp(join(tmpdir(), 'wechat-auth-')), 'w.db')).open()
  const channel = new WechatChannel({ store, config: { wechat: { enabled: true } } })
  const instances = []
  let resolved
  const finish = new Promise(resolve => { resolved = resolve })
  channel.makeTransport = () => {
    const transport = {
      async beginAuthorization() {
        return { id: 'ch-1', qrCodeUrl: 'https://mp.weixin.qq.com/x', createdAt: Date.now() }
      },
      async waitAuthorization(challenge) {
        await finish
        return { token: 't', botId: 'b', userId: 'u', baseUrl: 'https://ilinkai.weixin.qq.com' }
      },
      async notifyStart() {},
    }
    instances.push(transport)
    return transport
  }
  channel.connect = async credentials => { channel.phase = 'connected'; channel.savedCredentials = credentials }
  const challenge = await channel.beginLogin()
  assert.equal(challenge.id, 'ch-1')
  assert.equal(instances.length, 1, 'begin 阶段只应创建一个 transport')
  resolved()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(instances.length, 1, 'wait 必须复用 begin 的同一 transport 实例（vendor active Map 在实例内部）')
  assert.equal(channel.status().phase, 'connected')
  assert.equal(JSON.parse(store.getState().credentials_json).token, 't')
  store.close()
})
