// src/services/attention-schema.js —— 结构化提问（attention）字段：独立迁移 + 规范化。
//
// 背景：bot 想问人时过去只能写自由文本，接收方无法区分「在问人」与「在陈述」。
// 这里只接受显式给出的结构化字段，不从任何自由文本反推（正则猜问号一律不做）。
//
// 迁移独立成文件的原因：src/db.js 已贴 800 行红线（HEAD 版本已 818 行），迁移不写进 db.js。
// 手法与 src/services/approvals.js 的 ensureApprovalSchema、src/services/tasks.js 的
// ensureTaskTimesSchema 同款：schema_migrations 幂等守卫 + PRAGMA 判列 + ALTER TABLE。

import { nowIso } from '../util.js'

export const ATTENTION_MIGRATION = 'runs_attention'
export const ATTENTION_QUESTION_MAX = 200
export const ATTENTION_OPTIONS_MAX = 4
export const ATTENTION_OPTION_MAX = 200

// 同一个 store 只做一次迁移（WeakSet 记忆，store 生命周期内零额外查询）。
const migrated = new WeakSet()

// runs 表加 attention_json 列（结构化提问的 JSON 文本），迁移名 runs_attention。
export function ensureAttentionSchema(store) {
  if (!store || migrated.has(store)) return
  const columns = store.all('PRAGMA table_info(runs)').map(column => column.name)
  if (!columns.includes('attention_json')) {
    store.exec('ALTER TABLE runs ADD COLUMN attention_json TEXT')
  }
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    ATTENTION_MIGRATION,
    nowIso(),
  )
  migrated.add(store)
}

// 规范化结构化提问：question 必填且截断到 200 字，options 最多 4 条。
// 非法输入一律降级为 null（视为没有提问），不抛错。
export function normalizeAttention(raw) {
  if (!raw || typeof raw !== 'object') return null
  const question = String(raw.question ?? '').trim().slice(0, ATTENTION_QUESTION_MAX)
  if (!question) return null
  const options = Array.isArray(raw.options)
    ? raw.options
      .map(option => String(option ?? '').trim().slice(0, ATTENTION_OPTION_MAX))
      .filter(Boolean)
      .slice(0, ATTENTION_OPTIONS_MAX)
    : []
  return options.length ? { question, options } : { question }
}

// 读库里的 attention_json → 结构化对象；坏数据一律降级为 null。
export function parseAttention(raw) {
  if (!raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return normalizeAttention(parsed)
}
