// DSHBOTS-367：任务板键盘可达 + 遮罩背景 inert + 表单内联校验（UX 无障碍三件套）。
// 沿用仓库两条先例：读源断言（tests/helpers/ui-sources.js）+ 标记块 new Function 执行
// （tests/desktop-notify.test.js）。执行的是真实源码，不是把实现复制一份到测试里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'
import zh from '../ui/i18n/zh.js'
import en from '../ui/i18n/en.js'
import { t, setLanguage } from '../ui/modules/i18n.js'
import './helpers/eval-shim.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const uiSource = readUiSource()
const stylesSource = await uiStylesSource()
const moduleSource = (name: string) => readFileSync(join(root, 'ui', 'modules', `${name}.js`), 'utf8')

// 从构建产物里按花括号配平抽出函数体（源与产物同源，不复制实现到测试里）。
const extractFn = (source: string, name: string) => {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start > 0, `${name} 必须存在`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 括号不闭合`)
}

const markerBlock = (name: string) => {
  const match = uiSource.match(new RegExp(`// ===== ${name}:start[\\s\\S]*?// ===== ${name}:end =====`))
  assert.ok(match, `${name} 标记块必须存在`)
  return match[0]
}

const activation = new Function(`${markerBlock('keyboard-activation')}\nreturn { activationDecision }`)()
const inert = new Function(`${markerBlock('overlay-inert')}\nreturn { backgroundInert }`)()
const validation = new Function(`${markerBlock('form-validation')}\nreturn { constraintOf, errorKeyOf }`)()
const menu = new Function(`${markerBlock('task-menu')}\nreturn { moveTargets }`)()

test('键盘激活判定：Enter/Space 只在非原生载体上代为派发', () => {
  // 任务卡 article、侧栏行 div：Enter / Space 都要能打开。
  assert.equal(activation.activationDecision({ key: 'Enter', carrierTag: 'ARTICLE', chainTags: [] }), true)
  assert.equal(activation.activationDecision({ key: ' ', carrierTag: 'DIV', chainTags: [] }), true)
  // 原生按钮/链接自带激活，不重复派发（否则会双触发）。
  assert.equal(activation.activationDecision({ key: 'Enter', carrierTag: 'BUTTON', chainTags: [] }), false)
  assert.equal(activation.activationDecision({ key: 'Enter', carrierTag: 'A', chainTags: [] }), false)
  // 焦点落在卡内原生子按钮上时，交给子按钮，不触发卡片。
  assert.equal(activation.activationDecision({ key: 'Enter', carrierTag: 'ARTICLE', chainTags: ['BUTTON'] }), false)
  // 其它按键与无载体都不激活。
  assert.equal(activation.activationDecision({ key: 'a', carrierTag: 'ARTICLE', chainTags: [] }), false)
  assert.equal(activation.activationDecision({ key: 'Enter', carrierTag: '', chainTags: [] }), false)
  // 长按不放时 keydown 连发：只认第一次，卡片不被反复打开。
  assert.equal(activation.activationDecision({ key: 'Enter', carrierTag: 'ARTICLE', chainTags: [], repeat: true }), false)
})

test('背景 inert 判定：弹窗或图片查看器任一开着就锁背景', () => {
  assert.equal(inert.backgroundInert(true, false), true)
  assert.equal(inert.backgroundInert(false, true), true)
  assert.equal(inert.backgroundInert(true, true), true)
  assert.equal(inert.backgroundInert(false, false), false)
})

test('表单约束判定：约束类型映射到错误文案键，且中英词典都注册', () => {
  assert.equal(validation.constraintOf({ valueMissing: true }), 'valueMissing')
  assert.equal(validation.constraintOf({ typeMismatch: true }), 'typeMismatch')
  assert.equal(validation.constraintOf({ patternMismatch: true }), 'patternMismatch')
  assert.equal(validation.constraintOf({ tooShort: true }), 'tooShort')
  assert.equal(validation.constraintOf({ rangeUnderflow: true }), 'rangeUnderflow')
  assert.equal(validation.constraintOf({}), '')
  assert.equal(validation.errorKeyOf('valueMissing'), 'form.errorRequired')
  assert.equal(validation.errorKeyOf('nope'), '')
  // 每个约束键在 zh/en 都有成对文案——英文界面不回退中文。
  const keys = ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooShort', 'tooLong', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch']
  for (const name of keys) {
    const key = validation.errorKeyOf(name)
    assert.ok(key, `${name} 必须有错误文案键`)
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh 缺键 ${key}`)
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en 缺键 ${key}`)
    assert.notEqual(zh[key], en[key], `${key} 中英文案不应相同`)
  }
  assert.ok(Object.prototype.hasOwnProperty.call(zh, 'form.thisField'))
  assert.ok(Object.prototype.hasOwnProperty.call(en, 'form.thisField'))
})

