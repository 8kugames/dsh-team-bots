import { state } from './state.js'
import { attr, esc } from './util.js'
import { render, updateRunClocks } from '../app.js'
import { modalNewProject, modalRemoveTracking, modalRemoveBotTracking, modalBot, modalInviteMember, modalNewTask, modalTask, modalSkill, modalMemory, modalProposal, modalPrice, modalTrajectory } from './modal-forms.js'
import { modalFilePreview } from './file-preview.js'
import { t } from './i18n.js'

function modalShell({ title, subtitle = '', body = '', footer = '', size = '', badge = '' }) {
  return `<div class="modal-backdrop" data-action="modal-backdrop">
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${attr(title)}" tabindex="-1">
      <div class="modal-head">
        <div class="modal-head-main">${badge ? `<div class="eyebrow">${badge}</div>` : ''}<h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
        <button class="modal-close" data-action="close-modal" aria-label="${t("关闭")}">×</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>
  </div>`
}

function modalLoading(title) {
  return modalShell({
    title,
    body: `<div class="modal-loading"><div class="boot-mark sm">DSH</div><div>${t("正在读取数据")}…</div></div>`,
    footer: `<button class="btn" data-action="close-modal">${t("关闭")}</button>`,
    size: 'small',
  })
}

function renderModal() {
  const modal = state.modal
  if (!modal) return ''
  if (modal.loading) return modalLoading(modal.title || t("加载中"))
  switch (modal.type) {
    case 'new-project': return modalNewProject()
    case 'remove-tracking': return modalRemoveTracking()
    case 'bot-remove-tracking': return modalRemoveBotTracking()
    case 'new-bot': return modalBot(null)
    case 'invite-member': return modalInviteMember()
    case 'edit-bot': return modalBot(modal.detail)
    case 'new-task': return modalNewTask()
    case 'task': return modalTask(modal.detail)
    case 'skill-detail': return modalSkill(modal.detail)
    case 'memory': return modalMemory(modal.memory)
    case 'proposal': return modalProposal(modal.kind)
    case 'price': return modalPrice(modal.price ?? {})
    case 'trajectory': return modalTrajectory(modal.detail, modal.runId)
    case 'file-preview': return modalFilePreview(modal)
    default: return ''
  }
}

// modal-layer:start —— modal 与全量渲染解耦（DSHBOTS-90）
// 与 ensureComposerImageInput / ensureImageViewer 同一套 body 级常驻模式：#modal-root 在 #app 外，
// render() 只重建 #app，弹窗层在这里独立同步。同一弹窗刷新（loading→详情、保存/评论后的
// reloadTaskModal）只换内容：遮罩与 .modal 容器节点保持同一实例，.modal-body 节点原位保留，
// innerHTML 只替换其内部，弹窗滚动位与正在编辑的输入焦点不被拆掉；内容未变时零 DOM 操作。
let lastModalHtml = ''

// 两个 setter 供 app.js 写入本模块持有的可变状态（ESM 的 import 绑定不能跨模块赋值）。
function markAppRenderPending() { appRenderPending = true }
function noteModalScroll() { modalScrollAt = performance.now() }

// 滚动守卫（DSHBOTS-154）：modal-body 滚动进行中（最近 100ms 内有滚动事件，见模块尾的
// 捕获阶段 scroll 监听）不替换正文——原位补丁虽保留节点与 scrollTop，但整段子树重建在
// 滚动中肉眼可见。延后到滚动停止后补拍；关闭弹窗与首次挂载不延后（见 renderModalLayer 内闸门）。
let modalScrollAt = -1e9
let modalPatchTimer = null
function modalScrollRecent() {
  return performance.now() - modalScrollAt < 100
}
function scheduleModalPatch() {
  if (modalPatchTimer) return
  modalPatchTimer = setTimeout(() => {
    modalPatchTimer = null
    renderModalLayer()
  }, 120)
}

// overlay-render（DSHBOTS-98）：#modal-root 弹窗与 body 级 #image-viewer 同属半透明遮罩，
// 遮罩打开期间 #app 的全量重绘肉眼可见（闪烁）。轮询照常取数但跳过重建并记 pending，
// 遮罩关闭时 flushAppRender 补一次渲染追平最新 state。三个符号留在 modal-layer 块内：
// 本块会被测试整段抽出求值，render/state 只在 pending=true 的调用路径上被引用。
// state 在隔离求值时可能未定义（typeof 守卫），此时只看 DOM 层的遮罩。
let appRenderPending = false

