// 全项目「位置保持式类型擦除」下的类实例成员类型补齐。
// 这是纯类型文件：不产生运行时代码，且 .d.ts 已被 scripts/build.mjs 排除。
//
// 源码里 TeamService / DshRuntime 的业务方法由 defineMethods 动态挂到 prototype，
// 构造函数里的 this.xxx 赋值在 TS 下也需要显式字段声明；这里用模块增强补齐字段，
// 并通过 extends 把 defineMethods 传入的域方法对象的真实签名合并进类接口。
// 不给类加索引签名、不给方法写 (...args: any[]) => any、不改任何运行行为。

import type { Store } from '../src/db.js'
import type { AppError } from '../src/errors.js'
import type { PathError } from '../src/paths.js'
import type { DshRuntime } from '../src/runtime.js'
import type { TeamService } from '../src/service.js'
import type { WechatChannel } from '../src/wechat/channel.js'
import type { WechatBusinessError } from '../src/wechat/commands.js'
import type { WechatStore } from '../src/wechat/store.js'
import type { FeishuChannel } from '../src/feishu/channel.js'
import type { FeishuStore } from '../src/feishu/store.js'

// 业务域方法由 defineMethods 挂到 prototype 上。与其逐个手抄签名，直接把
// defineMethods 传入的那些域方法对象的真实类型交叉合并进类接口：方法名、参数名、
// 参数与返回类型全部来自实现本身，既精确又不会随域文件改动而漂移。
import { botsMethods } from '../src/services/bots.js'
import { projectsMethods } from '../src/services/projects.js'
import { chatMethods } from '../src/services/chat.js'
import { tasksMethods } from '../src/services/tasks.js'
import { taskDispatchMethods } from '../src/services/task-dispatch.js'
import { taskRunMethods } from '../src/services/task-runs.js'
import { taskNotifyMethods } from '../src/services/task-notify.js'
import { taskReviewMethods } from '../src/services/task-review.js'
import { notifyMethods } from '../src/services/notify.js'
import { runsMethods } from '../src/services/runs.js'
import { runFinishMethods } from '../src/services/run-finish.js'
import { hygieneMethods } from '../src/services/hygiene.js'
import { modelFallbackMethods } from '../src/services/model-fallback.js'
import { botQuotaMethods } from '../src/services/bot-quota.js'
import { schedulerMethods } from '../src/services/scheduler.js'
import { memoryMethods } from '../src/services/memory.js'
import { secretsMethods } from '../src/services/secrets.js'
import { proposalsMethods } from '../src/services/proposals.js'
import { terminalMethods } from '../src/services/terminal.js'
import { usageMethods } from '../src/services/usage.js'
import { systemMethods } from '../src/services/system.js'
import { wechatMethods } from '../src/services/wechat.js'
import { feishuMethods } from '../src/services/feishu.js'
import { approvalsMethods } from '../src/services/approvals.js'
import { questionsMethods } from '../src/services/questions.js'
import { coreMethods } from '../src/services/core.js'
import { githubSourceMethods } from '../src/services/github-source.js'
import { promptMethods } from '../src/services/runtime/prompt.js'
import { sessionMethods } from '../src/services/runtime/session.js'
import { trajectoryMethods } from '../src/services/runtime/trajectory.js'
import { lifecycleMethods } from '../src/services/runtime/lifecycle.js'

type TeamServiceMethods =
  & typeof botsMethods & typeof projectsMethods & typeof chatMethods
  & typeof tasksMethods & typeof taskDispatchMethods & typeof taskRunMethods & typeof taskNotifyMethods & typeof taskReviewMethods
  & typeof notifyMethods
  & typeof runsMethods & typeof runFinishMethods & typeof hygieneMethods
  & typeof modelFallbackMethods & typeof botQuotaMethods & typeof schedulerMethods & typeof memoryMethods
  & typeof secretsMethods & typeof proposalsMethods & typeof terminalMethods
  & typeof usageMethods & typeof systemMethods & typeof wechatMethods & typeof feishuMethods
  & typeof approvalsMethods & typeof questionsMethods & typeof coreMethods
  & typeof githubSourceMethods

type DshRuntimeMethods =
  & typeof promptMethods & typeof sessionMethods
  & typeof trajectoryMethods & typeof lifecycleMethods

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
// FeishuStore（src/feishu/store.js）
// ---------------------------------------------------------------------------
declare module '../src/feishu/store.js' {
  interface FeishuStore {
    db: SqlDatabase | null
    file: string
  }
}

// ---------------------------------------------------------------------------
// FeishuChannel（src/feishu/channel.js）
// ---------------------------------------------------------------------------
declare module '../src/feishu/channel.js' {
  interface FeishuChannel {
    store: FeishuStore
    config: TeamConfig
    log: DshLogger
    service: TeamService | null
    /** 'conflict'=exceed_conn_limit（1000040350，别的实例占用长连接）；'reconnecting'=断线退避中。 */
    phase: 'disabled' | 'unbound' | 'ready' | 'reconnecting' | 'conflict'
    error: string | null
    /** 传输层（进程内官方 SDK，测试注入桩）：botInfo/reply/startEvents/stop。 */
    transport: import('../src/feishu/channel.js').FeishuTransport | null
    batchWindowMs: number
    flushTimer: TimerHandle | null
    flushChain: Promise<unknown>
    /** 入站去重 LRU：(appId, message_id) -> 收到时间戳；TTL 10min、上限 1000、重连不清空。 */
    inboundSeen: Map<string, number>
    /** 连接 generation：每次（重）连接就绪 +1，旧轮次里未完成的事件处理整体丢弃。 */
    consumeGeneration: number
    consumeAbort: AbortController
    /** 群聊非 owner @bot 礼貌回应冷却表：发送者 open_id -> 上次回应时间。 */
    politeAt: Map<string, number>
    /** 同幂等键发送调用计数：send 层重试与 outbox 层重试共享 3 次总预算。 */
    sendAttempts: Map<string, number>
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
  interface DshRuntime extends DshRuntimeMethods {
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
  }
}

// ---------------------------------------------------------------------------
// TeamService（src/service.js）
// ---------------------------------------------------------------------------
declare module '../src/service.js' {
  interface TeamService extends TeamServiceMethods {
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
    feishu: FeishuChannel | null
    /** GitHub 触发源的 gh 执行钩子（B4-②/DSHBOTS-335）：生产 null=真实 gh CLI，测试注入桩。 */
    githubRunner: ((args: string[]) => Promise<string> | string) | null
    terminalActive: Map<string, unknown>
    /** index.js 里 service.initialize().then(...).catch(...) 的启动 Promise。 */
    boot: Promise<unknown> | null
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
