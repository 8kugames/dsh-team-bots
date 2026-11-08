// src/services/feishu.ts —— 飞书通道域（DSHBOTS-323 卡②）
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.ts 的 defineMethods 调用），
// 方法体内的 this 与微信域（services/wechat.ts）完全同语义。

import { nowIso } from '../util.js'
import { recordWechatTriggerRow } from './wechat-trigger-schema.js'

/** 项目外导演通道的正文来源标记（对齐微信 WECHAT_SOLO_SOURCE_MARK）：让 director 一眼看出该消息来自飞书管理员。 */
const FEISHU_SOLO_SOURCE_MARK = '[飞书管理员] '

export const feishuMethods = {

  // 飞书状态会进 UI state：channel.ts 的 status() 本就不携带任何凭据类字段。
  feishuStatus() {
    return this.feishu?.status()
      ?? { phase: 'disabled', enabled: false, error: null, appId: null, botId: null, brand: null, adminOuId: null }
  },

  /**
   * 入站 Trigger 留痕（对齐微信 B4-① 观测面，channel='feishu'）：复用 wechat_inbound
   * 表结构（disposition/route/reason 语义同款），稳定 id 前缀 feishu: 与微信留痕同表
   * 不同键空间，peer_id 记 lane 编码（g/{chatId}[/{threadId}] 或 p2p open_id）。
   */
  recordFeishuTrigger({ nativeId, senderId = null, text = '', disposition, route = null, reason = null }) {
    if (!nativeId) return 'skipped'
    return recordWechatTriggerRow(this.store, {
      id: `feishu:${nativeId}`,
      received_at: nowIso(),
      peer_id: senderId ?? '',
      disposition,
      route,
      reason,
      preview: String(text ?? ''),
    })
  },

  /**
   * 项目外导演通道的目标解析（与微信 wechatDirectorBot 同规则）：active bot 里
   * name='director'（大小写不敏感）优先于 role='director'/'总监'；同级多个按
   * created_at、id 取最旧。0 命中返回 null（异常状态防御）。
   */
  feishuDirectorBot() {
    const rows = this.store.all(
      `SELECT * FROM bots
       WHERE status = 'active' AND (lower(name) = 'director' OR role IN ('director', '总监'))
       ORDER BY CASE WHEN lower(name) = 'director' THEN 0 ELSE 1 END, created_at, id`,
    )
    return rows[0] ?? null
  },

  /** 飞书自由文本落 director 专属工作区（与 wechatDirectorChat 同链路，origin='feishu'）。 */
  async feishuDirectorChat(director, body) {
    const adminOuId = this.feishu?.status?.()?.adminOuId ?? null
    const actor = { type: 'user', id: adminOuId ?? 'user:feishu' }
    const firstContact = !this.store.get(
      "SELECT id FROM solo_messages WHERE bot_id = ? AND sender_type = 'user' AND sender_id = ? LIMIT 1",
      director.id,
      actor.id,
    )
    const result = await this.sendSoloMessage(
      director.id,
      `${FEISHU_SOLO_SOURCE_MARK}${body}`,
      actor,
      [],
      { origin: 'feishu' },
    )
    return { director, messageId: result?.messageId ?? null, firstContact }
  },

  /**
   * 飞书直达对话（与微信 wechatChat 同口径）：自由文本与 /tr <key> 显式转发都落
   * director 专属工作区（origin='feishu'，正文带 [飞书管理员] 来源标记）；key 未命中
   * 返回 null；解析不到 director 返回 { error: 'no_director' }。
   */
  async feishuChat(key, body) {
    let project = null
    if (key) {
      project = this.store.get(
        "SELECT * FROM projects WHERE key = ? COLLATE NOCASE AND status = 'active'",
        String(key ?? '').trim(),
      )
      if (!project) return null
    }
    const director = this.feishuDirectorBot()
    if (!director) return { error: 'no_director', ...(project ? { project } : {}) }
    if (!project) return this.feishuDirectorChat(director, String(body ?? ''))
    const adminOuId = this.feishu?.status?.()?.adminOuId ?? null
    const result = await this.sendSoloMessage(
      director.id,
      `${FEISHU_SOLO_SOURCE_MARK}[项目 ${project.key}] ${String(body ?? '')}`,
      { type: 'user', id: adminOuId ?? 'user:feishu' },
      [],
      { origin: 'feishu' },
    )
    return { project, director, messageId: result?.messageId ?? null }
  },
}
