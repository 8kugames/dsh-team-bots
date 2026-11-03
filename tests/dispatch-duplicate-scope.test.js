// DSHBOTS-82：派单侧同写范围重复检测（合批程序化）。
// 同一文件上叠 N 张小卡时，各卡各立各排，后面的卡只能等前一张跑完，形成排队空转。
// 派单入口拦截「写范围完全一致」的同项目在办卡；相交但不同的放行；force_duplicate 是逃生口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { installTeamTools } from '../src/tools.js'

// startRun 只记账不回调完成：任务 run 停在 running，任务停在 in_progress（在办状态）。
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

// schedulerIntervalMs 拉满（resolveConfig 上限 30s）：定时 tick 不掺和，时序只由显式 tick 驱动。
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dispatch-dup-'))
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

// 两个项目（各带一个负责人 Bot），供「同项目 / 跨项目」两类判定对照。
async function seedProjects(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const gate = await service.createProject({ name: 'Gate', key: 'GATE', ownerBotId: director.id, memberIds: [dev.id] })
  const other = await service.createProject({ name: 'Other', key: 'OTHER', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, gate, other }
}

function ownerSession(store, director, project, sessionId) {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return sessionId
}

async function closeQuietly(service, store, timeout = 500) {
  // HoldingRuntime 的运行永不自然结束：先取消在跑/排队运行（不改任务状态），否则只能等超时。
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try {
      await service.cancelRunInternal(run.id, false)
    } catch {}
  }
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

const taskCount = (store, projectId) =>
  Number(store.get('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?', projectId)?.n ?? 0)

const auditRows = (store, action) =>
  store.all('SELECT * FROM audit_log WHERE action = ? ORDER BY created_at', action)

test('同项目同写范围重复派单：409 拒绝，消息含已有卡号与标题，且不落库不建卡', async () => {
  const { root, store, service } = await setup()
  try {
    const { director, gate } = await seedProjects(service, store)
    const sessionId = ownerSession(store, director, gate, 'sess-gate')
    const first = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '第一张小卡', description: '做点事。',
      write_scopes: ['src/a.js'],
    })
    assert.equal(first.identifier, 'GATE-1')

    await assert.rejects(
      () => service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '第二张小卡', description: '同样的活。',
        write_scopes: ['src/a.js'],
      }),
      (error) => {
        assert.equal(error.status, 409)
        assert.equal(error.code, 'CONFLICT')
        assert.match(error.message, /已存在同写范围任务/)
        assert.match(error.message, /GATE-1/)
        assert.match(error.message, /第一张小卡/)
        assert.match(error.message, /重派原任务/)
        return true
      },
    )
    // 拒绝时不产生第二张卡，也不产生新运行。
    assert.equal(taskCount(store, gate.id), 1)
    assert.equal(
      Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id <> ?", first.id)?.n ?? 0),
      0,
    )
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('写范围集合相等即视为重复（顺序无关），描述行解析出的写范围同样参与判定', async () => {
  const { root, store, service } = await setup()
  try {
    const { director, gate } = await seedProjects(service, store)
    const sessionId = ownerSession(store, director, gate, 'sess-gate')
    await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '两张文件', write_scopes: ['src/a.js', 'src/b.js'],
    })
    // 顺序不同但集合相同 → 重复
    await assert.rejects(
      () => service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '同样两张文件', write_scopes: ['src/b.js', 'src/a.js'],
      }),
      /已存在同写范围任务 GATE-1/,
    )
    // 描述里的「写范围：」行解析出的集合与显式入参同口径 → 也算重复
    await assert.rejects(
      () => service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '描述行派单', description: '干活。\n写范围：src/b.js, src/a.js',
      }),
      /已存在同写范围任务 GATE-1/,
    )
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('不同项目同写范围不拦：跨项目各自独立排队', async () => {
  const { root, store, service } = await setup()
  try {
    const { director, gate, other } = await seedProjects(service, store)
    const gateSession = ownerSession(store, director, gate, 'sess-gate')
    const otherSession = ownerSession(store, director, other, 'sess-other')
    await service.assignFromBot(gateSession, {
      assignee: 'Builder', title: 'A 项目的小卡', write_scopes: ['src/a.js'],
    })
    const crossed = await service.assignFromBot(otherSession, {
      assignee: 'Builder', title: 'B 项目的小卡', write_scopes: ['src/a.js'],
    })
    assert.equal(crossed.identifier, 'OTHER-1')
    assert.equal(taskCount(store, gate.id), 1)
    assert.equal(taskCount(store, other.id), 1)
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('写范围相交但不完全相同：放行（串行正确性交给调度器闸门）', async () => {
  const { root, store, service } = await setup()
  try {
    const { director, gate } = await seedProjects(service, store)
    const sessionId = ownerSession(store, director, gate, 'sess-gate')
    await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '单文件', write_scopes: ['src/a.js'],
    })
    // 多一条路径：集合不同 → 放行
    const wider = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '两个文件', write_scopes: ['src/a.js', 'src/b.js'],
    })
    assert.equal(wider.identifier, 'GATE-2')
    // 目录前缀与文件路径相交但集合不同 → 放行
    const prefixed = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '目录范围', write_scopes: ['src'],
    })
    assert.equal(prefixed.identifier, 'GATE-3')
    assert.equal(taskCount(store, gate.id), 3)
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('force_duplicate 逃生口：放行同写范围派单并留审计事件', async () => {
  const { root, store, service } = await setup()
  try {
    const { director, gate } = await seedProjects(service, store)
    const sessionId = ownerSession(store, director, gate, 'sess-gate')
    const first = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '第一张小卡', write_scopes: ['src/a.js'],
    })
    const forced = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '故意并行的小卡', write_scopes: ['src/a.js'],
      force_duplicate: true,
    })
    assert.equal(forced.identifier, 'GATE-2')
    assert.equal(taskCount(store, gate.id), 2)

    const rows = auditRows(store, 'dispatch_force_duplicate')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].target_type, 'task')
    assert.equal(rows[0].target_id, forced.id)
    const data = JSON.parse(rows[0].data_json)
    assert.deepEqual(data.writeScopes, ['src/a.js'])
    assert.equal(data.duplicateTaskId, first.id)
    assert.equal(data.duplicateIdentifier, 'GATE-1')
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('force_duplicate 未命中重复卡时也留审计（force 使用本身可追溯）', async () => {
  const { root, store, service } = await setup()
  try {
    const { director, gate } = await seedProjects(service, store)
    const sessionId = ownerSession(store, director, gate, 'sess-gate')
    await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '唯一的小卡', write_scopes: ['src/a.js'], force_duplicate: true,
    })
    const rows = auditRows(store, 'dispatch_force_duplicate')
    assert.equal(rows.length, 1)
    const data = JSON.parse(rows[0].data_json)
    assert.equal(data.duplicateTaskId, null)
    assert.equal(data.duplicateIdentifier, null)
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('已结束的同写范围旧卡不再拦截新派单', async () => {
  const { root, store, service } = await setup()
  try {
    const { director, dev, gate } = await seedProjects(service, store)
    const sessionId = ownerSession(store, director, gate, 'sess-gate')
    // 历史终态卡：done 与 in_review 都不再占「在办」名额。
    for (const status of ['done', 'in_review']) {
      await service.createTask({
        projectId: gate.id, title: `旧卡 ${status}`, assigneeBotId: dev.id,
        status, writeScopes: ['src/a.js'], autoStart: false,
      })
    }
    const fresh = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '新派单', write_scopes: ['src/a.js'],
    })
    assert.equal(fresh.identifier, 'GATE-3')
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('重派既有卡不受重复检测影响（同卡换人不是新卡）', async () => {
  const { root, store, service } = await setup()
  try {
    const { director, gate } = await seedProjects(service, store)
    const sessionId = ownerSession(store, director, gate, 'sess-gate')
    const first = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '第一张小卡', write_scopes: ['src/a.js'],
    })
    const redispatched = await service.assignFromBot(sessionId, {
      assignee: 'Builder', task: 'GATE-1',
    })
    assert.equal(redispatched.id, first.id)
    assert.equal(taskCount(store, gate.id), 1)
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('team_assign_task 工具 schema 暴露 force_duplicate 逃生口参数', () => {
  const tools = []
  installTeamTools({ tools: { register: (tool) => tools.push(tool) } }, {})
  const tool = tools.find(item => item.name === 'team_assign_task')
  assert.ok(tool, 'team_assign_task 未注册')
  assert.equal(tool.parameters.properties.force_duplicate.type, 'boolean')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.match(tool.description, /force_duplicate/)
})
