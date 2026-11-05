import { defineMethods } from './services/mixin.js'
import { promptMethods } from './services/runtime/prompt.js'
import { sessionMethods } from './services/runtime/session.js'
import { trajectoryMethods } from './services/runtime/trajectory.js'
import { lifecycleMethods } from './services/runtime/lifecycle.js'

export class DshRuntime {
  constructor({ ctx, config, store, logger = console             , mask = null }) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.logger = logger
    // 密钥掩码钩子：service 层注入，轨迹等落库内容在写入前先脱敏。
    this.mask = typeof mask === 'function' ? mask : null
    this.pending = new Map()
    this.pendingByRun = new Map()
    this.childOwner = new Map()
    this.parentHints = new Map()
    this.sessionCreates = new Map()
    this.modelsCache = { at: 0, value: [] }
    // system 区会话级冻结缓存（方案 B）：session id -> 定格的身份提示词字节。
    this.promptFreeze = new Map()
    // 尾窗增量水位（DSHBOTS-96 P1-1）：session id → 已注入到 messages/solo_messages 的
    // rowid。值随会话线性增长，条目数受会话数约束，不做 LRU。
    this.messageWatermarks = new Map()
    this.selecting = Promise.resolve()
    this.completionHandler = null
    this.attached = false
  }

  setCompletionHandler(handler) {
    this.completionHandler = handler
  }

  // 由 service 层注入密钥掩码函数。
  setMask(fn) {
    this.mask = typeof fn === 'function' ? fn : null
  }
}

// 业务域方法按域拆到 src/services/runtime/*.js，这里挂回 DshRuntime 原型：
// 对外仍是 service.method(...) 的调用方式，方法体内的 this 语义与拆分前完全一致。
defineMethods(DshRuntime.prototype, [
  promptMethods,
  sessionMethods,
  trajectoryMethods,
  lifecycleMethods,
])
