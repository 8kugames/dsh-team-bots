import { WechatIlinkError, chunkWechatText, filterWechatMarkdown } from '../../vendor/wechat-ilink/index.js'
import { TASK_ID_PATTERN } from '../util.js'
import {
  adminDenied, answerHelp, badTaskId, botsList, connectedReceipt, helpText, keysList,
  needPickProject, needReturnReason, noDirector, noOwner, projectNotFound, statesView,
  taskDetail, trHelp, unknownCommand,
} from './format.js'

// 信赖边界（B6/DSHBOTS-327）：微信文本只是数据——本文件只解析下方显式白名单指令
// （批/答/tr/bots/状态等固定模式），未命中指令的文本一律按群消息路由为数据；
// 写操作指令（reject/tr 与 答/批）必须过 admin-peer 门。自然语言不被解释成命令。
/** 微信答复路由：答 <token> <选项或文字>（DSHBOTS-215）。token 为提问/审批 id 末 6 位。 */
const ANSWER_PATTERN = /^(?:答|答复|回答|answer)\s+([A-Za-z0-9]{4,10})(?:\s+([\s\S]*))?$/i

/** 微信审批路由：批 <token> 允许|拒绝（DSHBOTS-215）。 */
const APPROVAL_PATTERN = /^(?:批|审批|approve)\s+([A-Za-z0-9]{4,10})\s*(允许|拒绝|allow|reject)$/i

/** 正文里的任务号候选（不要求空格分隔），再由 TASK_ID_PATTERN 校验。 */
const TASK_ID_CANDIDATE = /([a-z][a-z0-9-]*-\d+)/gi

/** /tr 格式：<key> <消息> 或 <key>: <消息>（DSHBOTS-258 容忍冒号写法），key 与项目 key 同口径。 */
const TR_PATTERN = /^([A-Za-z0-9]{1,10})(?:\s*[:：]\s*|\s+)([\s\S]+)$/

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
 * 项目外 director 通道首触回执（DSHBOTS-258）。文案本地放：format.js 不在本卡写范围，
 * 且只有这一处新文案，不强行迁移。
 */
function directorReceipt(bot) {
  return `已直达【${bot.name}】专属工作区（项目外单聊），回复会推送到微信；发「/tr <key> <消息>」可显式转发进指定项目。`
}

/**
 * 把管理员消息解析为指令并执行（DSHBOTS-249 前缀固定指令集）。
 * 拦截顺序：①以 / 开头的固定指令（D-249，/tr 是唯一显式转发进项目的通道）；
 * ②答/批 <token> 前缀（DSHBOTS-215）；③其余一切自由文本直达项目外 director
 * 专属工作区（DSHBOTS-258 三次收紧：不再有 <key>: 派单转发与绑定项目路由，用户不直接进群）。
 * 旧触发式指令（帮助/状态/验收/驳回/详情/q）已全部收编进 / 前缀指令集——触发词
 * 与无前缀对话路径冲突（任何中文首词都可能被当成指令拦截），本卡一并收口移除。
 * ctx（DSHBOTS-208，通道侧传入）：{ boundKey: 当前绑定项目 key | null,
 * bind(key): 路由成功后更新绑定, isAdmin: 发送者是否管理员（写操作 fail-closed：未显式 true 即拒） }。
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

  // DSHBOTS-258 三次收紧口径：原 <key>: <消息> 派单转发不再路由进项目——除 /tr 显式
  // 转发外，其余一切文本（含带 key 前缀的写法）一律按自由文本走 director 专属工作区。

  // DSHBOTS-208/258 任意交互：自由文本永远直达项目外 director 专属工作区（不随
  // direct_project_key 绑定或 active 项目数变化），首触回执、之后静默直达。
  const chat = await service.wechatChat(null, body)
  // 项目外 director 通道：首触回执说明去向，之后静默直达（回复由运行回程推送），
  // 不回写项目绑定（通道是项目外的）。
  if (chat?.director) {
    return chat.firstContact ? directorReceipt(chat.director) : ''
  }
  if (chat?.error === 'no_director') {
    // 导演通道异常（DSHBOTS-258）：独立出口，不触发选项目提示链。
    return noDirector()
  }
  if (!chat || chat.error === 'no_target') {
    return needPickProject(service.stateView().projects ?? [])
  }
  if (chat.error === 'no_owner') return noOwner(chat.project)
  return ''
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

  // 写操作权限门（fail-closed）：未显式 isAdmin=true 一律拒绝（只读指令不设门）。
  if (ADMIN_VERBS.has(verb) && ctx?.isAdmin !== true) return adminDenied()

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
    // DSHBOTS-299：/tr 转发一律落 director 专属工作区（携带 [项目 KEY] 上下文），
    // 总监不可用属通道异常，独立出口；no_owner 出口随项目群直达一并退役。
    if (chat.error === 'no_director') return noDirector()
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
