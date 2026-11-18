import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig, applyRuntimeSettingOverrides, validateRuntimeSettingValue, RUNTIME_SETTING_DEFS, effectiveTaskTimeBudgetMinutes } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { readUiSource } from './helpers/ui-sources.js'

const source = readUiSource()

async function withEnv(vars, fn) {
  const saved = {}
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value as string
  }
  try { return await fn() } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value as string | undefined
    }
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-runtime-settings-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, modelCacheMs: 0 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  await service.initialize()
  service.started = true
  return { root, store, service, async close() { store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('目录覆盖所有运行期 DSH_TEAM_* 变量（键/env 一致且无重复）', async () => {
  const keys = new Set(RUNTIME_SETTING_DEFS.map(d => d.key))
  const envs = new Set(RUNTIME_SETTING_DEFS.map(d => d.env))
  assert.equal(keys.size, RUNTIME_SETTING_DEFS.length)
  assert.equal(envs.size, RUNTIME_SETTING_DEFS.length)
  // 抽查关键条目都在
  for (const key of ['max_concurrent_runs', 'max_run_tokens', 'worker_preset', 'router_preset', 'github_watch', 'code_hygiene_exts', 'chat_max_chars', 'agent_team']) {
    assert.ok(keys.has(key), key)
  }
})

test('validateRuntimeSettingValue：int/bool/extlist/json 口径', async () => {
  const intDef = RUNTIME_SETTING_DEFS.find(d => d.key === 'max_concurrent_runs')
  assert.equal(validateRuntimeSettingValue(intDef, '12').value, 12)
  assert.equal(validateRuntimeSettingValue(intDef, '99').ok, false)
  assert.equal(validateRuntimeSettingValue(intDef, '1.5').ok, false)
  const boolDef = RUNTIME_SETTING_DEFS.find(d => d.key === 'agent_team')
  assert.deepEqual(validateRuntimeSettingValue(boolDef, 'true'), { ok: true, normalized: '1', value: true })
  assert.equal(validateRuntimeSettingValue(boolDef, 'x').ok, false)
  const extDef = RUNTIME_SETTING_DEFS.find(d => d.key === 'code_hygiene_exts')
  assert.deepEqual(validateRuntimeSettingValue(extDef, 'js, ts;lua').value, ['js', 'ts', 'lua'])
  const jsonDef = RUNTIME_SETTING_DEFS.find(d => d.key === 'github_watch')
  assert.equal(validateRuntimeSettingValue(jsonDef, '[{"projectKey":"A","repo":"o/r"}]').ok, true)
  assert.equal(validateRuntimeSettingValue(jsonDef, '{"a":1}').ok, false)
  assert.equal(validateRuntimeSettingValue(jsonDef, '[{"projectKey":"A"}]').ok, false)
})

test('updateSettings 保存后 this.config 即时生效；清除保存值回默认', async () => {
  await withEnv({ DSH_TEAM_MAX_RUNS: undefined, DSH_TEAM_WORKER_PRESET: undefined }, async () => {
    const { service, close } = await setup()
    try {
      assert.equal(service.config.maxConcurrentRuns, 10)
      const view = service.updateSettings({ max_concurrent_runs: '4', worker_preset: 'minimal' })
      assert.equal(view.max_concurrent_runs, '4')
      assert.equal(service.config.maxConcurrentRuns, 4)
      assert.equal(service.config.workerPreset, 'minimal')
      // 清除保存值（空串）回默认
      service.updateSettings({ max_concurrent_runs: '', worker_preset: '' })
      assert.equal(service.config.maxConcurrentRuns, 10)
      assert.equal(service.config.workerPreset, '')
    } finally { await close() }
  })
})

test('env 显式设置仍最高优先，页面保存值不生效', async () => {
  await withEnv({ DSH_TEAM_MAX_RUNS: '3' }, async () => {
    const { service, close } = await setup()
    try {
      service.updateSettings({ max_concurrent_runs: '8' })
      assert.equal(service.config.maxConcurrentRuns, 3)
      const rows = service.runtimeSettingsView().rows
      const row = rows.find(r => r.key === 'max_concurrent_runs')
      assert.equal(row.envExplicit, true)
      assert.equal(row.effective, '3')
    } finally { await close() }
  })
})

test('updateSettings 对目录键非法值 badRequest', async () => {
  const { service, close } = await setup()
  try {
    assert.throws(() => service.updateSettings({ max_teammates: '99' }), /max_teammates/)
    assert.throws(() => service.updateSettings({ github_watch: 'not-json' }), /github_watch/)
  } finally { await close() }
})

test('task_time_budget_minutes：保存值 > 看门狗兜底；env 最高', async () => {
  await withEnv({ DSH_TEAM_TASK_TIME_BUDGET_MINUTES: undefined, DSH_TEAM_STALL_TIMEOUT_MS: undefined }, async () => {
    const { service, close } = await setup()
    try {
      const config = resolveConfig({})
      // 未保存：看门狗 20 分钟兜底
      assert.equal(effectiveTaskTimeBudgetMinutes(config, () => null), 20)
      // 保存值覆盖看门狗兜底
      service.updateSettings({ task_time_budget_minutes: '55' })
      assert.equal(effectiveTaskTimeBudgetMinutes(service.baseConfig, key => service.store.setting(key)), 55)
    } finally { await close() }
  })
  await withEnv({ DSH_TEAM_TASK_TIME_BUDGET_MINUTES: '77' }, async () => {
    const config = resolveConfig({})
    assert.equal(effectiveTaskTimeBudgetMinutes(config, () => '55'), 77)
  })
})

test('全局设置页渲染「运行参数」卡与保存动作', async () => {
  assert.ok(source.includes('renderRuntimeSettingsCard'), 'ui 应包含运行参数卡')
  assert.ok(source.includes('save-runtime-settings'), 'ui 应包含保存动作')
  assert.ok(source.includes('data-runtime-setting'), 'ui 应按目录键收集输入')
  // i18n：目录键每个都有中英标签
  const { readFileSync } = await import('node:fs')
  const zh = readFileSync(new URL('../ui/i18n/zh/settings.js', import.meta.url), 'utf8')
  const en = readFileSync(new URL('../ui/i18n/en/settings.js', import.meta.url), 'utf8')
  for (const def of RUNTIME_SETTING_DEFS) {
    assert.ok(zh.includes(`global.rs.${def.key}`), `zh i18n 缺 global.rs.${def.key}`)
    assert.ok(en.includes(`global.rs.${def.key}`), `en i18n 缺 global.rs.${def.key}`)
  }
})

test('applyRuntimeSettingOverrides 无保存值时原样返回 config', async () => {
  await withEnv({ DSH_TEAM_MAX_RUNS: undefined, DSH_TEAM_AGENT_TEAM: undefined }, async () => {
    const config = resolveConfig({})
    assert.equal(applyRuntimeSettingOverrides(config, () => null), config)
  })
})

test('Bot 级 agent preset 覆盖：createBot/updateBot 落库，defaultAgentPreset 逐 bot 生效', async () => {
  await withEnv({ DSH_TEAM_WORKER_PRESET: undefined, DSH_TEAM_ROUTER_PRESET: undefined }, async () => {
    const { service, close } = await setup()
    try {
      const bot = await service.createBot({ name: 'presetbot', role: '开发', instructions: 'x' })
      // 新建默认空 = 跟随全局
      assert.equal(bot.agentPreset, '')
      // updateBot 设置 per-bot 覆盖
      const updated = await service.updateBot(bot.id, { agentPreset: 'ptc' })
      assert.equal(updated.agentPreset, 'ptc')
      // 清空回跟随全局
      assert.equal((await service.updateBot(bot.id, { agentPreset: '' })).agentPreset, '')

      // defaultAgentPreset：bot 覆盖 > 全局 workerPreset > standard
      const { sessionMethods } = await import('../src/services/runtime/session.js')
      const make = (config, rosterBot) => Object.assign(Object.create(null), sessionMethods, {
        ctx: { get: name => name === 'agentPresets'
          ? { list: async () => [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }] } : null },
        config,
      })
      const row = { agent_preset: 'ptc' }
      assert.deepEqual(await make({ workerPreset: '' }, row).defaultAgentPreset('project', row), { agentPreset: 'ptc' })
      assert.deepEqual(await make({ workerPreset: 'minimal' }, row).defaultAgentPreset('task', row), { agentPreset: 'ptc' })
      const plain = { agent_preset: '' }
      assert.deepEqual(await make({ workerPreset: 'minimal' }, plain).defaultAgentPreset('task', plain), { agentPreset: 'minimal' })
      assert.deepEqual(await make({ workerPreset: '', routerPreset: '' }, plain).defaultAgentPreset('project', plain), { agentPreset: 'standard' })
      // bot 覆盖写了不存在的 preset → 回落 standard，不炸
      const ghost = { agent_preset: 'ghost' }
      assert.deepEqual(await make({ workerPreset: '' }, ghost).defaultAgentPreset('task', ghost), { agentPreset: 'standard' })
      // 未传 bot（历史调用形态）走全局链
      assert.deepEqual(await make({ workerPreset: 'minimal' }, null).defaultAgentPreset('task', null), { agentPreset: 'minimal' })
      // 两级都空且宿主注册表带 defaultId：跟随宿主默认
      const withDefault = Object.assign(Object.create(null), sessionMethods, {
        ctx: { get: () => ({ list: async () => [{ id: 'standard' }, { id: 'ptc' }], defaultId: 'ptc' }) },
        config: { workerPreset: '', routerPreset: '' },
      })
      assert.deepEqual(await withDefault.defaultAgentPreset('task', plain), { agentPreset: 'ptc' })
    } finally { await close() }
  })
})
