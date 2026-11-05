// DSHBOTS-258 守门：项目外 director solo 运行的微信回推。
// 正向：微信来源的自由文本触发 solo_chat 运行（trigger_type='wechat'），运行结束的
// bot 回复（或失败提示）经 wechat.notify 推回，排版走 chatReply（bot 名 + 分隔线）。
// 负向：普通 UI 单聊 solo run（trigger_type='mention'）绝不触发微信推送。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { handleCommand } from '../src/wechat/commands.js'

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

test('微信来源 director solo run：回复与失败提示都推回微信（chatReply 排版口径）', async () => {
  const { root, store, service } = await boot('dsh-solo-wechat-push-1-')
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const pushed: string[] = []
    ;(service as any).wechat = {
      notify(text: string) { pushed.push(text) },
      status: () => ({ adminPeerId: 'wx_admin_peer' }),
    }

    // 微信自由文本 → director solo 通道（DSHBOTS-258 绝对路由）
    const reply = await handleCommand(service, '帮我看下今天的安排', { boundKey: null, bind() {} })
    assert.ok(reply.includes('已直达【director】专属工作区'), '首触回执')
    const solo = store.get("SELECT * FROM solo_messages WHERE sender_id = 'wx_admin_peer'")
    assert.ok(solo)
    const run = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ?", solo.id)
    assert.ok(run, '必须派生 solo_chat 运行')
    assert.equal(run.trigger_type, 'wechat', '微信来源 solo 运行打 wechat 标记')

    // 成功收尾：bot 回复推回微信，排版与群聊直达同口径（bot 名 + 分隔线）
    await service.finishRun({ runId: run.id, status: 'succeeded', output: '收到，我来安排。' } as any)
    assert.deepEqual(pushed, ['director\n———————————————\n收到，我来安排。'], 'solo 回复按 chatReply 口径推回')
    const botReply = store.get(
      "SELECT * FROM solo_messages WHERE sender_type = 'bot' AND run_id = ?",
      run.id,
    )
    assert.ok(botReply, '回复照常落 director 的 solo 会话（UI 可见）')

    // 失败收尾：失败提示同样推回（[失败] 纯文字标头）
    const second = await handleCommand(service, '再看看部署', { boundKey: null, bind() {} })
    assert.equal(second, '', '第二条静默直达')
    const solo2 = store.get(
      "SELECT * FROM solo_messages WHERE sender_id = 'wx_admin_peer' AND run_id IS NULL AND id != ?",
      solo.id,
    )
    const run2 = store.get(
      "SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ? AND id != ?",
      solo2.id, run.id,
    )
    await service.finishRun({ runId: run2.id, status: 'failed', error: { message: '模型超时' } } as any)
    assert.equal(pushed.at(-1), '[失败] director\n———————————————\n运行失败：模型超时', '失败提示推回微信')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('负向：普通 UI 单聊 solo run 不触发微信推送（trigger_type 门禁）', async () => {
  const { root, store, service } = await boot('dsh-solo-wechat-push-2-')
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const pushed: string[] = []
    ;(service as any).wechat = { notify(text: string) { pushed.push(text) } }

    // UI 单聊路径（api.ts 同款调用）：不带 origin，保持 mention，不推微信
    await service.sendSoloMessage(director.id, '普通界面单聊消息', { type: 'user', id: service.localUserId })
    const outbox = store.get("SELECT * FROM outbox WHERE kind = 'solo_chat_run'")
    assert.ok(outbox, 'UI 单聊照常入 outbox')
    assert.equal(JSON.parse(outbox.payload_json).origin, undefined, 'UI 单聊载荷不带微信来源标记')
    const uiMessage = store.get("SELECT * FROM solo_messages WHERE body = '普通界面单聊消息'")
    const uiRun = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ?", uiMessage.id)
    assert.ok(uiRun)
    assert.equal(uiRun.trigger_type, 'mention', 'UI 单聊运行保持 mention（无微信标记）')

    await service.finishRun({ runId: uiRun.id, status: 'succeeded', output: '界面单聊回复' } as any)
    assert.equal(pushed.length, 0, '普通 UI 单聊 solo run 结束不得推送微信')

    const replyRow = store.get("SELECT * FROM solo_messages WHERE sender_type = 'bot' AND run_id = ?", uiRun.id)
    assert.ok(replyRow, 'UI 单聊回复照常落库，仅不推微信')
    assert.equal(replyRow.body, '界面单聊回复')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
