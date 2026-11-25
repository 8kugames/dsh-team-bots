// tests/task-goal.test.ts —— 任务卡版本化 Goal 锚点。
// ① 迁移：tasks 的 goal 四列随 openDatabase 落库；
// ② 建档：createTask 带 goal 落 v1，taskView.goal 暴露编号标准；非法输入整单拒绝；
// ③ 修订：updateTask 带 goal 升版本并落 goal_revised 事件；同值重写与状态流转都不升版本；
// ④ 派单链：team_assign_task 的新卡与重派改卡都能设/改 Goal，只传一半时另一半沿用；
// ⑤ 父目标快照：设目标时记父卡当时的 Goal 版本，父卡之后改目标不改子卡快照。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class HoldingRuntime {
  declare started: unknown[]
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push(run.id); return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-goal-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Goal', key: 'GOAL', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-task-goal-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  const actor = { type: 'user', id: service.localUserId }
  return { root, store, service, director, dev, project, sessionId, actor }
}

async function cleanup(root, service, store) {
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try { await service.cancelRunInternal(run.id, false) } catch {}
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const rowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)
const goalEvents = (t, taskId) => t.service.groupChatStore(t.project.id).all(
  'SELECT type, data_json FROM task_events WHERE task_id = ? AND type = ?', taskId, 'goal_revised',
)
const GOAL = { statement: '登录页可用手机号登录', criteria: ['输入合法手机号能收到验证码', '验证码错误时提示且不跳转'] }

test('迁移与建档：goal 四列在场，createTask 带 goal 落 v1，taskView.goal 暴露编号标准', async () => {
  const t = await setup()
  try {
    const columns = t.store.all("SELECT name FROM pragma_table_info('tasks')").map(column => column.name)
    for (const column of ['goal_statement', 'goal_criteria', 'goal_version', 'goal_parent_version']) {
      assert.ok(columns.includes(column), `tasks.${column} 列应随迁移落库`)
    }

    const card = await t.service.createTask({ projectId: t.project.id, title: '带 Goal', writeScopes: ['src/a.js'], goal: GOAL }, t.actor)
    assert.deepEqual(card.goal, {
      version: 1, statement: GOAL.statement, parentGoalVersion: null, criteria: [
        { id: 'C1', text: GOAL.criteria[0] }, { id: 'C2', text: GOAL.criteria[1] },
      ],
    }, '建档即 v1，标准编号从 C1 起')
    assert.equal(rowOf(t.store, card.id).goal_version, 1)
    assert.equal(goalEvents(t, card.id).length, 1, '设 v1 也落一条 goal_revised 事件（from null → 1）')
    assert.equal(JSON.parse(goalEvents(t, card.id)[0].data_json).from, null)

    const bare = await t.service.createTask({ projectId: t.project.id, title: '无 Goal', writeScopes: ['src/b.js'] }, t.actor)
    assert.equal(bare.goal, null, '没填 Goal 就是 null，不从描述生成')
    assert.equal(goalEvents(t, bare.id).length, 0)
  } finally { await cleanup(t.root, t.service, t.store) }
})

test('建档校验：目标陈述与完成标准缺一不可，超条数/超长度整单拒绝而不是悄悄截断', async () => {
  const t = await setup()
  try {
    const base = { projectId: t.project.id, title: '坏 Goal', writeScopes: ['src/bad/'] }
    const rejected = async (goal, pattern) => {
      await assert.rejects(t.service.createTask({ ...base, goal } as any, t.actor), pattern)
    }
    await rejected({ statement: '  ', criteria: ['a'] }, /目标陈述不能为空/)
    await rejected({ statement: '目标', criteria: [] }, /至少需要一条完成标准/)
    await rejected({ statement: '目标', criteria: ['  '] }, /至少需要一条完成标准/)
    await rejected({ statement: '目标', criteria: '不是数组' }, /完成标准应为字符串数组/)
    await rejected({ statement: '目标', criteria: Array.from({ length: 13 }, (_, index) => `标准${index}`) }, /最多 12 条/)
    await rejected({ statement: 'x'.repeat(2_001), criteria: ['a'] }, /目标陈述不能超过 2000 字符/)
    await rejected({ statement: '目标', criteria: ['y'.repeat(501)] }, /单条完成标准不能超过 500 字符/)
    await rejected('不是对象', /goal 应为/)
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM tasks WHERE title = '坏 Goal'").n, 0, '被拒绝的卡不落库')
  } finally { await cleanup(t.root, t.service, t.store) }
})

