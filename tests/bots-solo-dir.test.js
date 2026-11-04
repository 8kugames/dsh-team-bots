// DSHBOTS-164：createBot 的 solo_dir 查重与 INSERT 竞态——权威候选在事务内生成、
// 唯一冲突事务内重生成 -N 后缀重试（有限次）、UNIQUE 失败转可读错误不裸抛 SQLITE。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bots-solo-dir-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {}, debug() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, workspace, store, service }
}

const dirExists = async (workspace, soloDir) => {
  const info = await lstat(join(workspace, '_the_bots', soloDir))
  return info.isDirectory()
}

// 在 bots 表 INSERT 上注入伪造的 node:sqlite 唯一约束错误（与真实错误同 message/code 形态）。
// persistent=false 只拦第一次（走重试后成功）；true 每次都拦（重试穷尽）。
const injectUniqueOnBotsInsert = (service, { persistent = false } = {}) => {
  const original = service.store.run.bind(service.store)
  let botsInsertCalls = 0
  service.store.run = (sql, ...params) => {
    if (sql.includes('INSERT INTO bots(')) {
      botsInsertCalls += 1
      if (persistent || botsInsertCalls === 1) {
        const error = new Error('UNIQUE constraint failed: bots.solo_dir')
        error.code = 'ERR_SQLITE_ERROR'
        error.errcode = 2067
        throw error
      }
    }
    return original(sql, ...params)
  }
  return () => botsInsertCalls
}

test('顺序两次同名（slug 碰撞）创建均成功且 solo_dir 不同', async () => {
  const { root, workspace, service } = await setup()
  try {
    const first = await service.createBot({ name: 'a_b' })
    const second = await service.createBot({ name: 'a-b' })
    assert.equal(first.soloDir, 'a-b')
    assert.equal(second.soloDir, 'a-b-2')
    assert.notEqual(first.soloDir, second.soloDir)
    assert.ok(await dirExists(workspace, first.soloDir), '先建目录再建号')
    assert.ok(await dirExists(workspace, second.soloDir))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('并发两次同名（slug 碰撞）创建均成功且 solo_dir 不同，目录都真实存在', async () => {
  const { root, workspace, service } = await setup()
  try {
    const [x, y] = await Promise.all([
      service.createBot({ name: 'c_d' }),
      service.createBot({ name: 'c-d' }),
    ])
    assert.deepEqual([x.soloDir, y.soloDir].sort(), ['c-d', 'c-d-2'])
    assert.ok(await dirExists(workspace, x.soloDir), '赢家目录事务前已建')
    assert.ok(await dirExists(workspace, y.soloDir), '输家目录提交后补建')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('注入 UNIQUE 错误：事务内重生成候选重试后创建成功', async () => {
  const { root, store, service } = await setup()
  try {
    const attempts = injectUniqueOnBotsInsert(service)
    const bot = await service.createBot({ name: 'retry_x' })
    assert.equal(bot.soloDir, 'retry-x')
    assert.ok(attempts() >= 2, '第一次 INSERT 被拦后走了重试')
    const row = store.get('SELECT solo_dir FROM bots WHERE id = ?', bot.id)
    assert.equal(row.solo_dir, 'retry-x')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM bot_revisions WHERE bot_id = ?', bot.id).n, 1, '版本行随事务落库')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('注入持续 UNIQUE 错误：5 次尝试穷尽后抛带 bot 名的 badRequest 而非裸 SQLITE', async () => {
  const { root, store, service } = await setup()
  try {
    const attempts = injectUniqueOnBotsInsert(service, { persistent: true })
    await assert.rejects(
      service.createBot({ name: 'exhaust_x' }),
      error => error.code === 'BAD_REQUEST'
        && error.status === 400
        && error.message.includes('exhaust_x')
        && error.message !== 'UNIQUE constraint failed: bots.solo_dir',
    )
    assert.equal(attempts(), 5, '尝试上限恰为 5 次')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM bots WHERE name = 'exhaust_x'").n, 0, '失败不留 bot 行')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'bot.create' AND data_json LIKE '%exhaust_x%'").n, 0, '失败不留审计')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('并发字面同名：恰一个成功，输家拿到与预检一致的 conflict 而非裸 SQLITE', async () => {
  const { root, store, service } = await setup()
  try {
    const results = await Promise.allSettled([
      service.createBot({ name: 'Twins' }),
      service.createBot({ name: 'Twins' }),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.code, 'CONFLICT')
    assert.equal(rejected[0].reason.status, 409)
    assert.equal(rejected[0].reason.message, 'Bot 名称已存在')
    assert.notEqual(rejected[0].reason.code, 'ERR_SQLITE_ERROR')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM bots WHERE name = 'Twins'").n, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