test('任务卡上下文菜单：目标列排除当前列且保持看板列序', () => {
  const order = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled']
  assert.deepEqual(menu.moveTargets(order, 'todo'), ['backlog', 'in_progress', 'blocked', 'in_review', 'done', 'canceled'])
  assert.deepEqual(menu.moveTargets(order, 'done'), ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'canceled'])
  assert.equal(menu.moveTargets(order, 'backlog').length, order.length - 1)
})

test('任务卡与侧栏任务行：键盘可聚焦，Enter 可打开', () => {
  const tasks = moduleSource('tasks')
  const chat = moduleSource('chat')
  // 任务卡：article 带 tabindex（内含原生子按钮，故不加 role=button，避免子按钮被读屏吞掉）。
  assert.match(tasks, /<article class="task-card[^"]*" draggable="true" tabindex="0" data-task-id="\$\{attr\(task\.id\)\}" data-action="open-task">/, '任务卡可聚焦且带打开动作')
  // 侧栏任务行：div 载体补 role=button + tabindex。
  assert.match(chat, /<div class="side-row" role="button" tabindex="0" data-action="open-task"/, '侧栏任务行可聚焦')
  // 通用激活接线在 keydown 上。
  const misc = moduleSource('events-misc')
  assert.match(misc, /activationDecision\(\{ key: event\.key, carrierTag: carrier\?\.tagName, chainTags: chain, repeat: event\.repeat \}\)/, 'keydown 走通用激活判定')
  assert.match(misc, /event\.key === 'ContextMenu' \|\| \(event\.key === 'F10' && event\.shiftKey\)/, '菜单键开上下文菜单')
  assert.match(misc, /openTaskMenuForElement\(event\.target/, '菜单键接到任务卡菜单')
  // 遮罩本身也带 data-action，但它不是键盘动作载体（弹窗内无焦点元素时 Space 不该关弹窗）。
  assert.match(misc, /carrier\.classList\?\.contains\('modal-backdrop'\)/, '遮罩不参与通用激活')
})

test('遮罩开合：#app 置 inert 并还原，背景滚动锁定', () => {
  const util = moduleSource('util')
  const modal = moduleSource('modal-layer')
  const composer = moduleSource('composer')
  assert.match(util, /\)\.inert = Boolean\(inert\)/, '背景 #app 置 inert')
  assert.match(modal, /setAppInert\(overlayInertState\(\)\)/, '弹窗层开合即切 inert')
  assert.match(composer, /setAppInert\(overlayInertState\(\)\)/, '图片查看器开合同样切 inert')
  // 滚动锁定不改 html/body 的 overflow（会顶掉滚动条造成横向抖动），
  // 而是让遮罩自身成为不可滚动的滚动容器并 contain 滚动链。
  assert.doesNotMatch(stylesSource, /html\s*,\s*body\s*\{[^}]*overflow:\s*hidden/, '不得改 html/body 的 overflow')
  assert.match(stylesSource, /\.modal-backdrop \{[^}]*overflow: hidden;[^}]*overscroll-behavior: contain;/, '遮罩 contain 滚动链')
  assert.match(stylesSource, /\.modal-body \{[^}]*overscroll-behavior: contain;/, '弹窗正文 contain 滚动链')
})

