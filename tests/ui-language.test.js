import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig, effectiveUiLanguage, UI_LANGUAGE_KEY } from '../src/config.js'
import { resolveUiLanguage } from '../src/services/locale.js'
import { TeamService } from '../src/service.js'
import { normalizeLanguage } from '../ui/modules/i18n.js'

// env 用例独占进程环境：用例内 set、finally 内 delete，避免串扰其他套件。
async function withEnv(vars, fn) {
  const saved = {}
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// 与 tests/run-limits.test.js 的 setup 同构；DSH_HOME 指向不存在的目录，
// 使宿主 patch 文件读不到 → resolveDshUiLanguage 恒 'auto'，用例不依赖本机 ~/.dsh 实际设定。
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-ui-language-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'no-such-dsh-home')
  let config
  try {
    config = resolveConfig({ workspace, dataDir, modelCacheMs: 0 })
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  await service.initialize()
  service.started = true
  return { root, store, service, config, async close() { store.close(); await rm(root, { recursive: true, force: true }) } }
}

// 假 loader：模拟同进程直读 DSH 宿主 locale 插件条目（options.id='locale'）。
const hostLoader = (preference) => ({
  entries: () => [{ options: { id: 'locale', config: { preference } } }],
})

test('显式 zh/en 覆盖宿主解析', async () => {
  await withEnv({ DSH_TEAM_UI_LANGUAGE: undefined }, async () => {
    // 宿主是 en，页面显式 zh 应压住宿主。
    assert.equal(await resolveUiLanguage({ loader: hostLoader('en-US'), uiLanguage: 'zh' }), 'zh')
    // 宿主是 zh，页面显式 en 应压住宿主。
    assert.equal(await resolveUiLanguage({ loader: hostLoader('zh-CN'), uiLanguage: 'en' }), 'en')
  })
})

test('auto 跟随宿主解析；非法保存值按 auto 处理', async () => {
  await withEnv({ DSH_TEAM_UI_LANGUAGE: undefined }, async () => {
    assert.equal(await resolveUiLanguage({ loader: hostLoader('zh-CN'), uiLanguage: 'auto' }), 'zh')
    assert.equal(await resolveUiLanguage({ loader: hostLoader('en-GB'), uiLanguage: 'auto' }), 'en')
    // 非法值不落显式分支，回落宿主链。
    assert.equal(await resolveUiLanguage({ loader: hostLoader('zh-CN'), uiLanguage: 'fr' }), 'zh')
  })
})

test('无宿主设定落 auto，交浏览器 navigator 收敛', async () => {
  await withEnv({ DSH_TEAM_UI_LANGUAGE: undefined }, async () => {
    const resolved = await resolveUiLanguage({
      loader: null,
      dshHome: '/nonexistent-dsh-home',
      profile: 'team-bots',
      uiLanguage: 'auto',
    })
    assert.equal(resolved, 'auto')
    // 客户端 normalizeLanguage('auto') 按 navigator 收敛（Node ≥21 通常 en-US）。
    const navLang = String(globalThis.navigator?.language ?? '').toLowerCase()
    assert.equal(normalizeLanguage(resolved), navLang.startsWith('en') ? 'en' : 'zh')
  })
})

test('下拉保存链路：updateSettings 落库 → state.settings 回显 → state.language 同源生效', async () => {
  await withEnv({ DSH_TEAM_UI_LANGUAGE: undefined }, async () => {
    const ctx = await setup()
    try {
      await ctx.service.updateSettings({ [UI_LANGUAGE_KEY]: 'en' })
      assert.equal(ctx.store.setting(UI_LANGUAGE_KEY, ''), 'en')
      const state = await ctx.service.state()
      assert.equal(state.settings[UI_LANGUAGE_KEY], 'en')
      // 显式 en 压住宿主解析（本例无宿主设定）。
      assert.equal(state.language, 'en')

      await ctx.service.updateSettings({ [UI_LANGUAGE_KEY]: 'zh' })
      assert.equal((await ctx.service.state()).language, 'zh')

      // 保存 auto 后回落宿主链：无 loader、无 patch 文件 → 'auto'。
      await ctx.service.updateSettings({ [UI_LANGUAGE_KEY]: 'auto' })
      const after = await ctx.service.state()
      assert.equal(after.settings[UI_LANGUAGE_KEY], 'auto')
      assert.equal(after.language, 'auto')
    } finally {
      await ctx.close()
    }
  })
})

test('无效值收敛 auto：effectiveUiLanguage 回退 + updateSettings 拒绝非法输入', async () => {
  await withEnv({ DSH_TEAM_UI_LANGUAGE: undefined }, () => {
    const config = resolveConfig({})
    // 外部写入的非法保存值按未保存处理，回退默认 'auto'。
    for (const bad of ['fr', '', null, undefined, 'english']) {
      assert.equal(effectiveUiLanguage(config, () => bad), 'auto', `ui_language=${JSON.stringify(bad)} 应收敛 auto`)
    }
    // 合法值大小写不敏感：'ZH ' 收敛为 'zh'。
    assert.equal(effectiveUiLanguage(config, () => 'ZH '), 'zh')
  })
  const ctx = await setup()
  try {
    // 非法输入 badRequest，不静默钳制（与运行时效同口径）。
    assert.throws(() => ctx.service.updateSettings({ [UI_LANGUAGE_KEY]: 'fr' }), /ui_language/)
    // 合法值大小写不敏感，落库统一小写。
    ctx.service.updateSettings({ [UI_LANGUAGE_KEY]: 'EN' })
    assert.equal(ctx.store.setting(UI_LANGUAGE_KEY, ''), 'en')
  } finally {
    await ctx.close()
  }
})

test('env 显式合法值覆盖页面保存值；空白 env 不算显式设置', async () => {
  await withEnv({ DSH_TEAM_UI_LANGUAGE: 'en' }, () => {
    const config = resolveConfig({})
    assert.equal(effectiveUiLanguage(config, () => 'zh'), 'en')
    assert.equal(effectiveUiLanguage(config, () => null), 'en')
  })
  await withEnv({ DSH_TEAM_UI_LANGUAGE: '  ' }, () => {
    const config = resolveConfig({})
    assert.equal(effectiveUiLanguage(config, () => 'zh'), 'zh')
  })
})

test('settingsView 含 ui_language 键，供全局配置页回显', async () => {
  const ctx = await setup()
  try {
    const view = ctx.service.settingsView()
    assert.ok(Object.keys(view).includes(UI_LANGUAGE_KEY))
    assert.equal(view[UI_LANGUAGE_KEY], '')
    await ctx.service.updateSettings({ [UI_LANGUAGE_KEY]: 'zh' })
    assert.equal(ctx.service.settingsView()[UI_LANGUAGE_KEY], 'zh')
  } finally {
    await ctx.close()
  }
})
