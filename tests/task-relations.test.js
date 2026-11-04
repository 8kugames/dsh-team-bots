// DSHBOTS-59：任务父子关系与依赖阻塞。
// 纯函数（normalize/parse/环检测）、迁移幂等、createTask/assignFromBot 校验、
// 调度闸门（依赖未 done/canceled 不领取 + task_blocked_dep 事件去重）、父子不级联。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import {
  DEP_SATISFIED_STATUSES, MAX_BLOCKED_BY, TASK_RELATIONS_MIGRATION,
  detectRelationCycle, ensureTaskRelationsSchema, normalizeBlockedByInput,
  parseStoredBlockedBy, validateTaskRelations,
} from '../src/services/task-relations.js'

// startRun 只记账不回调完成：任务 run 停在 running，领取断言的终态稳定（board-drag 同款）。
class HoldingRuntime {
  constructor() {
    this.started = []
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) {
    this.started.push({ id: run.id, kind: run.kind, taskId: run.task_id ?? null })
    return `session-${run.id}`
  }
  async cancelRun() { return true }
}

// schedulerIntervalMs 拉满 30s（resolveConfig 上限）：定时 tick 不掺和，时序只由显式 await service.tick() 驱动。
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-relations-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new HoldingRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  return { root, store, service, runtime }
}

async function seedProjects(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const gate = await service.createProject({ name: 'Gate', key: 'GATE', ownerBotId: director.id, memberIds: [dev.id] })
  const other = await service.createProject({ name: 'Other', key: 'OTHER', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, gate, other }
}

function ownerSession(store, director, project) {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    'sess-owner', director.id, project.id, 'project', new Date().toISOString(),
  )
  return 'sess-owner'
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timeout waiting for condition')
}

async function closeQuietly(store, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch {
      break
    }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    store.close()
  } catch {}
}

const blockedEvents = (store, runId) =>
  store.all("SELECT * FROM run_events WHERE run_id = ? AND type = 'task_blocked_dep'", runId)

const taskRun = (store, taskId) =>
  store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task' ORDER BY queued_at DESC LIMIT 1", taskId)

// 状态推进走合法 TRANSITIONS 链（backlog → todo → in_progress → in_review → done）。
// 无 assignee 的任务初始是 backlog，链条从 todo 起步即可覆盖两种起点。
async function driveTo(service, taskId, status) {
  const chain = ['todo', 'in_progress', 'in_review', 'done']
  for (const next of chain.slice(0, chain.indexOf(status) + 1)) {
    await service.updateTask(taskId, { status: next })
  }
}

test('normalizeBlockedByInput：null/undefined/空数组归 []，trim 去重截断，类型错误显式拒绝', () => {
  assert.deepEqual(normalizeBlockedByInput(undefined), [])
  assert.deepEqual(normalizeBlockedByInput(null), [])
  assert.deepEqual(normalizeBlockedByInput([]), [])
  assert.deepEqual(normalizeBlockedByInput([' a ', 'a', '', 'b ']), ['a', 'b'])
  const many = normalizeBlockedByInput(Array.from({ length: MAX_BLOCKED_BY + 5 }, (_, index) => `task_${index}`))
  assert.equal(many.length, MAX_BLOCKED_BY)
  assert.throws(() => normalizeBlockedByInput('task_1'), /应为任务 id 字符串数组/)
  assert.throws(() => normalizeBlockedByInput([42]), /每一项应为任务 id 字符串/)
})

test('parseStoredBlockedBy：坏数据降级为 []，不抛错', () => {
  assert.deepEqual(parseStoredBlockedBy(null), [])
  assert.deepEqual(parseStoredBlockedBy('[]'), [])
  assert.deepEqual(parseStoredBlockedBy('["task_1"," task_2 ",null,3]'), ['task_1', 'task_2'])
  assert.deepEqual(parseStoredBlockedBy('not json'), [])
  assert.deepEqual(parseStoredBlockedBy('{"a":1}'), [])
})

