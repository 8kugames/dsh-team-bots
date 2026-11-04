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
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { restoreDefaultModel, RESTORE_MAX_ATTEMPTS, RESTORE_TIMEOUT_MS, resolveRestoreBudget } from '../src/services/runtime/model-restore.js'

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

// 给挂死型回归兜一道测试内 watchdog：护栏一旦回退，3s 内红，而不是让整份
// 测试文件挂到超时（挂死只表现为 cancelled，定位成本更高）。
async function withWatchdog(promise, ms, label) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`watchdog: ${label} 未在 ${ms}ms 内收口`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
        await hmr.runExclusive(async () => { throw new Error('boom') })
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
      error: 'boom',
      escape: 'scope',
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
  // 测试内 watchdog：护栏一旦被回退，这里要 3s 内红，而不是让整份测试挂死
  // （挂死只会表现为 cancelled，定位成本更高）。
  const ok = await withWatchdog(
    hmr.executing.run(true, () => restoreDefaultModel(defaults, BEFORE, {
      hmr,
      logger: { warn: (message) => warnings.push(message) },
      audit: (error, meta = {}) => audits.push({ error, meta }),
      retryBaseMs: 1,
      timeoutMs: 30,
    })),
    3000,
    '超时收口',
  )
  assert.equal(ok, false, '超时必须收口返回 false，不能挂住 selectModel 串行链')
  assert.equal(audits.length, 1, '超时也要落一条审计')
  assert.equal(audits[0].meta.timedOut, true, '审计须标记超时')
  assert.equal(audits[0].meta.escape, 'hmr-exit')
  assert.match(audits[0].error.message, /timed out after 30ms/)
  assert.equal(warnings.length, 1)
})

test('超时护栏：进程只剩这一次待办时护栏仍触发（定时器不 unref）', async () => {
  // 护栏定时器若被 unref，「恢复是进程唯一待办」时它不会触发：进程带着
  // unsettled top-level await 直接退出（code 13），失败重新变成静默。
  const moduleUrl = new URL('../src/services/runtime/model-restore.js', import.meta.url).href
  const script = `
import { restoreDefaultModel } from ${JSON.stringify(moduleUrl)}
const audits = []
const ok = await restoreDefaultModel(
  { saveSelection: () => new Promise(() => {}) },
  { provider: 'anthropic', model: 'claude-opus' },
  { logger: { warn() {}, debug() {} }, audit: (error, meta) => audits.push(meta), timeoutMs: 50 },
)
console.log('RESULT ' + JSON.stringify({ ok, meta: audits[0] ?? null }))
`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20000,
  })
  assert.notEqual(result.status, 13, `子进程不应带 unsettled top-level await 退出：${result.stderr}`)
  assert.match(result.stdout, /"ok":false/, '护栏须在进程唯一待办时照常触发并收口')
  assert.match(result.stdout, /"timedOut":true/)
})

test('兜底 scope 污染判定：结构化判定优先，文案一致也不误判', async () => {
  const hmr = createHmrStub()
  const audits = []
  // 有 executing 参照但没有 exit → 走兜底 scope 路径；模块级 scope 干净，
  // 错误文案又恰好与宿主嵌套拒绝一致，也不能误记成 scope-polluted。
  const failed = await restoreDefaultModel(
    { saveSelection: async () => { throw new Error('HMR transactions cannot be nested') } },
    BEFORE,
    {
      // executing 只有 getStore（没有 exit）→ 走兜底 scope 路径，但结构化判定可用。
      hmr: { executing: { getStore: () => hmr.executing.getStore() } },
      logger: { warn() {} },
      audit: (error, meta = {}) => audits.push({ error, meta }),
      retryBaseMs: 1,
    },
  )
  assert.equal(failed, false)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].meta.escape, 'scope', 'scope 干净时即便文案一致也不记污染')
})

test('兜底 scope 污染判定：模块出生在事务里时按结构化判定记 scope-polluted', async () => {
  const hmr = createHmrStub()
  // 模块实例出生在事务里 → 其模块级 scope 已被污染；即便错误只是 boom，
  // 结构化判定（scope 内事务标记为真）也能确认污染。
  const instance = await hmr.executing.run(true, async () => await import('../src/services/runtime/model-restore.js?born-in-hmr-tx-structured'))
  const audits = []
  const failed = await instance.restoreDefaultModel(
    { saveSelection: async () => { throw new Error('boom') } },
    BEFORE,
    {
      // executing 只有 getStore（没有 exit）→ 走兜底 scope 路径，但结构化判定可用。
      hmr: { executing: { getStore: () => hmr.executing.getStore() } },
      logger: { warn() {} },
      audit: (error, meta = {}) => audits.push({ error, meta }),
      retryBaseMs: 1,
    },
  )
  assert.equal(failed, false)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].meta.escape, 'scope-polluted', '结构化判定应识别出 scope 被污染')
  assert.match(audits[0].error.message, /boom/)
})

