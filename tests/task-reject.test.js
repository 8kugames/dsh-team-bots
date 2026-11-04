// DSHBOTS-141：已完成/已取消任务支持「驳回」退回 backlog。
// 钉住三条行为 + 一条 UI 接线：
//   ①done→backlog 成功，completed_at 清空（canceled_at 本就为空）；
//   ②canceled→backlog 成功，canceled_at 清空（completed_at 本就为空）；
//   ③离开终态时仍有活跃运行（queued/running）→ 拒绝，状态与终态时间戳不变；
//   ④UI 侧：卡片与详情 footer 都出「驳回」按钮，click 委托走 transition_task，文案走 i18n。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// startRun 只记账不回调完成：任务 run 停在 running（本卡用例不依赖运行生命周期，仅作运行时替身）。
class HoldingRuntime {
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) {
    this.started.push({ id: run.id, taskId: run.task_id ?? null })
    return `session-${run.id}`
  }
  async cancelRun() { return true }
}

// schedulerIntervalMs 拉满 30s：定时 tick 不掺和，时序只由显式调用驱动。
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-reject-'))
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

const rowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

async function primeProject(service) {
  const director = service.store.get("SELECT * FROM bots WHERE name = 'director'")
  return await service.createProject({ name: 'Reject', key: 'REJ', ownerBotId: director.id })
}

// 状态推进走合法 TRANSITIONS 链（backlog → todo → in_progress → in_review → done）。
async function driveTo(service, taskId, status) {
  const chain = ['todo', 'in_progress', 'in_review', 'done']
  for (const next of chain.slice(0, chain.indexOf(status) + 1)) {
    await service.updateTask(taskId, { status: next })
  }
}

test('done→backlog 驳回成功：状态回 backlog，completed_at 清空', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(service)
    const task = await service.createTask({ projectId: project.id, title: '已完成任务' })
    await driveTo(service, task.id, 'done')
    assert.ok(rowOf(store, task.id).completed_at != null, '前置：done 应写 completed_at')
    assert.equal(rowOf(store, task.id).canceled_at, null, '前置：done 不得有 canceled_at')

    const view = await service.transitionTask(task.id, 'backlog')
    assert.equal(view.status, 'backlog')
    assert.equal(rowOf(store, task.id).status, 'backlog')
    assert.equal(rowOf(store, task.id).completed_at, null, '离开 done 必须清空 completed_at')
    assert.equal(rowOf(store, task.id).canceled_at, null, 'canceled_at 保持为空')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('canceled→backlog 驳回成功：状态回 backlog，canceled_at 清空', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(service)
    const task = await service.createTask({ projectId: project.id, title: '已取消任务' })
    await service.updateTask(task.id, { status: 'canceled' })
    assert.ok(rowOf(store, task.id).canceled_at != null, '前置：canceled 应写 canceled_at')
    assert.equal(rowOf(store, task.id).completed_at, null, '前置：canceled 不得有 completed_at')

    const view = await service.transitionTask(task.id, 'backlog')
    assert.equal(view.status, 'backlog')
    assert.equal(rowOf(store, task.id).status, 'backlog')
    assert.equal(rowOf(store, task.id).canceled_at, null, '离开 canceled 必须清空 canceled_at')
    assert.equal(rowOf(store, task.id).completed_at, null, 'completed_at 保持为空')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('离开终态时仍有活跃运行 → 拒绝，状态与终态时间戳不变', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(service)
    const bot = store.get("SELECT * FROM bots WHERE name = 'director'")
    const task = await service.createTask({ projectId: project.id, title: '挂运行的终态任务' })
    await driveTo(service, task.id, 'done')
    // 终态任务上仍挂着的活跃派生运行（核验类，running）：直插一条，模拟「驳回时运行未停」。
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, ?, 'review', 'read', 'review_delegate', 'running', 1, ?, ?)`,
      'run_active_reject', project.id, bot.id, task.id, 'test:run_active_reject', new Date().toISOString(),
    )

    await assert.rejects(
      () => service.transitionTask(task.id, 'backlog'),
      /请先停止再变更状态/,
    )
    assert.equal(rowOf(store, task.id).status, 'done', '拒绝后状态不得改变')
    assert.ok(rowOf(store, task.id).completed_at != null, '拒绝后 completed_at 不得被清空')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('UI 接线：卡片与详情 footer 出「驳回」按钮，click 走 transition_task，文案走 i18n', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = join(here, '..')
  const app = readFileSync(join(root, 'ui', 'app.js'), 'utf8')
  const zh = readFileSync(join(root, 'ui', 'i18n', 'zh.js'), 'utf8')
  const en = readFileSync(join(root, 'ui', 'i18n', 'en.js'), 'utf8')

  // 两处渲染点（卡片 foot + 详情 footer）都以 done/canceled 为条件，且共用同一 action 名。
  const rejectButtons = app.match(/data-action="reject-task"/g) ?? []
  assert.equal(rejectButtons.length, 2, '卡片与详情 footer 都应渲染「驳回」按钮')
  assert.match(app, /\['done',\s*'canceled'\]\.includes\(task\.status\)/, '按钮应按终态条件渲染')

  // click 委托：驳回走 transition_task 通道，确认弹窗在调用之前。
  const rejectCase = app.slice(app.indexOf("case 'reject-task'"))
  assert.ok(rejectCase.length > 0, '缺少 reject-task click 分支')
  assert.match(rejectCase.slice(0, 600), /window\.confirm\(t\('task\.rejectConfirm'/, '驳回前应有确认弹窗')
  assert.match(rejectCase.slice(0, 900), /api\('transition_task',\s*\{\s*taskId,\s*status:\s*'backlog'/, '驳回应走 transition_task 通道')

  // 文案走 i18n，不硬编码：zh/en 两侧都要有这四个 key。
  for (const dict of [zh, en]) {
    for (const key of ['task.rejectAction', 'task.rejectTitle', 'task.rejectConfirm', 'task.rejectDone']) {
      assert.ok(dict.includes(`'${key}':`), `i18n 缺 key：${key}`)
    }
  }
})
