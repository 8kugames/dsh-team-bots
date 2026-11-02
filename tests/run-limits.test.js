import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig, effectiveRunLimits, RUN_TIMEOUT_KEY, STALL_WATCHDOG_KEY } from '../src/config.js'
import { TeamService } from '../src/service.js'

const MIN = 60_000
const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')

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

// 与 tests/core.test.js 的 setup 同构，但允许注入 env，供 env 覆盖用例独占配置。
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-run-limits-'))
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

test('默认运行时效：超时 2 小时、看门狗 30 分钟', async () => {
  await withEnv({ DSH_TEAM_RUN_TIMEOUT_MS: undefined, DSH_TEAM_STALL_TIMEOUT_MS: undefined }, () => {
    const config = resolveConfig({})
    const limits = effectiveRunLimits(config, () => null)
    assert.equal(limits.runTimeoutMs, 120 * MIN)
    assert.equal(limits.stallTimeoutMs, 30 * MIN)
    assert.equal(limits.runTimeoutEnv, false)
    assert.equal(limits.stallTimeoutEnv, false)
  })
})

test('env 显式设置优先于页面保存值', async () => {
  await withEnv({ DSH_TEAM_RUN_TIMEOUT_MS: String(20 * MIN), DSH_TEAM_STALL_TIMEOUT_MS: String(5 * MIN) }, () => {
    const config = resolveConfig({})
    const limits = effectiveRunLimits(config, key => (key === RUN_TIMEOUT_KEY ? '45' : '0'))
    assert.equal(limits.runTimeoutMs, 20 * MIN)
    assert.equal(limits.stallTimeoutMs, 5 * MIN)
    assert.equal(limits.runTimeoutEnv, true)
    assert.equal(limits.stallTimeoutEnv, true)
  })
})

test('页面保存值优先于默认值；看门狗保存 0 表示关闭', async () => {
  await withEnv({ DSH_TEAM_RUN_TIMEOUT_MS: undefined, DSH_TEAM_STALL_TIMEOUT_MS: undefined }, () => {
    const config = resolveConfig({})
    const limits = effectiveRunLimits(config, key => (key === RUN_TIMEOUT_KEY ? '45' : '0'))
    assert.equal(limits.runTimeoutMs, 45 * MIN)
    assert.equal(limits.stallTimeoutMs, 0)
    assert.equal(limits.runTimeoutEnv, false)
    assert.equal(limits.stallTimeoutEnv, false)
  })
})

test('env 空白字符串不算显式设置，页面保存值仍生效', async () => {
  await withEnv({ DSH_TEAM_RUN_TIMEOUT_MS: '  ', DSH_TEAM_STALL_TIMEOUT_MS: ' ' }, () => {
    const config = resolveConfig({})
    const limits = effectiveRunLimits(config, key => (key === RUN_TIMEOUT_KEY ? '60' : '10'))
    assert.equal(limits.runTimeoutMs, 60 * MIN)
    assert.equal(limits.stallTimeoutMs, 10 * MIN)
    assert.equal(limits.runTimeoutEnv, false)
    assert.equal(limits.stallTimeoutEnv, false)
  })
})

test('保存值越界或非法按未保存回退默认', async () => {
  await withEnv({ DSH_TEAM_RUN_TIMEOUT_MS: undefined, DSH_TEAM_STALL_TIMEOUT_MS: undefined }, () => {
    const config = resolveConfig({})
    for (const bad of ['0', '361', 'abc', '1.5', '-5']) {
      const limits = effectiveRunLimits(config, () => bad)
      assert.equal(limits.runTimeoutMs, 120 * MIN, `run_timeout=${bad} 应回退默认`)
    }
    for (const bad of ['-1', '361', 'abc', '2.5']) {
      const limits = effectiveRunLimits(config, key => (key === STALL_WATCHDOG_KEY ? bad : null))
      assert.equal(limits.stallTimeoutMs, 30 * MIN, `stall_watchdog=${bad} 应回退默认`)
    }
  })
})

