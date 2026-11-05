// 全项目「位置保持式类型擦除」下的类实例成员类型补齐。
// 这是纯类型文件：不产生运行时代码，且 .d.ts 已被 scripts/build.mjs 排除。
//
// 源码里 TeamService / DshRuntime 的业务方法由 defineMethods 动态挂到 prototype，
// 构造函数里的 this.xxx 赋值在 TS 下也需要显式字段声明；这里用模块增强一并补齐，
// 只声明 tsc 实际报错的那些成员，不给类加索引签名、不改任何运行行为。

import type { Store } from '../src/db.js'
import type { AppError } from '../src/errors.js'
import type { PathError } from '../src/paths.js'
import type { DshRuntime } from '../src/runtime.js'
import type { TeamService } from '../src/service.js'
import type { WechatChannel } from '../src/wechat/channel.js'
import type { WechatBusinessError } from '../src/wechat/commands.js'
import type { WechatStore } from '../src/wechat/store.js'

// ---------------------------------------------------------------------------
// 局部辅助类型（模块内私有，不导出）
// ---------------------------------------------------------------------------

/**
 * node:sqlite 的 DatabaseSync 按项目实际调用面自绘。
 * 若直接标注为 @types/node 的 DatabaseSync，prepare().get/all() 会返回
 * Record<string, SQLOutputValue>，把 bigint/Uint8Array 传导到数百处
 * store.get()/store.all() 调用点并连锁报错；本项目所有行都按任意行对象消费，
 * 因此行结果维持 any（与类型擦除前的推断一致），避免对调用点产生任何新约束。
 */
interface SqlDatabase {
  prepare(sql: string): {
    get(...params: any[]): any
    all(...params: any[]): any
    run(...params: any[]): any
  }
  exec(sql: string): void
  close(): void
}

/** vendor/wechat-ilink 为无类型 JS，按 channel.ts 里对 transport 的实际调用面自绘。 */
interface WechatTransport {
  sendMessage(payload: unknown, signal?: AbortSignal): Promise<unknown>
  beginAuthorization(signal: AbortSignal): Promise<unknown>
  waitAuthorization(challenge: unknown, signal: AbortSignal): Promise<unknown>
  notifyStart(signal: AbortSignal): Promise<unknown>
  poll(cursor: string, signal: AbortSignal): Promise<unknown>
}

/** 扫码授权状态机（beginLogin 里的 auth 对象）。 */
interface WechatAuth {
  id: string
  state: string
  event: unknown
  challenge: { qrCodeUrl?: string | null } | null
  verificationResolve: ((code: string) => void) | null
}

/** 一次长轮询连接的生命周期句柄。 */
interface WechatEpoch {
  abort: AbortController
  credentials: unknown
  drain?: Promise<unknown>
}

/** peers Map 的会话凭证值。 */
interface WechatPeer {
  contextToken: unknown
  clientId: unknown
  at: number
}

type WechatPhase =
  | 'disabled' | 'unbound' | 'connecting' | 'connected' | 'reconnecting' | 'needs_reauth'

/** setTimeout 句柄：兼容 Node（含 unref）与 DOM 返回值。 */
type TimerHandle = ReturnType<typeof setTimeout>

// ---------------------------------------------------------------------------
// Store（src/db.js）
// ---------------------------------------------------------------------------
declare module '../src/db.js' {
  interface Store {
    db: SqlDatabase
    ftsEnabled: boolean
  }
}

// ---------------------------------------------------------------------------
// AppError（src/errors.js）
// ---------------------------------------------------------------------------
declare module '../src/errors.js' {
  interface AppError {
    code: string
    status: number
    /** 仅部分调用点标记「不可重试」，故可选。 */
    permanent?: boolean
  }
}

// ---------------------------------------------------------------------------
// PathError（src/paths.js）
// ---------------------------------------------------------------------------
declare module '../src/paths.js' {
  interface PathError {
    code: string
  }
}

