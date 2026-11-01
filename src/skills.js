import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { ensureSkillRoot } from './paths.js'
import { parseSkill } from './skill-parse.js'
import { resolveProjectSkillDir, scanProjectSkills } from './project-skills.js'
import { nowIso, sha256, slugify } from './util.js'

const PROVIDER = 'dsh-team-skills'

// 候选 rank 越小越优先：项目技能优先于共享技能池。
const PROJECT_RANKS = { '.agents': 100, '.claude': 110, '.codex': 120 }
const SHARED_RANK = 700

export { parseSkill }

// 技能目录结构：skills/{slug}/SKILL.md 为当前版本，versions/{version}.md 保留历史版本，
// current.json 记录当前指针，便于回滚与追溯。
export function skillDir(root, slug) {
  return join(root, 'skills', slug)
}

export function versionDir(root, slug) {
  return join(skillDir(root, slug), 'versions')
}

export function versionPath(root, slug, version) {
  return join(versionDir(root, slug), `${version}.md`)
}

export function currentPointerPath(root, slug) {
  return join(skillDir(root, slug), 'current.json')
}

export function readCurrentPointer(root, slug) {
  const pointer = currentPointerPath(root, slug)
  if (!existsSync(pointer)) return null
  try {
    return JSON.parse(readFileSync(pointer, 'utf8'))
  } catch {
    return null
  }
}

function listVersionFiles(root, slug) {
  const dir = versionDir(root, slug)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => name.slice(0, -3))
    .sort()
}

// 技能当前生效的文件位置：优先取版本指针，回退到平铺的 SKILL.md；
// 两者都不存在即表示这个技能已从技能根目录里移除。
export function resolveSkillLocator(skillRoot, slug) {
  const pointer = readCurrentPointer(skillRoot, slug)
  if (pointer?.path && existsSync(pointer.path)) {
    return { locator: pointer.path, version: pointer.version ?? null }
  }
  const flat = join(skillDir(skillRoot, slug), 'SKILL.md')
  if (existsSync(flat)) return { locator: flat, version: pointer?.version ?? null }
  return null
}

