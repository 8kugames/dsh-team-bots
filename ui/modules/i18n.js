// ui/modules/i18n.js —— 轻量 i18n（DSHBOTS-120 Phase 1）
// 字典在 ../i18n/<lang>.js（key → 文案，zh 为源语言）。t(key, params) 支持 ${name} 插值；
// 当前语言缺 key 时回退中文原文并 console.warn，中文也缺时返回 key 本身（保证不漏白屏）。
// DOM（document.documentElement.lang）只在浏览器环境碰，node --test 下可直接 import 断言。

import zh from '../i18n/zh.js'
import en from '../i18n/en.js'

const DICTS = { zh, en }
let current = 'zh'

// 语言值收敛：en* → en，zh* → zh；'auto'/空 = 宿主未显式设定，跟随浏览器
// （navigator.language 同前缀语义），其余一律缺省 zh。
export function normalizeLanguage(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text.startsWith('en')) return 'en'
  if (text.startsWith('zh')) return 'zh'
  if (!text || text === 'auto') {
    const nav = String(globalThis.navigator?.language ?? '').toLowerCase()
    return nav.startsWith('en') ? 'en' : 'zh'
  }
  return 'zh'
}

export function setLanguage(value) {
  current = normalizeLanguage(value)
  if (typeof document !== 'undefined') {
    document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN'
  }
  return current
}

export function getLanguage() {
  return current
}

// 文案取值：当前语言 → 中文原文 → key 本身，逐级回退；后两级 console.warn 留痕。
// params 提供 ${name} 插值；缺的插值名保留 ${name} 原样（可见信号，不静默吞数据）。
export function t(key, params = null) {
  const dict = DICTS[current] ?? zh
  let text = dict[key]
  if (text === undefined) {
    text = zh[key]
    if (text === undefined) {
      console.warn(`[i18n] missing key: ${key}`)
      return String(key)
    }
    console.warn(`[i18n] key "${key}" missing in "${current}", fallback to zh`)
  }
  if (!params) return text
  return text.replace(/\$\{(\w+)\}/g, (match, name) => (
    params[name] === undefined || params[name] === null ? match : String(params[name])
  ))
}
