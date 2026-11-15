// DSHBOTS-171：私信（solo 单聊）默认视图自动归档——只留「最近 dmKeepRecent 条 且
// dmArchiveDays 天内」交集；归档=默认视图隐去不删，messagesPage 游标翻页仍可查回。
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

async function setup(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-solo-archive-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20, ...overrides })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  return { root, store, service }
}

const DAY = 86_400_000
const HOUR = 3_600_000
const SEC = 1_000
// 窗口 cutoff 基于真实 Date.now()，种子时间必须相对当前时刻（agoMs 越大越旧）。
const ago = ms => new Date(Date.now() - ms).toISOString()

function seedSolo(store, botId, id, body, agoMs) {
  const createdAt = ago(agoMs)
  store.run(
    `INSERT INTO solo_messages(id, bot_id, sender_type, sender_id, body, created_at)
     VALUES (?, ?, 'user', 'u1', ?, ?)`,
    id, botId, body, createdAt,
  )
  return createdAt
}

test('默认窗口：7 天前消息不进默认视图，但翻页可查回（归档=隐去不删）', async () => {
  const { root, store, service } = await setup()
  try {
    const bot = store.get('SELECT * FROM bots ORDER BY created_at LIMIT 1')
    seedSolo(store, bot.id, 's_old', '八天前', 8 * DAY)
    const midAt = seedSolo(store, bot.id, 's_mid', '六天前', 6 * DAY)
    seedSolo(store, bot.id, 's_new', '刚发', 1 * HOUR)

    const view = await service.state(null, bot.id)
    assert.deepEqual(view.solo.messages.map(m => m.id), ['s_mid', 's_new'], '8 天前消息应被归档，其余升序保留')

    // 被归档消息经游标翻页仍可见——数据没删，只是默认视图隐去。游标用种子的精确 created_at。
    const page = service.messagesPage({ soloBotId: bot.id, beforeCreatedAt: midAt, beforeId: 's_mid' })
    assert.deepEqual(page.messages.map(m => m.id), ['s_old'])
    assert.equal(page.hasMore, false)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('keep 窗口：101 条时最旧 1 条被归档，翻页可查回', async () => {
  const { root, store, service } = await setup()
  try {
    const bot = store.get('SELECT * FROM bots ORDER BY created_at LIMIT 1')
    // i 秒前：i=0 最新、i=100 最旧；keep=100 应留下 i=0..99，归档最旧的 i=100。
    for (let i = 0; i <= 100; i += 1) seedSolo(store, bot.id, `s_k_${String(i).padStart(3, '0')}`, `消息 ${i}`, i * SEC)

    const view = await service.state(null, bot.id)
    assert.equal(view.solo.messages.length, 100, '101 条只留最近 100 条')
    assert.equal(view.solo.messages[0].id, 's_k_099', '默认视图升序，首位=窗口内最旧一条')
    assert.equal(view.solo.messages.at(-1).id, 's_k_000', '末位=最新一条')
    assert.ok(!view.solo.messages.some(m => m.id === 's_k_100'), '最旧 1 条被 keep 窗口归档')
    for (let i = 1; i < view.solo.messages.length; i += 1) {
      assert.ok(view.solo.messages[i - 1].created_at <= view.solo.messages[i].created_at, '默认视图应升序')
    }

    const oldestVisibleAt = store.get('SELECT created_at FROM solo_messages WHERE id = ?', 's_k_099').created_at
    const page = service.messagesPage({ soloBotId: bot.id, beforeCreatedAt: oldestVisibleAt, beforeId: 's_k_099' })
    assert.deepEqual(page.messages.map(m => m.id), ['s_k_100'], '被归档的最旧一条翻页可查回')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('days=0 关闭时间维：7 天前的消息不再被归档', async () => {
  const { root, store, service } = await setup({ dmArchiveDays: 0 })
  try {
    const bot = store.get('SELECT * FROM bots ORDER BY created_at LIMIT 1')
    seedSolo(store, bot.id, 's_o0', '八天前', 8 * DAY)
    seedSolo(store, bot.id, 's_o1', '六天前', 6 * DAY)
    seedSolo(store, bot.id, 's_o2', '刚发', 1 * HOUR)

    const view = await service.state(null, bot.id)
    assert.deepEqual(view.solo.messages.map(m => m.id), ['s_o0', 's_o1', 's_o2'], '时间维关闭后全量可见（未超 keep）')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('keep=0 关闭条数维：回退 200 条上限，days 维仍生效', async () => {
  const { root, store, service } = await setup({ dmKeepRecent: 0 })
  try {
    const bot = store.get('SELECT * FROM bots ORDER BY created_at LIMIT 1')
    // 5 条 8 天前（应被 days 维归档）+ 200 条新消息（keep 关闭→不按 100 截，按 200 回退上限）。
    for (let i = 0; i < 5; i += 1) seedSolo(store, bot.id, `s_old_${i}`, `旧 ${i}`, 8 * DAY + i * SEC)
    for (let i = 0; i < 200; i += 1) seedSolo(store, bot.id, `s_new_${String(i).padStart(3, '0')}`, `新 ${i}`, i * SEC)

    const view = await service.state(null, bot.id)
    assert.equal(view.solo.messages.length, 200, 'keep 关闭应回退 200 上限而非 100 截断')
    assert.ok(view.solo.messages.every(m => !m.id.startsWith('s_old_')), '8 天前消息仍应被 days 维归档')
    assert.equal(view.solo.messages[0].id, 's_new_199', '默认视图升序，首位=最旧一条（199 秒前）')
    assert.equal(view.solo.messages.at(-1).id, 's_new_000', '末位=最新一条')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('群聊不受影响：8 天前的群聊消息照常进默认视图（同一 service 下 solo 被归档对照）', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Group Demo', key: 'GRPDMO', ownerBotId: director.id })
    const insertGroup = (id, body, agoMs) => store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, created_at)
       VALUES (?, ?, (SELECT id FROM group_chats WHERE project_id = ?), 'user', 'u1', ?, ?)`,
      id, project.id, project.id, body, ago(agoMs),
    )
    insertGroup('g_old', '群聊八天前', 8 * DAY)
    insertGroup('g_new', '群聊刚发', 1 * HOUR)

    seedSolo(store, director.id, 's_g_old', '单聊八天前', 8 * DAY)
    seedSolo(store, director.id, 's_g_new', '单聊刚发', 1 * HOUR)

    const groupView = await service.state(project.id)
    assert.deepEqual(groupView.messages.map(m => m.id), ['g_old', 'g_new'], '群聊默认视图不做时间归档')

    const soloView = await service.state(null, director.id)
    assert.deepEqual(soloView.solo.messages.map(m => m.id), ['s_g_new'], '同 service 下 solo 旧消息被归档（对照组）')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('env 覆盖生效：DSH_TEAM_DM_ARCHIVE_DAYS=2 且 DSH_TEAM_DM_KEEP_RECENT=3', async () => {
  process.env.DSH_TEAM_DM_ARCHIVE_DAYS = '2'
  process.env.DSH_TEAM_DM_KEEP_RECENT = '3'
  try {
    const { root, store, service } = await setup()
    try {
      const bot = store.get('SELECT * FROM bots ORDER BY created_at LIMIT 1')
      seedSolo(store, bot.id, 's_e_0', '三天前', 3 * DAY)
      for (let i = 1; i <= 5; i += 1) seedSolo(store, bot.id, `s_e_${i}`, `消息 ${i}`, i * SEC)

      const view = await service.state(null, bot.id)
      // days=2 归档 3 天前那条；keep=3 只留最近 3 条（i=1..3，1 秒前的最新），升序展示。
      assert.deepEqual(view.solo.messages.map(m => m.id), ['s_e_3', 's_e_2', 's_e_1'])
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  } finally {
    delete process.env.DSH_TEAM_DM_ARCHIVE_DAYS
    delete process.env.DSH_TEAM_DM_KEEP_RECENT
  }
})

test('resolveConfig：默认 7/100，非法回默认，负值钳到 0（=关闭），超上限钳制', () => {
  const base = { workspace: '/tmp/dsh-cfg-ws', dataDir: '/tmp/dsh-cfg-data', skillRoot: '/tmp/dsh-cfg-sk' }
  const read = () => {
    const c = resolveConfig(base)
    return { days: c.dmArchiveDays, keep: c.dmKeepRecent }
  }
  assert.deepEqual(read(), { days: 7, keep: 100 }, '默认 7 天 / 100 条')

  const cases: Array<[[string, string], [string, string], { days: number; keep: number }, string]> = [
    [['DSH_TEAM_DM_ARCHIVE_DAYS', 'abc'], ['DSH_TEAM_DM_KEEP_RECENT', 'abc'], { days: 7, keep: 100 }, '非法值回默认'],
    [['DSH_TEAM_DM_ARCHIVE_DAYS', '-5'], ['DSH_TEAM_DM_KEEP_RECENT', '-1'], { days: 0, keep: 0 }, '负值钳到 0=关闭'],
    [['DSH_TEAM_DM_ARCHIVE_DAYS', '30'], ['DSH_TEAM_DM_KEEP_RECENT', '250'], { days: 30, keep: 250 }, '合法覆盖生效'],
    [['DSH_TEAM_DM_ARCHIVE_DAYS', '99999'], ['DSH_TEAM_DM_KEEP_RECENT', '99999'], { days: 3650, keep: 10000 }, '超上限钳到 3650/10000'],
  ]
  try {
    for (const [[daysKey, daysVal], [keepKey, keepVal], expected, label] of cases) {
      process.env[daysKey] = daysVal
      process.env[keepKey] = keepVal
      assert.deepEqual(read(), expected, label)
      delete process.env[daysKey]
      delete process.env[keepKey]
    }
  } finally {
    delete process.env.DSH_TEAM_DM_ARCHIVE_DAYS
    delete process.env.DSH_TEAM_DM_KEEP_RECENT
  }
})