test('updateSettings 校验运行时效范围并落库生效', async () => {
  const ctx = await setup()
  try {
    const actor = { type: 'chief', id: 'chief' }
    await ctx.service.updateSettings({ [RUN_TIMEOUT_KEY]: '45', [STALL_WATCHDOG_KEY]: '15' })
    assert.equal(ctx.store.setting(RUN_TIMEOUT_KEY, ''), '45')
    assert.equal(ctx.store.setting(STALL_WATCHDOG_KEY, ''), '15')
    const view = ctx.service.runLimitsView()
    assert.equal(view.runTimeoutMinutes, 45)
    assert.equal(view.stallTimeoutMinutes, 15)
    assert.equal(view.runTimeoutEnv, false)

    // 看门狗 0（关闭）是合法保存值。
    await ctx.service.updateSettings({ [STALL_WATCHDOG_KEY]: '0' })
    assert.equal(ctx.service.runLimitsView().stallTimeoutMinutes, 0)

    // 空串 = 清除保存值，回退默认。
    await ctx.service.updateSettings({ [RUN_TIMEOUT_KEY]: '' })
    assert.equal(ctx.service.runLimitsView().runTimeoutMinutes, 120)

    // 越界与非法输入一律 badRequest，不静默钳制。updateSettings 是同步方法，
    // 同步 throw 时 assert.rejects 会把原始错误原样外抛，必须用 assert.throws。
    assert.throws(() => ctx.service.updateSettings({ [RUN_TIMEOUT_KEY]: '0' }), /run_timeout_minutes/)
    assert.throws(() => ctx.service.updateSettings({ [RUN_TIMEOUT_KEY]: '361' }), /1–360/)
    assert.throws(() => ctx.service.updateSettings({ [STALL_WATCHDOG_KEY]: '-1' }), /stall_watchdog_minutes/)
    assert.throws(() => ctx.service.updateSettings({ [STALL_WATCHDOG_KEY]: 'abc' }), /0–360/)
    assert.throws(() => ctx.service.updateSettings({ [STALL_WATCHDOG_KEY]: '1.5' }), /0–360/)
  } finally {
    await ctx.close()
  }
})

test('保存运行时效写 global.run_limits 审计', async () => {
  const ctx = await setup()
  try {
    await ctx.service.updateSettings({ [RUN_TIMEOUT_KEY]: '90', [STALL_WATCHDOG_KEY]: '20' })
    const rows = ctx.store.all(
      "SELECT * FROM audit_log WHERE action = 'settings.update' AND target_id = 'global.run_limits' ORDER BY created_at",
    )
    assert.equal(rows.length, 1)
    const data = JSON.parse(rows[0].data_json)
    assert.equal(data[RUN_TIMEOUT_KEY], '90')
    assert.equal(data[STALL_WATCHDOG_KEY], '20')
  } finally {
    await ctx.close()
  }
})

test('state 大视图带 runLimits 供回显，env 覆盖时给出标志', async () => {
  await withEnv({ DSH_TEAM_RUN_TIMEOUT_MS: String(60 * MIN) }, async () => {
    const ctx = await setup()
    try {
      const state = await ctx.service.state()
      assert.equal(state.runLimits.runTimeoutMinutes, 60)
      assert.equal(state.runLimits.runTimeoutEnv, true)
      assert.equal(state.runLimits.stallTimeoutEnv, false)
      assert.ok(state.settings !== undefined)
    } finally {
      await ctx.close()
    }
  })
})

test('全局配置页渲染运行时效卡与保存动作', () => {
  assert.match(source, /function renderRunLimitsCard\(\)/)
  assert.match(source, /\$\{renderRunLimitsCard\(\)\}/)
  assert.match(source, /id="settings-run-timeout"/)
  assert.match(source, /id="settings-stall-watchdog"/)
  assert.match(source, /data-action="save-run-limits"/)
  assert.match(source, /case 'save-run-limits':/)
  // 输入 name 与后端 settings 键一致，保存走 update_settings。
  assert.match(source, /name="run_timeout_minutes"/)
  assert.match(source, /name="stall_watchdog_minutes"/)
  assert.match(source, /run_timeout_minutes: value\('settings-run-timeout'\)/)
  // 生效语义说明：进行中不追溯。
  assert.match(source, /进行中的运行不追溯/)
})