function overlayOpen() {
  if (typeof state !== 'undefined' && state?.modal) return true
  const viewer = document.getElementById('image-viewer')
  return Boolean(viewer && !viewer.hidden)
}

function flushAppRender() {
  if (!appRenderPending || overlayOpen()) return
  appRenderPending = false
  render()
}

function ensureModalRoot(doc = document) {
  let el = doc.getElementById('modal-root')
  if (!el) {
    el = doc.createElement('div')
    el.id = 'modal-root'
    doc.body.appendChild(el)
  }
  return el as unknown as Document & { innerHTML: string }
}

function renderModalLayer() {
  const root = ensureModalRoot()
  const html = renderModal()
  if (html === lastModalHtml) return
  // 滚动守卫闸门（DSHBOTS-154）：同一弹窗的刷新在 modal-body 滚动进行中延后——延后期间
  // lastModalHtml 不更新，滚动停止后 scheduleModalPatch 重入时仍能识别「内容变了」并补拍。
  // 关闭（html 为空，须立即清层）与首次挂载（root 尚无遮罩，无旧内容可闪）不延后。
  if (html && root.firstElementChild?.classList?.contains('modal-backdrop') && modalScrollRecent()) {
    scheduleModalPatch()
    return
  }
  lastModalHtml = html
  // 关弹窗转换（有弹窗 → 无弹窗）：清层前补上遮罩期间被跳过的 #app 渲染（DSHBOTS-98）。
  if (!html) flushAppRender()
  if (!html) {
    root.replaceChildren()
    return
  }
  const prevBackdrop = root.firstElementChild
  if (!prevBackdrop?.classList?.contains('modal-backdrop')) {
    root.innerHTML = html
    // 秒级时钟占位水化（DSHBOTS-154）：占位符不能等 1s 定时器，挂载即补真实时长。
    if (typeof updateRunClocks === 'function') updateRunClocks(root)
    return
  }
  const stage = document.createElement('div')
  stage.innerHTML = html
  const freshBackdrop = stage.firstElementChild
  const freshPanel = freshBackdrop?.querySelector?.('.modal')
  const prevPanel = prevBackdrop.firstElementChild
  if (!freshBackdrop || !freshPanel || !prevPanel) {
    root.innerHTML = html
    if (typeof updateRunClocks === 'function') updateRunClocks(root)
    return
  }
  const prevBody = prevPanel.querySelector('.modal-body')
  const freshBody = freshPanel.querySelector('.modal-body')
  if (prevBody && freshBody) {
    const savedScroll = prevBody.scrollTop
    const active = document.activeElement
    const refocus = active?.id && prevBody.contains(active) ? active.id : null
    const prevHead = prevPanel.querySelector('.modal-head')
    const prevFoot = prevPanel.querySelector('.modal-foot')
    const freshHead = freshPanel.querySelector('.modal-head')
    const freshFoot = freshPanel.querySelector('.modal-foot')
    if (freshHead) prevHead ? prevHead.replaceWith(freshHead) : prevPanel.prepend(freshHead)
    else prevHead?.remove()
    if (freshFoot) prevFoot ? prevFoot.replaceWith(freshFoot) : prevPanel.append(freshFoot)
    else prevFoot?.remove()
    prevBody.innerHTML = freshBody.innerHTML
    prevBody.scrollTop = savedScroll
    if (refocus) {
      const restored = prevBody.querySelector(`[id="${refocus}"]`)
      if (restored instanceof HTMLElement) restored.focus()
    }
  } else {
    prevPanel.replaceChildren(...freshPanel.childNodes)
  }
  prevPanel.className = freshPanel.className
  prevPanel.setAttribute('aria-label', freshPanel.getAttribute('aria-label') ?? '')
  if (typeof updateRunClocks === 'function') updateRunClocks(root)
}
// modal-layer:end


export { modalShell, modalLoading, overlayOpen, flushAppRender, ensureModalRoot, renderModalLayer, markAppRenderPending, noteModalScroll }
