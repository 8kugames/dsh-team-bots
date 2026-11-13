// tests/memory-cap.test.ts —— DSHBOTS-339/342 守门：bot/project 作用域 64 条硬顶与滞回放行。
// a 触顶拦截文案；b 滞回 40 拒/33 放行；c 作用域独立（team 不限）；d 64 顶下覆盖写与编辑；
// e approve 触顶拒；f 自动沉淀降级；g 篇幅上限与自动截断；
// h 项目再开容量闸（DSHBOTS-342）；i UTF-16 口径（星面字符算 2 码元）；j bot 触顶+滞回标志置/清；
// k approve 滞回中间带（34–63 持续拒）；l memoryWriteFromBot 新建路径满顶拒；m 超长存量 topic-only 编辑放行。
// n 锁定带文案如实（DSHBOTS-355，61 条不得谎称已达上限）；o 触顶态文案回归；p 放行/拒绝边界矩阵；
// q 锁定带覆盖写放行；r 现场序列回归（64→62→61 全链路）；s logger %s 插值（根 index.ts createLogger）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../index.js'
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

test('h) 项目再开容量闸：冻结超 64 条整笔拒绝，整理后放行且不破顶', async () => {
  const t = await setup()
  try {
    t.seed('project', t.project.id, 60)
    t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '待审随冻', content: '内容', actor: t.actor, status: 'pending' })
    t.seed('project', t.project.id, MEMORY_CAP - 60)
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_CAP)
    t.service.archiveProject(t.project.id, t.actor)
    assert.equal(t.store.get('SELECT status FROM projects WHERE id = ?', t.project.id).status, 'archived')
    assert.equal(
      t.store.get("SELECT COUNT(*) AS n FROM memories WHERE scope_type = 'project' AND scope_id = ? AND status = 'frozen'", t.project.id).n,
      MEMORY_CAP + 1,
      '归档应把 active+pending 一并冻结',
    )
    await assert.rejects(
      () => t.service.reopenProject(t.project.id, t.actor),
      (error: any) => error.status === 409 && /上限/.test(String(error.message)) && /去废弃/.test(String(error.message)),
      '冻结 65 条时再开应拒绝',
    )
    assert.equal(t.store.get('SELECT status FROM projects WHERE id = ?', t.project.id).status, 'archived', '拒绝后项目保持归档')
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM memory_events WHERE action = 'unfrozen'").n, 0, '拒绝不得留下解冻事件')
    const frozenRows = t.store.all(
      "SELECT id FROM memories WHERE scope_type = 'project' AND scope_id = ? AND status = 'frozen' LIMIT 2",
      t.project.id,
    )
    for (const row of frozenRows) t.service.deleteMemory(row.id, t.actor)
    const view = await t.service.reopenProject(t.project.id, t.actor)
    assert.equal(view.status, 'active')
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_CAP - 1, '整理 2 条后重开应为 63 条 active')
    assert.equal(
      t.store.get("SELECT COUNT(*) AS n FROM memories WHERE scope_type = 'project' AND scope_id = ? AND status = 'frozen'", t.project.id).n,
      0,
      '重开后不应残留 frozen',
    )
  } finally {
    await t.close()
  }
})

test('i) 篇幅闸按 UTF-16 码元计：128 个星面字符恰好 256 放行、129 个拒绝', async () => {
  const t = await setup()
  try {
    assert.equal('😀'.length, 2, '星面字符在 UTF-16 下占 2 个码元')
    const exact = t.service.createMemory({
      scopeType: 'project', scopeId: t.project.id, topic: '星面 256', content: '😀'.repeat(128), actor: t.actor,
    })
    assert.equal(exact.content.length, MEMORY_MAX_CHARS, '128 个星面字符 = 256 码元应放行')
    assert.throws(
      () => t.service.createMemory({
        scopeType: 'project', scopeId: t.project.id, topic: '星面 258', content: '😀'.repeat(129), actor: t.actor,
      }),
      (error: any) => error.status === 400 && /258/.test(String(error.message)),
      '129 个星面字符 = 258 码元应拒绝',
    )
  } finally {
    await t.close()
  }
})

