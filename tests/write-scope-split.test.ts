// 大卡拆分闸（2026-11-13 产品化派单纪律）：派单建卡路径写范围条目超过
// maxWriteScopesPerTask（默认 8）时拒绝，要求拆成 parent_task_id 子卡并行施工。
// 守门三向：a) 超限拒绝且不落卡不建运行；b) 恰好等于上限放行；c) 重派既有大卡
// 不受此闸（闸只拦新建，存量卡改卡/重派口径不变）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class HoldingRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-held' }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-scope-split-'))
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

async function seedProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({ name: 'Split', key: 'SPLT', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return { sessionId, project }
}

async function closeQuietly(service, store) {
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try {
      await service.cancelRunInternal(run.id, false)
    } catch {}
  }
  try {
    store.close()
  } catch {}
}

async function withSetup(fn) {
  const ctx = await setup()
  try {
    return await fn(ctx)
  } finally {
    await closeQuietly(ctx.service, ctx.store)
    await rm(ctx.root, { recursive: true, force: true })
  }
}

const dispatch = (ctx, sessionId, input) =>
  ctx.service.assignFromBot(sessionId, { assignee: 'Builder', title: '大卡', ...input })

const many = n => Array.from({ length: n }, (_, i) => `src/part-${i}.js`)

test('a) 写范围超过上限（9 > 8）拒绝派单，拒绝文案带拆分指引，不落卡不建运行', async () => {
  await withSetup(async ctx => {
    const { sessionId, project } = await seedProject(ctx.service, ctx.store)
    await assert.rejects(
      () => dispatch(ctx, sessionId, { description: '做点事。', write_scopes: many(9) }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /单卡上限 8/)
        assert.match(error.message, /parent_task_id/)
        return true
      },
    )
    assert.equal(ctx.store.get('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?', project.id)?.n, 0)
    assert.equal(ctx.store.get('SELECT COUNT(*) AS n FROM runs')?.n, 0)
  })
})

test('b) 恰好等于上限（8 条）放行建卡', async () => {
  await withSetup(async ctx => {
    const { sessionId } = await seedProject(ctx.service, ctx.store)
    const task = await dispatch(ctx, sessionId, { description: '做点事。', write_scopes: many(8) })
    assert.deepEqual(task.writeScopes, many(8))
  })
})

test('c) 重派既有大卡不受拆分闸拦截（闸只拦新建卡路径）', async () => {
  await withSetup(async ctx => {
    const { sessionId, project } = await seedProject(ctx.service, ctx.store)
    // 直建一张超限卡（直建不经派单闸），再经派单重派——应正常改派不被拒。
    const big = await ctx.service.createTask(
      { projectId: project.id, title: '存量大卡', writeScopes: many(12) },
      ctx.service.actor(),
    )
    const updated = await dispatch(ctx, sessionId, { task: 'SPLT-1', title: '改名重派' })
    assert.equal(updated.id, big.id)
    assert.equal(updated.title, '改名重派')
  })
})
