// 任务卡修正闭环（DSHBOTS-232）：
// ① 已派单卡卡面变更（标题/描述/优先级/写范围）→ 群内系统消息点名负责人修正，
//    负责人名下有活跃运行时再向其会话注入修正提示（steer + run 事件 card_changed）；
//    值未变/未派单/纯状态流转不触发。总监经 team_assign_task 重派带 title/description/priority 改卡同口径。
// ② 总监强制受阻：进行中任务移 blocked + 既有 abort 链路停运行
//    （TASK_FORCE_BLOCKED 稳定码 + force_blocked 事件 + task.force_blocked 审计留痕）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// startRun 只记账不回调完成：任务 run 停在 running，卡面变更注入与强制受阻才有活跃运行可作用。
// 落 session_id 对齐真实 DshRuntime 契约（runtime/session.ts startRun 时写入），steer 注入依赖它。
class HoldingRuntime {
  store: any
  constructor(store) {
    this.store = store
  }
  started: string[] = []
  canceled: string[] = []
  steered: { sessionId: string; body: string }[] = []
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) {
    this.started.push(run.id)
    this.store.run('UPDATE runs SET session_id = ?, started_at = ?, last_progress_at = ? WHERE id = ?',
      `session-${run.id}`, new Date().toISOString(), new Date().toISOString(), run.id)
    return `session-${run.id}`
  }
  async cancelRun(runId) {
    this.canceled.push(runId)
    return true
  }
  async steer(sessionId, body) {
    this.steered.push({ sessionId, body })
    return true
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-card-fix-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new HoldingRuntime(store)
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  return { root, store, service, runtime }
}

