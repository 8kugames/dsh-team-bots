// DSHBOTS-174：单聊「查看更早归档消息」入口可达。
// 后端 state 增 view.solo.archived={count,hasMore} 契约（复用 DSBOTS-171 soloVisibleMessages 窗口口径）；
// 前端 canLoadOlder 单聊分支接契约门控（归档过滤后首屏恒 <CHAT_PAGE_SIZE，旧满页阈值永不满足），
// 取数零新请求路径——仍走既有 chatOlder 分片桶 + messagesPage 单聊游标；群聊按钮条件不变。
// 后端例走 service 行为断言（与 tests/solo-archive.test.js 同口径）；UI 例走 readUiSource 防假锁
// 惯例：先剔行注释再断言，锚点用函数名与语义、不写死行号。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { readUiSource } from './helpers/ui-sources.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-solo-archive-ui-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20, ...overrides })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  return { root, store, service }
}

const SEC = 1_000
const DAY = 86_400_000
// 窗口 cutoff 基于真实 Date.now()，种子时间相对当前时刻（agoMs 越大越旧）。
const ago = ms => new Date(Date.now() - ms).toISOString()

function seedSolo(store, botId, id, agoMs) {
  store.run(
    `INSERT INTO solo_messages(id, bot_id, sender_type, sender_id, body, created_at)
     VALUES (?, ?, 'user', 'u1', ?, ?)`,
    id, botId, `消息 ${id}`, ago(agoMs),
  )
}

const firstBot = store => store.get('SELECT * FROM bots ORDER BY created_at LIMIT 1')

// 剔行注释：防「注释里的字也能让断言通过」的假锁（6040ea5 教训，同 chat-pagination.test.js）。
const stripComments = src => src.replace(/\/\/[^\n]*/g, '')

