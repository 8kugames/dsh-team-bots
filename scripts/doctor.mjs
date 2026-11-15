// Diagnostics for path and permission problems. It prints the resolved layout
// and reports anything that would stop the service from writing to its own
// directories.
//
// 退出码分级（A5/DSHBOTS-329，吸收原型 dsh-superagent 守护脚本的 outcome 语义）：
// 让 CI/定时巡检能区分「自己能修」与「必须叫人」——
//   0  ok：目录可写、host refs 全部存在
//   1  目录/权限问题（workspace/data/skill 目录缺失或不可写）：多为环境可修复
//   2  host refs 缺失（patch 文件指向不存在的绝对路径）：必须人工改 patch 文件
//   3  两类问题同时存在
// 退出码按「最高严重级」落：problems 含两类时取 3，只有一类取对应码。
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveConfig } from '../src/config.js'

// Absolute filesystem paths referenced by a dsh patch (the global
// ~/.dsh/cordis.patch.yml registers MCP runtimes this way). Returns unique
// paths in order of first appearance. Comment lines are ignored; scoped
// package names, URLs and single-segment paths are not host references.
export function extractHostRefs(text) {
  const body = String(text)
    .split(/^/m)
    .filter(line => !/^\s*#/.test(line))
    .join('')
  const refs = []
  const pattern = /(^|[\s"'`,\[])(\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+)/g
  for (const match of body.matchAll(pattern)) {
    if (!refs.includes(match[2])) refs.push(match[2])
  }
  return refs
}

const describe = path => {
  let entry
  try {
    entry = lstatSync(path)
  } catch (error     ) {
    if (error.code === 'ENOENT') return { label: 'missing', dir: false, target: null }
    return { label: error.code === 'ELOOP' ? 'broken symlink loop' : (error.code ?? 'error'), dir: false, target: null }
  }
  if (entry.isSymbolicLink()) {
    try {
      const target = realpathSync(path)
      const targetEntry = statSync(target)
      return {
        label: targetEntry.isDirectory()
          ? `symlink -> ${target}`
          : `symlink -> ${target} (not a directory)`,
        dir: targetEntry.isDirectory(),
        target,
      }
    } catch (error     ) {
      return {
        label: error.code === 'ELOOP' ? 'broken symlink loop' : `dangling symlink (${error.code ?? 'error'})`,
        dir: false,
        target: null,
      }
    }
  }
  if (entry.isDirectory()) return { label: 'directory', dir: true, target: path }
  return { label: 'file', dir: false, target: path }
}

const writable = path => {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function main() {
  const config = resolveConfig()
  const targets                              = [
    ['DSH home', config.dshHome, true],
    ['workspace', config.workspace, false],
    ['data dir', config.dataDir, false],
    ['skill pool', config.skillRoot, false],
    ['skill dir', `${config.skillRoot}/skills`, false],
  ]

  console.log(`node        ${process.versions.node}  uid=${process.getuid?.() ?? 'n/a'} gid=${process.getgid?.() ?? 'n/a'} home=${homedir()}`)

  const dsh = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
  const dshVersion = dsh.status === 0 ? String(dsh.stdout).trim() : ((dsh.error                                     )?.code === 'ENOENT' ? 'not installed' : 'unknown')
  console.log(`dsh         ${dshVersion}`)
  console.log('')

  let problems = 0
  let pathProblems = 0
  let refProblems = 0
  for (const [label, path, optional] of targets) {
    const info = describe(path)
    const canWrite = info.dir ? writable(info.target ?? path) : false
    const ok = info.dir && canWrite
    if (!ok && !optional) { problems += 1; pathProblems += 1 }
    console.log(`${label.padEnd(11)} ${path}`)
    console.log(`${''.padEnd(11)} ${info.label}${ok ? ', writable' : info.dir ? ', NOT writable' : ''}${optional && !ok ? ' (optional)' : ''}`)
  }

  // Host capability bridge: every absolute path the global patch references
  // must resolve here, or the bundle it configures (typically an MCP client)
  // fails to activate on every start.
  const patchFile = join(config.dshHome, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    const refs = extractHostRefs(readFileSync(patchFile, 'utf8'))
    console.log('')
    console.log(`host refs   ${patchFile}`)
    if (refs.length === 0) {
      console.log(`${''.padEnd(11)} none (no absolute paths referenced)`)
    }
    for (const ref of refs) {
      const ok = existsSync(ref)
      if (!ok) { problems += 1; refProblems += 1 }
      console.log(`${''.padEnd(11)} ${ok ? 'ok      ' : 'MISSING '} ${ref}`)
    }
    if (refs.some(ref => !existsSync(ref))) {
      console.log(`${''.padEnd(11)} fix the entry so the path exists on this machine, or remove it from the patch file`)
    }
  }

  console.log('')
  console.log(problems === 0
    ? 'ok: all team directories exist and are writable'
    : `${problems} problem(s); see README "故障排查"`)
  // 退出码分级（A5/DSHBOTS-329）：1=目录/权限、2=host refs（人工配置）、3=两类并存。
  process.exit(problems === 0 ? 0 : pathProblems > 0 && refProblems > 0 ? 3 : refProblems > 0 ? 2 : 1)
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) main()
