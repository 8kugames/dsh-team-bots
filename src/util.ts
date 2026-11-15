import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const nowIso = () => new Date().toISOString()

/** 任务号 <项目key>-<序号>：与 service.resolveTaskByIdentifier 同一口径。 */
export const TASK_ID_PATTERN = /^([a-z][a-z0-9-]*)-(\d+)$/i

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
  .replace(/[^A-Z0-9]+/g, '')
  .slice(0, 10)

export const text = (value, max = 20_000) => String(value ?? '').trim().slice(0, max)

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

export const parseMentions = (body, candidates) => {
  const found = []
  const names = [...candidates].sort((a, b) => b.name.length - a.name.length)
  for (const candidate of names) {
    if (new RegExp(`(^|\\s)@${escapeRegExp(candidate.name)}(?=\\s|$|[，。,.!?：:])`, 'u').test(body)) found.push(candidate)
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
