// src/feishu/format.ts —— 飞书出站消息排版层（markdown 文本，DSHBOTS-323 卡①）
// 角色对齐 src/wechat/format.ts：通道全部回程/回执文案在此集中格式化。
// 飞书原生支持 markdown：出站一律走交互卡片的富文本（markdown）组件——卡片里单个 \n 即换行，
// 纯文本消息的 \n 是段落间距（版面松）；加粗、列表、分割线也都原生渲染。
// 不做微信式的 markdown 噪点过滤，只负责长文分块（飞书单条文本有长度上限）与固定文案。

/** markdown 分隔线：区分消息头与正文。 */
export const RULE = '———'

/** 单块字符上限：飞书单条消息文本上限约 4096 字符，留余量按段边界切块。 */
export const CHUNK_MAX_CHARS = 4000

/** 出站文本分块：优先按空行（段落）边界切，超长段落再硬切；原文 markdown 语义保留。 */
export function outboundChunks(text, maxChars = CHUNK_MAX_CHARS) {
  const source = String(text ?? '').trim()
  if (!source) return []
  if (source.length <= maxChars) return [source]
  const chunks = []
  let buffer = ''
  for (const paragraph of source.split(/\n{2,}/)) {
    const piece = buffer ? `${buffer}\n\n${paragraph}` : paragraph
    if (piece.length <= maxChars) {
      buffer = piece
      continue
    }
    if (buffer) {
      chunks.push(buffer)
      buffer = ''
    }
    // 单段超限：按行切，行本身超限再硬切
    for (const line of paragraph.split('\n')) {
      if (!line.length) continue
      let remaining = line
      while (remaining.length > maxChars) {
        chunks.push(remaining.slice(0, maxChars))
        remaining = remaining.slice(maxChars)
      }
      if ((buffer ? `${buffer}\n${remaining}` : remaining).length <= maxChars) {
        buffer = buffer ? `${buffer}\n${remaining}` : remaining
      } else {
        chunks.push(remaining)
      }
    }
  }
  if (buffer) chunks.push(buffer)
  return chunks
}

/**
 * 提问卡片（markdown）：题头加粗、选项列表化。
 * 信息口径与微信纯文本镜像一致，但排版按 markdown 给——飞书直接渲染，不必再降成纯文本。
 */
export function questionCard(projectName, botName, items, token) {
  const lines = [`**【提问】${botName}（${projectName}）**`]
  for (const [index, item] of (items ?? []).entries()) {
    lines.push(`**Q${index + 1}: ${item.question}**`)
    if (item.detail) lines.push(item.detail)
    for (const [optionIndex, option] of (item.options ?? []).entries()) {
      const description = option.description ? ` — ${option.description}` : ''
      lines.push(`- ${optionIndex + 1}. ${option.label}${description}`)
    }
  }
  lines.push('', `回复「答 ${token} 选项号或文字」`)
  if ((items ?? []).length > 1) lines.push(`多个问题用「;」分隔，如：答 ${token} 1:选项一;2:补充说明`)
  return lines.join('\n')
}

/** 审批卡片（markdown）：与提问卡同版式。 */
export function approvalCard(projectName, botName, toolName, reason, token) {
  return [
    `**【审批】${botName}（${projectName}）**`,
    `工具：${toolName}`,
    `原因：${reason}`,
    '',
    `回复「批 ${token} 允许」或「批 ${token} 拒绝」`,
  ].join('\n')
}

/** 管理员绑定欢迎（入站另卡接线时使用）。 */
export function welcomeAdmin() {
  return '已绑定为本团队管理员\n发送 /? 查看指令'
}

/** 用户侧通用失败提示（具体错误只进日志）。 */
export function failureText() {
  return '消息处理失败，稍后重试'
}
