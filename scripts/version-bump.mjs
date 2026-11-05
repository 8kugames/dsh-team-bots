#!/usr/bin/env node
// main/dev 分支提交前把 package.json 的 patch 位 +1 并暂存：发版提交留一个可追踪的版本号。
// 仅 main 与 dev 生效（长期分支），其余临时分支跳过，避免特性分支的提交消耗版本号。
// 用法：node scripts/version-bump.mjs [--dry-run]
// 跳过：DSH_SKIP_VERSION_BUMP=1（手工发版、回滚提交等场景）。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(root, 'package.json')
const dryRun = process.argv.includes('--dry-run')

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options })
}

// symbolic-ref 在未提交过的仓库上也能返回当前分支名；分离 HEAD 时失败，按未知处理。
function currentBranch() {
  try {
    return git(['symbolic-ref', '--short', 'HEAD']).trim()
  } catch {
    return ''
  }
}

function stagedVersion() {
  try {
    return JSON.parse(git(['show', ':package.json'])).version
  } catch {
    return undefined // 新仓库或 package.json 未入库
  }
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version ?? '').trim())
  if (!match) throw new Error(`package.json 的 version 不是 x.y.z 形式：${version}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

if (process.env.DSH_SKIP_VERSION_BUMP === '1') {
  process.exit(0)
}

// 仅 main/dev 分支 bump：特性分支的提交不消耗版本号，发版 tag 才能与 commit 版本对齐。
const branch = currentBranch()
if (branch !== 'main' && branch !== 'dev') {
  console.log(`[version] 当前分支 ${branch || '(未知)'} 非 main/dev，跳过版本 bump`)
  process.exit(0)
}

// 手工改过版本号（工作区版本与暂存区不一致）时尊重人工决定，不再自动加一。
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const staged = stagedVersion()
if (staged !== undefined && staged !== manifest.version) {
  console.log(`[version] 暂存区已是 ${staged}，工作区 ${manifest.version}，视为手工改版，跳过自动 +1`)
  process.exit(0)
}

const bumped = nextPatch(manifest.version)
if (dryRun) {
  console.log(`[version] ${manifest.version} → ${bumped}`)
  process.exit(0)
}

const next = { ...manifest, version: bumped }
writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
git(['add', 'package.json'])
console.log(`[version] ${manifest.version} → ${bumped}（已暂存）`)
