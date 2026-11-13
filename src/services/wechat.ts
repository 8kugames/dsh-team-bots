// src/services/wechat.js —— 微信通道域
// 微信扫码登录与状态查询。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { createRequire } from 'node:module'
import { effectiveWechatEnabled } from '../config.js'
import { AppError, conflict } from '../errors.js'
import { WechatIlinkError } from '../wechat/commands.js'
import { jsonParse, nowIso, parseMentions } from '../util.js'
import { answerFailed, answerReceipt, approvalCard, questionCard, wechatToken } from '../wechat/format.js'
import { recordWechatTriggerRow } from './wechat-trigger-schema.js'

// 微信登录二维码：服务端直接出 SVG，UI 注入即可，无需前端 QR 库（vendor/qrcode，MIT）。
// 依赖按需加载：二维码库缺失只影响扫码，不应让整个插件加载失败。
export function wechatQrSvg(url) {
  const makeQr = createRequire(import.meta.url)('../../vendor/qrcode/qrcode.js')
  const qr = makeQr(0, 'M')
  qr.addData(url)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2 })
}

/** 项目外导演通道的正文来源标记（DSHBOTS-258）：让 director 一眼看出该消息来自微信管理员。 */
const WECHAT_SOLO_SOURCE_MARK = '[微信管理员] '

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

  /** 微信通道生效开关（DSHBOTS-334）：通道页 settings 显式值 > patch.yml/env 默认。 */
  wechatChannelEnabled() {
    return effectiveWechatEnabled(this.config, key => this.store.setting(key))
  },

  /**
   * 通道页启停开关（DSHBOTS-334）：settings 落 '1'/'0' + 审计 + 即时对齐挂载态。
   * 停用即停推（this.wechat 置 null，channelNotify 不再扇出到微信）；启用按既有
   * 绑定凭据恢复连接（绑定持久在 wechat-channel.sqlite，stop 不清凭据）。
   */
  async setWechatChannelEnabled(enabled, actor = this.actor()) {
    this.store.setSetting('wechat_channel_enabled', enabled ? '1' : '0')
    this.audit(actor, 'settings.update', 'settings', 'wechat_channel', { enabled: Boolean(enabled) })
    await this.applyWechatChannelEnabled()
    return this.wechatStatus()
  },

  /** 按生效开关即时对齐通道挂载：关=断开卸载；开=挂载并按既有绑定连接。 */
  async applyWechatChannelEnabled() {
    if (!this.wechatChannelEnabled()) {
      if (!this.wechat) return
      const channel = this.wechat
      this.wechat = null
      try {
        await channel.stop()
      } catch (error: any) {
        this.logger.warn?.(`[wechat] 通道停用清理失败: ${error?.message ?? error}`)
      }
      return
    }
    if (this.wechat) return
    const { WechatStore } = await import('../wechat/store.js')
    const { WechatChannel } = await import('../wechat/channel.js')
    this._wechatStore ??= await new WechatStore(this.config.wechatDbPath).open()
    const channel = new WechatChannel({
      store: this._wechatStore,
      // 挂载决策已由生效开关做出，通道内 enabled() 门禁按挂载口径放行。
      config: { ...this.config, wechat: { ...this.config.wechat, enabled: true } },
      log: this.logger,
    })
    channel.setService(this)
    this.wechat = channel
    await channel.start().catch(error => {
      this.logger.warn?.(`[wechat] 通道启动失败: ${error?.message ?? error}`)
    })
  },

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

  /**
   * 项目外导演通道的目标解析（DSHBOTS-258）：微信自由文本的默认且唯一去向是 director
   * bot 的专属工作区单聊。解析规则：active bot 里 name='director'（大小写不敏感）优先于
   * role='director'/'总监'；同级多个按 created_at、id 取最旧，保证确定性。不过滤 solo_dir：
   * 目录一律读 bots.solo_dir 既有链路，为空时按 soloPromptFor 现有兜底路径处理，不写死目录。
   * 0 命中返回 null（异常状态防御，走次级回退避免消息黑洞）。
   */
  wechatDirectorBot() {
    const rows = this.store.all(
      `SELECT * FROM bots
       WHERE status = 'active' AND (lower(name) = 'director' OR role IN ('director', '总监'))
       ORDER BY CASE WHEN lower(name) = 'director' THEN 0 ELSE 1 END, created_at, id`,
    )
    return rows[0] ?? null
  },

  /**
   * 项目外导演通道投递（DSHBOTS-258）：消息落 director 的 solo_messages 并触发
   * solo_chat 运行，不进任何项目群聊。身份用微信 admin 的 peer id（不以 localUserId
   * 冒充工作台用户）；正文前缀 [微信管理员] 让 director 能看出消息来自微信通道。
   * firstContact：该管理员此前没在这个专属工作区说过话（首触回执依据，见 commands）。
   */
  async wechatDirectorChat(director, body) {
    const adminPeerId = this.wechat?.status?.()?.adminPeerId ?? null
    const actor = { type: 'user', id: adminPeerId ?? 'user:wechat' }
    const firstContact = !this.store.get(
      "SELECT id FROM solo_messages WHERE bot_id = ? AND sender_type = 'user' AND sender_id = ? LIMIT 1",
      director.id,
      actor.id,
    )
    const result = await this.sendSoloMessage(
      director.id,
      `${WECHAT_SOLO_SOURCE_MARK}${body}`,
      actor,
      [],
      { origin: 'wechat' },
    )
    return { director, messageId: result?.messageId ?? null, firstContact }
  },

  /**
   * 微信直达对话（DSHBOTS-208 起，258/299 演进后现为二值路由）：
   * 自由文本（key 为空）一律落 director 专属工作区 solo 会话（用户↔director 直接
   * 通信，solo_chat 运行 trigger_type='wechat'，回复经 run-finish 推回微信管理员）；
   * /tr <key> 显式转发（key 非空）直达指定项目群聊——消息以微信管理员身份（admin
   * peer id，不冒充工作台用户）插入项目群聊并触发 chat 运行（origin='wechat' →
   * trigger_type='wechat'，运行收尾把 bot 回复推回微信管理员）。正文可 @成员 定向；
   * 无 @ 时 sendMessage 兜底定向 owner_bot_id，owner 不可用则拒投（no_owner）；
   * key 未命中 → null；自由文本解析不到 director（通道异常）→ { error: 'no_director' }。
   */
  async wechatChat(key, body) {
    let project = null
    if (key) {
      project = this.store.get(
        "SELECT * FROM projects WHERE key = ? COLLATE NOCASE AND status = 'active'",
        String(key ?? '').trim(),
      )
      if (!project) return null
    } else {
      // DSHBOTS-258 绝对口径：自由文本永远走 director 专属工作区，用户不直接进群。
      const director = this.wechatDirectorBot()
      if (director) return this.wechatDirectorChat(director, String(body ?? ''))
      return { error: 'no_director' }
    }
    // /tr 显式直达项目群聊：正文原样进群（保留 @mention 语义），无 @ 且总监不可用时
    // 拒投，不让消息落库却无人接。
    const members = this.membersOf(project.id).filter(bot => bot.status === 'active')
    const textBody = String(body ?? '')
    if (parseMentions(textBody, members).length === 0
      && !members.some(bot => bot.id === project.owner_bot_id)) {
      return { error: 'no_owner', project }
    }
    const adminPeerId = this.wechat?.status?.()?.adminPeerId ?? null
    const result = await this.sendMessage(
      project.id,
      textBody,
      { type: 'user', id: adminPeerId ?? 'user:wechat' },
      null,
      [],
      { origin: 'wechat' },
    )
    return { project, ...result }
  },

  /**
   * 微信 /bots 指令（DSHBOTS-249）：按项目 key 列当前项目机器人清单。
   * 数据源与工作台项目成员表同源（membersOf），只读；key 未命中返回空表。
   */
  wechatProjectBots(key) {
    const project = this.store.get(
      "SELECT * FROM projects WHERE key = ? COLLATE NOCASE AND status = 'active'",
      String(key ?? '').trim(),
    )
    if (!project) return []
    return this.membersOf(project.id)
  },

  // ===== DSHBOTS-215：微信问答回路 =====
  // 群聊提问/审批转发外部通道：只推纯文本镜像，状态仍由工作台卡片与群消息承载；
  // 管理员在微信的答复经 commands 的「答/批 <token> …」路由回原条目（见 wechatAnswerQuestion /
  // wechatDecideApproval）。转发失败只告警，不阻塞提问主流程。
  // DSHBOTS-326：转发面从「微信单通道」扩为「各已启用通道」（微信/飞书），单通道失败不阻断另一通道。

  /** 提问转发各已启用通道（只推文本；token 取问题 id 末 6 位）。
   *  幂等收据键（A3/DSHBOTS-323）：question:<row.id>——同条目重复转发在各通道存留期内被吸收
   *  （各通道 outbox 库彼此独立，同键在两套库里各自幂等，互不干扰）。
   *  DSHBOTS-326：出站经 channelNotify 扇出到微信与飞书，单通道失败不阻断另一通道。 */
  wechatQuestion(project, row, items) {
    const results = this.channelNotify?.(
      questionCard(project.name || project.key, row.bot_name ?? 'Bot', items, wechatToken(row.id)),
      { receiptKey: `question:${row.id}` },
    ) ?? []
    return results.some(result => result.ok)
  },

  /** 审批转发各已启用通道（只推文本；token 取审批 id 末 6 位）。
   *  幂等收据键（A3/DSHBOTS-323）：approval:<row.id>（各通道 outbox 库内各自幂等）。
   *  DSHBOTS-326：出站经 channelNotify 扇出，单通道失败只留痕不阻断另一通道。 */
  wechatApproval(project, row) {
    const results = this.channelNotify?.(
      approvalCard(project.name || project.key, row.bot_name ?? 'Bot', row.tool_name, row.reason, wechatToken(row.id)),
      { receiptKey: `approval:${row.id}` },
    ) ?? []
    return results.some(result => result.ok)
  },

  /**
   * 外发收据视图（A3/DSHBOTS-323）：近 N 条带键推送的终态流水，可追责/可回放。
   * 真值唯一来源是通道出站库（wechat-channel.sqlite，随备份走）：sent=sent_at 在、
   * gone=gave_up_at 在（last_error 带废弃原因）、pending=两者皆无。
   * 通道未启用返回 available:false——「为什么没收到」在该态由通道页与 needsAttention 解释，
   * 不在插件库建第二张收据表（反双真值）。
   */
  notifyReceiptsView(limit = 50) {
    if (!this.wechat || typeof this.wechat.receipts !== 'function') {
      return { available: false, reason: 'wechat-disabled', items: [] }
    }
    const items = this.wechat.receipts(limit).map(row => ({
      receiptKey: row.receipt_key,
      state: row.sent_at ? 'sent' : row.gave_up_at ? 'gone' : 'pending',
      attempts: Number(row.attempts ?? 0),
      lastError: row.last_error ?? null,
      createdAt: row.created_at,
      sentAt: row.sent_at ?? null,
      gaveUpAt: row.gave_up_at ?? null,
    }))
    return { available: true, reason: null, items }
  },

  /**
   * 入站 Trigger 留痕（B4-①/DSHBOTS-328）：通道每条入站事件的处置记录——handled/
   * filtered/rejected + route + reason，回答「这条微信为什么没有触发」。稳定 id 去重
   * （native 主键），滚动封顶在 wechat-trigger-schema。读入（Trigger）与写出（notify
   * 收据）两侧各自留痕、互不混表。
   */
  recordWechatTrigger({ nativeId, peerId, text, disposition, route = null, reason = null }) {
    if (!nativeId) return 'skipped'
    return recordWechatTriggerRow(this.store, {
      id: `wechat:${nativeId}`,
      received_at: nowIso(),
      peer_id: peerId,
      disposition,
      route,
      reason,
      preview: String(text ?? ''),
    })
  },

  wechatTriggersView(limit = 50) {
    const rows = this.store.all(
      'SELECT id, received_at, peer_id, disposition, route, reason, preview FROM wechat_inbound ORDER BY received_at DESC LIMIT ?',
      Math.max(1, Math.min(200, Number(limit) || 50)),
    )
    return {
      count: rows.length,
      items: rows.map(row => ({
        id: row.id,
        receivedAt: row.received_at,
        peerId: row.peer_id,
        disposition: row.disposition,
        route: row.route,
        reason: row.reason,
        preview: row.preview,
      })),
    }
  },

  /** 按 token + 绑定项目定位 pending 条目（questions / approvals 共用）。 */
  pendingWechatRow(table, token, fallbackKey = null) {
    const rows = this.store.all(
      `SELECT ${table}.*, p.key AS project_key FROM ${table}
       LEFT JOIN projects p ON p.id = ${table}.project_id
       WHERE ${table}.status = 'pending' AND lower(substr(${table}.id, -6)) = ?`,
      String(token ?? '').toLowerCase(),
    )
    if (!rows.length) return null
    if (fallbackKey) {
      const key = String(fallbackKey).toUpperCase()
      return rows.find(row => String(row.project_key ?? '').toUpperCase() === key) ?? null
    }
    return rows[0]
  },

  /**
   * 微信答复路由（DSHBOTS-215）：把管理员的「答 <token> <内容>」落成对应提问的宿主应答。
   * 来源标识为 user:wechat，与工作台作答（user:<actorId>）区分，审计单独记 question.answer_wechat。
   */
  async wechatAnswerQuestion(token, body, fallbackKey = null) {
    const row = this.pendingWechatRow('questions', token, fallbackKey)
    if (!row) return answerFailed(token, '没有匹配的待答提问（可能已作答或已过期）')
    const items = jsonParse(row.questions, [])
    const parsed = parseWechatAnswers(items, body)
    if (parsed.error) return answerFailed(token, parsed.error)
    this.settleQuestion(row.id, 'answered', { answers: parsed.answers }, 'user:wechat')
    this.audit({ type: 'user', id: 'user_wechat' }, 'question.answer_wechat', 'question', row.id, {
      token,
      answers: parsed.answers,
    })
    return answerReceipt(wechatToken(row.id), parsed.summary)
  },

  /** 微信审批路由（DSHBOTS-215）：把「批 <token> 允许|拒绝」落成对应审批的宿主应答。 */
  async wechatDecideApproval(token, decision, fallbackKey = null) {
    const row = this.pendingWechatRow('approvals', token, fallbackKey)
    if (!row) return answerFailed(token, '没有匹配的待审批请求（可能已处理或已过期）')
    if (!['allow', 'reject'].includes(decision)) return answerFailed(token, '只能回复「允许」或「拒绝」')
    this.settleApproval(
      row.id,
      decision === 'allow' ? 'allowed' : 'rejected',
      decision === 'allow' ? 'allowed-once' : 'rejected',
      'user:wechat',
    )
    this.audit({ type: 'user', id: 'user_wechat' }, `approval.${decision}_wechat`, 'approval', row.id, {
      token,
      toolName: row.tool_name,
    })
    return answerReceipt(wechatToken(row.id), `${row.tool_name} 已${decision === 'allow' ? '允许' : '拒绝'}`)
  },
}

