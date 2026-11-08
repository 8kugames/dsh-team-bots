// tests/memory-cap.test.ts —— DSHBOTS-339 守门：bot/project 作用域 64 条硬顶与滞回放行。
// 锁定六件事：
//  ① 播满 64 条后第 65 条被拒，文案含作用域、当前条数与整理指引；
//  ② 滞回：整理到 40 仍拒、到 33 放行变 34，标志随放行清位；
//  ③ 作用域独立：project 满不拦 bot，team 灌到 100 条也永不拦；
//  ④ 64 顶下同名覆盖写与 updateMemory 编辑照常成功；
//  ⑤ active 已 64 时 approveMemory 拒绝（conflict 同文案）；
//  ⑥ 自动沉淀降级：learnFromTask 满顶不抛不落行、completeMemoryReview applied=0 无异常；
//  ⑦ 单条记忆篇幅上限 256 字：超长写入被拒，自动沉淀/审查产出截断到预算内。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { MEMORY_CAP, MEMORY_COMPACT_TO, MEMORY_MAX_CHARS } from '../src/services/memory.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-cap-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const devView = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const projectView = await service.createProject({ name: 'Mem', key: 'MEM', ownerBotId: director.id, memberIds: [devView.id] })
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const actor = { type: 'user', id: service.localUserId }
  const seed = (scopeType: string, scopeId: string, n: number) => {
    const rows = []
    for (let i = 0; i < n; i++) {
      rows.push(service.createMemory({ scopeType, scopeId, topic: `主题 ${i}`, content: `内容 ${i}`, actor }))
    }
    return rows
  }
  const archive = (scopeType: string, scopeId: string, n: number) => {
    const rows = store.all(
      'SELECT id FROM memories WHERE scope_type = ? AND scope_id = ? AND status = ? ORDER BY created_at LIMIT ?',
      scopeType, scopeId, 'active', n,
    )
    for (const row of rows) store.run("UPDATE memories SET status = 'archived' WHERE id = ?", row.id)
    return rows.length
  }
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { root, store, service, director, project, actor, seed, archive, close }
}

test('a) 播满 64 条后第 65 条被拒，文案含作用域、条数与整理指引', async () => {
  const t = await setup()
  try {
    assert.equal(MEMORY_CAP, 64)
    assert.equal(MEMORY_COMPACT_TO, 33)
    t.seed('project', t.project.id, MEMORY_CAP)
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_CAP)
    assert.throws(
      () => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '第 65 条', content: '超限内容', actor: t.actor }),
      (error: any) => {
        assert.equal(error.status, 409)
        const message = String(error.message)
        assert.ok(message.includes('项目'), `文案应含作用域类型：${message}`)
        assert.ok(message.includes(t.project.id), `文案应含作用域 id：${message}`)
        assert.ok(message.includes(String(MEMORY_CAP)), `文案应含当前条数：${message}`)
        assert.match(message, /去废弃/, '文案应含去废弃指引')
        assert.match(message, /去冗/, '文案应含去冗指引')
        assert.match(message, /融合/, '文案应含融合指引')
        assert.ok(message.includes(`≤${MEMORY_COMPACT_TO}`), `文案应含整理阈值：${message}`)
        return true
      },
    )
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_CAP)
    assert.equal(t.store.setting(`memory_full:project:${t.project.id}`), '1')
  } finally {
    await t.close()
  }
})

test('b) 滞回：整理到 40 仍拒、到 33 放行变 34', async () => {
  const t = await setup()
  try {
    t.seed('project', t.project.id, MEMORY_CAP)
    assert.throws(
      () => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '第 65 条', content: '超限内容', actor: t.actor }),
      /上限/,
    )
    const flagKey = `memory_full:project:${t.project.id}`
    assert.equal(t.store.setting(flagKey), '1', '首次拦截应置滞回标志')
    t.archive('project', t.project.id, MEMORY_CAP - 40)
    assert.equal(t.service.memoryActiveCount('project', t.project.id), 40)
    assert.throws(
      () => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '整理到 40', content: '内容', actor: t.actor }),
      (error: any) => /40/.test(String(error.message)),
      '整理到 40 仍应拒绝并透出当前条数',
    )
    assert.equal(t.store.setting(flagKey), '1', '40 条时标志不得清')
    t.archive('project', t.project.id, 40 - MEMORY_COMPACT_TO)
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_COMPACT_TO)
    const created = t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '整理后新增', content: '内容', actor: t.actor })
    assert.ok(created.id, '整理到 33 后应放行')
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_COMPACT_TO + 1)
    assert.equal(t.store.setting(flagKey), null, '放行后滞回标志应清除')
  } finally {
    await t.close()
  }
})

