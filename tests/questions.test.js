// DSHBOTS-116：宿主 user-questions/request 瀑布 → 群聊提问卡片 → 工作台作答。
// 认领/透传、owner 鉴权、单选/多选作答映射、超时/abort/重启清理、密钥掩码、上下文隔离、prepend 抢跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

class StubRuntime {
  constructor(ctx = null) {
    this.ctx = ctx
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

// 宿主 cordis 瀑布流语义复刻（与 tests/approval.test.js 同一份）：监听器按注册先后排队，
// prepend 插到队首；waterfall 逐个 shift，先到的监听器不调用 next() 就截断后续链路。
class FakeCordisCtx {
  constructor() {
    this.hooks = new Map()
  }
  on(name, listener, options = {}) {
    const list = this.hooks.get(name) ?? []
    this.hooks.set(name, list)
    const record = { listener }
    if (options.prepend === true) list.unshift(record)
    else list.push(record)
    return () => {
      const index = list.indexOf(record)
      if (index >= 0) list.splice(index, 1)
    }
  }
  effect() { return () => {} }
  waterfall(carrier, name, req, inner) {
    const cbs = (this.hooks.get(name) ?? []).map(record => record.listener)
    const next = () => {
      const cb = cbs.shift() ?? inner
      return cb.call(carrier, req, () => next())
    }
    return next()
  }
  // 宿主服务可达性桩：deliverLateAnswer 经 ctx.get('userQuestions') 取回投服务。
  get(name) { return (this.services ?? {})[name] }
}

const now = () => new Date().toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// 未 await 的提问 Promise 超时后会 reject；不接住就变成 unhandled rejection 干扰测试进程。
// 需要断言的用例自行 await 返回值。
function ask(service, req, next = () => {}) {
  const pending = service.handleQuestionRequest(req, next)
  if (pending && typeof pending.catch === 'function') pending.catch(() => {})
  return pending
}

async function setup({ ctx = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-question-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime(ctx))
  await service.initialize()
  service.started = true
  // 全局压短提问等待：失败路径遗留的定时器不至于吊住测试进程；需要具体时长的用例自行覆盖。
  service.config.questionTimeoutMs = 60
  return { root, store, service, config }
}

function primeProject(store, service, name) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  return service.createProject({ name, key: name.replace(/[^A-Za-z]/g, '').slice(0, 8).toUpperCase(), ownerBotId: director.id })
}

function bindSession(store, { sessionId, botId, projectId, kind = 'project', taskId = null }) {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId, botId, projectId, kind, taskId, now(),
  )
}

function makeReq({ sessionId, questions, signal } = {}) {
  const controller = signal === undefined ? new AbortController() : null
  const items = questions ?? [{
    id: 'q1',
    question: '选择哪个分支？',
    options: [{ label: 'main' }, { label: 'dev' }],
  }]
  return {
    req: { agent: { session: { id: sessionId } }, questions: items, signal: signal ?? controller?.signal },
    controller,
  }
}

const questionOf = (store, id) => store.get('SELECT * FROM questions WHERE id = ?', id)
const messageOf = (store, questionId) => store.get('SELECT * FROM messages WHERE question_id = ?', questionId)

