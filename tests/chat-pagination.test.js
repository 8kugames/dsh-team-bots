// DSHBOTS-33：聊天历史游标分页（messagesPage）——state 只回最后 200 条，更早历史按 created_at+id 游标向前翻。
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-chat-page-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  return { root, store, service }
}

const at = i => new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString()

function seedGroup(store, projectId, count) {
  for (let i = 0; i < count; i += 1) {
    store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, created_at)
       VALUES (?, ?, (SELECT id FROM group_chats WHERE project_id = ?), 'user', 'u1', ?, ?)`,
      `msg_seed_${i}`, projectId, projectId, `消息 ${i}`, at(i),
    )
  }
}

test('群聊分页：450 条翻三页 200/200/50，页间无漏无重', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Page Demo', key: 'PAGEDMO', ownerBotId: director.id })
    seedGroup(store, project.id, 450)

    // 模拟前端：state 已回最后 200 条，取其最旧一条作游标。
    const stateView = await service.state(project.id)
    let cursor = stateView.messages[0]
    let all = [...stateView.messages]

    let page = service.messagesPage({ projectId: project.id, beforeCreatedAt: cursor.created_at, beforeId: cursor.id })
    assert.equal(page.messages.length, 200)
    assert.equal(page.hasMore, true)
    all = [...page.messages, ...all]

    // 450 条 = state 200（250-449）+ 更早 250（0-249）：第一页补 200（50-249），第二页只剩 50（0-49）。
    cursor = page.messages[0]
    page = service.messagesPage({ projectId: project.id, beforeCreatedAt: cursor.created_at, beforeId: cursor.id })
    assert.equal(page.messages.length, 50)
    assert.equal(page.hasMore, false)
    all = [...page.messages, ...all]

    // 完整性：合并后 450 条、id 全唯一、时间严格升序。
    assert.equal(all.length, 450)
    assert.equal(new Set(all.map(m => m.id)).size, 450)
    for (let i = 1; i < all.length; i += 1) {
      assert.ok(all[i - 1].created_at <= all[i].created_at, '时间应升序')
    }
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('同毫秒消息：id 游标兜底，不漏不重', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Tie Demo', key: 'TIEDEMO', ownerBotId: director.id })
    const same = at(5)
    // 三条同毫秒，id 依次递增（同毫秒内按 id 升序即写入顺序）。
    for (const [i, mid] of ['msg_t1', 'msg_t2', 'msg_t3'].entries()) {
      store.run(
        `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, created_at)
         VALUES (?, ?, (SELECT id FROM group_chats WHERE project_id = ?), 'user', 'u1', ?, ?)`,
        mid, project.id, project.id, `同毫秒 ${i}`, same,
      )
    }
    // 游标取 msg_t2：应恰好返回 msg_t1 一条。
    const page = service.messagesPage({ projectId: project.id, beforeCreatedAt: same, beforeId: 'msg_t2' })
    assert.deepEqual(page.messages.map(m => m.id), ['msg_t1'])
    assert.equal(page.hasMore, false)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('单聊按 bot_id 分路，互不串线', async () => {
  const { root, store, service } = await setup()
  try {
    const bots = store.all('SELECT * FROM bots')
    const a = bots[0]
    const b = bots[1] ?? store.get("SELECT * FROM bots WHERE name = 'director'")
    for (const [bot, tag] of [[a, 'A'], [b, 'B']]) {
      for (let i = 0; i < 3; i += 1) {
        store.run(
          `INSERT INTO solo_messages(id, bot_id, sender_type, sender_id, body, created_at)
           VALUES (?, ?, 'user', 'u1', ?, ?)`,
          `solo_${tag}_${i}`, bot.id, `${tag} 的消息 ${i}`, at(i),
        )
      }
    }
    const page = service.messagesPage({ soloBotId: a.id, beforeCreatedAt: at(1), beforeId: `solo_A_2` })
    assert.deepEqual(page.messages.map(m => m.id).sort(), ['solo_A_0', 'solo_A_1'])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('limit 边界：超上限压到 200，小值生效，非法回默认', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Limit Demo', key: 'LMTDEMO', ownerBotId: director.id })
    seedGroup(store, project.id, 250)
    const page = service.messagesPage({ projectId: project.id, beforeCreatedAt: at(249), beforeId: 'msg_seed_249', limit: 500 })
    assert.equal(page.messages.length, 200)
    assert.equal(page.hasMore, true)

    const single = service.messagesPage({ projectId: project.id, beforeCreatedAt: at(10), beforeId: 'msg_seed_10', limit: 1 })
    assert.equal(single.messages.length, 1)

    const fallback = service.messagesPage({ projectId: project.id, beforeCreatedAt: at(249), beforeId: 'msg_seed_249', limit: 'abc' })
    assert.equal(fallback.messages.length, 200)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('参数校验：scope 二选一、游标缺一不可', async () => {
  const { root, store, service } = await setup()
  try {
    assert.throws(() => service.messagesPage({}), /二选一/)
    assert.throws(() => service.messagesPage({ projectId: 'p1', soloBotId: 'b1' }), /二选一/)
    assert.throws(() => service.messagesPage({ projectId: 'p1' }), /游标/)
    assert.throws(() => service.messagesPage({ projectId: 'p1', beforeCreatedAt: at(0) }), /游标/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

// UI 源码断言：锁住 ui/app.js 里分片加载的接线不被无意拆断（DSHBOTS-33 UI 重放）。
// 先剔行注释再断言顺序，防止「注释里的字也能让断言通过」的假锁（6040ea5 教训）。
test('UI 接线：标记块存在、渲染/分发/样式接通、顺序正确', async () => {
  const { readFile } = await import('node:fs/promises')
  const app = await readFile('ui/app.js', 'utf8')
  const bare = app.replace(/\/\/[^\n]*/g, '')
  const css = await readFile('ui/styles.css', 'utf8')

  // ① 标记块齐全（标记本身是行注释，须在原文定位），五个 helper 都在剔注释后的块内。
  const start = app.indexOf('chat-pagination:start')
  const end = app.indexOf('chat-pagination:end')
  assert.ok(start >= 0 && end > start, '标记块 start/end 应成对出现')
  const block = app.slice(start, end).replace(/\/\/[^\n]*/g, '')
  for (const fn of ['function chatKey', 'function mergedChatMessages', 'function canLoadOlder', 'function loadOlderButton', 'async function loadOlderMessages']) {
    assert.ok(block.includes(fn), `标记块应含 ${fn}`)
  }

  // ② 渲染接线：两处渲染都换 mergedChatMessages，且按钮行在 chat-messages 内、消息列表前。
  for (const anchor of ['const messages = mergedChatMessages(state.data.messages ?? [])', 'const messages = mergedChatMessages(solo?.messages ?? [])']) {
    assert.ok(bare.includes(anchor), `渲染应使用合并视图：${anchor}`)
  }
  const btn = bare.indexOf('canLoadOlder(messages.length) ? loadOlderButton()')
  assert.ok(btn >= 0, 'chat-messages 内应有条件按钮')
  const listGroup = bare.indexOf('messages.map(renderMessage).join')
  assert.ok(listGroup > btn, '按钮行应在消息列表之前（贴顶）')

  // ③ 分发接线：load-older case 存在且调用 loadOlderMessages。
  assert.ok(bare.includes("case 'load-older':"), 'data-action 分发应有 load-older case')
  assert.ok(bare.includes('await loadOlderMessages()'), 'case 应调用 loadOlderMessages')

  // ④ state 接线：chatOlder 桶存在且字段齐全。
  assert.ok(bare.includes('chatOlder: { key: null, items: [], hasMore: false, loading: false }'), 'state 应初始化 chatOlder 桶')
  assert.ok(bare.includes('const CHAT_PAGE_SIZE = 200'), '分片常量应为 200')

  // ⑤ 阅读位补偿在标记块内：rAF 套一层且用 scrollHeight 差补偿。
  assert.ok(block.includes('requestAnimationFrame'), '补偿应套 rAF')
  assert.ok(block.includes('listEl.scrollHeight - prevHeight'), '补偿应用 scrollHeight 差')

  // ⑥ 样式存在。
  assert.ok(css.includes('.load-older'), 'styles.css 应有 .load-older 样式')
})
