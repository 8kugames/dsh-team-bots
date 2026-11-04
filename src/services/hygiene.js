// src/services/hygiene.js —— 代码卫生域（DSHBOTS-172）
// 单文件行数约定：项目设置 code_hygiene_limit_lines（NULL = 默认 800，0 = 关闭）。
// 每轮运行结束（run-finish 钩子）扫描项目工作区内的文本源码文件，超过约定上限
// 110% 即向项目群发一条【系统指令】系统消息（列出文件+行数+上限，要求总监安排
// 拆分卡）。同一文件告警一次后，在其行数回落到判定线以内之前不重复告警。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods），
// 方法体内的 this 与其他域一致（this.store / this.config / this.logger）。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { jsonParse } from '../util.js'

// 约定默认上限（项目未设置时）；0 = 关闭检查。
export const CODE_HYGIENE_DEFAULT_LIMIT = 800
// 超标判定比例：行数 > limit × 1.1 才告警（800 → 880 不报、881 报）。
export const CODE_HYGIENE_OVER_RATIO = 1.1
// 单文件扫描体积上限：超过按超大文件跳过（误命名的二进制、数据集、生成数据）。
export const CODE_HYGIENE_MAX_FILE_BYTES = 2 * 1024 * 1024
// 告警消息里最多列出的文件数，超出折算成「……等 N 个」。
export const CODE_HYGIENE_LIST_MAX = 10

// 扫描时整目录跳过（目录名精确匹配；所有隐藏目录一律跳过，覆盖 .git/.codegraph 等）。
// assets 是本仓房规的媒体资产目录约定名，与 node_modules 等生成物目录并列排除。
export const CODE_HYGIENE_IGNORED_DIRS = new Set([
  'node_modules', 'assets', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', '__pycache__',
])

// 生成物/锁文件按文件名跳过：行数是生成器的输出，不是维护者的债。
export const CODE_HYGIENE_IGNORED_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.lock', 'Cargo.lock', 'poetry.lock',
])

// 默认扩展名白名单：文本源码与结构化源码（不含 md/图片/字体等非代码文本）。
// 可经全局配置 DSH_TEAM_CODE_HYGIENE_EXTS / config.codeHygieneExts 覆盖。
export const DEFAULT_CODE_HYGIENE_EXTS = [
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'vue', 'svelte', 'astro',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'dart',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'php',
  'sh', 'bash', 'zsh', 'ps1', 'lua', 'sql', 'prisma', 'graphql',
  'css', 'scss', 'sass', 'less', 'html', 'htm',
  'json', 'yml', 'yaml', 'toml', 'env', 'gitignore', 'dockerfile',
]

// 告警去重状态键：settings 表单键，值为 JSON map { 相对路径: true }。
// 文件回落到判定线以内（或从工作区消失）即从 map 摘除，之后再次超标可重新告警。
export const codeHygieneAlertedKey = (projectId) => `code_hygiene_alerted:${projectId}`

// 生效上限：NULL/未设置 → 默认 800；非法值 → 默认 800；负数按 0（关闭）。
export function effectiveCodeHygieneLimit(project) {
  const raw = project?.code_hygiene_limit_lines
  if (raw === null || raw === undefined) return CODE_HYGIENE_DEFAULT_LIMIT
  const num = Number(raw)
  if (!Number.isFinite(num)) return CODE_HYGIENE_DEFAULT_LIMIT
  return Math.max(0, Math.trunc(num))
}

// 生效扩展名白名单：config 覆盖（非空数组）> 默认白名单；统一收敛成带点小写 Set。
export function effectiveCodeHygieneExtensions(config) {
  const custom = Array.isArray(config?.codeHygieneExts) ? config.codeHygieneExts : []
  const list = custom.some(ext => String(ext ?? '').trim()) ? custom : DEFAULT_CODE_HYGIENE_EXTS
  const normalized = list
    .map(ext => String(ext ?? '').trim().toLowerCase())
    .map(ext => (ext.startsWith('.') ? ext : `.${ext}`))
    .filter(ext => ext !== '.')
  return new Set(normalized)
}

// 文本行数：按换行符计数，结尾无换行的末行也计 1，空文件为 0。
export function countTextLines(content) {
  if (!content) return 0
  let newlines = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) newlines++
  }
  return content.endsWith('\n') ? newlines : newlines + 1
}

