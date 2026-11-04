// DSHBOTS-51：bot 版本历史只记角色/指令——模型类字段改动即生效不占版本；
// 快照内容与最新版本行比对，同内容重复保存不插行、不 bump，审计带 unchanged 标记。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-bot-revisions-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

const revisions = (store, botId) => store.all('SELECT version, role, instructions FROM bot_revisions WHERE bot_id = ? ORDER BY version', botId)
const lastAudit = store => JSON.parse(store.get("SELECT data_json FROM audit_log WHERE action = 'bot.update' ORDER BY rowid DESC").data_json)

test('模型类字段（主/备 provider·model·effort）改动即生效：仅落库+审计，不插版本行、不 bump', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const before = revisions(store, director.id).length
    await service.updateBot(director.id, { provider: 'anthropic', model: 'claude-opus', effort: 'high' }, { type: 'user', id: 'u' })
    await service.updateBot(director.id, { fallbackProvider: 'openai', fallbackModel: 'gpt-4o-mini' }, { type: 'user', id: 'u' })
    const bot = store.get('SELECT provider, model, effort, fallback_provider, fallback_model, current_revision FROM bots WHERE id = ?', director.id)
    assert.equal(bot.provider, 'anthropic')
    assert.equal(bot.fallback_model, 'gpt-4o-mini')
    assert.equal(bot.current_revision, director.current_revision, 'current_revision 不动')
    assert.equal(revisions(store, director.id).length, before, '无新版本行')
    const audit = lastAudit(store)
    assert.equal(audit.unchanged, undefined, '真实配置变更不是 no-op，不带 unchanged 标记')
    assert.equal(audit.fallback_model, 'gpt-4o-mini', '模型改动仍进审计')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('同内容重复保存不产生新版本：不插行、不 bump、审计记 unchanged 标记', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const before = revisions(store, director.id).length
    await service.updateBot(director.id, { role: director.role, instructions: director.instructions }, { type: 'user', id: 'u' })
    assert.equal(revisions(store, director.id).length, before, '同内容保存零新行')
    assert.equal(store.get('SELECT current_revision FROM bots WHERE id = ?', director.id).current_revision, director.current_revision)
    assert.equal(lastAudit(store).unchanged, true, 'no-op 留痕')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('改一个字产生新版本：插行并 bump，审计不带 unchanged', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const next = director.instructions + '，注意复检'
    await service.updateBot(director.id, { instructions: next }, { type: 'user', id: 'u' })
    const rows = revisions(store, director.id)
    assert.equal(rows.length, Number(director.current_revision) + 1, '新增一行')
    assert.equal(rows.at(-1).instructions, next)
    const inserted = store.get('SELECT * FROM bot_revisions WHERE bot_id = ? AND version = ?', director.id, Number(director.current_revision) + 1)
    assert.equal(inserted.provider, null, '新版本行不再写模型列')
    assert.equal(inserted.model, null)
    assert.equal(inserted.effort, null)
    assert.equal(store.get('SELECT current_revision FROM bots WHERE id = ?', director.id).current_revision, Number(director.current_revision) + 1)
    assert.equal(lastAudit(store).unchanged, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rollbackBot 只还原角色/指令：模型字段不随版本回滚；回滚到当前内容是 no-op', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.updateBot(director.id, { provider: 'anthropic', model: 'claude-opus' }, { type: 'user', id: 'u' })
    await service.updateBot(director.id, { role: '新角色', instructions: '新指令' }, { type: 'user', id: 'u' })
    const v1 = store.get('SELECT * FROM bot_revisions WHERE bot_id = ? AND version = 1', director.id)

    await service.rollbackBot(director.id, v1.id, { type: 'user', id: 'u' })
    const rolled = store.get('SELECT role, instructions, provider, model, current_revision FROM bots WHERE id = ?', director.id)
    assert.equal(rolled.role, v1.role, '角色还原')
    assert.equal(rolled.provider, 'anthropic', '模型不随版本回滚（保持现值）')
    assert.equal(rolled.current_revision, 3, '内容变化产生新版本行 v3')

    const rowsBefore = revisions(store, director.id).length
    const v3 = store.get('SELECT * FROM bot_revisions WHERE bot_id = ? AND version = 3', director.id)
    await service.rollbackBot(director.id, v3.id, { type: 'user', id: 'u' })
    assert.equal(revisions(store, director.id).length, rowsBefore, '回滚到当前内容零新行')
    assert.equal(lastAudit(store).unchanged, true, 'no-op 审计留痕')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('无版本行的存量 bot：以 bot 行为基线，改角色正常产生首条版本', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    store.run('DELETE FROM bot_revisions WHERE bot_id = ?', director.id)
    store.run('UPDATE bots SET current_revision = 0 WHERE id = ?', director.id)
    const sameBot = store.get('SELECT * FROM bots WHERE id = ?', director.id)
    await service.updateBot(sameBot.id, { role: sameBot.role }, { type: 'user', id: 'u' })
    assert.equal(revisions(store, sameBot.id).length, 0, '与基线同内容不补行')
    await service.updateBot(sameBot.id, { role: '全新角色' }, { type: 'user', id: 'u' })
    const rows = revisions(store, sameBot.id)
    assert.equal(rows.length, 1, '内容变化产生首条版本行')
    assert.equal(rows[0].version, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
