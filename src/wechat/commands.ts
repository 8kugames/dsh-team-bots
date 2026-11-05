import { WechatIlinkError, chunkWechatText, filterWechatMarkdown } from '../../vendor/wechat-ilink/index.js'
import { TASK_ID_PATTERN } from '../util.js'

const HELP = [
  '可用指令：',
  '  帮助 / help / ?      查看本帮助',
  '  状态                概览各项目与待验收任务',
  '  验收 <任务号> [评语]  通过验收，如：验收 web-3 做得好',
  '  驳回 <任务号> <理由>  退回重做，理由必填',
  '  详情 <任务号>        查看任务卡片',
  '  q                   列出项目 key',
  '  <key>: <消息>        指定项目并直达其总监，如：web: 上线新版官网',
  '',
  '其余任意消息直接发给当前项目的总监，回复会推送到微信。',
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
 * / wechatChat(key, message, fallbackKey)（直达对话：按 key（或绑定/唯一 active 项目）
 * 把消息插入项目群聊并触发总监 chat 运行，回程推送见 run-finish；service.js 接线时实现，
 * actor 为微信管理员映射的工作台用户）。
 * ctx（DSHBOTS-208，通道侧传入）：{ boundKey: 当前绑定项目 key | null,
 * bind(key): 路由成功后更新绑定 }；测试与无绑定场景可省略。
 */
export async function handleCommand(service, rawText, ctx = null) {
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
    const chat = await service.wechatChat(key, message)
    if (!chat) {
      return `没有找到项目 ${key}。${projectListText(service.stateView().projects ?? [])}`
    }
    if (chat.error === 'no_owner') return noOwnerText(chat.project)
    ctx?.bind?.(chat.project.key)
    return `已直达【${chat.project.name || chat.project.key}】总监，之后的回复会推送到微信；直接发消息即可继续对话。`
  }

  // DSHBOTS-208 任意交互：非指令文本直达当前项目的总监，不再回「未识别的指令」。
  const boundKey = ctx?.boundKey ?? null
  const chat = await service.wechatChat(null, body, boundKey)
  if (!chat || chat.error === 'no_target') {
    return [
      '还没有选定直达的项目，先用「<key>: <消息>」指定一次，之后的消息就会直接发给该项目的总监。',
      projectListText(service.stateView().projects ?? []),
    ].join('\n')
  }
  if (chat.error === 'no_owner') return noOwnerText(chat.project)
  ctx?.bind?.(chat.project.key)
  if (boundKey === chat.project.key) {
    // 已绑定同项目：静默直达，总监回复由回程推送，不再逐条回执。
    return ''
  }
  return `已连接【${chat.project.name || chat.project.key}】总监，直接发消息即可，回复会推送到这里；换项目用「<key>: <消息>」。`
}

/** 项目无可用总监（且消息无 @mention）时的可读提示。 */
function noOwnerText(project) {
  return `项目【${project.name || project.key}】没有可用的总监 Bot，无法直达。`
}

/** 拆出指令词与其余正文：任务类指令允许「验收web-3」这种无空格写法。 */
function splitCommand(body) {
  for (const verb of TASK_VERBS) {
    if (body === verb || body.startsWith(verb)) return { verb, rest: body.slice(verb.length).trim() }
  }
  const parts = body.split(/\s+/)
  return { verb: parts[0], rest: parts.slice(1).join(' ').trim() }
}

/** q 列表与直达未命中提示共用的可选项目清单文案。 */
function projectListText(projects) {
  const list = projects ?? []
  if (!list.length) return '当前没有可选的项目。'
  const lines = ['可选的项目：']
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
