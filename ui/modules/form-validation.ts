// ui/modules/form-validation.ts —— 集中式表单内联校验。
// 口径：视觉状态用原生 :user-invalid，程序化状态用 aria-invalid + aria-describedby，
// 两者同一时刻切换——错误文案只在字段确实非法时挂进 aria-describedby，
// 文案走应用内词典（随界面语言），不依赖浏览器原生气泡。
import { t } from './i18n.js'

const FIELD_SELECTOR = 'input, select, textarea'

// ===== form-validation:start —— 纯逻辑标记块（tests/task-a11y.test.js 抽取断言）=====
// 约束类型 → 错误文案键。顺序即优先级：缺失 > 类型 > 模式 > 长度 > 数值范围 > 步长。
const CONSTRAINT_KEYS = {
  valueMissing: 'form.errorRequired',
  typeMismatch: 'form.errorTypeMismatch',
  patternMismatch: 'form.errorPatternMismatch',
  tooShort: 'form.errorTooShort',
  tooLong: 'form.errorTooLong',
  rangeUnderflow: 'form.errorRangeUnderflow',
  rangeOverflow: 'form.errorRangeOverflow',
  stepMismatch: 'form.errorStepMismatch',
}

// 取第一个命中的约束名；全部合法返回空串。
function constraintOf(validity) {
  if (!validity) return ''
  for (const name of Object.keys(CONSTRAINT_KEYS)) {
    if (validity[name]) return name
  }
  return ''
}

// 约束名 → i18n 键；未知约束返回空串（不渲染错误）。
function errorKeyOf(constraint) {
  return Object.prototype.hasOwnProperty.call(CONSTRAINT_KEYS, constraint) ? CONSTRAINT_KEYS[constraint] : ''
}
// ===== form-validation:end =====

// 不参与校验的控件：隐藏域、禁用域、只读域。
function skippable(field) {
  return field.type === 'hidden' || field.disabled || field.readOnly
}

// 字段可访问名：优先 label 文本，其次 name，最后 id。
function fieldLabel(field) {
  const labels = field.labels
  const el = labels && labels.length ? labels[0] : null
  const text = el ? String(el.textContent ?? '').trim() : ''
  return text || field.getAttribute('name') || field.id || t('form.thisField')
}

// 错误文案：按约束类型取词典条目，缺省参数填字段名与阈值。
function messageFor(field) {
  const key = errorKeyOf(constraintOf(field.validity))
  if (!key) return ''
  const params: Record<string, any> = { label: fieldLabel(field) }
  if (Number(field.minLength) > 0) params.min = field.minLength
  if (Number(field.maxLength) > 0) params.max = field.maxLength
  if (field.min !== '' && field.min !== undefined) params.min = field.min
  if (field.max !== '' && field.max !== undefined) params.max = field.max
  if (field.step) params.step = field.step
  return t(key, params)
}

// 错误节点：始终留在 DOM 里（隐藏），只在非法时被 aria-describedby 引用。
function errorNode(field) {
  const id = field.dataset.error || `${field.id || field.getAttribute('name') || 'field'}-error`
  field.dataset.error = id
  let node = document.getElementById(id)
  if (!node) {
    node = document.createElement('div')
    node.className = 'field-error'
    node.id = id
    const holder = field.closest('.field') || field.parentElement
    if (holder) holder.appendChild(node)
    else field.insertAdjacentElement('afterend', node)
  }
  return node
}

// 错误 id 只在显示期间进 aria-describedby——隐藏文本被引用也会被读屏念出来。
function linkError(field, shown) {
  const id = field.dataset.error
  if (!id) return
  const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(token => token && token !== id)
  if (shown) ids.push(id)
  if (ids.length) field.setAttribute('aria-describedby', ids.join(' '))
  else field.removeAttribute('aria-describedby')
}

function showError(field) {
  const node = errorNode(field)
  node.textContent = messageFor(field)
  node.classList.add('is-visible')
  field.setAttribute('aria-invalid', 'true')
  linkError(field, true)
}