/** 选项匹配：序号（1 起）或选项文字精确命中（大小写不敏感）。 */
function matchWechatOptions(options, raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return []
  const numeric = /^(\d+)$/.exec(value)
  if (numeric) {
    const index = Number(numeric[1])
    return index >= 1 && index <= options.length ? [options[index - 1].label] : []
  }
  const hit = options.find(option => String(option.label ?? '').trim().toLowerCase() === value)
  return hit ? [hit.label] : []
}

/**
 * 微信答复解析：支持「1:选项一;2:补充说明」的按题作答，也支持单题直接回选项/文字。
 * 带序前缀的段按序号指派，其余段按顺序补到未指派题；选项题必须命中选项，否则整单拒绝。
 */
function parseWechatAnswers(items, body) {
  if (!Array.isArray(items) || items.length === 0) return { error: '提问内容缺失' }
  const segments = String(body ?? '').split(/[;；]/).map(segment => segment.trim()).filter(Boolean)
  const assigned = new Map()
  const rest = []
  for (const segment of segments) {
    const indexed = /^(\d+)\s*[:：]\s*([\s\S]*)$/.exec(segment)
    if (indexed && Number(indexed[1]) >= 1 && Number(indexed[1]) <= items.length) {
      assigned.set(Number(indexed[1]) - 1, indexed[2].trim())
    } else {
      rest.push(segment)
    }
  }
  let cursor = 0
  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue
    if (rest.length === 0) break
    if (rest.length === 1 && items.length === 1) {
      assigned.set(i, rest[0])
      continue
    }
    if (cursor < rest.length) assigned.set(i, rest[cursor++])
  }
  const answers = []
  const parts = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const raw = String(assigned.get(i) ?? '').trim()
    const options = Array.isArray(item.options) ? item.options : []
    if (options.length > 0) {
      const selected = matchWechatOptions(options, raw)
      if (selected.length === 0) return { error: `Q${i + 1} 无法解析，请回复选项文字或序号（如 1）` }
      answers.push({ id: String(item.id), selected })
      parts.push(`Q${i + 1}: ${selected.join('、')}`)
    } else {
      answers.push({ id: String(item.id), selected: [], ...(raw ? { custom: raw } : {}) })
      parts.push(`Q${i + 1}: ${raw || '(未填)'}`)
    }
  }
  return { answers, summary: parts.join('\n') }
}
