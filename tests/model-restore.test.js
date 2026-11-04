// DSHBOTS-118：恢复默认模型报「HMR transactions cannot be nested」。
// 宿主 selectModel 会把下发模型写成默认模型，插件必须恢复运行前的默认值；恢复经
// configEditor.edit → hmr.runExclusive，若调用点残留 HMR 事务的 AsyncLocalStorage
// 上下文，runExclusive 会以「嵌套事务」直接 reject，恢复被 warn 吞掉。
// DSHBOTS-175：逃逸口径改为宿主 HMR 服务的 executing.exit（exit 即
// run(undefined, fn)，把回调及其全部 async 延续的 store 置为 undefined），
// 事务上下文里恢复不再被嵌套拒绝；「撞嵌套就重捕 scope」的自愈删除（它在污染
// 调用链里造出的仍是污染 scope，还把模块级干净 scope 覆盖成污染的）。
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
// exits 记录 executing.exit 被调用的次数（生产路径即用它逃逸事务上下文）。
function createHmrStub() {
  const executing = new AsyncLocalStorage()
  const state = { operations: Promise.resolve(), guarded: [], exits: 0 }
  const exit = executing.exit.bind(executing)
  executing.exit = (...args) => {
    state.exits += 1
    return exit(...args)
  }
  return {
    executing,
    guarded: state.guarded,
    get exits() { return state.exits },
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
      audit: (error, meta = {}) => store.audit('system', 'system', 'model_restore_failed', 'session', sessionId, {
        provider: BEFORE.provider,
        model: BEFORE.model,
        error: error instanceof Error ? error.message : String(error),
        ...(meta.escape ? { escape: meta.escape } : {}),
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
      escape: 'scope-polluted',
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
    const ctxNames = []
    let active = 0
    let maxActive = 0
    const ctx = {
      get: (name) => {
        ctxNames.push(name)
        if (name === 'agentDefaultModel') return defaults
        if (name === 'hmr') return hmr
        return undefined
      },
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
    assert.ok(ctxNames.includes('hmr'), 'session.js 必须把宿主 hmr 服务传给恢复逻辑')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'model_restore_failed'").n, 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('逃逸路径：事务上下文里经 executing.exit 恢复，runExclusive 不再被嵌套拒绝', async () => {
  const hmr = createHmrStub()
  const stores = []
  const defaults = {
    saveSelection: async (next) => {
      stores.push(hmr.executing.getStore())
      // 真实链路：configEditor.edit → hmr.runExclusive，事务上下文里会被嵌套拒绝。
      await hmr.runExclusive(async () => { await Promise.resolve() })
      return next
    },
  }
  const ok = await hmr.executing.run(true, async () => {
    const restored = await restoreDefaultModel(defaults, BEFORE, { hmr, retryBaseMs: 1 })
    assert.equal(hmr.executing.getStore(), true, '逃逸不得破坏调用方的事务上下文')
    return restored
  })
  assert.equal(ok, true)
  assert.deepEqual(stores, [undefined], 'saveSelection 必须落在事务标记之外')
  assert.deepEqual(hmr.guarded, [undefined], 'runExclusive 看到的上下文必须是干净的')
  assert.equal(hmr.exits, 1, '必须走 executing.exit 逃逸')
})

test('逃逸路径：事务外调用走 direct，不触发 exit', async () => {
  const hmr = createHmrStub()
  const stores = []
  const defaults = {
    saveSelection: async (next) => {
      stores.push(hmr.executing.getStore())
      return next
    },
  }
  const ok = await restoreDefaultModel(defaults, BEFORE, { hmr, retryBaseMs: 1 })
  assert.equal(ok, true)
  assert.deepEqual(stores, [undefined])
  assert.equal(hmr.exits, 0, 'store 为空时无需 exit')
})

test('逃逸路径：事务外调用走 direct，用调用方上下文而非污染的模块级 scope', async () => {
  const hmr = createHmrStub()
  // 模块实例出生在事务里（模块级 scope 已污染），调用点在事务外：
  // direct 路径用调用方的干净上下文，scope 路径会落到被污染的模块级 scope。
  const instance = await hmr.executing.run(true, async () => await import('../src/services/runtime/model-restore.js?born-in-hmr-tx-direct'))
  const stores = []
  const defaults = {
    saveSelection: async (next) => {
      stores.push(hmr.executing.getStore())
      return next
    },
  }
  const ok = await instance.restoreDefaultModel(defaults, BEFORE, { hmr, retryBaseMs: 1 })
  assert.equal(ok, true)
  assert.deepEqual(stores, [undefined], 'direct 路径必须用调用方的干净上下文')
  assert.equal(hmr.exits, 0, 'store 为空时无需 exit')
})

test('逃逸路径：出生在事务里的模块实例不再靠 scope 自愈，交给 hmr.exit', async () => {
  const hmr = createHmrStub()
  // 模拟插件经 HMR 事务加载（安装/热更路径）：模块评估期落在被 executing 标记的
  // 上下文里，模块级 restoreScope 捕获到的即被污染的上下文。?query 造独立模块
  // 实例，不污染顶部干净导入。
  const instance = await hmr.executing.run(true, async () => await import('../src/services/runtime/model-restore.js?born-in-hmr-tx'))
  const stores = []
  const defaults = {
    saveSelection: async (next) => {
      stores.push(hmr.executing.getStore())
      await hmr.runExclusive(async () => { await Promise.resolve() })
      return next
    },
  }
  const ok = await hmr.executing.run(true, () => instance.restoreDefaultModel(defaults, BEFORE, { hmr, retryBaseMs: 1 }))
  assert.equal(ok, true, '污染的模块级 scope 不得再拖垮恢复')
  assert.deepEqual(stores, [undefined], '恢复必须落在事务标记之外')
  assert.equal(hmr.exits, 1, '必须走 executing.exit 逃逸')

  // 红对照：同一个污染实例在没有 hmr 时只能靠兜底 scope，仍被事务标记拖累。
  const blind = await hmr.executing.run(true, () => instance.restoreDefaultModel(defaults, BEFORE, {
    retryBaseMs: 1,
    logger: { warn() {} },
    audit: () => {},
  }))
  assert.equal(blind, false, '无 hmr 时兜底 scope 无法逃出事务标记')
  assert.equal(stores.at(-1), true, '兜底 scope 出生在事务里，事务标记仍在')
})

test('审计口径：失败时落 escape（hmr-exit），便于判断实际走了哪条路', async () => {
  const hmr = createHmrStub()
  const audits = []
  const warnings = []
  const defaults = {
    saveSelection: async () => { throw new Error('boom') },
  }
  const ok = await hmr.executing.run(true, () => restoreDefaultModel(defaults, BEFORE, {
    hmr,
    logger: { warn: (message) => warnings.push(message) },
    audit: (error, meta = {}) => audits.push({ error, meta }),
    retryBaseMs: 1,
  }))
  assert.equal(ok, false)
  assert.equal(audits.length, 1, '穷尽后只落一条审计')
  assert.equal(audits[0].meta.escape, 'hmr-exit', '审计须记录实际逃逸方式')
  assert.match(audits[0].error.message, /boom/)
  assert.equal(warnings.length, 1)
})

test('兜底路径：hmr 存在但缺少 executing 时走 scope 路径', async () => {
  const stores = []
  const defaults = {
    saveSelection: async (next) => {
      stores.push('called')
      return next
    },
  }
  const ok = await restoreDefaultModel(defaults, BEFORE, { hmr: {}, retryBaseMs: 1 })
  assert.equal(ok, true, '拿不到 executing 时仍应走兜底 scope')
  assert.deepEqual(stores, ['called'])

  // 非嵌套类失败：兜底 scope 本身没被污染，escape 记 scope。
  const audits = []
  const failed = await restoreDefaultModel(
    { saveSelection: async () => { throw new Error('boom') } },
    BEFORE,
    { hmr: {}, retryBaseMs: 1, logger: { warn() {} }, audit: (error, meta = {}) => audits.push({ error, meta }) },
  )
  assert.equal(failed, false)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].meta.escape, 'scope', '非嵌套失败仍记 scope')
})

test('兜底路径：scope 自身被污染时审计记 scope-polluted，区分于干净 scope', async () => {
  const hmr = createHmrStub()
  // 模块实例出生在事务里 → 兜底 scope 已污染；saveSelection 走宿主那条
  // configEditor.edit → hmr.runExclusive 的拒绝路径，错误即嵌套事务拒绝。
  const instance = await hmr.executing.run(true, async () => await import('../src/services/runtime/model-restore.js?born-in-hmr-tx-polluted'))
  const audits = []
  const defaults = {
    saveSelection: async (next) => {
      await hmr.runExclusive(async () => { await Promise.resolve() })
      return next
    },
  }
  const ok = await hmr.executing.run(true, () => instance.restoreDefaultModel(defaults, BEFORE, {
    logger: { warn() {} },
    audit: (error, meta = {}) => audits.push({ error, meta }),
    retryBaseMs: 1,
  }))
  assert.equal(ok, false)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].meta.escape, 'scope-polluted', '污染的兜底 scope 要与干净 scope 区分')
  assert.match(audits[0].error.message, /cannot be nested/)
})

test('超时护栏：排队不落地时超时收口，落审计并标 timedOut', async () => {
  const hmr = createHmrStub()
  const audits = []
  const warnings = []
  const defaults = {
    // 模拟排在宿主事务队列尾、迟迟不落地：永不 resolve。
    saveSelection: () => new Promise(() => {}),
  }
  const ok = await hmr.executing.run(true, () => restoreDefaultModel(defaults, BEFORE, {
    hmr,
    logger: { warn: (message) => warnings.push(message) },
    audit: (error, meta = {}) => audits.push({ error, meta }),
    retryBaseMs: 1,
    timeoutMs: 30,
  }))
  assert.equal(ok, false, '超时必须收口返回 false，不能挂住 selectModel 串行链')
  assert.equal(audits.length, 1, '超时也要落一条审计')
  assert.equal(audits[0].meta.timedOut, true, '审计须标记超时')
  assert.equal(audits[0].meta.escape, 'hmr-exit')
  assert.match(audits[0].error.message, /timed out after 30ms/)
  assert.equal(warnings.length, 1)
})
