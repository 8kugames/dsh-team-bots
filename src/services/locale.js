// src/services/locale.js —— DSH 宿主语言偏好读取（DSHBOTS-120 Phase 1）
// 官方 locale 插件 @deepseek-ai/dsh-client-locale 把用户选择持久在
// ~/.dsh/profiles/<profile>/cordis.patch.yml 的 `- id: locale` 条目 config.preference；
// 插件页面拿不到 __DSH_LOCALE__ 桥与 gateway RPC，只能在服务端读取。
// 读取顺序：①同进程 loader 直读活配置（改动即时生效）→②profile patch 文件静态扫描→
// ③两处都没有显式设定时返回 'auto'（客户端按 navigator.language 解析，缺省 zh）——
// 与官方插件「absence delegates to the browser」语义对齐。

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const LOCALE_PLUGIN_ID = 'locale'
export const LOCALE_PLUGIN_PACKAGE = '@deepseek-ai/dsh-client-locale'
// UI 语言候选集，与官方插件 LOCALE_IDS 一致。
export const UI_LANGUAGES = ['zh', 'en']

// BCP47 前缀收敛：en* → en，zh* → zh，其余（空/非法/未知语言）→ null（=未显式设定）。
export function clampLocaleId(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text.startsWith('en')) return 'en'
  if (text.startsWith('zh')) return 'zh'
  return null
}

// 同进程直读：Loader.store 是以 profile 条目 id 为键的 Dict<Entry>（Map 子类）；
// 活配置在 entry.fiber.config（schema 校验后的运行值），原始值在 entry.options.config。
// 先按条目 id（'locale'）命中，再按插件包名兜底；该 profile 未启用官方插件时返回 null。
export function localePreferenceFromLoader(loader) {
  if (!loader) return null
  let entries = []
  try {
    if (typeof loader.entries === 'function') entries = [...loader.entries()]
    else if (loader.store) entries = [...(loader.store.values?.() ?? [])]
  } catch {
    entries = []
  }
  const entry = entries.find(item => item?.options?.id === LOCALE_PLUGIN_ID)
    ?? entries.find(item => String(item?.options?.name ?? '') === LOCALE_PLUGIN_PACKAGE)
  if (!entry) return null
  const preference = entry.fiber?.config?.preference ?? entry.options?.config?.preference
  return preference === undefined ? null : preference
}

// 剥掉 YAML 标量两侧成对引号；!!js 表达式等非标量原样返回（交给 clamp 判非法）。
function yamlScalar(text) {
  const value = String(text ?? '').trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

// patch 文件静态扫描（loader 不可达时的兜底）：只认 dsh 写出的固定两层结构——
// 顶层 `- id: <id>` 起（2 空格）字段 `name:`/`config:`，（4 空格）config 字段 `preference:`。
// 找不到 locale 条目或该条目没有 preference 时返回 null。
export function localePreferenceFromPatchYml(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  let matched = false
  let configIndent = null
  let preference = null
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    if (indent === 0) {
      // 顶层新条目（`- id: xxx`）或顶层其它内容：重置条目匹配状态。
      matched = false
      configIndent = null
      const inline = /^-\s*([\w.$-]+)\s*:\s*(.*)$/.exec(trimmed)
      if (inline && inline[1] === 'id' && yamlScalar(inline[2]) === LOCALE_PLUGIN_ID) matched = true
      continue
    }
    if (!matched) continue
    const field = /^([\w.$-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (configIndent === null) {
      if (field?.[1] === 'name' && yamlScalar(field[2]) === LOCALE_PLUGIN_PACKAGE) matched = true
      else if (field?.[1] === 'config') configIndent = indent
      continue
    }
    if (indent <= configIndent) {
      // config 块结束；回到字段层，允许后续再出现 config:（防御性，实际文件不会）。
      configIndent = null
      continue
    }
    if (field?.[1] === 'preference' && preference === null) preference = yamlScalar(field[2])
  }
  return preference
}

// 三级兜底编排：loader → patch 文件 → 'auto'。任何一级读到合法值（en*/zh*）即收敛返回。
export async function resolveDshUiLanguage({ loader = null, dshHome = null, profile = '' } = {}) {
  const fromLoader = clampLocaleId(localePreferenceFromLoader(loader))
  if (fromLoader) return fromLoader
  try {
    const home = dshHome || resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
    const text = await readFile(join(home, 'profiles', profile || 'team-bots', 'cordis.patch.yml'), 'utf8')
    const fromFile = clampLocaleId(localePreferenceFromPatchYml(text))
    if (fromFile) return fromFile
  } catch {
    // 文件不存在/不可读 = 无显式设定，落到 auto。
  }
  return 'auto'
}
