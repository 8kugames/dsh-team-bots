// 备份恢复演练：把备份复制到临时目录当新库恢复，做完整性校验，
// 再按备份清单逐表比对行数，最后与当前生产库做行数差异对照。
//
// 用法：
//   node scripts/restore-check.mjs [--backup <备份文件>] [--db <生产库>] [--dir <备份目录>]
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveConfig } from '../src/config.js'

const USAGE = `用法：node scripts/restore-check.mjs [选项]

  --backup <path>   指定要演练的备份文件（默认取备份目录里最新的一份）
  --db <path>       当前生产库路径（默认按 DSH_TEAM_DATA / DSH_TEAM_WORKSPACE 推导）
  --dir <dir>       备份目录（默认 <数据目录>/backups）
  --manifest <path> 清单路径（默认与备份同名 .json）
  --keep            保留恢复出来的临时库（排查用）
  --help            显示本帮助

清单与备份不一致即视为演练失败；与生产库的差异只报告、不判失败。`

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

function openSqlite(path, { readOnly = false } = {}) {
  try {
    return new DatabaseSync(path, { readOnly })
  } catch (error) {
    if (readOnly) return new DatabaseSync(path)
    throw error
  }
}

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

function tableCounts(db) {
  return Object.fromEntries(tableNames(db).map(table => [table, countRows(db, table)]))
}

async function latestBackup(dir) {
  if (!existsSync(dir)) return null
  const entries = await readdir(dir)
  const candidates = entries
    .filter(name => /^team-.*\.sqlite$/.test(name))
    .sort()
  if (candidates.length === 0) return null
  return join(dir, candidates[candidates.length - 1])
}

function manifestPathFor(backupPath) {
  return backupPath.replace(/\.sqlite$/, '.json')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  const config = resolveConfig()
  const backupDir = resolve(args.dir && args.dir !== true ? args.dir : join(config.dataDir, 'backups'))
  const explicit = args.backup && args.backup !== true ? args.backup : null
  const backupPath = explicit ? resolve(explicit) : await latestBackup(backupDir)
  if (!backupPath) throw new Error(`备份目录里没有可用的备份：${backupDir}`)
  if (!existsSync(backupPath)) throw new Error(`备份文件不存在：${backupPath}`)

  const manifestPath = resolve(
    args.manifest && args.manifest !== true ? args.manifest : manifestPathFor(backupPath),
  )
  if (!existsSync(manifestPath)) throw new Error(`找不到备份清单：${manifestPath}`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  const workDir = await mkdtemp(join(tmpdir(), 'dsh-team-restore-'))
  const restoredPath = join(workDir, basename(backupPath))
  try {
    await copyFile(backupPath, restoredPath)

    const restored = openSqlite(restoredPath, { readOnly: true })
    let integrity
    let foreignKeyIssues
    let restoredTables
    try {
      const row = restored.prepare('PRAGMA integrity_check').get()
      integrity = row?.integrity_check ?? row?.['integrity_check'] ?? 'unknown'
      foreignKeyIssues = restored.prepare('PRAGMA foreign_key_check').all()
      restoredTables = tableCounts(restored)
    } finally {
      restored.close()
    }

    // 与备份清单逐表比对：备份自己没丢数据才算演练通过。
    const manifestTables = manifest?.tables ?? {}
    const mismatch = []
    for (const [table, expected] of Object.entries(manifestTables)) {
      const actual = restoredTables[table]
      if (actual === undefined) {
        mismatch.push({ table, expected, actual: null, reason: '恢复库缺少该表' })
        continue
      }
      if (Number(expected) !== Number(actual)) {
        mismatch.push({ table, expected: Number(expected), actual: Number(actual), reason: '行数不一致' })
      }
    }
    for (const table of Object.keys(restoredTables)) {
      if (!(table in manifestTables)) mismatch.push({ table, expected: null, actual: restoredTables[table], reason: '清单里没有该表' })
    }

    // 与当前生产库对照：生产库一直在变，差异是正常的，只报告不判失败。
    const productionPath = resolve(args.db && args.db !== true ? args.db : config.dbPath)
    let productionDiff = []
    let productionChecked = false
    if (existsSync(productionPath)) {
      productionChecked = true
      const production = openSqlite(productionPath, { readOnly: true })
      let productionTables
      try {
        productionTables = tableCounts(production)
      } finally {
        production.close()
      }
      const names = [...new Set([...Object.keys(restoredTables), ...Object.keys(productionTables)])].sort()
      productionDiff = names
        .map(table => ({
          table,
          restored: restoredTables[table] ?? null,
          production: productionTables[table] ?? null,
        }))
        .filter(entry => entry.restored !== entry.production)
    }

    const ok = integrity === 'ok' && foreignKeyIssues.length === 0 && mismatch.length === 0
    console.log(JSON.stringify({
      ok,
      backup: backupPath,
      manifest: manifestPath,
      restored: restoredPath,
      bytes: (await stat(restoredPath)).size,
      integrity,
      foreignKeyIssues: foreignKeyIssues.length,
      manifestMismatch: mismatch,
      productionChecked,
      productionDiff,
      tables: restoredTables,
    }, null, 2))
    if (!ok) process.exitCode = 1
  } finally {
    if (args.keep) {
      console.error(`临时恢复库保留在：${workDir}`)
    } else {
      await rm(workDir, { recursive: true, force: true })
    }
  }
}

main().catch(error => {
  console.error(`恢复演练失败：${error?.stack || error}`)
  process.exitCode = 1
})
