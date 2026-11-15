// DSHBOTS-326：出站通道分发守门。
// 三处出站调用点（提问/审批卡片推送、任务回程）统一走 core.ts 的 channelNotify 扇出：
// ①两通道都启用→同一事件两边各收一条；②feishu 失败→wechat 照收不阻断且留痕；
// ③仅 wechat 启用→与现状一致零回归（单发一条、同收据键、返回值不变）；
// ④两通道都禁用→no-op 不报错。另锚 receiptKey 通道隔离：同一键在两套 outbox 库
// 里各自幂等（库与唯一索引彼此独立，键空间互不干扰）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { WechatStore } from '../src/wechat/store.js'
import { FeishuStore } from '../src/feishu/store.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-channel-fanout-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace,
    dataDir: join(root, 'data'),
    skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0,
    schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  const warnings: string[] = []
  const service = new TeamService({
    store,
    config,
    logger: { info() {}, warn(...args: unknown[]) { warnings.push(args.map(arg => String(arg)).join(' ')) }, error() {} },
  })
  service.attachRuntime(new StubRuntime() as any)
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  await service.createProject({ name: 'Fanout Demo', key: 'FAN', ownerBotId: director.id })
  const project = store.get("SELECT * FROM projects WHERE key = 'FAN'")
  return { root, store, service, project, director, warnings }
}

/** 通道桩：记录 (text, opts)；fail=true 时抛错模拟通道故障。 */
function channelStub(record: Array<{ text: string, opts: any }>, fail = false) {
  return {
    notify(text: string, opts: any) {
      if (fail) throw new Error('通道推送失败（模拟）')
      record.push({ text, opts })
    },
  }
}

const ITEMS = [{ id: 'q1', question: '用哪个方案？', options: [{ label: '方案一' }, { label: '方案二' }] }]

