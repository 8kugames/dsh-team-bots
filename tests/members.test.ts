import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'

import { handleAction } from '../src/api.js'
import { setupTeam } from './helpers/harness.js'
import { installSubagentLedger } from '../src/subagent-ledger.js'

// 宿主 cordis 瀑布流语义复刻（与 tests/subagent-ledger.test.ts 同款），用于驱动子代理账本。
class FakeCordisCtx {
  declare hooks: Map<string, any[]>
  constructor() { this.hooks = new Map() }
  on(name: string, listener: any) {
    const list = this.hooks.get(name) ?? []
    this.hooks.set(name, list)
    list.push(listener)
    return () => { const i = list.indexOf(listener); if (i >= 0) list.splice(i, 1) }
  }
  async waterfall(name: string, req: any, inner: any) {
    const cbs = (this.hooks.get(name) ?? []).slice()
    const next = () => {
      const cb = cbs.shift() ?? inner
      return cb(req, () => next())
    }
    return next()
  }
  emit(name: string, ...args: any[]) {
    for (const listener of [...(this.hooks.get(name) ?? [])]) listener(...args)
  }
}

async function setup() {
  return setupTeam({ prefix: 'dsh-members-test-', schedulerIntervalMs: 20 })
}

function insertRun(store, { id: runId, projectId, botId, status = 'succeeded', usage = {} }: { id: any; projectId: any; botId: any; status?: any; usage?: any }) {
  const ts = new Date().toISOString()
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, queued_at, started_at, ended_at,
       usage_input, usage_cache_read, usage_cache_write, usage_output, usage_cost)
     VALUES (?, ?, ?, 'task', 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    runId, projectId, botId, status, `idem-${runId}`, ts, ts, ts,
    usage.input ?? 0, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, usage.output ?? 0, usage.cost ?? 0,
  )
}