export function scanSkills(skillRoot) {
  const root = join(skillRoot, 'skills')
  if (!existsSync(root)) return []
  const entries = []
  for (const child of readdirSync(root, { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    const directory = join(root, child.name)
    const resolved = resolveSkillLocator(skillRoot, child.name)
    if (!resolved) continue
    const locator = resolved.locator
    try {
      const raw = readFileSync(locator, 'utf8')
      const parsed = parseSkill(raw, locator)
      entries.push({
        slug: child.name,
        name: parsed.name,
        description: parsed.description,
        version: resolved.version || parsed.version,
        path: locator,
        checksum: sha256(raw),
        resourceBase: directory,
        raw,
      })
    } catch {
      continue
    }
  }
  return entries.sort((a, b) => a.slug.localeCompare(b.slug))
}

export function syncSkills(store, skillRoot) {
  const entries = scanSkills(skillRoot)
  const seen = new Set()
  for (const entry of entries) {
    seen.add(entry.slug)
    store.run(
      `INSERT INTO skills(slug, name, description, version, path, checksum, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name, description = excluded.description, version = excluded.version,
         path = excluded.path, checksum = excluded.checksum, status = 'active', updated_at = excluded.updated_at`,
      entry.slug,
      entry.name,
      entry.description,
      entry.version,
      entry.path,
      entry.checksum,
      nowIso(),
    )
    store.run(
      `INSERT INTO skill_versions(slug, version, path, checksum, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT(slug, version) DO UPDATE SET path = excluded.path, checksum = excluded.checksum, status = 'active'`,
      entry.slug,
      entry.version,
      entry.path,
      entry.checksum,
      nowIso(),
    )
    for (const version of listVersionFiles(skillRoot, entry.slug)) {
      if (version === entry.version) continue
      const path = versionPath(skillRoot, entry.slug, version)
      store.run(
        `INSERT INTO skill_versions(slug, version, path, checksum, status, created_at)
         VALUES (?, ?, ?, ?, 'archived', ?)
         ON CONFLICT(slug, version) DO UPDATE SET path = excluded.path, checksum = excluded.checksum`,
        entry.slug,
        version,
        path,
        sha256(readFileSync(path, 'utf8')),
        nowIso(),
      )
    }
  }
  for (const row of store.all("SELECT slug FROM skills WHERE status = 'active'")) {
    if (!seen.has(row.slug)) store.run("UPDATE skills SET status = 'missing', updated_at = ? WHERE slug = ?", nowIso(), row.slug)
  }
  return entries
}

// 技能 provider：共享技能池 + 当前会话所在项目的项目技能池。
// 项目技能按 .agents > .claude > .codex 优先级去重，且优先于同名共享技能。
export function skillProvider(skillRoot, options = {}) {
  const resolveProjectDir = options.resolveProjectDir ?? (() => null)
  const list = (cwd) => {
    const candidates = []
    const projectDir = resolveProjectDir(cwd)
    if (projectDir) {
      for (const skill of scanProjectSkills(projectDir).skills) {
        candidates.push({
          name: skill.name,
          description: skill.description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: PROVIDER,
          source: 'project',
          rank: PROJECT_RANKS[skill.root] ?? 200,
          resourceBase: { kind: 'directory', path: dirname(skill.path).split(sep).join('/') },
          locator: skill.path,
          version: skill.version,
        })
      }
    }
    for (const entry of scanSkills(skillRoot)) {
      candidates.push({
        name: entry.slug,
        description: entry.description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER,
        source: 'workspace',
        rank: SHARED_RANK,
        resourceBase: { kind: 'directory', path: entry.resourceBase.split(sep).join('/') },
        locator: entry.path,
        version: entry.version,
      })
    }
    // 同一个 provider 内按技能名去重：rank 小的（项目技能）优先。
    const seen = new Set()
    return candidates.filter(candidate => {
      if (seen.has(candidate.name)) return false
      seen.add(candidate.name)
      return true
    })
  }
  return {
    name: PROVIDER,
    list: async (opts) => list(opts?.cwd),
    async get(candidate) {
      const locator = candidate.locator
      const raw = readFileSync(locator, 'utf8')
      const parsed = parseSkill(raw, locator)
      return { ...candidate, description: parsed.description, content: parsed.content }
    },
  }
}

export function installSkillProvider(ctx, config, logger) {
  ctx.inject?.({ skills: null }, scope => {
    try {
      scope.skills.registerProvider(() => skillProvider(config.skillRoot, {
        resolveProjectDir: (cwd) => resolveProjectSkillDir(config.workspace, cwd),
      }))
      logger?.info?.('shared skill provider registered: %s', config.skillRoot)
    } catch (error) {
      logger?.warn?.('shared skill provider failed: %s', error)
    }
  })
}

function buildSkillRaw({ name, description, version, content }) {
  const frontmatter = [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(String(description || '').slice(0, 500))}`,
    `version: ${JSON.stringify(version)}`,
    '---',
    '',
  ].join('\n')
  return `${frontmatter}${content}\n`
}

export async function publishSkill(config, { slug, name, description, content, version = '1.0.0' }) {
  const cleanSlug = slugify(slug)
  if (!cleanSlug) throw new Error('技能 slug 无效')
  const cleanVersion = String(version || '1.0.0').replace(/[^0-9A-Za-z._-]/g, '') || '1.0.0'
  const root = await ensureSkillRoot(config.workspace)
  const body = String(content ?? '').trim()
  if (!body) throw new Error('技能内容不能为空')
  const directory = skillDir(root, cleanSlug)
  mkdirSync(versionDir(root, cleanSlug), { recursive: true })
  const raw = buildSkillRaw({ name: name || cleanSlug, description, version: cleanVersion, content: body })
  const archived = versionPath(root, cleanSlug, cleanVersion)
  writeFileSync(archived, raw, 'utf8')
  const flat = join(directory, 'SKILL.md')
  writeFileSync(flat, raw, 'utf8')
  const pointer = { version: cleanVersion, path: archived, checksum: sha256(raw), publishedAt: nowIso() }
  writeFileSync(currentPointerPath(root, cleanSlug), `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
  return { slug: cleanSlug, locator: archived, flatPath: flat, version: cleanVersion, checksum: pointer.checksum, raw }
}

// 灰度暂存：只落版本文件，不切换当前指针，供 canary 审批后按项目绑定生效。
export async function stageSkill(config, { slug, name, description, content, version = '1.0.0' }) {
  const cleanSlug = slugify(slug)
  if (!cleanSlug) throw new Error('技能 slug 无效')
  const cleanVersion = String(version || '1.0.0').replace(/[^0-9A-Za-z._-]/g, '') || '1.0.0'
  const root = await ensureSkillRoot(config.workspace)
  const body = String(content ?? '').trim()
  if (!body) throw new Error('技能内容不能为空')
  mkdirSync(versionDir(root, cleanSlug), { recursive: true })
  const raw = buildSkillRaw({ name: name || cleanSlug, description, version: cleanVersion, content: body })
  const archived = versionPath(root, cleanSlug, cleanVersion)
  writeFileSync(archived, raw, 'utf8')
  return { slug: cleanSlug, locator: archived, version: cleanVersion, checksum: sha256(raw), raw }
}

// 回滚：把当前指针指回历史版本，并同步平铺副本。
export function rollbackSkill(config, { slug, version }) {
  const cleanSlug = slugify(slug)
  const root = config.skillRoot
  const archived = versionPath(root, cleanSlug, String(version))
  if (!existsSync(archived)) throw new Error('技能历史版本不存在')
  const raw = readFileSync(archived, 'utf8')
  const directory = skillDir(root, cleanSlug)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), raw, 'utf8')
  const pointer = { version: String(version), path: archived, checksum: sha256(raw), publishedAt: nowIso() }
  writeFileSync(currentPointerPath(root, cleanSlug), `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
  return { slug: cleanSlug, locator: archived, version: String(version), checksum: pointer.checksum, raw }
}

// 技能池快照：只暴露技能根目录里当前存在的技能。
// 文件已被移除的记录仍留在库里（便于追溯），但不再出现在列表与补全里。
export function skillSnapshot(store, config) {
  const rows = store.all('SELECT * FROM skills ORDER BY status, slug')
  const snapshots = []
  for (const row of rows) {
    const resolved = resolveSkillLocator(config.skillRoot, row.slug)
    if (!resolved) continue
    const versions = store.all(
      'SELECT version, path, checksum, status, created_at FROM skill_versions WHERE slug = ? ORDER BY created_at DESC, version DESC',
      row.slug,
    )
    const version = resolved.version || row.version
    snapshots.push({
      ...row,
      status: 'active',
      path: resolved.locator,
      version,
      exists: true,
      currentVersion: version,
      versions,
      sharedPath: join(config.skillRoot, 'skills', row.slug, 'SKILL.md'),
      relativePath: resolved.locator.startsWith(config.workspace)
        ? resolved.locator.slice(config.workspace.length + 1)
        : resolved.locator,
    })
  }
  return snapshots
}
