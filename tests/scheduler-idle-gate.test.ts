// tests/scheduler-idle-gate.test.js —— 空载门（tickIdleGate）护栏。
// ① 门只属于周期定时器：距上次全量拍不足 schedulerIdleIntervalMs 且探针无工作（无
//    queued/running 运行、无可领 outbox）时本拍直接返回，不进全量；
// ② 探针见工作即放行全量：queued/running 运行、到点 pending outbox 都算工作；
//    未到点的 pending outbox（退避/defer 等待中）不算，不惊醒全量拍；
// ③ 事件唤醒语义钉住：core.start 的 setInterval 挂 tickIdleGate（直调 tick 永远全量）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-idle-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  await service.initialize()
  service.started = true
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, close }
}

// 门的行为单测：stub 掉 tick（真实 tick 的行为由既有调度套件覆盖），只验门本身的放行/拦截。
function stubTick(service) {
  let fullPasses = 0
  service.tick = async () => { fullPasses += 1; service.lastFullTickAt = Date.now() }
  return () => fullPasses
}

test('空载拦截：窗口内无 queued/running 运行且无可领 outbox，本拍不进全量', async () => {
  const t = await setup()
  try {
    const passes = stubTick(t.service)
    t.service.lastFullTickAt = Date.now()
    const result = t.service.tickIdleGate()
    assert.equal(result, null, '拦截时返回 null')
    assert.equal(passes(), 0, '未进全量拍')
  } finally { await t.close() }
})

test('窗口外必全量：lastFullTickAt 归零后首拍不受门限制', async () => {
  const t = await setup()
  try {
    const passes = stubTick(t.service)
    t.service.lastFullTickAt = 0
    await t.service.tickIdleGate()
    assert.equal(passes(), 1, '窗口外放行全量')
  } finally { await t.close() }
})

test('探针见 queued/running 运行即放行', async () => {
  const t = await setup()
  try {
    const passes = stubTick(t.service)
    t.service.lastFullTickAt = Date.now()
    const bot = t.store.get("SELECT * FROM bots WHERE name = 'director'")
    t.store.run(
      `INSERT INTO runs(id, bot_id, kind, status, trigger_type, idempotency_key, queued_at)
       VALUES (?, ?, 'solo_chat', 'queued', 'mention', ?, ?)`,
      'run_gate_probe', bot.id, 'idle-gate:probe', new Date().toISOString(),
    )
    await t.service.tickIdleGate()
    assert.equal(passes(), 1, '有排队运行，窗口内也放行')
  } finally { await t.close() }
})

test('到点 pending outbox 放行、未到点不惊醒', async () => {
  const t = await setup()
  try {
    const past = new Date(Date.now() - 1000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    const insert = (idValue, availableAt) => t.store.run(
      `INSERT INTO outbox(id, kind, status, available_at, created_at) VALUES (?, 'task_run', 'pending', ?, ?)`,
      idValue, availableAt, new Date().toISOString(),
    )
    const passes = stubTick(t.service)
    t.service.lastFullTickAt = Date.now()
    insert('ob_gate_future', future)
    t.service.tickIdleGate()
    assert.equal(passes(), 0, '未到点的退避/deferred 行不算工作')
    insert('ob_gate_ready', past)
    await t.service.tickIdleGate()
    assert.equal(passes(), 1, '到点 pending 行放行全量')
  } finally { await t.close() }
})

test('接线钉住：周期定时器挂 tickIdleGate，事件唤醒保持直调 tick', async () => {
  const core = readFileSync(new URL('../src/services/core.ts', import.meta.url), 'utf8')
  assert.match(core, /setInterval\(\(\) => void this\.tickIdleGate\(\), this\.config\.schedulerIntervalMs\)/,
    '周期拍必须走空载门')
})
