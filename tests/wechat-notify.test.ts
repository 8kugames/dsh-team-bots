// DSHBOTS-182：微信推送收敛——创建→完成闭环：创建成功与真正进入「已完成」（→done 转换）
// 各推恰一条（通知域统一收口在 src/services/task-notify.js），交付（→in_review/待验收）节点
// 不推。done 的全部转换路径（总监验收 applyReview、微信「验收 KEY-N」指令 wechatReview、
// 看板/编辑表单直接完成 transitionTask/updateTask）都收口在 updateTask 的 notifyTaskDone；
// 重复提交 done 不会真的转换，也就不会重复推。
// DSHBOTS-185：待发队列治理——通道级测试：推送失败重试设上限（超限废弃不补发）、
// 链接建立作废存量堆积（只发链接后新事件）、同轮多条推送合批为一次发送。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { WechatChannel } from '../src/wechat/channel.js'
import { WechatStore } from '../src/wechat/store.js'
import { WechatIlinkError } from '../src/wechat/commands.js'

// startRun 只记账不回调完成：任务 run 停在 running，交付/验收节奏完全由测试掌控。
class HoldingRuntime { declare started: unknown[]; declare canceled: unknown[];
  constructor() {
    this.started = []
    this.canceled = []
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) {
    this.started.push(run.id)
    return `session-${run.id}`
  }
  async cancelRun(runId) {
    this.canceled.push(runId)
    return true
  }
}

// schedulerIntervalMs 拉满 30s（resolveConfig 上限）：测试期内定时 tick 不掺和。
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-notify-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new HoldingRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  return { root, store, service, runtime }
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timeout waiting for condition')
}

async function closeQuietly(store, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch {
      break
    }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    store.close()
  } catch {}
}

async function seedProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({ name: 'Notify', key: 'TSN', ownerBotId: director.id, memberIds: [dev.id] })
  return { dev, project }
}

// 微信通道桩：只记录 notify 文本，不落库。
function stubWechat(service) {
  const pushed = []
  service.wechat = { notify(text) { pushed.push(text) } }
  return pushed
}

// 走一遍真实的交付前舞步：todo → in_progress（开工入队并起跑）→ in_review（写运行被中止）。
async function deliverForReview(service, store, task) {
  const actor = { type: 'user', id: service.localUserId }
  await service.transitionTask(task.id, 'in_progress', actor)
  await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND status = 'running'", task.id))
  await service.transitionTask(task.id, 'in_review', actor)
  await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND status = 'canceled'", task.id))
}

