// tests/memory-cleanup-bulk.test.ts —— DSHBOTS-344 守门：team_memory_cleanup 的 before 批量判据。
// ① 切割线两侧恰好分流（严格早于才归档，等于/晚于保留），作用域不越界；
// ② memory.cleanup 审计清单数正确、逐条 memory_events 留痕；
// ③ before 缺省（且无 topics/task）被拒、非法时间戳被拒；
// ④ before 与 topics 组合按 AND 交集收窄。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-cleanup-bulk-'))
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
  const projectView = await service.createProject({ name: 'Mem', key: 'MEM', ownerBotId: director.id, memberIds: [] })
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const ownerSession = 'sess_owner'
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES (?, ?, ?, 'project', NULL, ?)`,
    ownerSession, director.id, project.id, new Date().toISOString(),
  )
  const actor = { type: 'user' as const, id: service.localUserId }
  // updated_at 由 createMemory 置为当前时间；需要旧条目的场景直接改库回填。
  const seed = (scopeType: string, scopeId: string, topic: string, updatedAt?: string) => {
    const memory = service.createMemory({ scopeType, scopeId, topic, content: `${topic} 内容`, actor })
    if (updatedAt) store.run('UPDATE memories SET updated_at = ? WHERE id = ?', updatedAt, memory.id)
    return memory
  }
  const statusOf = (id: string) => store.get('SELECT status FROM memories WHERE id = ?', id).status
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, director, project, ownerSession, actor, seed, statusOf, close }
}

test('① before 切割线两侧恰好分流：严格早于归档，等于与晚于保留', async () => {
  const t = await setup()
  try {
    const cutoff = '2026-01-01T00:00:00.000Z'
    const oldA = t.seed('project', t.project.id, '旧条目一', '2025-12-31T23:59:59.999Z')
    const oldB = t.seed('project', t.project.id, '旧条目二', '2025-06-01T12:00:00.000Z')
    const edge = t.seed('project', t.project.id, '切割线等值条目', cutoff)
    const fresh = t.seed('project', t.project.id, '新条目', '2026-02-01T00:00:00.000Z')
    const botOld = t.seed('bot', t.director.id, 'bot 域旧条目', '2025-01-01T00:00:00.000Z')

    const result = t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project', before: cutoff })
    assert.equal(result.archived, 2)
    assert.deepEqual(result.cleaned.map(item => item.topic).sort(), ['旧条目一', '旧条目二'])
    assert.equal(t.statusOf(oldA.id), 'archived')
    assert.equal(t.statusOf(oldB.id), 'archived')
    assert.equal(t.statusOf(edge.id), 'active', '恰好等于切割线的条目不得归档')
    assert.equal(t.statusOf(fresh.id), 'active', '晚于切割线的条目不得归档')
    assert.equal(t.statusOf(botOld.id), 'active', 'before 只作用于指定作用域')
    assert.deepEqual(result.missed, [], 'before 单独成判据时无 missed 主题')
  } finally {
    await t.close()
  }
})

test('② memory.cleanup 审计清单数与逐条 memory_events 留痕一致', async () => {
  const t = await setup()
  try {
    const cutoff = '2026-01-01T00:00:00.000Z'
    t.seed('project', t.project.id, '旧一', '2025-01-01T00:00:00.000Z')
    t.seed('project', t.project.id, '旧二', '2025-02-01T00:00:00.000Z')
    t.seed('project', t.project.id, '旧三', '2025-03-01T00:00:00.000Z')
    const result = t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project', before: cutoff })
    assert.equal(result.archived, 3)

    const auditRow = t.store.get("SELECT * FROM audit_log WHERE action = 'memory.cleanup'")
    assert.ok(auditRow, '应有一笔 memory.cleanup 审计')
    const data = JSON.parse(auditRow.data_json)
    assert.equal(data.before, cutoff, '审计应记录 before 判据')
    assert.equal(data.cleaned.length, result.archived, '审计清单数应与归档数一致')
    assert.deepEqual(
      new Set(data.cleaned.map((item: { topic: string }) => item.topic)),
      new Set(['旧一', '旧二', '旧三']),
    )
    for (const item of result.cleaned) {
      assert.ok(
        t.store.get('SELECT id FROM memory_events WHERE memory_id = ? AND action = ?', item.id, 'archived'),
        `${item.topic} 应有 archived 事件`,
      )
    }
  } finally {
    await t.close()
  }
})

test('③ before 缺省且无 topics/task 被拒；非法 before 被拒', async () => {
  const t = await setup()
  try {
    assert.throws(
      () => t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project' }),
      /至少一项/,
      '三判据全缺应拒绝（不做全清缺省）',
    )
    assert.throws(
      () => t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project', before: 'not-a-date' }),
      /ISO/,
      '非法时间戳应拒绝',
    )
    assert.throws(
      () => t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project', before: '' }),
      /ISO/,
      '显式空 before 应拒绝',
    )
    assert.equal(
      t.store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'memory.cleanup'").n,
      0,
      '被拒不得留审计',
    )
  } finally {
    await t.close()
  }
})

test('④ before 与 topics 组合按 AND 交集：只清点名的旧条目', async () => {
  const t = await setup()
  try {
    const cutoff = '2026-01-01T00:00:00.000Z'
    const oldNamed = t.seed('project', t.project.id, '旧口径', '2025-05-01T00:00:00.000Z')
    const freshNamed = t.seed('project', t.project.id, '旧口径', '2026-03-01T00:00:00.000Z')
    const oldOther = t.seed('project', t.project.id, '别的旧主题', '2025-05-01T00:00:00.000Z')

    const combined = t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project', topics: ['旧口径'], before: cutoff })
    assert.equal(combined.archived, 1, '组合判据只清点名的旧条目')
    assert.equal(combined.cleaned[0].topic, '旧口径')
    assert.equal(t.statusOf(oldNamed.id), 'archived')
    assert.equal(t.statusOf(freshNamed.id), 'active', '同名但新于切割线的条目保留')
    assert.equal(t.statusOf(oldOther.id), 'active', '旧但未点名的条目保留')

    // topics 单独仍按原语义全清（不受 before 缺省影响）。
    const topicsOnly = t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project', topics: ['旧口径'] })
    assert.equal(topicsOnly.archived, 1)
    assert.equal(t.statusOf(freshNamed.id), 'archived')
  } finally {
    await t.close()
  }
})
