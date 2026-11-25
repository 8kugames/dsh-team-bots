// src/client.js —— 浏览器半边（dsh.client 声明，由 DSH 原生 SPA 的 client cordis 加载）。
// 团队工作台（插件页）与原生界面之间没有 URL 路由可深链（原生 SPA 无 hash/query 路由），
// 跳转靠这一层桥：插件页写 localStorage 待开键 + BroadcastChannel 广播，本半边消费并调
// ctx.uiWorkspace.openSession(sessionId) 精确打开对应会话。
//
// 双通道互补：
// - 冷启动（跳转开的新标签）：SPA 起来时读本页先写好的待开键，消费后删除；
// - 热路径（原生标签已开着）：BroadcastChannel 广播直接响应；storage 事件作双保险
//   （openSession 幂等，双触发无害）。
// 环境面全部可选链守卫：apply 在宿主单测/无 uiWorkspace 服务时静默不注册。

export const name = 'dsh-team-bots-bridge'
export const inject = ['uiWorkspace']

const CHANNEL = 'dsh-team-bots'
const PENDING_KEY = 'dsh-team-bots:open-session'

export function apply(ctx) {
  const open = (sessionId) => {
    try { ctx?.uiWorkspace?.openSession?.(sessionId) } catch {}
  }
  const consumePending = () => {
    try {
      const pending = globalThis.localStorage?.getItem?.(PENDING_KEY)
      if (pending) {
        globalThis.localStorage?.removeItem?.(PENDING_KEY)
        open(pending)
      }
      return pending
    } catch { return null }
  }
  // 冷启动：SPA 本标签刚起，消费插件页留下的待开请求。
  consumePending()
  // 热路径：BroadcastChannel（同源跨标签，插件页 post）。
  try {
    const channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (event) => {
      const data = event?.data
      if (data?.type === 'open-session' && typeof data.sessionId === 'string' && data.sessionId) open(data.sessionId)
    }
    ctx?.effect?.(() => () => { try { channel.close() } catch {} }, 'dsh-team-bots: client bridge')
  } catch {}
  // storage 事件双保险：插件页写键即触发（仅其他标签收到），本标签消费后删键。
  const onStorage = (event) => {
    if (event?.key !== PENDING_KEY || event.newValue == null) return
    try { globalThis.localStorage?.removeItem?.(PENDING_KEY) } catch {}
    open(event.newValue)
  }
  globalThis.addEventListener?.('storage', onStorage)
  ctx?.effect?.(() => () => { globalThis.removeEventListener?.('storage', onStorage) }, 'dsh-team-bots: storage bridge')
}