function clearError(field) {
  const id = field.dataset.error
  if (id) {
    const node = document.getElementById(id)
    if (node) {
      node.textContent = ''
      node.classList.remove('is-visible')
    }
  }
  field.setAttribute('aria-invalid', 'false')
  linkError(field, false)
}

// :user-invalid 的降级判定：极老浏览器不支持该伪类时退回 validity。
function isUserInvalid(field) {
  try {
    return field.matches(':user-invalid')
  } catch {
    return field.validity ? !field.validity.valid : false
  }
}

// 单字段同步：视觉（错误节点 is-visible）与程序化（aria-invalid/aria-describedby）同步。
export function syncFieldValidity(field) {
  if (!field || !field.matches?.(FIELD_SELECTOR) || skippable(field)) return true
  const invalid = isUserInvalid(field)
  if (invalid) showError(field)
  else clearError(field)
  return !invalid
}

// 提交失败后聚焦第一个非法字段——读屏会在焦点落位时念出该字段的错误。
export function reportInvalid(field) {
  showError(field)
  const form = field.closest?.('form')
  if (!form) return
  const fields = Array.from(form.querySelectorAll(FIELD_SELECTOR)) as HTMLInputElement[]
  const first = fields.find(el => !skippable(el) && !el.validity.valid)
  if (first !== field) return
  try { first.focus() } catch {}
  announce(messageFor(field))
}

// 表单级校验：同步所有字段的非法态；返回 true 表示可以继续提交。
export function validateForm(form) {
  if (!form) return true
  const fields = Array.from(form.querySelectorAll(FIELD_SELECTOR)) as HTMLInputElement[]
  let firstInvalid = null
  for (const field of fields) {
    if (skippable(field)) continue
    if (!syncFieldValidity(field) && !firstInvalid) firstInvalid = field
  }
  // 用户没碰过的必填项在提交瞬间才被判非法：此时 :user-invalid 尚未匹配，按 validity 兜底。
  if (!firstInvalid) {
    for (const field of fields) {
      if (skippable(field)) continue
      if (!field.validity.valid) {
        showError(field)
        if (!firstInvalid) firstInvalid = field
      }
    }
  }
  if (firstInvalid) {
    try { firstInvalid.focus() } catch {}
    announce(messageFor(firstInvalid))
    return false
  }
  return true
}

// 一个页面一个礼貌播报区：错误出现时念一次（错误节点本身不做 live region）。
let announcer = null
function announce(text) {
  if (!text) return
  if (!announcer) {
    announcer = document.createElement('div')
    announcer.className = 'visually-hidden'
    announcer.setAttribute('aria-live', 'polite')
    document.body.appendChild(announcer)
  }
  announcer.textContent = text
}

// 原生约束校验：捕获阶段拦下浏览器自带的浮动气泡，改用应用内内联错误。
document.addEventListener('invalid', event => {
  const field = event.target as HTMLInputElement
  if (!field?.matches?.(FIELD_SELECTOR)) return
  if (!field.closest?.('form[data-form]')) return
  event.preventDefault()
  reportInvalid(field)
}, true)

// 离开字段时按 :user-invalid 同步：非法才显示错误并播报文案。
document.addEventListener('blur', event => {
  const field = event.target as HTMLInputElement
  if (!field?.matches?.(FIELD_SELECTOR)) return
  if (!field.closest?.('form[data-form]')) return
  if (!syncFieldValidity(field)) announce(messageFor(field))
}, true)

// 输入中：已经被标记为非法的字段，若内容已合法就撤掉错误，否则只更新文案。
document.addEventListener('input', event => {
  const field = event.target as HTMLInputElement
  if (!field?.matches?.(FIELD_SELECTOR)) return
  if (field.getAttribute('aria-invalid') !== 'true') return
  if (field.validity.valid) clearError(field)
  else showError(field)
})
