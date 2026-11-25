// 宿主集成工具面的「按需」口径。MCP 服务器、引擎桥这类工具由宿主在根作用域注册，所有 Agent
// 可见——preset 的插件清单管不到它们，团队 bot 的每次调用因此都带着用不上的工具定义（实测
// taptap-maker 一家就 62k 字符）。这里按项目工作区的标记文件判定「这个项目用不用这族工具」：
// 有标记才放行，其余对团队 bot 的会话隐藏。隐藏只作用于工具面（tools.restrict）；宿主注入
// 系统提示词的 MCP 路由说明不归这里管。
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 默认对团队 bot 隐藏的工具名前缀：全部 MCP 服务器 + godot-bridge 这类引擎桥。
export const DEFAULT_HIDE_TOOL_PREFIXES = ['mcp__', 'godot_']
// 按需放行：键是工具名前缀，值是工作区相对路径（文件或目录）。项目工作区里有这个路径，
// 这一族工具才对它的团队 bot 会话可见。
export const DEFAULT_TOOL_FAMILY_MARKERS = {
  'mcp__codegraph__': '.codegraph',
  'mcp__taptap-maker__': '.project/project.json',
  godot_: 'project.godot',
}

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
