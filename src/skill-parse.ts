import { basename, dirname } from 'node:path'

// 技能包（SKILL.md）解析：frontmatter 优先，缺失时回退到目录名与正文首段。
export function parseSkill(raw, locator) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const metadata: any = {}
  if (frontmatter?.[1]) {
    for (const line of frontmatter[1].split('\n')) {
      const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
      if (match) metadata[match[1]] = match[2].replace(/^["']|["']$/g, '').trim()
    }
  }
  const body = raw.slice(frontmatter?.[0]?.length ?? 0)
  const declaredName = metadata.name || ''
  const declaredDescription = metadata.description || ''
  const name = declaredName || basename(dirname(locator)) || basename(locator, '.md')
  const description = declaredDescription || firstParagraph(body)
  return {
    name,
    description: description.slice(0, 500),
    version: metadata.version || '1.0.0',
    content: body.trim(),
    raw,
    // frontmatter 里显式声明的字段，用于按宿主规则判定技能名/描述是否合法。
    declaredName,
    declaredDescription,
  }
}

export const firstParagraph = (value) => String(value)
  .split(/\r?\n/)
  .map(line => line.trim())
  .find(line => line !== '' && !line.startsWith('#')) ?? ''
