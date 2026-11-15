// tests/restore-check-latest-backup.test.ts —— 「挑最新一份主备份」的判定守门。
// 备份目录里主备份 `team-<stamp>.sqlite` 与附件同名前缀：附件库
// `team-<stamp>.wechat.sqlite`、密钥 `team-<stamp>.secret.key`、清单 `team-<stamp>.json`。
// 宽匹配会把附件当主备份挑走，演练随即报「找不到备份清单」而失败（DSHBOTS-354 复跑暴露）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isMainBackupFile } from '../scripts/restore-check.mjs'

// 读 .mts 源（RULES：.js/.mjs 是构建产物不手改，守门钉源文件）。
const source = readFileSync(fileURLToPath(new URL('../scripts/restore-check.mts', import.meta.url)), 'utf8')

test('主备份与附件分开判定：附件不算主备份', () => {
  assert.equal(isMainBackupFile('team-20261113-115929.sqlite'), true)
  assert.equal(isMainBackupFile('team-20261113-115929.wechat.sqlite'), false)
  assert.equal(isMainBackupFile('team-20261113-115929.secret.key'), false)
  assert.equal(isMainBackupFile('team-20261113-115929.json'), false)
  assert.equal(isMainBackupFile('team.sqlite'), false)
})

test('演练默认目标仍是「最新主备份」', () => {
  assert.match(source, /\.filter\(isMainBackupFile\)/, 'latestBackup 用主备份判定过滤')
  assert.match(source, /\.sort\(\)/, '同名按名字排序取末位（时间戳最新）')
})

test('被 import 时不自动开跑（导出的判定函数可单独测）', () => {
  assert.match(source, /if \(invokedDirectly\) \{/, 'main 只在直接调用时执行')
})
