// DSHBOTS-146：dsh 宿主运行时版本探测链。
// 宿主进程从不设置 DSH_RUNTIME_VERSION（全宿主 grep 零命中），env-only 读取恒 unknown。
// 探测链三级回退：env → process.argv[1] 向上最多 6 级找宿主 package.json → 'unknown'。
// 纯函数注入 env/argv1，全部用临时目录，不依赖真实宿主。
// 数据流终点两例（查到链路终点纪律）：dshUpdateInfo().current 与
// capabilityInfo()（state().dsh.version 的数据源，即「DSH 服务」卡「dsh 当前版本」一行）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectDshRuntimeVersion } from '../src/updater.js'
import { lifecycleMethods } from '../src/services/runtime/lifecycle.js'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

async function pkgAt(dir, body) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), typeof body === 'string' ? body : JSON.stringify(body))
}

test('探测链①：DSH_RUNTIME_VERSION 优先，即使 argv1 也能命中 package.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-version-env-'))
  try {
    await pkgAt(join(root, 'host-pkg'), { name: 'host', version: '0.2.1-rc.5' })
    const cli = join(root, 'host-pkg', 'bin', 'cli.js')
    assert.equal(
      detectDshRuntimeVersion({ DSH_RUNTIME_VERSION: '9.9.9' }, cli),
      '9.9.9',
      'env 提供时必须优先，不走 argv 探测',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('探测链②：env 缺失时从 argv[1] 向上找宿主 package.json 读 version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-version-argv-'))
  try {
    // 模拟真实宿主布局：…/@deepseek-ai/dsh/bin/cli.js，包根在两级向上。
    await pkgAt(join(root, '@deepseek-ai', 'dsh'), { name: '@deepseek-ai/dsh', version: '0.2.1-rc.5' })
    const cli = join(root, '@deepseek-ai', 'dsh', 'bin', 'cli.js')
    assert.equal(detectDshRuntimeVersion({}, cli), '0.2.1-rc.5', 'env 未设置时走 argv 探测')
    assert.equal(detectDshRuntimeVersion({ DSH_RUNTIME_VERSION: '' }, cli), '0.2.1-rc.5', '空串 env 视为未设置')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('探测链③：env 与 argv 全 miss 返回 unknown，不依赖真实宿主环境', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-version-miss-'))
  try {
    // 入口埋在 6 层子目录下：探测链最多检查 6 级（n6…n1），到不了 root 之上，
    // 结果不依赖系统 tmp 树里是否有别人的 package.json。
    const deep = join(root, 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'cli.js')
    assert.equal(detectDshRuntimeVersion({}, deep), 'unknown', '6 级内无 package.json 应返回 unknown')
    assert.equal(detectDshRuntimeVersion({}, undefined), 'unknown', '无 argv1 时直接 unknown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('探测上限：向上最多 6 级（含起始目录），第 6 级命中、第 7 级不取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-version-cap-'))
  try {
    await pkgAt(root, { name: 'host-root', version: '1.2.3' })
    const cliAt = (...ns) => join(root, ...ns, 'cli.js')
    // n5 起：检查 n5,n4,n3,n2,n1,root —— root 是第 6 级，命中。
    assert.equal(detectDshRuntimeVersion({}, cliAt('n1', 'n2', 'n3', 'n4', 'n5')), '1.2.3')
    // n6 起：检查 n6…n1 共 6 级为止，root 是第 7 级，取不到。
    assert.equal(detectDshRuntimeVersion({}, cliAt('n1', 'n2', 'n3', 'n4', 'n5', 'n6')), 'unknown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('容错：坏 JSON 或缺 version 的 package.json 跳过继续向上', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-version-broken-'))
  try {
    await pkgAt(root, { name: 'host-root', version: '3.0.0' })
    await pkgAt(join(root, 'mid'), '{"version": "0.1.0", oops')
    await pkgAt(join(root, 'mid', 'inner'), { name: 'no-version-field' })
    // 检查序：deeper（无 pkg）→ inner（pkg 缺 version，跳过）→ mid（JSON 损坏，跳过）→ root（命中）。
    const cli = join(root, 'mid', 'inner', 'deeper', 'cli.js')
    assert.equal(detectDshRuntimeVersion({}, cli), '3.0.0', '坏 JSON/缺 version 不得中断探测')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// —— 数据流终点（真实 service 调用链，setup 先例：tests/dsh-service-card.test.js）——

class HoldingRuntime {
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

async function setupService() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-version-service-'))
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

// 临时宿主包：bin/cli.js + 包根 package.json（version 0.2.1-rc.5），模拟生产 argv[1] 落位。
async function makeTempHost(root) {
  await pkgAt(join(root, 'host', '@deepseek-ai', 'dsh'), { name: '@deepseek-ai/dsh', version: '0.2.1-rc.5' })
  return join(root, 'host', '@deepseek-ai', 'dsh', 'bin', 'cli.js')
}

test('数据流终点①：dshUpdateInfo().current 走探测链取宿主包版本，并参与可升级判定', async () => {
  const ctx = await setupService()
  const hostCli = await makeTempHost(ctx.root)
  const realArgv1 = process.argv[1]
  const realVersion = process.env.DSH_RUNTIME_VERSION
  const realFetch = globalThis.fetch
  delete process.env.DSH_RUNTIME_VERSION
  process.argv[1] = hostCli
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('%40deepseek-ai') || target.includes('@deepseek-ai')) {
      return { ok: true, json: async () => ({ versions: { '0.2.1-rc.5': {}, '0.2.200': {} }, 'dist-tags': { latest: '0.2.200' } }) }
    }
    if (target.includes('dsh-team-bots')) {
      return { ok: true, json: async () => ({ versions: { '0.0.0-stage': {} }, 'dist-tags': { latest: '0.0.0-stage' } }) }
    }
    throw new Error(`意外请求：${target}`)
  }
  try {
    const info = await ctx.service.dshUpdateInfo()
    assert.equal(info.current, '0.2.1-rc.5', 'env 未设置时 current 必须来自 argv[1] 探测，而非 unknown')
    assert.equal(info.updateAvailable, true, 'current 参与可升级判定（0.2.200 > 0.2.1-rc.5）')
  } finally {
    process.argv[1] = realArgv1
    if (realVersion === undefined) delete process.env.DSH_RUNTIME_VERSION
    else process.env.DSH_RUNTIME_VERSION = realVersion
    globalThis.fetch = realFetch
    ctx.store.close()
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('数据流终点②：capabilityInfo() 经 state().dsh.version 下发探测链版本（卡片数据源）', async () => {
  const ctx = await setupService()
  const hostCli = await makeTempHost(ctx.root)
  const realArgv1 = process.argv[1]
  const realVersion = process.env.DSH_RUNTIME_VERSION
  delete process.env.DSH_RUNTIME_VERSION
  process.argv[1] = hostCli
  // 用真实 lifecycle.capabilityInfo（最小 this 绑定）替换 HoldingRuntime 缺省的 capabilityInfo，
  // 断言修复落在生产代码路径上，而非测试替身。
  ctx.service.runtime.capabilityInfo = lifecycleMethods.capabilityInfo.bind({ ctx: {}, modelsCache: { value: [] } })
  try {
    const info = ctx.service.runtime.capabilityInfo()
    assert.equal(info.version, '0.2.1-rc.5', 'capabilityInfo().version 必须走探测链')
    const view = await ctx.service.state(null, null)
    assert.equal(view.dsh.version, '0.2.1-rc.5', 'state().dsh.version 是「DSH 服务」卡「dsh 当前版本」行的数据源，不得为 unknown')
  } finally {
    process.argv[1] = realArgv1
    if (realVersion === undefined) delete process.env.DSH_RUNTIME_VERSION
    else process.env.DSH_RUNTIME_VERSION = realVersion
    ctx.store.close()
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('源码守门：DSH_RUNTIME_VERSION 直读只允许存在于探测链内', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const rootDir = join(here, '..')
  const read = rel => readFileSync(join(rootDir, rel), 'utf8')
  const systemSource = read('src/services/system.js')
  const lifecycleSource = read('src/services/runtime/lifecycle.js')
  const updaterSource = read('src/updater.js')
  assert.ok(!systemSource.includes('DSH_RUNTIME_VERSION'), 'system.js 不得再直读 env，须走 detectDshRuntimeVersion')
  assert.ok(!lifecycleSource.includes('DSH_RUNTIME_VERSION'), 'lifecycle.js 同上')
  assert.ok(
    systemSource.includes('detectDshRuntimeVersion(process.env, process.argv[1])'),
    'system.js 两处调用点（dshUpdateInfo/upgradeDsh）必须走探测链',
  )
  assert.ok(
    lifecycleSource.includes('detectDshRuntimeVersion(process.env, process.argv[1])'),
    'capabilityInfo 的 version 必须走探测链',
  )
  assert.ok(
    updaterSource.includes('export function detectDshRuntimeVersion'),
    '探测链唯一归属 src/updater.js',
  )
})