test('c) 作用域独立：project 满不拦 bot，team 永不拦', async () => {
  const t = await setup()
  try {
    t.seed('project', t.project.id, MEMORY_CAP)
    const botMemory = t.service.createMemory({ scopeType: 'bot', scopeId: t.director.id, topic: 'bot 私记', content: '内容', actor: t.actor })
    assert.ok(botMemory.id, 'project 满不应拦 bot 作用域')
    t.seed('team', 'team', 100)
    assert.equal(t.service.memoryActiveCount('team', 'team'), 100, 'team 作用域不设上限')
    assert.throws(
      () => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '超限', content: '内容', actor: t.actor }),
      /上限/,
      'project 仍应被拦',
    )
    t.seed('bot', t.director.id, MEMORY_CAP - 1)
    assert.equal(t.service.memoryActiveCount('bot', t.director.id), MEMORY_CAP)
    assert.throws(
      () => t.service.createMemory({ scopeType: 'bot', scopeId: t.director.id, topic: '超限', content: '内容', actor: t.actor }),
      /上限/,
      'bot 灌满后同样触顶',
    )
    const teamMemory = t.service.createMemory({ scopeType: 'team', scopeId: 'team', topic: '再加一条', content: '内容', actor: t.actor })
    assert.ok(teamMemory.id, 'team 永不拦')
  } finally {
    await t.close()
  }
})

