// 单轮上下文治理 P4：记忆快照召回降量——memoryContextFor 由宿主渲染成历史尾部的
// 用户快照、文本一变就追加一条，16 条 × 条均 ~400 字符恰好顶满旧 7k 截断，等于每次
// 记忆写入都往活跃会话追加约 3.5k token。守门：召回封顶 MEMORY_CONTEXT_LIMIT 条
// （按更新时间取最近、条内不截断）、总长封顶 MEMORY_CONTEXT_MAX_CHARS。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { DshRuntime } from '../src/runtime.js'
import { MEMORY_CONTEXT_LIMIT, MEMORY_CONTEXT_MAX_CHARS } from '../src/services/runtime/prompt.js'

test('记忆快照召回：只取最近 N 条完整条目，总量不超字符封顶', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-ctx-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0 })
  const store = openDatabase(config.dbPath)
  try {
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, solo_dir, created_at, updated_at)
       VALUES ('b1', 'Builder', '开发', 'Build.', 'blue', 'active', 0, 'builder', ?, ?)`, now, now,
    )
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES ('sess-m', 'b1', NULL, 'solo', NULL, ?)",
      now,
    )
    // 播种 LIMIT+2 条：updated_at 递增，第 i 条正文长度 ~500 字符（超条均实测值）。
    for (let i = 0; i < MEMORY_CONTEXT_LIMIT + 2; i += 1) {
      const at = new Date(Date.parse('2026-11-08T00:00:00Z') + i * 60_000).toISOString()
      store.run(
        `INSERT INTO memories(scope_type, scope_id, topic, content, status, created_by, created_at, updated_at)
         VALUES ('bot', 'b1', ?, ?, 'active', 'user:user_local', ?, ?)`,
        `记忆${i}`, `第${i}条${'x'.repeat(480)}`, at, at,
      )
    }
    const runtime = new DshRuntime({ ctx: {}, config, store, logger: { warn() {} } } as any)
    const block = runtime.memoryContextFor({ agent: { id: 'sess-m' } })
    assert.doesNotMatch(block, /第0条/, '超出召回条数的旧记忆不进快照')
    assert.match(block, new RegExp(`第${MEMORY_CONTEXT_LIMIT + 1}条`), '最近的记忆在快照内')
    assert.ok(block.length <= MEMORY_CONTEXT_MAX_CHARS + 200, `快照总量受字符封顶约束（实际 ${block.length}）`)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
