import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { nowIso, stripLeakedToolMarkup } from '../src/util.js'
import { isToolMarkupFragment, selectDeliverableText } from '../src/services/runtime/lifecycle.js'

// —— 纯函数：剥 provider 泄漏的工具调用标记残片 ——

test('①纯残片清洗后为空（DSML 残片与工具调用标签）', () => {
  assert.equal(stripLeakedToolMarkup('</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'), '')
  assert.equal(stripLeakedToolMarkup('<｜｜DSML｜｜ invoke name="read">正文'), '正文')
  assert.equal(stripLeakedToolMarkup('｜｜DSML｜｜'), '')
  assert.equal(stripLeakedToolMarkup('<tool_call>\n<invoke name="read">\n<file_path>/tmp/a.js</file_path>\n</invoke>\n</tool_call>'), '')
  assert.equal(stripLeakedToolMarkup('<tool_use model="x">hi</tool_use>'), '')
  assert.equal(stripLeakedToolMarkup('<tool_use model="x">hi'), 'hi')
  // minimax 变体：标签与 ]minimax[ 包裹层剥掉；残渣只剩括号与参数值（历史 3 条的可接受降级）
  const minimaxResidue = stripLeakedToolMarkup(
    '<<tool_call> ]<]minimax[>[<invoke name="read">]<]minimax[>[<file_path>/tmp/a.js]<]minimax[>[<limit>30]<]minimax[>[<offset>1858',
  )
  assert.ok(!/minimax|tool_call|invoke|file_path|limit|offset/.test(minimaxResidue), minimaxResidue)
  assert.ok(minimaxResidue.includes('/tmp/a.js'), minimaxResidue)
  assert.equal(stripLeakedToolMarkup(null), '')
})

test('②正常文本夹残片：只留正常文本', () => {
  assert.equal(
    stripLeakedToolMarkup('结论如下。\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>\n完整交付见评论。'),
    '结论如下。\n\n完整交付见评论。',
  )
  assert.equal(stripLeakedToolMarkup('<tool_call>x</tool_call>已交付，待验收。'), '已交付，待验收。')
})

test('③正常 markdown 不被误伤', () => {
  const sample = [
    '## 结论',
    '',
    '**要点**：<b>清洗</b>只针对标记残片，详见 <https://example.com/fix>。',
    '',
    '```',
    'const x = [1, 2].map(n => n * 2)',
    'a < b && c > d',
    '```',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '|  1  |  2  |',
  ].join('\n')
  assert.equal(stripLeakedToolMarkup(sample), sample)
})

// —— 服务层：写入侧落库前清洗 + 读取侧历史脏数据兜底 ——

class FakeRuntime {
  constructor() {
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }
  setCompletionHandler() {}
  async catalog() { return this.models }
  async validateBotConfig() {}
  async startRun() { return 'session-x' }
  async cancelRun() { return true }
}

async function closeQuietly(store, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch { break }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try { store.close() } catch {}
}

async function sanitizeSetup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sanitize-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`)
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new FakeRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const builder = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({
    name: 'Sanitize Project', key: 'SAN', ownerBotId: director.id, memberIds: [builder.id],
  })
  return { root, store, service, director, builder, project }
}

test('④写入侧：bot 纯残片不落库、夹残片只留正常文本，用户引用残片原样保留', async () => {
  const { root, store, service, builder, project } = await sanitizeSetup()
  try {
    const skipped = service.insertMessage({
      projectId: project.id, senderType: 'bot', senderId: builder.id,
      body: '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
    })
    assert.equal(skipped, null)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM messages WHERE sender_type = ?', 'bot')?.n, 0)

    const mixedId = service.insertMessage({
      projectId: project.id, senderType: 'bot', senderId: builder.id,
      body: '结论如下。\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>\n完整交付见评论。',
    })
    assert.ok(mixedId)
    assert.equal(store.get('SELECT body FROM messages WHERE id = ?', mixedId).body, '结论如下。\n\n完整交付见评论。')

    const userId = service.insertMessage({
      projectId: project.id, senderType: 'user', senderId: 'u1',
      body: '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls> 结论是什么？',
    })
    assert.equal(store.get('SELECT body FROM messages WHERE id = ?', userId).body, '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls> 结论是什么？')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('④读取侧：历史脏数据在消息视图/引用视图/单聊视图被过滤', async () => {
  const { root, store, service, builder, project } = await sanitizeSetup()
  try {
    const group = service.groupOf(project.id)
    // 模拟历史脏数据：绕过 insertMessage 直接落库残片行
    const legacyId = 'msg_legacy01'
    store.run(
      'INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      legacyId, project.id, group.id, 'bot', builder.id, '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>', nowIso(),
    )
    const view = service.messageView(store.get('SELECT * FROM messages WHERE id = ?', legacyId))
    assert.equal(view.body, '')
    assert.equal(service.replyView(legacyId).excerpt, '')

    const soloLegacy = 'msg_legacy02'
    store.run(
      'INSERT INTO solo_messages(id, bot_id, sender_type, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      soloLegacy, builder.id, 'bot', builder.id, '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>', nowIso(),
    )
    assert.equal(service.soloMessageView(store.get('SELECT * FROM solo_messages WHERE id = ?', soloLegacy)).body, '')

    // 单聊写入侧同样不落纯残片
    const soloSkipped = service.insertSoloMessage({
      botId: builder.id, senderType: 'bot', senderId: builder.id, body: '</｜｜DSML｜｜ invoke>',
    })
    assert.equal(soloSkipped, null)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

// —— 运行收尾选文本：整段工具标记残片不当成交付文本（lifecycle 的 strip-tool-markup 块）——

// 生产库 run_2e2b158e36c649428afede87 的真实残片样本。
const RUN_OUTPUT_FRAGMENT = '<tool_call>\n]<]minimax[>[<invoke name="read">]<]minimax[>[<file_path>...<offset>1858'

test('⑤整段工具调用残片被识别、收尾选文本时丢弃并回退正常正文', () => {
  assert.equal(isToolMarkupFragment(RUN_OUTPUT_FRAGMENT), true)
  // 该轮只有残片：按「模型未返回文本」处理（返回空串）。
  assert.equal(selectDeliverableText([RUN_OUTPUT_FRAGMENT]), '')
  // 回退到此前的正常 text block。
  const prose = '第一轮交付说明：改动落在 src/api.js 与 tests/chat-pagination.test.js。'
  assert.equal(selectDeliverableText([prose, RUN_OUTPUT_FRAGMENT]), prose)
  // 无标记的普通文本永不误判，空串不算残片。
  assert.equal(isToolMarkupFragment('完成'), false)
  assert.equal(isToolMarkupFragment(''), false)
  assert.equal(selectDeliverableText([]), '')
})

test('⑥正文恰好提到 <invoke> 不被误伤：只在整段无散文时才丢', () => {
  const prose = '排查结论：模型把 <invoke name="read"> 整段序列化成了 text 块，属于 provider 侧泄漏，收尾时按残片丢弃。'
  assert.equal(isToolMarkupFragment(prose), false)
  assert.equal(selectDeliverableText([prose, RUN_OUTPUT_FRAGMENT]), prose)
  // 带标记但剥完仍有成段散文的正文，同样保留原文。
  const report = '本轮完成了收尾卫生改造。\n\n<tool_call>\n<invoke name="read">\n<file_path>/tmp/a.js</file_path>\n</invoke>\n</tool_call>\n\n具体改动见任务评论，待验收。'
  assert.equal(isToolMarkupFragment(report), false)
  assert.equal(selectDeliverableText([report]), report)
})