test('d) 64 顶下同名覆盖写与 updateMemory 编辑成功', async () => {
  const t = await setup()
  try {
    const seeded = t.seed('project', t.project.id, MEMORY_CAP)
    const sessionId = 'sess_owner'
    t.store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
       VALUES (?, ?, ?, 'project', NULL, ?)`,
      sessionId, t.director.id, t.project.id, new Date().toISOString(),
    )
    const { memory, overwritten } = t.service.memoryWriteFromBot(sessionId, { scope: 'project', topic: seeded[0].topic, content: '覆盖后的内容' })
    assert.equal(overwritten, true, '同名主题应走覆盖写而非新增')
    assert.equal(memory.revision, 2)
    assert.equal(memory.content, '覆盖后的内容')
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_CAP, '覆盖写不得叠条')
    const updated = await t.service.updateMemory(seeded[1].id, { content: '编辑后的内容' })
    assert.equal(updated.content, '编辑后的内容')
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_CAP, '编辑不得叠条')
    assert.throws(
      () => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '新增', content: '内容', actor: t.actor }),
      /上限/,
      '同作用域新增仍被拦',
    )
  } finally {
    await t.close()
  }
})

test('e) active 已 64 时 approveMemory 拒绝（conflict 同文案）', async () => {
  const t = await setup()
  try {
    const pending = t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '待审条目', content: '待审内容', actor: t.actor, status: 'pending' })
    t.seed('project', t.project.id, MEMORY_CAP)
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_CAP)
    await assert.rejects(
      () => t.service.approveMemory(pending.id, t.actor),
      (error: any) => {
        assert.equal(error.status, 409)
        assert.match(String(error.message), /上限/)
        assert.match(String(error.message), /去废弃/)
        return true
      },
    )
    assert.equal(t.store.get('SELECT status FROM memories WHERE id = ?', pending.id).status, 'pending', '被拒后 pending 不得转 active')
  } finally {
    await t.close()
  }
})

test('f) 自动沉淀触顶降级：learnFromTask 不抛不落行、completeMemoryReview applied=0', async () => {
  const t = await setup()
  try {
    t.seed('bot', t.director.id, MEMORY_CAP)
    t.seed('project', t.project.id, MEMORY_CAP)
    const now = new Date().toISOString()
    t.store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id, created_at, updated_at)
       VALUES ('task-1', ?, 1, '示例任务', 'done', 'medium', 'user', ?, ?, ?)`,
      t.project.id, t.service.localUserId, now, now,
    )
    const task = t.store.get('SELECT * FROM tasks WHERE id = ?', 'task-1')
    const output = '这是一段足够长的任务交付输出内容用于触发自动沉淀。'.repeat(2)
    assert.doesNotThrow(
      () => t.service.learnFromTask(t.project, t.director, task, output, 'run-auto-1'),
      'learnFromTask 触顶不得抛',
    )
    assert.equal(t.service.memoryActiveCount('bot', t.director.id), MEMORY_CAP, 'bot 域不得落行')
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_CAP, 'project 域不得落行')
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM memories WHERE source = 'run:run-auto-1'").n, 0)

    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at)
       VALUES ('run-review-1', ?, ?, 'memory_review', 'read', 'memory_review', 'run-source-1', 'running', 1, 'memory_review:run-source-1', ?)`,
      t.project.id, t.director.id, now,
    )
    const reviewRun = t.store.get('SELECT * FROM runs WHERE id = ?', 'run-review-1')
    const reviewOutput = JSON.stringify([{ scope: 'bot', topic: '审查结论', content: '满顶后审查产出的可复用事实', confidence: 0.9 }])
    const result = await t.service.completeMemoryReview(reviewRun, reviewOutput, null)
    assert.equal(result.applied, 0, '满顶时审查写入应全部降级丢弃')
    assert.equal(t.service.memoryActiveCount('bot', t.director.id), MEMORY_CAP)
  } finally {
    await t.close()
  }
})

test('g) 单条记忆篇幅上限 256 字：超长写入被拒，自动沉淀/审查截断到预算内', async () => {
  const t = await setup()
  try {
    assert.equal(MEMORY_MAX_CHARS, 256)
    const over = '长'.repeat(MEMORY_MAX_CHARS + 1)
    assert.throws(
      () => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '超长', content: over, actor: t.actor }),
      (error: any) => {
        assert.equal(error.status, 400)
        assert.match(String(error.message), /256/)
        return true
      },
      '超过 256 字应拒绝',
    )
    const exact = t.service.createMemory({
      scopeType: 'project', scopeId: t.project.id, topic: '刚好 256', content: '字'.repeat(MEMORY_MAX_CHARS), actor: t.actor,
    })
    assert.equal(exact.content.length, MEMORY_MAX_CHARS, '恰好 256 字应放行')
    await assert.rejects(
      () => t.service.updateMemory(exact.id, { content: '超'.repeat(MEMORY_MAX_CHARS + 1) }),
      /256/,
      '编辑同样受篇幅上限约束',
    )
    const sessionId = 'sess_owner'
    t.store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
       VALUES (?, ?, ?, 'project', NULL, ?)`,
      sessionId, t.director.id, t.project.id, new Date().toISOString(),
    )
    assert.throws(
      () => t.service.memoryWriteFromBot(sessionId, { scope: 'project', topic: exact.topic, content: '超'.repeat(MEMORY_MAX_CHARS + 1) }),
      /256/,
      '同名覆盖写同样受篇幅上限约束',
    )
    // 自动沉淀：超长输出截断到 256 字内落库。
    const now = new Date().toISOString()
    t.store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id, created_at, updated_at)
       VALUES ('task-long', ?, 1, '长输出任务', 'done', 'medium', 'user', ?, ?, ?)`,
      t.project.id, t.service.localUserId, now, now,
    )
    const task = t.store.get('SELECT * FROM tasks WHERE id = ?', 'task-long')
    t.service.learnFromTask(t.project, t.director, task, '很长的交付输出'.repeat(100), 'run-long-1')
    const settled = t.store.get("SELECT * FROM memories WHERE source = 'run:run-long-1' AND scope_type = 'bot'")
    assert.ok(settled, '自动沉淀应落行')
    assert.ok(settled.content.length <= MEMORY_MAX_CHARS, `沉淀应截断到 ${MEMORY_MAX_CHARS} 字内，实际 ${settled.content.length}`)
    // 审查产出：超长条目截断后仍计入 applied。
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at)
       VALUES ('run-review-long', ?, ?, 'memory_review', 'read', 'memory_review', 'run-long-src', 'running', 1, 'memory_review:run-long-src', ?)`,
      t.project.id, t.director.id, now,
    )
    const reviewRun = t.store.get('SELECT * FROM runs WHERE id = ?', 'run-review-long')
    const reviewOutput = JSON.stringify([{ scope: 'project', topic: '审查长文', content: '审'.repeat(500), confidence: 0.9 }])
    const result = await t.service.completeMemoryReview(reviewRun, reviewOutput, null)
    assert.equal(result.applied, 1, '截断后审查条目应正常落库')
    const reviewed = t.store.get("SELECT * FROM memories WHERE source = 'run:run-long-src' AND scope_type = 'project'")
    assert.ok(reviewed)
    assert.ok(reviewed.content.length <= MEMORY_MAX_CHARS, `审查产出应截断到 ${MEMORY_MAX_CHARS} 字内，实际 ${reviewed.content.length}`)
  } finally {
    await t.close()
  }
})
