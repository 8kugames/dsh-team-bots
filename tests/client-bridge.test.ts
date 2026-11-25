// 客户端桥（src/client.ts，dsh.client 浏览器半边）守门：插件页与原生 SPA 间的会话跳转。
// 冷启动消费 localStorage 待开键；打开动作走重试泵——会话目录未就绪时 openSession 抛
// unknown session，泵 600ms 一拍重试，超限则放弃并告警（不静默、无副作用）。
// node 无浏览器全局：逐用例把 globalThis 换成替身，并把 setTimeout 换成手动时钟驱动泵。
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

// 手动时钟：捕获 setTimeout 回调，用例里逐拍推进。
function makeClock() {
  const timers: Array<() => void> = []
  return {
    setTimeout(fn: () => void) { timers.push(fn); return timers.length },
    clearTimeout(_t: number) {},
    tick() { const next = timers.splice(0, timers.length); for (const fn of next) fn() },
    pending: () => timers.length,
  }
}

interface Env {
  storage: Map<string, string>
  listeners: Record<string, any>
  clock: ReturnType<typeof makeClock>
  ctx: any
  warnings: string[]
}

function withBrowserEnv(run: (env: Env) => void): Env {
  const saved = {
    localStorage: (globalThis as any).localStorage,
    BroadcastChannel: (globalThis as any).BroadcastChannel,
    addEventListener: (globalThis as any).addEventListener,
    removeEventListener: (globalThis as any).removeEventListener,
    setTimeout: (globalThis as any).setTimeout,
    clearTimeout: (globalThis as any).clearTimeout,
  }
  const env: Env = {
    storage: new Map(),
    listeners: {},
    clock: makeClock(),
    ctx: null,
    warnings: [],
  }
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (env.storage.has(k) ? env.storage.get(k)! : null),
    setItem: (k: string, v: string) => env.storage.set(k, String(v)),
    removeItem: (k: string) => env.storage.delete(k),
  }
  ;(globalThis as any).BroadcastChannel = FakeBroadcastChannel
  ;(globalThis as any).addEventListener = (name: string, fn: any) => { env.listeners[name] = fn }
  ;(globalThis as any).removeEventListener = (name: string) => { delete env.listeners[name] }
  ;(globalThis as any).setTimeout = env.clock.setTimeout
  ;(globalThis as any).clearTimeout = env.clock.clearTimeout
  const ctx: any = {
    opened: [] as string[],
    effects: [] as Array<{ fn: () => void }>,
    effect(fn: () => void) { ctx.effects.push({ fn }); return () => {} },
    uiWorkspace: {
      openSession(id: string) {
        if (ctx.catalogReady || ctx.opened.includes(id)) { ctx.opened.push(id); return }
        throw new Error(`sessions.retain: unknown session ${id}`)
      },
    },
    catalogReady: false,
  }
  env.ctx = ctx
  try { run(env) } finally { Object.assign(globalThis as any, saved) }
  return env
}

const flushUntilSettled = (env: Env, beats = 40) => {
  for (let i = 0; i < beats && env.clock.pending() > 0; i++) {
    env.clock.tick()
    if (env.ctx.opened.length > 0) break
  }
}

test('冷启动：目录未就绪时重试泵兜住，目录就绪即打开', () => {
  FakeBroadcastChannel.reset()
  const env = withBrowserEnv((env) => {
    env.storage.set('dsh-team-bots:open-session', 'session-cold')
    apply(env.ctx)
    assert.deepEqual(env.ctx.opened, [], '目录未就绪，首次尝试不打开也不丢请求')
    env.ctx.catalogReady = true
  })
  flushUntilSettled(env)
  assert.deepEqual(env.ctx.opened, ['session-cold'])
  assert.equal(env.storage.has('dsh-team-bots:open-session'), false, '消费后删键')
})

test('热路径：BroadcastChannel 广播即入泵；无关载荷忽略', () => {
  FakeBroadcastChannel.reset()
  const env = withBrowserEnv((env) => {
    apply(env.ctx)
    const sender = new FakeBroadcastChannel('dsh-team-bots')
    sender.postMessage({ type: 'open-session', sessionId: 'session-warm' })
    sender.postMessage({ type: 'other', sessionId: 'session-x' })
    sender.postMessage({ type: 'open-session', sessionId: '' })
    sender.postMessage({ type: 'open-session' })
    env.ctx.catalogReady = true
  })
  flushUntilSettled(env)
  assert.deepEqual(env.ctx.opened, ['session-warm'])
})

test('目录一直不就绪：超限放弃并 console.warn（不静默）', () => {
  FakeBroadcastChannel.reset()
  const warnings: string[] = []
  const savedWarn = console.warn
  console.warn = (...args: any[]) => warnings.push(args.join(' '))
  try {
    withBrowserEnv((env) => {
      env.storage.set('dsh-team-bots:open-session', 'session-never')
      apply(env.ctx)
      // 在替身时钟仍生效的窗口内推进超过 25 次尝试上限（600ms 一拍）
      for (let i = 0; i < 30 && env.clock.pending() > 0; i++) env.clock.tick()
    })
    assert.ok(warnings.some(w => w.includes('session-never')), '超限后明确告警')
  } finally { console.warn = savedWarn }
})

test('storage 事件双保险：写键即开且消费；删除/无关键不触发', () => {
  FakeBroadcastChannel.reset()
  const env = withBrowserEnv((env) => {
    apply(env.ctx)
    const onStorage = env.listeners.storage
    assert.ok(onStorage, 'storage 监听已注册')
    onStorage({ key: 'dsh-team-bots:open-session', newValue: 'session-event' })
    onStorage({ key: 'dsh-team-bots:open-session', newValue: null })
    onStorage({ key: 'other-key', newValue: 'x' })
    env.ctx.catalogReady = true
  })
  flushUntilSettled(env)
  assert.deepEqual(env.ctx.opened, ['session-event'])
  assert.equal(env.storage.has('dsh-team-bots:open-session'), false, '双保险路径同样消费删键')
})

test('无 uiWorkspace 服务（旧宿主）时静默完成不抛', () => {
  FakeBroadcastChannel.reset()
  withBrowserEnv((env) => {
    const bare: any = { effect: (fn: () => void) => () => {} }
    apply(bare)
    assert.ok(env.listeners.storage, '桥监听照常注册')
  })
})