// 遍历工作区收集白名单内文件的行数（相对路径 → 行数）。
// 纯函数（只依赖入参），目录不可读/文件读失败逐项跳过不抛出。
export function scanCodeHygieneFiles(dir, { exts, ignoredDirs = CODE_HYGIENE_IGNORED_DIRS, ignoredFiles = CODE_HYGIENE_IGNORED_FILES, maxFileBytes = CODE_HYGIENE_MAX_FILE_BYTES } = {}) {
  const files = []
  const walk = (current, prefix) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) continue
        walk(join(current, entry.name), rel)
        continue
      }
      if (!entry.isFile()) continue
      if (ignoredFiles.has(entry.name)) continue
      if (!exts.has(extname(entry.name).toLowerCase())) continue
      const full = join(current, entry.name)
      try {
        if (statSync(full).size > maxFileBytes) continue
        files.push({ path: rel, lines: countTextLines(readFileSync(full, 'utf8')) })
      } catch {
        // 读不到（权限/竞态删除等）按跳过处理
      }
    }
  }
  walk(dir, '')
  return files
}

export const hygieneMethods = {
  // 生效行数上限（0 = 关闭）。项目视图与扫描共用同一口径。
  codeHygieneLimit(project) {
    return effectiveCodeHygieneLimit(project)
  },

  // 代码卫生扫描（run-finish 钩子调用；也可独立调用）。全程 try/catch：
  // 卫生检查永远不能破坏运行收尾主流程。
  runCodeHygieneScan(project, runId = null) {
    try {
      if (!project?.id) return { skipped: 'no_project' }
      const limit = this.codeHygieneLimit(project)
      if (limit <= 0) return { skipped: 'disabled' }
      const threshold = Math.floor(limit * CODE_HYGIENE_OVER_RATIO)
      const dir = this.projectWorkDir(project)
      const files = scanCodeHygieneFiles(dir, { exts: effectiveCodeHygieneExtensions(this.config) })
      const over = files.filter(file => file.lines > threshold)
      const settingKey = codeHygieneAlertedKey(project.id)
      const alerted = jsonParse(this.store.setting(settingKey), {}) ?? {}
      // 新超标（本次越线且未告警过）→ 待告警；已告警但本次未越线 → 摘除，恢复再告警资格。
      const toAlert = over.filter(file => !alerted[file.path])
      const recovered = Object.keys(alerted).filter(path => !over.some(file => file.path === path))
      if (toAlert.length === 0 && recovered.length === 0) return { limit, threshold, scanned: files.length, over: over.length, alerted: [] }
      for (const file of toAlert) alerted[file.path] = true
      for (const path of recovered) delete alerted[path]
      if (toAlert.length > 0) {
        const listed = toAlert.slice(0, CODE_HYGIENE_LIST_MAX)
        const more = toAlert.length - listed.length
        const body = [
          `【系统指令】代码卫生告警：${toAlert.length} 个文件超过单文件行数约定（约定上限 ${limit} 行，判定线 ${threshold} 行 = ${Math.round(CODE_HYGIENE_OVER_RATIO * 100)}%）。`,
          ...listed.map(file => `- ${file.path}（${file.lines} 行）`),
          more > 0 ? `……等共 ${toAlert.length} 个超标文件` : '',
          '请项目总监安排拆分卡，将超标文件按职责拆分到约定上限以内。',
        ].filter(Boolean).join('\n')
        this.insertMessage({
          projectId: project.id,
          senderType: 'system',
          senderId: 'system',
          runId,
          body,
        })
        if (runId) {
          this.insertRunEvent(runId, 'code_hygiene_alert', `代码卫生告警：${toAlert.length} 个文件超过 ${threshold} 行判定线`)
        }
      }
      this.store.setSetting(settingKey, JSON.stringify(alerted))
      return { limit, threshold, scanned: files.length, over: over.length, alerted: toAlert.map(file => file.path), recovered }
    } catch (error) {
      this.logger?.warn?.(`dsh-team: 代码卫生扫描失败（${project?.key ?? project?.id ?? 'unknown'}）：${error?.message ?? error}`)
      return { error: String(error?.message ?? error) }
    }
  },
}