async function seedProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({ name: 'CardFix', key: 'CFX', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project }
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

const cardChangedMessages = (store, projectId) =>
  store.all("SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '%卡面已变更%' ORDER BY rowid", projectId)

const runEventTypes = (store, runId) =>
  store.all('SELECT type FROM run_events WHERE run_id = ?', runId).map(row => row.type)

test('改卡→通知发出：系统消息点名负责人；活跃运行注入修正提示并记 card_changed 事件', async () => {
  const { root, store, service, runtime } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '修正闭环', description: '初版', assigneeBotId: dev.id, postCard: false })
    await service.transitionTask(task.id, 'in_progress', { type: 'user', id: service.localUserId })
    let run
    await waitFor(() => {
      run = store.get("SELECT * FROM runs WHERE task_id = ? AND status = 'running'", task.id)
      return run
    })

    await service.updateTask(task.id, { description: '按新需求修正后的卡面' }, { type: 'user', id: service.localUserId })

    const messages = cardChangedMessages(store, project.id)
    assert.equal(messages.length, 1, '卡面变更恰好发一条系统消息')
    assert.equal(messages[0].task_id, task.id)
    assert.equal(messages[0].body, `任务 CFX-${task.number} 卡面已变更，请按新卡面修正。`)
    assert.deepEqual(JSON.parse(messages[0].mentions_json), [dev.id], '点名负责人')

    assert.equal(runtime.steered.length, 1, '活跃运行注入一条修正提示')
    assert.equal(runtime.steered[0].sessionId, run.session_id)
    assert.ok(runtime.steered[0].body.includes(`Task card CFX-${task.number} has just been amended`))
    assert.ok(runEventTypes(store, run.id).includes('card_changed'), 'run 侧记 card_changed 事件')

    await service.pauseRunsForBoard(task.id).catch(() => {})
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('不触发口径：同值重写、纯状态流转、未派单卡改卡面——零通知', async () => {
  const { root, store, service } = await setup()
  try {
    const { dev, project } = await seedProject(service, store)
    const dispatched = await service.createTask({ projectId: project.id, title: '已派单', description: '描述甲', assigneeBotId: dev.id, postCard: false })
    await service.updateTask(dispatched.id, { description: '描述甲' }, { type: 'user', id: service.localUserId })
    await service.updateTask(dispatched.id, { status: 'in_progress' }, { type: 'user', id: service.localUserId })
    assert.equal(cardChangedMessages(store, project.id).length, 0, '同值重写与状态流转不触发')

    const unassigned = await service.createTask({ projectId: project.id, title: '未派单', description: '描述乙', postCard: false })
    await service.updateTask(unassigned.id, { description: '描述乙改' }, { type: 'user', id: service.localUserId })
    assert.equal(cardChangedMessages(store, project.id).length, 0, '未派单卡无人可通知，不触发')

    await service.pauseRunsForBoard(dispatched.id).catch(() => {})
    await service.cancelRunsForTask(unassigned.id).catch(() => {})
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('总监重派改卡（team_assign_task 语义）：description 随重派落卡且通知负责人，不另起运行', async () => {
  const { root, store, service, runtime } = await setup()
  try {
    const { director, dev, project } = await seedProject(service, store)
    store.run(
      'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
      'sess-cfx', director.id, project.id, 'project', new Date().toISOString(),
    )
    const task = await service.assignFromBot('sess-cfx', {
      assignee: 'Builder', title: '初始卡', description: '初版描述', write_scopes: ['src/a/x.ts'],
    })
    let run
    await waitFor(() => {
      run = store.get("SELECT * FROM runs WHERE task_id = ? AND status = 'running'", task.id)
      return run
    })

    const updated = await service.assignFromBot('sess-cfx', {
      task: `CFX-${task.number}`, assignee: 'Builder', description: '整合后的新卡面',
    })

    assert.equal(updated.description, '整合后的新卡面', '重派带 description 已落卡')
    const messages = cardChangedMessages(store, project.id)
    assert.equal(messages.length, 1, '改卡通知已发出')
    assert.deepEqual(JSON.parse(messages[0].mentions_json), [dev.id])
    assert.equal(Number(store.get('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?', task.id).n), 1, '同负责人重派不另起运行')
    assert.ok(runtime.steered.some(item => item.sessionId === run.session_id), '活跃运行注入修正提示')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('强制受阻：进行中任务移 blocked，运行走既有 abort 链路中止并留痕（TASK_FORCE_BLOCKED/force_blocked/task.force_blocked）', async () => {
  const { root, store, service, runtime } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '跑偏任务', description: 'x', assigneeBotId: dev.id, postCard: false })
    await service.transitionTask(task.id, 'in_progress', { type: 'user', id: service.localUserId })
    let run
    await waitFor(() => {
      run = store.get("SELECT * FROM runs WHERE task_id = ? AND status = 'running'", task.id)
      return run
    })

    const view = await service.forceBlockTask(task.id, { type: 'user', id: service.localUserId })

    assert.equal(view.status, 'blocked', '任务已移受阻')
    const stopped = store.get('SELECT * FROM runs WHERE id = ?', run.id)
    assert.equal(stopped.status, 'canceled')
    assert.equal(stopped.error_code, 'TASK_FORCE_BLOCKED', '强制受阻专用稳定码，区别于看板暂停')
    assert.ok(stopped.ended_at, '运行已结束')
    assert.ok(runtime.canceled.includes(run.id), 'runtime.cancelRun 已下发（既有 abort 链路）')
    assert.ok(runEventTypes(store, run.id).includes('force_blocked'), 'run 侧记 force_blocked 事件')
    const audit = store.get("SELECT * FROM audit_log WHERE action = 'task.force_blocked' AND target_id = ?", task.id)
    assert.ok(audit, '审计留痕 task.force_blocked')
    assert.deepEqual(JSON.parse(audit.data_json).stoppedRuns, [run.id], '审计记录被停运行清单')
    const last = store.all("SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' ORDER BY rowid", project.id).at(-1)
    assert.equal(last.body, `任务 CFX-${task.number} 被总监强制移为受阻，运行已中止。`)

    // 非进行中任务不可强制受阻（口径收紧：只收 in_progress）
    await assert.rejects(
      () => service.forceBlockTask(task.id, { type: 'user', id: service.localUserId }),
      /不在进行中/,
    )
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
