import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatStore } from '../src/wechat/store.js'
import { extractTaskId, handleCommand, isRetryable, outboundChunks, WechatBusinessError, WechatIlinkError } from '../src/wechat/commands.js'
import {
  adminDenied, answerFailed, answerHelp, answerReceipt, approvalCard, badTaskId, batchDigest,
  botsList, chatReply, connectedReceipt, failureText, helpText, keysList, needPickProject,
  needReturnReason, noOwner, projectList, projectNotFound, questionCard, reviewResult,
  statesView, taskCreated, taskDone, taskDetail, trHelp, unknownCommand, welcomeAdmin,
} from '../src/wechat/format.js'
import { WechatChannel } from '../src/wechat/channel.js'
import { TASK_ID_PATTERN } from '../src/util.js'
import { AppError } from '../src/errors.js'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

const SERVICE_STUB = (): any => ({
  stateView() {
    return { projects: [{ key: 'web', name: 'Web', tasks: [
      { number: 3, status: 'in_progress', title: '写登录页' },
      { number: 4, status: 'done', title: '已完成' },
      { number: 5, status: 'in_review', title: '等验收' },
    ] }] }
  },
  wechatProjectBots(key) {
    if (String(key).toLowerCase() !== 'web') return []
    return [
      { name: 'director', member_role: 'owner', status: 'active' },
      { name: 'builder', member_role: 'member', status: 'active' },
      { name: 'sleeper', member_role: 'member', status: 'paused' },
    ]
  },
  taskViewByIdentifier(identifier) {
    return { identifier, status: 'in_review', title: '写登录页', assigneeName: 'Builder', comments: [] }
  },
  wechatReview(identifier, { decision, comment }) {
    this.seen = { identifier, decision, comment }
    return `已${decision === 'accept' ? '验收' : '驳回'} ${identifier}`
  },
  // DSHBOTS-208 直达对话桩：记录调用并按 key 命中/未命中模拟项目解析。
  chatted: null,
  async wechatChat(key, body, fallbackKey) {
    this.chatted = { key, body, fallbackKey }
    if (key && key.toLowerCase() !== 'web') return null
    return { project: { id: 'p-web', key: key ? key.toLowerCase() : 'web', name: 'Web' }, messageId: 'msg_1', runBots: ['bot_director'] }
  },
})

async function openStore(prefix = 'wechat-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const store = await new WechatStore(join(dir, 'w.db')).open()
  return { dir, store }
}

