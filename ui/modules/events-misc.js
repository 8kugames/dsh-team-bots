// 事件接线：输入/键盘/粘贴/滚动/拖拽等零散监听（原 app.js 的 misc 段）。
import { state, STATUS } from './state.js'
import { icon } from './icons.js'
import { applyUiScale, toast } from './util.js'
import { api } from './api.js'
import { COMPOSER_AUTO_MAX_PX, addPendingImages, applyAutocomplete, closeAutocomplete, composerPanelCap, insertTextAtCursor, moveAcSelection, parseFileUriList, resolveImageMediaType, sendMessage, syncComposerBox, thumbnailFallback, updateAutocomplete } from './composer.js'
import { questionDraftOf } from './cards.js'
import { searchMemories } from './tasks.js'
import { closeModal, trapModalFocus, updateEffortOptions, updateFallbackEffortOptions } from './modal-forms.js'
import { UI_SCALE_KEY, renderShell, renderKeepingChatScroll, panelKey, applyPanelToggle, nextChatAtBottom, render, refresh } from '../app.js'

document.addEventListener('input', (event) => {
  const el = event.target
  el.closest?.('form')?.setAttribute('data-dirty', '1')
  if (el.id === 'remove-tracking-name') {
    // 输入项目名与待移除项目完全一致才点亮执行按钮；不属于此弹窗时跳过。
    const submitBtn = document.getElementById('remove-tracking-submit')
    if (submitBtn) submitBtn.disabled = el.value !== state.modal?.name
    return
  }
  if (el.id === 'ui-scale') {
    const scale = applyUiScale(el.value)
    try { localStorage.setItem(UI_SCALE_KEY, String(scale)) } catch {}
    const value = document.getElementById('ui-scale-value')
    if (value) value.textContent = `${Math.round(scale * 100)}%`
    return
  }
  if (el.id === 'composer-input') {
    state.composerInputAt = Date.now()
    syncComposerBox(el)
    updateAutocomplete()
  }
  if (el.id === 'task-search') {
    state.taskFilter.search = el.value
  }
  if (el.id === 'memory-search') {
    state.memoryQuery = el.value
  }
  if (el.id === 'terminal-cmd-input') {
    state.terminalDraft = el.value
  }
  // 提问卡补充说明（DSHBOTS-116）：只写草稿不重绘，避免整页重建吞掉输入焦点与未提交内容。
  if (el.classList?.contains('question-custom')) {
    const questionId = el.dataset.questionId
    const itemId = el.dataset.itemId
    if (questionId && itemId) questionDraftOf(questionId).custom[itemId] = el.value
  }
})

// IME 组词标记（DSHBOTS-123）：组词期间 composition 事件不总是伴随常规 input 节奏，
// 单独记 composerComposing，让轮询渲染闸门在组词全程让路；compositionend 后回到静默窗判定。
document.addEventListener('compositionstart', (event) => {
  if (event.target?.id === 'composer-input') state.composerComposing = true
})
document.addEventListener('compositionend', (event) => {
  if (event.target?.id === 'composer-input') state.composerComposing = false
})

