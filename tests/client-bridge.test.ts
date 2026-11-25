// 客户端桥（src/client.ts，dsh.client 浏览器半边）守门：插件页与原生 SPA 间的会话跳转
// 双通道——冷启动消费 localStorage 待开键、热路径响应 BroadcastChannel 广播与 storage 事件。
// node 无浏览器全局：逐用例把 globalThis 的 localStorage/BroadcastChannel/addEventListener
// 换成替身再驱动 apply（测完还原）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/client.js'

class FakeBroadcastChannel {
  static channels: any[] = []
  declare name: string
  declare onmessage: ((event: any) => void) | null
  constructor(name: string) { this.name = name; this.onmessage = null; FakeBroadcastChannel.channels.push(this) }
  postMessage(data) {
    for (const channel of FakeBroadcastChannel.channels) {
      if (channel !== this && channel.onmessage) channel.onmessage({ data })
    }
  }
  close() {}
  static reset() { FakeBroadcastChannel.channels = [] }
}

function withBrowserEnv(storage, listeners, run) {
  const saved = {
    localStorage: globalThis.localStorage,
    BroadcastChannel: globalThis.BroadcastChannel,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
  }
  ;(globalThis as any).localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k: string) => storage.delete(k),
  } as any
  ;(globalThis as any).BroadcastChannel = FakeBroadcastChannel
  ;(globalThis as any).addEventListener = (name: string, fn: any) => { listeners[name] = fn }
  ;(globalThis as any).removeEventListener = (name: string) => { delete listeners[name] }
  try { return run() } finally { Object.assign(globalThis as any, saved) }
}

const makeCtx = () => {
  const ctx: any = {
    opened: [],
    effects: [],
    effect(fn, tag) { ctx.effects.push({ fn, tag }); return () => {} },
    uiWorkspace: { openSession: (id) => { ctx.opened.push(id) } },
  }
  return ctx
}

test('冷启动：SPA 起来时消费插件页留下的待开键', () => {
  FakeBroadcastChannel.reset()
  const storage = new Map([['dsh-team-bots:open-session', 'session-cold']])
  const listeners: any = {}
  const ctx = makeCtx()
  withBrowserEnv(storage, listeners, () => apply(ctx))
  assert.deepEqual(ctx.opened, ['session-cold'])
  assert.equal(storage.has('dsh-team-bots:open-session'), false, '消费后删键')
})

test('热路径：BroadcastChannel 广播 open-session 即开；无关载荷忽略', () => {
  FakeBroadcastChannel.reset()
  const storage = new Map()
  const listeners: any = {}
  const ctx = makeCtx()
  withBrowserEnv(storage, listeners, () => apply(ctx))
  const post = (data) => {
    // 模拟插件页：自己持一条不在列表里的通道发消息
    const sender = new FakeBroadcastChannel('dsh-team-bots')
    sender.postMessage(data)
  }
  assert.equal(ctx.opened.length, 0)
  post({ type: 'open-session', sessionId: 'session-warm' })
  post({ type: 'other', sessionId: 'session-x' })
  post({ type: 'open-session', sessionId: '' })
  post({ type: 'open-session' })
  assert.deepEqual(ctx.opened, ['session-warm'])
})

test('storage 事件双保险：写键即开且消费；删除/无关键不触发', () => {
  FakeBroadcastChannel.reset()
  const storage = new Map()
  const listeners: any = {}
  const ctx = makeCtx()
  withBrowserEnv(storage, listeners, () => apply(ctx))
  const onStorage = listeners.storage
  assert.ok(onStorage, 'storage 监听已注册')
  onStorage({ key: 'dsh-team-bots:open-session', newValue: 'session-event' })
  assert.deepEqual(ctx.opened, ['session-event'])
  assert.equal(storage.has('dsh-team-bots:open-session'), false, '双保险路径同样消费删键')
  onStorage({ key: 'dsh-team-bots:open-session', newValue: null })
  onStorage({ key: 'other-key', newValue: 'x' })
  assert.equal(ctx.opened.length, 1)
})

test('无 uiWorkspace 服务（旧宿主）时静默完成不抛', () => {
  FakeBroadcastChannel.reset()
  const storage = new Map()
  const listeners: any = {}
  const ctx: any = { effect(fn, tag) { return () => {} } }
  withBrowserEnv(storage, listeners, () => apply(ctx))
  assert.ok(listeners.storage, '桥监听照常注册（开不了会话也不影响宿主）')
  listeners.storage({ key: 'dsh-team-bots:open-session', newValue: 'session-x' })
  assert.equal(storage.has('dsh-team-bots:open-session'), false, '消费仍删键，不残留')
})
