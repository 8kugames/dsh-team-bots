import { WechatIlinkError, chunkWechatText, filterWechatMarkdown } from '../../vendor/wechat-ilink/index.js'

const HELP = [
  '可用指令：',
  '  状态                概览各项目与待验收任务',
  '  验收 <任务号> [评语]  通过验收，如：验收 web-3 做得好',
  '  驳回 <任务号> <理由>  退回重做，理由必填',
  '  详情 <任务号>        查看任务卡片',
].join('\n')

const IDENTIFIER = /^[a-z]+-\d+$/i

/**
 * 把管理员消息解析为指令并执行。service 需要提供：
 * stateView() / taskByIdentifier(identifier) / wechatReview(identifier, {decision, comment})
 * （service.js 接线时实现，职责与 reviewFromBot 一致但 actor 为微信用户）。
 */
export async function handleCommand(service, rawText) {
  const body = String(rawText ?? '').trim()
  if (!body) return HELP
  const [command, ...rest] = body.split(/\s+/)
  const arg = rest.join(' ').trim()
  const normalized = command.toLowerCase()

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

  if (normalized === '验收' || normalized === '驳回' || normalized === '详情') {
    const identifier = (rest[0] ?? '').toLowerCase()
    if (!IDENTIFIER.test(identifier)) return `任务号格式不对，形如 web-3。${HELP}`
    if (normalized === '详情') {
      const view = service.taskViewByIdentifier(identifier)
      const lines = [`${identifier} [${view.status}] ${view.title}`]
      for (const comment of (view.comments ?? []).slice(-3)) {
        lines.push(`— ${comment.author_type}:${comment.author_id} ${comment.created_at}\n  ${String(comment.body).slice(0, 200)}`)
      }
      return lines.join('\n')
    }
    const decision = normalized === '验收' ? 'accept' : 'return'
    const comment = rest.slice(1).join(' ').trim()
    if (decision === 'return' && !comment) return '驳回必须带理由：驳回 web-3 理由文字。'
    const result = await service.wechatReview(identifier, { decision, comment })
    return result
  }

  return `未识别的指令。${HELP}`
}

/** 出站文本规整：过滤 markdown 噪点并按微信上限分块。 */
export function outboundChunks(text) {
  const filtered = filterWechatMarkdown(String(text ?? ''))
  return chunkWechatText(filtered)
}

export function isRetryable(error) {
  if (error instanceof WechatIlinkError) return error.retryable
  return true
}

export { WechatIlinkError }
