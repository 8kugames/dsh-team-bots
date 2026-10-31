import { lstat, mkdir, realpath } from 'node:fs/promises'
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

export function safeSlug(value) {
  const slug = String(value ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) {
    throw new PathError('项目 slug 只能包含小写字母、数字和连字符，长度 1–48')
  }
  return slug
}

export async function ensureProjectWorkspace(workspaceRoot, slug) {
  const safe = safeSlug(slug)
  await mkdir(workspaceRoot, { recursive: true })
  const rootReal = await realpath(workspaceRoot)
  const target = resolve(rootReal, safe)
  if (!within(target, rootReal) || target === rootReal) throw new PathError('项目目录越界')
  await mkdir(target, { recursive: true })
  const targetReal = await realpath(target)
  if (!within(targetReal, rootReal) || targetReal === rootReal) throw new PathError('项目目录经符号链接越界')
  const info = await lstat(targetReal)
  if (!info.isDirectory()) throw new PathError('项目工作区不是目录')
  return targetReal
}

export async function ensureSkillRoot(workspaceRoot) {
  await mkdir(workspaceRoot, { recursive: true })
  const rootReal = await realpath(workspaceRoot)
  const target = join(rootReal, '.agents')
  await mkdir(target, { recursive: true })
  const real = await realpath(target)
  if (!within(real, rootReal)) throw new PathError('共享技能池越界')
  return real
}

export async function projectDir(workspaceRoot, slug) {
  return ensureProjectWorkspace(workspaceRoot, slug)
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
