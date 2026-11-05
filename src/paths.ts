import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
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
 * how `~/.agents` can block startup after a bad manual `ln -s` or a
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

export async function ensureSkillRoot(skillRoot) {
  await ensureDirResilient(skillRoot)
  const real = await realpath(skillRoot)
  await ensureDirResilient(join(real, 'skills'))
  return real
}

export async function projectDir(workspaceRoot, slug) {
  return ensureProjectWorkspace(workspaceRoot, slug)
}

// 项目生产目录：允许指向工作区外的任意本机目录（如既有代码库）。
// 只要求绝对路径且最终解析为真实目录，不做工作区越界限制。
export async function ensureExternalDir(dir) {
  const raw = String(dir ?? '').trim()
  if (!raw) throw new PathError('生产目录不能为空')
  if (!isAbsolute(raw)) throw new PathError('生产目录必须是绝对路径')
  await ensureDirResilient(raw)
  const real = await realpath(raw)
  const info = await lstat(real)
  if (!info.isDirectory()) throw new PathError('生产目录不是目录')
  return real
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

// DSHBOTS-225 临时文件纪律：bot 名 → 临时目录名的安全化。
// 路径分隔符、Windows 保留字符与控制字符替换为 '-'，空白归一为 '-'，去前导点
// （防隐藏目录）与首尾连字符，截断到 64；净化后为空回退 'bot'。
export function sanitizeTmpBotDirName(name, fallback = 'bot') {
  const safe = String(name ?? '')
    .trim()
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 64)
  return safe || fallback
}

// DSHBOTS-225 临时文件纪律：项目工作区统一临时区 .tmp/bots/。
// .tmp/.gitignore 写 "*"（整个 .tmp 不入 git）——ignore 文件自包含在项目工作区内，
// 不碰仓库根 .gitignore；只在缺失时写入（wx），不覆盖用户自定义内容。
// 每个成员 bot 一个 .tmp/bots/{安全化 bot 名}/ 子目录。调用方负责 try/catch 降级。
export async function ensureBotTmpDirs(projectDir, botNames = []) {
  const tmpRoot = join(projectDir, '.tmp')
  await ensureDirResilient(tmpRoot)
  await writeFile(join(tmpRoot, '.gitignore'), '*\n', { flag: 'wx' }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error
  })
  const botsRoot = join(tmpRoot, 'bots')
  await ensureDirResilient(botsRoot)
  for (const name of botNames) {
    await ensureDirResilient(join(botsRoot, sanitizeTmpBotDirName(name)))
  }
  return botsRoot
}