test('通道分发：两通道都启用时同一事件两边各收一条（提问/审批/回程三处）', async () => {
  const { root, store, service, project, director } = await setup()
  try {
    const wechatPushed: Array<{ text: string, opts: any }> = []
    const feishuPushed: Array<{ text: string, opts: any }> = []
    ;(service as any).wechat = channelStub(wechatPushed)
    ;(service as any).feishu = channelStub(feishuPushed)

    assert.equal(service.wechatQuestion(project, { id: 'qstABC123XYZ', bot_name: director.name }, ITEMS), true)
    assert.equal(wechatPushed.length, 1, '微信通道收到提问')
    assert.equal(feishuPushed.length, 1, '飞书通道收到同一提问')
    assert.equal(wechatPushed[0].text, feishuPushed[0].text, '两通道正文一致')
    assert.equal(wechatPushed[0].opts.receiptKey, 'question:qstABC123XYZ')
    assert.equal(feishuPushed[0].opts.receiptKey, 'question:qstABC123XYZ', '同一收据键两通道各自幂等')

    assert.equal(service.wechatApproval(project, { id: 'aprYYY888VVV', bot_name: director.name, tool_name: 'bash', reason: '需要写文件' }), true)
    assert.equal(wechatPushed.length, 2)
    assert.equal(feishuPushed.length, 2, '审批事件也两边各一条')
    assert.equal(feishuPushed[1].opts.receiptKey, 'approval:aprYYY888VVV')

    ;(service as any).notifyWechatChat(director, { trigger_type: 'wechat' }, 'bot 回复正文')
    assert.equal(wechatPushed.length, 3, '回程事件推到微信')
    assert.equal(feishuPushed.length, 3, '回程事件同时推到飞书')
    assert.ok(feishuPushed[2].text.includes('bot 回复正文'))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('通道分发：feishu 失败不阻断微信（留痕 warn，微信照收）', async () => {
  const { root, store, service, project, director, warnings } = await setup()
  try {
    const wechatPushed: Array<{ text: string, opts: any }> = []
    ;(service as any).wechat = channelStub(wechatPushed)
    ;(service as any).feishu = channelStub([], true)

    assert.equal(service.wechatQuestion(project, { id: 'qstABC123XYZ', bot_name: director.name }, ITEMS), true)
    assert.equal(wechatPushed.length, 1, '飞书失败不影响微信收到')
    assert.ok(
      warnings.some(line => line.includes('feishu') && line.includes('通道推送失败')),
      `飞书失败必须留痕，实际：${JSON.stringify(warnings)}`,
    )

    const results = (service as any).channelNotify('直接分发文本')
    assert.deepEqual(results.map((item: any) => item.channel), ['wechat', 'feishu'])
    assert.equal(results.find((item: any) => item.channel === 'feishu').ok, false)
    assert.equal(results.find((item: any) => item.channel === 'wechat').ok, true)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('通道分发：仅微信启用时行为与现状一致（单发一条、同一收据键、返回值不变）', async () => {
  const { root, store, service, project, director } = await setup()
  try {
    const wechatPushed: Array<{ text: string, opts: any }> = []
    ;(service as any).wechat = channelStub(wechatPushed)
    ;(service as any).feishu = null

    assert.equal(service.wechatQuestion(project, { id: 'qstABC123XYZ', bot_name: director.name }, ITEMS), true)
    assert.equal(wechatPushed.length, 1, '只推一条，不重复')
    assert.equal(wechatPushed[0].opts.receiptKey, 'question:qstABC123XYZ')
    assert.ok(wechatPushed[0].text.includes('123xyz'), '正文与现状同款：带短 token')
    assert.ok(wechatPushed[0].text.includes('答 123xyz'), '正文与现状同款：给出回复格式')

    assert.equal(service.wechatApproval(project, { id: 'aprYYY888VVV', bot_name: director.name, tool_name: 'bash', reason: '需要写文件' }), true)
    assert.equal(wechatPushed.length, 2)

    ;(service as any).notifyWechatChat(director, { trigger_type: 'wechat' }, 'bot 回复正文')
    assert.equal(wechatPushed.length, 3)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('通道分发：两通道都禁用时 no-op 不报错（返回 false，不抛异常）', async () => {
  const { root, store, service, project, director } = await setup()
  try {
    ;(service as any).wechat = null
    ;(service as any).feishu = null

    assert.equal(service.wechatQuestion(project, { id: 'qstABC123XYZ', bot_name: director.name }, ITEMS), false)
    assert.equal(service.wechatApproval(project, { id: 'aprYYY888VVV', bot_name: director.name, tool_name: 'bash', reason: '需要写文件' }), false)
    assert.deepEqual((service as any).channelNotify('无人接收的文本'), [])
    assert.doesNotThrow(() => (service as any).notifyWechatChat(director, { trigger_type: 'wechat' }, 'bot 回复正文'))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('收据键通道隔离：同一 receiptKey 在微信/飞书两套 outbox 库内各自幂等、互不吸收', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-channel-receipt-'))
  const wechatStore = new WechatStore(join(root, 'wechat-channel.sqlite'))
  const feishuStore = new FeishuStore(join(root, 'feishu-channel.sqlite'))
  try {
    await wechatStore.open()
    await feishuStore.open()
    const key = 'question:qstABC123XYZ'

    assert.equal(wechatStore.enqueue('提问卡片', key), 'enqueued')
    assert.equal(feishuStore.enqueue('提问卡片', key), 'enqueued', '飞书库不吸收微信库的同键行')
    assert.equal(wechatStore.enqueue('重复提问', key), 'duplicate', '微信库内同键仍幂等吸收')
    assert.equal(feishuStore.enqueue('重复提问', key), 'duplicate', '飞书库内同键仍幂等吸收')

    const wechatRows = wechatStore.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()
    const feishuRows = feishuStore.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()
    assert.equal(wechatRows.n, 1)
    assert.equal(feishuRows.n, 1)
  } finally {
    wechatStore.close()
    feishuStore.close()
    await rm(root, { recursive: true, force: true })
  }
})
