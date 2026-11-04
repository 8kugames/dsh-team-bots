// 通用工具函数：转义、格式化、状态徽标与 toast。依赖 state.js 的运行态与枚举。
import { state, STATUS, RUN_STATUS, FILE_POLICY, DEFAULT_FILE_POLICY } from './state.js'

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
  if (type === 'user' || (!type && (id === 'user' || id === 'owner'))) return state.data?.me?.name || '用户'
  if (type === 'bot' || (!type && id.startsWith('bot_'))) {
    const bot = botById(id)
    if (bot) return `${bot.name}·${bot.role || '成员'}`
    return `已删除 Bot · ${shortRefId(id)}`
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
  if (value === null || value === undefined) return '未配置'
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
  if (ms < 45_000) return '刚刚'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`
  if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)} 天前`
  return new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
export function formatTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
export function duration(start, end) {
  if (!start) return '—'
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}
export function initials(name) {
  const text = String(name ?? '?').trim()
  return /^[A-Za-z]/.test(text) ? text.slice(0, 2).toUpperCase() : text.slice(0, 2)
}
export function avatar(bot, size = '') {
  return `<div class="avatar ${attr(bot?.color ?? 'gray')} ${size}">${esc(initials(bot?.name ?? '?'))}</div>`
}
export function statusPill(status, text = STATUS[status] ?? status) {
  const tone = status === 'done' ? 'green' : status === 'blocked' || status === 'canceled' ? 'red' : status === 'in_review' ? 'violet' : status === 'in_progress' ? 'amber' : ''
  return `<span class="pill ${tone}">${esc(text)}</span>`
}
export function runDot(status) {
  return `<span class="run-dot ${attr(status ?? '')}" title="${attr(RUN_STATUS[status] ?? '未运行')}"></span>`
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
  return `<span class="pill ${tone}" title="${attr(`生效沙箱档位：${mode}`)}">沙箱 ${esc(mode)}</span>`
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
      ? { cls: 'running', status: 'running', text: '运行中' }
      : { cls: 'idle', status: 'queued', text: '排队中（按空闲计）' }
  }
  if (status === 'plan_wait') return { cls: 'plan-wait', status: 'plan_wait', text: `限流等待，约 ${waitMin} 分钟后自动重试` }
  if (status === 'failed') return { cls: 'failed', status: 'failed', text: '最近运行失败' }
  return { cls: 'idle', status: 'idle', text: '空闲' }
}
export function runDotHtml(dot) {
  return `<span class="run-dot ${dot.cls}" data-status="${dot.status}" title="${esc(dot.text)}" aria-label="${esc(dot.text)}"></span>`
}
// 卡片底部的状态短标签（完整说明仍在 run-dot 的 title 里）。
export const MEMBER_STATUS_TEXT = { idle: '空闲', running: '运行中', queued: '排队中', plan_wait: '限流等待', failed: '运行失败' }
export function memorySource(source) {
  const value = String(source ?? '')
  if (!value) return '手动写入'
  if (value === 'chat-command') return '群聊指令'
  if (value.startsWith('run:')) return '运行沉淀'
  if (value.startsWith('session:')) return '会话沉淀'
  return '自动沉淀'
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

