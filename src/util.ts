import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const nowIso = () => new Date().toISOString()

/** 任务号 <项目key>-<序号>：与 service.resolveTaskByIdentifier 同一口径。 */
export const TASK_ID_PATTERN = /^([a-z][a-z0-9_-]*)-(\d+)$/i

/** 项目 key 形态：字母开头，_ 和 - 只能夹在字母数字之间（不相邻、不收尾），最多 10 位。 */
export const PROJECT_KEY_PATTERN = /^[A-Z](?:[A-Z0-9]|(?:_|-)(?=[A-Z0-9])){0,9}$/

export const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 24)}`

export const slugify = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48)

export const projectKey = (value) => String(value ?? '')
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9_-]+/g, '')
  .slice(0, 10)

export const text = (value, max = 20_000) => String(value ?? '').trim().slice(0, max)

/**
 * 去 CR：CRLF 归一为 LF，其余孤立 CR 直接丢弃。
 * 模型工具入参偶发把空格写成 CR（U+000D）——渲染器按行尾处理，一句话会被劈成多段
 * （飞书卡片 markdown、聊天气泡都把 CR 当换行）。
 */
export const stripCarriageReturns = (value) => String(value ?? '')
  .replace(/\r\n/g, '\n')
  .replace(/\r/g, '')

/**
 * 单行化：去 CR 后把其余空白（空格/Tab/换行）折叠成单个半角空格并去首尾空白。
 * 提问、选项这类单行字段统一过这一道，避免残留空白把版面撑散。
 */
export const flattenWhitespace = (value) => stripCarriageReturns(value)
  .replace(/\s+/g, ' ')
  .trim()

export const jsonParse = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

export const clampNumber = (value, min, max, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export const redactSecrets = (value) => String(value ?? '')
  .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
  .replace(/\b(ghp_[A-Za-z0-9]{20,})\b/g, '[REDACTED]')
  .replace(/(password|passwd|pwd|api[_ -]?key|secret|token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')

export const escapeXml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')

// provider 把工具调用序列化成 text 块泄漏进回复（真实样例：生产库 messages 表）。
// 形态一：DSML 标签残片 </｜｜DSML｜｜ invoke>、</｜｜DSML｜｜ calls>，可能不成对、也可能只剩标记本体；
// 形态二：minimax 变体 <tool_call>…</tool_call>、<invoke name="read">、]<]minimax[> 括号残渣与观测到的
// 参数标签 <file_path>/<limit>/<offset>。只剥标记与包裹残渣，不碰正常 markdown（<b>、<https://…>、代码块）。
const LEAKED_TOOL_MARKUP_PATTERNS = [
  /<\/?｜｜DSML｜｜[^><]*>/g,
  /｜｜DSML｜｜/g,
  /<(?:tool_call|tool_use|function_calls)\b[^><]*>[\s\S]{0,2000}?<\/(?:tool_call|tool_use|function_calls)>/g,
  /<\/?(?:tool_call|tool_use|invoke|function_call|function_calls)\b[^><]*>/g,
  /<\]?minimax\[?>|]minimax\[/g,
  /<\/?(?:file_path|limit|offset)\b[^><]*>/g,
]

/** 剥掉 provider 泄漏的工具调用标记残片；清除后连续空行压成一个，两端留白裁掉。 */
export const stripLeakedToolMarkup = (value) => {
  let cleaned = String(value ?? '')
  for (const pattern of LEAKED_TOOL_MARKUP_PATTERNS) cleaned = cleaned.replace(pattern, '')
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

// Bot 名称解析的唯一口径：大小写不敏感（建档查重就是按 lower(name) 定的，同名只可能有一个）。
// 任何「把名字解析成成员 Bot」的地方都走这里，别再各写一份比较式。
export const findMemberByName = (members, name) => {
  const target = String(name ?? '').trim().toLowerCase()
  if (!target) return undefined
  return [...(members ?? [])].find(bot => String(bot?.name ?? '').toLowerCase() === target)
}

export const parseMentions = (body, candidates) => {
  const found = []
  const names = [...candidates].sort((a, b) => b.name.length - a.name.length)
  for (const candidate of names) {
    if (new RegExp(`(^|\\s)@${escapeRegExp(candidate.name)}(?=\\s|$|[，。,.!?：:])`, 'iu').test(body)) found.push(candidate)
  }
  return found
}

export const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// projects.disabled_skills 是 JSON 字符串数组；坏数据一律安全降级为空数组。
export const parseDisabledSkills = (value) => {
  try {
    const list = JSON.parse(value ?? '[]')
    return Array.isArray(list) ? list.filter(item => typeof item === 'string' && item.length > 0) : []
  } catch {
    return []
  }
}

export const sanitizeFilename = (value) => slugify(value) || 'item'

export async function ensureDir(path) {
  await mkdir(path, { recursive: true })
}

export async function writeIfChanged(path, content) {
  await ensureDir(dirname(path))
  try {
    const current = await readFile(path, 'utf8')
    if (current === content) return false
  } catch {}
  await writeFile(path, content, 'utf8')
  return true
}

export function atPath(root, ...parts) {
  return join(root, ...parts)
}