test('契约·keep 窗口：150 条只显 100，archived={count:50,hasMore:true}，游标一翻即回', async () => {
  const { root, store, service } = await setup()
  try {
    const bot = firstBot(store)
    for (let i = 0; i < 150; i += 1) seedSolo(store, bot.id, `s_c_${String(i).padStart(3, '0')}`, i * SEC)

    const view = await service.state(null, bot.id)
    assert.equal(view.solo.messages.length, 100, 'keep=100 只留最近 100 条')
    assert.deepEqual(view.solo.archived, { count: 50, hasMore: true }, '被窗口隐去的 50 条应有契约')

    // 入口可达性闭环：以窗口最旧一条作游标（=前端点击按钮的取数方式），归档 50 条一页翻回、无漏无重。
    const oldest = view.solo.messages[0]
    const page = service.messagesPage({ soloBotId: bot.id, beforeCreatedAt: oldest.created_at, beforeId: oldest.id })
    assert.equal(page.messages.length, 50, '归档的 50 条应一页翻回')
    assert.equal(page.hasMore, false)
    const all = [...page.messages, ...view.solo.messages]
    assert.equal(all.length, 150)
    assert.equal(new Set(all.map(m => m.id)).size, 150, '翻回后全量无漏无重')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('契约·两维全关：回退 200 上限隐去的 50 条也计入契约，入口不因维全关而失明', async () => {
  const { root, store, service } = await setup({ dmArchiveDays: 0, dmKeepRecent: 0 })
  try {
    const bot = firstBot(store)
    for (let i = 0; i < 250; i += 1) seedSolo(store, bot.id, `s_f_${String(i).padStart(3, '0')}`, i * SEC)

    const view = await service.state(null, bot.id)
    assert.equal(view.solo.messages.length, 200, '两维全关回退 200 条上限')
    assert.deepEqual(view.solo.archived, { count: 50, hasMore: true }, '上限隐去的同样是可翻回的更早消息')

    const oldest = view.solo.messages[0]
    const page = service.messagesPage({ soloBotId: bot.id, beforeCreatedAt: oldest.created_at, beforeId: oldest.id })
    assert.equal(page.messages.length, 50)
    assert.equal(page.hasMore, false)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('契约·窗口全空（消息全被归档）：如实上报 count/hasMore，不吞数据事实', async () => {
  const { root, store, service } = await setup()
  try {
    const bot = firstBot(store)
    for (let i = 0; i < 3; i += 1) seedSolo(store, bot.id, `s_e_${i}`, 8 * DAY + i * SEC)

    const view = await service.state(null, bot.id)
    assert.equal(view.solo.messages.length, 0, '三天窗外的消息全被隐去')
    assert.deepEqual(view.solo.archived, { count: 3, hasMore: true }, '契约如实——UI 侧由 mergedCount>0 锚点闸兜住无锚可翻的角落')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('契约·无隐去：archived={count:0,hasMore:false}，入口不亮', async () => {
  const { root, store, service } = await setup()
  try {
    const bot = firstBot(store)
    for (let i = 0; i < 50; i += 1) seedSolo(store, bot.id, `s_n_${String(i).padStart(3, '0')}`, i * SEC)
    // 第二个 bot 的消息不得计入本 bot 契约（COUNT 按 bot_id 收敛）。
    const other = store.get("SELECT * FROM bots WHERE name = 'director'")
    if (other && other.id !== bot.id) seedSolo(store, other.id, 's_other_0', 1 * SEC)

    const view = await service.state(null, bot.id)
    assert.equal(view.solo.messages.length, 50)
    assert.deepEqual(view.solo.archived, { count: 0, hasMore: false })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('UI 锚点·门控模块：solo-archived-gate 标记块内是契约门控，bot 匹配防串台', () => {
  const raw = readFileSync(join(REPO, 'ui/modules/solo-archive.js'), 'utf8')
  const start = raw.indexOf('solo-archived-gate:start')
  const end = raw.indexOf('solo-archived-gate:end')
  assert.ok(start >= 0 && end > start, '标记块 start/end 应成对出现')
  const block = stripComments(raw.slice(start, end))
  assert.ok(block.includes('function soloArchivedHasMore'), '块内应定义门控函数')
  assert.ok(block.includes('solo.bot?.id !== state.soloBotId'), '必须校验 view.solo.bot 与当前 bot 匹配，防切 bot 后旧数据串台')
  assert.ok(block.includes('solo.archived?.hasMore'), '门控只认契约字段 archived.hasMore')
})

test('UI 锚点·canLoadOlder 单聊分支接契约门控，群聊条件不变', () => {
  const bare = stripComments(readUiSource())
  // 单聊：契约门控 + mergedCount>0 游标锚点（窗口全空时无锚不亮死按钮），旧后端无契约时回退满页阈值。
  assert.ok(
    bare.includes("if (state.chatMode === 'solo') return (mergedCount > 0 && soloArchivedHasMore()) || mergedCount >= CHAT_PAGE_SIZE"),
    '单聊分支应为契约门控且带回退',
  )
  // 群聊：满页阈值条件一字不动。
  assert.ok(bare.includes('return mergedCount >= CHAT_PAGE_SIZE'), '群聊满页阈值应保持')
  // 群聊与单聊两处渲染仍接同一条件按钮。
  const wired = [...bare.matchAll(/canLoadOlder\(messages\.length\) \? loadOlderButton\(\)/g)]
  assert.equal(wired.length, 2, '两处渲染都应接条件按钮')
  // chat.js 必须真的 import 门控（ui-modules-split 跨切片 import 守门的配套锚点）。
  assert.ok(bare.includes("import { soloArchivedHasMore } from './solo-archive.js'"), 'chat.js 应 import solo-archive 门控')
})

test('UI 锚点·零新请求路径：门控模块不调 api，取数仍走既有 messages_page', () => {
  const moduleSrc = stripComments(readFileSync(join(REPO, 'ui/modules/solo-archive.js'), 'utf8'))
  assert.ok(!/\bapi\s*\(/.test(moduleSrc), '门控模块不应发起任何请求')
  const raw = readUiSource()
  const block = stripComments(raw.slice(raw.indexOf('chat-pagination:start'), raw.indexOf('chat-pagination:end')))
  assert.ok(block.includes("api('messages_page'"), '取数仍应走既有 loadOlderMessages 的 messages_page 链路')
})

test('后端锚点·state 下发 view.solo.archived 契约，COUNT 按 bot 收敛', () => {
  const src = stripComments(readFileSync(join(REPO, 'src/services/system.js'), 'utf8'))
  assert.ok(src.includes('archived: { count: archivedCount, hasMore: archivedCount > 0 }'), '契约字段应原样下发')
  assert.ok(src.includes('SELECT COUNT(*) AS count FROM solo_messages WHERE bot_id = ?'), '归档计数应按 bot_id 收敛')
})
