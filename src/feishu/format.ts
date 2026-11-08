// src/feishu/format.ts —— 飞书出站消息排版层（markdown 文本，DSHBOTS-323 卡①）
// 角色对齐 src/wechat/format.ts：通道全部回程/回执文案在此集中格式化。
// 飞书原生支持 markdown（发送走 lark-cli --markdown），不做微信式的 markdown 噪点过滤，
// 只负责长文分块（飞书单条文本有长度上限）与固定文案。

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

/** 管理员绑定欢迎（入站另卡接线时使用）。 */
export function welcomeAdmin() {
  return '已绑定为本团队管理员\n发送 /? 查看指令'
}

/** 用户侧通用失败提示（具体错误只进日志）。 */
export function failureText() {
  return '消息处理失败，稍后重试'
}
