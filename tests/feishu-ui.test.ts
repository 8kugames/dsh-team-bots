// DSHBOTS-327 守门：通道页飞书状态卡。
// ① 禁用态（DSH_BOTS_FEISHU 未开）整卡不渲染；② 启用+ready 显示相位/管理员 ou_id/元信息；
// ③ conflict 相出警示（amber + 冲突文案）；④ i18n 键双语齐平且无死键。
// 渲染口径与 tests/global-config-layout.test.ts 同款：真实渲染 ui/modules/global-pages.js 的
// renderChannel()，断言产出的 HTML（不是只读源码文本）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zh from '../ui/i18n/zh.js'
import en from '../ui/i18n/en.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 与 global-config-layout.test.ts 同款最小 DOM 桩：state.js 顶层读 location.search，
// util.js 顶层取 document.getElementById('toast-root')。
function stubDom() {
  const noop = () => {}
  const el = () => ({
    style: {}, dataset: {}, children: [], childNodes: [],
    innerHTML: '', textContent: '', hidden: false, value: '', className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    appendChild(child) { this.children.push(child); return child },
    replaceChildren() {}, replaceWith() {}, prepend() {}, append() {}, remove() {},
    setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, removeEventListener() {}, focus() {},
    contains() { return false }, closest() { return null },
    get firstElementChild() { return null },
    get offsetWidth() { return 1 }, get offsetHeight() { return 1 },
  })
  const elements = new Map()
  globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, el()); return elements.get(id) },
    createElement: el,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    documentElement: {
      dataset: {}, style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
    },
    body: el(), activeElement: null,
  } as unknown as Document
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { href: 'http://127.0.0.1:3080/api/dsh-team/ui?view=channel', search: '' },
    innerWidth: 1440, innerHeight: 900,
  } as unknown as Window & typeof globalThis
  globalThis.location = globalThis.window.location
  globalThis.performance = { now: () => 0 } as unknown as Performance
  globalThis.HTMLElement = (class {}) as unknown as typeof HTMLElement
  globalThis.Element = (class {}) as unknown as typeof Element
  globalThis.Node = (class {}) as unknown as typeof Node
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } } as unknown as typeof MutationObserver
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration)
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) } as unknown as Response)
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop } as unknown as Storage
  globalThis.confirm = () => false
  globalThis.alert = noop
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true,
  })
}

const BASE_DATA = {
  bots: [], projects: [], tasks: [], approvals: [], proposals: [], models: [], prices: [], priceDefaults: [],
  members: [], runs: [], skills: [], secrets: [], secretRequests: [],
  wechat: { enabled: false, phase: 'disabled' },
}

// 渲染通道页；feishu 缺省 = 飞书通道未挂载（state 里无该字段）。
async function renderChannel(feishu?: Record<string, unknown>) {
  stubDom()
  const { state } = await import(pathToFileURL(join(root, 'ui/modules/state.js')) as unknown as string)
  const mod = await import(pathToFileURL(join(root, 'ui/modules/global-pages.js')) as unknown as string)
  state.data = { ...BASE_DATA, ...(feishu ? { feishu } : {}) }
  state.projectId = null
  return mod.renderChannel()
}

test('① 禁用态：飞书未启用时整卡与整个分组都不渲染（不显示死卡）', async () => {
  const html = await renderChannel({ enabled: false, phase: 'disabled' })
  assert.doesNotMatch(html, /feishu-card/, '飞书未启用时不应出现飞书卡')
  assert.doesNotMatch(html, /id="c-feishu"/, '飞书未启用时不应出现飞书分组')
  assert.doesNotMatch(html, /feishu-admin/, '飞书未启用时不应出现管理员 ou_id')
  const missing = await renderChannel(undefined)
  assert.doesNotMatch(missing, /feishu-card/, 'state 里没有 feishu 字段时同样不渲染飞书卡')
})

test('② 启用 + ready：相位/管理员/元信息，AppID 脱敏、settings 来源出清除按钮', async () => {
  const html = await renderChannel({
    enabled: true, phase: 'ready', error: null,
    adminOuId: 'ou_admin_1234567890', botId: 'ou_bot_9876543210', appId: 'cli_a1b2c3d4e5f6',
    credentials: { source: 'saved', appIdMasked: 'cli_a1b2…' },
  })
  assert.match(html, /id="feishu-card"/, '启用后应渲染飞书卡')
  assert.match(html, /class="pill green">已连接<\/span>/, 'ready 相位应显示绿色「已连接」pill')
  assert.match(html, /class="feishu-admin" title="ou_admin_1234567890"/, '管理员 ou_id 应带 title 悬停全文')
  assert.match(html, /ou_admin_1234567890/, '管理员 ou_id 应显示')
  assert.match(html, /机器人 ID/, '应有机器人 ID 元信息')
  assert.match(html, /ou_bot_9876543210/, '机器人 ID 值应显示')
  assert.match(html, /cli_a1b2…/, 'AppID 应脱敏显示（前 8 位+…）')
  assert.doesNotMatch(html, /cli_a1b2c3d4e5f6/, '卡内不得回显完整 AppID')
  assert.doesNotMatch(html, /name="appId"/, '非未绑定态不应渲染凭据输入表单')
  assert.match(html, /凭据已配置/, '已配置来源应显示凭据态')
  assert.match(html, /data-action="feishu-clear-credentials"/, 'settings 来源已配置应显示清除按钮')
  assert.doesNotMatch(html, /二维码|扫码绑定/, '飞书无扫码流程，卡内不应出现扫码入口')
})

