import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { installHttp } from '../src/http.js'
import { id, nowIso } from '../src/util.js'

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.email=team@test', '-c', 'user.name=team', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  await service.initialize()
  service.started = true
  return { root, workspace, dataDir, config, store, service }
}

function insertRun(store, { projectId, botId, mode = 'write', kind = 'task' }) {
  const runId = id('run')
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, idempotency_key, queued_at, started_at)
     VALUES (?, ?, ?, ?, ?, 'manual', 'running', ?, ?, ?)`,
    runId, projectId, botId, kind, mode, `test:${runId}:${randomUUID()}`, nowIso(), nowIso(),
  )
  return runId
}

function fakeHttp(service) {
  const routes = new Map()
  const ctx = {
    connection: { fetch: { register: (spec) => { routes.set(spec.path, spec); return () => routes.delete(spec.path) } } },
    webServer: { register: () => () => {} },
    effect: () => {},
  }
  installHttp(ctx, service, { info() {}, error() {} })
  return (pathWithQuery) => {
    const path = pathWithQuery.split('?')[0]
    const spec = routes.get(path)
    if (!spec) throw new Error(`没有注册路由 ${path}`)
    return spec.fetch(new Request(`http://localhost${pathWithQuery}`))
  }
}

async function closeQuietly(store) {
  try { store.close() } catch {}
}

