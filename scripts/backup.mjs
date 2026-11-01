// SQLite 在线备份：用 VACUUM INTO 生成一致快照，再做完整性校验并写出行数清单。
// 生产库不需要停服，备份期间对源库只持有读锁。
//
// 用法：
//   node scripts/backup.mjs [--db <team.sqlite>] [--out <备份目录>]
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveConfig } from '../src/config.js'

const USAGE = `用法：node scripts/backup.mjs [选项]

  --db <path>   数据库路径（默认按 DSH_TEAM_DATA / DSH_TEAM_WORKSPACE 推导 team.sqlite）
  --out <dir>   备份输出目录（默认 <数据目录>/backups）
  --help        显示本帮助

成功后向 stdout 打印一份 JSON 摘要；失败时把原因打到 stderr 并以退出码 1 结束。`

function parseArgs(argv) {
  const args = {}
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
    durationMs: Date.now() - startedAt,
  }, null, 2))
}

main().catch(error => {
  console.error(`备份失败：${error?.stack || error}`)
  process.exitCode = 1
})
