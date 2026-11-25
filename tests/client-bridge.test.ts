// 客户端桥（src/client.ts，dsh.client 浏览器半边）守门。
//
// 两条防线：
// 1) 形态防线：宿主把该文件原文内联进 classic script 执行，顶层出现 ESM 语法会让整包
//    解析失败（浏览器报 Unexpected token 'export'，插件 import failed，桥从未运行）。
//    所以这里用 VM 执行**构建产物**（src/client.js）——ESM 语法会当场抛错。
// 2) 行为防线：冷启动消费待开键、热路径响应广播与 storage 事件；打开动作走重试泵
//    （会话目录未就绪时 openSession 抛 unknown session，泵 600ms 一拍重试，超限告警）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/client.js'), 'utf8')

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
  registration: any
}

/**
 * 在 VM 里执行构建产物，取出它向 window.__ModuleLoader__ 注册的工厂。
 * @param env - 浏览器替身环境。
 */
function loadBundle(env: Env): void {
  const sandbox: any = {
    console: { warn: (...args: any[]) => env.warnings.push(args.join(' ')), log: () => {}, error: () => {} },
    setTimeout: env.clock.setTimeout,
    clearTimeout: env.clock.clearTimeout,
    Map,
    Set,
    Date,
    Error,
  }
  sandbox.window = {
    localStorage: {
      getItem: (k: string) => (env.storage.has(k) ? env.storage.get(k)! : null),
      setItem: (k: string, v: string) => env.storage.set(k, String(v)),
      removeItem: (k: string) => env.storage.delete(k),
    },
    BroadcastChannel: FakeBroadcastChannel,
    addEventListener: (name: string, fn: any) => { env.listeners[name] = fn },
    removeEventListener: (name: string) => { delete env.listeners[name] },
    __ModuleLoader__: {
      load: (registration: any) => { env.registration = registration },
    },
  }
  sandbox.globalThis = sandbox
  runInContext(source, createContext(sandbox), { filename: 'src/client.js' })
}

function makeEnv(): Env {
  const env: Env = {
    storage: new Map(),
    listeners: {},
    clock: makeClock(),
    ctx: null,
    warnings: [],
    registration: null,
  }
  env.ctx = {
    opened: [] as string[],
    effects: [] as Array<{ fn: () => void }>,
    effect(fn: () => void) { env.ctx.effects.push({ fn }); return () => {} },
    uiWorkspace: {
      openSession(id: string) {
        if (env.ctx.catalogReady || env.ctx.opened.includes(id)) { env.ctx.opened.push(id); return }
        throw new Error(`sessions.retain: unknown session ${id}`)
      },
    },
    catalogReady: false,
  }
  return env
}

const flushUntilSettled = (env: Env, beats = 40) => {
  for (let i = 0; i < beats && env.clock.pending() > 0; i++) {
    env.clock.tick()
    if (env.ctx.opened.length > 0) break
  }
}

test('形态：构建产物是 classic script，自注册到 window.__ModuleLoader__', () => {
  FakeBroadcastChannel.reset()
  const env = makeEnv()
  loadBundle(env)
  assert.ok(env.registration, '未向 __ModuleLoader__ 注册')
  assert.equal(env.registration.id, 'dsh-team-bots', '注册 id 必须是包名')
  const exports = env.registration.factory(() => ({}))
  assert.deepEqual(Array.from(exports.inject as string[]), ['uiWorkspace'])
  assert.equal(typeof exports.apply, 'function')
})

test('冷启动：目录未就绪时重试泵兜住，目录就绪即打开', () => {
  FakeBroadcastChannel.reset()
  const env = makeEnv()
  env.storage.set('dsh-team-bots:open-session', 'session-cold')
  loadBundle(env)
  env.registration.factory(() => ({})).apply(env.ctx)
  assert.deepEqual(env.ctx.opened, [], '目录未就绪，首次尝试不打开也不丢请求')
  assert.equal(env.storage.has('dsh-team-bots:open-session'), false, '消费后删键')
  env.ctx.catalogReady = true
  flushUntilSettled(env)
  assert.deepEqual(env.ctx.opened, ['session-cold'])
})

test('热路径：BroadcastChannel 广播即入泵；无关载荷忽略', () => {
  FakeBroadcastChannel.reset()
  const env = makeEnv()
  loadBundle(env)
  env.registration.factory(() => ({})).apply(env.ctx)
  const sender = new FakeBroadcastChannel('dsh-team-bots')
  sender.postMessage({ type: 'open-session', sessionId: 'session-warm' })
  sender.postMessage({ type: 'other', sessionId: 'session-x' })
  sender.postMessage({ type: 'open-session', sessionId: '' })
  sender.postMessage({ type: 'open-session' })
  env.ctx.catalogReady = true
  flushUntilSettled(env)
  assert.deepEqual(env.ctx.opened, ['session-warm'])
})

test('effect 清理是返回值而非回调体：注册不会立刻清掉重试定时器', () => {
  FakeBroadcastChannel.reset()
  const env = makeEnv()
  loadBundle(env)
  // 模拟 cordis：effect 回调体立即执行，其返回值才是清理函数。
  const cleanups: Array<() => void> = []
  env.ctx.effect = (fn: () => unknown) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
    return () => {}
  }
  env.storage.set('dsh-team-bots:open-session', 'session-x')
  env.registration.factory(() => ({})).apply(env.ctx)
  // 回调体立即执行过，但定时器必须还在（否则重试泵被自清，只试一次）
  assert.ok(env.clock.pending() > 0, '重试定时器不应在 effect 注册时被清掉')
})

test('目录一直不就绪：超限放弃并 console.warn（不静默）', () => {
  FakeBroadcastChannel.reset()
  const env = makeEnv()
  env.storage.set('dsh-team-bots:open-session', 'session-never')
  loadBundle(env)
  env.registration.factory(() => ({})).apply(env.ctx)
  // 推进超过 25 次尝试上限（600ms 一拍）
  for (let i = 0; i < 30 && env.clock.pending() > 0; i++) env.clock.tick()
  assert.deepEqual(env.ctx.opened, [])
  assert.ok(env.warnings.some(w => w.includes('session-never')), '超限后明确告警')
})

test('storage 事件双保险：写键即开且消费；删除/无关键不触发', () => {
  FakeBroadcastChannel.reset()
  const env = makeEnv()
  loadBundle(env)
  env.registration.factory(() => ({})).apply(env.ctx)
  const onStorage = env.listeners.storage
  assert.ok(onStorage, 'storage 监听已注册')
  onStorage({ key: 'dsh-team-bots:open-session', newValue: 'session-event' })
  onStorage({ key: 'dsh-team-bots:open-session', newValue: null })
  onStorage({ key: 'other-key', newValue: 'x' })
  env.ctx.catalogReady = true
  flushUntilSettled(env)
  assert.deepEqual(env.ctx.opened, ['session-event'])
  assert.equal(env.storage.has('dsh-team-bots:open-session'), false, '双保险路径同样消费删键')
})

test('无 uiWorkspace 服务（旧宿主）时静默完成不抛', () => {
  FakeBroadcastChannel.reset()
  const env = makeEnv()
  loadBundle(env)
  const bare: any = { effect: (fn: () => void) => () => {} }
  env.registration.factory(() => ({})).apply(bare)
  assert.ok(env.listeners.storage, '桥监听照常注册')
})
