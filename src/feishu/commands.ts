// src/feishu/commands.ts —— 飞书指令接线（DSHBOTS-323 卡②）
// 复用微信 commands.ts 的通道无关层（/ 前缀指令集 + 答/批 token 回路 + 自由文本
// 直达 director）：路由语义零复制，只把自由文本的落点从微信管理员通道换到飞书
// 管理员通道（service.feishuChat，source mark 与 solo origin 均按 channel='feishu'
// 留痕）。service 未实现 feishuChat（测试桩）时原样直通微信命令层。
import { handleCommand as wechatHandleCommand } from '../wechat/commands.js'

/** 群聊非 owner @bot 的礼貌回应文案（60s 冷却，不起 turn）。 */
export const NON_OWNER_NOTICE = '抱歉，本机器人仅管理员可用，如有需要请联系管理员。'

export async function handleCommand(service, rawText, ctx = null) {
  if (!service || typeof (service as any).feishuChat !== 'function') {
    return wechatHandleCommand(service, rawText, ctx)
  }
  // 委托代理：只在本次调用里把自由文本路由换到 feishuChat，其余 service 方法
  // （stateView/答/批 token 回路等）经原型链原样复用。
  const adapter = Object.create(service)
  ;(adapter as any).wechatChat = (key, body) => (service as any).feishuChat(key, body)
  return wechatHandleCommand(adapter, rawText, ctx)
}
