// 完全权限总开关（总览 bots 页「免审权限」卡）：settings 'approval_full_access'
// 存 '1'/'0'——打开后所有 bot 与派发任务的生效沙箱统一 danger-full-access，优先于
// 非写运行的 run_type 降档与任务派发覆盖（只收紧档不再生效）；派单策略闸不再拦
// 配置只读的 bot；bot 不能自批开关（与免审规则同一信任边界）；bump settings_revision
// 让客户端轮询即刷。各 bot 配置档与覆盖值原样保留，关掉即恢复原判定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { effectiveSandbox, sandboxModeForRun, APPROVAL_FULL_ACCESS_SETTING } from '../src/services/runtime/sandbox-policy.js'

class FakeRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-full-access-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new FakeRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

async function cleanup(root, store) {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const user = { type: 'user', id: 'u_owner' }
const writeRun = { kind: 'task', mode: 'write' }

test('纯函数层：fullAccess 优先于 run_type 降档、派发覆盖与 bot 配置档', () => {
  const bot = { file_policy: 'workspace-write' }
  const readOnlyBot = { file_policy: 'read-only' }
  // 非写运行、覆盖收紧、只读配置档，打开开关后一律 danger-full-access。
  assert.deepEqual(effectiveSandbox({ kind: 'chat', mode: 'read' }, bot, null, true), { mode: 'danger-full-access', source: 'full_access' })
  assert.deepEqual(effectiveSandbox(writeRun, bot, { sandbox_override: 'read-only' }, true), { mode: 'danger-full-access', source: 'full_access' })
  assert.deepEqual(effectiveSandbox(writeRun, readOnlyBot, { sandbox_override: 'read-only' }, true), { mode: 'danger-full-access', source: 'full_access' })
  assert.equal(sandboxModeForRun({ kind: 'dm', mode: 'read' }, bot, true), 'danger-full-access')
  assert.equal(sandboxModeForRun(writeRun, readOnlyBot, true), 'danger-full-access')
  // 关闭（缺省 false）时既有口径逐字不变。
  assert.deepEqual(effectiveSandbox({ kind: 'chat', mode: 'read' }, bot, null), { mode: 'read-only', source: 'run_type' })
  assert.deepEqual(effectiveSandbox(writeRun, bot, { sandbox_override: 'read-only' }), { mode: 'read-only', source: 'override' })
  assert.deepEqual(effectiveSandbox(writeRun, readOnlyBot, null), { mode: 'read-only', source: 'bot_config' })
  assert.equal(sandboxModeForRun({ kind: 'chat' }, bot), 'read-only')
})

test('开关读写：仅 owner 可写，落 settings、随 state 下发，bot 自批被拒', async () => {
  const { root, store, service } = await setup()
  try {
    assert.equal(service.fullAccessAllEnabled(), false, '默认关闭')
    assert.equal(store.setting(APPROVAL_FULL_ACCESS_SETTING), null, '默认不落键')
    await assert.rejects(
      () => service.updateApprovalFullAccess(true, { type: 'bot', id: 'bot_x' }),
      /仅工作台 owner/, 'bot 不能自批权限开关',
    )
    assert.deepEqual(await service.updateApprovalFullAccess(true, user), { enabled: true })
    assert.equal(store.setting(APPROVAL_FULL_ACCESS_SETTING), '1')
    assert.equal(service.fullAccessAllEnabled(), true)
    const state = await service.state(null)
    assert.equal(state.approvalFullAccess, true, '开关态随 state 下发（UI toggle 唯一真值）')
    assert.ok(service.settingsRevision() >= 1, '保存推进 settings_revision，轮询即刷')
    await service.updateApprovalFullAccess(false, user)
    assert.equal(service.fullAccessAllEnabled(), false, '关闭后恢复原判定')
    assert.equal(store.setting(APPROVAL_FULL_ACCESS_SETTING), '0')
  } finally {
    await cleanup(root, store)
  }
})

test('派单策略闸：开关打开时只读配置 bot 可承接写卡，关闭即恢复拦截', async () => {
  const { root, store, service } = await setup()
  try {
    const auditor = await service.createBot({ name: 'Auditor', role: '审查', instructions: 'Audit.', provider: 'fake', model: 'model-a', filePolicy: 'read-only' })
    assert.throws(() => service.assertWritableDispatch(auditor.id, ['src/a.js']), /只读策略/, '默认按配置档拦截')
    await service.updateApprovalFullAccess(true, user)
    service.assertWritableDispatch(auditor.id, ['src/a.js'])
    await service.updateApprovalFullAccess(false, user)
    assert.throws(() => service.assertWritableDispatch(auditor.id, ['src/a.js']), /只读策略/, '关闭后恢复拦截')
    // 无写范围的卡不受本闸影响（既有口径）。
    service.assertWritableDispatch(auditor.id, [])
  } finally {
    await cleanup(root, store)
  }
})
