// src/wechat/format.ts —— 微信出站消息排版层（纯文本，DSHBOTS-217）
// 通道全部回程/回执文案在此集中格式化：分段、分隔线、缩进、关键标识前置。
// 只改样式不改语义（状态码、任务号、标题、指派等信息原样保留）；
// 消费点（commands / channel / run-finish / task-notify / service.wechatReview）
// 只传数据不拼文案，后续调样式只动本文件。
// 排版一律纯文本，不用 emoji（D-211 实机验收驳回口径）：状态一律写成 [状态码] 纯文字。

/** 纯文本分隔线：区分消息头与正文。 */
export const RULE = '———————————————'

/** 合批摘要的明细行数上限：超过只保留最旧 N 条原文，其余汇总。 */
export const DIGEST_DETAIL_LINES = 5

/** 帮助：固定指令一行一条，自由文本直达。 */
export function helpText() {
  return [
    '可用指令：',
    '  /?                  查看本帮助',
    '  /keys               项目 key 清单',
    '  /bots               当前项目机器人清单',
    '  /states             未验收任务清单',
    '  /detail <任务号>     任务详情',
    '  /reject <任务号> <理由>  退回重做（管理员）',
    '  /tr <key> <消息>     直达指定项目（管理员）',
    '',
    '其余消息直接发给项目外 director 的专属工作区，回复会推送到微信。',
  ].join('\n')
}

/** 未知固定指令：回一条简短可用指令提示。 */
export function unknownCommand() {
  return '没有这个指令，发送 /? 查看可用指令。'
}

/** 写操作权限不足（非管理员）。 */
export function adminDenied() {
  return '该指令仅限管理员使用。'
}

/** /tr 缺 key 或消息时的格式提示。 */
export function trHelp() {
  return '格式：/tr <key> <消息>，如：/tr web 上线新版官网。'
}

/** /keys：可选项目 key 清单；当前绑定项目标注（当前）。 */
export function keysList(projects, boundKey = null) {
  const list = projects ?? []
  if (!list.length) return '当前没有可选的项目。'
  const lines = ['项目 key：']
  for (const project of list) {
    const current = Boolean(boundKey) && String(project.key).toUpperCase() === String(boundKey).toUpperCase()
    const name = project.name && project.name !== project.key ? `  ${project.name}` : ''
    lines.push(`  ${project.key}${name}${current ? '（当前）' : ''}`)
  }
  return lines.join('\n')
}

/** /bots：当前项目机器人清单。 */
export function botsList(bots) {
  const list = bots ?? []
  if (!list.length) return '当前项目没有机器人。'
  const lines = ['当前项目机器人：']
  for (const bot of list) {
    const role = bot.member_role || bot.bot_role
    const state = bot.status && bot.status !== 'active' ? `  [${bot.status}]` : ''
    lines.push(`  ${bot.name}${role ? `  ${role}` : ''}${state}`)
  }
  return lines.join('\n')
}

/** /states：未验收（in_review）任务清单，按项目分组。 */
export function statesView(projects) {
  const lines = ['未验收的任务']
  let any = false
  for (const project of projects ?? []) {
    const pending = (project.tasks ?? []).filter(task => task.status === 'in_review')
    if (!pending.length) continue
    any = true
    lines.push(`【${project.name || project.key}】`)
    for (const task of pending.slice(0, 10)) {
      lines.push(`  ${project.key}-${task.number} [${task.status}] ${task.title}`)
    }
  }
  return any ? lines.join('\n') : '当前没有待验收的任务。'
}

/** 任务详情：卡片头 + 指派 + 最近评论（各评论空行分段，正文缩进两格）。 */
export function taskDetail(view) {
  const lines = [`${view.identifier} [${view.status}] ${view.title}`]
  lines.push(`指派 ${view.assigneeName ?? '暂未指派'}`)
  for (const comment of (view.comments ?? []).slice(-3)) {
    lines.push('', `— ${comment.author_type}:${comment.author_id} ${comment.created_at}`)
    lines.push(`  ${String(comment.body).slice(0, 200)}`)
  }
  return lines.join('\n')
}

/** 可选项目清单（q 指令与直达未命中提示共用）。 */
export function projectList(projects) {
  const list = projects ?? []
  if (!list.length) return '当前没有可选的项目。'
  const lines = ['可选的项目：']
  for (const project of list) {
    lines.push(`  ${project.key}${project.name && project.name !== project.key ? `  ${project.name}` : ''}`)
  }
  return lines.join('\n')
}

/** 直达连接回执：dispatch=/tr 显式直达项目群聊；bind=自由文本首次绑定/换项目。 */
export function connectedReceipt(project, via) {
  const name = project.name || project.key
  return via === 'dispatch'
    ? `已直达【${name}】项目群，Bot 回复会推送到微信；继续给该项目发消息仍用「/tr <key> <消息>」。`
    : `已连接【${name}】总监，直接发消息即可，回复会推送到这里；换项目用「<key>: <消息>」。`
}

/** 项目无可定向总监。 */
export function noOwner(project) {
  return `项目【${project.name || project.key}】没有可用的总监 Bot，无法直达；可在消息里 @成员名 指定接收人。`
}