test('j) bot 作用域触顶置滞回标志、整理到 ≤33 清标志放行', async () => {
  const t = await setup()
  try {
    const botId = t.director.id
    const flagKey = `memory_full:bot:${botId}`
    t.seed('bot', botId, MEMORY_CAP)
    assert.throws(
      () => t.service.createMemory({ scopeType: 'bot', scopeId: botId, topic: '超限', content: '内容', actor: t.actor }),
      /上限/,
      'bot 灌满后第 65 条应被拒',
    )
    assert.equal(t.store.setting(flagKey), '1', 'bot 触顶应置滞回标志')
    t.archive('bot', botId, MEMORY_CAP - 40)
    assert.equal(t.service.memoryActiveCount('bot', botId), 40)
    assert.throws(
      () => t.service.createMemory({ scopeType: 'bot', scopeId: botId, topic: '中间带', content: '内容', actor: t.actor }),
      /40/,
      '标志在时 40 条仍拒',
    )
    assert.equal(t.store.setting(flagKey), '1', '中间带标志不得清')
    t.archive('bot', botId, 40 - MEMORY_COMPACT_TO)
    const created = t.service.createMemory({ scopeType: 'bot', scopeId: botId, topic: '整理后新增', content: '内容', actor: t.actor })
    assert.ok(created.id, '整理到 33 后 bot 作用域应放行')
    assert.equal(t.store.setting(flagKey), null, '放行后滞回标志应清')
  } finally {
    await t.close()
  }
})

test('k) approveMemory 滞回中间带：标志在、34–63 条持续拒，≤33 才放行', async () => {
  const t = await setup()
  try {
    const pending = t.service.createMemory({
      scopeType: 'project', scopeId: t.project.id, topic: '待审条目', content: '待审内容', actor: t.actor, status: 'pending',
    })
    t.seed('project', t.project.id, MEMORY_CAP)
    const flagKey = `memory_full:project:${t.project.id}`
    await assert.rejects(() => t.service.approveMemory(pending.id, t.actor), /上限/)
    assert.equal(t.store.setting(flagKey), '1', 'approve 触顶应置滞回标志')
    t.archive('project', t.project.id, MEMORY_CAP - 40)
    await assert.rejects(
      () => t.service.approveMemory(pending.id, t.actor),
      (error: any) => /40/.test(String(error.message)),
      '中间带 40 条时 approve 仍应拒并透出当前条数',
    )
    assert.equal(t.store.setting(flagKey), '1', '中间带标志不得清')
    t.archive('project', t.project.id, 40 - MEMORY_COMPACT_TO)
    const approved = await t.service.approveMemory(pending.id, t.actor)
    assert.equal(approved.status, 'active')
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_COMPACT_TO + 1)
    assert.equal(t.store.setting(flagKey), null, 'approve 放行后滞回标志应清')
  } finally {
    await t.close()
  }
})

