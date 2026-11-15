import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { nowIso } from '../src/util.js'

const run = promisify(execFile)

const quietLogger = { info() {}, warn() {}, error() {} }

// 手动 runtime：只满足 service 的最低要求，不真的起会话。
class ManualRuntime { declare handler: any;
  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  sessionBusy() { return false }

  async startRun({ run }) { return `session-${run.id}` }

  async steer() { return true }

  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-hardening-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: quietLogger })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const builder = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const project = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: director.id, memberIds: [builder.id] })
  const task = await service.createTask(
    { projectId: project.id, title: '做登录页', description: 'x', assigneeBotId: builder.id },
    { type: 'user', id: 'u' },
  )
  const originSession = 'sess-builder-task-1'
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES (?, ?, ?, 'task', ?, ?)`,
    originSession, builder.id, project.id, task.id, nowIso(),
  )
  return { root, store, service, config, workspace, dataDir, director, builder, project, task, originSession }
}

async function closeQuietly(store) {
  try { store.close() } catch {}
}

test('密钥指纹不匹配时拒绝启动，不静默换密钥', async () => {
  const { root, store, service, config } = await setup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' } as any)
    const keyPath = join(config.dataDir, 'secret.key')
    assert.ok(existsSync(keyPath))
    store.close()

    // 换机恢复最常见的事故：数据库在，密钥文件没了或换了。
    writeFileSync(keyPath, randomBytes(32).toString('hex'))
    const store2 = openDatabase(config.dbPath)
    const service2 = new TeamService({ store: store2, config, logger: quietLogger })
    await assert.rejects(
      () => service2.initialize(),
      (error: any) => error?.code === 'SECRET_KEY_MISMATCH',
    )
    closeQuietly(store2)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('密钥缺失时不新建空密钥，已有密文解不开就报错', async () => {
  const { root, store, service, config } = await setup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' } as any)
    store.close()
    rmSync(join(config.dataDir, 'secret.key'), { force: true })

    const store2 = openDatabase(config.dbPath)
    const service2 = new TeamService({ store: store2, config, logger: quietLogger })
    await assert.rejects(() => service2.initialize(), /密钥文件不存在/)
    closeQuietly(store2)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('环境变量提供主密钥：换一把密钥启动会被拒绝', async () => {
  const previous = process.env.DSH_TEAM_SECRET_KEY
  const key = randomBytes(32).toString('hex')
  let root = null
  let store = null
  try {
    // 环境变量里的主密钥要在建库之前就生效，首次登记的指纹才对得上。
    process.env.DSH_TEAM_SECRET_KEY = key
    const setupResult = await setup()
    root = setupResult.root
    store = setupResult.store
    const { service, config } = setupResult
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' } as any)
    store.close()

    process.env.DSH_TEAM_SECRET_KEY = randomBytes(32).toString('hex')
    const store2 = openDatabase(config.dbPath)
    const service2 = new TeamService({ store: store2, config, logger: quietLogger })
    await assert.rejects(() => service2.initialize(), (error: any) => error?.code === 'SECRET_KEY_MISMATCH')
    closeQuietly(store2)

    process.env.DSH_TEAM_SECRET_KEY = key
    const store3 = openDatabase(config.dbPath)
    const service3 = new TeamService({ store: store3, config, logger: quietLogger })
    await service3.initialize()
    assert.equal(service3.maskSecretValues('ghp_abcdefghijklmnop'), '$GITHUB_TOKEN')
    closeQuietly(store3)
  } finally {
    if (previous === undefined) delete process.env.DSH_TEAM_SECRET_KEY
    else process.env.DSH_TEAM_SECRET_KEY = previous
    await closeQuietly(store)
    if (root) await rm(root, { recursive: true, force: true })
  }
})

test('掩码失败时直接报错，不把密钥原文返回出去', async () => {
  const { root, store, service } = await setup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' } as any)
    // 密文被破坏：解密失败必须冒泡，绝不能退回「返回原文」。
    store.run("UPDATE secrets SET value_enc = 'broken-ciphertext'")
    assert.throws(() => service.maskSecretValues('ghp_abcdefghijklmnop'))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('Bot 私信落库前掩码密钥值', async () => {
  const { root, store, service, originSession } = await setup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' } as any)
    service.messageFromBot({
      sessionId: originSession,
      toName: 'director',
      requestId: 'ask-secret',
      textBody: '我的 token 是 ghp_abcdefghijklmnop 帮我看看',
    })
    const row = store.get('SELECT text FROM bot_messages WHERE request_id = ?', 'ask-secret')
    assert.equal(row.text, '我的 token 是 $GITHUB_TOKEN 帮我看看')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('私信卡住时维护流程把它补进出站队列', async () => {
  const { root, store, service, project, builder, director } = await setup()
  try {
    store.run(
      `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_session_id,
        origin_kind, origin_task_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      'msg-stuck-1', project.id, builder.id, director.id, 'stuck-1', '在吗', 'sess-x', 'task', null,
      new Date(Date.now() - 10 * 60_000).toISOString(),
    )
    assert.equal(store.get('SELECT COUNT(*) AS n FROM outbox').n, 0)

    service.runMaintenance({ force: true })

    const outbox = store.get("SELECT * FROM outbox WHERE kind = 'dm_run'")
    assert.ok(outbox, '卡住的私信应被补进 outbox')
    assert.equal(JSON.parse(outbox.payload_json).messageId, 'msg-stuck-1')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime 拿到密钥掩码钩子，轨迹落库前脱敏', async () => {
  const { root, store, service } = await setup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' } as any)
    let mask = null
    service.attachRuntime({ setCompletionHandler() {}, setMask(fn) { mask = fn } })
    assert.ok(typeof mask === 'function')
    assert.equal(mask('token ghp_abcdefghijklmnop'), 'token $GITHUB_TOKEN')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('单聊目录名冲突时既唯一又不超长', async () => {
  const { root, store, service } = await setup()
  try {
    // 两个不同名字会 slug 成同一个目录名：冲突后缀不得把目录名顶出 safeSlug 的 48 上限。
    const first = await service.createBot({ name: 'agent_alpha', role: '测试', instructions: 'x', provider: 'fake', model: 'model-a' })
    const second = await service.createBot({ name: 'agent-alpha', role: '测试', instructions: 'x', provider: 'fake', model: 'model-a' })
    assert.ok(first.soloDir && second.soloDir)
    assert.notEqual(first.soloDir, second.soloDir)
    for (const dir of [first.soloDir, second.soloDir]) {
      assert.ok(dir.length <= 48, `单聊目录名超长：${dir}`)
      assert.match(dir, /^[a-z0-9][a-z0-9-]*$/)
    }
    const rows = store.all('SELECT solo_dir FROM bots WHERE solo_dir IS NOT NULL')
    assert.equal(new Set(rows.map(row => row.solo_dir)).size, rows.length)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('同一条私信只排一次回信运行', async () => {
  const { root, store, service, project, builder, director } = await setup()
  try {
    store.run(
      `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_session_id,
        origin_kind, origin_task_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'replied', ?)`,
      'msg-dm-1', project.id, director.id, builder.id, 'dm-1', '问题', 'sess-x', 'task', null, nowIso(),
    )
    const message = store.get('SELECT * FROM bot_messages WHERE id = ?', 'msg-dm-1')
    const first = service.deliverBotReply(message)
    const second = service.deliverBotReply(message)
    assert.equal(first, second)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE kind = 'dm_reply'").n, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('记忆审查按来源与内容去重', async () => {
  const { root, store, service, project, builder } = await setup()
  try {
    const sourceRunId = 'run-source-1'
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, NULL, 'memory_review', 'read', 'memory_review', ?, 'running', 1, ?, ?)`,
      'run-review-1', project.id, builder.id, sourceRunId, 'memory_review:run-source-1', nowIso(),
    )
    const reviewRun = store.get('SELECT * FROM runs WHERE id = ?', 'run-review-1')
    const output = JSON.stringify([
      { scope: 'bot', topic: '协作偏好', content: 'Builder 回复群聊时偏好中文短句', confidence: 0.9 },
    ])
    const first = await service.completeMemoryReview(reviewRun, output, null)
    assert.equal(first.applied, 1)
    const second = await service.completeMemoryReview(reviewRun, output, null)
    assert.equal(second.applied, 0)
    assert.equal(second.deduped, 1)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM memories').n, 1)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('备份脚本连密钥主文件与微信通道库一起带走', async () => {
  const { root, store, service, config } = await setup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' } as any)
    // 微信通道库要是个真库，空文件 VACUUM INTO 会失败。
    const wechatDb = new DatabaseSync(config.wechatDbPath)
    wechatDb.exec('CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY)')
    wechatDb.close()
    store.close()

    const outDir = join(root, 'backups')
    const { stdout } = await run('node', ['scripts/backup.mjs', '--db', config.dbPath, '--out', outDir], {
      cwd: join(import.meta.dirname, '..'),
    })
    const summary = JSON.parse(stdout)
    const keyExtra = summary.extras.find(item => item.name === 'secret.key')
    assert.ok(keyExtra?.backup, '密钥主文件应被备份')
    assert.ok(existsSync(keyExtra.backup))
    const manifest = JSON.parse(readFileSync(summary.manifest, 'utf8'))
    const manifestKey = manifest.extras.find(item => item.name === 'secret.key')
    assert.ok(manifestKey?.sha256)
    const wechatExtra = summary.extras.find(item => item.name === 'wechat-channel.sqlite')
    assert.ok(wechatExtra?.backup, '微信通道库应被备份')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
