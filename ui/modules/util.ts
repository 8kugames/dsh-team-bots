import { state, STATUS, RUN_STATUS, FILE_POLICY, DEFAULT_FILE_POLICY } from './state.js'
import { t } from './i18n.js'

const toastRoot = document.getElementById('toast-root')
export function applyUiScale(value) {
  const scale = Math.min(1.4, Math.max(1, Number(value) || 1))
  document.documentElement.style.setProperty('--ui-scale', String(scale))
  return scale
}
export function applyUiTheme(value) {
  const theme = value === 'catppuccin' ? 'catppuccin' : 'dsh'
  if (theme === 'dsh') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
  return theme
}
export const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
export const attr = esc
export const pathCode = value => `<code>${esc(value).split('/').join('/<wbr>')}</code>`
// 工作区路径的显示缩写（DSHBOTS-186）：/Users/{用户} 或 /home/{用户} 前缀替换为 '~'，
// 其余前缀原样返回、空值归空串。仅用于展示位；复制（data-copy）、title 与请求载荷仍走完整路径。
export const tildePath = value => {
  const text = String(value ?? '')
  return text ? text.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~') : ''
}
export const costValue = value => {
  const text = formatCost(value)
  return /^[¥$€£]/.test(text) ? `<span class="unit">${esc(text[0])}</span>${esc(text.slice(1))}` : esc(text)
}
export const clamp = (value, max, fallback = '') => String(value ?? fallback).slice(0, max)
export const botById = (id) => state.data?.bots.find(bot => bot.id === id)
// 审批人/决定人标识形如 `bot:<id>`、`user:<id>`：bot 显示「名称·角色标签」，user 显示本地用户名；
// bot 已删除时回退短 id（对齐 team_recall 的 m_短id 口径，只取末 6 位），不暴露完整原始 id。
export const shortRefId = (id) => String(id ?? '').slice(-6)
export function actorLabel(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  const sep = value.indexOf(':')
  const type = sep >= 0 ? value.slice(0, sep) : ''
  const id = sep >= 0 ? value.slice(sep + 1) : value
  if (type === 'user' || (!type && (id === 'user' || id === 'owner'))) return state.data?.me?.name || t("用户")
  if (type === 'bot' || (!type && id.startsWith('bot_'))) {
    const bot = botById(id)
    if (bot) return `${bot.name}·${bot.role || t("成员")}`
    return t("已删除 Bot · ${id}", { id: shortRefId(id) })
  }
  return value
}
export const taskById = (id) => state.data?.tasks.find(task => task.id === id)
export const activeProject = () => state.data?.project
// 1V1 单聊上下文（对话/配置/技能/记忆/进化/用量）不携带任何项目，页面呈现团队全局口径。
export const inSoloContext = () => state.chatMode === 'solo' || state.view === 'solo-config'
export const pageProject = () => (inSoloContext() ? null : activeProject())
export const activeBots = () => (state.data?.bots ?? []).filter(bot => bot.status === 'active')

