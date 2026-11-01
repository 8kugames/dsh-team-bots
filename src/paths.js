import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export class PathError extends Error {
  constructor(message) {
    super(message)
    this.code = 'INVALID_PATH'
  }
}

const within = (candidate, root) => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// slug 长度上限：目录名/项目名统一用它，越界会抛 PathError。
export const SLUG_MAX = 48

const SLUG_PATTERN = new RegExp(`^[a-z0-9][a-z0-9-]{0,${SLUG_MAX - 1}}$`)

export function safeSlug(value) {
  const slug = String(value ?? '').trim().toLowerCase()
  if (!SLUG_PATTERN.test(slug)) {
    throw new PathError('项目 slug 只能包含小写字母、数字和连字符，长度 1–48')
  }
  return slug
}

/**
 * Create `directory` unless it already exists as a directory.
 *
 * A broken or self-referencing symlink (ELOOP) makes `mkdir -p` fail, which is
 * how `/workspace/.agents` can block startup after a bad manual `ln -s` or a
 * half-restored backup. Replace only symlinks that do not resolve to a real
 * directory; leave valid ones untouched.
 */
export async function ensureDirResilient(directory) {
  const existing = await lstat(directory).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    if (existing.isDirectory()) return
    if (existing.isSymbolicLink()) {
      const real = await realpath(directory).catch(() => null)
      if (real) {
        const target = await lstat(real).catch(() => null)
        if (target?.isDirectory()) return
      }
      await rm(directory, { force: true })
    } else {
      throw new PathError(`${directory} 已存在但不是目录`)
    }
  }
  await mkdir(directory, { recursive: true })
}

export async function ensureProjectWorkspace(workspaceRoot, slug) {
  const safe = safeSlug(slug)
  await ensureDirResilient(workspaceRoot)
  const rootReal = await realpath(workspaceRoot)
  const target = resolve(rootReal, safe)
  if (!within(target, rootReal) || target === rootReal) throw new PathError('项目目录越界')
  await ensureDirResilient(target)
  const targetReal = await realpath(target)
  if (!within(targetReal, rootReal) || targetReal === rootReal) throw new PathError('项目目录经符号链接越界')
  const info = await lstat(targetReal)
  if (!info.isDirectory()) throw new PathError('项目工作区不是目录')
  return targetReal
}

export async function ensureSkillRoot(workspaceRoot) {
  await ensureDirResilient(workspaceRoot)
  const rootReal = await realpath(workspaceRoot)
  const target = join(rootReal, '.agents')
  await ensureDirResilient(target)
  const real = await realpath(target)
  if (!within(real, rootReal)) throw new PathError('共享技能池越界')
  await ensureDirResilient(join(real, 'skills'))
  return real
}

export async function projectDir(workspaceRoot, slug) {
  return ensureProjectWorkspace(workspaceRoot, slug)
}

// 单聊工作区：workspaceRoot/_the_bots/<soloDir>，与项目目录同一套越界防护。
export async function botsHome(workspaceRoot) {
  await ensureDirResilient(workspaceRoot)
  const rootReal = await realpath(workspaceRoot)
  const target = join(rootReal, '_the_bots')
  if (!within(target, rootReal)) throw new PathError('单聊根目录越界')
  await ensureDirResilient(target)
  const real = await realpath(target)
  if (!within(real, rootReal)) throw new PathError('单聊根目录经符号链接越界')
  return real
}

export async function botWorkspaceDir(workspaceRoot, soloDir) {
  const safe = safeSlug(soloDir)
  const home = await botsHome(workspaceRoot)
  const target = resolve(home, safe)
  if (!within(target, home) || target === home) throw new PathError('单聊目录越界')
  await ensureDirResilient(target)
  const targetReal = await realpath(target)
  if (!within(targetReal, home) || targetReal === home) throw new PathError('单聊目录经符号链接越界')
  const info = await lstat(targetReal)
  if (!info.isDirectory()) throw new PathError('单聊工作区不是目录')
  return targetReal
}

export function relativeWorkspacePath(workspaceRoot, absolutePath) {
  const rel = relative(workspaceRoot, absolutePath)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new PathError('工作区路径越界')
  return rel.split(sep).join('/')
}

export function assertInside(root, path) {
  const target = resolve(path)
  if (!within(target, resolve(root))) throw new PathError('路径不在允许的工作区内')
  return target
}
