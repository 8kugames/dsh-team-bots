// DSHBOTS-182：微信推送收敛——创建→完成闭环：创建成功与真正进入「已完成」（→done 转换）
// 各推恰一条（通知域统一收口在 src/services/task-notify.js），交付（→in_review/待验收）节点
// 不推。done 的全部转换路径（总监验收 applyReview、微信「验收 KEY-N」指令 wechatReview、
// 看板/编辑表单直接完成 transitionTask/updateTask）都收口在 updateTask 的 notifyTaskDone；
// 重复提交 done 不会真的转换，也就不会重复推。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// startRun 只记账不回调完成：任务 run 停在 running，交付/验收节奏完全由测试掌控。
class HoldingRuntime {
  constructor() {
    this.started = []
    this.canceled = []
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) {
    this.started.push(run.id)
    return `session-${run.id}`
  }
  async cancelRun(runId) {
    this.canceled.push(runId)
    return true
  }
}

// schedulerIntervalMs 拉满 30s（resolveConfig 上限）：测试期内定时 tick 不掺和。
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-notify-'))
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

async function seedProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({ name: 'Notify', key: 'TSN', ownerBotId: director.id, memberIds: [dev.id] })
  return { dev, project }
}

// 微信通道桩：只记录 notify 文本，不落库。
function stubWechat(service) {
  const pushed = []
  service.wechat = { notify(text) { pushed.push(text) } }
  return pushed
}

// 走一遍真实的交付前舞步：todo → in_progress（开工入队并起跑）→ in_review（写运行被中止）。
async function deliverForReview(service, store, task) {
  const actor = { type: 'user', id: service.localUserId }
  await service.transitionTask(task.id, 'in_progress', actor)
  await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND status = 'running'", task.id))
  await service.transitionTask(task.id, 'in_review', actor)
  await waitFor(() => store.get("SELECT status FROM runs WHERE task_id = ? AND status = 'canceled'", task.id))
}

test('bot 交付收尾（→in_review 待验收）：不推微信，交付群消息照常', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '交付不推', assigneeBotId: dev.id, postCard: false })
    // 同步直入队一条运行且不触发 tick：run 停在 queued，交付节奏由 finishRun 掌控。
    service.enqueueTaskRun(service.taskRow(task.id), 'manual', { type: 'system', id: 'system' })
    const run = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task'", task.id)
    const pushed = stubWechat(service)

    await service.finishRun({ runId: run.id, status: 'succeeded', output: '交付完成' })

    assert.equal(service.taskRow(task.id).status, 'in_review', '交付后进入待验收')
    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', run.id).status, 'succeeded')
    assert.equal(pushed.length, 0, '交付（待验收）节点不推微信')
    // 反证收尾真的走了交付分支：群里的「已交付」消息不受影响，撤的只是微信推送。
    assert.ok(
      store.all("SELECT * FROM messages WHERE project_id = ? AND body LIKE '%已交付%'", project.id).length >= 1,
      '交付消息照常落群',
    )
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('验收通过（applyReview 路径）：推恰一条完成通知，重复验收被拒不重复推', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '验收推送', assigneeBotId: dev.id, postCard: false })
    const pushed = stubWechat(service)
    await deliverForReview(service, store, task)
    assert.equal(pushed.length, 0, '开工/交付过程节点都不推微信')

    await service.applyReview(
      service.taskRow(task.id),
      service.projectRow(project.id),
      'accept',
      '验收通过',
      { type: 'user', id: service.localUserId },
    )

    assert.equal(service.taskRow(task.id).status, 'done')
    assert.equal(pushed.length, 1, '完成只推一条')
    assert.equal(pushed[0], `任务 TSN-${task.number}《验收推送》已完成。回复「详情 TSN-${task.number}」查看。`)

    await assert.rejects(
      () => service.applyReview(
        service.taskRow(task.id),
        service.projectRow(project.id),
        'accept',
        '',
        { type: 'user', id: service.localUserId },
      ),
      /不在待验收状态/,
    )
    assert.equal(pushed.length, 1, 'done 后重复验收被 TRANSITIONS 拒绝，不再推')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('微信「验收 KEY-N」指令：同一收口推恰一条，指令回复文案不受影响', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev, project } = await seedProject(service, store)
    task = await service.createTask({ projectId: project.id, title: '微信验收', assigneeBotId: dev.id, postCard: false })
    const pushed = stubWechat(service)
    await deliverForReview(service, store, task)
    assert.equal(pushed.length, 0, '过程节点不推')

    const reply = await service.wechatReview(`tsn-${task.number}`, { decision: 'accept', comment: '过了' })

    assert.ok(reply.includes('已验收通过'), '指令回复文案不受影响')
    assert.equal(service.taskRow(task.id).status, 'done')
    assert.equal(pushed.length, 1, '微信验收路径同样只推一条')
    assert.equal(pushed[0], `任务 TSN-${task.number}《微信验收》已完成。回复「详情 TSN-${task.number}」查看。`)
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('看板/编辑表单直接完成（transition_task → done）：同样推恰一条', async () => {
  const { root, store, service } = await setup()
  let task
  try {
    const { dev } = await seedProject(service, store)
    const project = store.get('SELECT * FROM projects WHERE key = ?', 'TSN')
    task = await service.createTask({ projectId: project.id, title: '直接完成', assigneeBotId: dev.id, postCard: false })
    const pushed = stubWechat(service)
    const actor = { type: 'user', id: service.localUserId }
    await deliverForReview(service, store, task)
    assert.equal(pushed.length, 0, '过程节点不推')

    await service.transitionTask(task.id, 'done', actor)

    assert.equal(service.taskRow(task.id).status, 'done')
    assert.equal(pushed.length, 1, '直接完成同样只推一条')
    assert.ok(pushed[0].includes(`任务 TSN-${task.number}《直接完成》已完成`))

    // done → done 重复提交是同状态幂等（与重复 in_progress 提交同构，不构成状态转换）：不重复推。
    await service.transitionTask(task.id, 'done', actor)
    assert.equal(pushed.length, 1, '同状态重复提交不重复推')
  } finally {
    if (task) await service.pauseRunsForBoard(task.id).catch(() => {})
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('创建任务（DSHBOTS-182 增补）：推恰一条含 KEY-N/标题/派给谁，无指派如实注明', async () => {
  const { root, store, service } = await setup()
  try {
    const { dev, project } = await seedProject(service, store)
    const pushed = stubWechat(service)

    const task = await service.createTask({ projectId: project.id, title: '创建推送', assigneeBotId: dev.id, postCard: false })

    assert.equal(pushed.length, 1, '创建只推一条')
    assert.equal(pushed[0], `任务 TSN-${task.number}《创建推送》已创建，派给 Builder。回复「详情 TSN-${task.number}」查看。`)

    const unassigned = await service.createTask({ projectId: project.id, title: '无主创建', status: 'todo', postCard: false })
    assert.equal(pushed.length, 2, '无指派任务创建同样推一条')
    assert.equal(pushed[1], `任务 TSN-${unassigned.number}《无主创建》已创建，暂未指派。回复「详情 TSN-${unassigned.number}」查看。`)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
