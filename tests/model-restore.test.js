// DSHBOTS-118：恢复默认模型报「HMR transactions cannot be nested」。
// 宿主 selectModel 会把下发模型写成默认模型，插件必须恢复运行前的默认值；恢复经
// configEditor.edit → hmr.runExclusive，若调用点残留 HMR 事务的 AsyncLocalStorage
// 上下文，runExclusive 会以「嵌套事务」直接 reject，恢复被 warn 吞掉。
// DSHBOTS-163：模块本身经 HMR 事务加载/热更时，模块评估期创建的 restoreScope
// 捕获到的就是被标记的上下文（生产审计 model_restore_failed 成簇根因）；
// 撞嵌套拒绝时须丢弃污染 scope 自愈重捕获。经 ?query 动态 import 造独立模块
// 实例、令其评估期落在 executing.run 窗口内，忠实模拟该加载路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { restoreDefaultModel, RESTORE_MAX_ATTEMPTS } from '../src/services/runtime/model-restore.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-restore-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new DshRuntime({ ctx: { get: () => undefined }, config, store, logger: { info() {}, warn() {}, error() {} } }))
  await service.initialize()
  return { root, store, service, config }
}

// 忠实照抄 dsh-hmr 的 runExclusive：AsyncLocalStorage 标记事务，嵌套直接 reject。
function createHmrStub() {
  const executing = new AsyncLocalStorage()
  const state = { operations: Promise.resolve(), guarded: [] }
  return {
    executing,
    guarded: state.guarded,
    runExclusive(operation) {
      state.guarded.push(executing.getStore())
      if (executing.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'))
      const task = state.operations.then(async () => executing.run(true, operation))
      state.operations = task.catch(() => {})
      return task
    },
  }
}

const BEFORE = { provider: 'anthropic', model: 'claude-opus' }

test('正常恢复：saveSelection 成功即返回 true，不 warn 不审计', async () => {
  const saves = []
  const warnings = []
  const audits = []
  const ok = await restoreDefaultModel(
    { saveSelection: async (next) => { saves.push(next) } },
    BEFORE,
    { logger: { warn: (message) => warnings.push(message) }, audit: (error) => audits.push(error), retryBaseMs: 1 },
  )
  assert.equal(ok, true)
  assert.deepEqual(saves, [BEFORE])
  assert.deepEqual(warnings, [])
  assert.deepEqual(audits, [])
})

test('嵌上下文恢复：残留 HMR 事务上下文里也能恢复（红对照 + 逃逸）', async () => {
  const hmr = createHmrStub()
  const stores = []
  const defaults = {
    saveSelection: async (next) => {
      stores.push(hmr.executing.getStore())
      await hmr.runExclusive(async () => { await Promise.resolve() })
      return next
    },
  }

  // 红对照：不逃逸时，事务上下文里的 runExclusive 就是被嵌套拒绝的。
  await assert.rejects(
    () => hmr.executing.run(true, () => defaults.saveSelection(BEFORE)),
    /HMR transactions cannot be nested/,
  )
  assert.deepEqual(hmr.guarded, [true], '事务上下文里进 runExclusive 时事务标记仍在，被嵌套拒绝')

  // 修复路径：restoreDefaultModel 把恢复切到事务之外的干净上下文。
  hmr.guarded.length = 0
  stores.length = 0
  const ok = await hmr.executing.run(true, async () => restoreDefaultModel(defaults, BEFORE, { retryBaseMs: 1 }))
  assert.equal(ok, true)
  assert.deepEqual(stores, [undefined], 'saveSelection 进入时不应带事务标记')
  assert.deepEqual(hmr.guarded, [undefined], 'runExclusive 看到的上下文必须是干净的')
})

test('重试穷尽：warn 一次 + 审计 model_restore_failed 落库', async () => {
  const { root, store, config } = await setup()
  try {
    const warnings = []
    const attempts = []
    const hmr = createHmrStub()
    const defaults = {
      saveSelection: async (next) => {
        attempts.push(next)
        await hmr.runExclusive(async () => { throw new Error('HMR transactions cannot be nested') })
      },
    }
    const sessionId = 'sess-retry'
    const ok = await restoreDefaultModel(defaults, BEFORE, {
      logger: { warn: (message, error) => warnings.push(`${message} ${error}`) },
      audit: (error) => store.audit('system', 'system', 'model_restore_failed', 'session', sessionId, {
        provider: BEFORE.provider,
        model: BEFORE.model,
        error: error instanceof Error ? error.message : String(error),
      }),
      retryBaseMs: 1,
    })
    assert.equal(ok, false)
    assert.equal(attempts.length, RESTORE_MAX_ATTEMPTS, '首次 + 两次退避重试')
    assert.equal(warnings.length, 1, '穷尽后只 warn 一次')
    assert.match(warnings[0], /restore default model failed/)
    const audit = store.get("SELECT * FROM audit_log WHERE action = 'model_restore_failed' AND target_id = ?", sessionId)
    assert.ok(audit, '失败必须落审计，不能只 warn')
    assert.equal(audit.actor_type, 'system')
    assert.equal(audit.target_type, 'session')
    assert.deepEqual(JSON.parse(audit.data_json), {
      provider: 'anthropic',
      model: 'claude-opus',
      error: 'HMR transactions cannot be nested',
    })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('selectModel 集成：残留上下文里恢复成功，且 selecting 串行语义不变', async () => {
  const { root, store, config } = await setup()
  try {
    const hmr = createHmrStub()
    const saves = []
    const defaults = {
      currentSelection: () => ({ provider: 'anthropic', model: 'claude-opus' }),
      saveSelection: async (next) => {
        saves.push({ next, store: hmr.executing.getStore() })
        await hmr.runExclusive(async () => { await Promise.resolve() })
      },
    }
    const calls = []
    let active = 0
    let maxActive = 0
    const ctx = {
      get: (name) => (name === 'agentDefaultModel' ? defaults : undefined),
      sessionController: {
        selectModel: async (arg) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          calls.push(arg)
          await Promise.resolve()
          active -= 1
          return { selected: { provider: arg.provider, model: arg.model } }
        },
      },
    }
    const warnings = []
    const runtime = new DshRuntime({
      ctx,
      config,
      store,
      logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
    })
    const bot = { id: 'bot-1', name: 'director', provider: 'openai', model: 'gpt-4o-mini' }

    // 在残留的 HMR 事务上下文里连续两次下发不同模型。
    const [first, second] = await hmr.executing.run(true, async () => Promise.all([
      runtime.selectModel('sess-a', bot),
      runtime.selectModel('sess-b', bot, { provider: 'openai', model: 'gpt-4o' }),
    ]))

    assert.equal(first.selected.provider, 'openai')
    assert.equal(second.selected.model, 'gpt-4o')
    assert.equal(maxActive, 1, 'selecting 串行：同一时刻只有一次 selectModel 在飞')
    assert.equal(calls.length, 2)
    assert.equal(saves.length, 2, '两次切换都要恢复默认模型')
    for (const save of saves) {
      assert.equal(save.store, undefined, '恢复动作必须落在事务之外的干净上下文')
      assert.deepEqual(save.next, { provider: 'anthropic', model: 'claude-opus' })
    }
    assert.deepEqual(warnings, [], '恢复成功不应有告警')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'model_restore_failed'").n, 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('自愈重捕获：scope 出生于 HMR 事务上下文时，丢弃重捕后恢复成功', async () => {
  const hmr = createHmrStub()
  // 模拟插件经 HMR 事务加载（安装/热更路径）：模块评估期落在被 executing 标记的
  // 上下文里，模块级 restoreScope 捕获到的即被污染的上下文——生产审计
  // model_restore_failed 成簇的根因。?query 造独立模块实例，不污染顶部干净导入。
  const instance = await hmr.executing.run(true, async () => await import('../src/services/runtime/model-restore.js?born-in-hmr-tx'))
  const stores = []
  const defaults = {
    saveSelection: async (next) => {
      stores.push(hmr.executing.getStore())
      await hmr.runExclusive(async () => { await Promise.resolve() })
      return next
    },
  }
  const ok = await instance.restoreDefaultModel(defaults, BEFORE, { retryBaseMs: 1 })
  assert.equal(ok, true, '出生污染的 scope 必须经一次重捕获自愈才能恢复')
  assert.equal(instance.restoreScopeRecaptures(), 1, '恰好重捕获一次')
  assert.equal(stores.length, 2, '首次尝试被嵌套拒绝，重试即成功')
  assert.equal(stores[0], true, '出生污染的 scope 让第一次尝试仍落在事务标记里')
  assert.equal(stores[1], undefined, '重捕获后的 scope 必须落在干净上下文')
})

test('重捕获复用：成功过的 scope 保留，后续恢复不再重建', async () => {
  const hmr = createHmrStub()
  const instance = await hmr.executing.run(true, async () => await import('../src/services/runtime/model-restore.js?reuse-after-heal'))
  const stores = []
  const defaults = {
    saveSelection: async (next) => {
      stores.push(hmr.executing.getStore())
      await hmr.runExclusive(async () => { await Promise.resolve() })
      return next
    },
  }
  const first = await instance.restoreDefaultModel(defaults, BEFORE, { retryBaseMs: 1 })
  assert.equal(first, true)
  assert.equal(instance.restoreScopeRecaptures(), 1, '第一次调用自愈重捕获一次')
  const second = await instance.restoreDefaultModel(defaults, BEFORE, { retryBaseMs: 1 })
  assert.equal(second, true)
  assert.equal(instance.restoreScopeRecaptures(), 1, '成功过的干净 scope 直接复用，不再重建')
  assert.equal(stores.length, 3, '第一次 2 次尝试（污染+自愈）+ 第二次直接成功')
  assert.equal(stores[2], undefined, '第二次调用直接落在复用的干净 scope 上')
})
