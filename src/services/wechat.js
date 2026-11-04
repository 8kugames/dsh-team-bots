// src/services/wechat.js —— 微信通道域
// 微信扫码登录与状态查询。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { createRequire } from 'node:module'
import { AppError, conflict } from '../errors.js'
import { WechatIlinkError } from '../wechat/commands.js'

// 微信登录二维码：服务端直接出 SVG，UI 注入即可，无需前端 QR 库（vendor/qrcode，MIT）。
// 依赖按需加载：二维码库缺失只影响扫码，不应让整个插件加载失败。
export function wechatQrSvg(url) {
  const makeQr = createRequire(import.meta.url)('../../vendor/qrcode/qrcode.js')
  const qr = makeQr(0, 'M')
  qr.addData(url)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2 })
}

/** channel.js 的状态守卫文案全集（未启用/已登录等，抛的都是裸 Error）。 */
const CHANNEL_GUARD_MESSAGES = new Set([
  '微信通道未启用（DSH_TEAM_WECHAT=1）',
  '微信通道已登录，如需换号请先退出',
  '当前没有等待验证码的授权流程',
  '验证码应为数字',
])

/**
 * 服务边界错误包装：channel.js 全部抛裸 Error，而 http.js 的 errorResponse 只认 AppError，
 * 非 AppError 一律 500「服务端处理失败」——真实原因被吞。这里统一翻译：
 * 通道状态守卫（固定文案）→ 409 conflict 原文案透传；其余视为上游（腾讯 iLink）请求失败
 * → 502（同 system.js 上游不可用口径），可读原文进响应、原始 stack 只进 logger.warn（不落凭据）。
 */
function toChannelError(service, action, error) {
  if (error instanceof AppError) return error
  const text = error instanceof WechatIlinkError
    ? `${error.code}: ${error.message}`
    : String(error?.message ?? error).trim()
  if (CHANNEL_GUARD_MESSAGES.has(text)) return conflict(text)
  service.logger.warn?.('dsh-team: wechat %s 上游请求失败: %s', action, error?.stack ?? error)
  return new AppError('WECHAT_UPSTREAM', `微信服务请求失败：${text || '未知错误'}`, 502)
}

export const wechatMethods = {

  // 微信状态会进 UI state：凭据类字段一律剥掉，只留 phase/是否登录/管理员等展示信息。
  wechatStatus() {
    const status = this.wechat?.status()
      ?? { phase: 'disabled', enabled: false, error: null, adminPeerId: null, auth: null }
    const auth = status?.auth && typeof status.auth === 'object'
      ? Object.fromEntries(Object.entries(status.auth).filter(([key]) => !/token|secret|cookie|credential/i.test(key)))
      : status?.auth ?? null
    return { ...status, auth }
  },
  async wechatBeginLogin() {
    await this.initialize()
    if (!this.wechat) throw conflict('微信通道未启用（DSH_TEAM_WECHAT=1）')
    let challenge
    try {
      challenge = await this.wechat.beginLogin()
    } catch (error) {
      throw toChannelError(this, 'beginLogin', error)
    }
    return { qrCodeUrl: challenge.qrCodeUrl, qrSvg: wechatQrSvg(challenge.qrCodeUrl) }
  },
  wechatSubmitCode(code) {
    if (!this.wechat) throw conflict('微信通道未启用（DSH_TEAM_WECHAT=1）')
    try {
      return this.wechat.submitVerificationCode(code)
    } catch (error) {
      throw toChannelError(this, 'submitCode', error)
    }
  },
  async wechatLogout() {
    if (!this.wechat) throw conflict('微信通道未启用（DSH_TEAM_WECHAT=1）')
    try {
      await this.wechat.logout()
    } catch (error) {
      throw toChannelError(this, 'logout', error)
    }
    return { phase: this.wechat.status().phase }
  },
}
