// DSHBOTS-329 守门：飞书回程闭环（入站出站成环）。
// ①origin='feishu' 的运行 trigger_type 落 'feishu'（solo 直达 + 群聊直达两条路径）；
// ②该运行收尾后回复回到飞书管理员消息锚点（store.reply_message_id，lark-cli 出站参数断言）；
// ③origin='wechat' 回程零回归（微信通道照收一条、排版不变）；
// ④普通 UI 消息（origin 空）trigger_type 仍 'mention'，收尾不推任何通道。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { FeishuChannel } from '../src/feishu/channel.js'
import { FeishuStore } from '../src/feishu/store.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function boot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
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
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

/** 通道桩：记录 (text, opts)。 */
function channelStub(record: Array<{ text: string, opts: any }>) {
  return {
    notify(text: string, opts: any) {
      record.push({ text, opts })
    },
  }
}

test('origin=feishu：solo 直达与群聊直达的运行 trigger_type 都落 feishu', async () => {
  const { root, store, service } = await boot('dsh-feishu-return-1-')
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'Feishu Return', key: 'FSR', ownerBotId: director.id })
    const project = store.get("SELECT * FROM projects WHERE key = 'FSR'")

    // 飞书入站自由文本（origin='feishu'）→ 项目外 director solo 运行
    const inbound = await service.feishuChat(null, '飞书来的一条消息')
    assert.ok(inbound?.messageId, '飞书消息落 solo 会话')
    const soloRun = store.get(
      "SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ?",
      inbound.messageId,
    )
    assert.ok(soloRun, '必须派生 solo_chat 运行')
    assert.equal(soloRun.trigger_type, 'feishu', '飞书来源 solo 运行打 feishu 标记')

    // 飞书来源的群聊直达（origin='feishu'）→ 项目 chat 运行
    const sent = await service.sendMessage(
      project.id,
      '群里来自飞书的提问',
      { type: 'user', id: service.localUserId },
      null,
      [],
      { origin: 'feishu' },
    )
    const chatRun = store.get("SELECT * FROM runs WHERE kind = 'chat' AND trigger_ref = ?", sent.messageId)
    assert.ok(chatRun, '必须派生 chat 运行')
    assert.equal(chatRun.trigger_type, 'feishu', '飞书来源群聊运行打 feishu 标记')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('飞书触发运行收尾：回复推到飞书管理员消息锚点（reply_message_id）', async () => {
  const { root, store, service } = await boot('dsh-feishu-return-2-')
  const feishuStore = new FeishuStore(join(root, 'feishu-channel.sqlite'))
  await feishuStore.open()
  let channel: FeishuChannel | null = null
  try {
    // 卡②入站时落的出站锚点：管理员最近一条消息 id（飞书回复据此定位话题）
    feishuStore.saveReplyMessageId('om_admin_msg_001', 'ou_admin_1')
    const sent: string[][] = []
    channel = new FeishuChannel({
      store: feishuStore,
      config: { feishu: { enabled: true, cliPath: '/fake/lark-cli' } } as any,
      log: { info() {}, warn() {}, error() {} },
      runLark: async (args: string[]) => {
        sent.push(args)
        return '{"message_id":"om_reply_001"}'
      },
    })
    channel.phase = 'ready'
    const wechatPushed: Array<{ text: string, opts: any }> = []
    ;(service as any).feishu = channel
    ;(service as any).wechat = channelStub(wechatPushed)

    const inbound = await service.feishuChat(null, '帮我看下今天的安排')
    const run = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ?", inbound.messageId)
    assert.ok(run)
    assert.equal(run.trigger_type, 'feishu')

    await service.finishRun({ runId: run.id, status: 'succeeded', output: '收到，我来安排。' } as any)
    await channel.flushOutbox()

    assert.equal(sent.length, 1, '飞书通道恰好外发一条')
    const args = sent[0]
    assert.deepEqual(args.slice(0, 3), ['im', '+messages-reply', '--message-id'])
    assert.equal(args[3], 'om_admin_msg_001', '回复落在管理员消息锚点上')
    assert.ok(args[5].includes('收到，我来安排。'), '回复正文随出站带出')
    assert.equal(wechatPushed.length, 1, '扇出口径（DSHBOTS-326）：同一事件各已启用通道各收一条')
  } finally {
    channel?.stop()
    feishuStore.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('origin=wechat：回程零回归（微信通道照收一条、排版不变）', async () => {
  const { root, store, service } = await boot('dsh-feishu-return-3-')
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const wechatPushed: Array<{ text: string, opts: any }> = []
    const feishuPushed: Array<{ text: string, opts: any }> = []
    ;(service as any).wechat = channelStub(wechatPushed)
    ;(service as any).feishu = channelStub(feishuPushed)

    await service.sendSoloMessage(
      director.id,
      '微信来的一条消息',
      { type: 'user', id: 'wx_admin_peer' },
      [],
      { origin: 'wechat' },
    )
    const message = store.get("SELECT * FROM solo_messages WHERE body = '微信来的一条消息'")
    const run = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ?", message.id)
    assert.ok(run)
    assert.equal(run.trigger_type, 'wechat', '微信来源 solo 运行标记不变')

    await service.finishRun({ runId: run.id, status: 'succeeded', output: '收到，我来安排。' } as any)
    assert.equal(wechatPushed.length, 1, '微信通道照收一条')
    assert.deepEqual(wechatPushed[0].text.split('\n').slice(0, 2), ['director', '———————————————'])
    assert.ok(wechatPushed[0].text.includes('收到，我来安排。'))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('普通 UI 消息不受影响：trigger_type 仍 mention，收尾不推任何通道', async () => {
  const { root, store, service } = await boot('dsh-feishu-return-4-')
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'Plain Chat', key: 'PLA', ownerBotId: director.id })
    const project = store.get("SELECT * FROM projects WHERE key = 'PLA'")
    const wechatPushed: Array<{ text: string, opts: any }> = []
    const feishuPushed: Array<{ text: string, opts: any }> = []
    ;(service as any).wechat = channelStub(wechatPushed)
    ;(service as any).feishu = channelStub(feishuPushed)

    // UI 单聊（不带 origin）
    await service.sendSoloMessage(director.id, '界面单聊消息', { type: 'user', id: service.localUserId })
    const soloMessage = store.get("SELECT * FROM solo_messages WHERE body = '界面单聊消息'")
    const soloRun = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ?", soloMessage.id)
    assert.ok(soloRun)
    assert.equal(soloRun.trigger_type, 'mention', 'UI 单聊运行保持 mention')

    // UI 群聊（不带 origin）
    const sent = await service.sendMessage(project.id, '界面群聊消息', { type: 'user', id: service.localUserId })
    const chatRun = store.get("SELECT * FROM runs WHERE kind = 'chat' AND trigger_ref = ?", sent.messageId)
    assert.ok(chatRun)
    assert.equal(chatRun.trigger_type, 'mention', 'UI 群聊运行保持 mention')

    await service.finishRun({ runId: soloRun.id, status: 'succeeded', output: '界面单聊回复' } as any)
    await service.finishRun({ runId: chatRun.id, status: 'succeeded', output: '界面群聊回复' } as any)
    assert.equal(wechatPushed.length, 0, '普通 UI 消息不推微信')
    assert.equal(feishuPushed.length, 0, '普通 UI 消息不推飞书')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
