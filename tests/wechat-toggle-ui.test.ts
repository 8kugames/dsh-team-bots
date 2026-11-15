// DSHBOTS-334 守门（卡面扩展③）：微信通道 enable 开关上通道页。
// f) 关=state.wechat 停用且出站不推（channelNotify 不再扇出到微信）；
// g) 开=恢复挂载（真实 WechatChannel 挂载 + start，无既有绑定时回 unbound 待扫码）；
// h) settings 显式值覆盖 patch.yml/env 默认（含 core 挂载决策源码锚与生效值纯函数）；
// 另含 UI 渲染守门：停用态出「启用通道」、启用态出「停用通道」，i18n 双语齐平。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveConfig, effectiveWechatEnabled, WECHAT_CHANNEL_ENABLED_KEY } from '../src/config.js'
import { openDatabase } from '../src/db.js'
import { TeamService } from '../src/service.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function captureLog() {
  const lines: string[] = []
  return {
    lines,
    logger: {
      info: text => lines.push(String(text)),
      warn: text => lines.push(String(text)),
      error: text => lines.push(String(text)),
    },
  }
}

async function setup() {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-wechat-toggle-'))
  const dataDir = join(tmp, 'data')
  await mkdir(dataDir, { recursive: true })
  // patch.yml/env 默认开着（对齐生产 cordis.patch.yml wechatEnabled: true）。
  const config = resolveConfig({ dataDir, wechatEnabled: true })
  const db = openDatabase(config.dbPath)
  const { logger } = captureLog()
  const service = new TeamService({ store: db, config, logger })
  return { tmp, config, db, service, cleanup: () => rm(tmp, { recursive: true, force: true }) }
}

test('h) 生效值纯函数：settings 显式值覆盖 patch.yml/env 默认', () => {
  const config = { wechat: { enabled: true } }
  assert.equal(effectiveWechatEnabled(config), true, '未保存回退注入默认')
  assert.equal(effectiveWechatEnabled(config, () => '0'), false, "保存 '0' 覆盖默认开")
  assert.equal(effectiveWechatEnabled({ wechat: { enabled: false } }, () => '1'), true, "保存 '1' 覆盖默认关")
  assert.equal(effectiveWechatEnabled(config, () => ''), true, '空串=未保存，回退默认')
})

test('f) 关=停用：wechat 卸载、state 停用、出站不再扇出到微信', async () => {
  const ctx = await setup()
  try {
    let stopped = 0
    let pushed = 0
    ctx.service.wechat = {
      async stop() {
        stopped += 1
      },
      notify() {
        pushed += 1
      },
      status: () => ({ phase: 'connected', enabled: true, error: null, adminPeerId: null, pendingAdmin: false, auth: null }),
    } as any
    const response = await ctx.service.setWechatChannelEnabled(false)
    assert.equal(stopped, 1, '停用应断开旧通道（stop 一次）')
    assert.equal(ctx.service.wechat, null, '停用应卸载通道实例')
    assert.equal((response as any).enabled, false, 'state.wechat 应为停用态')
    assert.equal(ctx.service.wechatStatus().enabled, false, '状态视图应显示停用')
    const results = ctx.service.channelNotify('测试推送')
    assert.equal(pushed, 0, '停用后出站不得再推微信')
    assert.equal(results.some(item => item.channel === 'wechat'), false, 'channelNotify 结果不得含微信')
    assert.equal(ctx.db.setting(WECHAT_CHANNEL_ENABLED_KEY), '0', '开关值应落 settings')
  } finally {
    await ctx.cleanup()
  }
})