test('bot 交付收尾（→in_review 待验收）：不推微信，交付群消息照常', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '交付不推', assigneeBotId: dev.id, postCard: false })
    // 同步直入队一条运行且不触发 tick：run 停在 queued，交付节奏由 finishRun 掌控。
    service.enqueueTaskRun(service.taskRow(task.id), 'manual', { type: 'system', id: 'system' })
    const run = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task'", task.id)
    const pushed = stubWechat(service)

    await service.finishRun({ runId: run.id, status: 'succeeded', output: '交付完成' } as any)

    assert.equal(service.taskRow(task.id).status, 'in_review', '交付后进入待验收')
    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', run.id).status, 'succeeded')
    assert.equal(pushed.length, 0, '交付（待验收）节点不推微信')
    // 反证收尾真的走了交付分支：群里的「已交付」消息不受影响，撤的只是微信推送。
    assert.ok(
      store.all("SELECT * FROM messages WHERE project_id = ? AND body LIKE '%已交付%'", project.id).length >= 1,
      '交付消息照常落群',
    )
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('验收通过（applyReview 路径）：推恰一条完成通知，重复验收被拒不重复推', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '验收推送', assigneeBotId: dev.id, postCard: false })
    const pushed = stubWechat(service)
    await deliverForReview(service, store, task)
    assert.equal(pushed.length, 0, '开工/交付过程节点都不推微信')

    await service.applyReview(
      service.taskRow(task.id),
      service.projectRow(project.id),
      'accept',
      '验收通过',
      { type: 'user', id: service.localUserId },
    )

    assert.equal(service.taskRow(task.id).status, 'done')
    assert.equal(pushed.length, 1, '完成只推一条')
    assert.equal(pushed[0], `任务 TSN-${task.number}《验收推送》已完成。回复「详情 TSN-${task.number}」查看。`)

    await assert.rejects(
      () => service.applyReview(
        service.taskRow(task.id),
        service.projectRow(project.id),
        'accept',
        '',
        { type: 'user', id: service.localUserId },
      ),
      /不在待验收状态/,
    )
    assert.equal(pushed.length, 1, 'done 后重复验收被 TRANSITIONS 拒绝，不再推')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('微信「验收 KEY-N」指令：同一收口推恰一条，指令回复文案不受影响', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '微信验收', assigneeBotId: dev.id, postCard: false })
    const pushed = stubWechat(service)
    await deliverForReview(service, store, task)
    assert.equal(pushed.length, 0, '过程节点不推')

    const reply = await service.wechatReview(`tsn-${task.number}`, { decision: 'accept', comment: '过了' })

    assert.ok(reply.includes('已验收通过'), '指令回复文案不受影响')
    assert.equal(service.taskRow(task.id).status, 'done')
    assert.equal(pushed.length, 1, '微信验收路径同样只推一条')
    assert.equal(pushed[0], `任务 TSN-${task.number}《微信验收》已完成。回复「详情 TSN-${task.number}」查看。`)
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('看板/编辑表单直接完成（transition_task → done）：同样推恰一条', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev } = await seedProject(service, store)
    const project = store.get('SELECT * FROM projects WHERE key = ?', 'TSN')
    task = await service.createTask({ projectId: project.id, title: '直接完成', assigneeBotId: dev.id, postCard: false })
    const pushed = stubWechat(service)
    const actor = { type: 'user', id: service.localUserId }
    await deliverForReview(service, store, task)
    assert.equal(pushed.length, 0, '过程节点不推')

    await service.transitionTask(task.id, 'done', actor)

    assert.equal(service.taskRow(task.id).status, 'done')
    assert.equal(pushed.length, 1, '直接完成同样只推一条')
    assert.ok(pushed[0].includes(`任务 TSN-${task.number}《直接完成》已完成`))

    // done → done 重复提交是同状态幂等（与重复 in_progress 提交同构，不构成状态转换）：不重复推。
    await service.transitionTask(task.id, 'done', actor)
    assert.equal(pushed.length, 1, '同状态重复提交不重复推')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('创建任务（DSHBOTS-182 增补）：推恰一条含 KEY-N/标题/派给谁，无指派如实注明', async () => {
  const { root, store, service } = await setup()
  try {
    const { dev, project } = await seedProject(service, store)
    const pushed = stubWechat(service)

    const task = await service.createTask({ projectId: project.id, title: '创建推送', assigneeBotId: dev.id, postCard: false })

    assert.equal(pushed.length, 1, '创建只推一条')
    assert.equal(pushed[0], `任务 TSN-${task.number}《创建推送》已创建，派给 Builder。回复「详情 TSN-${task.number}」查看。`)

    const unassigned = await service.createTask({ projectId: project.id, title: '无主创建', status: 'todo', postCard: false })
    assert.equal(pushed.length, 2, '无指派任务创建同样推一条')
    assert.equal(pushed[1], `任务 TSN-${unassigned.number}《无主创建》已创建，暂未指派。回复「详情 TSN-${unassigned.number}」查看。`)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

// ---- DSHBOTS-185：待发队列治理（通道级） ----

// 真实 WechatStore 临时库 + 桩 transport：只关心 outbox 语义，不碰 vendor 协议。
async function openChannelStore() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-outbox-'))
  const store = await new WechatStore(join(root, 'w.db')).open()
  return { root, store }
}

// 已连接通道：phase='connected'、管理员与会话凭证齐备，sendMessage 可注入成败。
function connectedChannel(store, sendMessage?, { batchWindowMs = 20 } = {}) {
  const sent = []
  const logs = []
  const channel = new WechatChannel({
    store,
    config: { wechat: { enabled: true } },
    log: { info: () => {}, warn: m => logs.push(m), error: () => {} } as unknown as Console,
    batchWindowMs,
  })
  channel.transport = {
    async sendMessage(request: { text: string }) {
      if (sendMessage) await sendMessage(request)
      sent.push(request.text)
    },
  } as any
  channel.bindAuthorizedAdmin({ userId: 'p-admin' })
  channel.peers.set('p-admin', { contextToken: 'ctx', clientId: 'c1' } as any)
  channel.phase = 'connected'
  return { channel, sent, logs }
}

test('D-185 合批：多条待发合并为一次发送，超过明细上限截断加「等 N 项」', async () => {
  const { root, store } = await openChannelStore()
  try {
    const texts = Array.from({ length: 7 }, (_, i) => `任务 TSN-${i + 1}《任务${i + 1}》已完成。回复「详情 TSN-${i + 1}」查看。`)
    for (const text of texts) store.enqueue(text)
    const { channel, sent } = connectedChannel(store)

    await channel.flushOutbox(channel.transport, new AbortController().signal)

    assert.equal(sent.length, 1, '7 条待发只占一次通道调用')
    const body = sent[0]
    assert.ok(body.includes('任务动态 7 条：'), '合批摘要带总条数头')
    for (let i = 0; i < 5; i++) assert.ok(body.includes(texts[i]), `明细第 ${i + 1} 条保留原文`)
    assert.ok(body.includes('……等 2 项'), '超出明细上限的部分汇总为「等 N 项」')
    assert.ok(!body.includes(texts[5]) && !body.includes(texts[6]), '截断掉的条目不进正文')
    assert.equal(store.pendingOutbox().length, 0, '含截断条目在内全部标记已发送')
    const rows = store.db.prepare('SELECT * FROM outbox').all()
    assert.ok(rows.every(row => row.sent_at && !row.gave_up_at))
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('D-185 单条待发不受合批影响：原文直发，无摘要头尾', async () => {
  const { root, store } = await openChannelStore()
  try {
    const text = '任务 TSN-1《单条》已完成。回复「详情 TSN-1」查看。'
    store.enqueue(text)
    const { channel, sent } = connectedChannel(store)

    await channel.flushOutbox(channel.transport, new AbortController().signal)

    assert.equal(sent.length, 1)
    assert.equal(sent[0], text, '单条保持原文，不加「任务动态」头')
    assert.equal(store.pendingOutbox().length, 0)
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('D-185 重试上限：可重试失败计次，达上限废弃，通道痊愈后不再补发', async () => {
  const { root, store } = await openChannelStore()
  try {
    let fail = true
    const { channel, sent, logs } = connectedChannel(store, () => {
      if (fail) throw new WechatIlinkError('PROTOCOL_ERROR', 'iLink rejected the message', true)
    })
    store.enqueue('任务 TSN-9《堆积》已完成。回复「详情 TSN-9」查看。')
    const signal = () => new AbortController().signal

    await channel.flushOutbox(channel.transport, signal())
    await channel.flushOutbox(channel.transport, signal())
    assert.equal(store.pendingOutbox().length, 1, '前两次可重试失败保留待发')
    assert.equal(sent.length, 0)

    await channel.flushOutbox(channel.transport, signal())
    const row = store.db.prepare('SELECT * FROM outbox WHERE id = ?').get(1)
    assert.ok(row.gave_up_at, '第三次失败达上限，废弃')
    assert.equal(row.sent_at, null, '废弃不冒充已发送')
    assert.equal(store.pendingOutbox().length, 0, '废弃后不再占用待发队列')
    assert.ok(logs.some(line => line.includes('推送废弃') && line.includes('超限')))

    fail = false
    await channel.flushOutbox(channel.transport, signal())
    assert.equal(sent.length, 0, '通道恢复后不补发废弃的历史堆积')
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('D-185 链接建立：作废此前全部待发堆积，链接后新事件照常发送', async () => {
  const { root, store } = await openChannelStore()
  try {
    // 模拟重启/换号前的历史堆积：链接尚未建立时落盘的三条
    const stale = ['旧堆积一', '旧堆积二', '旧堆积三']
    for (const text of stale) store.enqueue(text)
    const { channel, sent } = connectedChannel(store)

    // connect 会起真实轮询：每轮 poll 带 10ms 真实间隔（微任务循环会饿死定时器），
    // connect 返回后立即 stop()，由 stop abort 本链接的 epoch 让轮询干净退出。
    channel.makeTransport = () => ({
      async notifyStart() {},
      async poll() {
        await new Promise(resolve => setTimeout(resolve, 10))
        return { cursor: '', messages: [] }
      },
      async sendMessage(request) { sent.push(request.text) },
    })
    await channel.connect({ token: 't' })
    await channel.stop()

    assert.equal(store.pendingOutbox().length, 0, '链接建立后存量待发全部作废')
    const rows = store.db.prepare('SELECT * FROM outbox').all()
    assert.equal(rows.length, 3)
    assert.ok(rows.every(row => row.gave_up_at && !row.sent_at))
    assert.equal(sent.length, 0, '历史堆积不补发，不占消息额度')

    // 链接之后的新事件照常发送：重新挂上会话凭证与 transport
    channel.peers.set('p-admin', { contextToken: 'ctx', clientId: 'c9' } as any)
    channel.transport = {
      async sendMessage(request: { text: string }) { sent.push(request.text) },
    } as any
    channel.notify('任务 TSN-1《新事件》已完成。回复「详情 TSN-1》查看。')
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(sent.length, 1, '链接之后的新事件照常发送')
    assert.ok(sent[0].includes('TSN-1'), '发送的是新事件而非旧堆积')
    assert.ok(sent.every(text => !stale.some(old => text.includes(old))), '旧堆积文本不出现在任何出站消息里')
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('D-185 notify 合批窗口：窗口内多次推送合并为一次发送', async () => {
  const { root, store } = await openChannelStore()
  try {
    const { channel, sent } = connectedChannel(store)

    channel.notify('任务 TSN-1《甲》已创建，暂未指派。回复「详情 TSN-1」查看。')
    channel.notify('任务 TSN-2《乙》已完成。回复「详情 TSN-2」查看。')
    await new Promise(resolve => setTimeout(resolve, 120))

    assert.equal(sent.length, 1, '同一窗口内的两条推送只占一次通道调用')
    assert.ok(sent[0].includes('任务动态 2 条：'))
    assert.ok(sent[0].includes('TSN-1') && sent[0].includes('TSN-2'))
    assert.equal(store.pendingOutbox().length, 0)
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