test('②b 相位别名：connected 与 ready 同义，都渲染「已连接」绿 pill', async () => {
  const html = await renderChannel({ enabled: true, phase: 'connected' })
  assert.match(html, /class="pill green">已连接<\/span>/, 'connected 相位应渲染绿色「已连接」')
})

test('②c 服务端注入来源：显示凭据态但无清除按钮（凭据归 operator 侧）', async () => {
  const html = await renderChannel({
    enabled: true, phase: 'ready', credentials: { source: 'config', appIdMasked: 'cli_conf…' },
  })
  assert.match(html, /凭据已配置/, '注入来源同样显示已配置态')
  assert.match(html, /cli_conf…/, '注入来源显示脱敏 AppID')
  assert.match(html, /服务端注入/, '注入来源应标注来源')
  assert.doesNotMatch(html, /feishu-clear-credentials/, '注入来源不提供清除按钮')
})

test('③ unbound / conflict：未绑定出凭据表单（secret 密码框），冲突相出 amber 警示', async () => {
  const unbound = await renderChannel({ enabled: true, phase: 'unbound', error: '未配置飞书应用凭据（feishuAppId / feishuAppSecret）', credentials: { source: 'none', appIdMasked: null } })
  assert.match(unbound, /data-form="feishu-credentials"/, '未绑定应渲染凭据表单（DSHBOTS-334）')
  assert.match(unbound, /name="appId"/, '表单应有 AppID 输入')
  assert.match(unbound, /name="appSecret" type="password"/, 'AppSecret 输入应为密码框（不回显）')
  assert.match(unbound, /type="submit"/, '表单应有保存按钮')
  assert.match(unbound, /未配置飞书应用凭据（feishuAppId \/ feishuAppSecret）/, '未绑定错误文案应显示')
  assert.doesNotMatch(unbound, /lark-cli/, '飞书卡不得再提 lark-cli')

  const conflict = await renderChannel({ enabled: true, phase: 'conflict', error: 'exceed_conn_limit（1000040350）：已有其他实例在消费本应用事件' })
  assert.match(conflict, /class="pill amber">连接冲突<\/span>/, 'conflict 相位应显示 amber「连接冲突」pill')
  assert.match(conflict, /class="hint feishu-conflict"/, 'conflict 应出警示行')
  assert.match(conflict, /检测到连接冲突：同一 App ID 在多处登录/, 'conflict 警示应说明同 App ID 多处登录')
})

test('④ i18n：飞书词条 zh/en 齐平、调用点均已注册、无死键', () => {
  const source = readFileSync(join(root, 'ui/modules/global-pages.js'), 'utf8')
  const keys = ['channel.sectionFeishu', 'channel.sectionFeishuDesc', '连接冲突', 'App Secret', '保存并连接', '凭据已配置', '清除凭据', '服务端注入', '检测到连接冲突：同一 App ID 在多处登录（exceed_conn_limit），请先退出其他实例。', '机器人 ID', 'App ID']
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh 缺键：${key}`)
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en 缺键：${key}`)
    assert.ok((zh[key] as string).length > 0 && (en[key] as string).length > 0, `键值为空：${key}`)
    assert.ok(source.includes(`"${key}"`) || source.includes(`'${key}'`), `词条未被调用：${key}`)
  }
  // zh/en 键集一致（全局口径，防飞书词条只进一门）。
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en 键集必须一致')
})

test('⑤ api：feishu 动作在白名单与类型契约里齐平（含凭据保存/清除）', () => {
  const apiSource = readFileSync(join(root, 'src/api.js'), 'utf8')
  assert.match(apiSource, /'feishu_status'/, 'api 动作白名单应含 feishu_status')
  assert.match(apiSource, /case 'feishu_status':/, 'api 应有 feishu_status 分支')
  assert.match(apiSource, /service\.feishuStatus\(\)/, 'feishu_status 应回 service.feishuStatus()')
  assert.match(apiSource, /'save_feishu_credentials'/, 'api 动作白名单应含 save_feishu_credentials')
  assert.match(apiSource, /case 'save_feishu_credentials':/, 'api 应有 save_feishu_credentials 分支')
  assert.match(apiSource, /'clear_feishu_credentials'/, 'api 动作白名单应含 clear_feishu_credentials')
  assert.match(apiSource, /case 'clear_feishu_credentials':/, 'api 应有 clear_feishu_credentials 分支')
  const contracts = readFileSync(join(root, 'types/contracts.d.ts'), 'utf8')
  assert.match(contracts, /'feishu_status' \| 'save_feishu_credentials' \| 'clear_feishu_credentials'/, 'TeamActionName 联合应含三个飞书动作')
})
