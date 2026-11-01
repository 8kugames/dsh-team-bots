// Diagnostics for path and permission problems, useful both locally and in the
// container. It prints the resolved layout and reports anything that would stop
// the service from writing to its own directories.
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveConfig, defaultWorkspace } from '../src/config.js'

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
  } catch (error) {
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
    } catch (error) {
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
  const targets = [
    ['DSH home', config.dshHome, true],
    ['workspace', config.workspace, false],
    ['data dir', config.dataDir, false],
    ['skill pool', config.skillRoot, false],
    ['skill dir', `${config.skillRoot}/skills`, false],
  ]

  console.log(`node        ${process.versions.node}  uid=${process.getuid?.() ?? 'n/a'} gid=${process.getgid?.() ?? 'n/a'} home=${homedir()}`)
  console.log(`container   ${defaultWorkspace() === '/workspace' ? 'yes (/workspace present)' : `no, using ${defaultWorkspace()}`}`)

  const dsh = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
  const dshVersion = dsh.status === 0 ? String(dsh.stdout).trim() : (dsh.error?.code === 'ENOENT' ? 'not installed' : 'unknown')
  console.log(`dsh         ${dshVersion}`)
  console.log('')

  let problems = 0
  for (const [label, path, optional] of targets) {
    const info = describe(path)
    const canWrite = info.dir ? writable(info.target ?? path) : false
    const ok = info.dir && canWrite
    if (!ok && !optional) problems += 1
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
      if (!ok) problems += 1
      console.log(`${''.padEnd(11)} ${ok ? 'ok      ' : 'MISSING '} ${ref}`)
    }
    if (refs.some(ref => !existsSync(ref))) {
      console.log(`${''.padEnd(11)} regenerate the bridge with npm run docker:up (README 宿主能力桥), or fix the patch entry`)
    }
  }

  console.log('')
  console.log(problems === 0
    ? 'ok: all team directories exist and are writable'
    : `${problems} problem(s); see README "故障排查"`)
  process.exit(problems === 0 ? 0 : 1)
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) main()
