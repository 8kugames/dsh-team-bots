// DSHBOTS-70 粘贴文件路径补全：解析剪贴板 file:// URI、按文件名在固定根目录白名单里只读反查绝对路径。
// 浏览器安全边界决定粘贴拿到的 File 对象只有 name/type/bytes、没有本地绝对路径；
// 全路径唯一可靠来源是剪贴板里的 file:// URI（macOS Finder 复制时部分浏览器会给 text/uri-list，Chromium 通常不给），
// 所以本模块与前端 ui/app.js 的 paste 分发共同构成「能拿就拿、拿不到就反查、仍拿不到就贴文件名」的三段式。
// 安全口径：只读（绝不写、绝不删）；查找根目录白名单在本文件写死（工作区根由调用方从服务配置注入），
// 不接受任何 HTTP 入参指定的根目录；文件名闸只放行纯文件名，含 / 或 .. 的输入直接丢弃（纵深防御——
// 反查实现只拿 readdir 的 entry 名做等值比较、从不拼路径，穿越本就走不通，闸是第二道保险）。
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { badRequest } from '../errors.js'

// 单次反查的名字上限：一次粘贴最多 20 个文件，超出直接拒绝，防扫描放大。
export const PASTE_NAMES_MAX = 20
// 递归查找深度上限：根目录自身为第 0 层，子目录逐层 +1，最多进到第 3 层。
export const PASTE_WALK_MAX_DEPTH = 3
// 一次反查遍历的总条目上限（跨全部根目录累计）：配额耗尽即停止深入，已收集的命中保留，避免大目录卡死。
export const PASTE_WALK_MAX_ENTRIES = 5000
// 永不进入的目录名：依赖目录与版本库体积大且不可能贴进聊天。
const PASTE_SKIP_DIRS = new Set(['node_modules', '.git', '.dist'])

// 从 text/uri-list 或 text/plain 文本里抠出 file:// URI 并还原成绝对路径。
// 逐行扫描：空行与 # 注释行跳过；非 file:// 丢弃；只认 POSIX 形态（file:///…），
// 带主机名的罕见形态（file://localhost/…）一并丢弃，不猜。坏百分号编码 decode 失败也丢弃。
// 去重保序：重复 URI 只留第一个。
export function parseFileUriList(text) {
  const out = []
  const seen = new Set()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.startsWith('file://')) continue
    const rest = line.slice('file://'.length)
    if (!rest.startsWith('/')) continue
    let decoded
    try {
      decoded = decodeURIComponent(rest)
    } catch {
      continue
    }
    if (!decoded.startsWith('/') || decoded.includes('\0')) continue
    if (seen.has(decoded)) continue
    seen.add(decoded)
    out.push(decoded)
  }
  return out
}

// 文件名闸：只放行纯文件名。空名、. 、以及含 / 或 .. 的输入一律拒绝（保守口径，宁可少反查也不放宽）。
export function isSafeLookupName(name) {
  const value = String(name ?? '')
  return value !== '' && value !== '.' && !value.includes('/') && !value.includes('..')
}

// 单目录只读遍历：命中名字收集进 matches，返回是否还该继续（配额是否已耗尽）。
// depth 为当前目录深度（根=0）；无权限/已消失的目录静默跳过，不让一个坏目录毁掉整次反查；
// 符号链接不跟随（防环、防逃出根目录）。
function walkDir(dir, nameSet, matches, depth, maxDepth, entriesLeft) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entriesLeft.count <= 0) return
    entriesLeft.count -= 1
    if (entry.isFile() && nameSet.has(entry.name)) {
      matches.get(entry.name).push(join(dir, entry.name))
    } else if (entry.isDirectory() && depth < maxDepth && !PASTE_SKIP_DIRS.has(entry.name)) {
      walkDir(join(dir, entry.name), nameSet, matches, depth + 1, maxDepth, entriesLeft)
    }
  }
}

// 按文件名在给定根目录里反查。roots 必须由调用方写死注入（见 resolvePastedPaths），绝不来自外部输入。
// 每个名字返回 { name, matches:[绝对路径…], chosen }：唯一命中 chosen=该路径；多命中或零命中 chosen=null——
// 宁缺毋滥，多个同名文件时绝不替用户挑一个。非法名字（含 / 或 ..）直接从结果里消失，调用方按拿不到处理。
// limits 仅供测试注入 maxDepth / maxEntries，生产调用不传。
export function resolveNames(names, roots, limits = {}) {
  const maxDepth = Number.isInteger(limits.maxDepth) && limits.maxDepth >= 0 ? limits.maxDepth : PASTE_WALK_MAX_DEPTH
  const maxEntries = Number.isInteger(limits.maxEntries) && limits.maxEntries > 0 ? limits.maxEntries : PASTE_WALK_MAX_ENTRIES
  const wanted = []
  for (const item of Array.isArray(names) ? names : [names]) {
    const value = String(item ?? '').trim()
    if (!isSafeLookupName(value) || wanted.includes(value)) continue
    wanted.push(value)
  }
  const nameSet = new Set(wanted)
  const matches = new Map(wanted.map(name => [name, []]))
  const entriesLeft = { count: maxEntries }
  const seenRoots = new Set()
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string' || !root.trim()) continue
    const dir = resolve(root)
    if (seenRoots.has(dir) || entriesLeft.count <= 0) continue
    seenRoots.add(dir)
    walkDir(dir, nameSet, matches, 0, maxDepth, entriesLeft)
  }
  return wanted.map(name => {
    const list = [...matches.get(name)].sort((a, b) => a.localeCompare(b))
    return { name, matches: list, chosen: list.length === 1 ? list[0] : null }
  })
}

// 反查根目录白名单：工作区根（调用方注入）+ ~/Desktop + ~/Downloads——粘贴的文件几乎都来自这三处。
export function pasteLookupRoots(workspaceRoot) {
  const home = homedir()
  const roots = []
  for (const dir of [workspaceRoot, join(home, 'Desktop'), join(home, 'Downloads')]) {
    if (typeof dir === 'string' && dir.trim()) roots.push(resolve(dir))
  }
  return [...new Set(roots)]
}

// API 入口（action: resolve_pasted_paths，src/api.js 委托）：只认 names 数组，
// payload 里传任何根目录字段一律忽略。只读、无缓存、不落库。
export function resolvePastedPaths(workspaceRoot, payload = {}) {
  const raw = Array.isArray(payload?.names) ? payload.names : null
  if (!raw) throw badRequest('names 必须是文件名数组')
  if (raw.length > PASTE_NAMES_MAX) throw badRequest(`一次最多反查 ${PASTE_NAMES_MAX} 个文件名`)
  const roots = pasteLookupRoots(workspaceRoot)
  return { roots, results: resolveNames(raw, roots) }
}
