// DSHBOTS-168：派单入口写范围清洗（程序化约束，不靠提示词）。
// 三入口共用同一判定链：assignFromBot（闸门按清洗后清单预判 + createTask 权威清洗）、
// createTask（owner 派单路径，事务内权威清洗）、taskUpdateScopes（改卡入口）。口径：
// ① 命中项目 .gitignore 的条目机械移除，落审计 task.scopes_normalize（removed=[...]）；
// ② 清洗后清单为空 → assignFromBot / taskUpdateScopes 走各自既有「必须声明写范围」拒绝；
// ③ 一级目录（不含 /）驳回；package.json 由 parseWriteScopes 出口剥除（f4763a2），不进驳回；
// ④ 非 git 目录跳过清洗保守放行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// startRun 只记账不回调完成：任务 run 停在 running，任务停在 in_progress（在办状态）。
class HoldingRuntime { declare started: unknown[];
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-scope-norm-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  return { root, workspace, store, service }
}

async function seedProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({ name: 'Norm', key: 'NRM', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project }
}

function ownerSession(store, director, project, sessionId) {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return sessionId
}

// 造一个真 git 项目目录并写 .gitignore——check-ignore 按规则纯语义命中（--no-index）。
async function gitProject(dir, rules) {
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' })
  await writeFile(join(dir, '.gitignore'), `${rules.join('\n')}\n`, 'utf8')
}

const userActor = service => ({ type: 'user', id: service.localUserId })

