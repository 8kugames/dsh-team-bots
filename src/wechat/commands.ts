import { WechatIlinkError, chunkWechatText, filterWechatMarkdown } from '../../vendor/wechat-ilink/index.js'
import { TASK_ID_PATTERN } from '../util.js'
import {
  adminDenied, answerHelp, badTaskId, botsList, connectedReceipt, helpText, keysList,
  needPickProject, needReturnReason, noOwner, projectNotFound, statesView, taskDetail,
  trHelp, unknownCommand,
} from './format.js'

/** 微信答复路由：答 <token> <选项或文字>（DSHBOTS-215）。token 为提问/审批 id 末 6 位。 */
const ANSWER_PATTERN = /^(?:答|答复|回答|answer)\s+([A-Za-z0-9]{4,10})(?:\s+([\s\S]*))?$/i

/** 微信审批路由：批 <token> 允许|拒绝（DSHBOTS-215）。 */
const APPROVAL_PATTERN = /^(?:批|审批|approve)\s+([A-Za-z0-9]{4,10})\s*(允许|拒绝|allow|reject)$/i

/** 正文里的任务号候选（不要求空格分隔），再由 TASK_ID_PATTERN 校验。 */
const TASK_ID_CANDIDATE = /([a-z][a-z0-9-]*-\d+)/gi

/** 派单转发格式 <key>: <消息>：key 与项目 key 同口径（字母数字、至多 10 位），全角冒号与大小写均容忍。 */
const DISPATCH_PATTERN = /^([A-Za-z0-9]{1,10})\s*[:：]\s*([\s\S]+)$/

/** /tr 格式：<key> <消息>，key 与项目 key 同口径（字母数字、至多 10 位）。 */
const TR_PATTERN = /^([A-Za-z0-9]{1,10})\s+([\s\S]+)$/

/** 固定指令的写操作：需要 admin-peer 门（与 答/批 同口径）。 */
const ADMIN_VERBS = new Set(['reject', 'tr'])

/** 业务性错误：重试无意义（区别于网络/限流等可重试错误）。 */
export class WechatBusinessError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WechatBusinessError'
    this.permanent = true
  }
}

/**
 * 把管理员消息解析为指令并执行（DSHBOTS-249 前缀固定指令集）。
 * 拦截顺序：①以 / 开头的固定指令（本卡）；②答/批 <token> 前缀（DSHBOTS-215）；
 * ③<key>: <消息> 派单转发（DSHBOTS-183）；④其余自由文本直达项目总监（DSHBOTS-208）。
 * 旧触发式指令（帮助/状态/验收/驳回/详情/q）已全部收编进 / 前缀指令集——触发词
 * 与无前缀对话路径冲突（任何中文首词都可能被当成指令拦截），本卡一并收口移除。
 * ctx（DSHBOTS-208，通道侧传入）：{ boundKey: 当前绑定项目 key | null,
 * bind(key): 路由成功后更新绑定, isAdmin: 发送者是否管理员（默认 true 兼容旧调用） }。
 * 权限分档（DSHBOTS-249 口径②）：只读指令（/? /keys /bots /states /detail）对
 * 群成员开放；写操作（/reject /tr）走 admin-peer 门（与 答/批 同口径）——通道侧
 * 非管理员消息本就被忽略，ctx.isAdmin 供群聊场景复用同一命令层。
 */
export async function handleCommand(service, rawText, ctx = null) {
  const body = String(rawText ?? '').trim()
  if (!body) return helpText()

  // DSHBOTS-249 固定指令：/ 前缀一律不进对话链路，未知 /xxx 回简短帮助提示。
  if (body.startsWith('/')) return handleFixedCommand(service, body, ctx)

  // DSHBOTS-215 问答回路：微信答复/审批按 token 路由回对应条目，绝不进普通对话。
  // 仅在 service 实现了对应方法时拦截（测试桩未实现时按普通文本处理）。
  const approval = APPROVAL_PATTERN.exec(body)
  if (approval && typeof (service as any).wechatDecideApproval === 'function') {
    const decision = ['允许', 'allow'].includes(approval[2].toLowerCase()) ? 'allow' : 'reject'
    return (service as any).wechatDecideApproval(approval[1].toLowerCase(), decision, ctx?.boundKey ?? null)
  }
  const answer = ANSWER_PATTERN.exec(body)
  if (answer && typeof (service as any).wechatAnswerQuestion === 'function') {
    const text = String(answer[2] ?? '').trim()
    if (!text) return answerHelp()
    return (service as any).wechatAnswerQuestion(answer[1].toLowerCase(), text, ctx?.boundKey ?? null)
  }

  const dispatch = DISPATCH_PATTERN.exec(body)
  if (dispatch) {
    const key = dispatch[1].toUpperCase()
    const message = dispatch[2].trim()
    const chat = await service.wechatChat(key, message)
    if (!chat) {
      return projectNotFound(key, service.stateView().projects ?? [])
    }
    if (chat.error === 'no_owner') return noOwner(chat.project)
    ctx?.bind?.(chat.project.key)
    return connectedReceipt(chat.project, 'dispatch')
  }

  // DSHBOTS-208 任意交互：非指令文本直达当前项目的总监，不再回「未识别的指令」。
  const boundKey = ctx?.boundKey ?? null
  const chat = await service.wechatChat(null, body, boundKey)
  if (!chat || chat.error === 'no_target') {
    return needPickProject(service.stateView().projects ?? [])
  }
  if (chat.error === 'no_owner') return noOwner(chat.project)
  ctx?.bind?.(chat.project.key)
  if (boundKey === chat.project.key) {
    // 已绑定同项目：静默直达，总监回复由回程推送，不再逐条回执。
    return ''
  }
  return connectedReceipt(chat.project, 'bind')
}