test('add_member / remove_member manage membership with precise error semantics', async () => {
  const { root, store, service } = await setup()
  try {
    const actor = { type: 'user', id: 'owner' }
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build things.' })
    const project = await service.createProject({ name: 'Demo Project', key: 'DEMO', ownerBotId: director.id })

    // 邀请新成员：零值起步，busy=false、usage 全 0（含 0 值成员不缺行）
    const added = await handleAction(service, 'add_member', { projectId: project.id, botId: builder.id }, actor)
    const member = added.members.find(row => row.id === builder.id)
    assert.ok(member, 'added member should appear in project view')
    assert.equal(member.member_role, 'member')
    assert.equal(member.busy, false)
    assert.equal(member.usage_input, 0)
    assert.equal(member.usage_output, 0)
    assert.equal(member.usage_cost, 0)

    // 重复添加 → 409
    await assert.rejects(
      () => handleAction(service, 'add_member', { projectId: project.id, botId: builder.id }, actor),
      (err: any) => err.code === 'CONFLICT',
    )
    // 不存在的 bot → 404
    await assert.rejects(
      () => handleAction(service, 'add_member', { projectId: project.id, botId: 'bot_missing' }, actor),
      (err: any) => err.code === 'NOT_FOUND',
    )
    // 归档 bot 不可邀请 → 400
    const archived = await service.createBot({ name: 'Retired', role: '开发', instructions: 'None.' })
    await service.archiveBot(archived.id, actor)
    await assert.rejects(
      () => handleAction(service, 'add_member', { projectId: project.id, botId: archived.id }, actor),
      (err: any) => err.code === 'BAD_REQUEST',
    )
    // 移除非成员 → 404；总监不可移除 → 403
    await assert.rejects(
      () => handleAction(service, 'remove_member', { projectId: project.id, botId: archived.id }, actor),
      (err: any) => err.code === 'NOT_FOUND',
    )
    await assert.rejects(
      () => handleAction(service, 'remove_member', { projectId: project.id, botId: director.id }, actor),
      (err: any) => err.code === 'FORBIDDEN',
    )

    // 移除成员后不出现在成员列表（mention 定向随 membersOf 自动失效）
    const removed = await handleAction(service, 'remove_member', { projectId: project.id, botId: builder.id }, actor)
    assert.equal(removed.members.some(row => row.id === builder.id), false)
    assert.equal(service.membersOf(project.id).some(row => row.member_id === builder.id), false)

    // 归档项目不可增删成员 → 400
    await service.archiveProject(project.id, actor)
    await assert.rejects(
      () => handleAction(service, 'add_member', { projectId: project.id, botId: builder.id }, actor),
      (err: any) => err.code === 'BAD_REQUEST',
    )
    await assert.rejects(
      () => handleAction(service, 'remove_member', { projectId: project.id, botId: director.id }, actor),
      (err: any) => err.code === 'BAD_REQUEST',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('membersWithUsage aggregates busy state and per-project usage totals', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build things.' })
    const idle = await service.createBot({ name: 'Watcher', role: '测试', instructions: 'Watch.' })
    const project = await service.createProject({
      name: 'Usage Project', key: 'USAGE', ownerBotId: director.id, memberIds: [builder.id, idle.id],
    })
    const other = await service.createProject({ name: 'Other Project', key: 'OTHER', ownerBotId: director.id })
    await service.addProjectMember(other.id, builder.id, { type: 'user', id: 'owner' })

    // builder 在本项目两条成功 run（各 input=100/output=50/cacheRead=10/cost=0.01），另有一条属于其他项目的 run
    insertRun(store, { id: 'run-u1', projectId: project.id, botId: builder.id, usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01 } })
    insertRun(store, { id: 'run-u2', projectId: project.id, botId: builder.id, usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01 } })
    insertRun(store, { id: 'run-x1', projectId: other.id, botId: builder.id, usage: { input: 999, output: 999, cost: 9 } })
    // director 有一条排队中的 run → busy
    insertRun(store, { id: 'run-q1', projectId: project.id, botId: director.id, status: 'queued' })

    const members = service.projectView(service.projectRow(project.id)).members
    const builderRow = members.find(row => row.id === builder.id)
    const directorRow = members.find(row => row.id === director.id)
    const idleRow = members.find(row => row.id === idle.id)

    // 只聚合本项目：两条 run 的和，其他项目的不算
    assert.equal(builderRow.usage_input, 200)
    assert.equal(builderRow.usage_output, 100)
    assert.equal(builderRow.usage_cache_read, 20)
    assert.equal(builderRow.usage_cache_write, 10)
    assert.ok(Math.abs(builderRow.usage_cost - 0.02) < 1e-9)
    assert.equal(builderRow.busy, false)

    // 排队中 → 任务中
    assert.equal(directorRow.busy, true)
    assert.equal(directorRow.usage_input, 0)

    // 无 run 的成员照常出现且全 0
    assert.ok(idleRow)
    assert.equal(idleRow.usage_input, 0)
    assert.equal(idleRow.usage_cost, 0)
    assert.equal(idleRow.busy, false)

    // owner 排在成员列表最前
    assert.equal(members[0].id, director.id)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('membersWithUsage run_status 三态判定：bot 全局口径，busy 仍项目口径', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const builder = await service.createBot({ name: 'Runner', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a' })
    const watcher = await service.createBot({ name: 'Watcher', role: '测试', instructions: 'Watch.' })
    const project = await service.createProject({
      name: 'Status Project', key: 'STATUS', ownerBotId: director.id, memberIds: [builder.id, watcher.id],
    })
    const other = await service.createProject({ name: 'Elsewhere', key: 'ELSE', ownerBotId: director.id })

    // 时间戳递增的 run：run_status 取「最近一条已终结 run」，同刻时间戳会让排序退化到 rowid，显式错开。
    const at = n => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 60_000).toISOString()
    const run = (id, n, projectId, botId, status) => store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, queued_at, started_at, ended_at)
       VALUES (?, ?, ?, 'task', 'manual', ?, ?, ?, ?, ?)`,
      id, projectId, botId, status, `idem-${id}`, at(n), at(n), status === 'queued' || status === 'running' ? null : at(n),
    )
    const statusOf = async botId => {
      const members = service.projectView(service.projectRow(project.id)).members
      return members.find(row => row.id === botId)
    }

    // 1) 无 run → idle；模型未配置 → modelRef null；配了 → provider/model 组合
    assert.equal((await statusOf(watcher.id)).run_status, 'idle')
    assert.equal((await statusOf(watcher.id)).run_phase, null)
    assert.equal((await statusOf(watcher.id)).modelRef, null)
    assert.equal((await statusOf(builder.id)).modelRef, 'fake/model-a')

    // 2) 单聊 run（project_id NULL）运行中：run_status=running（bot 全局口径），busy=false（项目口径不含单聊）
    run('solo-r1', 1, null, builder.id, 'running')
    let row = await statusOf(builder.id)
    assert.equal(row.run_status, 'running')
    assert.equal(row.run_phase, 'running')
    assert.equal(row.busy, false)

    // 3) 单聊 run 以失败收场 → failed；busy 仍 false
    store.run("UPDATE runs SET status = 'failed', ended_at = ? WHERE id = 'solo-r1'", at(2))
    row = await statusOf(builder.id)
    assert.equal(row.run_status, 'failed')
    assert.equal(row.busy, false)

    // 4) 跨项目（builder 非成员）成功 run 更晚 → 回落 idle：失败不粘死，成功即翻篇
    run('other-r1', 3, other.id, builder.id, 'succeeded')
    assert.equal((await statusOf(builder.id)).run_status, 'idle')

    // 5) 最近一条是 canceled → 不算失败，仍 idle
    run('cancel-r1', 4, project.id, builder.id, 'canceled')
    assert.equal((await statusOf(builder.id)).run_status, 'idle')
    assert.equal((await statusOf(builder.id)).busy, false)

    // 6) 本项目排队 → busy=true 且 run_status=running（两个口径同时为真）
    run('proj-q1', 5, project.id, builder.id, 'queued')
    row = await statusOf(builder.id)
    assert.equal(row.run_status, 'running')
    assert.equal(row.run_phase, 'queued')
    assert.equal(row.busy, true)

    // 7) director 无 run → idle
    assert.equal((await statusOf(director.id)).run_status, 'idle')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('membersWithUsage taskStats：本项目任务聚合，待办=未完成且未取消，无任务兜底 0/0', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const builder = await service.createBot({ name: 'Worker', role: '开发', instructions: 'Build.' })
    const watcher = await service.createBot({ name: 'Watcher', role: '测试', instructions: 'Watch.' })
    const project = await service.createProject({
      name: 'TaskStats Project', key: 'TSTATS', ownerBotId: director.id, memberIds: [builder.id, watcher.id],
    })
    const other = await service.createProject({ name: 'Elsewhere', key: 'ELSE2', ownerBotId: director.id })

    // builder 在本项目：done×1 + todo×2 + canceled×1（canceled 不算待办）；另有一条属于其他项目的任务不计数
    const mk = async (projectId, title, assignee) =>
      (await service.createTask({ projectId, title, assigneeBotId: assignee })).id
    const walk = async (id, ...sts) => { for (const st of sts) await service.updateTask(id, { status: st }) }
    const tDone = await mk(project.id, '已完成的活', builder.id)
    await walk(tDone, 'in_progress', 'in_review', 'done')
    await mk(project.id, '待办一', builder.id)
    await mk(project.id, '待办二', builder.id)
    const tCanceled = await mk(project.id, '被取消的活', builder.id)
    await walk(tCanceled, 'canceled')
    // 别项目任务挂在总监名下：builder 在该项目无归属，其完成不计入 builder 的本项目统计
    const tOther = await mk(other.id, '别项目的活', director.id)
    await walk(tOther, 'in_progress', 'in_review', 'done')

    const members = service.projectView(service.projectRow(project.id)).members
    const builderRow = members.find(row => row.id === builder.id)
    const watcherRow = members.find(row => row.id === watcher.id)

    // done=1（别项目的完成不计）、open=2（canceled 被排除）
    assert.deepEqual(builderRow.taskStats, { done: 1, open: 2 })
    // 无任务成员兜底 0/0，不许 undefined（前端会显示 NaN）
    assert.deepEqual(watcherRow.taskStats, { done: 0, open: 0 })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('update_project 不带 memberIds 时不动成员表；换总监自动补齐成员归属', async () => {
  const { root, store, service } = await setup()
  try {
    const actor = { type: 'user', id: 'owner' }
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build things.' })
    const project = await service.createProject({ name: 'Demo Project', key: 'DEMO', ownerBotId: director.id })
    await handleAction(service, 'add_member', { projectId: project.id, botId: builder.id }, actor)

    // 设置页不全量提交 memberIds：纯信息更新（如改描述）不得触碰成员表
    await handleAction(service, 'update_project', { projectId: project.id, patch: { description: 'changed' } }, actor)
    let roles = store.all('SELECT member_id, member_role FROM project_members WHERE project_id = ?', project.id)
    assert.equal(roles.length, 3, '纯信息更新后成员数不变（director+默认 reviewer+builder）')
    assert.equal(roles.find(row => row.member_id === builder.id)?.member_role, 'member')

    // 换总监（不带 memberIds）：新总监须自动进成员表且角色为 owner，原总监降为普通成员
    await handleAction(service, 'update_project', { projectId: project.id, patch: { ownerBotId: builder.id } }, actor)
    roles = store.all('SELECT member_id, member_role FROM project_members WHERE project_id = ?', project.id)
    assert.equal(roles.length, 3, '换总监不增不减成员')
    assert.equal(roles.find(row => row.member_id === builder.id)?.member_role, 'owner', '新总监角色为 owner')
    assert.equal(roles.find(row => row.member_id === director.id)?.member_role, 'member', '原总监降为普通成员')

    // 幂等：同一总监再保存一次仍是 owner，成员数不变
    await handleAction(service, 'update_project', { projectId: project.id, patch: { ownerBotId: builder.id } }, actor)
    roles = store.all('SELECT member_id, member_role FROM project_members WHERE project_id = ?', project.id)
    assert.equal(roles.length, 3)
    assert.equal(roles.find(row => row.member_id === builder.id)?.member_role, 'owner')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('在跑子代理计入成员看板 busy：项目口径外（如单聊）的子代理也判任务中', async () => {
  const { root, store, service } = await setup()
  try {
    const worker = await service.createBot({ name: 'Worker', role: '开发', instructions: 'Build things.' })
    const project = await service.createProject({
      name: 'Subagent Board', key: 'SUBBRD', ownerBotId: worker.id,
    })
    // 单聊运行中（project_id NULL）：项目口径 busy=false，run_status=running（bot 全局口径）
    insertRun(store, { id: 'run-solo', projectId: null, botId: worker.id, status: 'running' })
    const ts = new Date().toISOString()
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES ('ctrl-solo', ?, NULL, 'bot', NULL, ?)",
      worker.id, ts,
    )
    const busyOf = () => service.projectView(service.projectRow(project.id)).members.find(row => row.id === worker.id)?.busy
    assert.equal(busyOf(), false)

    // 子代理在跑（账本经宿主事件缝计数）→ busy 翻 true
    const ctx = new FakeCordisCtx()
    const dispose = installSubagentLedger(ctx, store, { info() {}, warn() {}, error() {} })
    try {
      await ctx.waterfall('tools/pre-execute', {
        name: 'subagent',
        callId: 'call-1',
        arguments: { description: '研究看板状态' },
        agent: { session: { id: 'ctrl-solo' } },
      }, async () => ({ allowed: true }))
      assert.equal(busyOf(), true)

      // 子代理收尾（tools/result 配对减计数）→ busy 回 false（单聊 run 仍 running，但项目口径不含）
      ctx.emit('tools/result', {
        name: 'subagent',
        callId: 'call-1',
        arguments: {},
        agent: { session: { id: 'ctrl-solo' } },
      }, { value: { sessionId: 'child-1', summary: 'done' } })
      assert.equal(busyOf(), false)
    } finally {
      dispose()
    }
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('membersWithUsage 带控制面会话 id（跳原生界面入口）', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.' })
    const project = await service.createProject({
      name: 'Ctrl Project', key: 'CTRL', ownerBotId: director.id, memberIds: [builder.id],
    })
    const ts = new Date().toISOString()
    // builder 在本项目有控制面绑定；在别的项目另有一条（不该串进来）
    store.run(
      'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias) VALUES (?, ?, ?, ?, NULL, ?, 0)',
      'ctrl-1', builder.id, project.id, 'bot', ts,
    )
    const other = await service.createProject({ name: 'Other', key: 'OTHER2', ownerBotId: director.id })
    store.run(
      'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias) VALUES (?, ?, ?, ?, NULL, ?, 0)',
      'ctrl-other', builder.id, other.id, 'bot', ts,
    )

    const members = service.projectView(service.projectRow(project.id)).members
    assert.equal(members.find(row => row.id === builder.id)?.controlSessionId, 'ctrl-1')
    // 无绑定成员（director 未建控制面绑定）为 null，不误报
    assert.equal(members.find(row => row.id === director.id)?.controlSessionId, null)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
