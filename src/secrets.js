import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 保留导出：外部模块按这个名字引用密钥前缀常量。
export const ENV_PREFIX = 'DSH_SECRET_'
const ENV_FILE_HEADER = '# managed by dsh-team-bots'
const KEY_BYTES = 32
const IV_BYTES = 12
const HEX_KEY = /^[0-9a-fA-F]{64}$/
const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
// A value is written bare only when every character is inert in a POSIX shell
// assignment word. Anything else (whitespace, quotes, `$`, `#`, backticks, `;`,
// glob characters, …) is single-quoted, so sourcing the file can never expand
// or execute part of a value.
const BARE_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/
// .gitignore 里认得的屏蔽写法：出现任一即认为 .team 已被忽略，不再追加。
const GITIGNORE_TEAM_FORMS = new Set(['.team/', '.team', '**/.team/'])

/**
 * Normalize a secret name the user typed on the settings page into a legal
 * POSIX shell identifier, deterministically and idempotently:
 * trim, drop one leading `$env:` (or bare `$`), drop one `DSH_SECRET_`
 * prefix, replace every character outside `[A-Za-z0-9_]` with `_`, uppercase,
 * collapse runs of `_`, and prefix `_` when the first character is a digit.
 * The result always satisfies `isShellIdentifier`; an empty result throws.
 */
export function normalizeSecretName(raw) {
  let name = String(raw ?? '').trim()
  name = name.replace(/^\$(?:env:)?/i, '')
  name = name.replace(/^DSH_SECRET_/i, '')
  name = name.replace(/[^A-Za-z0-9_]/g, '_')
  name = name.toUpperCase().replace(/_+/g, '_')
  if (/^[0-9]/.test(name)) name = `_${name}`
  if (name === '') throw new Error('密钥名称为空')
  return name
}

/** True when `name` is a legal POSIX shell identifier (`[A-Za-z_][A-Za-z0-9_]*`). */
export function isShellIdentifier(name) {
  return SHELL_IDENTIFIER.test(String(name ?? ''))
}

/**
 * AES-256-GCM box for the values stored in SQLite. The key comes from a file
 * (created with mode 0600, parent dirs recursive) or from hex. Constructing is
 * synchronous on purpose: callers do `new SecretBox({ keyFile })` during setup.
 *
 * `requireExisting: true` refuses to create a missing key file: a machine that
 * lost its key must fail loudly instead of silently minting a new key that can
 * never decrypt the existing ciphertext.
 */
export class SecretBox {
  #key

  constructor({ keyFile, keyHex, requireExisting = false } = {}) {
    if (keyHex !== undefined) {
      this.#key = decodeKeyHex(keyHex, 'keyHex')
    } else if (keyFile !== undefined) {
      if (existsSync(keyFile)) {
        enforceSecretKeyFilePermissions(keyFile)
        this.#key = decodeKeyHex(readFileSync(keyFile, 'utf8'), `密钥文件 ${keyFile}`)
      } else {
        if (requireExisting) throw new Error(`密钥文件不存在：${keyFile}`)
        this.#key = randomBytes(KEY_BYTES)
        mkdirSync(dirname(keyFile), { recursive: true })
        writeFileSync(keyFile, this.#key.toString('hex'), { mode: 0o600 })
        chmodSync(keyFile, 0o600)
      }
    } else {
      throw new Error('必须提供 keyFile 或 keyHex')
    }
  }

  encrypt(value) {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const enc = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
    return {
      valueEnc: enc.toString('base64'),
      valueIv: iv.toString('base64'),
      valueTag: cipher.getAuthTag().toString('base64'),
    }
  }

  decrypt({ valueEnc, valueIv, valueTag }) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(String(valueIv), 'base64'))
      decipher.setAuthTag(Buffer.from(String(valueTag), 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(String(valueEnc), 'base64')), decipher.final()]).toString('utf8')
    } catch (error) {
      throw new Error(`解密失败（密文或认证标签不匹配）: ${error.message}`)
    }
  }
}

/**
 * Make sure a key file is not readable by group or others. A too-wide mode is
 * tightened to 0600; if the mode is still too wide afterwards (or cannot be
 * changed at all), the caller is told the file is unsafe to read.
 */