test('命中 bot 会话：落 pending 提问与 kind=question 消息，单选映射回宿主答案并写审计', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Question Claim')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-claim', botId: director.id, projectId: project.id })
    let nexted = false
    const { req } = makeReq({ sessionId: 'sess-claim' })
    const outcome = ask(service, req, () => { nexted = true })
    assert.equal(nexted, false)
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    assert.ok(row)
    assert.equal(JSON.parse(row.questions)[0].id, 'q1')
    const msg = messageOf(store, row.id)
    assert.equal(msg.kind, 'question')
    assert.ok(msg.body.includes('director'))
    // 单选：只回一个 label，映射成 {answers:[{id,selected}]}。
    const view = await service.answerQuestion(row.id, { answers: [{ id: 'q1', selected: ['dev'] }] })
    assert.equal(view.status, 'answered')
    assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['dev'] }] })
    assert.deepEqual(JSON.parse(questionOf(store, row.id).answer), { answers: [{ id: 'q1', selected: ['dev'] }] })
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'question.claim' AND target_id = ?", row.id))
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'question.answer' AND target_id = ?", row.id))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('未绑定会话与单聊绑定都透传：next() 接管，不落提问', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Question Pass')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-solo', botId: director.id, projectId: null })
    for (const sessionId of ['sess-unknown', 'sess-solo']) {
      let nexted = false
      const { req } = makeReq({ sessionId })
      const result = await service.handleQuestionRequest(req, () => { nexted = true; return { answers: [] } })
      assert.equal(nexted, true)
      assert.deepEqual(result, { answers: [] })
    }
    assert.equal(store.get('SELECT COUNT(*) AS n FROM questions').n, 0)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'question'").n, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('多选与自定义文本：selected 多 label + custom 原样回宿主', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Question Multi')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-multi', botId: director.id, projectId: project.id })
    const { req } = makeReq({
      sessionId: 'sess-multi',
      questions: [
        { id: 'a', question: '选多个？', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] },
        { id: 'b', question: '补充说明？', options: [{ label: 'ok' }] },
      ],
    })
    const outcome = ask(service, req)
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    const view = await service.answerQuestion(row.id, {
      answers: [
        { id: 'a', selected: ['x', 'z'] },
        { id: 'b', selected: [], custom: '按现状处理' },
      ],
    })
    assert.equal(view.status, 'answered')
    assert.deepEqual(await outcome, {
      answers: [
        { id: 'a', selected: ['x', 'z'] },
        { id: 'b', selected: [], custom: '按现状处理' },
      ],
    })
    // 漏项兜底：未提交的问题按空选补齐，避免宿主 BAD_ANSWER。
    const row2 = store.get("SELECT * FROM questions WHERE id != ? AND status = 'pending'", row.id) ?? null
    assert.equal(row2, null, '本用例只有一条提问')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('漏项兜底：前端少答的问题按空选补齐，宿主校验恰每问一项', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Question Gaps')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-gaps', botId: director.id, projectId: project.id })
    const { req } = makeReq({
      sessionId: 'sess-gaps',
      questions: [{ id: 'q1', question: '一？' }, { id: 'q2', question: '二？' }, { id: 'q3', question: '三？' }],
    })
    const outcome = ask(service, req)
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    await service.answerQuestion(row.id, { answers: [{ id: 'q2', selected: ['b'] }] })
    assert.deepEqual(await outcome, {
      answers: [
        { id: 'q1', selected: [] },
        { id: 'q2', selected: ['b'] },
        { id: 'q3', selected: [] },
      ],
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('bot actor 不能自答：forbidden，条目保持 pending', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Question Owner')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-owner', botId: director.id, projectId: project.id })
    const { req } = makeReq({ sessionId: 'sess-owner' })
    ask(service, req)
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    await assert.rejects(
      () => service.answerQuestion(row.id, { answers: [{ id: 'q1', selected: ['main'] }] }, { type: 'bot', id: director.id }),
      /仅项目负责人/,
    )
    assert.equal(questionOf(store, row.id).status, 'pending')
    service.settleQuestion(row.id, 'expired', null, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('超时到点：当轮 reject，条目置 timeout，迟到应答 conflict', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Question Timeout')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-timeout', botId: director.id, projectId: project.id })
    service.config.questionTimeoutMs = 30
    const { req } = makeReq({ sessionId: 'sess-timeout' })
    const outcome = ask(service, req)
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    await assert.rejects(() => outcome, /timed out/)
    assert.equal(questionOf(store, row.id).status, 'timeout')
    assert.ok(questionOf(store, row.id).ended_at)
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'question.timeout' AND target_id = ?", row.id))
    await assert.rejects(() => service.answerQuestion(row.id, { answers: [] }), /已处理/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('abort：条目置 expired 并当轮 reject（宿主 ask() 无信号竞态，挂起即死锁）', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Question Abort')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-abort', botId: director.id, projectId: project.id })
    const { req, controller } = makeReq({ sessionId: 'sess-abort' })
    const outcome = ask(service, req)
    outcome.catch(() => {})
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    controller.abort()
    await assert.rejects(() => outcome, /aborted/)
    assert.equal(questionOf(store, row.id).status, 'expired')
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'question.expired' AND target_id = ?", row.id))
    await assert.rejects(() => service.answerQuestion(row.id, { answers: [] }), /已处理/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('进程重启：残留 pending 一律置 timeout（宿主侧请求已消失）', async () => {
  const { root, store, service, config } = await setup()
  try {
    const project = await primeProject(store, service, 'Question Restart')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    store.run(
      `INSERT INTO questions(id, project_id, bot_id, questions, status, created_at, expires_at)
       VALUES ('qst_stale', ?, ?, ?, 'pending', ?, ?)`,
      project.id, director.id, JSON.stringify([{ id: 'q1', question: '旧问题' }]), now(), now(),
    )
    const reborn = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
    reborn.attachRuntime(new StubRuntime())
    await reborn.initialize()
    assert.equal(questionOf(store, 'qst_stale').status, 'timeout')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('问题文案落库前过密钥掩码', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Question Mask')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.upsertSecret({ scope: 'team', name: 'DEPLOY_TOKEN', purpose: 'test', value: 'sk-live-abc123' })
    bindSession(store, { sessionId: 'sess-mask', botId: director.id, projectId: project.id })
    const { req } = makeReq({
      sessionId: 'sess-mask',
      questions: [{ id: 'q1', question: '读取 sk-live-abc123 吗？', detail: 'sk-live-abc123' }],
    })
    ask(service, req)
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    assert.ok(!row.questions.includes('sk-live-abc123'))
    assert.ok(row.questions.includes('DEPLOY_TOKEN'))
    service.settleQuestion(row.id, 'expired', null, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('state 视图带 questions 与 pendingQuestions，提问消息不进 bot 上下文', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Question View')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-view', botId: director.id, projectId: project.id })
    const { req } = makeReq({ sessionId: 'sess-view' })
    ask(service, req)
    const view = await service.state(project.id)
    assert.ok(Array.isArray(view.questions) && view.questions.length === 1)
    assert.equal(view.questions[0].status, 'pending')
    assert.equal(view.questions[0].botName, 'director')
    assert.equal(view.pendingQuestions.count, 1)
    assert.equal(view.messages.filter(m => m.kind === 'question').length, 1)
    // 上下文隔离：bot 提示词只取 kind='text' 的消息，提问卡片绝不进上下文。
    const runtime = new DshRuntime({ ctx: { on() {} }, config: service.config, store, logger: { info() {}, warn() {}, error() {} } })
    const context = runtime.promptFor({ run: { kind: 'task' }, bot: director, project, task: null })
    assert.ok(!context.includes('【提问】'), '提问卡片不得进入 bot 提示词上下文')
    service.settleQuestion(view.questions[0].id, 'expired', null, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('任务运行会话的提问被插件认领：插件先于原生面板应答，卡片进群聊', async () => {
  const ctx = new FakeCordisCtx()
  const native = []
  ctx.on('user-questions/request', request => {
    native.push(request)
    return Promise.resolve({ answers: [] })
  })
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Question Task')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-task-run', botId: director.id, projectId: project.id })
    const { req } = makeReq({ sessionId: 'sess-task-run' })
    const outcome = ctx.waterfall({ agent: req.agent }, 'user-questions/request', req, () => Promise.resolve({ answers: [] }))
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    assert.ok(row, '任务运行会话的提问应被插件认领')
    assert.equal(row.session_id, 'sess-task-run')
    assert.equal(native.length, 0, '插件认领后原生提问面板不应再参与')
    assert.equal(messageOf(store, row.id).kind, 'question')
    const view = await service.answerQuestion(row.id, { answers: [{ id: 'q1', selected: ['main'] }] })
    assert.equal(view.status, 'answered')
    assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['main'] }] })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('未绑定会话仍透传：原生面板照常接管，不落提问', async () => {
  const ctx = new FakeCordisCtx()
  const native = []
  ctx.on('user-questions/request', request => {
    native.push(request)
    return Promise.resolve({ answers: [] })
  })
  const { root, store, service } = await setup({ ctx })
  try {
    const { req } = makeReq({ sessionId: 'sess-not-bound' })
    const outcome = await ctx.waterfall({ agent: req.agent }, 'user-questions/request', req, () => Promise.resolve({ answers: [] }))
    assert.equal(native.length, 1, '未绑定会话应透传给宿主原生界面')
    assert.deepEqual(outcome, { answers: [] })
    assert.equal(store.get('SELECT COUNT(*) AS n FROM questions').n, 0)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'question'").n, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// DSHBOTS-170：群聊提示词须告知 ask_user_question（能力补全的缺口在指引不在链路），
// 且指引边界与 questions.js 认领条件一致：项目绑定会话可用，单聊（solo）不可用。
// task 会话同样被认领，但本卡按最小改动只在群聊分支注入指引，此处钉住该口径。
test('提示词指引：群聊会话含 ask_user_question 指引，solo/task 提示词不含', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Question Prompt')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id, created_at, updated_at)
       VALUES ('t-prompt', ?, 9, '提问指引', 'in_progress', 'medium', 'user', 'u1', ?, ?)`,
      project.id, now(), now(),
    )
    bindSession(store, { sessionId: 'sess-prompt-chat', botId: director.id, projectId: project.id })
    bindSession(store, { sessionId: 'sess-prompt-task', botId: director.id, projectId: project.id, kind: 'task', taskId: 't-prompt' })
    bindSession(store, { sessionId: 'sess-prompt-solo', botId: director.id, projectId: null })
    const runtime = new DshRuntime({ ctx: { on() {} }, config: service.config, store, logger: { info() {}, warn() {}, error() {} } })

    const chat = runtime.systemPromptFor({ agent: { id: 'sess-prompt-chat' } })
    assert.match(chat, /ask_user_question/, '群聊提示词应指引 ask_user_question 工具')
    assert.match(chat, /question card in the project group that only the project owner may answer/, '指引应说明卡片去向与作答权')
    assert.match(chat, /not in solo sessions/, '指引应写明单聊会话不可用')

    assert.doesNotMatch(
      runtime.systemPromptFor({ agent: { id: 'sess-prompt-solo' } }),
      /ask_user_question/,
      'solo 会话走 soloPromptFor，不应出现 ask_user_question 指引',
    )
    assert.doesNotMatch(
      runtime.systemPromptFor({ agent: { id: 'sess-prompt-task' } }),
      /ask_user_question/,
      '本卡口径：task 会话提示词不注入 ask_user_question 指引（认领链路不受影响）',
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

// DSHBOTS-177：宿主 timed 前台等待到期（ASK_TIMED_OUT abort）宿主语义是 {pending:true}、
// 问题保持可答——插件不得杀卡；窗口内迟到作答经宿主 userQuestions.answer 回投原 agent。
test('timed abort：前台等待断开但条目保持可答，迟到答案经 userQuestions.answer 回投', async () => {
  const ctx = new FakeCordisCtx()
  const answerCalls = []
  ctx.services = { userQuestions: { answer: async (...args) => { answerCalls.push(args); return true } } }
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Question Timed')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-timed', botId: director.id, projectId: project.id })
    const { req, controller } = makeReq({ sessionId: 'sess-timed' })
    req.wait = { callId: 'call-timed-1', timed: true }
    const outcome = ask(service, req)
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    assert.equal(row.call_id, 'call-timed-1')
    // 宿主 askTimed 到期：signal 以 ASK_TIMED_OUT reason abort（UserQuestionError 实例或序列化 record 同形）。
    controller.abort({ name: 'UserQuestionError', message: 'ask_user_question timed out before the user answered', code: 'ASK_TIMED_OUT' })
    await assert.rejects(() => outcome, /foreground wait timed out/)
    // 卡片不死：条目仍 pending（未写 expired 审计），窗口内可答。
    assert.equal(questionOf(store, row.id).status, 'pending')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'question.expired' AND target_id = ?", row.id).n, 0)
    const view = await service.answerQuestion(row.id, { answers: [{ id: 'q1', selected: ['dev'] }] })
    assert.equal(view.status, 'answered')
    // 迟到答案回投：answer(agent, callId, {answers})，agent 即认领时请求里的 agent。
    await sleep(5)
    assert.equal(answerCalls.length, 1)
    assert.equal(answerCalls[0][0], req.agent)
    assert.equal(answerCalls[0][1], 'call-timed-1')
    assert.deepEqual(answerCalls[0][2], { answers: [{ id: 'q1', selected: ['dev'] }] })
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'question.steer' AND target_id = ?", row.id))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('timed abort 后窗口到点：条目置 timeout，迟到应答 conflict，不回投', async () => {
  const ctx = new FakeCordisCtx()
  const answerCalls = []
  ctx.services = { userQuestions: { answer: async (...args) => { answerCalls.push(args); return true } } }
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Question Timed Window')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-timed-win', botId: director.id, projectId: project.id })
    service.config.questionTimeoutMs = 40
    const { req, controller } = makeReq({ sessionId: 'sess-timed-win' })
    req.wait = { callId: 'call-timed-2', timed: true }
    const outcome = ask(service, req)
    const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
    controller.abort({ name: 'UserQuestionError', message: 'ask_user_question timed out before the user answered', code: 'ASK_TIMED_OUT' })
    await assert.rejects(() => outcome, /foreground wait timed out/)
    assert.equal(questionOf(store, row.id).status, 'pending')
    // 插件可答窗口（questionTimeoutMs）到点后不可答。
    await sleep(90)
    assert.equal(questionOf(store, row.id).status, 'timeout')
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'question.timeout' AND target_id = ?", row.id))
    await assert.rejects(() => service.answerQuestion(row.id, { answers: [] }), /已处理/)
    assert.equal(answerCalls.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('非 timed abort（其它 reason code / 无 reason / 缺 callId）一律立即置 expired', async () => {
  const scenarios = [
    {
      label: 'timed 请求遇到非 ASK_TIMED_OUT reason（轮次取消）',
      wait: () => ({ callId: 'call-plain', timed: true }),
      abort: controller => controller.abort({ name: 'UserQuestionError', message: 'ask_user_question was aborted before the user answered', code: 'ASK_ABORTED' }),
    },
    {
      label: '无 reason 的裸 abort',
      wait: () => ({ callId: 'call-plain' }),
      abort: controller => controller.abort(),
    },
    {
      label: 'ASK_TIMED_OUT reason 但请求未带 callId',
      wait: () => null,
      abort: controller => controller.abort({ name: 'UserQuestionError', message: 'ask_user_question timed out before the user answered', code: 'ASK_TIMED_OUT' }),
    },
  ]
  for (const scenario of scenarios) {
    const ctx = new FakeCordisCtx()
    const answerCalls = []
    ctx.services = { userQuestions: { answer: async (...args) => { answerCalls.push(args); return true } } }
    const { root, store, service } = await setup({ ctx })
    try {
      const project = await primeProject(store, service, 'Question Not Timed')
      const director = store.get("SELECT * FROM bots WHERE name = 'director'")
      bindSession(store, { sessionId: 'sess-not-timed', botId: director.id, projectId: project.id })
      const { req, controller } = makeReq({ sessionId: 'sess-not-timed' })
      const wait = scenario.wait()
      if (wait) req.wait = wait
      const outcome = ask(service, req)
      const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
      scenario.abort(controller)
      await assert.rejects(() => outcome, /aborted/)
      assert.equal(questionOf(store, row.id).status, 'expired', scenario.label)
      assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'question.expired' AND target_id = ?", row.id), scenario.label)
      await assert.rejects(() => service.answerQuestion(row.id, { answers: [] }), /已处理/)
      assert.equal(answerCalls.length, 0, scenario.label)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test('迟到回投失败（run 已结束/宿主不再认领）：答案仍落库 answered，审计 steer_failed，不向作答方抛错', async () => {
  for (const behavior of [
    {
      label: 'answer 抛 CALLER_NOT_LIVE（run 已结束）',
      answer: async () => {
        const error = new Error('human interaction requires the exact live calling agent')
        error.code = 'CALLER_NOT_LIVE'
        throw error
      },
    },
    { label: 'answer 返回 false（宿主不再认领）', answer: async () => false },
  ]) {
    const ctx = new FakeCordisCtx()
    ctx.services = { userQuestions: { answer: behavior.answer } }
    const { root, store, service } = await setup({ ctx })
    try {
      const project = await primeProject(store, service, 'Question Steer Fail')
      const director = store.get("SELECT * FROM bots WHERE name = 'director'")
      bindSession(store, { sessionId: 'sess-steer-fail', botId: director.id, projectId: project.id })
      const { req, controller } = makeReq({ sessionId: 'sess-steer-fail' })
      req.wait = { callId: 'call-steer-fail', timed: true }
      const outcome = ask(service, req)
      const row = store.get("SELECT * FROM questions WHERE status = 'pending'")
      controller.abort({ name: 'UserQuestionError', message: 'ask_user_question timed out before the user answered', code: 'ASK_TIMED_OUT' })
      await assert.rejects(() => outcome, /foreground wait timed out/)
      // 投递失败不影响作答结果：行照常 answered，answerQuestion 不抛错。
      const view = await service.answerQuestion(row.id, { answers: [{ id: 'q1', selected: ['main'] }] })
      assert.equal(view.status, 'answered', behavior.label)
      await sleep(5)
      assert.equal(questionOf(store, row.id).status, 'answered', behavior.label)
      const failed = store.get("SELECT * FROM audit_log WHERE action = 'question.steer_failed' AND target_id = ?", row.id)
      assert.ok(failed, behavior.label)
      assert.ok(failed.data_json.includes('call-steer-fail'), behavior.label)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})
