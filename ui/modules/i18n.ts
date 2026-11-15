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

// 静默取值：字典里没有该键时原样返回，不告警。
// 给后端下发的自由文本用（轨迹里的工具名、运行结束原因等）——它们大多不是词典键，
// 原样显示即可，不该刷 console.warn；落在词典里的（如后端兜底写的中文词）照常翻译。
export function tMaybe(key, fallback = key) {
  const dict = DICTS[current] ?? zh
  if (dict[key] !== undefined) return dict[key]
  if (zh[key] !== undefined) return zh[key]
  return fallback
}