test('detectRelationCycle：干净链/菱形 DAG 不误报，自引用与脏环拒绝', () => {
  const lookup = (graph) => (id) => graph[id] ?? null
  // 干净链：T → A → B，无环。
  const clean = lookup({
    task_a: { parentTaskId: 'task_b', blockedBy: [] },
    task_b: { parentTaskId: null, blockedBy: [] },
  })
  assert.equal(detectRelationCycle({ taskId: 'task_t', parentTaskId: 'task_a', blockedBy: [], lookup: clean }), null)
  // 菱形 DAG：T 依赖 A、B，两者都依赖 C，无环。
  const diamond = lookup({
    task_a: { parentTaskId: null, blockedBy: ['task_c'] },
    task_b: { parentTaskId: null, blockedBy: ['task_c'] },
    task_c: { parentTaskId: null, blockedBy: [] },
  })
  assert.equal(detectRelationCycle({ taskId: 'task_t', parentTaskId: null, blockedBy: ['task_a', 'task_b'], lookup: diamond }), null)
  // 直接自引用。
  assert.equal(detectRelationCycle({ taskId: 'task_t', parentTaskId: 'task_t', blockedBy: [], lookup: clean }), 'self')
  assert.equal(detectRelationCycle({ taskId: 'task_t', parentTaskId: null, blockedBy: ['task_t'], lookup: clean }), 'self')
  // 路径回到自身：A 依赖 T，T 依赖 A。
  const back = lookup({ task_a: { parentTaskId: null, blockedBy: ['task_t'] } })
  assert.equal(detectRelationCycle({ taskId: 'task_t', parentTaskId: null, blockedBy: ['task_a'], lookup: back }), 'self')
  // 库内脏环（与 T 无关的互阻）：拒绝挂接。
  const dirty = lookup({
    task_x: { parentTaskId: null, blockedBy: ['task_y'] },
    task_y: { parentTaskId: null, blockedBy: ['task_x'] },
  })
  assert.equal(detectRelationCycle({ taskId: 'task_t', parentTaskId: 'task_x', blockedBy: [], lookup: dirty }), 'cycle')
  // 父链脏环同理。
  const parentCycle = lookup({
    task_p1: { parentTaskId: 'task_p2', blockedBy: [] },
    task_p2: { parentTaskId: 'task_p1', blockedBy: [] },
  })
  assert.equal(detectRelationCycle({ taskId: 'task_t', parentTaskId: 'task_p1', blockedBy: [], lookup: parentCycle }), 'cycle')
  // 悬空引用（lookup 找不到）：死路，不算环。
  assert.equal(detectRelationCycle({ taskId: 'task_t', parentTaskId: null, blockedBy: ['task_ghost'], lookup: clean }), null)
})

test('DEP_SATISFIED_STATUSES：done 与 canceled 视为依赖已满足', () => {
  assert.equal(DEP_SATISFIED_STATUSES.size, 2)
  assert.ok(DEP_SATISFIED_STATUSES.has('done'))
  assert.ok(DEP_SATISFIED_STATUSES.has('canceled'))
})

