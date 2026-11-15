// tests/reviewer-delegate.test.ts —— DSHBOTS-365：reviewer 产品默认角色。
// ① 建群默认带 reviewer：不显式指定成员的新群自动带入种子 reviewer；显式 memberIds
//    是用户裁剪过的名单，不擅自加人。
// ② 核验委派承接人：项目内有可用 reviewer 时 spawnReviewDelegate 落到 reviewer 名下；
//    移除 reviewer 后回落总监兜底（老链路）。
// ③ 验收机械闸认领线扩到「本任务的委派核验运行」：reviewer 跑的核验账目放行总监
//    team_review_task 裁决，不再要求「兜底验收」注记。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class HoldRuntime {
  setCompletionHandler(handler: any) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-hold' }
  async steer() { return true }
  async cancelRun() { return true }
  handler: any
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-rvd-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(
    join(workspace, '.agents', 'skills', 'review', 'SKILL.md'),
    `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`,
  )
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldRuntime() as any)
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")!
  const reviewer = store.get("SELECT * FROM bots WHERE name = 'reviewer'")!
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, director, reviewer, dev, close }
}

test('① 建群默认带 reviewer；显式 memberIds 不擅自加人', async () => {
  const t = await setup()
  try {
    assert.ok(t.reviewer, '种子库里有 reviewer')
    // 不显式指定成员：reviewer 自动进群。
    const auto = await t.service.createProject({ name: 'Auto', key: 'AUTO', ownerBotId: t.director.id })
    const autoMembers = t.service.membersOf(auto.id).map((row: any) => row.member_id ?? row.id)
    assert.ok(autoMembers.includes(t.reviewer.id), '默认成员包含 reviewer')

    // 显式 memberIds：视为用户裁剪过的名单，不加 reviewer。
    const manual = await t.service.createProject({
      name: 'Manual', key: 'MANU', ownerBotId: t.director.id, memberIds: [t.dev.id],
    })
    const manualMembers = t.service.membersOf(manual.id).map((row: any) => row.member_id ?? row.id)
    assert.ok(!manualMembers.includes(t.reviewer.id), '显式名单不含 reviewer')
  } finally { await t.close() }
})

test('② 核验委派优先 reviewer；移除后回落总监兜底', async () => {
  const t = await setup()
  try {
    const project = await t.service.createProject({ name: 'Delegate', key: 'DLG', ownerBotId: t.director.id, memberIds: [t.dev.id] })
    await t.service.addProjectMember(project.id, t.reviewer.id)
    const task = await t.service.createTask({
      projectId: project.id, title: '待核验', assigneeBotId: t.dev.id, status: 'in_review', postCard: false,
    })
    const first = t.service.spawnReviewDelegate(task, { actor: { type: 'user', id: 'local' } })
    const run = t.store.get('SELECT * FROM runs WHERE id = ?', first.runId)!
    assert.equal(run.bot_id, t.reviewer.id, '核验运行落在 reviewer 名下')
    assert.equal(run.kind, 'review')
    assert.equal(run.trigger_type, 'review_delegate')
    assert.equal(run.mode, 'read')

    // 清掉运行位再移除 reviewer：回落总监兜底（老链路）。
    t.store.run("UPDATE runs SET status = 'canceled', ended_at = ? WHERE id = ?", new Date().toISOString(), run.id)
    t.service.removeProjectMember(project.id, t.reviewer.id)
    const secondTask = await t.service.createTask({
      projectId: project.id, title: '兜底核验', assigneeBotId: t.dev.id, status: 'in_review', postCard: false,
    })
    const second = t.service.spawnReviewDelegate(secondTask, { actor: { type: 'user', id: 'local' } })
    const fallbackRun = t.store.get('SELECT * FROM runs WHERE id = ?', second.runId)!
    assert.equal(fallbackRun.bot_id, t.director.id, '移除 reviewer 后核验回落总监')
  } finally { await t.close() }
})

test('③ 机械闸认领线：reviewer 的核验账目放行总监裁决，无账目仍拒绝', async () => {
  const t = await setup()
  try {
    const project = await t.service.createProject({ name: 'Gate', key: 'GATE', ownerBotId: t.director.id, memberIds: [t.dev.id] })
    const task = await t.service.createTask({
      projectId: project.id, title: '闸门', assigneeBotId: t.dev.id, status: 'in_review', postCard: false,
    })
    // 负例：评审周期内无任何子代理账目 → 拒绝。
    assert.throws(
      () => t.service.assertReviewSubagentVerified('sess-none', project, task, '结论'),
      /没有子代理账目/,
    )
    // 正例：reviewer 名下的委派核验运行带 subagent_spawned 账目 → 放行（无需「兜底验收」）。
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at, started_at, ended_at, session_id)
       VALUES ('run-rv', ?, ?, ?, 'review', 'read', 'review_delegate', 'succeeded', 1, 'key-rv', ?, ?, ?, 'sess-rv')`,
      project.id, t.reviewer.id, task.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
    )
    t.store.run(
      "INSERT INTO run_events(id, run_id, type, message, created_at) VALUES ('evt-rv', 'run-rv', 'subagent_spawned', 'spawned', ?)",
      new Date().toISOString(),
    )
    t.service.assertReviewSubagentVerified('sess-none', project, task, '子代理核验：建议 accept')
  } finally { await t.close() }
})
