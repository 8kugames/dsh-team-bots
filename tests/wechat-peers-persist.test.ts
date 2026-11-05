import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatStore } from '../src/wechat/store.js'
import { WechatChannel } from '../src/wechat/channel.js'

// DSHBOTS-191：微信会话凭证（contextToken/clientId）持久化。
// 重启/重连后 channel 从库读回凭证，无需对方先发消息即可主动发送；
// 入站消息同步刷新落库；7 天过期上限，过期回落「等对方发来消息」的既有可恢复路径。

const DAY_MS = 24 * 60 * 60 * 1000

const SERVICE_STUB = () => ({
  stateView() {
    return { projects: [] }
  },
  // D-249 后「帮助」按自由文本直达：桩补一个静默成功的 wechatChat 即可走通入站路径。
  async wechatChat() {
    return { project: { key: 'web', name: 'Web' }, messageId: 'm1' }
  },
})

async function openStore(prefix = 'wechat-peers-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const store = await new WechatStore(join(dir, 'w.db')).open()
  return { dir, store }
}

test('wechat store peers 凭证 UPSERT、读取与过期清理', async () => {
  const { dir, store } = await openStore('wechat-peers-store-')
  try {
    assert.deepEqual(store.loadPeers(), [])
    const now = Date.now()
    assert.equal(store.savePeer('p-1', { contextToken: 'ctx-1', clientId: 'c-1', at: now }), true)
    assert.equal(store.savePeer('', { contextToken: 'x', at: now } as any), false, '缺 peerId 不落库')
    assert.equal(store.savePeer('p-2', { contextToken: '', at: now } as any), false, '缺 contextToken 不落库')
    // 同一联系人再次入站 = 刷新凭证（UPSERT），不是追加行
    store.savePeer('p-1', { contextToken: 'ctx-2', clientId: 'c-2', at: now })
    let rows = store.loadPeers()
    assert.equal(rows.length, 1, '同一 peer 只有一行')
    assert.equal(rows[0].peer_id, 'p-1')
    assert.equal(rows[0].context_token, 'ctx-2')
    assert.equal(rows[0].client_id, 'c-2')
    assert.equal(rows[0].at, now)

    store.savePeer('p-old', { contextToken: 'ctx-old', at: Date.now() - 8 * DAY_MS } as any)
    assert.equal(store.purgeExpiredPeers(7), 1, '只清理超过时效的凭证')
    rows = store.loadPeers()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].peer_id, 'p-1')
    assert.equal(store.loadPeers().length, 1, '幂等：再清一次无变化')

    // 重开同一库文件：建表语句幂等，数据仍在（老库迁移空转）
    store.close()
    const reopened = await new WechatStore(join(dir, 'w.db')).open()
    assert.equal(reopened.loadPeers().length, 1)
    reopened.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 重启后从库加载会话凭证，免对方先发消息', async () => {
  const { dir, store } = await openStore('wechat-peers-restart-')
  let channel: any
  try {
    store.saveCredentials({ token: 't' })
    store.saveAdminPeer('p-admin')
    store.savePeer('p-admin', { contextToken: 'ctx-persist', clientId: 'c-1', at: Date.now() })

    const sent = []
    channel = new WechatChannel({ store, config: { wechat: { enabled: true } } })
    channel.makeTransport = () => ({
      async notifyStart() {},
      async poll() {
        await new Promise(resolve => setTimeout(resolve, 20))
        return { cursor: '', messages: [] }
      },
      async sendMessage(request) { sent.push(request) },
    })
    await channel.connect({ token: 't' })
    assert.equal(channel.peers.get('p-admin')?.contextToken, 'ctx-persist', 'connect 应从库读回凭证')
    await channel.sendTo('p-admin', '重启后直接发送')
    assert.equal(sent.length, 1, '无需对方先发消息即可发送')
    assert.equal(sent[0].contextToken, 'ctx-persist', '发送应使用持久化的会话凭证')
  } finally {
    await channel?.stop()
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 入站消息同步刷新凭证并落库（含非管理员）', async () => {
  const { dir, store } = await openStore('wechat-peers-inbound-')
  try {
    const channel: any = new WechatChannel({ store, config: { wechat: { enabled: true } } })
    channel.service = SERVICE_STUB()
    channel.transport = { async sendMessage() {} }
    channel.bindAuthorizedAdmin({ userId: 'p-admin' })

    await channel.onInbound({ senderId: 'p-admin', contextToken: 'ctx-a', clientId: 'c-a', text: '帮助' }, channel.transport)
    let rows = store.loadPeers()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].context_token, 'ctx-a')
    const firstAt = rows[0].at
    assert.ok(firstAt > Date.now() - 60_000, 'at 应为本次入站时间')

    // 再次入站刷新 token：UPSERT 同一行，at 前移
    await channel.onInbound({ senderId: 'p-admin', contextToken: 'ctx-b', clientId: 'c-b', text: '帮助' }, channel.transport)
    rows = store.loadPeers()
    assert.equal(rows.length, 1, '同一联系人只有一行')
    assert.equal(rows[0].context_token, 'ctx-b')
    assert.ok(rows[0].at >= firstAt)

    // 非管理员消息也被记录凭证（与内存 Map :318 语义一致——只存不回复）
    await channel.onInbound({ senderId: 'p-other', contextToken: 'ctx-o', clientId: 'c-o', text: '状态' }, channel.transport)
    const byId = Object.fromEntries(store.loadPeers().map(row => [row.peer_id, row]))
    assert.equal(byId['p-other']?.context_token, 'ctx-o', '非管理员入站同样落库')
    assert.equal(byId['p-admin']?.context_token, 'ctx-b')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 过期凭证不加载，回落「等对方发来消息」路径', async () => {
  const { dir, store } = await openStore('wechat-peers-ttl-')
  let channel: any
  try {
    store.saveCredentials({ token: 't' })
    store.savePeer('p-admin', { contextToken: 'ctx-stale', clientId: 'c-1', at: Date.now() - 8 * DAY_MS })
    channel = new WechatChannel({ store, config: { wechat: { enabled: true } } })
    channel.makeTransport = () => ({
      async notifyStart() {},
      async poll() {
        await new Promise(resolve => setTimeout(resolve, 20))
        return { cursor: '', messages: [] }
      },
      async sendMessage() {},
    })
    await channel.connect({ token: 't' })
    assert.equal(channel.peers.size, 0, '过期凭证不得加载进内存')
    // 回落到既有可恢复路径：可重试的「等对方发来消息」，不报错刷屏
    await assert.rejects(() => channel.sendTo('p-admin', '推送'), /尚无该联系人的会话凭证，等待对方发来消息/)
    assert.equal(store.loadPeers().length, 1, 'connect 不删行（过期清理只在 start 做一次）')
  } finally {
    await channel?.stop()
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 启动即清理过期凭证并加载有效凭证（start 集成）', async () => {
  const { dir, store } = await openStore('wechat-peers-start-')
  let channel: any
  try {
    store.saveCredentials({ token: 't' })
    store.saveAdminPeer('p-admin')
    store.savePeer('p-admin', { contextToken: 'ctx-fresh', clientId: 'c-1', at: Date.now() - 6 * DAY_MS })
    store.savePeer('p-stale', { contextToken: 'ctx-stale', at: Date.now() - 8 * DAY_MS } as any)

    const sent = []
    channel = new WechatChannel({ store, config: { wechat: { enabled: true } } })
    channel.makeTransport = () => ({
      async notifyStart() {},
      async poll() {
        await new Promise(resolve => setTimeout(resolve, 20))
        return { cursor: '', messages: [] }
      },
      async sendMessage(request) { sent.push(request) },
    })
    await channel.start()
    const rows = store.loadPeers()
    assert.equal(rows.length, 1, '启动应清掉过期凭证行')
    assert.equal(rows[0].peer_id, 'p-admin')
    assert.equal(channel.peers.get('p-admin')?.contextToken, 'ctx-fresh', '未过期凭证（6 天前）应加载')
    await channel.sendTo('p-admin', '重启后推送')
    assert.equal(sent[0].contextToken, 'ctx-fresh')
  } finally {
    await channel?.stop()
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat store 登出清空 peers，防跨账号凭证残留', async () => {
  const { dir, store } = await openStore('wechat-peers-clear-')
  try {
    store.saveCredentials({ token: 't' })
    store.saveAdminPeer('p-admin')
    store.savePeer('p-admin', { contextToken: 'ctx', at: Date.now() } as any)
    assert.equal(store.loadPeers().length, 1)
    store.clearCredentials()
    assert.deepEqual(store.loadPeers(), [], '登出后会话凭证必须清空')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