test('整体预算：退避被截断到剩余预算内，预算耗尽也不丢真实失败原因', async () => {
  const audits = []
  const started = Date.now()
  const ok = await restoreDefaultModel(
    { saveSelection: async () => { throw new Error('boom') } },
    BEFORE,
    {
      logger: { warn() {} },
      audit: (error, meta = {}) => audits.push({ error, meta }),
      retryBaseMs: 1000, // 退避远大于预算：必须被截断，不得整体阻塞越过预算
      timeoutMs: 200,
    },
  )
  const elapsed = Date.now() - started
  assert.equal(ok, false)
  assert.ok(elapsed < 1000, `退避不得越过整体预算，实际阻塞 ${elapsed}ms`)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].meta.timedOut, true)
  assert.equal(audits[0].meta.budgetExhausted, true, '预算耗尽要单独标记')
  assert.equal(audits[0].meta.cause, 'boom', '审计须保留真实失败原因')
  assert.match(audits[0].error.message, /timed out after 200ms/, '超时消息用配置的预算值，不用剩余时间')
  assert.match(audits[0].error.message, /boom/, '错误消息里要带真实失败原因')
})

test('超时收口：排队不落地时也保留上一次的真实失败原因', async () => {
  const audits = []
  let calls = 0
  const defaults = {
    saveSelection: async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return new Promise(() => {}) // 排在宿主事务队列尾，迟迟不落地
    },
  }
  const ok = await withWatchdog(
    restoreDefaultModel(defaults, BEFORE, {
      logger: { warn() {} },
      audit: (error, meta = {}) => audits.push({ error, meta }),
      retryBaseMs: 1,
      timeoutMs: 150,
    }),
    3000,
    '超时收口（保留真实原因）',
  )
  assert.equal(ok, false)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].meta.timedOut, true)
  assert.equal(audits[0].meta.cause, 'boom', '超时不得掩盖真实失败原因')
  assert.match(audits[0].error.message, /timed out after 150ms/)
  assert.match(audits[0].error.message, /boom/)
})

test('有效预算：timeoutMs 非法时退回默认上限，不给「完全无保护」留口子', () => {
  assert.equal(resolveRestoreBudget(0), RESTORE_TIMEOUT_MS)
  assert.equal(resolveRestoreBudget(-1), RESTORE_TIMEOUT_MS)
  assert.equal(resolveRestoreBudget(Number.NaN), RESTORE_TIMEOUT_MS)
  assert.equal(resolveRestoreBudget(undefined), RESTORE_TIMEOUT_MS)
  assert.equal(resolveRestoreBudget(250), 250)
})

test('失败原因：非 Error 的抛出值也保留真实原因', async () => {
  const audits = []
  const ok = await restoreDefaultModel(
    // 宿主/插件侧的抛出值不一定是 Error（字符串等），真实原因不能丢。
    { saveSelection: async () => { throw 'boom-string' } },
    BEFORE,
    {
      logger: { warn() {} },
      audit: (error, meta = {}) => audits.push({ error, meta }),
      retryBaseMs: 1000, // 退避远大于预算：第二次尝试前预算即耗尽 → 走预算耗尽收口
      timeoutMs: 200,
    },
  )
  assert.equal(ok, false)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].meta.timedOut, true)
  assert.equal(audits[0].meta.cause, 'boom-string', '非 Error 抛出值也要带进审计')
  assert.match(audits[0].error.message, /boom-string/, '错误消息里要带真实失败原因')
})

test('失败原因：业务错误带 timedOut 字段不被误判成护栏超时', async () => {
  const audits = []
  let attempts = 0
  const ok = await restoreDefaultModel(
    {
      saveSelection: async () => {
        attempts += 1
        throw Object.assign(new Error('business boom'), { timedOut: true })
      },
    },
    BEFORE,
    {
      logger: { warn() {} },
      audit: (error, meta = {}) => audits.push({ error, meta }),
      retryBaseMs: 1,
    },
  )
  assert.equal(ok, false)
  assert.equal(attempts, RESTORE_MAX_ATTEMPTS, '业务错误要走完重试，不被当成超时直接收口')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].meta.timedOut, undefined, '业务错误不得记成超时')
  assert.equal(audits[0].meta.cause, undefined, '非超时不带 cause')
  assert.match(audits[0].error.message, /business boom/)
})

test('兜底路径：失败时 debug 日志说明判定来源（结构化 / 未知）', async () => {
  const collect = () => {
    const lines = []
    return { lines, logger: { warn() {}, debug: (message, ...rest) => lines.push(`${message} ${rest.join(' ')}`.trim()) } }
  }

  // 有 executing 参照（只有 getStore，没有 exit）→ 结构化判定可用且 scope 干净。
  const structured = collect()
  await restoreDefaultModel(
    { saveSelection: async () => { throw new Error('boom') } },
    BEFORE,
    { hmr: { executing: { getStore: () => undefined } }, logger: structured.logger, audit: () => {}, retryBaseMs: 1 },
  )
  assert.ok(
    structured.lines.some((line) => /判定来源/.test(line) && line.includes('structured-clean')),
    `结构化判定来源要进日志，实际：${JSON.stringify(structured.lines)}`,
  )

  // 完全没有 hmr 参照 → 判定来源只能是未知。
  const unknown = collect()
  await restoreDefaultModel(
    { saveSelection: async () => { throw new Error('boom') } },
    BEFORE,
    { logger: unknown.logger, audit: () => {}, retryBaseMs: 1 },
  )
  assert.ok(
    unknown.lines.some((line) => /判定来源/.test(line) && line.includes('unknown-no-hmr')),
    `未知判定来源要进日志，实际：${JSON.stringify(unknown.lines)}`,
  )
})
