import { WechatIlinkError, chunkWechatText, filterWechatMarkdown } from '../../vendor/wechat-ilink/index.js'
import { TASK_ID_PATTERN } from '../util.js'
import {
  answerHelp, badTaskId, connectedReceipt, helpText, needPickProject, needReturnReason,
  noOwner, projectList, projectNotFound, statusView, taskDetail,
} from './format.js'

/** 需要任务号的任务指令。 */
const TASK_VERBS = ['验收', '驳回', '详情']

/** 微信答复路由：答 <token> <选项或文字>（DSHBOTS-215）。token 为提问/审批 id 末 6 位。 */
const ANSWER_PATTERN = /^(?:答|答复|回答|answer)\s+([A-Za-z0-9]{4,10})(?:\s+([\s\S]*))?$/i

/** 微信审批路由：批 <token> 允许|拒绝（DSHBOTS-215）。 */
const APPROVAL_PATTERN = /^(?:批|审批|approve)\s+([A-Za-z0-9]{4,10})\s*(允许|拒绝|allow|reject)$/i

/** 正文里的任务号候选（不要求空格分隔），再由 TASK_ID_PATTERN 校验。 */
const TASK_ID_CANDIDATE = /([a-z][a-z0-9-]*-\d+)/gi

/** 派单转发格式 <key>: <消息>：key 与项目 key 同口径（字母数字、至多 10 位），全角冒号与大小写均容忍。 */
const DISPATCH_PATTERN = /^([A-Za-z0-9]{1,10})\s*[:：]\s*([\s\S]+)$/

/** 业务性错误：重试无意义（区别于网络/限流等可重试错误）。 */
export class WechatBusinessError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WechatBusinessError'
    this.permanent = true
  }
}

/**
 * 把管理员消息解析为指令并执行。service 需要提供：
 * stateView() / taskByIdentifier(identifier) / wechatReview(identifier, {decision, comment})
 * / wechatChat(key, message, fallbackKey)（直达对话：按 key（或绑定/唯一 active 项目）
 * 把消息插入项目群聊并触发总监 chat 运行，回程推送见 run-finish；service.js 接线时实现，
 * actor 为微信管理员映射的工作台用户）。
 * ctx（DSHBOTS-208，通道侧传入）：{ boundKey: 当前绑定项目 key | null,
 * bind(key): 路由成功后更新绑定 }；测试与无绑定场景可省略。
 */
export async function handleCommand(service, rawText, ctx = null) {
  const body = String(rawText ?? '').trim()
  if (!body) return helpText()
  const { verb, rest } = splitCommand(body)
  const normalized = verb.toLowerCase()

  if (normalized === '帮助' || normalized === 'help' || normalized === '?') return helpText()

  if (normalized === '状态') {
    return statusView(service.stateView().projects ?? [])
  }

  if (TASK_VERBS.includes(verb)) {
    const identifier = extractTaskId(rest)
    if (!identifier) return badTaskId()
    if (verb === '详情') {
      return taskDetail(service.taskViewByIdentifier(identifier))
    }
    const decision = verb === '验收' ? 'accept' : 'return'
    const comment = stripTaskId(rest, identifier)
    if (decision === 'return' && !comment) return needReturnReason()
    const result = await service.wechatReview(identifier, { decision, comment })
    return result
  }

  if (normalized === 'q') {
    return projectList(service.stateView().projects ?? [])
  }

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

/** 拆出指令词与其余正文：任务类指令允许「验收web-3」这种无空格写法。 */
function splitCommand(body) {
  for (const verb of TASK_VERBS) {
    if (body === verb || body.startsWith(verb)) return { verb, rest: body.slice(verb.length).trim() }
  }
  const parts = body.split(/\s+/)
  return { verb: parts[0], rest: parts.slice(1).join(' ').trim() }
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
