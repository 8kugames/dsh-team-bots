// tests/read-audit-dedup.test.js —— DSHBOTS-96 P1-2：只读审计告警围栏化 + 同指纹跨运行去重
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { nowIso } from '../src/util.js'

class ManualRuntime { declare handler: (...args: unknown[]) => unknown;
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-x' }
  async steer() { return true }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-dedup-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const project = await service.createProject({ name: 'Dedup', key: 'DDP', ownerBotId: director.id, memberIds: [dev.id] })
  const dir = join(workspace, project.slug)
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' })
  const projectRow = store.get('SELECT * FROM projects WHERE id = ?', project.id)
  const insertRun = (id, extra: { write_scopes?: unknown } = {}) => {
    // 争用口径 A（DSHBOTS-289）：同 bot 同时至多一条 queued/running——播种前先把该
    // bot 的既有运行置终态，跨运行去重用例按「前一条完结后再跑下一条」排队。
    store.run(
      "UPDATE runs SET status = 'succeeded', ended_at = ? WHERE bot_id = ? AND status IN ('queued', 'running')",
      nowIso(), dev.id,
    )
    store.run(
      `INSERT INTO runs (id, project_id, bot_id, kind, mode, trigger_type, idempotency_key, queued_at, started_at, write_scopes)
       VALUES (?, ?, ?, 'chat', 'read', 'manual', ?, ?, ?, ?)`,
      id, project.id, dev.id, `key-${id}`, nowIso(), nowIso(), extra.write_scopes ?? null,
    )
    return { id, project_id: project.id, bot_id: dev.id, task_id: null, kind: 'chat', mode: 'read', started_at: nowIso(), ended_at: null, ...extra }
  }
  const alerts = () => store.all(
    "SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '%只读运行%'",
    project.id,
  )
  return {
    root, store, service, project, projectRow, dir, insertRun, alerts,
    close: async () => {
      try { store.close() } catch {}
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('围栏化：正文一句话 + porcelain 进 ``` 围栏并截断 400，保留只读运行与运行号', async () => {
  const t = await setup()
  try {
    const run = t.insertRun('run_fence')
    t.service.fingerprints.set(run.id, '')
    // 40 个未跟踪文件让 porcelain 超过 400 字符，验证截断
    for (let i = 0; i < 40; i++) await writeFile(join(t.dir, `file${String(i).padStart(2, '0')}.txt`), 'x\n')
    t.service.auditReadRunWrites(run, t.projectRow)
    const [alert] = t.alerts()
    assert.ok(alert, '未归因的只读变化应告警')
    assert.ok(alert.body.startsWith('⚠️ 工作区在只读运行（chat，运行 run_fence）期间被修改'), '正文一句话含运行号')
    assert.ok(alert.body.includes('\n```\n'), 'porcelain dump 应进围栏')
    assert.ok(alert.body.endsWith('```\n若此变更应由任务产出，请立卡跟进。'), '围栏闭合 + 一句跟进提示收尾')
    const after = t.service.workspaceFingerprint(t.projectRow)
    assert.ok(after.length > 400, '测试前置：porcelain 超过 400 字符')
    assert.ok(alert.body.includes(after.slice(0, 400)), '围栏内容为 after 前 400 字符')
    assert.ok(!alert.body.includes(after.slice(0, 401)), '超出 400 的部分被截断')
  } finally { await t.close() }
})

test('同指纹跨运行去重：第二次不再插群消息，只留 run_event', async () => {
  const t = await setup()
  try {
    const runA = t.insertRun('run_first')
    t.service.fingerprints.set(runA.id, '')
    await writeFile(join(t.dir, 'same.txt'), 'first\n')
    t.service.auditReadRunWrites(runA, t.projectRow)
    assert.equal(t.alerts().length, 1, '首次未归因变化应告警')
    const runB = t.insertRun('run_second')
    t.service.fingerprints.set(runB.id, '')
    // 工作区状态不变：同 before('') → 同 after 字符串 → 同指纹
    t.service.auditReadRunWrites(runB, t.projectRow)
    assert.equal(t.alerts().length, 1, '同指纹不重复点名')
    const dupEvent = t.store.get("SELECT * FROM run_events WHERE run_id = 'run_second' AND type = 'read_audit_dup'")
    assert.ok(dupEvent, '重复应记 read_audit_dup 事件')
  } finally { await t.close() }
})

test('不同指纹不去重；嫌疑并发写运行号进围栏告警正文', async () => {
  const t = await setup()
  try {
    const runA = t.insertRun('run_one')
    t.service.fingerprints.set(runA.id, '')
    await writeFile(join(t.dir, 'a.txt'), 'a\n')
    t.service.auditReadRunWrites(runA, t.projectRow)
    // 场外造一条在跑的并发写运行（声明 src/ 范围），再在范围外弄脏
    // 播种 bot 须确定性选取（LIMIT 1 无 ORDER BY 时行序未定义，选中在途运行的 Builder 会撞 one_active_run_per_bot）
    t.store.run(
      `INSERT INTO runs (id, project_id, bot_id, kind, mode, trigger_type, idempotency_key, queued_at, started_at, write_scopes)
       VALUES ('run_writer', ?, ?, 'task', 'write', 'manual', 'key-writer', ?, ?, ?)`,
      t.projectRow.id, t.store.get("SELECT id FROM bots WHERE name = 'director'").id, nowIso(), nowIso(), JSON.stringify(['src']),
    )
    const runB = t.insertRun('run_two')
    t.service.fingerprints.set(runB.id, '')
    await mkdir(join(t.dir, 'docs'), { recursive: true })
    await writeFile(join(t.dir, 'docs', 'out.txt'), 'outside\n')
    t.service.auditReadRunWrites(runB, t.projectRow)
    const alerts = t.alerts()
    assert.equal(alerts.length, 2, '工作区状态变化（新指纹）应再次告警')
    const second = alerts.find(a => a.body.includes('run_two'))
    assert.ok(second, '第二条告警对应 run_two')
    assert.ok(second.body.includes('存在并发写运行 run_writer'), '嫌疑并发写运行号进正文')
    assert.ok(second.body.includes('\n```\n'), '嫌疑版告警同样围栏化')
  } finally { await t.close() }
})
