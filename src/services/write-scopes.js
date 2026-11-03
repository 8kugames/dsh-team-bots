// src/services/write-scopes.js —— 写范围（write scopes）纯函数
// 任务可声明自己会写工作区里的哪些路径；调度器据此判断同项目两个写运行能否并行。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { badRequest } from '../errors.js'
import { jsonParse } from '../util.js'

// ── 写范围（write scopes）────────────────────────────────────────────────
// 任务可以声明自己会写工作区里的哪些路径（相对项目工作目录）。调度器据此判断同项目的
// 两个写运行能否并行：两侧都声明且路径前缀互不重叠才放行；任一未声明（空集合）按保守
// 串行处理——既有安全边界不因并行能力而削弱。
export const WRITE_SCOPE_MAX = 50

export const WRITE_SCOPE_MAX_LEN = 240

// 归一化单条写范围路径：相对项目工作目录，去掉 ./ 与尾部 /，拒绝绝对路径与 ..。
export function normalizeScopePath(raw) {
  const value = String(raw ?? '').trim().replace(/\\/g, '/')
  if (!value || value.startsWith('/')) return null
  const parts = value.split('/').filter(part => part && part !== '.')
  if (!parts.length || parts.some(part => part === '..')) return null
  return parts.join('/')
}

// 解析外部输入（数组或 JSON 字符串）：非法条目直接报错，不静默降级。
export function parseWriteScopes(input) {
  if (input === undefined || input === null) return []
  const list = typeof input === 'string' ? jsonParse(input, null) : input
  if (!Array.isArray(list)) throw badRequest('写范围必须是路径数组')
  if (list.length > WRITE_SCOPE_MAX) throw badRequest(`写范围最多 ${WRITE_SCOPE_MAX} 条`)
  const scopes = []
  for (const item of list) {
    if (typeof item !== 'string') throw badRequest('写范围必须是路径数组')
    const path = normalizeScopePath(item)
    if (!path) throw badRequest(`写范围包含非法路径：${item}`)
    if (path.length > WRITE_SCOPE_MAX_LEN) throw badRequest(`写范围路径过长（上限 ${WRITE_SCOPE_MAX_LEN} 字符）`)
    if (!scopes.includes(path)) scopes.push(path)
  }
  // package.json 由版本钩子机械改动（.githooks/pre-commit 每次提交 bump patch 位），
  // 不纳入写范围锁（DSHBOTS-133）：声明出口直接剥掉，新任务从源头不带它。
  return scopes.filter(scope => scope !== 'package.json')
}

// 兜底解析：任务描述里行首的 `写范围：a, b` 或 `write_scopes: a, b` 行（中英文冒号、
// 逗号/顿号分隔、每项 trim）。必须行首，避免误伤句中提及；多条命中取第一条。
// 解析结果交给 parseWriteScopes 校验，非法项直接报错；未命中返回 []，保持保守串行。
const DESCRIPTION_SCOPE_LINE = /(?:^|\n)[ \t]*(?:写范围|write_scopes)[ \t]*[：:][ \t]*([^\n]+)/i

export function parseWriteScopesFromDescription(description) {
  const match = DESCRIPTION_SCOPE_LINE.exec(String(description ?? ''))
  if (!match) return []
  return parseWriteScopes(match[1].split(/[,，、]/).map(item => item.trim()).filter(Boolean))
}

// 读取库里的写范围快照：坏数据一律降级成「未声明」，即保守串行。
export function readWriteScopes(raw) {
  if (raw === undefined || raw === null || raw === '') return []
  const list = typeof raw === 'string' ? jsonParse(raw, null) : raw
  if (!Array.isArray(list)) return []
  const scopes = []
  for (const item of list) {
    if (typeof item !== 'string') return []
    const path = normalizeScopePath(item)
    if (!path || path.length > WRITE_SCOPE_MAX_LEN) return []
    if (!scopes.includes(path)) scopes.push(path)
  }
  return scopes
}

// 两条写范围路径是否指向同一片区域：相等，或一方是另一方的目录前缀（按路径分段比较）。
export function writeScopePathsOverlap(left, right) {
  if (left === right) return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

// 两个写范围集合是否冲突。空集合 = 未声明 = 冲突（保守串行）。
export function writeScopesOverlap(a, b) {
  const left = readWriteScopes(a)
  const right = readWriteScopes(b)
  if (!left.length || !right.length) return true
  return left.some(x => right.some(y => writeScopePathsOverlap(x, y)))
}

// 写范围锁豁免（DSHBOTS-133）：package.json 是版本钩子的机械改动（pre-commit 每次提交
// bump patch 位），任何任务都会碰它，纳入写范围会让同项目所有写运行两两判交叠、全队列串行。
// 闸门比对前用它过滤双侧：只剥路径恰为 'package.json' 的条目，scripts/、src/ 等不受影响。
// 入参口径与 readWriteScopes 一致（数组或库里快照），过滤后为空即按「未声明」保守串行。
export function effectiveWriteScopes(scopes) {
  return readWriteScopes(scopes).filter(scope => scope !== 'package.json')
}
