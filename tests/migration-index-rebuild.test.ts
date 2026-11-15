// 回归（生产 0.3.51 启动崩溃）：runMigrations 的 exemptTaskRunsFromBotSerialization 无
// 账本闸、每次开库 DROP+重建，中间谓词（仅豁免 task）比最终治理豁免谓词窄——库内存在
// 最终态合法共存（review:running + rollover_summary:queued 同域）时 CREATE UNIQUE INDEX
// 撞 one_active_run_per_bot，宿主启动崩溃且 DROP 已执行（索引缺失）→每次启动都崩。
// 修复：重建谓词收敛到最终口径 + CREATE 前按最终谓词收口重复活跃运行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'

test('库内治理共存/重复活跃运行时开库迁移不再撞唯一索引', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mig-rebuild-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const dbPath = join(root, 'team.sqlite')

  // 第一次开库：建好 schema，塞入生产同款脏数据后关库。
  {
    const db = openDatabase(dbPath)
    // 先拆掉索引模拟生产现场：索引缺失（上次崩溃时 DROP 已执行）+ 域内治理共存与重复活跃行。
    db.exec('DROP INDEX IF EXISTS one_active_run_per_bot')
    db.exec(`
      INSERT INTO bots(id, name, provider, model, created_at, updated_at) VALUES ('b1', 'boss', 'fake', 'm', '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z');
      INSERT INTO projects(id, key, slug, name, owner_bot_id, created_at, updated_at) VALUES ('p1', 'ZZ', 'zz', '脏数据', 'b1', '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z');
      INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at, started_at)
      VALUES
        ('r_review', 'p1', 'b1', 'review', 'read', 'review_requested', 't1', 'running', 1, 'k1', '2026-11-15T10:00:00Z', '2026-11-15T10:00:01Z'),
        ('r_rover', 'p1', 'b1', 'rollover_summary', 'read', 'governance', 'r_review', 'queued', 1, 'k2', '2026-11-15T10:00:02Z', NULL),
        ('r_dup', 'p1', 'b1', 'chat', 'read', 'mention', 'm1', 'running', 1, 'k3', '2026-11-15T09:00:00Z', '2026-11-15T09:00:01Z');
    `)
    db.close()
  }

  // 第二次开库 = 复现生产崩溃点（runMigrations 在 openDatabase 内执行）。
  const db = openDatabase(dbPath)
  const index = db.get("SELECT sql FROM sqlite_master WHERE name = 'one_active_run_per_bot'")
  assert.ok(index, '索引已重建存在')
  assert.match(String(index.sql), /rollover_summary/, '索引谓词为最终治理豁免口径')
  // 重复活跃运行被收口：chat 与 review 同域只留最早（chat 09:00 更早）；治理运行豁免不受影响。
  const statuses = db.all("SELECT id, status FROM runs WHERE id IN ('r_review','r_rover','r_dup')")
  const byId = Object.fromEntries(statuses.map((r: any) => [r.id, r.status]))
  assert.equal(byId.r_dup, 'running', '最早的 chat 保留')
  assert.equal(byId.r_review, 'canceled', '同域较晚的重复运行被收口')
  assert.equal(byId.r_rover, 'queued', '治理豁免运行不被收口')
  db.close()

  // 第三次开库：稳态数据（无重复）下重复迁移幂等，不误杀。
  const db3 = openDatabase(dbPath)
  const kept = db3.get("SELECT status FROM runs WHERE id = 'r_dup'")
  assert.equal((kept as any).status, 'running', '稳态重开不误杀活跃运行')
  db3.close()
})
