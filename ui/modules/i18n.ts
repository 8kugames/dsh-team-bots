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
