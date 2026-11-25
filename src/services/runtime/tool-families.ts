// 宿主集成工具面（MCP 服务器、引擎桥等）由宿主在根作用域注册，所有 Agent 可见——preset 的
// 插件清单管不到它们，部署里团队 bot 用不上的工具定义会随每次调用重复计费。选择启用「按需」
// 口径的部署，在这里按项目工作区的标记文件判定「这个项目用不用这族工具」：有标记才放行，其余
// 对团队 bot 的会话隐藏。隐藏只作用于工具面（tools.restrict）；宿主注入系统提示词的 MCP 路由
// 说明不归这里管。
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 缺省不隐藏任何工具：各部署的宿主集成面（MCP 服务器、引擎桥）不同，写死清单会把别人的
// 工具藏掉。要用「按项目按需」口径的部署，通过配置显式给出隐藏前缀与「前缀 = 工作区标记」
// 映射（示例见 .env.example）；没配 = 工具面与宿主全局一致。
export const DEFAULT_HIDE_TOOL_PREFIXES: string[] = []
export const DEFAULT_TOOL_FAMILY_MARKERS: Record<string, string> = {}

export function parseHideToolPrefixes(raw): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,;]+/)
  return list.map(item => String(item).trim()).filter(Boolean)
}

// 接受对象或 `prefix=path;prefix=path` 文本；没有 `=` 的片段忽略。
export function parseToolFamilyMarkers(raw): Record<string, string> {
  const markers: Record<string, string> = {}
  if (raw && typeof raw === 'object') {
    for (const [prefix, marker] of Object.entries(raw)) {
      if (prefix && typeof marker === 'string') markers[prefix] = marker
    }
    return markers
  }
  for (const part of String(raw ?? '').split(/[\n;]+/)) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const prefix = part.slice(0, at).trim()
    if (prefix) markers[prefix] = part.slice(at + 1).trim()
  }
  return markers
}

// 本项目会话的工具面口径：hide 里的前缀默认隐藏，allow 里的前缀（工作区有标记的那几族）放行。
// 没有项目目录（单聊）或 hide 为空时什么都不隐藏。
export function toolPolicyFor(config, projectDir): { hide: string[]; allow: string[] } {
  const hide = parseHideToolPrefixes(config?.hideToolPrefixes ?? DEFAULT_HIDE_TOOL_PREFIXES)
  if (!hide.length || !projectDir) return { hide: [], allow: [] }
  const markers = parseToolFamilyMarkers(config?.toolFamilyMarkers ?? DEFAULT_TOOL_FAMILY_MARKERS)
  const allow = Object.entries(markers)
    .filter(([prefix, marker]) => prefix && marker && existsSync(join(projectDir, marker)))
    .map(([prefix]) => prefix)
  return { hide, allow }
}

export function hiddenToolNames(policy: { hide: readonly string[]; allow: readonly string[] }, names: readonly string[]): string[] {
  return names.filter(name => policy.hide.some(prefix => name.startsWith(prefix))
    && !policy.allow.some(prefix => name.startsWith(prefix)))
}