async function closeQuietly(service, store, timeout = 500) {
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

const normalizeAudits = store =>
  store.all("SELECT * FROM audit_log WHERE action = 'task.scopes_normalize' ORDER BY created_at")

test('assignFromBot：ignored 二级目录条目机械移除，落库清单已清洗并留审计', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const { director, dev, project } = await seedProject(service, store)
    const dir = join(workspace, project.slug)
    await gitProject(dir, ['dist/'])
    const sessionId = ownerSession(store, director, project, 'sess-norm-1')

    const task = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '清洗', description: '做点事。',
      write_scopes: ['dist/build', 'src/a.js'],
    })

    assert.equal(task.identifier, 'NRM-1')
    assert.deepEqual(task.writeScopes, ['src/a.js'])
    const audits = normalizeAudits(store)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].target_id, task.id)
    assert.deepEqual(JSON.parse(audits[0].data_json), { removed: ['dist/build'] })
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('assignFromBot：ignored 子路径（文件规则）同样移除', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const { director, dev, project } = await seedProject(service, store)
    await gitProject(join(workspace, project.slug), ['*.log', 'secrets.env'])
    const sessionId = ownerSession(store, director, project, 'sess-norm-2')

    const task = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '文件规则', description: '做点事。',
      write_scopes: ['logs/app.log', 'src/b.js'],
    })

    assert.deepEqual(task.writeScopes, ['src/b.js'])
    assert.deepEqual(JSON.parse(normalizeAudits(store)[0].data_json), { removed: ['logs/app.log'] })
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('非 ignored 条目原样保留，且不产生清洗审计', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const { director, dev, project } = await seedProject(service, store)
    await gitProject(join(workspace, project.slug), ['dist/'])
    const sessionId = ownerSession(store, director, project, 'sess-norm-3')

    const task = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '全保留', description: '做点事。',
      write_scopes: ['src/a.js', 'docs/guide.md'],
    })

    assert.deepEqual(task.writeScopes, ['src/a.js', 'docs/guide.md'])
    assert.equal(normalizeAudits(store).length, 0)
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('全部条目被移除 → 既有「派单必须声明写范围」拒绝，不落卡', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const { director, dev, project } = await seedProject(service, store)
    await gitProject(join(workspace, project.slug), ['dist/', 'build/'])
    const sessionId = ownerSession(store, director, project, 'sess-norm-4')

    await assert.rejects(
      () => service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '全忽略', description: '做点事。',
        write_scopes: ['dist/build', 'build/out.js'],
      }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /派单必须声明写范围/)
        return true
      },
    )
    assert.equal(taskCount(store, project.id), 0)
    assert.equal(normalizeAudits(store).length, 0, '拒绝的派单不产生审计行（无任务实体可挂）')
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('一级目录声明驳回：单独与混合清单都拒绝，文案点出二级路径要求', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const { director, dev, project } = await seedProject(service, store)
    await gitProject(join(workspace, project.slug), ['dist/'])
    const sessionId = ownerSession(store, director, project, 'sess-norm-5')

    await assert.rejects(
      () => service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '裸目录', description: '做点事。',
        write_scopes: ['src'],
      }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /src/)
        assert.match(error.message, /二级路径或具体文件/)
        assert.match(error.message, /整目录声明会锁死同项目全部写运行/)
        return true
      },
    )
    // 混合清单：合法条目在场也整单拒绝，且点名违规条目。
    await assert.rejects(
      () => service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '混合', description: '做点事。',
        write_scopes: ['src/a.js', 'tests'],
      }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /tests/)
        return true
      },
    )
    assert.equal(taskCount(store, project.id), 0)
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('package.json 出口剥除不进驳回：混入清单静默去掉，纯 package.json 走既有拒绝', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const { director, dev, project } = await seedProject(service, store)
    await gitProject(join(workspace, project.slug), ['dist/'])
    const sessionId = ownerSession(store, director, project, 'sess-norm-6')

    const task = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '带包清单', description: '做点事。',
      write_scopes: ['package.json', 'src/a.js'],
    })
    assert.deepEqual(task.writeScopes, ['src/a.js'])

    // 纯 package.json：剥除后清单为空 → 既有「必须声明写范围」拒绝（f4763a2 现状，非一级驳回文案）。
    await assert.rejects(
      () => service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '纯包清单', description: '做点事。',
        write_scopes: ['package.json'],
      }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /派单必须声明写范围/)
        return true
      },
    )
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('非 git 目录跳过清洗：无 .gitignore 可言，条目全部保守放行', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const { director, dev, project } = await seedProject(service, store)
    // 不 git init：即便条目在别的仓库语义里会被忽略，这里也无从判定，保守放行。
    const sessionId = ownerSession(store, director, project, 'sess-norm-7')

    const task = await service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '非 git', description: '做点事。',
      write_scopes: ['dist/build', 'src/a.js'],
    })
    assert.deepEqual(task.writeScopes, ['dist/build', 'src/a.js'])
    assert.equal(normalizeAudits(store).length, 0)
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('createTask 直建（owner 派单路径）：同样清洗+审计挂真实 taskId；全部移除后按未声明建档', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const { dev, project } = await seedProject(service, store)
    await gitProject(join(workspace, project.slug), ['dist/'])

    const task = await service.createTask({
      projectId: project.id, title: '直建清洗', assigneeBotId: dev.id,
      writeScopes: ['dist/build', 'src/a.js'],
    })
    assert.deepEqual(task.writeScopes, ['src/a.js'])
    const audits = normalizeAudits(store)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].target_id, task.id)
    assert.deepEqual(JSON.parse(audits[0].data_json), { removed: ['dist/build'] })

    // createTask 本无「必须声明」闸门（backlog 卡允许未声明）：全部被移除 → 按未声明建档，
    // 后续闸门自然保守串行——「走既有」，不新增拒绝分支。
    const undeclared = await service.createTask({
      projectId: project.id, title: '全忽略直建', assigneeBotId: dev.id,
      writeScopes: ['dist/x'],
    })
    assert.deepEqual(undeclared.writeScopes, [])
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})

test('taskUpdateScopes 改卡入口：ignored 移除+审计+快照刷新；一级目录驳回', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const { dev, project } = await seedProject(service, store)
    await gitProject(join(workspace, project.slug), ['dist/'])
    const task = await service.createTask({
      projectId: project.id, title: '改范围', assigneeBotId: dev.id,
      writeScopes: ['src/old.js'],
    })

    const updated = await service.taskUpdateScopes(task.id, ['dist/build', 'src/new.js'], userActor(service))
    assert.deepEqual(updated.writeScopes, ['src/new.js'])
    const audits = normalizeAudits(store)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].target_id, task.id)
    assert.deepEqual(JSON.parse(audits[0].data_json), { removed: ['dist/build'] })

    await assert.rejects(
      () => service.taskUpdateScopes(task.id, ['src'], userActor(service)),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /二级路径或具体文件/)
        return true
      },
    )
  } finally {
    await closeQuietly(service, store)
    await rm(root, { recursive: true, force: true })
  }
})
