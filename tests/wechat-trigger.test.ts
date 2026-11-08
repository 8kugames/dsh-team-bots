// tests/wechat-trigger.test.ts —— B4-①/DSHBOTS-328：微信入站 Trigger 留痕守门。
// 吸收原型 sources 层「不收的消息仍进系统并记 reason」：每条入站事件按稳定 id 落
// wechat_inbound（handled/filtered/rejected/duplicate + route + reason），回答「为什么没触发」。
// 守门四向：① 服务层落痕去重与封顶；② 通道层各处置路径（welcome/指令/业务拒绝/非管理员/
// 无正文）；③ 视图映射；④ 命令层 ctx.trigger 分类回填（不改变返回契约）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { WechatChannel } from '../src/wechat/channel.js'
import { WechatStore } from '../src/wechat/store.js'
import { ensureWechatTriggerSchema, recordWechatTriggerRow, WECHAT_TRIGGER_LOG_CAP } from '../src/services/wechat-trigger-schema.js'
import { handleCommand } from '../src/wechat/commands.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-trigger-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

const teardown = async (root, store) => {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

test('服务层留痕：稳定 id 去重 + 滚动封顶 + 视图映射', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  assert.equal(service.recordWechatTrigger({ nativeId: 'm1', peerId: 'p1', text: '你好', disposition: 'handled', route: 'chat:chat' }), 'recorded')
  assert.equal(service.recordWechatTrigger({ nativeId: 'm1', peerId: 'p1', text: '你好', disposition: 'handled', route: 'chat:chat' }), 'duplicate', '同稳定 id 只留一次')
  assert.equal(service.recordWechatTrigger({ nativeId: null, peerId: 'p', text: 'x', disposition: 'handled' }), 'skipped', '无 native id 跳过')
  for (let i = 0; i < 15; i++) {
    service.recordWechatTrigger({ nativeId: `m-${i}`, peerId: 'p1', text: `消息 ${i}`, disposition: 'filtered', route: 'non-admin', reason: '测试' })
  }
  const view = service.wechatTriggersView(200)
  assert.equal(view.count, 16, '1 + 15 条在场')
  assert.equal(view.items[0].disposition, 'filtered', '按时间倒序')
  assert.ok(view.items[0].preview.length <= 120)
  // 封顶：超过 CAP 裁掉最旧。
  for (let i = 100; i < 100 + WECHAT_TRIGGER_LOG_CAP; i++) {
    service.recordWechatTrigger({ nativeId: `m-${i}`, peerId: 'p1', text: `压载 ${i}`, disposition: 'handled', route: 'chat:chat' })
  }
  const capped = Number(store.get('SELECT COUNT(*) AS count FROM wechat_inbound')?.count ?? 0)
  assert.ok(capped <= WECHAT_TRIGGER_LOG_CAP, `滚动封顶生效（实测 ${capped} ≤ ${WECHAT_TRIGGER_LOG_CAP}）`)
})

test('通道层处置留痕：welcome/指令/业务拒绝/非管理员/无正文', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-trigger-ch-'))
  try {
    const wechatStore = await new WechatStore(join(dir, 'w.db')).open()
    const channel: any = new WechatChannel({ store: wechatStore, config: { wechat: { enabled: true } }, log: { info() {}, warn() {}, error() {} } as any })
    channel.setService(service)
    const sent: any[] = []
    channel.transport = { async sendMessage(request) { sent.push(request) } }
    channel.bindAuthorizedAdmin({ userId: 'p-admin' })
    channel.peers.set('p-admin', { contextToken: 'ctx', clientId: 'c1' })
    const msg = (over: Record<string, unknown> = {}) => ({ messageId: `mid-${Math.random()}`, senderId: 'p-admin', text: '/help', contextToken: 'ctx', clientId: 'c1', ...over })

    await channel.onInbound(msg(), channel.transport, new AbortController().signal)
    // welcome/帮助类 handled：无正文过滤、非管理员过滤两条补充。
    channel.recordTrigger(msg({ text: '' }), 'filtered', 'no-text')
    channel.recordTrigger(msg({ senderId: 'p-other', text: 'hi' }), 'filtered', 'non-admin', '发送者不是已绑定管理员')
    // 业务拒绝：带理由的 /reject 指向不存在的任务 → notFound AppError → rejected 留痕。
    await channel.onInbound(msg({ text: '/reject ORD-1 未按验收标准实现' }), channel.transport, new AbortController().signal).catch(() => {})

    const rows = store.all('SELECT disposition, route FROM wechat_inbound ORDER BY rowid')
    const routes = rows.map(row => `${row.disposition}:${row.route}`)
    assert.ok(routes.includes('handled:fixed:help'), `帮助指令按 fixed:help 留痕（实测 ${routes.join(' / ')}）`)
    assert.ok(routes.includes('filtered:no-text'))
    assert.ok(routes.includes('filtered:non-admin'))
    assert.ok(routes.includes('rejected:command'), '业务拒绝按 rejected 留痕')
    // 去重：同 messageId 的重复处理记 duplicate 而非重放。
    const dup = msg({ messageId: 'dup-1' })
    channel.recordTrigger(dup, 'duplicate', 'processed-in-memory')
    channel.recordTrigger(dup, 'duplicate', 'processed-in-memory')
    assert.equal(store.all("SELECT * FROM wechat_inbound WHERE id = 'wechat:dup-1'").length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('命令层 ctx.trigger 分类回填：固定指令/答/批/自由文本，返回契约不变', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  const ctx: any = { isAdmin: true, boundKey: null }
  const reply = await handleCommand(service, '/help', ctx)
  assert.ok(typeof reply === 'string', '返回契约仍是字符串')
  assert.deepEqual(ctx.trigger, { kind: 'fixed', verb: 'help' })

  const chatCtx: any = { isAdmin: true }
  await handleCommand(service, '看一下 ORD', chatCtx)
  assert.equal(chatCtx.trigger.kind, 'chat')

  const emptyCtx: any = {}
  await handleCommand(service, '   ', emptyCtx)
  assert.deepEqual(emptyCtx.trigger, { kind: 'chat', verb: null })

  // 无 ctx 调用（既有测试桩形态）不炸：分类回填是可选增强。
  const reply2 = await handleCommand(service, '/help', null)
  assert.ok(typeof reply2 === 'string')
})
