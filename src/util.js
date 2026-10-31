import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const nowIso = () => new Date().toISOString()

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

export const parseMentions = (body, candidates) => {
  const found = []
  const names = [...candidates].sort((a, b) => b.name.length - a.name.length)
  for (const candidate of names) {
    if (new RegExp(`(^|\\s)@${escapeRegExp(candidate.name)}(?=\\s|$|[，。,.!?：:])`, 'u').test(body)) found.push(candidate)
  }
  return found
}

export const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
