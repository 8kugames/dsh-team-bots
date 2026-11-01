// 项目技能池：从项目工作区的 .agents / .claude / .codex 三个根发现技能包。
// 只做发现与展示，不写入共享技能池，也不改动项目文件。
// 同名技能按根优先级 .agents > .claude > .codex 去重，被覆盖的来源记录在 duplicates 里。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseSkill } from './skill-parse.js'

export const PROJECT_SKILL_ROOTS = ['.agents', '.claude', '.codex']

// 宿主校验技能名用的规则：kebab-case 小写。
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function projectSkillRoots(projectDir) {
  return PROJECT_SKILL_ROOTS.map(root => ({
    root,
    path: join(projectDir, root),
    skillsPath: join(projectDir, root, 'skills'),
  }))
}

// 会话工作目录 → 项目目录。只接受工作区的一级子目录（项目目录），
// 排除 _the_bots（单聊工作区）与点目录（共享技能根等）。
export function resolveProjectSkillDir(workspace, cwd) {
  if (!cwd || !workspace) return null
  const target = resolve(cwd)
  const base = resolve(workspace)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const parts = rel.split(sep)
  if (parts.length !== 1) return null
  if (parts[0].startsWith('.') || parts[0] === '_the_bots') return null
  return target
}

function readPackage(rootPath, dirName) {
  const file = join(rootPath, dirName, 'SKILL.md')
  if (!existsSync(file)) return null
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const parsed = parseSkill(raw, file)
  const name = SKILL_NAME.test(parsed.declaredName)
    ? parsed.declaredName
    : (SKILL_NAME.test(dirName) ? dirName : '')
  const description = parsed.description.trim()
  if (!name || !description) return null
  return { name, slug: dirName, description, version: parsed.version, path: file }
}

// 扫描项目技能池，返回去重后的技能列表。
export function scanProjectSkills(projectDir) {
  if (!projectDir) return { skills: [], skipped: 0 }
  const packages = []
  let skipped = 0
  for (const { root, skillsPath } of projectSkillRoots(projectDir)) {
    if (!existsSync(skillsPath)) continue
    let children = []
    try {
      children = readdirSync(skillsPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const pkg = readPackage(skillsPath, child.name)
      if (!pkg) {
        skipped += 1
        continue
      }
      packages.push({ ...pkg, root })
    }
  }
  const ordered = [...packages].sort((a, b) => (
    PROJECT_SKILL_ROOTS.indexOf(a.root) - PROJECT_SKILL_ROOTS.indexOf(b.root)
    || a.slug.localeCompare(b.slug)
  ))
  const skills = []
  const index = new Map()
  for (const pkg of ordered) {
    const existing = index.get(pkg.name)
    if (existing) {
      if (!existing.roots.includes(pkg.root)) existing.roots.push(pkg.root)
      existing.duplicates.push({ root: pkg.root, slug: pkg.slug, path: pkg.path })
      continue
    }
    const entry = {
      name: pkg.name,
      slug: pkg.slug,
      description: pkg.description,
      version: pkg.version,
      path: pkg.path,
      root: pkg.root,
      roots: [pkg.root],
      duplicates: [],
      relativePath: relative(projectDir, pkg.path).split(sep).join('/'),
    }
    index.set(pkg.name, entry)
    skills.push(entry)
  }
  return { skills, skipped }
}
