// ui/modules/task-menu.ts —— 任务卡上下文菜单：键盘跨列移动的通路。
// 入口：卡片聚焦后按菜单键（ContextMenu）/ Shift+F10，或触屏长按（contextmenu 事件）。
// 菜单列出目标列，选中即 transition_task——与鼠标拖拽落列走同一后端动作。
import { STATUS_ORDER } from './state.js'
import { api } from './api.js'
import { t } from './i18n.js'
import { attr, esc, taskById, toast } from './util.js'
import { refresh } from '../app.js'

// 看板列名 → 词典键（字面量键才在英文界面有对应文案）。
const STATUS_LABEL_KEYS = {
  backlog: 'status.backlog',
  todo: 'status.todo',
  in_progress: 'status.in_progress',
  blocked: 'status.blocked',
  in_review: 'status.in_review',
  done: 'status.done',
  canceled: 'status.canceled',
}

function statusLabel(status) {
  const key = STATUS_LABEL_KEYS[status]
  return key ? t(key) : String(status ?? '')
}

// ===== task-menu:start —— 纯逻辑标记块（tests/task-a11y.test.js 抽取断言）=====
// 目标列清单：排除当前列，其余列都是可选的移动目标。
function moveTargets(statusOrder, current) {
  return (statusOrder ?? []).filter(status => status !== current)
}
// ===== task-menu:end =====

function menuMarkup(task) {
  const items = moveTargets(STATUS_ORDER, task?.status).map(status => (
    `<button type="button" class="task-menu-item" role="menuitem" data-move-status="${attr(status)}">${esc(statusLabel(status))}</button>`
  )).join('')
  const label = t('task.moveMenuLabel')
  return `<div class="task-menu" role="menu" aria-label="${attr(label)}">
    <div class="task-menu-title">${esc(label)}</div>${items}</div>`
}

let menuEl: HTMLElement | null = null
let menuTaskId = ''
// 菜单锚点：开菜单时的那张任务卡。开菜单时焦点已移到菜单项上，卡片不再持焦，
// 关闭后要还焦只能靠记住的锚点（查 :focus 必空——焦点已被菜单抢走）。
let menuAnchor: HTMLElement | null = null

function ensureRoot() {
  let root = document.getElementById('task-menu-root')
  if (!root) {
    root = document.createElement('div')
    root.id = 'task-menu-root'
    document.body.appendChild(root)
  }
  return root
}

export function closeTaskMenu(restoreFocus = false) {
  const root = document.getElementById('task-menu-root')
  if (root) root.innerHTML = ''
  menuEl = null
  menuTaskId = ''
  const anchor = menuAnchor
  menuAnchor = null
  if (restoreFocus && anchor) {
    try { anchor.focus() } catch {}
  }
}

export function openTaskMenu(task, anchor) {
  if (!task) return
  closeTaskMenu()
  const root = ensureRoot()
  root.innerHTML = menuMarkup(task)
  menuEl = root.firstElementChild as HTMLElement | null
  menuTaskId = String(task.id ?? '')
  menuAnchor = anchor ?? null
  const rect = anchor?.getBoundingClientRect?.()
  if (menuEl && rect) {
    const top = Math.min(rect.bottom + 6, window.innerHeight - 260)
    const left = Math.min(rect.left, window.innerWidth - 240)
    menuEl.style.top = `${Math.max(8, top)}px`
    menuEl.style.left = `${Math.max(8, left)}px`
  }
  const first = menuEl?.querySelector('.task-menu-item') as HTMLElement | null
  if (first) first.focus()
}

// 从事件目标定位任务卡并开菜单：找不到卡或卡不在数据里就不开。
export function openTaskMenuForElement(el) {
  const card = (el as HTMLElement)?.closest?.('.task-card') as HTMLElement | null
  if (!card) return false
  const task = taskById(card.dataset.taskId)
  if (!task) return false
  openTaskMenu(task, card)
  return true
}

async function moveTask(taskId, status) {
  try {
    await api('transition_task', { taskId, status })
    await refresh()
    toast(`${t('任务已移动到')} ${statusLabel(status)}`, 'success')
  } catch (error: any) {
    toast(error?.message || String(error), 'error')
  }
}

// 菜单项点击：移动任务并收起菜单。
document.addEventListener('click', event => {
  const item = (event.target as HTMLElement).closest?.('.task-menu-item') as HTMLElement | null
  if (item) {
    event.preventDefault()
    const status = item.dataset.moveStatus
    const taskId = menuTaskId
    closeTaskMenu()
    if (status && taskId) void moveTask(taskId, status)
    return
  }
  if (menuEl && !menuEl.contains(event.target as Node)) closeTaskMenu()
})

// 菜单内键盘导航：上下键移动、Esc 关闭并把焦点还给卡片。
document.addEventListener('keydown', event => {
  if (!menuEl) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeTaskMenu(true)
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const items = Array.from(menuEl.querySelectorAll('.task-menu-item')) as HTMLElement[]
  if (!items.length) return
  event.preventDefault()
  const index = items.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
  items[next]?.focus()
})

// 长按 / 右键：触屏长按会派发 contextmenu，鼠标右键同理——都开同一张卡菜单。
document.addEventListener('contextmenu', event => {
  const card = (event.target as HTMLElement).closest?.('.task-card') as HTMLElement | null
  if (!card) return
  if (!openTaskMenuForElement(card)) return
  event.preventDefault()
})

