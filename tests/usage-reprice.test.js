import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { exportUsageCsv, recordUsage, setPrice, usageSnapshot } from '../src/usage.js'

// 用量成本追认（DSHBOTS-115）：入库时没命中价目的历史明细，在价目配齐后按当前价目
// 回溯补算——聚合结果即全量，「成本为部分值」随之消失；已计价明细仍用入库算死的成本。

async function withStore(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reprice-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  try {
    await fn(store)
  } finally {
    try {
      store.close()
    } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

function seedBot(store, id, name) {
  const now = new Date().toISOString()
  store.run(
    `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, created_at, updated_at)
     VALUES (?, ?, 'dev', '', 'blue', 'active', 0, ?, ?)`,
    id, name, now, now,
  )
}

function seedProject(store, { id, key, name, slug }) {
  const now = new Date().toISOString()
  store.run(
    `INSERT INTO projects(id, key, name, slug, owner_bot_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'b1', 'active', ?, ?)`,
    id, key, name, slug, now, now,
  )
}

function seedRun(store, { id, projectId = null, botId }) {
  const now = new Date().toISOString()
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key,
        queued_at, started_at, ended_at)
     VALUES (?, ?, ?, 'task', 'write', 'manual', 'succeeded', 1, ?, ?, ?, ?)`,
    id, projectId, botId, `key-${id}`, now, now, now,
  )
}

function seedUsage(store, { sourceKey, run, provider, model, usage }) {
  return recordUsage(store, { sourceKey, run, provider, model, usage })
}

const MODEL_A = {
  provider: 'fake',
  model: 'model-a',
  inputPerMtok: 10,
  outputPerMtok: 20,
  effectiveAt: '2020-01-01T00:00:00.000Z',
}

test('未配价时成本为部分值：单独计数、costComplete=false、cost 为空', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    seedProject(store, { id: 'p1', key: 'P1', name: 'Alpha', slug: 'alpha' })
    seedRun(store, { id: 'r1', projectId: 'p1', botId: 'b1' })
    seedUsage(store, {
      sourceKey: 'u:r1',
      run: { id: 'r1', project_id: 'p1', bot_id: 'b1' },
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })

    const snapshot = usageSnapshot(store, null, 30)
    assert.equal(snapshot.global.calls, 1)
    assert.equal(snapshot.global.pricedCalls, 0)
    assert.equal(snapshot.global.unpricedCalls, 1)
    assert.equal(snapshot.global.costConfigured, false)
    assert.equal(snapshot.global.costComplete, false)
    assert.equal(snapshot.global.cost, null)
    assert.equal(snapshot.global.unpricedTokens, 2_000_000)
    assert.deepEqual(snapshot.global.costByCurrency, {})

    const model = snapshot.byModel.find(item => item.model === 'model-a')
    assert.equal(model.pricedCalls, 0)
    assert.equal(model.unpricedCalls, 1)
    assert.equal(model.costComplete, false)
  })
})

test('配价后追认：未计价明细按当前价目补算，成本变全量、提示消失', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    seedProject(store, { id: 'p1', key: 'P1', name: 'Alpha', slug: 'alpha' })
    seedRun(store, { id: 'r1', projectId: 'p1', botId: 'b1' })
    seedUsage(store, {
      sourceKey: 'u:r1',
      run: { id: 'r1', project_id: 'p1', bot_id: 'b1' },
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    // 入库时没有价目；之后全局配置补上价格。
    setPrice(store, MODEL_A)

    const snapshot = usageSnapshot(store, null, 30)
    assert.equal(snapshot.global.calls, 1)
    assert.equal(snapshot.global.pricedCalls, 1)
    assert.equal(snapshot.global.unpricedCalls, 0)
    assert.equal(snapshot.global.costConfigured, true)
    assert.equal(snapshot.global.costComplete, true)
    assert.equal(snapshot.global.cost, 30)
    assert.equal(snapshot.global.unpricedTokens, 0)
    assert.deepEqual(snapshot.global.costByCurrency, { CNY: 30 })

    // 各分档口径与全局一致，不残留「部分值」。
    const bot = snapshot.byBot.find(item => item.botId === 'b1')
    const project = snapshot.byProject.find(item => item.projectId === 'p1')
    const model = snapshot.byModel.find(item => item.model === 'model-a')
    const day = snapshot.byDay.find(item => item.calls === 1)
    for (const row of [bot, project, model, day]) {
      assert.equal(row.pricedCalls, 1, '分档 pricedCalls')
      assert.equal(row.unpricedCalls, 0, '分档 unpricedCalls')
      assert.equal(row.costComplete, true, '分档 costComplete')
      assert.equal(row.cost, 30, '分档 cost')
    }
  })
})

test('追认是纯查询：重复聚合结果一致、不写库、不累积', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    seedUsage(store, {
      sourceKey: 'u:r1',
      run: null,
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    setPrice(store, MODEL_A)

    const first = usageSnapshot(store, null, 30)
    const second = usageSnapshot(store, null, 30)
    assert.deepEqual(first.global, second.global)
    assert.deepEqual(first.byModel, second.byModel)
    assert.equal(usageSnapshot(store, null, 30).global.cost, 30, '多次聚合金额不翻倍')

    // 追认不落库：明细的 cost 列仍为 NULL，重跑不会把追认金额写进去。
    const row = store.get('SELECT * FROM usage_events WHERE source_key = ?', 'u:r1')
    assert.equal(row.total_cost, null)
    assert.equal(row.input_cost, null)
    assert.equal(row.output_cost, null)
  })
})

test('已计价历史不被后续改价改写，未计价明细按最新价追认', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    setPrice(store, MODEL_A)
    seedUsage(store, {
      sourceKey: 'u:r1',
      run: null,
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    // 改价（新 effective_at = 新版本）：入库时已算死的 30 不变。
    setPrice(store, {
      ...MODEL_A,
      inputPerMtok: 100,
      outputPerMtok: 200,
      effectiveAt: '2021-01-01T00:00:00.000Z',
    })
    let snapshot = usageSnapshot(store, null, 30)
    assert.equal(snapshot.global.cost, 30, '已计价明细保留入库时算死的成本')

    // 另一条入库时没价的明细，按最新价目追认成 300。
    seedUsage(store, {
      sourceKey: 'u:r2',
      run: null,
      provider: 'fake',
      model: 'model-b',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    // model-b 先不配价，确认它仍是部分值。
    snapshot = usageSnapshot(store, null, 30)
    assert.equal(snapshot.global.pricedCalls, 1)
    assert.equal(snapshot.global.unpricedCalls, 1)
    assert.equal(snapshot.global.cost, 30)
    assert.equal(snapshot.global.costComplete, false)

    setPrice(store, { ...MODEL_A, model: 'model-b', inputPerMtok: 100, outputPerMtok: 200 })
    snapshot = usageSnapshot(store, null, 30)
    assert.equal(snapshot.global.pricedCalls, 2)
    assert.equal(snapshot.global.unpricedCalls, 0)
    assert.equal(snapshot.global.cost, 330, '30（入库算死）+ 300（按最新价追认）')
    assert.equal(snapshot.global.costComplete, true)
  })
})

test('只有部分模型配价时，未配价的调用仍是部分值', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    seedUsage(store, {
      sourceKey: 'u:r1',
      run: null,
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    seedUsage(store, {
      sourceKey: 'u:r2',
      run: null,
      provider: 'fake',
      model: 'model-b',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    setPrice(store, MODEL_A)

    const snapshot = usageSnapshot(store, null, 30)
    assert.equal(snapshot.global.calls, 2)
    assert.equal(snapshot.global.pricedCalls, 1)
    assert.equal(snapshot.global.unpricedCalls, 1)
    assert.equal(snapshot.global.cost, 30)
    assert.equal(snapshot.global.costComplete, false)

    const modelA = snapshot.byModel.find(item => item.model === 'model-a')
    const modelB = snapshot.byModel.find(item => item.model === 'model-b')
    assert.equal(modelA.costComplete, true)
    assert.equal(modelB.costComplete, false)
    assert.equal(modelB.cost, null)
  })
})

test('未来生效的价目不参与追认', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    seedUsage(store, {
      sourceKey: 'u:r1',
      run: null,
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    setPrice(store, { ...MODEL_A, effectiveAt: new Date(Date.now() + 86_400_000).toISOString() })

    const snapshot = usageSnapshot(store, null, 30)
    assert.equal(snapshot.global.unpricedCalls, 1)
    assert.equal(snapshot.global.cost, null)
    assert.equal(snapshot.global.costComplete, false)
  })
})

test('CSV 导出与用量页同口径：追认后成本列有值、币种随价目', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    seedProject(store, { id: 'p1', key: 'P1', name: 'Alpha', slug: 'alpha' })
    seedRun(store, { id: 'r1', projectId: 'p1', botId: 'b1' })
    seedUsage(store, {
      sourceKey: 'u:r1',
      run: { id: 'r1', project_id: 'p1', bot_id: 'b1' },
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })

    const columns = exportUsageCsv(store, { days: 30 }).trim().split('\n')
    const header = columns[0].split(',')
    const before = columns[1].split(',')
    assert.equal(before[header.indexOf('total_cost')], '', '未配价时成本列为空')
    assert.equal(before[header.indexOf('currency')], 'CNY', '未配价时币种是占位币种')

    setPrice(store, MODEL_A)
    const after = exportUsageCsv(store, { days: 30 }).trim().split('\n')[1].split(',')
    assert.equal(after[header.indexOf('total_cost')], '30')
    assert.equal(after[header.indexOf('input_cost')], '10')
    assert.equal(after[header.indexOf('output_cost')], '20')
    assert.equal(after[header.indexOf('currency')], 'CNY')
  })
})

// 端到端：用量页读的就是 service.state() 的 usage，这里按用户实际操作
// （先有历史未计价调用，再在配置里补价格）验证提示消失、成本变全量。
test('端到端：配置价格后用量页提示消失、成本变全量', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reprice-e2e-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(
    join(workspace, '.agents', 'skills', 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n',
  )
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20,
  })
  const store = openDatabase(config.dbPath)
  try {
    const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
    service.attachRuntime({
      setCompletionHandler() {},
      catalog: async () => [],
      validateBotConfig: async () => {},
      startRun: async () => 'session',
      cancelRun: async () => true,
    })
    await service.initialize()
    service.started = true
    const actor = { type: 'user', id: service.localUserId }
    const dev = await service.createBot({
      name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a', effort: 'high',
    })
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({
      name: 'Reprice', key: 'REP', ownerBotId: director.id, memberIds: [dev.id],
    })
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key,
          queued_at, started_at, ended_at)
       VALUES ('r1', ?, ?, 'task', 'write', 'manual', 'succeeded', 1, 'k1', ?, ?, ?)`,
      project.id, dev.id, now, now, now,
    )
    seedUsage(store, {
      sourceKey: 'u:r1',
      run: { id: 'r1', project_id: project.id, bot_id: dev.id },
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })

    const before = (await service.state(project.id)).usage
    assert.equal(before.global.unpricedCalls, 1)
    assert.equal(before.global.cost, null)
    assert.equal(before.global.costComplete, false)

    await service.savePrice({ ...MODEL_A }, actor)

    const after = (await service.state(project.id)).usage
    assert.equal(after.global.unpricedCalls, 0, '提示驱动字段归零')
    assert.equal(after.global.pricedCalls, 1)
    assert.equal(after.global.cost, 30)
    assert.equal(after.global.costComplete, true)
    assert.equal(after.project.unpricedCalls, 0)
    assert.equal(after.project.cost, 30)
    assert.equal(after.byModel.find(item => item.model === 'model-a').costComplete, true)
  } finally {
    try {
      store.close()
    } catch {}
    await rm(root, { recursive: true, force: true })
  }
})