test('修订：改 Goal 升版本并落事件；同值重写与状态流转都不升版本', async () => {
  const t = await setup()
  try {
    const card = await t.service.createTask({ projectId: t.project.id, title: '修订卡', writeScopes: ['src/a.js'], goal: GOAL }, t.actor)
    const same = await t.service.updateTask(card.id, { goal: { ...GOAL, criteria: [...GOAL.criteria] } }, t.actor)
    assert.equal(same.goal.version, 1, '内容没变不产生新版本')

    const revised = await t.service.updateTask(card.id, { goal: { statement: GOAL.statement, criteria: [...GOAL.criteria, '连续错 5 次锁定 10 分钟'] } }, t.actor)
    assert.equal(revised.goal.version, 2, '显式改目标升到 v2')
    assert.deepEqual(revised.goal.criteria.map(item => item.id), ['C1', 'C2', 'C3'], '标准重新连续编号')
    assert.equal(revised.version, card.version + 1, '改 Goal 同时推进卡片编辑版本（expected_version 栅栏能看到）')

    const events = goalEvents(t, card.id)
    assert.equal(events.length, 2, '同值重写不落事件，只有 v1 与 v2 两条')
    const last = JSON.parse(events[1].data_json)
    assert.equal(last.from, 1)
    assert.equal(last.to, 2)
    assert.deepEqual(last.criteria, revised.goal.criteria.map(item => item.text), '旧版本正文留在事件里，不进新 run 上下文')

    const moved = await t.service.updateTask(card.id, { status: 'todo' }, t.actor)
    assert.equal(moved.goal.version, 2, '状态流转不改 Goal 版本')
    assert.equal(goalEvents(t, card.id).length, 2)

    await assert.rejects(
      t.service.updateTask(card.id, { goal: { statement: '只改陈述', criteria: [] } } as any, t.actor),
      /至少需要一条完成标准/,
    )
    assert.equal(rowOf(t.store, card.id).goal_version, 2, '被拒绝的修订不落库')

    // 终态卡的 Goal 不再修订（与写范围终态闸同口径）。
    for (const status of ['in_progress', 'in_review', 'done']) await t.service.updateTask(card.id, { status }, t.actor)
    await assert.rejects(
      t.service.updateTask(card.id, { goal: { statement: '事后改目标', criteria: ['x'] } } as any, t.actor),
      /任务已结束，不能修改 Goal/,
    )
    assert.equal(rowOf(t.store, card.id).goal_version, 2, '终态卡的 Goal 不再修订')

    // 按任务号回读卡面时带当前 Goal：被要求「重读卡面再裁决」的 bot 看得到要对照的那一版。
    assert.match(
      t.service.recall(t.sessionId, `GOAL-${card.number}`),
      /Goal \(current version v2\):\n登录页可用手机号登录\n  C1\. 输入合法手机号能收到验证码\n  C2\. 验证码错误时提示且不跳转\n  C3\. 连续错 5 次锁定/,
    )
    const bare = await t.service.createTask({ projectId: t.project.id, title: '回读裸卡' }, t.actor)
    assert.ok(!t.service.recall(t.sessionId, `GOAL-${bare.number}`).includes('Goal (current version'), '没有 Goal 的卡回读时不出现 Goal 段')
  } finally { await cleanup(t.root, t.service, t.store) }
})

test('派单链：新卡带 Goal，重派只传一半时另一半沿用；成员会话改不了 Goal', async () => {
  const t = await setup()
  try {
    const created = await t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '派单卡', description: '做 A', write_scopes: ['src/a.js'],
      goal_statement: GOAL.statement, completion_criteria: GOAL.criteria,
    })
    assert.equal(created.goal.version, 1, '总监派单新卡的 Goal 落 v1')

    const criteriaOnly = await t.service.assignFromBot(t.sessionId, { task: 'GOAL-1', assignee: 'Builder', completion_criteria: ['只要这一条'] })
    assert.equal(criteriaOnly.goal.version, 2, '只改完成标准也升版本')
    assert.equal(criteriaOnly.goal.statement, GOAL.statement, '陈述沿用当前 Goal')
    assert.deepEqual(criteriaOnly.goal.criteria.map(item => item.text), ['只要这一条'])

    const statementOnly = await t.service.assignFromBot(t.sessionId, { task: 'GOAL-1', assignee: 'Builder', goal_statement: '改口后的目标' })
    assert.equal(statementOnly.goal.version, 3)
    assert.deepEqual(statementOnly.goal.criteria.map(item => item.text), ['只要这一条'], '只改陈述时完成标准沿用')

    const untouched = await t.service.assignFromBot(t.sessionId, { task: 'GOAL-1', assignee: 'Builder', description: '补充说明一句' })
    assert.equal(untouched.goal.version, 3, '重派不带 Goal 字段就不动 Goal')

    const memberSession = 'sess-task-goal-member'
    t.store.run(
      'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
      memberSession, t.dev.id, t.project.id, 'project', new Date().toISOString(),
    )
    await assert.rejects(
      t.service.assignFromBot(memberSession, { task: 'GOAL-1', assignee: 'Builder', goal_statement: '成员偷改' } as any),
      /只有项目总监 Bot 可以执行该操作/,
    )
  } finally { await cleanup(t.root, t.service, t.store) }
})

test('父目标快照：设目标时记父卡当时的版本，父卡之后改目标不改子卡快照', async () => {
  const t = await setup()
  try {
    const parent = await t.service.createTask({ projectId: t.project.id, title: '主卡', writeScopes: ['src/p/'], goal: GOAL }, t.actor)
    const child = await t.service.createTask({
      projectId: t.project.id, title: '子卡', writeScopes: ['src/c/'], parentTaskId: parent.id, goal: GOAL,
    }, t.actor)
    assert.equal(child.goal.parentGoalVersion, 1, '子卡设目标时父卡在 v1')

    await t.service.updateTask(parent.id, { goal: { statement: '主卡目标改了', criteria: GOAL.criteria } }, t.actor)
    assert.equal(rowOf(t.store, child.id).goal_parent_version, 1, '父卡改目标不动子卡快照')

    await t.service.updateTask(child.id, { goal: { statement: '子卡目标也改', criteria: GOAL.criteria } }, t.actor)
    assert.equal(rowOf(t.store, child.id).goal_parent_version, 2, '子卡再次设目标时快照跟到父卡当前版本')

    const orphan = await t.service.createTask({ projectId: t.project.id, title: '顶层卡', writeScopes: ['src/t/'], goal: GOAL }, t.actor)
    assert.equal(orphan.goal.parentGoalVersion, null, '没有父卡就没有父目标快照')
  } finally { await cleanup(t.root, t.service, t.store) }
})
