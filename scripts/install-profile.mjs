#!/usr/bin/env node
// 一键把当前仓库打包并安装进 team-bots profile，然后重启 DSH 生效：
//   npm run profile:install
// 可用 --to <dir> 指定其他 profile 目录（默认 ~/.dsh/profiles/team-bots）。
// 原理：npm pack 产物落在仓库 .dist/，pnpm 在 profile 里从该 tarball 重装；
// profile 的 node_modules 是快照，DSH 不热更新，装完必须重启。
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function argOf(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profileDir = resolve(argOf('to') ?? join(homedir(), '.dsh', 'profiles', 'team-bots'))

if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`profile 目录不存在或缺少 package.json：${profileDir}`)
  process.exit(1)
}
for (const tool of ['npm', 'pnpm']) {
  try { execFileSync(tool, ['--version'], { stdio: 'ignore' }) } catch {
    console.error(`缺少 ${tool}，请先安装后重试`)
    process.exit(1)
  }
}

const dist = join(repo, '.dist')
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
console.log('打包中…')
const packed = execFileSync('npm', ['pack', `--pack-destination=${dist}`], { cwd: repo, encoding: 'utf8' })
const tarballName = packed.trim().split('\n').pop()
if (!tarballName?.endsWith('.tgz')) {
  console.error(`npm pack 输出异常：${packed.trim()}`)
  process.exit(1)
}
const tarball = join(dist, tarballName)
console.log(`已打包 ${tarballName}`)

console.log(`安装到 ${profileDir} …`)
execFileSync('pnpm', ['--dir', profileDir, 'add', `dsh-team-bots@file:${tarball}`], { stdio: 'inherit' })
console.log('\n完成。重启 DSH 后生效：dsh --profile team-bots')
