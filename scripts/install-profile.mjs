#!/usr/bin/env node
// 一键把当前仓库打包并安装进指定的 DSH profile：
//   npm run profile:install                          # 缺省装进 team-bots
//   npm run profile:install -- --profile web         # 装进任意指定 profile
// 原理：npm pack 产物落在仓库 .dist/，`dsh plugin` 在目标 profile 里从该
// tarball 重装并把插件登记进 profile bundles（profile 不存在时按模板初始化）；
// profile 的 node_modules 是快照，DSH 不热更新，装完必须重启。
// 团队数据与 profile 无关：始终由 DSH_TEAM_WORKSPACE / DSH_TEAM_DATA 决定
// （缺省 ~/.dsh/workspace/team-bots/.data），装到哪个 profile 都共享同一份。
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function argOf(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = argOf('profile') ?? 'team-bots'

for (const tool of ['npm', 'dsh']) {
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

console.log(`安装到 profile ${profile} …`)
execFileSync('dsh', ['plugin', '--profile', profile, 'add', `dsh-team-bots@file:${tarball}`], { stdio: 'inherit' })
console.log(`\n完成。重启 DSH 后生效：dsh --profile ${profile}`)
