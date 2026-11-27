import { defineMethods } from './services/mixin.js'
import { applyRuntimeSettingOverrides } from './config.js'
import { promptMethods } from './services/runtime/prompt.js'
import { sessionMethods } from './services/runtime/session.js'
import { trajectoryMethods } from './services/runtime/trajectory.js'
import { lifecycleMethods } from './services/runtime/lifecycle.js'

export class DshRuntime {
  // 聊天分库路由器：{ forRun(run) -> 聊天库 Store }，由 index 注入。
  chatStores: any = null
  // 任务卡驱动 run 的启动上下文清单（run id → manifest），见 runtime/prompt.ts 的 taskCardContext。
  contextManifests: Map<string, any> = null
  // 各 agent 上已对团队 bot 隐藏的宿主集成工具名（见 tools.ts 的 applyBotToolPolicy）。
  toolDenials: WeakMap<object, Set<string>> = null

  constructor({ ctx, config, store, logger = console as DshLogger, mask = null, chatStores = null }) {
    this.ctx = ctx
    // config 存活覆盖视图（与 TeamService 同款）：workerPreset/routerPreset 等
    // 运行参数经全局设置改值后，下一次会话创建即用新值，无需重启。
    this.baseConfig = config
    this.configCache = null
    this.configCacheRev = -1
    Object.defineProperty(this, 'config', {
      get() {
        const rev = Number(this.store?.setting?.('settings_revision', '0')) || 0
        if (this.configCache && this.configCacheRev === rev) return this.configCache
        this.configCache = applyRuntimeSettingOverrides(this.baseConfig, key => this.store?.setting(key))
        this.configCacheRev = rev
        return this.configCache
      },
      configurable: true,
    })
    this.store = store
    this.logger = logger
    // 聊天分库路由：service 注入 { forRun(run) -> 聊天库 Store }。
    // 未注入（独立构造/测试桩）时一律回落顶库。
    this.chatStores = chatStores
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
    // 尾窗增量水位：session id → 已注入到 messages/solo_messages 的
    // rowid。值随会话线性增长，条目数受会话数约束，不做 LRU。
    this.messageWatermarks = new Map()
    // 任务卡驱动 run 的启动上下文清单（run id → manifest）：promptFor 暂存，startRun 取走落 run_events。
    this.contextManifests = new Map()
    this.toolDenials = new WeakMap()
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

  // 聊天分库路由：按运行归属取正文库（群聊库/单聊库）。
  // 未注入解析器（测试桩/独立构造）时回落顶库。
  chatStoreForRun(run) {
    return this.chatStores?.forRun?.(run) ?? this.store
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
