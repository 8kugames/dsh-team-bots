// SQLite 在线备份：用 VACUUM INTO 生成一致快照，再做完整性校验并写出行数清单。
// 生产库不需要停服，备份期间对源库只持有读锁。
//
// 密钥主文件 secret.key 与微信通道库 wechat-channel.sqlite 同在数据目录里，
// 一并备份：只备份 team.sqlite 的话，换机恢复后既有密文再也解不开。
//
// 用法：
//   node scripts/backup.mjs [--db <team.sqlite>] [--out <备份目录>]
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveConfig } from '../src/config.js'

const USAGE = `用法：node scripts/backup.mjs [选项]

  --db <path>   数据库路径（默认按 DSH_TEAM_DATA / DSH_TEAM_WORKSPACE 推导 team.sqlite）
  --out <dir>   备份输出目录（默认 <数据目录>/backups）
  --help        显示本帮助

成功后向 stdout 打印一份 JSON 摘要；失败时把原因打到 stderr 并以退出码 1 结束。`

function parseArgs(argv) {
  const args: Record<string, string | boolean> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

// 本地时间的 YYYYMMDD-HHMMSS，避免备份名在跨时区排查时对不上。
function stamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function openSqlite(path, { readOnly = false } = {}) {
  try {
    return new DatabaseSync(path, { readOnly })
  } catch (error) {
    if (readOnly) return new DatabaseSync(path)
    throw error
  }
}

// VACUUM INTO 的目标是一个 SQL 字面量字符串，单引号要转义。
const quoteSql = value => `'${String(value).replaceAll("'", "''")}'`

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(row => row.name)
}

function countRows(db, table) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`).get()
  return Number(row?.n ?? 0)
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  const config = resolveConfig()
  const dbPath = resolve(args.db && args.db !== true ? args.db : config.dbPath)
  const outDir = resolve(args.out && args.out !== true ? args.out : join(config.dataDir, 'backups'))
  // 密钥主文件与微信通道库都跟数据库同目录，从库路径反推，避免 --db 指到别处时备错地方。
  const dataDir = dirname(dbPath)

  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`)

  mkdirSync(outDir, { recursive: true })
  const base = `team-${stamp()}`
  const backupPath = join(outDir, `${base}.sqlite`)
  const manifestPath = join(outDir, `${base}.json`)
  if (existsSync(backupPath)) throw new Error(`备份文件已存在，拒绝覆盖：${backupPath}`)

  const startedAt = Date.now()
  const source = openSqlite(dbPath)
  let backup
  try {
    source.exec(`VACUUM INTO ${quoteSql(backupPath)}`)
  } finally {
    source.close()
  }

  const bytes = statSync(backupPath).size
  const digest = await sha256File(backupPath)

  backup = openSqlite(backupPath, { readOnly: true })
  let integrity
  let foreignKeyIssues
  let tables
  try {
    integrity = backup.prepare('PRAGMA integrity_check').get()
    integrity = integrity?.integrity_check ?? integrity?.['integrity_check'] ?? 'unknown'
    foreignKeyIssues = backup.prepare('PRAGMA foreign_key_check').all()
    tables = Object.fromEntries(tableNames(backup).map(table => [table, countRows(backup, table)]))
  } finally {
    backup.close()
  }

  if (integrity !== 'ok') throw new Error(`备份库完整性校验失败：${integrity}`)
  if (foreignKeyIssues.length > 0) {
    throw new Error(`备份库存在 ${foreignKeyIssues.length} 处外键不一致：${JSON.stringify(foreignKeyIssues.slice(0, 5))}`)
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    tool: 'scripts/backup.mjs',
    source: dbPath,
    backup: backupPath,
    bytes,
    sha256: digest,
    integrity,
    foreignKeyIssues: foreignKeyIssues.length,
    tables,
    extras: await backupExtras({ dataDir, outDir, base }),
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify({
    ok: true,
    backup: backupPath,
    manifest: manifestPath,
    bytes,
    sha256: digest,
    integrity,
    foreignKeyIssues: foreignKeyIssues.length,
    tables,
    extras: manifest.extras,
    durationMs: Date.now() - startedAt,
  }, null, 2))
}

// 同目录下的密钥主文件与微信通道库：一起备份，少一个都可能在换机后要命。
async function backupExtras({ dataDir, outDir, base }) {
  const extras = []

  const keyFile = join(dataDir, 'secret.key')
  if (existsSync(keyFile)) {
    const target = join(outDir, `${base}.secret.key`)
    copyFileSync(keyFile, target)
    chmodSync(target, 0o600)
    extras.push({
      name: 'secret.key',
      source: keyFile,
      backup: target,
      bytes: statSync(target).size,
      sha256: await sha256File(target),
    })
  } else {
    extras.push({ name: 'secret.key', source: keyFile, backup: null, missing: true })
  }

  const wechatDb = join(dataDir, 'wechat-channel.sqlite')
  if (existsSync(wechatDb)) {
    const target = join(outDir, `${base}.wechat.sqlite`)
    const source = openSqlite(wechatDb)
    try {
      source.exec(`VACUUM INTO ${quoteSql(target)}`)
    } finally {
      source.close()
    }
    extras.push({
      name: 'wechat-channel.sqlite',
      source: wechatDb,
      backup: target,
      bytes: statSync(target).size,
      sha256: await sha256File(target),
    })
  } else {
    extras.push({ name: 'wechat-channel.sqlite', source: wechatDb, backup: null, missing: true })
  }

  return extras
}

main().catch(error => {
  console.error(`备份失败：${error?.stack || error}`)
  process.exitCode = 1
})
