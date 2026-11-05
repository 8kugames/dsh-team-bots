// DSHBOTS-151 任务写范围 owner 可编辑：task_update_scopes 的行为测试（DB 行为）+ api.js 分发守门。
// 行为口径：
// ① owner-only：非 user actor 一律 forbidden；
// ② running 写运行拒改（400，提示先等运行结束或取消）；
// ③ queued 写运行允许改，且同步刷新其 write_scopes 快照 + run_events scopes_updated + 审计；
// ④ parseWriteScopes 归一（trim/去重/去尾斜杠）与空集合拒绝；终态卡（done/canceled）拒改。
// UI 编辑态（modal 编辑入口/表单/handler）的源码守门随 UI 段子卡补入本文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { handleAction } from '../src/api.js'

// 手动完成的 runtime：startRun 后运行保持 running，直到测试显式 complete。
class ManualRuntime {
  declare pendingRuns: Map<string, unknown>
  declare handler: ((result: { runId: string; status: string; output: string; error: null }) => unknown) | null

  constructor() {
    this.pendingRuns = new Map()
    this.handler = null
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  async startRun({ run }) {
    this.pendingRuns.set(run.id, run)
    return `session-${run.id}`
  }

  async steer() { return true }

  async cancelRun() { return true }

  complete(runId, status = 'succeeded', output = 'done') {
    this.pendingRuns.delete(runId)
    return this.handler({ runId, status, output, error: null })
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-scopes-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  // 关闭自动调度：queued 用例由测试显式 enqueueTaskRun 落运行，running 用例再显式开 tick。
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Scopes', key: 'SCP', ownerBotId: director.id, memberIds: [dev.id] })
  return { root, store, service, project, dev }
}

async function cleanup(root, store) {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const userActor = service => ({ type: 'user', id: service.localUserId })

async function makeTask(service, project, dev, overrides = {}) {
  return service.createTask({
    projectId: project.id,
    title: '改范围',
    assigneeBotId: dev.id,
    writeScopes: ['src/old.js'],
    ...overrides,
  })
}

test('owner-only：非 user actor 拒绝，user actor 放行', async () => {
  const { root, store, service, project, dev } = await setup()
  try {
    const task = await makeTask(service, project, dev)
    await assert.rejects(
      service.taskUpdateScopes(task.id, ['src/new.js'], { type: 'bot', id: dev.id }),
      /只有工作台 owner 可以修改写范围/,
    )
    const updated = await service.taskUpdateScopes(task.id, ['src/new.js'], userActor(service))
    assert.deepEqual(updated.writeScopes, ['src/new.js'], 'owner 修改应成功落库')
  } finally {
    await cleanup(root, store)
  }
})

test('running 写运行拒改：400 提示先等运行结束或取消，任务声明原样保留', async () => {
  const { root, store, service, project, dev } = await setup()
  try {
    const task = await makeTask(service, project, dev, { autoStart: true })
    service.started = true
    await service.tick()
    const running = store.get("SELECT id FROM runs WHERE task_id = ? AND status = 'running'", task.id)
    assert.ok(running, '前置：写运行应已处于 running')
    await assert.rejects(
      service.taskUpdateScopes(task.id, ['src/new.js'], userActor(service)),
      /先等运行结束或取消/,
    )
    const row = store.get('SELECT write_scopes FROM tasks WHERE id = ?', task.id)
    assert.deepEqual(JSON.parse(row.write_scopes), ['src/old.js'], '拒改时任务声明不能被改动')
    assert.equal(store.get('SELECT write_scopes FROM runs WHERE id = ?', running.id).write_scopes, JSON.stringify(['src/old.js']), '运行快照不能被改动')
  } finally {
    await cleanup(root, store)
  }
})

test('queued 写运行：允许改，任务声明与运行快照同拍更新，事件与审计齐写', async () => {
  const { root, store, service, project, dev } = await setup()
  try {
    const task = await makeTask(service, project, dev)
    // 显式走真实入队路径（scheduler 派发 outbox 时调用的同一方法），快照来自任务当时的声明。
    const runId = service.enqueueTaskRun(service.taskRow(task.id), 'assigned', userActor(service))
    assert.equal(
      store.get('SELECT write_scopes FROM runs WHERE id = ?', runId).write_scopes,
      JSON.stringify(['src/old.js']),
      '前置：入队快照应等于旧声明',
    )
    const updated = await service.taskUpdateScopes(task.id, ['src/new/deep.js', 'tests/new.test.js'], userActor(service))
    assert.deepEqual(updated.writeScopes, ['src/new/deep.js', 'tests/new.test.js'])
    assert.deepEqual(
      JSON.parse(store.get('SELECT write_scopes FROM runs WHERE id = ?', runId).write_scopes),
      ['src/new/deep.js', 'tests/new.test.js'],
      '排队运行的写范围快照必须同步为新声明（下一拍调度按它判闸）',
    )
    const runEvent = store.get("SELECT type, message FROM run_events WHERE run_id = ? AND type = 'scopes_updated'", runId)
    assert.ok(runEvent, '运行事件应记 scopes_updated')
    assert.match(runEvent.message, /src\/new\/deep\.js/)
    const taskEvent = store.get("SELECT type, data_json FROM task_events WHERE task_id = ? AND type = 'scopes_updated'", task.id)
    assert.ok(taskEvent, '任务事件应记 scopes_updated')
    assert.deepEqual(JSON.parse(taskEvent.data_json), { from: ['src/old.js'], to: ['src/new/deep.js', 'tests/new.test.js'] })
    const audit = store.get("SELECT data_json FROM audit_log WHERE action = 'task.scopes_update' AND target_id = ?", task.id)
    assert.ok(audit, '审计应记 task.scopes_update')
    assert.deepEqual(JSON.parse(audit.data_json), { from: ['src/old.js'], to: ['src/new/deep.js', 'tests/new.test.js'] })
  } finally {
    await cleanup(root, store)
  }
})

test('归一化：trim/去重/去尾斜杠后落库；空集合与终态卡拒绝', async () => {
  const { root, store, service, project, dev } = await setup()
  try {
    const task = await makeTask(service, project, dev)
    const updated = await service.taskUpdateScopes(
      task.id,
      ['  src/api.js ', 'src/api.js/', 'src/api.js', 'tests/api.test.js'],
      userActor(service),
    )
    assert.deepEqual(updated.writeScopes, ['src/api.js', 'tests/api.test.js'], 'trim/去重/去尾斜杠后只留归一条目')
    await assert.rejects(
      service.taskUpdateScopes(task.id, [], userActor(service)),
      /写范围不能为空/,
    )
    await assert.rejects(
      service.taskUpdateScopes(task.id, ['/abs/path'], userActor(service)),
      /非法路径/,
    )
    const done = await makeTask(service, project, dev, { status: 'done', title: '已完结' })
    await assert.rejects(
      service.taskUpdateScopes(done.id, ['src/x.js'], userActor(service)),
      /任务已结束，不能修改写范围/,
    )
    const canceled = await makeTask(service, project, dev, { status: 'canceled', title: '已取消' })
    await assert.rejects(
      service.taskUpdateScopes(canceled.id, ['src/x.js'], userActor(service)),
      /任务已结束，不能修改写范围/,
    )
  } finally {
    await cleanup(root, store)
  }
})

// ── api.js 分发守门（UI 编辑态的接线守门随 UI 段子卡补齐）─────────────────────────
test('api.js 分发收录 task_update_scopes（ACTIONS + case 双口径）', () => {
  const apiSource = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8')
  assert.match(apiSource, /'task_update_scopes',/, 'ACTIONS Set 收录')
  assert.match(apiSource, /case 'task_update_scopes':/, 'switch 分发收录')
  assert.match(apiSource, /service\.taskUpdateScopes\(/, 'case 调用服务层 taskUpdateScopes')
})

test('handleAction 分发层：write_scopes 与 writeScopes 双口径收参一致落库，缺 taskId 被拦截', async () => {
  const { root, store, service, project, dev } = await setup()
  try {
    const task = await makeTask(service, project, dev)
    await handleAction(service, 'task_update_scopes', { taskId: task.id, write_scopes: [' src/a.js ', 'src/a.js/'] }, userActor(service))
    assert.deepEqual(
      JSON.parse(store.get('SELECT write_scopes FROM tasks WHERE id = ?', task.id).write_scopes),
      ['src/a.js'],
      'write_scopes 键：分发层直传服务层并归一落库',
    )
    await handleAction(service, 'task_update_scopes', { taskId: task.id, writeScopes: ['src/b.js'] }, userActor(service))
    assert.deepEqual(
      JSON.parse(store.get('SELECT write_scopes FROM tasks WHERE id = ?', task.id).write_scopes),
      ['src/b.js'],
      'writeScopes 键：camelCase 口径同样生效',
    )
    await assert.rejects(
      () => handleAction(service, 'task_update_scopes', { write_scopes: ['src/c.js'] }, userActor(service)),
      /taskId/,
      '缺 taskId 被分发层 required 拦截',
    )
  } finally {
    await cleanup(root, store)
  }
})

// ── UI 编辑态源码守门（DSHBOTS-155：modal 两态切换 + handler 接线）──────────────────
function stripLineComments(source) {
  return source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
}

test('任务详情 modal：写范围段两态——只读 chips 保留 + 编辑入口带终态闸 + 编辑态表单', () => {
  const source = readFileSync(new URL('../ui/modules/modal-forms.js', import.meta.url), 'utf8')
  const start = source.indexOf('function modalTask(')
  const end = source.indexOf('\nfunction ', start + 1)
  const modalTaskBody = stripLineComments(source.slice(start, end > 0 ? end : undefined))
  assert.ok(start >= 0 && end > start, '前置：能截取 modalTask 函数体')
  // 只读态保持（D-124 口径不回归）
  assert.match(modalTaskBody, /scope-chips/, 'chips 展示保留')
  assert.match(modalTaskBody, /未声明（保守串行）/, '未声明兜底文案保留')
  // 终态闸：终态卡不渲染编辑入口，与后端 taskUpdateScopes 终态拒改同口径
  assert.match(modalTaskBody, /const scopesEditable = !\['done', 'canceled'\]\.includes\(task\.status\)/, '终态卡不进编辑态的闸门在场')
  assert.match(modalTaskBody, /editingScopes \? scopesEdit : `\$\{scopesEditable \?/, '编辑态优先，查看态里编辑入口由终态闸控制')
  assert.match(modalTaskBody, /data-action="edit-scopes"/, '编辑入口按钮在场')
  assert.match(modalTaskBody, /data-task-id="\$\{attr\(task\.id\)\}"/, '编辑动作携带 task id')
  // 编辑态表单：预填旧声明、逗号或空格分隔口径、保存/取消、生效范围 hint 逐字
  assert.match(modalTaskBody, /id="task-write-scopes"/, '输入框在场')
  assert.match(modalTaskBody, /placeholder="\$\{t\("逗号或空格分隔路径"\)\}"/, 'placeholder 口径在场')
  assert.match(modalTaskBody, /writeScopes\.join\(', '\)/, '预填旧声明')
  assert.match(modalTaskBody, /data-action="update-scopes"/, '保存按钮在场')
  assert.match(modalTaskBody, /data-action="cancel-scopes-edit"/, '取消按钮在场')
  assert.match(modalTaskBody, /保存后立即生效于排队中的运行；运行中的运行不受影响/, 'hint 逐字在场')
})

test('编辑态 handler：切态走弹窗层局部刷新，保存走 task_update_scopes，失败文案透传', () => {
  const source = stripLineComments(readFileSync(new URL('../ui/modules/events-click.js', import.meta.url), 'utf8'))
  assert.match(source, /case 'edit-scopes':/, '编辑入口 case 在场')
  assert.match(source, /case 'cancel-scopes-edit':/, '取消 case 在场')
  assert.match(source, /case 'update-scopes':/, '保存 case 在场')
  assert.match(source, /import \{ renderModalLayer \} from '\.\/modal-layer\.js'/, '弹窗层同步入口已接线')
  assert.match(source, /renderModalLayer\(\)/, '两态切换只同步弹窗层（modal 原位补丁，不整页重建）')
  assert.match(source, /getElementById\('task-write-scopes'\)/, '从输入框取值')
  assert.match(source, /split\(\/\[,，、\\s\]\+\/\)/, '输入按逗号/顿号/空白切分')
  assert.match(source, /api\('task_update_scopes', \{ taskId: target\.dataset\.taskId, write_scopes: scopes \}, \{ quiet: true \}\)/, '保存调用 task_update_scopes（quiet，错误自管）')
  assert.match(source, /refreshAfterTask\(target\.dataset\.taskId\)/, '成功后刷新任务详情')
  assert.match(source, /toast\(t\("写范围已更新"\), 'success'\)/, '成功 toast')
  assert.match(source, /toast\(error\.message \|\| String\(error\), 'error'\)/, '失败透传后端文案')
})