// format-tokens:start —— tokens/调用量展示的唯一格式化出口：k/m/b 标准进位，档内 <10 两位小数、≥10 一位小数（DSHBOTS-114），tests/token-format.test.js 按本标记块抽取断言。
export function formatNumber(value) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 1 : 2)}b`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 1 : 2)}k`
  return String(Math.round(n))
}
// format-tokens:end
export const CURRENCY_SYMBOL = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', JPY: '¥' }
export function formatCost(value, currency = 'CNY') {
  if (value === null || value === undefined) return t("未配置")
  const code = String(currency || 'CNY').toUpperCase()
  const symbol = CURRENCY_SYMBOL[code] ?? `${code} `
  if (value === 0) return `${symbol}0.00`
  if (value < 0.01) return `${symbol}${value.toFixed(4)}`
  return `${symbol}${value.toFixed(2)}`
}
export function timeAgo(value) {
  if (!value) return '—'
  const ms = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(ms)) return '—'
  if (ms < 45_000) return t("刚刚")
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} ${t("分钟前")}`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} ${t("小时前")}`
  if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)} ${t("天前")}`
  return new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
export function formatTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
export function duration(start, end?) {
  if (!start) return '—'
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}
// avatar:start —— 头像取字与渲染的唯一出口（DSHBOTS-221 收敛点，散点内联一律改调这里）。
// initials：英文名取首二字母大写；非英文（CJK 等）取首字——单字居中不换行，修复两字竖排撑破头像块。
export function initials(name) {
  const text = String(name ?? '?').trim()
  return /^[A-Za-z]/.test(text) ? text.slice(0, 2).toUpperCase() : text.slice(0, 1)
}
// identicon：GitHub 风格 5x5 镜像对称像素块头像（零依赖，纯 SVG 字符串内联）。
// seed 先过 FNV-1a 32 位散列，再逐位 xorshift 取随机：左半 3 列 × 5 行每位独立 50% 填充，
// 右两列沿中轴镜像；同 seed 同图。颜色不进 seed——沿用外层 .avatar 色类的 var(--av)。
export function identiconSvg(seed) {
  let hash = 0x811c9dc5
  const text = String(seed ?? '')
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const next = () => {
    hash ^= hash << 13; hash >>>= 0
    hash ^= hash >>> 17
    hash ^= hash << 5; hash >>>= 0
    return hash / 4294967296
  }
  let rects = ''
  for (let row = 0; row < 5; row++) {
    const left = [next() < 0.5, next() < 0.5, next() < 0.5]
    const cells = [left[0], left[1], left[2], left[1], left[0]]
    for (let col = 0; col < 5; col++) {
      if (cells[col]) rects += `<rect x="${col}" y="${row}" width="1" height="1"/>`
    }
  }
  return `<svg class="identicon" viewBox="0 0 5 5" aria-hidden="true">${rects}</svg>`
}
// roll 用的随机种子：字母数字短串，满足服务端 avatarSeedPattern 校验。
export const avatarSeedRandom = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
export function avatar(bot, size = '') {
  const seed = bot?.avatar_seed
  const content = seed ? identiconSvg(seed) : esc(initials(bot?.name ?? '?'))
  return `<div class="avatar ${attr(bot?.color ?? 'gray')} ${size}">${content}</div>`
}
// avatar:end
export function statusPill(status, text = STATUS[status] ?? status) {
  const tone = status === 'done' ? 'green' : status === 'blocked' || status === 'canceled' ? 'red' : status === 'in_review' ? 'violet' : status === 'in_progress' ? 'amber' : ''
  return `<span class="pill ${tone}">${esc(text)}</span>`
}
export function runDot(status) {
  return `<span class="run-dot ${attr(status ?? '')}" title="${attr(RUN_STATUS[status] ?? t("未运行"))}"></span>`
}

// sandbox-pill:start —— 生效沙箱档位的轻量标签（DSHBOTS-157）。
// 只复用既有 pill token（绿/琥珀/紫），零新增色值；档位色只回答「这次运行能不能写」，
// 不承载告警语义——read-only 是只读运行的常态，不做成红色。
const SANDBOX_TONE = {
  'read-only': 'amber',
  'workspace-write': 'green',
  'danger-full-access': 'violet',
}

export function sandboxPill(mode) {
  if (!mode) return ''
  const tone = SANDBOX_TONE[mode] ?? ''
  return `<span class="pill ${tone}" title="${attr(t("生效沙箱档位：${mode}", { mode: mode }))}">${t("沙箱")} ${esc(mode)}</span>`
}
// sandbox-pill:end
// 成员/总监状态点：红黄绿三色——空闲绿、运行中黄（且仅此态闪烁）、失败红（含限流等待）。
// 排队中按空闲处理（绿、不闪），只有真正 running 才闪。
export function memberRunDot(member) {
  const status = member?.run_status ?? 'idle'
  const phase = member?.run_phase ?? null
  const waitMin = member?.retry_wait_seconds ? Math.max(1, Math.round(member.retry_wait_seconds / 60)) : null
  if (status === 'running') {
    return phase === 'running'
      ? { cls: 'running', status: 'running', text: t("运行中") }
      : { cls: 'idle', status: 'queued', text: t("排队中（按空闲计）") }
  }
  if (status === 'plan_wait') return { cls: 'plan-wait', status: 'plan_wait', text: t("限流等待，约 ${waitMin} 分钟后自动重试", { waitMin: waitMin }) }
  if (status === 'failed') return { cls: 'failed', status: 'failed', text: t("最近运行失败") }
  return { cls: 'idle', status: 'idle', text: t("空闲") }
}
export function runDotHtml(dot) {
  return `<span class="run-dot ${dot.cls}" data-status="${dot.status}" title="${esc(dot.text)}" aria-label="${esc(dot.text)}"></span>`
}
export function memorySource(source) {
  const value = String(source ?? '')
  if (!value) return t("手动写入")
  if (value === 'chat-command') return t("群聊指令")
  if (value.startsWith('run:')) return t("运行沉淀")
  if (value.startsWith('session:')) return t("会话沉淀")
  return t("自动沉淀")
}

export function filePolicyOptions(current) {
  const value = FILE_POLICY[current] ? current : DEFAULT_FILE_POLICY
  return Object.entries(FILE_POLICY).map(([id, label]) => `<option value="${attr(id)}" ${value === id ? 'selected' : ''}>${esc(label)}</option>`).join('')
}

export function toast(message, type = '') {
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = message
  toastRoot.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateY(5px)'
    el.style.transition = 'opacity .2s, transform .2s'
    setTimeout(() => el.remove(), 220)
  }, 3600)
}

// 提案展示辅助（DSHBOTS-223 自 tasks.ts 迁入，tasks.ts 触及 800 行铁律）：
// 灰度范围、评估结论、payload 预览（instructions/skill 内容/兜底 JSON）三段纯格式化。
export function canaryText(canary) {
  if (!canary) return ''
  if (typeof canary === 'string') return canary
  if (typeof canary === 'object') {
    const parts = Object.entries(canary).map(([key, value]) => {
      const label = key === 'projectIds' ? t("项目") : key
      const values = Array.isArray(value) ? value.join(t("、")) : String(value)
      return `${label} ${values}`
    })
    return parts.join(' · ')
  }
  return String(canary)
}

export function evaluationText(evaluation) {
  if (!evaluation) return ''
  if (typeof evaluation === 'string') return evaluation
  const verdict = { pass: t("通过"), fail: t("不通过"), pending: t("待评估") }[evaluation.verdict] ?? evaluation.verdict ?? ''
  const notes = evaluation.notes ? `${t("：")}${evaluation.notes}` : ''
  const by = evaluation.evaluatedBy ? `${t("（")}${evaluation.evaluatedBy}${t("）")}` : ''
  return `${verdict}${notes}${by}`
}

export function proposalPreview(proposal) {
  const payload = proposal.payload ?? {}
  if (proposal.kind === 'skill') return payload.content || t("技能内容为空")
  if (proposal.kind === 'bot_update') {
    return [payload.role ? `role: ${payload.role}` : '', payload.instructions ? `instructions:\n${payload.instructions}` : '', payload.model ? `model: ${payload.provider}/${payload.model}` : ''].filter(Boolean).join('\n\n') || t("无配置内容")
  }
  return JSON.stringify(payload, null, 2)
}

