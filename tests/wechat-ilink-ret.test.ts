// tests/wechat-ilink-ret.test.ts —— 微信通道 iLink 拒发细节透出（诊断辅助，未立项卡号）。
// 日志现场：出站推送连续 4 条 `PROTOCOL_ERROR: iLink rejected the message.` 后废弃，
// 上游 ret 码被 vendor 吞掉，凭证失效/频控/内容审核无法区分，第二步对症无从裁决。
// 落地约束：vendor/wechat-ilink 是上游编译产物保持原样（用户拍板，NOTICE 口径），
// ret 透出在本仓桥接层完成——channel.ts 的 observeIlinkReject 包装 makeTransport
// 注入的 fetch 记录 ret!=0，attachRejectDetail 在 sendTo 捕获后拼进错误文案。
// 本守门走「真 vendor + 桥接包装 + 桩 fetch」全链路，五向：
// ①拒发文案带 ret/errmsg 且 vendor 原文案不变；②err_msg 拼法兜底；③ret=0 成功路径
// 不受影响；④网络层错误不误附 ret（无观测残留）；⑤outbox.last_error 与 warn 日志带 ret。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatChannel } from '../src/wechat/channel.js'
import { WechatStore } from '../src/wechat/store.js'
import { WechatIlinkError } from '../src/wechat/commands.js'

const ILINK_ORIGIN = 'https://ilinkai.weixin.qq.com'

// fetch 桩：HTTP 200 + 指定 JSON 回包（ret!=0 即触发 vendor sendText 的拒发分支）。
// 用真 Response：桥接层要 clone() 读 ret，手搓对象没有该方法。
function replyFetch(reply: Record<string, unknown>) {
  return async () => new Response(JSON.stringify(reply), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// 已连接通道 + 真实 vendor transport（经 makeTransport 的桥接 fetch 包装，桩注入假回包）。
async function channelWithFetch(fetchImpl: () => Promise<unknown>, warnLogs: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-ret-'))
  const store = await new WechatStore(join(root, 'w.db')).open()
  const channel = new WechatChannel({
    store,
    config: { wechat: { enabled: true } } as any,
    log: { info: () => {}, warn: (m: string) => warnLogs.push(m), error: () => {} } as unknown as Console,
    batchWindowMs: 20,
  })
  channel.transport = channel.makeTransport(null, { fetch: fetchImpl } as any) as any
  channel.bindAuthorizedAdmin({ userId: 'p-admin' } as any)
  channel.peers.set('p-admin', { contextToken: 'ctx', clientId: 'c1' } as any)
  channel.phase = 'connected'
  return { root, store, channel }
}

test('桥接全链路：vendor 拒发后错误文案带 ret/errmsg，vendor 本体零改动', async () => {
  const logs: string[] = []
  const { root, store, channel } = await channelWithFetch(replyFetch({ ret: -131, errmsg: 'context token expired' }), logs)
  try {
    await assert.rejects(
      () => channel.sendTo('p-admin', '第一条'),
      (error: WechatIlinkError) => {
        assert.equal(error.code, 'PROTOCOL_ERROR', 'vendor 的错误分类不变')
        assert.ok(error.retryable, 'vendor 的可重试语义不变')
        assert.ok(error.message.includes('iLink rejected the message.'), 'vendor 原文案保留，ret 以后缀附注')
        assert.ok(error.message.includes('ret=-131'), `ret 码必须透出，实际文案：${error.message}`)
        assert.ok(error.message.includes('errmsg=context token expired'), 'errmsg 透出')
        return true
      },
    )
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('err_msg 拼法兜底透出（上游字段名未公开，两种兼容）', async () => {
  const { root, store, channel } = await channelWithFetch(replyFetch({ ret: 7, err_msg: 'rate limited' }))
  try {
    await assert.rejects(
      () => channel.sendTo('p-admin', '第一条'),
      (error: WechatIlinkError) => {
        assert.ok(error.message.includes('ret=7'), `ret 码必须透出，实际文案：${error.message}`)
        assert.ok(error.message.includes('errmsg=rate limited'), 'err_msg 归一为 errmsg 透出')
        return true
      },
    )
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ret=0 照常送达（桥接不改变成功路径）', async () => {
  const { root, store, channel } = await channelWithFetch(replyFetch({ ret: 0 }))
  try {
    await assert.doesNotReject(() => channel.sendTo('p-admin', '第一条'))
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('网络层错误不误附 ret：无观测时 attach 原样透传', async () => {
  const { root, store, channel } = await channelWithFetch(async () => {
    throw new Error('connect ECONNREFUSED')
  })
  try {
    await assert.rejects(
      () => channel.sendTo('p-admin', '第一条'),
      (error: WechatIlinkError) => {
        assert.equal(error.code, 'NETWORK_ERROR')
        assert.ok(!error.message.includes('ret='), `无上游响应不得伪造 ret，实际文案：${error.message}`)
        return true
      },
    )
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('诊断落点：拒发 ret 端到端落进 outbox.last_error 与 warn 日志', async () => {
  const logs: string[] = []
  const { root, store, channel } = await channelWithFetch(replyFetch({ ret: -131, errmsg: 'context token expired' }), logs)
  try {
    store.enqueue('任务 TSN-1《拒发诊断》已完成。发送 /detail TSN-1 查看。')

    await channel.flushOutbox(channel.transport, new AbortController().signal)

    assert.equal(store.pendingOutbox().length, 1, '首次可重试失败保留待发')
    const row = store.db.prepare('SELECT * FROM outbox WHERE id = ?').get(1) as any
    assert.ok(String(row.last_error).includes('ret=-131'), `last_error 必须带 ret 码，实际：${row.last_error}`)
    assert.ok(logs.some(line => line.includes('ret=-131')), 'warn 日志同样带 ret 码')
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
