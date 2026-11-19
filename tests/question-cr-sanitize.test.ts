// CR 污染回归：模型工具入参偶发把空格写成 CR（U+000D）。渲染器按行尾处理，
// 一句话会被劈成多段——飞书卡片里「照准（推荐）」裂成「照准 / (推荐 / )」，
// 答复气泡里「同意另出 3 张」断成三行。口径：
// ①提问/选项/答复落库前单行化；②存量行读出时同样清洗；③通道出站边界去 CR。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { cleanAnswerItem, cleanQuestionItem } from '../src/services/questions.js'
import { FeishuChannel } from '../src/feishu/channel.js'
import { FeishuStore } from '../src/feishu/store.js'
import { flattenWhitespace, stripCarriageReturns } from '../src/util.js'

class StubRuntime {
  declare ctx: any
  constructor(ctx = null) { this.ctx = ctx }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

const now = () => new Date().toISOString()

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-question-cr-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime(null))
  await service.initialize()
  service.started = true
  service.config.questionTimeoutMs = 60
  return { root, store, service }
}

function primeProject(store, service, name) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  return service.createProject({ name, key: name.replace(/[^A-Za-z]/g, '').slice(0, 8).toUpperCase(), ownerBotId: director.id })
}

function bindSession(store, { sessionId, botId, projectId }) {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    sessionId, botId, projectId, 'project', null, now(),
  )
}

test('提问文案落库前单行化：CR 折叠掉，落库文本不再含行尾', () => {
  const cleaned = cleanQuestionItem({
    id: 'd1',
    header: 'D1\r\r 怪物牌',
    question: 'D1\r\r 怪物牌四点照准\r\r？',
    options: [{ label: '照准\r\r（推荐\r\r）', description: 'A\r\r 版绢白纸底' }, { label: '部分调整' }],
  })
  assert.equal(cleaned.header, 'D1 怪物牌')
  assert.equal(cleaned.question, 'D1 怪物牌四点照准？')
  assert.equal(cleaned.options[0].label, '照准（推荐）')
  assert.equal(cleaned.options[0].description, 'A 版绢白纸底')
})

test('答复条目单行化：selected 与 custom 同样折叠 CR', () => {
  const cleaned = cleanAnswerItem({ id: 'd1', selected: ['照准\r\r（推荐\r\r）'], custom: '同意另出\r\r 3\r\r 张' })
  assert.deepEqual(cleaned.selected, ['照准（推荐）'])
  assert.equal(cleaned.custom, '同意另出 3 张')
})

test('空白工具：CR 丢弃、CRLF 归一为 LF，其余空白折叠成单空格', () => {
  assert.equal(stripCarriageReturns('a\r\nb\rc'), 'a\nbc')
  assert.equal(flattenWhitespace('a\r\r\r  b\t\nc'), 'a b c')
})

test('提问落库与答复回宿主都是单行文本：不再把一句话劈成多段', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'CR Clean')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-cr', botId: director.id, projectId: project.id })
    const pending = service.handleQuestionRequest({
      agent: { session: { id: 'sess-cr' } },
      questions: [{
        id: 'd1',
        header: 'D1\r\r 怪物牌',
        question: 'D1\r\r 怪物牌四点照准\r\r？',
        options: [{ label: '照准\r\r（推荐\r\r）' }, { label: '部分调整' }],
      }],
      signal: new AbortController().signal,
    }, () => {})
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    assert.ok(row)
    assert.ok(!row.questions.includes('\r'), '落库提问不得含 CR')
    const stored = JSON.parse(row.questions)[0]
    assert.equal(stored.question, 'D1 怪物牌四点照准？')
    assert.equal(stored.options[0].label, '照准（推荐）')

    await service.answerQuestion(row.id, {
      answers: [{ id: 'd1', selected: ['照准\r\r（推荐\r\r）'], custom: '同意另出\r\r 3\r\r 张' }],
    })
    const answered = JSON.parse(store.get('SELECT answer FROM questions WHERE id = ?', row.id).answer)
    assert.deepEqual(answered.answers[0].selected, ['照准（推荐）'])
    assert.equal(answered.answers[0].custom, '同意另出 3 张')
    assert.deepEqual(await pending, {
      answers: [{ id: 'd1', selected: ['照准（推荐）'], custom: '同意另出 3 张' }],
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('存量行读出时清洗：历史 CR 污染条目在视图里恢复单行', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'CR Legacy')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-legacy', botId: director.id, projectId: project.id })
    const pending = service.handleQuestionRequest({
      agent: { session: { id: 'sess-legacy' } },
      questions: [{ id: 'd1', question: '占位？', options: [{ label: '照准' }] }],
      signal: new AbortController().signal,
    }, () => {})
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    store.run(
      'UPDATE questions SET questions = ?, answer = ? WHERE id = ?',
      JSON.stringify([{ id: 'd1', question: 'D1\r\r 怪物牌四点照准\r\r？', options: [{ label: '照准\r\r（推荐\r\r）' }] }]),
      JSON.stringify({ answers: [{ id: 'd1', selected: ['照准\r\r（推荐\r\r）'] }] }),
      row.id,
    )
    const view = service.questionView(store.get('SELECT * FROM questions WHERE id = ?', row.id))
    assert.equal(view.questions[0].question, 'D1 怪物牌四点照准？')
    assert.equal(view.questions[0].options[0].label, '照准（推荐）')
    assert.deepEqual(view.answer.answers[0].selected, ['照准（推荐）'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('飞书出站边界去 CR：发出的文本不含行尾，句子不被劈开', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-cr-'))
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  const store = await new FeishuStore(join(dataDir, 'feishu-channel.sqlite')).open()
  const sent = []
  const transport = {
    async botInfo() { return { appId: 'cli_test', botId: 'ou_bot', brand: 'feishu' } },
    async reply(messageId, text) { sent.push(text); return { messageId: 'om_sent' } },
    async startEvents({ onReady }) { onReady?.() },
    stop() {},
  }
  try {
    const channel = new FeishuChannel({
      store,
      config: { feishu: { enabled: true, appId: 'cli_test', appSecret: 'secret' }, wechat: { enabled: false } },
      log: { info() {}, warn() {}, error() {} },
      transport,
    })
    await channel.start()
    await channel.sendFeishu('om_target', '选项: 1.照准\r\r（推荐\r\r） / 2.部分调整', 'idem-1')
    assert.equal(sent.length, 1)
    assert.ok(!sent[0].includes('\r'), '出站文本不得含 CR')
    assert.equal(sent[0], '选项: 1.照准（推荐） / 2.部分调整')
  } finally { await rm(root, { recursive: true, force: true }) }
})