test('l) memoryWriteFromBot 同名新建路径满顶被拒', async () => {
  const t = await setup()
  try {
    t.seed('project', t.project.id, MEMORY_CAP)
    const sessionId = 'sess_owner_new'
    t.store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
       VALUES (?, ?, ?, 'project', NULL, ?)`,
      sessionId, t.director.id, t.project.id, new Date().toISOString(),
    )
    assert.throws(
      () => t.service.memoryWriteFromBot(sessionId, { scope: 'project', topic: '全新主题', content: '内容' }),
      (error: any) => error.status === 409 && /上限/.test(String(error.message)),
      '无同名可覆盖时新建路径同样受容量闸约束',
    )
    assert.equal(t.service.memoryActiveCount('project', t.project.id), MEMORY_CAP, '被拒不得叠条')
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM memories WHERE topic = '全新主题'").n, 0)
  } finally {
    await t.close()
  }
})

test('m) 超长存量条目仅改 topic 放行，改 content 仍受篇幅闸约束', async () => {
  const t = await setup()
  try {
    const long = '长'.repeat(MEMORY_MAX_CHARS + 10)
    const now = new Date().toISOString()
    t.store.run(
      `INSERT INTO memories(id, scope_type, scope_id, topic, content, source, confidence, status, created_by, created_at, updated_at, revision, summary)
       VALUES ('mem-legacy', 'project', ?, '旧主题', ?, '', 1, 'active', 'system', ?, ?, 1, '')`,
      t.project.id, long, now, now,
    )
    const updated = await t.service.updateMemory('mem-legacy', { topic: '新主题' })
    assert.equal(updated.topic, '新主题')
    assert.equal(updated.content, long, 'topic-only 编辑不得触碰 content')
    assert.equal(updated.content.length, MEMORY_MAX_CHARS + 10)
    await assert.rejects(
      () => t.service.updateMemory('mem-legacy', { content: '超'.repeat(MEMORY_MAX_CHARS + 1) }),
      /256/,
      '实际变更 content 时仍受篇幅闸约束',
    )
  } finally {
    await t.close()
  }
})

test('n) 锁定带文案如实：标志在、61 条时不再谎称「已达 61/64」', async () => {
  const t = await setup()
  try {
    const flagKey = `memory_full:project:${t.project.id}`
    t.seed('project', t.project.id, MEMORY_CAP)
    assert.throws(
      () => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '触顶', content: '内容', actor: t.actor }),
      /上限/,
      '先触顶置滞回标志',
    )
    assert.equal(t.store.setting(flagKey), '1')
    t.archive('project', t.project.id, 3)
    assert.equal(t.service.memoryActiveCount('project', t.project.id), 61)
    assert.throws(
      () => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '锁定期新增', content: '内容', actor: t.actor }),
      (error: any) => {
        const message = String(error.message)
        assert.ok(message.includes('此前触顶'), `文案应说明此前触顶：${message}`)
        assert.ok(message.includes('锁定期'), `文案应说明整理锁定期：${message}`)
        assert.ok(message.includes('当前 61 条'), `文案应如实报当前条数：${message}`)
        assert.ok(message.includes(`≤${MEMORY_COMPACT_TO}`), `文案应含整理阈值：${message}`)
        assert.ok(message.includes('覆盖写不受影响'), `文案应说明覆盖写不受影响：${message}`)
        assert.doesNotMatch(message, /已达 61\/64/, '61<64 不得再出现「已达 61/64」句式')
        return true
      },
    )
  } finally {
    await t.close()
  }
})

test('o) 触顶态文案回归：=64 拒绝时仍含 64、去废弃、去冗、融合与 ≤33', async () => {
  const t = await setup()
  try {
    t.seed('project', t.project.id, MEMORY_CAP)
    assert.throws(
      () => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '第 65 条', content: '内容', actor: t.actor }),
      (error: any) => {
        const message = String(error.message)
        assert.ok(message.includes(String(MEMORY_CAP)), `文案应含上限值：${message}`)
        assert.match(message, /去废弃/, '文案应含去废弃指引')
        assert.match(message, /去冗/, '文案应含去冗指引')
        assert.match(message, /融合/, '文案应含融合指引')
        assert.ok(message.includes(`≤${MEMORY_COMPACT_TO}`), `文案应含整理阈值：${message}`)
        return true
      },
    )
  } finally {
    await t.close()
  }
})

test('p) 边界矩阵：无标志 59–63 放行、64 拒并置标志；有标志 34 拒、33 放行清标志', async t => {
  const ctx = await setup()
  try {
    const flagKey = `memory_full:project:${ctx.project.id}`
    const create = (topic: string) => ctx.service.createMemory({ scopeType: 'project', scopeId: ctx.project.id, topic, content: '内容', actor: ctx.actor })
    ctx.seed('project', ctx.project.id, 59)
    for (const pre of [59, 60, 61, 62, 63]) {
      await t.test(`无标志 pre=${pre} 放行`, () => {
        assert.equal(ctx.service.memoryActiveCount('project', ctx.project.id), pre)
        assert.ok(create(`矩阵新增 ${pre}`).id, `pre=${pre} 应放行`)
      })
    }
    await t.test('无标志 pre=64 拒绝并置标志', () => {
      assert.equal(ctx.service.memoryActiveCount('project', ctx.project.id), MEMORY_CAP)
      assert.throws(() => create('矩阵新增 64'), (error: any) => error.status === 409 && /上限/.test(String(error.message)))
      assert.equal(ctx.store.setting(flagKey), '1', '触顶应置标志')
    })
    ctx.archive('project', ctx.project.id, 30)
    await t.test('有标志 34 拒（锁定期文案）', () => {
      assert.equal(ctx.service.memoryActiveCount('project', ctx.project.id), 34)
      assert.throws(() => create('矩阵新增 34'), (error: any) => /锁定期/.test(String(error.message)) && /当前 34 条/.test(String(error.message)))
      assert.equal(ctx.store.setting(flagKey), '1', '34 条时标志不得清')
    })
    ctx.archive('project', ctx.project.id, 1)
    await t.test('有标志 33 放行并清标志', () => {
      assert.equal(ctx.service.memoryActiveCount('project', ctx.project.id), MEMORY_COMPACT_TO)
      assert.ok(create('矩阵新增 33').id, '整理到 33 应放行')
      assert.equal(ctx.store.setting(flagKey), null, '放行后标志应清')
    })
  } finally {
    await ctx.close()
  }
})

test('q) 锁定带覆盖写放行：标志在、61 条时同名覆盖写不经容量闸', async () => {
  const t = await setup()
  try {
    t.seed('project', t.project.id, MEMORY_CAP)
    const flagKey = `memory_full:project:${t.project.id}`
    assert.throws(
      () => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '触顶', content: '内容', actor: t.actor }),
      /上限/,
    )
    t.archive('project', t.project.id, 3)
    assert.equal(t.service.memoryActiveCount('project', t.project.id), 61)
    const sessionId = 'sess_lock_band'
    t.store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
       VALUES (?, ?, ?, 'project', NULL, ?)`,
      sessionId, t.director.id, t.project.id, new Date().toISOString(),
    )
    const survivor = t.store.get(
      "SELECT topic FROM memories WHERE scope_type = 'project' AND scope_id = ? AND status = 'active' LIMIT 1",
      t.project.id,
    )
    const { memory, overwritten } = t.service.memoryWriteFromBot(sessionId, { scope: 'project', topic: survivor.topic, content: '锁定期覆盖后的内容' })
    assert.equal(overwritten, true, '锁定带同名主题应走覆盖写而非新增')
    assert.equal(memory.revision, 2)
    assert.equal(memory.content, '锁定期覆盖后的内容')
    assert.equal(t.service.memoryActiveCount('project', t.project.id), 61, '覆盖写不得叠条')
    assert.equal(t.store.setting(flagKey), '1', '覆盖写不经容量闸，标志保持')
  } finally {
    await t.close()
  }
})

