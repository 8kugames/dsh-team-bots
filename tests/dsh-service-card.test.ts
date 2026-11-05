// DSHBOTS-143：「DSH 服务」卡收敛——删热升级死按钮，卡内展示四项版本。
// 行为三例：health().version 读部署 package.json 真值；state() 下发 pluginVersion；
// dshUpdateInfo() 同时回 dsh 与 dsh-team-bots 两套当前/最新版本与升级标记。
// UI 三例：死按钮与 case 全删；检查更新接线保留 + 卡内渲染四项；API 层保留 upgrade_dsh/reboot_dsh。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { readUiSource } from './helpers/ui-sources.js'
import { TeamService } from '../src/service.js'

const require = createRequire(import.meta.url)
const PACKAGE_VERSION = String(require('../package.json').version)

class HoldingRuntime {
  declare started: Array<{ id: string }>
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) {
    this.started.push({ id: run.id })
    return `session-${run.id}`
  }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-service-card-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

const cleanup = async ({ root, store }) => {
  store.close()
  await rm(root, { recursive: true, force: true })
}

test('health().version 读部署 package.json 真值，不再硬编码', async () => {
  const ctx = await setup()
  try {
    const health = await ctx.service.health()
    assert.equal(health.version, PACKAGE_VERSION, 'health 版本必须等于部署副本 package.json 的 version')
  } finally {
    await cleanup(ctx)
  }
})

test('state() 下发 pluginVersion（部署生效版，与 health 同源）', async () => {
  const ctx = await setup()
  try {
    const view = await ctx.service.state(null, null)
    assert.equal(view.pluginVersion, PACKAGE_VERSION, 'state 必须携带插件当前生效版本')
  } finally {
    await cleanup(ctx)
  }
})

test('dshUpdateInfo() 回 dsh 与 dsh-team-bots 两套版本与升级标记', async () => {
  const ctx = await setup()
  const realFetch = globalThis.fetch
  const realVersion = process.env.DSH_RUNTIME_VERSION
  process.env.DSH_RUNTIME_VERSION = '0.2.100'
  globalThis.fetch = (async (url) => {
    const target = String(url)
    if (target.includes('%40deepseek-ai') || target.includes('@deepseek-ai')) {
      return {
        ok: true,
        json: async () => ({
          versions: { '0.2.100': {}, '0.2.110': {}, '0.3.0-alpha.1': {} },
          'dist-tags': { latest: '0.2.110' },
        }),
      }
    }
    if (target.includes('dsh-team-bots')) {
      return {
        ok: true,
        json: async () => ({
          versions: { '0.0.0-stage': {} },
          'dist-tags': { latest: '0.0.0-stage' },
        }),
      }
    }
    throw new Error(`意外请求：${target}`)
  }) as unknown as typeof fetch
  try {
    const info = await ctx.service.dshUpdateInfo()
    assert.equal(info.current, '0.2.100', 'dsh 当前版本取 DSH_RUNTIME_VERSION')
    assert.equal(info.latest, '0.2.110', 'dsh 最新版过滤 alpha')
    assert.equal(info.pluginCurrent, PACKAGE_VERSION, '插件当前版本取部署 package.json')
    assert.equal(info.pluginLatest, '0.0.0-stage', 'dsh-team-bots 最新版取 registry')
    assert.equal(info.updateAvailable, true, 'dsh 落后于最新时应标记可升级')
    assert.equal(info.pluginUpdateAvailable, false, '插件不低于 registry 最新版时不标记')
  } finally {
    globalThis.fetch = realFetch
    if (realVersion === undefined) delete process.env.DSH_RUNTIME_VERSION
    else process.env.DSH_RUNTIME_VERSION = realVersion
    await cleanup(ctx)
  }
})

// —— UI 源码断言（tests/task-reject.test.js 先例：读源码断言，不跑浏览器）——
const here = dirname(fileURLToPath(import.meta.url))
const rootDir = join(here, '..')
const read = rel => readFileSync(join(rootDir, rel), 'utf8')
const app = readUiSource()

test('UI：热升级死按钮与 case 分支全删', () => {
  assert.ok(!app.includes('data-action="upgrade-dsh"'), '不得再有「升级并重启」按钮')
  assert.ok(!app.includes('data-action="reboot-dsh"'), '不得再有「仅重启 DSH」按钮')
  assert.ok(!app.includes("case 'upgrade-dsh'"), 'upgrade-dsh case 应随按钮删除')
  assert.ok(!app.includes("case 'reboot-dsh'"), 'reboot-dsh case 应随按钮删除')
  assert.ok(!app.includes('升级并重启') && !app.includes('仅重启 DSH'), '死按钮文案不得残留')
})

test('UI：检查更新接线保留，卡内渲染四项版本', () => {
  assert.ok(app.includes('data-action="check-dsh-update"'), '「检查更新」按钮保留')
  assert.ok(app.includes("case 'check-dsh-update'"), 'check-dsh-update case 保留')
  assert.ok(app.includes('state.dshUpdate'), '检查结果应存入 state.dshUpdate 供卡内渲染')
  assert.ok(app.includes('data.dsh?.version'), 'dsh 当前版本应取 state 下发的 dsh.version')
  assert.ok(app.includes('data.pluginVersion'), '插件当前版本应取 state 下发的 pluginVersion')
  assert.ok(app.includes('可升级'), 'updateAvailable 需在卡内呈现')
})

test('API 兼容：upgrade_dsh/reboot_dsh 服务端方法与 API case 保留', () => {
  const apiSource = read('src/api.js')
  assert.ok(apiSource.includes("case 'upgrade_dsh'"), 'api.js 保留 upgrade_dsh case')
  assert.ok(apiSource.includes("case 'reboot_dsh'"), 'api.js 保留 reboot_dsh case')
  const systemSource = read('src/services/system.js')
  assert.ok(systemSource.includes('async upgradeDsh('), 'system.js 保留 upgradeDsh 方法')
  assert.ok(systemSource.includes('async rebootDsh('), 'system.js 保留 rebootDsh 方法')
  const systemVersionLiteral = /version:\s*'0\.2\.0'/.test(systemSource)
  assert.ok(!systemVersionLiteral, 'health() 不得再硬编码版本号')
})
