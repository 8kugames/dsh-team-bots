// src/services/runtime/sandbox-policy.js —— 沙箱档位域
// 沙箱档位常量、运行类型收紧、生效档判定与文件策略应用。
// 本文件只放方法体，方法挂到 DshRuntime 原型上（见 src/runtime.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { id, nowIso } from '../../util.js'

// 与 DSH 宿主 dsh-sandbox-policy 的 SANDBOX_MODES 保持一致；库里值不合法时不向宿主写覆盖。
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

// 沙箱档位按运行类型收紧：一切非写运行（mode!=='write'，如 dm/dm_reply/chat/review 等）
// 物理降只读，越权写入由宿主沙箱层拒绝；写运行沿用 bot.file_policy；
// 无运行上下文（run 为空）时同样保持 bot.file_policy。
export function sandboxModeForRun(run, bot) {
  return run && run.mode !== 'write' ? 'read-only' : bot?.file_policy
}

// 生效沙箱档（DSHBOTS-156）：任务派发可选 sandbox 覆盖后的最终口径，run_events 与视图共用。
// - 非写运行恒 read-only（来源 run_type）：覆盖只作用于写运行，dm_reply 回投任务会话等
//   读运行不得因任务带覆盖而放宽只读；
// - 写运行取 tasks.sandbox_override（来源 override），只在不比 bot 配置档更宽时生效
//   （只收紧不放大：运行侧兜底，防旁路落库的旧覆盖在换负责人后放大权限）；
// - 其余回落 bot.file_policy（来源 bot_config）。
// 覆盖或配置档不合法（不在 SANDBOX_MODES）时不采用，落 bot_config 由 applyFilePolicy 拦截。
export function effectiveSandbox(run, bot, task) {
  if (run && run.mode !== 'write') return { mode: 'read-only', source: 'run_type' }
  const override = task?.sandbox_override
  const policyRank = SANDBOX_MODES.indexOf(bot?.file_policy)
  if (SANDBOX_MODES.includes(override) && SANDBOX_MODES.indexOf(override) <= policyRank) {
    return { mode: override, source: 'override' }
  }
  return { mode: bot?.file_policy, source: 'bot_config' }
}

export const sandboxMethods = {
  // 把收紧后的档位（effectiveSandbox）写成宿主会话的文件沙箱覆盖：等价直调宿主的
  // setSandboxMode(session, mode)，即 session.append('sandbox/mode', { mode })（插件不依赖
  // 宿主包），事件 log-only、replay 持久、下次受限调用生效。已是目标档位就不重复追加；
  // 失败只告警不阻断会话（沙箱回落宿主默认）。
  // DSHBOTS-156：带运行上下文时把生效档与来源落 run_events（type='sandbox_mode'）——
  // run_events 是运行时间线，复用会话的每条运行也各自留档，与 sandbox/mode 追加的去重无关。
  applyFilePolicy(agent, bot, run?, task?) {
    const { mode, source } = effectiveSandbox(run, bot, task)
    if (!SANDBOX_MODES.includes(mode)) return
    if (run?.id) {
      this.store.run(
        'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
        id('evt'), run.id, 'sandbox_mode', `沙箱档位 ${mode}（来源：${source}）`, nowIso(),
      )
    }
    const liveSession = agent?.agent?.session ?? agent?.session
    if (!liveSession?.append) return
    try {
      // 必须走 ctx.get()：宿主服务未在本插件 inject 声明时，直接读 ctx.sandboxPolicy
      // 会被 cordis 代理抛 "cannot get property \"sandboxPolicy\" without inject"，
      // 导致每次应用权限都失败、静默回落宿主默认档位。
      const policy = this.ctx.get?.('sandboxPolicy')
      const current = policy?.overrideOf?.(liveSession)
      if (current === mode) return
      liveSession.append('sandbox/mode', { mode })
    } catch (error: any) {
      this.logger.warn?.(`应用文件权限 ${mode} 失败（${bot?.name ?? bot?.id}）：${error?.message ?? error}`)
    }
  },
}
