import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { ensureSkillRoot } from './paths.js'
import { nowIso, sha256, slugify } from './util.js'

const PROVIDER = 'dsh-team-skills'

export function parseSkill(raw, locator) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const metadata = {}
  if (frontmatter?.[1]) {
    for (const line of frontmatter[1].split('\n')) {
      const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
      if (match) metadata[match[1]] = match[2].replace(/^["']|["']$/g, '').trim()
    }
  }
  const name = metadata.name || basename(dirname(locator)) || basename(locator, '.md')
  const description = metadata.description || firstParagraph(raw.slice(frontmatter?.[0]?.length ?? 0))
  return {
    name,
    description: description.slice(0, 500),
    version: metadata.version || '1.0.0',
    content: raw.slice(frontmatter?.[0]?.length ?? 0).trim(),
    raw,
  }
}

const firstParagraph = (value) => String(value)
  .split(/\r?\n/)
  .map(line => line.trim())
  .find(line => line !== '' && !line.startsWith('#')) ?? ''

export function scanSkills(skillRoot) {
  const root = join(skillRoot, 'skills')
  if (!existsSync(root)) return []
  const entries = []
  for (const child of readdirSync(root, { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    const locator = join(root, child.name, 'SKILL.md')
    if (!existsSync(locator)) continue
    try {
      const raw = readFileSync(locator, 'utf8')
      const parsed = parseSkill(raw, locator)
      entries.push({
        slug: child.name,
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        path: locator,
        checksum: sha256(raw),
        resourceBase: join(root, child.name),
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
  }
  for (const row of store.all("SELECT slug FROM skills WHERE status = 'active'")) {
    if (!seen.has(row.slug)) store.run("UPDATE skills SET status = 'missing', updated_at = ? WHERE slug = ?", nowIso(), row.slug)
  }
  return entries
}

export function skillProvider(skillRoot) {
  const list = () => scanSkills(skillRoot).map(entry => ({
    name: entry.slug,
    description: entry.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'workspace',
    rank: 700,
    resourceBase: { kind: 'directory', path: entry.resourceBase.split(sep).join('/') },
    locator: entry.path,
    version: entry.version,
  }))
  return {
    name: PROVIDER,
    list: async () => list(),
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
      scope.skills.registerProvider(() => skillProvider(config.skillRoot))
      logger?.info?.('shared skill provider registered: %s', config.skillRoot)
    } catch (error) {
      logger?.warn?.('shared skill provider failed: %s', error)
    }
  })
}

export async function publishSkill(config, { slug, name, description, content, version = '1.0.0' }) {
  const cleanSlug = slugify(slug)
  if (!cleanSlug) throw new Error('技能 slug 无效')
  const cleanVersion = String(version || '1.0.0').replace(/[^0-9A-Za-z._-]/g, '') || '1.0.0'
  const root = await ensureSkillRoot(config.workspace)
  const directory = join(root, 'skills', cleanSlug)
  mkdirSync(directory, { recursive: true })
  const locator = join(directory, 'SKILL.md')
  const body = String(content ?? '').trim()
  if (!body) throw new Error('技能内容不能为空')
  const frontmatter = [
    '---',
    `name: ${JSON.stringify(name || cleanSlug)}`,
    `description: ${JSON.stringify(String(description || '').slice(0, 500))}`,
    `version: ${JSON.stringify(cleanVersion)}`,
    '---',
    '',
  ].join('\n')
  const raw = `${frontmatter}${body}\n`
  writeFileSync(locator, raw, 'utf8')
  const archiveDir = join(root, '.history', cleanSlug)
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(join(archiveDir, `${cleanVersion}-${sha256(raw).slice(0, 8)}.md`), raw, 'utf8')
  return { slug: cleanSlug, locator, version: cleanVersion, checksum: sha256(raw), raw }
}

export function skillSnapshot(store, config) {
  const rows = store.all('SELECT * FROM skills ORDER BY status, slug')
  return rows.map(row => ({
    ...row,
    exists: existsSync(row.path),
    sharedPath: `/workspace/.agents/skills/${row.slug}/SKILL.md`,
    relativePath: row.path.startsWith(config.workspace) ? row.path.slice(config.workspace.length + 1) : row.path,
  }))
}