// ---------------------------------------------------------------------------
// WechatStore（src/wechat/store.js）
// ---------------------------------------------------------------------------
declare module '../src/wechat/store.js' {
  interface WechatStore {
    db: SqlDatabase | null
    file: string
  }
}

// ---------------------------------------------------------------------------
// WechatBusinessError（src/wechat/commands.js）
// ---------------------------------------------------------------------------
declare module '../src/wechat/commands.js' {
  interface WechatBusinessError {
    permanent: boolean
  }
}

// ---------------------------------------------------------------------------
// DshRuntime（src/runtime.js）
// ---------------------------------------------------------------------------
declare module '../src/runtime.js' {
  interface DshRuntime {
    ctx: DshContext
    config: TeamConfig
    store: Store
    logger: DshLogger
    mask: ((value: unknown) => unknown) | null
    pending: Map<string, unknown>
    pendingByRun: Map<string, unknown>
    childOwner: Map<string, unknown>
    parentHints: Map<string, unknown>
    sessionCreates: Map<string, unknown>
    modelsCache: { at: number; value: unknown[] }
    promptFreeze: Map<string, unknown>
    messageWatermarks: Map<string, unknown>
    selecting: Promise<void>
    completionHandler: ((result: unknown) => unknown) | null
    attached: boolean

    // 由 services/runtime/lifecycle.js 挂到 prototype 上的方法。
    attach(): void
  }
}

// ---------------------------------------------------------------------------
// TeamService（src/service.js）
// ---------------------------------------------------------------------------
declare module '../src/service.js' {
  interface TeamService {
    store: Store
    config: TeamConfig
    logger: DshLogger
    runtime: DshRuntime | null
    localUserId: string
    timer: ReturnType<typeof setInterval> | null
    ticking: boolean
    started: boolean
    ready: Promise<unknown> | null
    rate: Record<string, unknown>
    fingerprints: Map<string, unknown>
    readAuditAlerted: Map<string, unknown>
    lastMaintenanceAt: number
    wechat: WechatChannel | null
    terminalActive: Map<string, unknown>
    /** index.js 里 service.initialize().then(...).catch(...) 的启动 Promise。 */
    boot: Promise<unknown> | null

    // 由 services/*.js 挂到 prototype 上、且被 tsc 报错的成员。
    attachRuntime(runtime: unknown): void
    initialize(): Promise<unknown>
    start(): void
    stop(): void
    tick(): Promise<void>
    reapStalledRuns(): Promise<void>
    createBot(input: unknown, actor?: unknown): Promise<DbRow>
    createProject(input: unknown, actor?: unknown): Promise<DbRow>
    createTask(input: unknown, actor?: unknown): Promise<DbRow>
    sendMessage(
      projectId: unknown,
      bodyInput: unknown,
      actor?: unknown,
      replyTo?: unknown,
      imagesInput?: unknown,
    ): Promise<unknown>
    enqueueTaskRun(task: unknown, triggerType: unknown, actor: unknown): unknown
    resolveTaskByIdentifier(identifier: unknown): { project: DbRow; task: DbRow }
    applyReview(
      task: unknown,
      project: unknown,
      decision: unknown,
      comment: unknown,
      actor: unknown,
    ): Promise<DbRow>
  }
}

// ---------------------------------------------------------------------------
// WechatChannel（src/wechat/channel.js）
// ---------------------------------------------------------------------------
declare module '../src/wechat/channel.js' {
  interface WechatChannel {
    store: WechatStore
    config: TeamConfig
    log: DshLogger
    service: TeamService | null
    transport: WechatTransport | null
    epoch: WechatEpoch | null
    authAbort: AbortController | null
    phase: WechatPhase
    error: string | null
    auth: WechatAuth | null
    peers: Map<unknown, WechatPeer>
    pendingAdmin: { armedAt: number } | null
    processedMessages: Set<unknown>
    batchWindowMs: number
    flushTimer: TimerHandle | null
    flushChain: Promise<unknown>
  }
}
