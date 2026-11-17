// 快照装配性能回归守门（切项目 / 轮询共用的全量 state 组装）：
// 生产库实测两处把 state() 拖到数秒——①零用量分档用 JOIN runs 逐组合跑相关子查询，
// 行数按「窗口内运行数 × bot」放大；②每个分档分组各扫一遍全窗口明细做成本 breakdown。
// 这里钉住修法不退回：零用量走 EXISTS、breakdown 一次预取按维度归并。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { openDatabase } from '../src/db.js'
import { recordUsage, usageSnapshot, clearUsageSnapshotCache } from '../src/usage.js'

const source = readFileSync(fileURLToPath(new URL('../src/usage.ts', import.meta.url)), 'utf8')

function fnBody(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `缺少函数 ${name}`)
  return source.slice(start, source.indexOf('\n}', start))
}

test('零用量分档用 EXISTS 逐 bot 判定，不回退成 JOIN runs 的逐组合放大', () => {
  const body = fnBody('zeroUsageBotRows')
  assert.match(body, /EXISTS\s*\(/, '应以 EXISTS 表达「窗口内跑过」')
  assert.doesNotMatch(body, /JOIN\s+runs\s+/i, '不得再 JOIN runs（窗口内运行数 × bot 会放大行数）')
})

test('成本 breakdown 按维度一次预取，不再逐分组扫全窗口', () => {
  assert.match(source, /function breakdownByDimension\(/, '缺少分维度预取实现')
  for (const tier of ['byBotRows', 'byProjectRows', 'byModelRows', 'byDayRows']) {
    const body = fnBody(tier)
    assert.match(body, /breakdownByDimension\(/, `${tier} 应复用预取结果`)
    assert.doesNotMatch(body, /costBreakdown\(store/, `${tier} 不得在分组循环里逐组调 costBreakdown`)
  }
})

// 行为侧：改写不得改变口径——跑过但零用量的 bot 仍要出现在项目分档里（零值行）。
test('项目分档仍补齐「跑过但零用量」的 bot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-perf-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  try {
    const now = new Date().toISOString()
    const iso = new Date(Date.now() - 60_000).toISOString()
    store.run(
      `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, created_at, updated_at)
       VALUES ('b1','Busy','dev','','blue','active',0,?,?), ('b2','Idle','dev','','teal','active',0,?,?)`,
      now, now, now, now,
    )
    store.run(
      `INSERT INTO projects(id, key, name, slug, owner_bot_id, status, created_at, updated_at)
       VALUES ('p1','P1','Alpha','alpha','b1','active',?,?)`, now, now,
    )
    // b1 有明细；b2 只有 run、没有明细——必须作为零用量行出现。
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key,
          queued_at, started_at, ended_at, usage_input, usage_output)
       VALUES ('r1','p1','b1','task','write','manual','succeeded',1,'k1',?,?,?,?,?), ('r2','p1','b2','task','write','manual','succeeded',1,'k2',?,?,?,?,?)`,
      iso, iso, iso, 5, 5, iso, iso, iso, 0, 0,
    )
    recordUsage(store, {
      sourceKey: 'u:r1',
      run: { id: 'r1', project_id: 'p1', bot_id: 'b1' },
      provider: 'fake', model: 'model-a',
      usage: { inputTokens: 100, outputTokens: 10 },
      occurredAt: iso,
    })
    clearUsageSnapshotCache()
    const snap = usageSnapshot(store, 'p1', 30, { currency: 'USD', window: '30d', cacheTtlMs: 0 })
    const byBot = snap.scopeTiers.project.byBot
    const idle = byBot.find(row => row.botId === 'b2')
    assert.ok(idle, '零用量 bot 必须出现在项目分档')
    assert.equal(idle.name, 'Idle')
    assert.equal(idle.calls, 0, '零用量行的调用数为 0')
    assert.equal(idle.costConfigured, false, '零用量行不带计价标记')
  } finally {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
})