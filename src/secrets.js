import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ENV_PREFIX = 'DSH_SECRET_'
const ENV_FILE_HEADER = '# managed by dsh-team-bots'
const KEY_BYTES = 32
const IV_BYTES = 12
// A value is written bare only when every character is inert in a POSIX shell
// assignment word. Anything else (whitespace, quotes, `$`, `#`, backticks, `;`,
// glob characters, …) is single-quoted, so sourcing the file can never expand
// or execute part of a value.
const BARE_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Normalize a secret name the user typed on the settings page: trim, drop a
 * leading `$env:` (or bare `$`), drop one `DSH_SECRET_` prefix, turn inner
 * whitespace and hyphens into `_`, uppercase. Empty result throws.
 */
export function normalizeSecretName(raw) {
  const name = String(raw ?? '')
    .trim()
    .replace(/^\$(?:env:)?/i, '')
    .replace(/^DSH_SECRET_/i, '')
    .replace(/[\s-]+/g, '_')
    .toUpperCase()
  if (name === '') throw new Error('密钥名称为空')
  return name
}

/**
 * AES-256-GCM box for the values stored in SQLite. The key comes from a file
 * (created with mode 0600, parent dirs recursive) or from hex. Constructing is
 * synchronous on purpose: callers do `new SecretBox({ keyFile })` during setup.
 */
export class SecretBox {
  #key

  constructor({ keyFile, keyHex } = {}) {
    if (keyHex !== undefined) {
      this.#key = decodeKeyHex(keyHex, 'keyHex')
    } else if (keyFile !== undefined) {
      if (existsSync(keyFile)) {
        this.#key = decodeKeyHex(readFileSync(keyFile, 'utf8'), `密钥文件 ${keyFile}`)
      } else {
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

function decodeKeyHex(raw, what) {
  const key = Buffer.from(String(raw).trim(), 'hex')
  if (key.length !== KEY_BYTES) throw new Error(`${what} 必须是 ${KEY_BYTES} 字节的十六进制`)
  return key
}

/**
 * Write `${workspaceDir}/.team/secrets.env` (mode 0600, dir 0700) for the bot
 * shell to `set -a; source`. Names are normalized so the file only ever holds
 * valid shell identifiers. Values are single-quoted with `'\''` escaping unless
 * every character is shell-inert; multi-line values stay inside the quotes.
 * Empty entries still produce the comment-only file, and `.gitignore` is
 * created (mode 0644) or appended with a single `.team/` line. Returns the
 * written file path.
 */
export async function materializeEnvFile(entries, workspaceDir) {
  const teamDir = join(workspaceDir, '.team')
  await mkdir(teamDir, { recursive: true, mode: 0o700 })
  await chmod(teamDir, 0o700)
  const envPath = join(teamDir, 'secrets.env')
  const lines = [ENV_FILE_HEADER]
  for (const { name, value } of entries) {
    lines.push(`${normalizeSecretName(name)}=${formatEnvValue(value)}`)
  }
  await writeFile(envPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(envPath, 0o600)
  await ensureGitignore(workspaceDir)
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
  if (current !== null && current.split(/\r?\n/).some(line => line.trim() === '.team/')) return
  const next = current === null || current === ''
    ? '.team/\n'
    : current.endsWith('\n') ? `${current}.team/\n` : `${current}\n.team/\n`
  await writeFile(gitignorePath, next, { encoding: 'utf8', mode: 0o644 })
  if (current === null) await chmod(gitignorePath, 0o644)
}

/**
 * Replace every occurrence of a known secret value in persisted text with
 * `$DSH_SECRET_<NAME>`, so the value never reaches the model context. Values
 * shorter than 8 characters are left alone (they would eat ordinary words);
 * longer values are replaced longest first, so a value containing another is
 * replaced whole. Names are normalized to match what the bot's shell sees.
 */
export function maskSecrets(text, entries) {
  if (typeof text !== 'string') return text
  const pairs = []
  for (const { name, value } of entries) {
    if (typeof value !== 'string' || value === '' || value.length < 8) continue
    pairs.push([value, normalizeSecretName(name)])
  }
  pairs.sort((a, b) => b[0].length - a[0].length)
  let masked = text
  for (const [value, name] of pairs) {
    masked = masked.split(value).join(`$${ENV_PREFIX}${name}`)
  }
  return masked
}

/** First 8 hex chars of sha256(value): lets the UI confirm a re-entered key without echoing it. */
export function secretFingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8)
}