// select / checkbox 只发 change 不发 input，同样要计入未保存修改。
document.addEventListener('change', (event) => {
  event.target.closest?.('form')?.setAttribute('data-dirty', '1')
  // 邀请弹窗：单选后放开「确认邀请」按钮，并把选择记在 state.modal 上（重渲染后仍保持）。
  if (state.modal?.type === 'invite-member' && event.target?.name === 'botId') {
    state.modal.botId = String(event.target.value || '')
    const submit = document.getElementById('invite-member-submit')
    if (submit) submit.disabled = !state.modal.botId
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && state.modal) {
    trapModalFocus(event)
    return
  }
  const tab = event.target.closest?.('[role="tab"]')
  if (tab && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
    const index = tabs.indexOf(tab)
    const next = event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs[tabs.length - 1]
      : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    next?.focus()
    next?.click()
    return
  }
  if (state.ac && event.target.id === 'composer-input') {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveAcSelection(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      applyAutocomplete(state.ac.items[state.ac.selected])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAutocomplete()
      return
    }
  }
  // 图片查看器：Esc 关闭（优先级高于 modal 与 composer 快捷键）。
  if (event.key === 'Escape' && !document.getElementById('image-viewer')?.hidden) {
    event.preventDefault()
    closeImageViewer()
    return
  }
  if (event.key === 'Escape' && state.modal) {
    closeModal()
    return
  }
  // 引用条：Esc 取消（优先级低于补全与 modal，高于 composer 快捷键）。
  if (event.key === 'Escape' && state.replyTo) {
    event.preventDefault()
    state.replyTo = null
    renderKeepingChatScroll()
    return
  }
  if (event.target.id === 'composer-input' && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    void sendMessage()
    return
  }
  if (event.target.id === 'task-search' && event.key === 'Enter') {
    event.preventDefault()
    render()
    return
  }
  if (event.target.id === 'memory-search' && event.key === 'Enter') {
    event.preventDefault()
    void searchMemories()
    return
  }
  if (event.target.id === 'terminal-cmd-input' && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    document.querySelector('form[data-form="terminal-run"]')?.requestSubmit()
    return
  }
})

document.addEventListener('mousedown', (event) => {
  if (event.target.closest('.composer-ac-item')) {
    event.preventDefault()
    return
  }
  if (state.ac && !event.target.closest('.composer-box')) closeAutocomplete()
})

document.addEventListener('click', (event) => {
  const el = event.target.closest('.composer-ac-item')
  if (!el || !state.ac) return
  applyAutocomplete(state.ac.items[Number(el.dataset.acIdx)])
})

// 粘贴分发（DSHBOTS-70）：document 级委托——#composer-input 在 renderShell 里被 2.8s 轮询重建，
// 监听挂节点会随节点一起被换掉（D-64 同类根因）。target 不是 composer 就完全放行，纯文本粘贴行为不变。
document.addEventListener('paste', (event) => {
  const input = event.target
  if (input?.id !== 'composer-input') return
  const files = Array.from(event.clipboardData?.files ?? [])
  if (files.length === 0) return
  // 剪贴板里是文件（截图/复制的文件），接管默认行为：图片走现有校验与待发通道（顺带补上粘贴截图能力），
  // 不支持的类型从剪贴板文本里找 file:// 绝对路径；都拿不到就明说，不静默、不猜路径。
  event.preventDefault()
  const images = files.filter(file => resolveImageMediaType(file.type, file.name))
  if (images.length > 0) void addPendingImages(images)
  if (images.length === files.length) return
  const data = event.clipboardData
  const paths = parseFileUriList(data.getData('text/uri-list') || data.getData('text/plain'))
  if (paths.length > 0) {
    insertTextAtCursor(input, paths.join('\n'))
  } else {
    insertTextAtCursor(input, files.map(file => file.name || '未命名文件').join('\n'))
    toast('浏览器未提供完整路径', 'error')
  }
})

// 待发缩略图兜底（DSHBOTS-75）：捕获阶段接资源 error，破图当场换成「图标 + 文件名」占位。
// 不用内联 onerror——CSP script-src 'self' 会把内联处理器一起拦掉。
document.addEventListener('error', (event) => {
  const target = event.target
  if (!(target instanceof HTMLImageElement)) return
  if (!target.classList.contains('image-thumb-img')) return
  if (target.dataset.fallbackApplied === '1') return
  target.dataset.fallbackApplied = '1'
  target.replaceWith(thumbnailFallback(target.getAttribute('alt') || '', icon('image'), target.ownerDocument ?? document))
}, true)

