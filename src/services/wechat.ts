// src/services/wechat.js —— 微信通道域
// 微信扫码登录与状态查询。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { createRequire } from 'node:module'
import { AppError, conflict } from '../errors.js'
import { WechatIlinkError } from '../wechat/commands.js'
import { jsonParse, parseMentions } from '../util.js'
import { answerFailed, answerReceipt, approvalCard, questionCard, wechatToken } from '../wechat/format.js'

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

  /**
   * 微信直达对话（DSHBOTS-208，接替原派单转发 wechatDispatch）：把管理员消息以
   * 工作台用户身份插入项目群聊并触发 chat 运行（无 mention 时定向项目总监），
   * 运行结束的 bot 回复由 run-finish 按 trigger_type='wechat' 推回微信管理员。
   * 返回：显式 key 未命中 → null；无可定向目标 → { error: 'no_target' }；
   * 项目无可定向 Bot（无 mention 且总监不可用）→ { error: 'no_owner', project }；
   * 成功 → { project, messageId, runBots }。key 为空时按 fallbackKey（通道绑定）
   * 解析，仍未命中且恰有一个 active 项目时自动选中。
   */
  async wechatChat(key, body, fallbackKey = null) {
    let project = null
    if (key) {
      project = this.store.get(
        "SELECT * FROM projects WHERE key = ? COLLATE NOCASE AND status = 'active'",
        String(key ?? '').trim(),
      )
      if (!project) return null
    } else {
      const actives = this.store.all("SELECT * FROM projects WHERE status = 'active'")
      project = (fallbackKey
        ? actives.find(row => row.key.toUpperCase() === String(fallbackKey).toUpperCase())
        : null) ?? (actives.length === 1 ? actives[0] : null)
      if (!project) return { error: 'no_target' }
    }
    const members = this.membersOf(project.id).filter(bot => bot.status === 'active')
    const text = String(body ?? '')
    // 无 mention 时 sendMessage 兜底定向 owner_bot_id：总监必须可用，否则消息发出无人接。
    if (parseMentions(text, members).length === 0
      && !members.some(bot => bot.id === project.owner_bot_id)) {
      return { error: 'no_owner', project }
    }
    const result = await this.sendMessage(project.id, text, { type: 'user', id: this.localUserId }, null, [], { origin: 'wechat' })
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
  // 群聊提问/审批转发微信：只推纯文本镜像，状态仍由工作台卡片与群消息承载；
  // 管理员在微信的答复经 commands 的「答/批 <token> …」路由回原条目（见 wechatAnswerQuestion /
  // wechatDecideApproval）。转发失败只告警，不阻塞提问主流程。

  /** 提问转发微信（只推文本；token 取问题 id 末 6 位）。 */
  wechatQuestion(project, row, items) {
    if (!this.wechat || typeof this.wechat.notify !== 'function') return false
    try {
      this.wechat.notify(questionCard(project.name || project.key, row.bot_name ?? 'Bot', items, wechatToken(row.id)))
      return true
    } catch (error: any) {
      this.logger.warn?.('dsh-team: 微信提问转发失败: %s', error?.message ?? error)
      return false
    }
  },

  /** 审批转发微信（只推文本；token 取审批 id 末 6 位）。 */
  wechatApproval(project, row) {
    if (!this.wechat || typeof this.wechat.notify !== 'function') return false
    try {
      this.wechat.notify(approvalCard(project.name || project.key, row.bot_name ?? 'Bot', row.tool_name, row.reason, wechatToken(row.id)))
      return true
    } catch (error: any) {
      this.logger.warn?.('dsh-team: 微信审批转发失败: %s', error?.message ?? error)
      return false
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