test('表单内联校验：接中央 submit 路径，错误节点与 aria 关联成对', () => {
  const submit = moduleSource('events-submit')
  const validationSource = moduleSource('form-validation')
  assert.match(submit, /if \(!validateForm\(form\)\) return/, '中央 submit 路径先过校验')
  // 错误节点常驻 DOM，显示期才进 aria-describedby（隐藏文本被引用也会被读屏念出）。
  assert.match(validationSource, /linkError\(field, true\)/, '非法时挂 aria-describedby')
  assert.match(validationSource, /linkError\(field, false\)/, '合法时撤 aria-describedby')
  assert.match(validationSource, /field\.setAttribute\('aria-invalid', 'true'\)/, '非法时置 aria-invalid')
  assert.match(validationSource, /field\.setAttribute\('aria-invalid', 'false'\)/, '合法时置 aria-invalid=false')
  assert.match(validationSource, /document\.addEventListener\('invalid', event => \{/, '接管原生约束校验')
  assert.match(validationSource, /firstInvalid\.focus\(\)/, '提交失败聚焦第一个非法字段')
  // 视觉态与程序化态同一时刻切换：错误节点用 is-visible 控制显隐。
  assert.match(stylesSource, /\.field-error \{[^}]*display: none;/, '错误节点默认隐藏')
  assert.match(stylesSource, /\.field-error\.is-visible \{[^}]*display: block;/, '非法时显示')
  assert.match(stylesSource, /\[aria-invalid='true'\][^{]*\{[^}]*border-color: var\(--danger\)/, '非法态描边走既有 token')
})

test('行为断言：#app 的 inert 真值随遮罩开合切换', () => {
  // 真跑 util.js 里的 setAppInert（不是复制实现）：背景元素真值必须跟着开合翻转。
  const src = moduleSource('util')
  const app: any = { inert: false }
  const documentStub = { getElementById: (id: string) => (id === 'app' ? app : null) }
  const setAppInert = new Function('document', `${extractFn(src, 'setAppInert')}\nreturn setAppInert`)(documentStub)
  setAppInert(true)
  assert.equal(app.inert, true, '遮罩打开时 #app 必须 inert')
  setAppInert(false)
  assert.equal(app.inert, false, '遮罩关闭后 #app 必须还原')
  // 没有 #app 时不抛错（早退即可）。
  const noApp = new Function('document', `${extractFn(src, 'setAppInert')}\nreturn setAppInert`)({ getElementById: () => null })
  assert.doesNotThrow(() => noApp(true))
})

test('行为断言：空必填字段的错误文案随界面语言切换（zh/en 同一实现）', () => {
  // 真跑 form-validation.js 里的 messageFor + 真实 i18n 的 t：英文界面不得回退中文。
  const src = moduleSource('form-validation')
  const fns = new Function(
    't', 'errorKeyOf', 'constraintOf',
    `${extractFn(src, 'fieldLabel')}\n${extractFn(src, 'messageFor')}\nreturn { messageFor }`,
  )(t, validation.errorKeyOf, validation.constraintOf)
  const field: any = {
    validity: { valueMissing: true },
    labels: [{ textContent: '任务标题' }],
    getAttribute: (name: string) => (name === 'name' ? 'title' : null),
    id: 'title',
  }
  setLanguage('zh')
  assert.match(fns.messageFor(field), /任务标题不能为空/, '中文界面给中文错误')
  setLanguage('en')
  assert.match(fns.messageFor(field), /任务标题 is required/, '英文界面给英文错误')
  setLanguage('zh')
})

test('行为断言：任务卡菜单按 Esc 关闭后焦点回到锚点卡片', () => {
  // 真跑 task-menu.js（剥掉 ESM import 后注入桩）：开菜单时焦点已被移到菜单项，
  // 关闭要还焦只能靠记住的锚点——查 .task-card:focus 必空。
  const src = moduleSource('task-menu').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const listeners: Record<string, any[]> = {}
  const focused: string[] = []
  const fakeItem = { focus: () => focused.push('menu-item') }
  const fakeMenu: any = { style: {}, querySelector: () => fakeItem, contains: () => false }
  const fakeRoot: any = { innerHTML: '', firstElementChild: fakeMenu }
  const anchor: any = { focus: () => focused.push('card'), getBoundingClientRect: () => ({ bottom: 100, left: 20, top: 0 }) }
  const documentStub: any = {
    getElementById: (id: string) => (id === 'task-menu-root' ? fakeRoot : null),
    createElement: () => ({ id: '', innerHTML: '' }),
    body: { appendChild: () => {} },
    addEventListener: (type: string, handler: any) => { (listeners[type] ||= []).push(handler) },
    querySelector: () => null,
  }
  const mod = new Function(
    'STATUS_ORDER', 'api', 't', 'attr', 'esc', 'taskById', 'toast', 'refresh', 'document', 'window',
    `${src}\nreturn { openTaskMenu, closeTaskMenu }`,
  )(
    ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled'],
    async () => ({}),
    (key: string) => key,
    (value: any) => String(value ?? ''),
    (value: any) => String(value ?? ''),
    () => ({ id: 't1', status: 'todo' }),
    () => {},
    async () => {},
    documentStub,
    { innerHeight: 800, innerWidth: 1200 },
  )
  mod.openTaskMenu({ id: 't1', status: 'todo' }, anchor)
  assert.deepEqual(focused, ['menu-item'], '开菜单后焦点落在首个菜单项')
  const escHandler = listeners['keydown']?.[0]
  assert.ok(escHandler, '任务卡菜单必须注册 keydown 处理器')
  escHandler({ key: 'Escape', preventDefault: () => {} })
  assert.deepEqual(focused, ['menu-item', 'card'], 'Esc 关闭后焦点回到锚点卡片')
  // 旧实现的查 :focus 路径必然落空（焦点已被菜单抢走），不得再出现。
  assert.doesNotMatch(moduleSource('task-menu'), /\.task-card:focus/, '不得靠查 :focus 还焦')
})

test('样式与尺寸：错误样式、菜单样式、消息操作按钮 24px', () => {
  assert.match(stylesSource, /\.task-menu \{[^}]*position: absolute;/, '任务卡菜单样式在位')
  assert.match(stylesSource, /\.task-menu-item \{[^}]*cursor: pointer;/, '菜单项可点')
  assert.match(stylesSource, /\.visually-hidden \{[^}]*position: absolute;/, '读屏播报区视觉隐藏')
  // 消息操作按钮 22 → 24px（chat.css）。
  const chatCss = readFileSync(join(root, 'ui', 'styles', 'chat.css'), 'utf8')
  const block = chatCss.slice(chatCss.indexOf('.msg-quote-btn,'), chatCss.indexOf('.msg-quote-btn,') + 400)
  assert.match(block, /width: 24px;/, '消息操作按钮宽 24px')
  assert.match(block, /height: 24px;/, '消息操作按钮高 24px')
  assert.doesNotMatch(block, /width: 22px;/, '不再保留 22px')
})