/** 项目外导演通道不可达（DSHBOTS-258）：通道异常，语义与「需要用户选项目」不同。 */
export function noDirector() {
  return '导演通道暂不可用，请稍后再试或到工作台处理。'
}

/** 未选定直达项目：引导先指定一次，附项目清单。 */
export function needPickProject(projects) {
  return [
    '还没有选定直达的项目，先用「<key>: <消息>」指定一次，之后的消息就会直接发给该项目的总监。',
    projectList(projects),
  ].join('\n')
}

/** 显式 key 未命中。 */
export function projectNotFound(key, projects) {
  return `没有找到项目 ${key}。${projectList(projects)}`
}

/** 任务指令正文里没有合法任务号。 */
export function badTaskId() {
  return `任务号格式不对：正文里没有形如 web-3 的任务号。${helpText()}`
}

/** 驳回缺理由。 */
export function needReturnReason() {
  return '驳回必须带理由：驳回 web-3 理由文字。'
}

/** 验收/驳回指令回执（accept | return）。 */
export function reviewResult(identifier, title, decision) {
  return decision === 'accept'
    ? `${identifier}《${title}》已验收通过。`
    : `${identifier}《${title}》已退回重做。`
}

/** 直达对话回程推送：总监回复（或失败提示）推回管理员微信；失败用 [失败] 纯文字标头。 */
export function chatReply(botName, body, failed = false) {
  return `${failed ? '[失败] ' : ''}${botName}\n${RULE}\n${body}`
}

/** 提问/审批的微信短 token：取 id 末 6 位（库内唯一性由项目绑定 + pending 收敛）。 */
export function wechatToken(rowId) {
  return String(rowId ?? '').slice(-6).toLowerCase()
}

/**
 * 提问转发微信（DSHBOTS-215）：群聊提问卡片的微信镜像。
 * 带短 token 与回复格式，管理员的答复经 commands 的「答 <token> …」路由回原问题。
 * 微信出站一律纯文本、不用 emoji（D-211 实机验收驳回口径，重做卡 D-217）。
 */
export function questionCard(projectName, botName, items, token) {
  const lines = [`【提问】${botName}（${projectName}）`, RULE]
  for (const [index, item] of (items ?? []).entries()) {
    lines.push(`Q${index + 1}: ${item.question}`)
    if (item.detail) lines.push(`  ${item.detail}`)
    if (Array.isArray(item.options) && item.options.length > 0) {
      lines.push(`  选项: ${item.options.map((option, i) => `${i + 1}.${option.label}`).join(' / ')}`)
    }
  }
  lines.push('', `回复「答 ${token} <选项或文字>」`)
  if ((items ?? []).length > 1) lines.push(`多个问题用「;」分隔，如：答 ${token} 1:选项一;2:补充说明`)
  return lines.join('\n')
}

/** 审批转发微信（DSHBOTS-215）：审批卡片的微信镜像，允许/拒绝经「批 <token> …」路由回原审批。 */
export function approvalCard(projectName, botName, toolName, reason, token) {
  return [
    `【审批】${botName}（${projectName}）`,
    RULE,
    `工具: ${toolName}`,
    `原因: ${reason}`,
    '',
    `回复「批 ${token} 允许」或「批 ${token} 拒绝」`,
  ].join('\n')
}

/** 答复/审批路由成功回执。 */
export function answerReceipt(token, summary) {
  return `已收到答复（${token}）\n${summary}`
}

/** 答复/审批路由失败提示（token 未命中、选项无法解析等）。 */
export function answerFailed(token, reason) {
  return `答复无法提交（${token}）：${reason}`
}

/** 答复缺少正文。 */
export function answerHelp() {
  return '请按格式答复：答 <token> <选项或文字>；多个问题用「;」分隔，如：答 abc123 1:选项一;2:补充说明。'
}

/** 任务创建推送：任务号前置，指派与详情入口逐行列出。 */
export function taskCreated(identifier, title, assignee) {
  return [
    `${identifier}《${title}》已创建`,
    `指派 ${assignee || '暂未指派'}`,
    `发送 /detail ${identifier} 查看`,
  ].join('\n')
}

/** 任务完成推送。 */
export function taskDone(identifier, title) {
  return [
    `${identifier}《${title}》已完成`,
    `发送 /detail ${identifier} 查看`,
  ].join('\n')
}

/** 合批摘要：总条数头 + 分隔线 + 明细原文（每条自带标识与状态），超上限截断汇总。 */
export function batchDigest(items) {
  const shown = items.slice(0, DIGEST_DETAIL_LINES)
  const rest = items.length - shown.length
  const lines = [`任务动态 ${items.length} 条`, RULE, ...shown.map(item => item.text)]
  if (rest > 0) lines.push(`其余 ${rest} 项`)
  return lines.join('\n')
}

/** 管理员绑定欢迎。 */
export function welcomeAdmin() {
  return '已绑定为本团队管理员\n发送 /? 查看指令'
}

/** 用户侧通用失败提示（具体错误只进日志）。 */
export function failureText() {
  return '消息处理失败，稍后重试'
}
