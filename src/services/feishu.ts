// src/services/feishu.ts —— 飞书通道域（DSHBOTS-323 卡②）
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.ts 的 defineMethods 调用），
// 方法体内的 this 与微信域（services/wechat.ts）完全同语义。

import { effectiveFeishuCredentials } from '../config.js'
import { badRequest } from '../errors.js'
import { nowIso } from '../util.js'
import { recordWechatTriggerRow } from './wechat-trigger-schema.js'

/** 项目外导演通道的正文来源标记（对齐微信 WECHAT_SOLO_SOURCE_MARK）：让 director 一眼看出该消息来自飞书管理员。 */
const FEISHU_SOLO_SOURCE_MARK = '[飞书管理员] '

// 通道页保存的飞书凭据（DSHBOTS-334）：复用项目既有敏感配置存法——secrets 表 +
// SecretBox 加密，键为 team 级 FEISHU_APP_ID / FEISHU_APP_SECRET。进 secretEntries
// 后自动过 maskSecretValues，secret 不会漏进任何转录/日志。
export const FEISHU_CRED_APP_ID = 'FEISHU_APP_ID'
export const FEISHU_CRED_APP_SECRET = 'FEISHU_APP_SECRET'

/** AppID 展示脱敏：前 8 位 + …（DSHBOTS-334 口径；不足 8 位原样）。 */
export function maskFeishuAppId(appId) {
  const raw = String(appId ?? '').trim()
  return raw.length > 8 ? `${raw.slice(0, 8)}…` : raw
}

export const feishuMethods = {

  // 飞书状态会进 UI state（system.ts 的 state 轮询直调本方法）：channel.ts 的
  // status() 不携带任何凭据类字段；这里叠加 credentials 视图（DSHBOTS-334）——
  // 只带来源与脱敏 AppID，不带 secret 明文。
  feishuStatus() {
    const base = this.feishu?.status()
      ?? { phase: 'disabled', enabled: false, error: null, appId: null, botId: null, brand: null, adminOuId: null }
    return { ...base, credentials: this.feishuCredentialView() }
  },

  /** 通道页保存的凭据对（SecretBox 解密后）；任一键缺失返回 null。 */
  feishuSavedCredentials() {
    const entries = this.secretEntries()
    const appId = entries.find(item => item.name === FEISHU_CRED_APP_ID)?.value
    const appSecret = entries.find(item => item.name === FEISHU_CRED_APP_SECRET)?.value
    return appId && appSecret ? { appId: String(appId), appSecret: String(appSecret) } : null
  },

  /** 生效凭据（DSHBOTS-334）：通道页保存 > 服务端注入（patch.yml/env）。 */
  feishuEffectiveCredentials() {
    return effectiveFeishuCredentials(this.config, () => this.feishuSavedCredentials())
  },

  /** 凭据视图（通道页用）：来源 + 脱敏 AppID，无 secret 明文。 */
  feishuCredentialView() {
    const effective = this.feishuEffectiveCredentials()
    return {
      source: effective.source,
      appIdMasked: effective.appId ? maskFeishuAppId(effective.appId) : null,
    }
  },

  /**
   * 通道页保存飞书凭据（DSHBOTS-334）：secrets 表加密落库（复用 upsertSecret 的
   * 校验/指纹/审计/缓存失效），保存即触发通道重连。响应只回凭据视图，不回 secret。
   */
  async saveFeishuCredentials({ appId, appSecret }: { appId?: string; appSecret?: string } = {}, actor = this.actor()) {
    const id = String(appId ?? '').trim()
    const secret = String(appSecret ?? '').trim()
    if (!id || !secret) throw badRequest('App ID 与 App Secret 都不能为空')
    for (const [name, value] of [[FEISHU_CRED_APP_ID, id], [FEISHU_CRED_APP_SECRET, secret]] as const) {
      await this.upsertSecret({ scope: 'team', projectId: null, name, purpose: '飞书通道凭据（通道页配置）', value }, actor)
    }
    await this.rebindFeishuChannel()
    return this.feishuStatus()
  },

  /**
   * 通道页清除飞书凭据（DSHBOTS-334）：外科删 secrets 表两行 + 审计 + 触发重连。
   * 不走 deleteSecret——那个会对全部活动项目执行运行时密钥即焚，与通道凭据无关。
   */
  async clearFeishuCredentials(actor = this.actor()) {
    const removed = []
    this.store.transaction(() => {
      for (const name of [FEISHU_CRED_APP_ID, FEISHU_CRED_APP_SECRET]) {
        const row = this.store.get("SELECT id FROM secrets WHERE scope = 'team' AND name = ?", name)
        if (!row) continue
        this.store.run('DELETE FROM secrets WHERE id = ?', row.id)
        removed.push(name)
      }
      if (removed.length > 0) {
        this.audit(actor, 'settings.update', 'settings', 'feishu_credentials', { cleared: removed })
      }
    })
    this._secretEntries = null
    await this.rebindFeishuChannel()
    return this.feishuStatus()
  },

  /**
   * 通道重连锚（DSHBOTS-334）：保存/清除凭据后调 channel.rebind()（通道内
   * stop→按新生效凭据重建传输→start 自检），不依赖宿主 HMR 重载。
   */
  async rebindFeishuChannel() {
    await this.feishu?.rebind?.()
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