test('迁移：旧库与新建库的 runs 表都有 artifacts 列', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-migrate-'))
  const file = join(root, 'team.sqlite')
  try {
    const legacy = new DatabaseSync(file)
    // HEAD 之前的 runs 结构（无 artifacts 列）。
    legacy.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      task_id TEXT,
      parent_run_id TEXT,
      kind TEXT NOT NULL DEFAULT 'chat',
      mode TEXT NOT NULL DEFAULT 'write',
      trigger_type TEXT NOT NULL,
      trigger_ref TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT NOT NULL UNIQUE,
      session_id TEXT,
      error_code TEXT,
      error_message TEXT,
      output TEXT,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      last_progress_at TEXT,
      usage_input INTEGER NOT NULL DEFAULT 0,
      usage_cache_read INTEGER NOT NULL DEFAULT 0,
      usage_cache_write INTEGER NOT NULL DEFAULT 0,
      usage_output INTEGER NOT NULL DEFAULT 0,
      usage_cost REAL,
      cancel_requested INTEGER NOT NULL DEFAULT 0
    )`)
    legacy.prepare("INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, queued_at) VALUES ('r1', 'p1', 'b1', 'chat', 'manual', 'succeeded', 'k1', '2026-01-01')").run()
    legacy.close()

    const store = openDatabase(file)
    try {
      const columns = store.all('PRAGMA table_info(runs)').map(column => column.name)
      assert.ok(columns.includes('artifacts'), '旧库迁移后 runs.artifacts 应存在')
      const row = store.get('SELECT * FROM runs WHERE id = ?', 'r1')
      assert.equal(row.status, 'succeeded')
      assert.equal(row.artifacts, null)
    } finally {
      store.close()
    }

    const fresh = openDatabase(join(root, 'fresh.sqlite'))
    try {
      assert.ok(fresh.all('PRAGMA table_info(runs)').map(column => column.name).includes('artifacts'))
    } finally {
      fresh.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('成功的写运行在 git 项目里记录产物清单，只读运行不记录', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
    const project = await service.createProject({ name: 'Artifacts', key: 'ART', ownerBotId: chief.id })
    const dir = join(workspace, project.slug)
    git(dir, 'init', '-q')
    await writeFile(join(dir, 'README.md'), 'base\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'init')

    await writeFile(join(dir, 'README.md'), 'changed\n')
    await mkdir(join(dir, '交付'))
    await writeFile(join(dir, '交付', '产物图.png'), 'PNGDATA')
    await writeFile(join(dir, 'notes.md'), 'new note\n')
    await writeFile(join(dir, 'gone.txt'), 'temp')
    git(dir, 'add', 'gone.txt')
    git(dir, 'commit', '-q', '-m', 'add gone')
    await rm(join(dir, 'gone.txt'))

    const writeRunId = insertRun(store, { projectId: project.id, botId: chief.id })
    await service.finishRun({ runId: writeRunId, status: 'succeeded', output: 'done' })
    const writeRun = store.get('SELECT * FROM runs WHERE id = ?', writeRunId)
    const list = JSON.parse(writeRun.artifacts)
    const paths = list.map(item => item.path)
    assert.ok(paths.includes('README.md'), '修改的文件应记录为 M')
    assert.equal(list.find(item => item.path === 'README.md').status, 'M')
    assert.ok(paths.includes('交付/产物图.png'), '中文路径的未跟踪文件应记录为 ??')
    assert.equal(list.find(item => item.path === '交付/产物图.png').status, '??')
    assert.ok(paths.includes('notes.md'))
    assert.ok(!paths.includes('gone.txt'), '删除的文件不进产物清单')

    const readRunId = insertRun(store, { projectId: project.id, botId: chief.id, mode: 'read', kind: 'review' })
    await service.finishRun({ runId: readRunId, status: 'succeeded', output: 'ok' })
    assert.equal(store.get('SELECT artifacts FROM runs WHERE id = ?', readRunId).artifacts, null)

    const view = service.listRunArtifacts(writeRunId)
    assert.ok(Array.isArray(view.artifacts))
    assert.ok(view.artifacts.some(item => item.path === 'README.md'))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('非 git 项目跳过产物记录并写入 run_event', async () => {
  const { root, store, service } = await setup()
  try {
    const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
    const project = await service.createProject({ name: 'No Git', key: 'NOGIT', ownerBotId: chief.id })
    const runId = insertRun(store, { projectId: project.id, botId: chief.id })
    await service.finishRun({ runId, status: 'succeeded', output: 'done' })
    assert.equal(store.get('SELECT artifacts FROM runs WHERE id = ?', runId).artifacts, null)
    const events = store.all('SELECT * FROM run_events WHERE run_id = ? AND type = ?', runId, 'artifacts_skipped')
    assert.equal(events.length, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('产物 HTTP 端点：清单、文件类型、越界与限额', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
    const project = await service.createProject({ name: 'HTTP', key: 'HTTPX', ownerBotId: chief.id })
    const dir = join(workspace, project.slug)
    git(dir, 'init', '-q')
    await writeFile(join(dir, 'README.md'), 'base\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'init')
    await writeFile(join(dir, 'shot.png'), 'PNGDATA')
    await writeFile(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    await writeFile(join(dir, 'notes.md'), '说明\n')
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1, 7))

    const runId = insertRun(store, { projectId: project.id, botId: chief.id })
    await service.finishRun({ runId, status: 'succeeded', output: 'done' })
    const fetchRoute = fakeHttp(service)

    const listRes = await fetchRoute(`/api/dsh-team/artifacts?runId=${runId}`)
    assert.equal(listRes.status, 200)
    const listBody = await listRes.json()
    assert.ok(listBody.ok)
    assert.ok(listBody.data.artifacts.some(item => item.path === 'shot.png'))

    const pngRes = await fetchRoute(`/api/dsh-team/artifact-file?runId=${runId}&path=${encodeURIComponent('shot.png')}`)
    assert.equal(pngRes.status, 200)
    assert.equal(pngRes.headers.get('content-type'), 'image/png')
    assert.equal(await pngRes.text(), 'PNGDATA')
    assert.equal(pngRes.headers.get('content-disposition'), null)

    const mdRes = await fetchRoute(`/api/dsh-team/artifact-file?runId=${runId}&path=${encodeURIComponent('notes.md')}`)
    assert.equal(mdRes.status, 200)
    assert.equal(mdRes.headers.get('content-type'), 'text/plain; charset=utf-8')

    const svgRes = await fetchRoute(`/api/dsh-team/artifact-file?runId=${runId}&path=${encodeURIComponent('icon.svg')}`)
    assert.equal(svgRes.status, 200)
    assert.match(svgRes.headers.get('content-disposition') ?? '', /^attachment;/)

    const bigRes = await fetchRoute(`/api/dsh-team/artifact-file?runId=${runId}&path=${encodeURIComponent('big.bin')}`)
    assert.equal(bigRes.status, 413)

    const missingRes = await fetchRoute(`/api/dsh-team/artifact-file?runId=${runId}&path=${encodeURIComponent('not-listed.txt')}`)
    assert.equal(missingRes.status, 403)

    const escapeRes = await fetchRoute(`/api/dsh-team/artifact-file?runId=${runId}&path=${encodeURIComponent('../../README.md')}`)
    assert.equal(escapeRes.status, 403)

    const unknownRunRes = await fetchRoute('/api/dsh-team/artifact-file?runId=run_missing&path=shot.png')
    assert.equal(unknownRunRes.status, 404)

    const noParamRes = await fetchRoute('/api/dsh-team/artifacts')
    assert.equal(noParamRes.status, 400)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
