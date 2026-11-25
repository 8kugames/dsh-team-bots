// 会话中心目录的规模上限：只列最近 50 个会话（运行中的会话恒保留）。
// 口径：目录条目按「最近活动时间」（最近一次运行的结束/开始时间，无运行则用绑定创建时间）
// 倒序取；运行中的会话不参与裁剪（正在跑的会话最该被看见），其余补齐到 50。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { setupTeam } from './helpers/harness.js'

const LIMIT = 50

test('sessionCatalog：只列最近 50 个会话，运行中的会话恒保留', async () => {
  const team = await setupTeam({ prefix: 'dsh-session-catalog-limit-', schedulerIntervalMs: 20 })
  const { root, store, service } = team
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const worker = await service.createBot({ name: 'Worker', role: '开发', instructions: 'Build.' })
    const project = await service.createProject({
      name: 'Catalog Project', key: 'CAT', ownerBotId: director.id, memberIds: [worker.id],
    })
    const task = await service.createTask({ projectId: project.id, title: '目录上限', assigneeBotId: worker.id })

    const base = Date.parse('2026-01-01T00:00:00.000Z')
    const iso = (index: number) => new Date(base + index * 60_000).toISOString()
    // 60 个绑定会话：sess-000 最老，sess-059 最新。
    for (let i = 0; i < 60; i++) {
      store.run(
        'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias) VALUES (?, ?, ?, ?, ?, ?, 0)',
        `sess-${String(i).padStart(3, '0')}`, worker.id, project.id, 'task', task.id, iso(i),
      )
    }
    // 最老的那个正在跑：裁剪时也必须留下。
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, session_id, queued_at, started_at)
       VALUES (?, ?, ?, 'task', 'manual', 'running', ?, ?, ?, ?)`,
      'run-live', project.id, worker.id, 'idem-live', 'sess-000', iso(0), iso(0),
    )

    const catalog = service.sessionCatalog(null)
    assert.equal(catalog.total, 60, '总数报全量（供前端说明「最近 N / 共 M」）')
    assert.equal(catalog.sessions.length, LIMIT, `目录只回最近 ${LIMIT} 个`)

    const ids = catalog.sessions.map(row => row.sessionId)
    assert.ok(ids.includes('sess-000'), '运行中的会话恒保留')
    assert.ok(ids.includes('sess-059'), '最新的会话在列')
    assert.equal(ids.includes('sess-001'), false, '最老的空闲会话被裁掉')

    // 运行中的会话排在最前（前端也按 running 排，这里钉住服务端顺序）。
    assert.equal(catalog.sessions[0].sessionId, 'sess-000')
    // 裁剪掉的正好是最老的 10 个空闲会话（运行中的那个占了 1 个名额）。
    assert.equal(ids.includes('sess-011'), true, '第 12 个（sess-011）仍在最近 50 个里')
    assert.equal(ids.includes('sess-010'), false, 'sess-010 被裁掉')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
