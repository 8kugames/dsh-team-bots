import { WechatIlinkError, chunkWechatText, filterWechatMarkdown } from '../../vendor/wechat-ilink/index.js'
import { TASK_ID_PATTERN } from '../util.js'

const HELP = [
  '可用指令：',
  '  帮助 / help / ?      查看本帮助',
  '  状态                概览各项目与待验收任务',
  '  验收 <任务号> [评语]  通过验收，如：验收 web-3 做得好',
  '  驳回 <任务号> <理由>  退回重做，理由必填',
  '  详情 <任务号>        查看任务卡片',
  '  q                   列出可派单的项目 key',
  '  <key>: <消息>        转发消息到项目群聊由总监安排，如：web: 上线新版官网',
].join('\n')

/** 需要任务号的任务指令。 */
const TASK_VERBS = ['验收', '驳回', '详情']

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
 * / wechatDispatch(key, message)（派单转发：按 key 把消息插入项目群聊并触发运行，
 * 未命中返回 null；service.js 接线时实现，职责与 reviewFromBot 一致但 actor 为微信用户）。
 */
export async function handleCommand(service, rawText) {
  const body = String(rawText ?? '').trim()
  if (!body) return HELP
  const { verb, rest } = splitCommand(body)
  const normalized = verb.toLowerCase()

  if (normalized === '帮助' || normalized === 'help' || normalized === '?') return HELP

  if (normalized === '状态') {
    const state = service.stateView()
    const lines = []
    for (const project of state.projects ?? []) {
      const open = (project.tasks ?? []).filter(task => task.status !== 'done' && task.status !== 'canceled')
      if (!open.length) continue
      lines.push(`【${project.name || project.key}】`)
      for (const task of open.slice(0, 10)) {
        lines.push(`  ${project.key}-${task.number} [${task.status}] ${task.title}`)
      }
    }
    return lines.length ? lines.join('\n') : '当前没有进行中的任务。'
  }

  if (TASK_VERBS.includes(verb)) {
    const identifier = extractTaskId(rest)
    if (!identifier) return `任务号格式不对：正文里没有形如 web-3 的任务号。${HELP}`
    if (verb === '详情') {
      const view = service.taskViewByIdentifier(identifier)
      const lines = [`${identifier} [${view.status}] ${view.title}`]
      for (const comment of (view.comments ?? []).slice(-3)) {
        lines.push(`— ${comment.author_type}:${comment.author_id} ${comment.created_at}\n  ${String(comment.body).slice(0, 200)}`)
      }
      return lines.join('\n')
    }
    const decision = verb === '验收' ? 'accept' : 'return'
    const comment = stripTaskId(rest, identifier)
    if (decision === 'return' && !comment) return '驳回必须带理由：驳回 web-3 理由文字。'
    const result = await service.wechatReview(identifier, { decision, comment })
    return result
  }

  if (normalized === 'q') {
    return projectListText(service.stateView().projects ?? [])
  }

  const dispatch = DISPATCH_PATTERN.exec(body)
  if (dispatch) {
    const key = dispatch[1].toUpperCase()
    const message = dispatch[2].trim()
    const project = await service.wechatDispatch(key, message)
    if (!project) {
      return `没有找到项目 ${key}。${projectListText(service.stateView().projects ?? [])}`
    }
    return `已转发到【${project.name || project.key}】群聊，总监会安排处理。`
  }

  return `未识别的指令。${HELP}`
}

/** 拆出指令词与其余正文：任务类指令允许「验收web-3」这种无空格写法。 */
function splitCommand(body) {
  for (const verb of TASK_VERBS) {
    if (body === verb || body.startsWith(verb)) return { verb, rest: body.slice(verb.length).trim() }
  }
  const parts = body.split(/\s+/)
  return { verb: parts[0], rest: parts.slice(1).join(' ').trim() }
}

/** q 列表与派单未命中提示共用的可派单项目清单文案。 */
function projectListText(projects) {
  const list = projects ?? []
  if (!list.length) return '当前没有可派单的项目。'
  const lines = ['可派单的项目：']
  for (const project of list) {
    lines.push(`  ${project.key}${project.name && project.name !== project.key ? `  ${project.name}` : ''}`)
  }
  return lines.join('\n')
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
