// DSHBOTS-215：微信问答回路守门。
// 覆盖：①提问/审批转发微信（纯文本、带 token、无 emoji）；②微信答复按 token 路由回原条目并标识来源 user:wechat；
// ③选项/自由文本解析（单题直回、多题按序号/顺序）；④无法解析时整单拒绝不误答；⑤commands 层「答/批」路由不与普通对话混淆。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { ensureQuestionSchema } from '../src/services/questions.js'
import { ensureApprovalSchema } from '../src/services/approvals.js'
import { handleCommand } from '../src/wechat/commands.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-qa-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace,
    dataDir: join(root, 'data'),
    skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0,
    schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  ensureQuestionSchema(store)
  ensureApprovalSchema(store)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime() as any)
  await service.initialize()
  service.started = true
  return { root, store, service }
}

function insertPending(store, table, row) {
  const createdAt = new Date().toISOString()
  if (table === 'questions') {
    store.run(
      `INSERT INTO questions(id, project_id, bot_id, session_id, questions, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      row.id, row.projectId, row.botId, row.sessionId, JSON.stringify(row.items), createdAt,
      new Date(Date.parse(createdAt) + 60_000).toISOString(),
    )
    return
  }
  store.run(
    `INSERT INTO approvals(id, project_id, bot_id, session_id, tool_name, reason, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    row.id, row.projectId, row.botId, row.sessionId, row.toolName, row.reason, createdAt,
    new Date(Date.parse(createdAt) + 60_000).toISOString(),
  )
}

const NO_EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u

test('微信问答回路：提问转发带 token（纯文本无 emoji），答复按 token 路由回原问题并标识来源', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'QA Demo', key: 'QA', ownerBotId: director.id })
    const project = store.get("SELECT * FROM projects WHERE key = 'QA'")
    const pushed: string[] = []
    ;(service as any).wechat = { notify: (text: string) => pushed.push(text) }

    const items = [
      { id: 'q1', question: '用哪个方案？', options: [{ label: '方案一' }, { label: '方案二' }] },
      { id: 'q2', question: '补充说明', options: [] },
    ]
    insertPending(store, 'questions', { id: 'qstABC123XYZ', projectId: project.id, botId: director.id, sessionId: 'sess-1', items })

    assert.equal(service.wechatQuestion(project, { id: 'qstABC123XYZ', bot_name: director.name }, items), true)
    assert.equal(pushed.length, 1)
    assert.ok(pushed[0].includes('123xyz'), '转发文本必须带短 token')
    assert.ok(!NO_EMOJI.test(pushed[0]), '微信出站禁用 emoji')
    assert.ok(pushed[0].includes('答 123xyz'), '转发文本必须给出回复格式')

    const receipt = await service.wechatAnswerQuestion('123xyz', '1:方案一;2:今晚发', 'QA')
    assert.ok(receipt.includes('已收到答复'))
    const row = store.get('SELECT * FROM questions WHERE id = ?', 'qstABC123XYZ')
    assert.equal(row.status, 'answered')
    assert.equal(row.answered_by, 'user:wechat', '答复来源必须标识为微信，防与普通指令混淆')
    assert.deepEqual(JSON.parse(row.answer), {
      answers: [
        { id: 'q1', selected: ['方案一'] },
        { id: 'q2', selected: [], custom: '今晚发' },
      ],
    })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('微信答复：单题直回选项文字/序号；token 未命中或选项无法解析时整单拒绝', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'QA Demo 2', key: 'QB', ownerBotId: director.id })
    const project = store.get("SELECT * FROM projects WHERE key = 'QB'")
    ;(service as any).wechat = { notify() {} }
    const items = [{ id: 'q1', question: '方案？', options: [{ label: '方案一' }, { label: '方案二' }] }]
    insertPending(store, 'questions', { id: 'qstZZZ999WWW', projectId: project.id, botId: director.id, sessionId: 'sess-2', items })

    // 选项文字精确命中
    await service.wechatAnswerQuestion('999www', '方案二', 'QB')
    let row = store.get('SELECT * FROM questions WHERE id = ?', 'qstZZZ999WWW')
    assert.equal(row.status, 'answered')
    assert.deepEqual(JSON.parse(row.answer).answers, [{ id: 'q1', selected: ['方案二'] }])

    // 未命中 token：不误答任何条目
    insertPending(store, 'questions', { id: 'qstAAA111BBB', projectId: project.id, botId: director.id, sessionId: 'sess-3', items })
    const missed = await service.wechatAnswerQuestion('nope00', '方案一', 'QB')
    assert.ok(missed.includes('没有匹配的待答提问'))
    assert.equal(store.get('SELECT status FROM questions WHERE id = ?', 'qstAAA111BBB').status, 'pending')

    // 选项无法解析：整单拒绝，条目保持 pending
    const bad = await service.wechatAnswerQuestion('111bbb', '随便写', 'QB')
    assert.ok(bad.includes('无法解析'))
    assert.equal(store.get('SELECT status FROM questions WHERE id = ?', 'qstAAA111BBB').status, 'pending')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('微信审批回路：转发带 token，允许/拒绝按 token 路由回原审批', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'QA Demo 3', key: 'QC', ownerBotId: director.id })
    const project = store.get("SELECT * FROM projects WHERE key = 'QC'")
    const pushed: string[] = []
    ;(service as any).wechat = { notify: (text: string) => pushed.push(text) }
    insertPending(store, 'approvals', {
      id: 'aprYYY888VVV', projectId: project.id, botId: director.id, sessionId: 'sess-4',
      toolName: 'bash', reason: '执行部署命令',
    })

    assert.equal(service.wechatApproval(project, { id: 'aprYYY888VVV', bot_name: director.name, tool_name: 'bash', reason: '执行部署命令' }), true)
    assert.ok(pushed[0].includes('888vvv'))
    assert.ok(!NO_EMOJI.test(pushed[0]))

    const receipt = await service.wechatDecideApproval('888vvv', 'allow', 'QC')
    assert.ok(receipt.includes('已收到答复'))
    const row = store.get('SELECT * FROM approvals WHERE id = ?', 'aprYYY888VVV')
    assert.equal(row.status, 'allowed')
    assert.equal(row.decided_by, 'user:wechat')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('commands 层：「答/批」按 token 路由到问答回路，不进普通对话', async () => {
  const calls: any[] = []
  const service: any = {
    stateView: () => ({ projects: [] }),
    async wechatAnswerQuestion(token, body, fallbackKey) {
      calls.push({ kind: 'answer', token, body, fallbackKey })
      return `已收到答复（${token}）`
    },
    async wechatDecideApproval(token, decision, fallbackKey) {
      calls.push({ kind: 'approval', token, decision, fallbackKey })
      return `已收到答复（${token}）`
    },
    async wechatChat() {
      calls.push({ kind: 'chat' })
      return { project: { key: 'web', name: 'Web' } }
    },
  }
  const ctx = { boundKey: 'web' }

  assert.ok((await handleCommand(service, '答 abc123 1:选项一', ctx)).includes('已收到答复'))
  assert.deepEqual(calls.at(-1), { kind: 'answer', token: 'abc123', body: '1:选项一', fallbackKey: 'web' })

  assert.ok((await handleCommand(service, '批 def456 允许', ctx)).includes('已收到答复'))
  assert.deepEqual(calls.at(-1), { kind: 'approval', token: 'def456', decision: 'allow', fallbackKey: 'web' })

  assert.ok((await handleCommand(service, '批 def456 拒绝', ctx)).includes('已收到答复'))
  assert.equal(calls.at(-1).decision, 'reject')

  // 缺正文给格式提示，不路由
  const help = await handleCommand(service, '答 abc123', ctx)
  assert.ok(help.includes('答 <token>'))
  assert.equal(calls.length, 3, '缺正文不得触发路由')

  // 普通文本仍走对话路由，不被问答回路截获
  await handleCommand(service, '答案是什么', ctx)
  assert.equal(calls.at(-1).kind, 'chat', '非 token 形态的普通文本不得被误判为答复')
})