export function enforceSecretKeyFilePermissions(keyFile, io = { chmod: chmodSync, stat: statSync }) {
  const mode = io.stat(keyFile).mode & 0o777
  if ((mode & 0o077) === 0) return
  try {
    io.chmod(keyFile, 0o600)
  } catch {
    // 收紧失败：交给下面的复查给出明确错误。
  }
  const after = io.stat(keyFile).mode & 0o777
  if ((after & 0o077) !== 0) throw new Error(`密钥文件权限过宽：${keyFile}`)
}

function decodeKeyHex(raw, what) {
  const text = String(raw).trim()
  if (!HEX_KEY.test(text)) throw new Error(`${what} 必须是 ${KEY_BYTES} 字节的十六进制`)
  return Buffer.from(text, 'hex')
}

/**
 * Write `${workspaceDir}/.team/secrets.env` (mode 0600, dir 0700) for the bot
 * shell to `set -a; source`. Names go through `normalizeSecretName`, so the
 * file only ever holds valid shell identifiers. Values are single-quoted with
 * `'\''` escaping unless every character is shell-inert; multi-line values stay
 * inside the quotes. Empty entries still produce the comment-only file.
 *
 * `.gitignore` (mode 0644) is written before the secrets file, so a failure
 * while writing the plaintext never leaves an unguarded secret on disk.
 * Returns the written file path.
 */
export async function materializeEnvFile(entries, workspaceDir) {
  const teamDir = join(workspaceDir, '.team')
  await mkdir(teamDir, { recursive: true, mode: 0o700 })
  await chmod(teamDir, 0o700)
  await ensureGitignore(workspaceDir)
  const envPath = join(teamDir, 'secrets.env')
  const lines = [ENV_FILE_HEADER]
  for (const { name, value } of entries) {
    lines.push(`${normalizeSecretName(name)}=${formatEnvValue(value)}`)
  }
  await writeFile(envPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(envPath, 0o600)
  return envPath
}

function formatEnvValue(value) {
  const raw = String(value ?? '')
  if (raw === '') return ''
  if (BARE_VALUE.test(raw)) return raw
  return `'${raw.replace(/'/g, "'\\''")}'`
}

async function ensureGitignore(workspaceDir) {
  const gitignorePath = join(workspaceDir, '.gitignore')
  let current = null
  try {
    current = await readFile(gitignorePath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (current !== null && current.split(/\r?\n/).some(line => GITIGNORE_TEAM_FORMS.has(line.trim()))) return
  const next = current === null || current === ''
    ? '.team/\n'
    : current.endsWith('\n') ? `${current}.team/\n` : `${current}\n.team/\n`
  await writeFile(gitignorePath, next, { encoding: 'utf8', mode: 0o644 })
  if (current === null) await chmod(gitignorePath, 0o644)
}

/**
 * Replace every occurrence of a known secret value in persisted text with
 * `$<NAME>`, where `<NAME>` is the variable name the bot's shell sees after
 * `set -a; . .team/secrets.env`. Values shorter than 8 characters are left
 * alone (they would eat ordinary words); longer values are replaced longest
 * first, so a value containing another is replaced whole.
 *
 * All replacements go through an unambiguous sentinel first and only become
 * placeholders at the very end, so a placeholder can never be masked a second
 * time by a later value.
 */
export function maskSecrets(text, entries) {
  if (typeof text !== 'string') return text
  const pairs = []
  for (const { name, value } of entries) {
    if (typeof value !== 'string' || value === '' || value.length < 8) continue
    pairs.push([value, normalizeSecretName(name)])
  }
  pairs.sort((a, b) => b[0].length - a[0].length)
  const marks = pairs.map((_, index) => `\u0000DSHMASK${index}\u0000`)
  let masked = text
  pairs.forEach(([value], index) => {
    masked = masked.split(value).join(marks[index])
  })
  pairs.forEach(([, name], index) => {
    masked = masked.split(marks[index]).join(`$${name}`)
  })
  return masked
}

/** First 8 hex chars of sha256(value): lets the UI confirm a re-entered key without echoing it. */
export function secretFingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8)
}

/**
 * First 16 hex chars of sha256 over the raw key bytes: lets a restored machine
 * detect that its key file is not the one the ciphertext was written with.
 * Accepts a 32-byte Buffer or its 64-char hex form.
 */
export function secretKeyFingerprint(key) {
  const bytes = Buffer.isBuffer(key) ? key : decodeKeyHex(key, '密钥')
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}