test('r) 现场序列回归：64 触顶→归档 2→覆盖写成功→新增拒→再归档 1→61 仍拒且文案如实', async () => {
  const t = await setup()
  try {
    const flagKey = `memory_full:project:${t.project.id}`
    const create = (topic: string) => t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic, content: '内容', actor: t.actor })
    t.seed('project', t.project.id, MEMORY_CAP)
    assert.throws(() => create('新增一次'), (error: any) => error.status === 409 && /上限/.test(String(error.message)))
    assert.equal(t.store.setting(flagKey), '1', '触顶应置滞回标志')
    t.archive('project', t.project.id, 2)
    assert.equal(t.service.memoryActiveCount('project', t.project.id), 62)
    assert.equal(t.store.setting(flagKey), '1', '归档不清标志')
    const sessionId = 'sess_owner_scene'
    t.store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
       VALUES (?, ?, ?, 'project', NULL, ?)`,
      sessionId, t.director.id, t.project.id, new Date().toISOString(),
    )
    const survivor = t.store.get(
      "SELECT topic FROM memories WHERE scope_type = 'project' AND scope_id = ? AND status = 'active' LIMIT 1",
      t.project.id,
    )
    const { overwritten } = t.service.memoryWriteFromBot(sessionId, { scope: 'project', topic: survivor.topic, content: '现场覆盖' })
    assert.equal(overwritten, true, '锁定期内同名覆盖写应成功')
    assert.throws(() => create('新增二次'), /锁定期/, '62 条时新增仍拒')
    t.archive('project', t.project.id, 1)
    assert.equal(t.service.memoryActiveCount('project', t.project.id), 61)
    assert.throws(
      () => create('新增三次'),
      (error: any) => {
        const message = String(error.message)
        assert.ok(message.includes('此前触顶'), `文案应说明此前触顶：${message}`)
        assert.ok(message.includes('锁定期'), `文案应说明整理锁定期：${message}`)
        assert.ok(message.includes('当前 61 条'), `文案应如实报当前条数：${message}`)
        assert.doesNotMatch(message, /已达 61\/64/, '不得谎称已达 61/64 上限')
        return true
      },
    )
  } finally {
    await t.close()
  }
})

test('s) logger %s 插值：warn("%s", x) 完成插值并保留 [dsh-team] 前缀', () => {
  const original = console.warn
  let captured = ''
  console.warn = (...parts: unknown[]) => { captured += parts.join(' ') + '\n' }
  try {
    const logger = createLogger()
    logger.warn('记忆审查写入失败：%s', '项目记忆已触顶')
    logger.warn('a %s b %s', 'x', 'y')
    logger.warn('无占位符的普通日志')
    assert.ok(captured.includes('[dsh-team]'), `应保留前缀：${captured}`)
    assert.ok(captured.includes('记忆审查写入失败：项目记忆已触顶'), `%s 应完成插值：${captured}`)
    assert.ok(!captured.includes('%s'), `不应残留字面 %s：${captured}`)
    assert.ok(captured.includes('a x b y'), `多占位符应全部插值：${captured}`)
    assert.ok(captured.includes('[dsh-team] 无占位符的普通日志'), `无占位符日志不受影响：${captured}`)
  } finally {
    console.warn = original
  }
})
