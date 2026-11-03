// tests/read-run-audit.test.js —— DSHBOTS-94：只读运行工作区审计的并发归因
// 覆盖 attributeWorkspaceChange 纯函数四个分支，以及并发写运行在场时
// auditReadRunWrites 的静默与范围不匹配告警两条集成路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { attributeWorkspaceChange, porcelainTouchedPaths } from '../src/services/runs.js'

class ManualRuntime {
  constructor() {
    this.started = []
    this.steers = []
    this.cancelled = []
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  async startRun({ run }) {
    this.started.push({ runId: run.id, botId: run.bot_id, kind: run.kind, mode: run.mode })
    return `session-${run.id}`
  }

  async steer(sessionId, text) {
    this.steers.push({ sessionId, text })
    return true
  }

  async cancelRun(runId) {
    this.cancelled.push(runId)
    return true
  }

  complete(runId, status = 'succeeded', output = 'done') {
    return this.handler({ runId, status, output, error: null })
  }
}

async function setup(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-audit-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000, ...overrides,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  return { root, workspace, config, store, service, runtime, director, dev }
}

async function closeQuietly(store) {
  try {
    store.close()
  } catch {}
}

test('porcelainTouchedPaths：普通行取路径，重命名新旧两侧都算触碰', () => {
  const paths = porcelainTouchedPaths(' M src/a.js\n?? docs/note.txt\nR  src/old.js -> src/new.js')
  assert.deepEqual([...paths].sort(), ['docs/note.txt', 'src/a.js', 'src/new.js', 'src/old.js'])
})

test('归因：无并发写运行 → 维持点名，suspects 为空', () => {
  const decision = attributeWorkspaceChange({ before: '', after: '?? a.txt', concurrentWrites: [] })
  assert.equal(decision.silent, false)
  assert.deepEqual(decision.suspects, [])
  assert.deepEqual(decision.unattributedPaths, ['a.txt'])
})

test('归因：并发写范围覆盖全部变化 → 静默并给出归属', () => {
  const decision = attributeWorkspaceChange({
    before: '',
    after: '?? src/a.js\n?? src/b.js',
    concurrentWrites: [{ id: 'run_w', label: 'AUD-1', scopes: ['src'] }],
  })
  assert.equal(decision.silent, true)
  assert.deepEqual(decision.attributedTo, ['AUD-1'])
})

test('归因：范围外的路径不归因 → 告警并点名嫌疑写运行', () => {
  const decision = attributeWorkspaceChange({
    before: '',
    after: '?? src/a.js\n?? docs/note.txt',
    concurrentWrites: [{ id: 'run_w', label: 'AUD-1', scopes: ['src'] }],
  })
  assert.equal(decision.silent, false)
  assert.deepEqual(decision.suspects, ['AUD-1'])
  assert.deepEqual(decision.unattributedPaths, ['docs/note.txt'])
})

test('归因：并发写运行未声明范围 → 保守视为可归因，静默', () => {
  const decision = attributeWorkspaceChange({
    before: '',
    after: '?? anywhere/x.txt',
    concurrentWrites: [{ id: 'run_w', label: 'AUD-1', scopes: [] }],
  })
  assert.equal(decision.silent, true)
  assert.deepEqual(decision.attributedTo, ['AUD-1'])
})

test('归因：状态位翻转（工作区改→暂存）与文件消失都算触碰并参与匹配', () => {
  const staged = attributeWorkspaceChange({
    before: ' M src/a.js',
    after: 'A  src/a.js',
    concurrentWrites: [{ id: 'run_w', label: 'AUD-1', scopes: ['src/a.js'] }],
  })
  assert.equal(staged.silent, true)
  const removed = attributeWorkspaceChange({
    before: ' M src/a.js',
    after: '',
    concurrentWrites: [{ id: 'run_w', label: 'AUD-1', scopes: ['src'] }],
  })
  assert.equal(removed.silent, true)
})

test('集成：并发写运行在跑时，只读运行的指纹变化不点名，改记归因事件', async () => {
  const { root, workspace, store, service, runtime, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Audit', key: 'AUD', ownerBotId: director.id, memberIds: [dev.id] })
    const dir = join(workspace, project.slug)
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' })
    await service.createTask({ projectId: project.id, title: 'Write run', assigneeBotId: dev.id, autoStart: true })
    await service.sendMessage(project.id, '随便聊聊，不要改文件')
    service.started = true
    await service.tick()
    const chatRun = store.get("SELECT * FROM runs WHERE kind = 'chat'")
    assert.ok(chatRun, '群聊运行应已领取')
    const writeRun = store.get("SELECT * FROM runs WHERE mode = 'write' AND status = 'running'")
    assert.ok(writeRun, '写运行应与只读运行并行在跑')
    // 等待 executeRun 记录指纹后，模拟并发写运行弄脏工作区
    await new Promise(resolve => setTimeout(resolve, 30))
    await writeFile(join(dir, 'main.js'), 'module.exports = 1\n')
    await runtime.complete(chatRun.id, 'succeeded', '好的')

    const alert = store.get(
      "SELECT body FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '%只读运行%'",
      project.id,
    )
    assert.equal(alert, undefined, '有并发写运行时不应点名只读运行')
    const event = store.get("SELECT * FROM run_events WHERE run_id = ? AND type = 'read_audit_attributed'", chatRun.id)
    assert.ok(event, '应留下归因 run_event')
    assert.match(event.message, /AUD-1/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('集成：并发写运行范围对不上号时仍告警，嫌疑写运行号写进消息', async () => {
  const { root, workspace, store, service, runtime, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Audit', key: 'AUD', ownerBotId: director.id, memberIds: [dev.id] })
    const dir = join(workspace, project.slug)
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' })
    await service.createTask({
      projectId: project.id, title: 'Scoped write', assigneeBotId: dev.id, writeScopes: ['src'], autoStart: true,
    })
    await service.sendMessage(project.id, '随便聊聊，不要改文件')
    service.started = true
    await service.tick()
    const chatRun = store.get("SELECT * FROM runs WHERE kind = 'chat'")
    assert.ok(chatRun, '群聊运行应已领取')
    const writeRun = store.get("SELECT * FROM runs WHERE mode = 'write' AND status = 'running'")
    assert.ok(writeRun, '写运行应与只读运行并行在跑')
    await new Promise(resolve => setTimeout(resolve, 30))
    // 脏文件落在声明范围（src/）之外，无法归因
    await writeFile(join(dir, 'note.txt'), 'outside declared scopes\n')
    await runtime.complete(chatRun.id, 'succeeded', '好的')

    const alert = store.get(
      "SELECT body FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '%只读运行%'",
      project.id,
    )
    assert.ok(alert, '范围对不上号应维持告警')
    assert.match(alert.body, /只读运行/)
    assert.match(alert.body, /AUD-1/)
    assert.match(alert.body, /note\.txt/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