test('迁移：tasks 加 parent_task_id/blocked_by 两列，登记 schema_migrations，幂等可重入', async () => {
  const { root, store } = await setup()
  try {
    const columnsBefore = store.all('PRAGMA table_info(tasks)').map(row => row.name)
    assert.ok(!columnsBefore.includes('parent_task_id'))
    assert.ok(!columnsBefore.includes('blocked_by'))
    ensureTaskRelationsSchema(store)
    const columnsAfter = store.all('PRAGMA table_info(tasks)').map(row => row.name)
    assert.ok(columnsAfter.includes('parent_task_id'))
    assert.ok(columnsAfter.includes('blocked_by'))
    assert.ok(store.get('SELECT 1 AS ok FROM schema_migrations WHERE name = ?', TASK_RELATIONS_MIGRATION))
    ensureTaskRelationsSchema(store)
    ensureTaskRelationsSchema(store)
    assert.equal(store.all('PRAGMA table_info(tasks)').length, columnsAfter.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createTask 校验：跨项目父/依赖拒、不存在拒、非法 blocked_by 拒', async () => {
  const { root, store, service } = await setup()
  try {
    const { dev, gate, other } = await seedProjects(service, store)
    const gateTask = await service.createTask({ projectId: gate.id, title: '闸内任务' })
    const otherTask = await service.createTask({ projectId: other.id, title: '别的项目任务' })
    const input = (patch) => ({ projectId: gate.id, title: 'B', assigneeBotId: dev.id, ...patch })
    await assert.rejects(() => service.createTask(input({ parentTaskId: otherTask.id })), /不在当前项目内/)
    await assert.rejects(() => service.createTask(input({ blockedBy: [otherTask.id] })), /不在当前项目内/)
    await assert.rejects(() => service.createTask(input({ parentTaskId: 'task_ghost' })), /父任务 task_ghost 不存在/)
    await assert.rejects(() => service.createTask(input({ blockedBy: ['task_ghost'] })), /依赖任务 task_ghost 不存在/)
    await assert.rejects(() => service.createTask(input({ blockedBy: 'task_not_array' })), /应为任务 id 字符串数组/)
    await assert.rejects(() => service.createTask(input({ blockedBy: [gateTask.id, 7] })), /每一项应为任务 id 字符串/)
    // snake_case 入参同口径。
    await assert.rejects(() => service.createTask(input({ parent_task_id: otherTask.id })), /不在当前项目内/)
    await assert.rejects(() => service.createTask(input({ blocked_by: ['task_ghost'] })), /不存在/)
    assert.ok(store.get('SELECT 1 AS ok FROM tasks WHERE project_id = ? AND title = ?', gate.id, 'B') == null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validateTaskRelations：自引用直接拒（taskId 由调用方给定，覆盖直插库/未来 update 路径）', async () => {
  const { root, store, service } = await setup()
  try {
    const { gate } = await seedProjects(service, store)
    await service.createTask({ projectId: gate.id, title: '锚点' })
    assert.throws(() => validateTaskRelations({ store, projectId: gate.id, taskId: 'task_self', parentTaskId: 'task_self', blockedBy: [] }), /不能以自身为父任务/)
    assert.throws(() => validateTaskRelations({ store, projectId: gate.id, taskId: 'task_self', parentTaskId: null, blockedBy: ['task_self'] }), /不能依赖自身/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createTask 合法关系落库：taskView 透出 parent_task_id/blocked_by/blockedBy/depsSatisfied/blockedByNames，去重入参收敛', async () => {
  const { root, store, service } = await setup()
  try {
    const { gate } = await seedProjects(service, store)
    const parent = await service.createTask({ projectId: gate.id, title: '父任务' })
    const dep = await service.createTask({ projectId: gate.id, title: '依赖任务' })
    const child = await service.createTask({
      projectId: gate.id, title: '子任务',
      parentTaskId: parent.id, blockedBy: [dep.id, dep.id, '  '],
    })
    const row = store.get('SELECT * FROM tasks WHERE id = ?', child.id)
    assert.equal(row.parent_task_id, parent.id)
    assert.deepEqual(JSON.parse(row.blocked_by), [dep.id])
    assert.equal(child.parent_task_id, parent.id)
    assert.deepEqual(child.blockedBy, [dep.id])
    assert.equal(child.depsSatisfied, false)
    assert.deepEqual(child.blockedByNames, ['GATE-2'])
    // 无依赖的老任务视图：空数组 + satisfied。
    assert.deepEqual(parent.blockedBy, [])
    assert.equal(parent.depsSatisfied, true)
    assert.deepEqual(parent.blockedByNames, [])
    // 依赖 done 后翻转；canceled 同样视为满足。
    await driveTo(service, dep.id, 'done')
    const after = service.taskView(service.taskRow(child.id))
    assert.equal(after.depsSatisfied, true)
    assert.deepEqual(after.blockedByNames, [])
    const dep2 = await service.createTask({ projectId: gate.id, title: '依赖2' })
    const child2 = await service.createTask({ projectId: gate.id, title: '子2', blockedBy: [dep2.id] })
    assert.equal(child2.depsSatisfied, false)
    await service.updateTask(dep2.id, { status: 'canceled' })
    assert.equal(service.taskView(service.taskRow(child2.id)).depsSatisfied, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('调度闸门：依赖未完结 run 留 queued，task_blocked_dep 恰记一次不刷屏；依赖 done 后下一拍领取', async () => {
  const { root, store, service, runtime } = await setup()
  try {
    const { dev, gate } = await seedProjects(service, store)
    const dep = await service.createTask({ projectId: gate.id, title: '依赖任务' })
    const blocked = await service.createTask({
      projectId: gate.id, title: '被阻塞任务', assigneeBotId: dev.id, blockedBy: [dep.id], autoStart: true,
    })
    const run = taskRun(store, blocked.id)
    assert.ok(run, 'autoStart 应同步建 queued run')
    assert.equal(run.status, 'queued')
    await service.tick()
    await service.tick()
    await service.tick()
    assert.equal(taskRun(store, blocked.id).status, 'queued', '依赖未完结：run 不得领取')
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', blocked.id).status, 'todo', '任务不得被置 in_progress')
    const events = blockedEvents(store, run.id)
    assert.equal(events.length, 1, 'task_blocked_dep 事件只记一次')
    assert.match(events[0].message, /GATE-1/)
    assert.ok(runtime.started.every(started => started.taskId !== blocked.id), '运行时从未领到被阻塞任务')
    // 依赖 done → 下一拍放行。
    await driveTo(service, dep.id, 'done')
    await service.tick()
    await waitFor(() => taskRun(store, blocked.id).status === 'running')
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', blocked.id).status, 'in_progress')
    assert.equal(blockedEvents(store, run.id).length, 1, '放行后不追加阻塞事件')
    assert.ok(runtime.started.some(started => started.taskId === blocked.id))
  } finally {
    closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('调度闸门不拦无依赖任务：正常领取，不产生阻塞事件', async () => {
  const { root, store, service, runtime } = await setup()
  try {
    const { dev, gate } = await seedProjects(service, store)
    const plain = await service.createTask({ projectId: gate.id, title: '普通任务', assigneeBotId: dev.id, autoStart: true })
    await service.tick()
    await waitFor(() => taskRun(store, plain.id)?.status === 'running')
    assert.equal(blockedEvents(store, taskRun(store, plain.id).id).length, 0)
    assert.ok(runtime.started.some(started => started.taskId === plain.id))
  } finally {
    closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('调度闸门不拦依赖已满足的任务：dep 已 done 的 blocked_by 直接放行', async () => {
  const { root, store, service, runtime } = await setup()
  try {
    const { dev, gate } = await seedProjects(service, store)
    const dep = await service.createTask({ projectId: gate.id, title: '已完结依赖' })
    await driveTo(service, dep.id, 'done')
    const ready = await service.createTask({ projectId: gate.id, title: '就绪任务', assigneeBotId: dev.id, blockedBy: [dep.id], autoStart: true })
    await service.tick()
    await waitFor(() => taskRun(store, ready.id)?.status === 'running')
    assert.equal(blockedEvents(store, taskRun(store, ready.id).id).length, 0)
    assert.ok(runtime.started.some(started => started.taskId === ready.id))
  } finally {
    closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('父子不级联：父 todo 不挡子运行，父 done 不自动关子（v1 明确不做）', async () => {
  const { root, store, service } = await setup()
  try {
    const { dev, gate } = await seedProjects(service, store)
    const parent = await service.createTask({ projectId: gate.id, title: '父任务' })
    const child = await service.createTask({
      projectId: gate.id, title: '子任务', assigneeBotId: dev.id, parentTaskId: parent.id, autoStart: true,
    })
    await service.tick()
    await waitFor(() => taskRun(store, child.id)?.status === 'running')
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', child.id).status, 'in_progress')
    await driveTo(service, parent.id, 'done')
    const childStatus = store.get('SELECT status FROM tasks WHERE id = ?', child.id).status
    assert.ok(!['done', 'canceled'].includes(childStatus), '父完成不得自动级联关子')
    assert.equal(service.taskView(service.taskRow(child.id)).parent_task_id, parent.id)
  } finally {
    closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('assignFromBot 透传 parent_task_id/blocked_by 并同口径校验', async () => {
  const { root, store, service } = await setup()
  try {
    const { director, gate, other } = await seedProjects(service, store)
    const sessionId = ownerSession(store, director, gate)
    const anchor = await service.createTask({ projectId: gate.id, title: '锚点' })
    const otherTask = await service.createTask({ projectId: other.id, title: '外部任务' })
    const assigned = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '总监派单',
      parent_task_id: anchor.id, blocked_by: [anchor.id],
      write_scopes: ['src/anchor.js'],
    })
    assert.equal(assigned.parent_task_id, anchor.id)
    assert.deepEqual(assigned.blockedBy, [anchor.id])
    assert.equal(assigned.depsSatisfied, false)
    await assert.rejects(() => service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '跨项目', blocked_by: [otherTask.id],
      write_scopes: ['src/cross.js'],
    }), /不在当前项目内/)
  } finally {
    closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('脏数据环：直插库造互阻环后，createTask 挂上去要拒', async () => {
  const { root, store, service } = await setup()
  try {
    const { gate } = await seedProjects(service, store)
    ensureTaskRelationsSchema(store)
    const now = new Date().toISOString()
    const dirtyInsert = (id, number, blockedBy, parentTaskId = null) => store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id,
         parent_task_id, blocked_by, created_at, updated_at)
       VALUES (?, ?, ?, '脏数据', 'todo', 'medium', 'user', 'test', ?, ?, ?, ?)`,
      id, gate.id, number, parentTaskId, JSON.stringify(blockedBy), now, now,
    )
    dirtyInsert('task_dirty_x', 90, ['task_dirty_y'])
    dirtyInsert('task_dirty_y', 91, ['task_dirty_x'])
    await assert.rejects(
      () => service.createTask({ projectId: gate.id, title: '挂脏环', parentTaskId: 'task_dirty_x' }),
      /成环/,
    )
    await assert.rejects(
      () => service.createTask({ projectId: gate.id, title: '挂脏环', blockedBy: ['task_dirty_x'] }),
      /成环/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