document.addEventListener('change', (event) => {
  const el = event.target
  // composer 选图：先把文件列表取出来（清空 input 后 FileList 会失效），再交给前端校验 + 读取。
  if (el.id === 'composer-image-input') {
    const files = Array.from(el.files ?? [])
    el.value = ''
    if (files.length > 0) void addPendingImages(files)
    return
  }
  if (el.matches('[data-task-filter]')) {
    state.taskFilter[el.dataset.taskFilter] = el.value
    render()
  }
  // 任务排序（D-63）：组内重排，不动分组与父子层级。
  if (el.matches('[data-task-sort]')) {
    state.taskSort = el.value
    render()
  }
  if (el.matches('[data-model-select]')) updateEffortOptions(el)
  if (el.matches('[data-fallback-model-select]')) updateFallbackEffortOptions(el)
  if (el.id === 'secret-scope') {
    const projectSelect = document.getElementById('secret-project')
    if (projectSelect) {
      projectSelect.disabled = el.value !== 'project'
      if (el.value !== 'project') projectSelect.value = ''
    }
  }
})

document.addEventListener('scroll', (event) => {
  const el = event.target
  if (!el?.classList?.contains('chat-messages')) return
  // 判定口径抽成纯函数 nextChatAtBottom：渲染窗口内与已脱离文档的节点保持原值（DSHBOTS-72）。
  state.chatAtBottom = nextChatAtBottom({
    rendering: state.rendering,
    connected: el.isConnected,
    current: state.chatAtBottom,
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
  })
}, true)

// 折叠面板展开态：toggle 不冒泡，在 document 捕获阶段统一记录 <details data-panel> 的展开/收起（含 modal 里的面板）。
document.addEventListener('toggle', (event) => {
  applyPanelToggle(state, panelKey(event.target), event.target.open)
}, true)

// composer 拖柄：按住垂直拖动调整输入框高度，最小不低于当前内容的自动高度，最大不超过面板 61.8%；双击恢复自动高度。
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest?.('.composer-resizer')) return
  const input = document.getElementById('composer-input')
  if (!input) return
  event.preventDefault()
  const startY = event.clientY
  const startHeight = input.offsetHeight
  input.style.height = 'auto'
  const minHeight = Math.min(COMPOSER_AUTO_MAX_PX, input.scrollHeight)
  const capHeight = composerPanelCap(input)
  const lowerBound = Math.min(minHeight, capHeight)
  const onMove = (moveEvent) => {
    state.composerHeight = Math.min(Math.max(Math.round(startHeight - (moveEvent.clientY - startY)), lowerBound), capHeight)
    input.style.height = `${state.composerHeight}px`
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
})
document.addEventListener('dblclick', (event) => {
  if (!event.target.closest?.('.composer-resizer')) return
  const input = document.getElementById('composer-input')
  if (!input) return
  state.composerHeight = null
  applyComposerHeight(input)
})

let draggedTask = null
document.addEventListener('dragstart', (event) => {
  const card = event.target.closest('.task-card')
  if (!card) return
  draggedTask = card.dataset.taskId
  card.classList.add('dragging')
  event.dataTransfer.effectAllowed = 'move'
  try { event.dataTransfer.setData('text/plain', draggedTask) } catch {}
})
document.addEventListener('dragend', () => {
  document.querySelectorAll('.task-card.dragging').forEach(card => card.classList.remove('dragging'))
  document.querySelectorAll('.column.drop-target').forEach(column => column.classList.remove('drop-target'))
  draggedTask = null
})
document.addEventListener('dragover', (event) => {
  const column = event.target.closest('.column[data-drop-status]')
  if (!column || !draggedTask) return
  event.preventDefault()
  document.querySelectorAll('.column.drop-target').forEach(item => { if (item !== column) item.classList.remove('drop-target') })
  column.classList.add('drop-target')
})
document.addEventListener('drop', async (event) => {
  const column = event.target.closest('.column[data-drop-status]')
  if (!column || !draggedTask) return
  event.preventDefault()
  const taskId = draggedTask
  const status = column.dataset.dropStatus
  try {
    await api('transition_task', { taskId, status })
    await refresh()
    toast(`任务已移动到 ${STATUS[status]}`, 'success')
  } catch (error) {
    toast(error.message || String(error), 'error')
  }
})