test('wechat store 持久化凭证、游标、管理员与发件箱', async () => {
  const { dir, store } = await openStore('wechat-store-')
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

test('wechat commands /? /states /detail /reject 路由（DSHBOTS-249）', async () => {
  assert.ok((await handleCommand({}, '/?')).includes('可用指令'))
  assert.ok((await handleCommand({}, '')).includes('可用指令'))
  // 旧触发式指令已收编进 / 前缀：中文词不再拦截，走直达对话（无可用项目时引导选项目）。
  const free = { stateView: () => ({ projects: [] }), async wechatChat() { return { error: 'no_target' } } }
  assert.ok((await handleCommand(free, 'foo')).includes('还没有选定直达的项目'))

  const service = SERVICE_STUB()
  const states = await handleCommand(service, '/states')
  assert.ok(states.includes('【Web】'))
  assert.ok(states.includes('web-5 [in_review] 等验收'))
  assert.ok(!states.includes('web-3'), '非 in_progress 任务不应出现在验收面清单')

  const detail = await handleCommand(service, '/detail web-5')
  assert.ok(detail.includes('写登录页'))
  assert.ok(detail.includes('指派 Builder'), '详情应带指派')

  assert.ok((await handleCommand(service, '/detail bad-id')).includes('任务号格式'))
  const rejected = await handleCommand(service, '/reject web-5 首页样式崩了')
  assert.ok(rejected.includes('已驳回 web-5'))
  assert.deepEqual(service.seen, { identifier: 'web-5', decision: 'return', comment: '首页样式崩了' })
  assert.ok((await handleCommand(service, '/reject web-5')).includes('必须带理由'))
})

test('wechat commands /detail /reject 正文里任务号可无空格分隔', async () => {
  const service = SERVICE_STUB()

  // 任务号出现在正文任意位置（extractTaskId 不强制首位）
  const reply = await handleCommand(service, '/detail 请看 web-5')
  assert.ok(reply.includes('写登录页'))

  const returned = await handleCommand(service, '/reject web-5 样式崩了')
  assert.ok(returned.includes('已驳回 web-5'))
  assert.equal(service.seen.comment, '样式崩了')

  // 正文里没有合法任务号时给明确提示
  const missing = await handleCommand(service, '/detail 随便说说')
  assert.ok(missing.includes('任务号格式'))
  assert.ok(missing.includes('web-3'))
})

test('wechat commands 任务号口径与 service 一致', async () => {
  const servicePattern = /^([a-z][a-z0-9-]*)-(\d+)$/i
  assert.equal(TASK_ID_PATTERN.source, servicePattern.source)
  const samples = ['web-3', 'a1-2', 'web-3-4', 'bad-id', 'web-', '-3', '3-web', 'Web-3']
  for (const sample of samples) {
    assert.equal(TASK_ID_PATTERN.test(sample), servicePattern.test(sample), `口径不一致: ${sample}`)
  }
  // 旧正则会误拒的数字/连字符前缀，现在要能被识别
  assert.equal(TASK_ID_PATTERN.test('web-3'), true)
  assert.equal(TASK_ID_PATTERN.test('a1-2'), true)
  assert.equal(extractTaskId('请看 a1-2 任务'), 'a1-2')
  assert.equal(extractTaskId('没有任务号'), null)
})

test('wechat outbound 出站规整与重试判定', () => {
  const chunks = outboundChunks(`**粗体** \`code\` ${'长'.repeat(4000)}`)
  assert.ok(chunks.length > 1, '超长文本必须分块')
  for (const chunk of chunks) assert.ok(chunk.length <= 3500)
  assert.ok(!outboundChunks('~~划掉~~')[0].includes('~~'), '删除线噪点应被过滤')
  assert.equal(isRetryable(new Error('x')), true)
  assert.equal(isRetryable(new WechatIlinkError('PROTOCOL_ERROR', 'x', false)), false)
  assert.equal(isRetryable(new WechatIlinkError('TIMEOUT', 'x', true)), true)
  assert.equal(isRetryable(new WechatBusinessError('业务失败')), false)
})

test('wechat channel 未启用时的状态与推送行为', () => {
  const store = { getState: () => null, enqueue() { throw new Error('不应入队') } }
  const channel: any = new WechatChannel({ store, config: { wechat: { enabled: false } } })
  assert.equal(channel.status().phase, 'disabled')
  assert.doesNotThrow(() => channel.notify('任务完成'))
  assert.equal((store as any).enqueued, undefined)
})

test('wechat channel 扫码授权成功后自动绑定授权者为管理员', async () => {
  const { dir, store } = await openStore('wechat-bind-')
  try {
    const channel: any = new WechatChannel({ store, config: { wechat: { enabled: true } } })
    channel.makeTransport = () => ({
      async beginAuthorization() {
        return { id: 'ch-1', qrCodeUrl: 'https://mp.weixin.qq.com/x', createdAt: Date.now() }
      },
      async waitAuthorization() {
        // vendor confirmed 分支返回 { token, botId, userId(=ilink_user_id), baseUrl }
        return { token: 't', botId: 'b', userId: 'ilink-user-1', baseUrl: 'https://ilinkai.weixin.qq.com' }
      },
      async notifyStart() {},
    })
    channel.connect = async () => {}
    await channel.beginLogin()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(store.getState().admin_peer_id, 'ilink-user-1', '授权成功应把授权者写进 admin_peer_id')
    assert.equal(channel.status().adminPeerId, 'ilink-user-1')
    assert.equal(channel.status().pendingAdmin, false)
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 授权响应无用户标识时降级为首条入站消息绑定', async () => {
  const { dir, store } = await openStore('wechat-fallback-')
  try {
    const sent = []
    const channel: any = new WechatChannel({ store, config: { wechat: { enabled: true } } })
    channel.makeTransport = () => ({
      async beginAuthorization() {
        return { id: 'ch-2', qrCodeUrl: 'https://mp.weixin.qq.com/x', createdAt: Date.now() }
      },
      async waitAuthorization() {
        return { token: 't', botId: 'b', baseUrl: 'https://ilinkai.weixin.qq.com' }
      },
      async notifyStart() {},
    })
    channel.connect = async () => {}
    await channel.beginLogin()
    await new Promise(resolve => setTimeout(resolve, 20))
    channel.transport = { async sendMessage(request) { sent.push(request) } }
    assert.equal(store.getState().admin_peer_id, null)
    assert.equal(channel.status().pendingAdmin, true, '授权成功但无用户标识时应置位待绑定标记')

    await channel.onInbound({ senderId: 'p-first', contextToken: 'ctx', clientId: 'c1', text: '你好' }, channel.transport)
    assert.equal(store.getState().admin_peer_id, 'p-first', '本次授权会话的首条入站消息发送者应被绑定')
    assert.equal(channel.status().pendingAdmin, false)
    assert.ok(sent.at(-1).text.includes('管理员'))
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 只有 admin_peer_id 能执行管理指令，「绑定」口令已移除', async () => {
  const { dir, store } = await openStore('wechat-admin-')
  try {
    const sent = []
    const channel: any = new WechatChannel({ store, config: { wechat: { enabled: true } } })
    channel.service = SERVICE_STUB()
    channel.transport = { async sendMessage(request) { sent.push(request) } }
    channel.bindAuthorizedAdmin({ userId: 'p-admin' })
    assert.equal(store.getState().admin_peer_id, 'p-admin')

    await channel.onInbound({ senderId: 'p-admin', contextToken: 'ctx-1', clientId: 'c1', text: '/?' }, channel.transport)
    assert.ok(sent.at(-1).text.includes('可用指令'))

    // 非管理员消息被忽略，不执行管理指令
    const before = sent.length
    await channel.onInbound({ senderId: 'p-other', contextToken: 'ctx-2', clientId: 'c2', text: '/states' }, channel.transport)
    assert.equal(sent.length, before, '非管理员消息不应触发任何回复')
    assert.equal(store.getState().admin_peer_id, 'p-admin')

    // 「绑定」口令已移除：管理员发「绑定」不再改绑 admin，而是按自由文本直达项目总监（DSHBOTS-208）
    await channel.onInbound({ senderId: 'p-admin', contextToken: 'ctx-1', clientId: 'c3', text: '绑定' }, channel.transport)
    assert.ok(sent.at(-1).text.includes('已连接【Web】'), '「绑定」按自由文本直达，回连接确认')
    assert.equal(store.getState().admin_peer_id, 'p-admin', '管理员绑定不受影响')
    assert.equal(store.getDirectProjectKey(), 'web', '首次直达成功后通道记住绑定项目')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 处理失败时 cursor 不前移，成功才落盘', async () => {
  const { dir, store } = await openStore('wechat-cursor-')
  try {
    const logs = []
    const channel: any = new WechatChannel({
      store,
      config: { wechat: { enabled: true } },
      log: { info: () => {}, warn: m => logs.push(m), error: () => {} } as unknown as Console,
    })
    channel.service = { stateView() { throw new Error('内部故障 detail-secret') } }
    channel.transport = { async sendMessage() {} }
    channel.bindAuthorizedAdmin({ userId: 'p-admin' })

    const controller = new AbortController()
    const epoch = { abort: controller, drain: Promise.resolve() }
    channel.epoch = epoch
    const transport = {
      async poll() {
        controller.abort()
        return { cursor: 'c-next', messages: [{ messageId: 'm-1', senderId: 'p-admin', contextToken: 'ctx', clientId: 'c1', text: '/states' }] }
      },
    }
    await channel.pollLoop(epoch, transport, controller.signal)
    assert.equal(store.getState().cursor, '', '处理失败时 cursor 不能前移')
    assert.ok(logs.some(line => line.includes('消息处理失败')), '失败要写日志')

    // 处理成功时才推进并落盘
    const store2 = await new WechatStore(join(await mkdtemp(join(tmpdir(), 'wechat-cursor2-')), 'w.db')).open()
    const channel2: any = new WechatChannel({ store: store2, config: { wechat: { enabled: true } } })
    channel2.service = SERVICE_STUB()
    channel2.transport = { async sendMessage() {} }
    channel2.bindAuthorizedAdmin({ userId: 'p-admin' })
    const controller2 = new AbortController()
    const epoch2 = { abort: controller2, drain: Promise.resolve() }
    channel2.epoch = epoch2
    await channel2.pollLoop(epoch2, {
      async poll() {
        controller2.abort()
        return { cursor: 'c-next', messages: [{ messageId: 'm-2', senderId: 'p-admin', contextToken: 'ctx', clientId: 'c1', text: '/?' }] }
      },
    }, controller2.signal)
    assert.equal(store2.getState().cursor, 'c-next')
    store2.close()
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 内部异常不回显给用户', async () => {
  const { dir, store } = await openStore('wechat-err-')
  try {
    const sent = []
    const logs = []
    const channel: any = new WechatChannel({
      store,
      config: { wechat: { enabled: true } },
      log: { info: () => {}, warn: m => logs.push(m), error: () => {} } as unknown as Console,
    })
    channel.service = { stateView() { throw new Error('内部数据库 detail-secret') } }
    channel.transport = { async sendMessage(request) { sent.push(request) } }
    channel.bindAuthorizedAdmin({ userId: 'p-admin' })
    // onInbound 会把处理异常继续抛给上层（用于 cursor 不前移），但用户侧只收到通用提示
    await assert.rejects(
      () => channel.onInbound({ senderId: 'p-admin', contextToken: 'ctx', clientId: 'c1', text: '/states' }, channel.transport),
      /detail-secret/,
    )
    const text = sent.at(-1).text
    assert.ok(!text.includes('detail-secret'), '内部异常原文不应回显给用户')
    assert.ok(!text.includes('Error'))
    assert.ok(text.includes('消息处理失败'))
    assert.ok(logs.some(line => line.includes('detail-secret')), '详细错误要写日志')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 业务性拒绝给可读提示且不重试', async () => {
  const { dir, store } = await openStore('wechat-biz-')
  try {
    const sent = []
    const channel: any = new WechatChannel({ store, config: { wechat: { enabled: true } } })
    channel.service = {
      stateView() { return { projects: [] } },
      wechatReview() { throw new AppError('NOT_FOUND', '项目 web 没有任务 3', 404) },
    }
    channel.transport = { async sendMessage(request) { sent.push(request) } }
    channel.bindAuthorizedAdmin({ userId: 'p-admin' })
    await assert.doesNotReject(
      () => channel.onInbound({ senderId: 'p-admin', contextToken: 'ctx', clientId: 'c1', text: '/reject web-3 差' }, channel.transport),
      '业务性拒绝不应作为处理失败上抛（否则 cursor 永不推进）',
    )
    assert.ok(sent.at(-1).text.includes('没有任务 3'), '业务错误应给用户可读提示')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 旧授权流程失败不会清掉新登录状态', async () => {
  const { dir, store } = await openStore('wechat-failauth-')
  try {
    const channel: any = new WechatChannel({ store, config: { wechat: { enabled: true } } })
    const authOld = { id: 'old', state: 'scanning' }
    const authNew = { id: 'new', state: 'scanning' }
    channel.auth = authNew
    channel.failAuth(new Error('旧流程失败'), authOld)
    assert.equal(channel.auth, authNew, '旧流程失败不得清掉当前登录状态')
    assert.equal(channel.error, null)

    channel.failAuth(new Error('当前流程失败'), authNew)
    assert.equal(channel.auth, null, '当前流程失败应清掉登录状态')
    assert.match(channel.error, /当前流程失败/)
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 不可重试错误直接废弃不补发，可重试错误计次保留待发', async () => {
  const { dir, store } = await openStore('wechat-outbox-')
  try {
    const logs = []
    let mode = 'permanent'
    let attempts = 0
    const channel: any = new WechatChannel({
      store,
      config: { wechat: { enabled: true } },
      log: { info: () => {}, warn: m => logs.push(m), error: () => {} } as unknown as Console,
    })
    channel.transport = {
      async sendMessage() {
        attempts += 1
        if (mode === 'permanent') throw new WechatIlinkError('PROTOCOL_ERROR', '消息不完整', false)
        throw new WechatIlinkError('TIMEOUT', '网络超时', true)
      },
    }
    channel.bindAuthorizedAdmin({ userId: 'p-admin' })
    channel.peers.set('p-admin', { contextToken: 'ctx', clientId: 'c1' })
    store.enqueue('推送内容')

    await channel.flushOutbox(channel.transport, new AbortController().signal)
    assert.equal(attempts, 1)
    const rows = () => store.db.prepare('SELECT * FROM outbox ORDER BY id').all()
    let row = rows()[0]
    assert.equal(row.sent_at, null, '发送失败不能标记为已发送')
    assert.ok(row.gave_up_at, '不可重试错误应直接废弃')
    assert.equal(store.pendingOutbox().length, 0, '废弃条目不再占用待发队列')
    assert.ok(logs.some(line => line.includes('推送废弃') && line.includes('id=1')))

    await channel.flushOutbox(channel.transport, new AbortController().signal)
    assert.equal(attempts, 1, '废弃条目不再重试')

    mode = 'retryable'
    store.enqueue('可重试内容')
    await channel.flushOutbox(channel.transport, new AbortController().signal)
    assert.equal(attempts, 2, '可重试错误应继续尝试')
    row = rows().at(-1)
    assert.equal(row.attempts, 1, '可重试失败计一次尝试')
    assert.equal(row.gave_up_at, null, '未超限不废弃')
    assert.equal(store.pendingOutbox().length, 1, '可重试失败保留待发')
    assert.ok(logs.some(line => line.includes('可重试')))
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 空文本不入队、推送成功才标记已发送', async () => {
  const { dir, store } = await openStore('wechat-empty-')
  try {
    const channel: any = new WechatChannel({ store, config: { wechat: { enabled: true } } })
    channel.notify('   ')
    assert.equal(store.pendingOutbox().length, 0, '空文本不应进入发送队列')
    assert.equal(store.enqueue(''), false)

    const sent = []
    channel.transport = { async sendMessage(request) { sent.push(request) } }
    channel.bindAuthorizedAdmin({ userId: 'p-admin' })
    channel.peers.set('p-admin', { contextToken: 'ctx', clientId: 'c1' })
    channel.notify('任务完成')
    await channel.flushOutbox(channel.transport, new AbortController().signal)
    assert.equal(sent.length, 1)
    assert.equal(store.pendingOutbox().length, 0, '发送成功才标记已发送')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat store 数据目录 0700、库文件与凭据 0600', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-perm-'))
  try {
    const dir = join(root, 'channel')
    await mkdir(dir, { recursive: true, mode: 0o755 })
    await chmod(dir, 0o755)
    const dbFile = join(dir, 'w.db')
    await writeFile(dbFile, '')
    await chmod(dbFile, 0o666)

    const store = await new WechatStore(dbFile).open()
    const dirStat = await stat(dir)
    assert.equal(dirStat.mode & 0o777, 0o700, '数据目录必须是 0700')
    const fileStat = await stat(dbFile)
    assert.equal(fileStat.mode & 0o777, 0o600, '数据库文件（含明文 token）必须是 0600')
    store.saveCredentials({ token: 'secret-token', botId: 'b', userId: 'u' })
    const walStat = await stat(`${dbFile}-wal`).catch(() => null)
    if (walStat) assert.equal(walStat.mode & 0o777, 0o600, 'WAL 文件必须 0600')
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('wechat store clearCredentials 同时清空 outbox', async () => {
  const { dir, store } = await openStore('wechat-clear-')
  try {
    store.saveCredentials({ token: 't' })
    store.enqueue('残留消息')
    store.enqueue('另一条')
    assert.equal(store.pendingOutbox().length, 2)
    store.clearCredentials()
    assert.equal(store.pendingOutbox().length, 0, '登出后不得残留出站消息')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat store 清理 N 天前已发送的出站记录（默认 7 天）', async () => {
  const { dir, store } = await openStore('wechat-purge-')
  try {
    store.enqueue('旧的')
    store.enqueue('新的')
    const items = store.pendingOutbox()
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    store.db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?').run(old, items[0].id)
    store.markSent([items[1].id])
    assert.equal(store.purgeSentOutbox(7), 1, '只清理超过保留期的已发送记录')
    const left = store.db.prepare('SELECT id FROM outbox').all()
    assert.equal(left.length, 1)
    assert.equal(left[0].id, items[1].id)
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wechat channel 扫码授权 begin 与 wait 必须同一 transport 实例', async () => {
  const { dir, store } = await openStore('wechat-auth-')
  try {
    const channel: any = new WechatChannel({ store, config: { wechat: { enabled: true } } })
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
    assert.equal(store.getState().admin_peer_id, 'u', '授权者应被绑定为管理员')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// —— DSHBOTS-183：help 变体、q 列项目 key；DSHBOTS-208：{key}: {msg} 直达 + 任意交互 ——

const DISPATCH_STUB = () => ({
  stateView() {
    return { projects: [{ key: 'web', name: 'Web', tasks: [] }, { key: 'bot', name: '', tasks: [] }] }
  },
  chatted: null,
  async wechatChat(key, body, fallbackKey) {
    this.chatted = { key, body, fallbackKey }
    if (key && key.toLowerCase() !== 'web') return null
    return { project: { id: 'p-web', key: 'web', name: 'Web' }, messageId: 'msg_1', runBots: ['bot_director'] }
  },
})

test('wechat commands /? 出帮助，旧 help/？ 触发词不再拦截', async () => {
  const reply = await handleCommand({}, '/?')
  assert.ok(reply.includes('可用指令'))
  assert.ok(reply.includes('/keys'), '帮助里应提到 /keys 指令')
  assert.ok(reply.includes('/tr'), '帮助里应提到 /tr 指令')
  assert.ok(reply.includes('/reject'), '帮助里应提到 /reject 指令')
  assert.ok(reply.includes('任意消息') || reply.includes('其余消息'), '帮助里应说明自由文本直达')

  // 旧触发词（help/?/帮助）已不再是指令：作为自由文本走直达路由
  const free = { stateView: () => ({ projects: [{ key: 'web', name: 'Web', tasks: [] }] }), async wechatChat() { return { error: 'no_target' } } }
  for (const text of ['help', 'Help', '?', '帮助']) {
    assert.ok((await handleCommand(free, text)).includes('还没有选定直达的项目'), `「${text}」应按自由文本直达`)
  }
})

test('wechat commands /keys 列出项目 key，空列表给空态文案', async () => {
  const service = DISPATCH_STUB()
  const reply = await handleCommand(service, '/keys')
  assert.ok(reply.startsWith('项目 key：'))
  assert.ok(reply.includes('  web  Web'), 'key 与名称都应出现')
  assert.ok(reply.includes('  bot'), '无名称项目只列 key')
  assert.equal((await handleCommand(service, '/KEYS')), reply, '大小写不敏感')

  const empty = { stateView: () => ({ projects: [] }) }
  assert.ok((await handleCommand(empty, '/keys')).includes('当前没有可选的项目'))

  // 绑定项目标注（当前）
  const bound = await handleCommand(service, '/keys', { boundKey: 'web' })
  assert.ok(bound.includes('web  Web（当前）'), '绑定项目应带（当前）标注')
  assert.ok(!bound.includes('bot  （当前）'))
})

test('wechat commands 指定项目直达命中：按 key 调 wechatChat 并回执', async () => {
  const service = DISPATCH_STUB()
  const reply = await handleCommand(service, 'web: 上线新版官网')
  assert.ok(reply.includes('已直达【Web】'))
  assert.deepEqual(service.chatted, { key: 'WEB', body: '上线新版官网', fallbackKey: undefined })

  // 全角冒号、key 大小写、消息里再含冒号只切第一段
  const reply2 = await handleCommand(service, 'WEB：改导航样式，备注：今晚发')
  assert.ok(reply2.includes('已直达【Web】'))
  assert.deepEqual(service.chatted, { key: 'WEB', body: '改导航样式，备注：今晚发', fallbackKey: undefined })
})

test('wechat commands 直达未命中 key 给出可选项目列表提示', async () => {
  const service = DISPATCH_STUB()
  const reply = await handleCommand(service, 'nope: 干活')
  assert.ok(reply.includes('没有找到项目 NOPE'))
  assert.ok(reply.includes('可选的项目'))
  assert.ok(reply.includes('web'), '提示里应带可用 key 列表')
  assert.equal(service.chatted.key, 'NOPE', '未命中也要走一次解析定位')
})

test('wechat commands 任意交互：自由文本经绑定项目直达，同项目静默、换项目回执', async () => {
  const service = DISPATCH_STUB()
  const bindings = []
  const ctx = { boundKey: 'web', bind: key => bindings.push(key) }

  // 已绑定同项目：消息原文直达，无逐条回执（回复由运行回程推送）
  const silent = await handleCommand(service, '把首页改成深色模式', ctx)
  assert.equal(silent, '', '绑定项目内的自由文本应静默直达')
  assert.deepEqual(service.chatted, { key: null, body: '把首页改成深色模式', fallbackKey: 'web' })
  assert.deepEqual(bindings, ['web'], '路由成功后仍回写绑定（幂等）')

  // 未绑定但恰一个项目时 commands 层不猜：由 service 决定（桩外的真实现自动选唯一项目）
  const bound = { ...ctx, boundKey: 'bot' }
  const ack = await handleCommand(service, '继续上次的事', bound)
  assert.ok(ack.includes('已连接【Web】'), '切换到新项目应回连接确认')
  assert.ok(service.chatted.fallbackKey === 'bot')

  // 无绑定且多项目（真实现返回 no_target）：引导用 <key>: 先选一次
  const multi = { stateView: () => ({ projects: [{ key: 'a' }, { key: 'b' }] }), async wechatChat() { return { error: 'no_target' } } }
  const guide = await handleCommand(multi, '随便聊聊')
  assert.ok(guide.includes('还没有选定直达的项目'))
  assert.ok(guide.includes('  a') && guide.includes('  b'), '引导里带项目清单')

  // 项目无可用总监：可读提示，不入对话
  const ownerless = { stateView: () => ({ projects: [] }), async wechatChat() { return { error: 'no_owner', project: { key: 'web', name: 'Web' } } } }
  assert.ok((await handleCommand(ownerless, '在吗')).includes('没有可用的总监 Bot'))
})

test('wechat commands 固定指令照旧：/states /reject /detail 路由不变', async () => {
  const service = SERVICE_STUB()
  const states = await handleCommand(service, '/states')
  assert.ok(states.includes('web-5 [in_review] 等验收'))
  assert.ok((await handleCommand(service, '/reject web-5 差')).includes('已驳回 web-5'))
  assert.ok((await handleCommand(service, '/detail web-5')).includes('写登录页'))
  // 非指令文本不再回「未识别」，直达路由由 wechatChat 承接
  const free = await handleCommand(SERVICE_STUB(), 'foo')
  assert.ok(free.includes('已连接【Web】'), '未绑定时的首条自由文本回连接确认')
})

class DispatchStubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

test('wechat 直达真 service：消息以用户身份插入项目会话并触发总监 chat 运行（trigger_type=wechat），回复推回微信', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-direct-'))
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
  service.attachRuntime(new DispatchStubRuntime())
  await service.initialize()
  service.started = true
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'Dispatch Demo', key: 'DISPATCH', ownerBotId: director.id })

    // 小写 key 也要命中（COLLATE NOCASE 同 resolveTaskByIdentifier 口径）
    const reply = await handleCommand(service, 'dispatch: 上线新版官网')
    assert.ok(reply.includes('已直达【Dispatch Demo】'))

    const message = store.get("SELECT * FROM messages WHERE body = '上线新版官网'")
    assert.ok(message, '直达消息必须落库到项目群聊')
    assert.equal(message.project_id, store.get("SELECT id FROM projects WHERE key = 'DISPATCH'").id)
    assert.equal(message.sender_type, 'user')
    assert.equal(message.sender_id, service.localUserId, '以工作台用户身份插入')

    const outbox = store.get("SELECT * FROM outbox WHERE kind = 'chat_run'")
    assert.ok(outbox, '直达必须入 chat_run outbox 触发一轮运行')
    assert.equal(outbox.status, 'delivered')
    assert.equal(outbox.idempotency_key, `chat:${message.id}:${director.id}`)
    assert.equal(JSON.parse(outbox.payload_json).origin, 'wechat', '载荷带微信来源标记')

    const run = store.get("SELECT * FROM runs WHERE kind = 'chat' AND trigger_ref = ?", message.id)
    assert.ok(run, '必须派生 chat 运行')
    assert.equal(run.bot_id, director.id, '无 mention 时定向项目总监（owner_bot_id）')
    assert.equal(run.trigger_type, 'wechat', '微信直达运行打 wechat 标记（回程推送依据）')

    // 已绑定同项目（上一条 <key>: 已 bind）：自由文本静默直达同一位总监
    const silent = await handleCommand(service, '顺带把首页也改了', { boundKey: 'DISPATCH', bind() {} })
    assert.equal(silent, '', '绑定项目内的自由文本无逐条回执')
    const freeMessage = store.get("SELECT * FROM messages WHERE body = '顺带把首页也改了'")
    assert.equal(freeMessage.sender_id, service.localUserId)
    const freeRun = store.get("SELECT * FROM runs WHERE kind = 'chat' AND trigger_ref = ?", freeMessage.id)
    assert.equal(freeRun.bot_id, director.id)
    assert.equal(freeRun.trigger_type, 'wechat')

    // 回程：微信直达运行结束，bot 回复推回管理员；普通群聊运行不推
    // DSHBOTS-217 回程排版：bot 名 + 分隔线（chatReply），失败加 [失败] 纯文字标头。
    const pushed: string[] = []
    ;(service as any).wechat = { notify(text: string) { pushed.push(text) } }
    await service.finishRun({ runId: run.id, status: 'succeeded', output: '收到，我来安排上线。' } as any)
    assert.deepEqual(pushed, ['director\n———————————————\n收到，我来安排上线。'], '直达运行的 bot 回复要推回微信')
    await service.finishRun({ runId: freeRun.id, status: 'failed', error: { message: '模型超时' } } as any)
    assert.equal(pushed.at(-1), '[失败] director\n———————————————\n运行失败：模型超时', '失败提示同样推回')

    await service.sendMessage(store.get("SELECT id FROM projects WHERE key = 'DISPATCH'").id, '工作台普通群聊消息', { type: 'user', id: service.localUserId })
    const uiRun = store.get("SELECT * FROM runs WHERE kind = 'chat' AND trigger_ref = ?", store.get("SELECT id FROM messages WHERE body = '工作台普通群聊消息'").id)
    assert.equal(uiRun.trigger_type, 'mention', '工作台消息不带微信标记')
    const before = pushed.length
    await service.finishRun({ runId: uiRun.id, status: 'succeeded', output: '普通群聊回复' } as any)
    assert.equal(pushed.length, before, '普通群聊运行结束不推微信')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('wechat store 直达项目绑定：保存/读取随通道持久化，登出一并清空', async () => {
  const { dir, store } = await openStore('wechat-bind-key-')
  try {
    assert.equal(store.getDirectProjectKey(), null)
    store.saveDirectProjectKey('WEB')
    assert.equal(store.getDirectProjectKey(), 'WEB', '绑定跨重启持久化在通道库')
    store.saveDirectProjectKey('')
    assert.equal(store.getDirectProjectKey(), null, '空值解除绑定')
    store.saveDirectProjectKey('WEB')
    store.clearCredentials()
    assert.equal(store.getDirectProjectKey(), null, '登出清空直达绑定')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// DSHBOTS-217：微信出站一律纯文本，全部排版函数渲染结果不得含 emoji/符号标记。
const NO_EMOJI = /[\u{1F000}-\u{1FAFF}\u{2500}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]/u

test('wechat 排版纯文本：全部 format 渲染结果无 emoji', () => {
  const project = { key: 'web', name: 'Web' }
  const samples = [
    helpText(),
    statesView([{ key: 'web', name: 'Web', tasks: [{ number: 3, status: 'in_review', title: '等验收' }] }]),
    statesView([]),
    keysList([project, { key: 'bot', name: '' }], 'web'),
    keysList([]),
    botsList([{ name: 'director', member_role: 'owner', status: 'active' }]),
    botsList([]),
    unknownCommand(),
    adminDenied(),
    trHelp(),
    taskDetail({
      identifier: 'web-3', status: 'in_progress', title: '写登录页',
      comments: [{ author_type: 'user', author_id: 'admin', created_at: '2026-11-05 14:00', body: '做得好' }],
    }),
    projectList([project, { key: 'bot', name: '' }]),
    projectList([]),
    connectedReceipt(project, 'dispatch'),
    connectedReceipt(project, 'bind'),
    noOwner(project),
    needPickProject([{ key: 'a' }, { key: 'b' }]),
    projectNotFound('NOPE', [project]),
    badTaskId(),
    needReturnReason(),
    reviewResult('web-3', '写登录页', 'accept'),
    reviewResult('web-3', '写登录页', 'return'),
    chatReply('director', '收到，我来安排上线。'),
    chatReply('director', '运行失败：模型超时', true),
    questionCard('Web', 'director', [{ question: '用哪个方案？', options: [{ label: '方案一' }, { label: '方案二' }] }], 'abc123'),
    approvalCard('Web', 'director', 'bash', '需要执行命令', 'abc123'),
    answerReceipt('abc123', '已记录'),
    answerFailed('abc123', '没有匹配的待答提问'),
    answerHelp(),
    taskCreated('web-3', '写登录页', 'Builder'),
    taskCreated('web-3', '写登录页', ''),
    taskDone('web-3', '写登录页'),
    batchDigest([{ text: 'web-1《甲》已完成' }, { text: 'web-2《乙》已完成' }]),
    welcomeAdmin(),
    failureText(),
  ]
  for (const text of samples) assert.ok(!NO_EMOJI.test(text), `排版不得含 emoji/符号标记：\n${text}`)
})