/**
 * / 前缀固定指令集（DSHBOTS-249）。只读指令对群成员开放；写操作（ADMIN_VERBS）
 * 走 admin 门（与 答/批 同口径，分档依据见 handleCommand 注释）。
 * 需要的 service 方法：stateView() / wechatProjectBots(key) /
 * taskViewByIdentifier(identifier) / wechatReview(identifier, {decision, comment}) /
 * wechatChat(key, message)（同 D-208 直达）。
 */
async function handleFixedCommand(service, body, ctx) {
  const slash = /^\/([a-z?]+)(?:\s+([\s\S]*))?$/i.exec(body)
  if (!slash) return unknownCommand()
  const verb = slash[1].toLowerCase()
  const rest = String(slash[2] ?? '').trim()

  // 写操作权限门：非 admin 一律拒绝（只读指令不设门）。
  if (ADMIN_VERBS.has(verb) && ctx?.isAdmin === false) return adminDenied()

  if (verb === '?') return helpText()

  if (verb === 'keys') {
    return keysList(service.stateView().projects ?? [], ctx?.boundKey ?? null)
  }

  if (verb === 'bots') {
    const boundKey = ctx?.boundKey ?? null
    const projects = service.stateView().projects ?? []
    const target = boundKey
      ? projects.find(project => String(project.key).toUpperCase() === String(boundKey).toUpperCase())
      : (projects.length === 1 ? projects[0] : null)
    if (!target) return needPickProject(projects)
    const bots = typeof (service as any).wechatProjectBots === 'function'
      ? (service as any).wechatProjectBots(target.key)
      : []
    return botsList(bots)
  }

  if (verb === 'states') {
    return statesView(service.stateView().projects ?? [])
  }

  if (verb === 'detail') {
    const identifier = extractTaskId(rest)
    if (!identifier) return badTaskId()
    return taskDetail(service.taskViewByIdentifier(identifier))
  }

  if (verb === 'reject') {
    const identifier = extractTaskId(rest)
    if (!identifier) return badTaskId()
    const comment = stripTaskId(rest, identifier)
    if (!comment) return needReturnReason()
    return service.wechatReview(identifier, { decision: 'return', comment })
  }

  if (verb === 'tr') {
    const match = TR_PATTERN.exec(rest)
    if (!match) return trHelp()
    const key = match[1].toUpperCase()
    const message = match[2].trim()
    const chat = await service.wechatChat(key, message)
    if (!chat) return projectNotFound(key, service.stateView().projects ?? [])
    if (chat.error === 'no_owner') return noOwner(chat.project)
    ctx?.bind?.(chat.project.key)
    return connectedReceipt(chat.project, 'dispatch')
  }

  return unknownCommand()
}

/** 从正文里提取任务号（不强制空格分隔）；没有合法任务号时返回 null。 */
export function extractTaskId(text) {
  for (const match of String(text ?? '').matchAll(TASK_ID_CANDIDATE)) {
    const candidate = match[1]
    if (TASK_ID_PATTERN.test(candidate)) return candidate.toLowerCase()
  }
  return null
}

/** 去掉正文里的任务号，剩下的当评语/理由。 */
function stripTaskId(text, identifier) {
  const source = String(text ?? '')
  const index = source.toLowerCase().indexOf(identifier)
  if (index < 0) return ''
  return `${source.slice(0, index)} ${source.slice(index + identifier.length)}`.replace(/\s+/g, ' ').trim()
}

/** 出站文本规整：过滤 markdown 噪点并按微信上限分块。 */
export function outboundChunks(text) {
  const filtered = filterWechatMarkdown(String(text ?? ''))
  return chunkWechatText(filtered)
}

/** 传输/限流类错误可重试；业务错误（permanent）与明显代码错误不可重试。 */
export function isRetryable(error) {
  if (!error) return false
  if (error instanceof WechatIlinkError) return Boolean(error.retryable)
  if (error?.permanent === true) return false
  if (error instanceof SyntaxError || error instanceof RangeError || error instanceof ReferenceError) return false
  return true
}

export { WechatIlinkError }