test('g) 开=恢复：重新挂载真实 WechatChannel 并 start（无绑定时回 unbound 待扫码）', async () => {
  const ctx = await setup()
  try {
    await ctx.service.setWechatChannelEnabled(true)
    assert.ok(ctx.service.wechat, '启用应重新挂载通道实例')
    const status = ctx.service.wechatStatus()
    assert.equal(status.enabled, true, '挂载后状态应为启用')
    assert.equal(status.phase, 'unbound', '无既有绑定时回 unbound（不 crash、不联网失败）')
    // 停用→再启用一轮：挂载/卸载幂等，可反复切换。
    await ctx.service.setWechatChannelEnabled(false)
    assert.equal(ctx.service.wechat, null, '再次停用应卸载')
    await ctx.service.setWechatChannelEnabled(true)
    assert.ok(ctx.service.wechat, '再次启用应恢复挂载')
  } finally {
    await ctx.service.wechat?.stop?.()
    await ctx.cleanup()
  }
})

test('h) core 挂载决策源码锚：启动挂载按生效开关而非裸 config', () => {
  const source = readFileSync(join(root, 'src/services/core.js'), 'utf8')
  assert.match(source, /if \(this\.wechatChannelEnabled\(\)\)/, 'core 初始化挂载应走 wechatChannelEnabled()（settings 覆盖 patch.yml）')
})

test('api/契约锚：set_wechat_channel_enabled 动作齐平', () => {
  const apiSource = readFileSync(join(root, 'src/api.js'), 'utf8')
  assert.match(apiSource, /'set_wechat_channel_enabled'/, 'api 动作白名单应含 set_wechat_channel_enabled')
  assert.match(apiSource, /case 'set_wechat_channel_enabled':/, 'api 应有 set_wechat_channel_enabled 分支')
  assert.match(apiSource, /service\.setWechatChannelEnabled\(Boolean\(payload\.enabled\), actor\)/, '应透传 enabled 与 actor')
  const contracts = readFileSync(join(root, 'types/contracts.d.ts'), 'utf8')
  assert.match(contracts, /'set_wechat_channel_enabled'/, 'TeamActionName 联合应含该动作')
})

// ===== UI 渲染守门（真实渲染 global-pages.js 的 renderChannel，同 feishu-ui 口径） =====

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
  feishu: { enabled: false, phase: 'disabled' },
}

async function renderChannel(wechat: Record<string, unknown>) {
  stubDom()
  const { state } = await import(pathToFileURL(join(root, 'ui/modules/state.js')) as unknown as string)
  const mod = await import(pathToFileURL(join(root, 'ui/modules/global-pages.js')) as unknown as string)
  state.data = { ...BASE_DATA, wechat }
  state.projectId = null
  return mod.renderChannel()
}

test('UI：停用态出启用开关卡，启用态出停用按钮（扫码入口保留）', async () => {
  const disabled = await renderChannel({ enabled: false, phase: 'disabled' })
  assert.match(disabled, /data-action="wechat-toggle" data-next="1"/, '停用态应有启用开关')
  assert.match(disabled, /启用通道/, '停用态按钮文案为「启用通道」')
  assert.doesNotMatch(disabled, /data-next="0"/, '停用态不应再出停用按钮')
  assert.doesNotMatch(disabled, /data-action="wechat-login"/, '停用态无扫码入口')

  const enabled = await renderChannel({ enabled: true, phase: 'connected' })
  assert.match(enabled, /data-action="wechat-toggle" data-next="0"/, '启用态应有停用开关')
  assert.match(enabled, /停用通道/, '启用态按钮文案为「停用通道」')
  assert.match(enabled, /data-action="wechat-logout"/, '已连接态保留退出绑定')
})

test('UI i18n：微信开关词条 zh/en 齐平且被调用', async () => {
  const zh = (await import(pathToFileURL(join(root, 'ui/i18n/zh.js')) as unknown as string)).default
  const en = (await import(pathToFileURL(join(root, 'ui/i18n/en.js')) as unknown as string)).default
  const source = readFileSync(join(root, 'ui/modules/global-pages.js'), 'utf8')
  for (const key of ['启用通道', '停用通道', '通道已停用，启用后可扫码绑定管理员微信接收推送。', '停用后微信通道立即断开且不再推送。确认停用？', '微信通道已启用', '微信通道已停用']) {
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh 缺键：${key}`)
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en 缺键：${key}`)
    assert.ok(source.includes(`"${key}"`), `词条未被调用：${key}`)
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en 键集必须一致')
})
