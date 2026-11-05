// DSHBOTS-116 群聊提问：宿主 user-questions/request waterfall 的插件侧应答器。
// 只认领 session_bindings 命中且绑定到项目的 bot 会话；其余 next() 透传（人类会话提问继续走原生界面）。
// 应答权仅项目负责人（type=user）持有，bot 一律 forbidden 不能自答；pending 之外拒绝重复应答，动作写审计。
// DSHBOTS-177：宿主 timed 前台等待到期（ASK_TIMED_OUT abort）不杀卡——条目保持可答至插件
// questionTimeoutMs 窗口，窗口内迟到作答经宿主 userQuestions.answer 回投原 agent；其余 abort 立即失效。
// 注意：本域自管迁移（db.js 已贴 800 行上限，一行不加），手法与 approvals.js 一致。
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { id, jsonParse, nowIso, text as textValue } from '../util.js'

const QUESTIONS_DDL = `
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  bot_id TEXT NOT NULL,
  session_id TEXT,
  call_id TEXT,
  questions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  answered_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_status_idx ON questions(status, created_at);
CREATE INDEX IF NOT EXISTS questions_project_idx ON questions(project_id, created_at);
`

// 迁移体全在本文件：建表、messages 加 question_id 列、幂等登记迁移名。
// 重启清理也在此——宿主侧请求随进程消失，不可能再被应答，库里残留的 pending 一律置 timeout。
export function ensureQuestionSchema(store) {
  store.exec(QUESTIONS_DDL)
  const messageColumns = store.all('PRAGMA table_info(messages)').map(column => column.name)
  if (!messageColumns.includes('question_id')) {
    store.exec('ALTER TABLE messages ADD COLUMN question_id TEXT')
  }
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    'questions_table', nowIso(),
  )
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    'messages_question_link', nowIso(),
  )
  store.run(
    "UPDATE questions SET status = 'timeout', ended_at = ? WHERE status = 'pending'",
    nowIso(),
  )
}

// 问题条目清洗：文案统一过密钥掩码（会进群聊与 bot 可见范围），并夹取长度防单条撑爆卡片。
// intent 只保留 plan-review 的展示字段；未知 intent 一律按通用选项列表渲染（协议允许）。
function cleanQuestionItem(item) {
  const cleaned      = {
    id: String(item?.id ?? '').slice(0, 100),
    question: textValue(item?.question, 4_000),
  }
  if (item?.detail) cleaned.detail = textValue(item.detail, 20_000)
  if (item?.header) cleaned.header = textValue(item.header, 200)
  if (Array.isArray(item?.options)) {
    cleaned.options = item.options.slice(0, 20).map(option => {
      const row      = { label: textValue(option?.label, 200) }
      if (option?.description) row.description = textValue(option.description, 1_000)
      return row
    })
  }
  if (item?.multiSelect === true) cleaned.multiSelect = true
  if (item?.intent?.kind === 'plan-review') {
    cleaned.intent = { kind: 'plan-review', approve: textValue(item.intent.approve, 200) }
    if (item.intent.callId) cleaned.intent.callId = String(item.intent.callId)
  }
  return cleaned
}

export const questionsMethods = {
  // 由 core.attachRuntime 调用：注册宿主事件。runtime.ctx 不存在（测试桩）时跳过注册，
  // 但 pending Map 无条件初始化——handleQuestionRequest 直调（测试）也依赖它。
  questionsAttach(runtime) {
    this.questionPending = new Map()
    if (this.questionsAttached || !runtime?.ctx?.on) return
    this.questionsAttached = true
    // prepend：宿主 user-questions/request 是「按注册序」的瀑布流——先执行的监听器若不调用 next()，
    // 就截断后面整条链路。web bundle 的 dsh-client-ui-user-questions 把请求交给 DSH 原生提问面板，
    // 面板给出答案后直接 resolve 且不调 next()；插件若排在其后就永远收不到请求，提问全落到原生界面。
    // 插到队首后：命中项目绑定的 bot 会话由插件自己应答，未命中的照旧 next() 透传给原生界面。
    const off = runtime.ctx.on('user-questions/request', (req, next) => this.handleQuestionRequest(req, next), { prepend: true })
    runtime.ctx.effect?.(() => () => {
      off?.()
      for (const pending of this.questionPending.values()) clearTimeout(pending.timer)
      this.questionPending.clear()
    }, 'dsh-team: user question request binding')
  },

  // waterfall 监听器：DSHBOTS-190 起，提问能力收紧为项目总监（owner bot）专属。
  // 未绑定会话无法归因，保持透传原生界面；命中 bot 会话一律先过所有权闸门，不再透传——
  // 透传会把提问落回宿主面板，收紧形同虚设。拒绝以 rejected promise 回宿主，错误文案
  // 即调用 bot 收到的 ask_user_question 工具结果。
  async handleQuestionRequest(req, next) {
    const sessionId = req?.agent?.session?.id
    // bindingOfSession 在 DshRuntime 原型上，服务层拿不到 this 绑定，这里直查同款 SQL。
    const binding = sessionId
      ? this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
      : undefined
    if (!binding) return next()

    if (!binding.project_id) {
      return Promise.reject(new Error(
        'ask_user_question 仅限项目总监 Bot 在项目群中使用；当前是单聊会话。如需向用户提问，请在项目群中由总监 Bot 发起。',
      ))
    }

    const store = this.store
    const bot = store.get('SELECT * FROM bots WHERE id = ?', binding.bot_id)
    const project = store.get('SELECT * FROM projects WHERE id = ?', binding.project_id)
    if (!bot || !project) {
      return Promise.reject(new Error(
        'ask_user_question 会话绑定失效，无法确认项目归属；请在项目群中由总监 Bot 发起提问。',
      ))
    }
    if (project.owner_bot_id !== binding.bot_id) {
      return Promise.reject(new Error(
        `ask_user_question 仅限项目总监 Bot 使用；${bot.name} 不是本项目总监。需要用户决策时，请把问题交给总监 Bot 发起。`,
      ))
    }

    const items = (Array.isArray(req.questions) ? req.questions : []).map(cleanQuestionItem)
      .filter(item => item.id && item.question)
    // 空请求不认领：没有可渲染的内容，交回原生界面按自身校验处理。
    if (items.length === 0) return next()

    const run = store.get('SELECT id FROM runs WHERE session_id = ? ORDER BY queued_at DESC LIMIT 1', sessionId)
    const timeoutMs = this.config.questionTimeoutMs
    const createdAt = nowIso()
    const questionId = id('qst')
    const callId = req.wait?.callId ? String(req.wait.callId) : null
    const masked = items.map(item => ({
      ...item,
      question: this.maskSecretValues(item.question),
      detail: item.detail ? this.maskSecretValues(item.detail) : undefined,
      header: item.header ? this.maskSecretValues(item.header) : undefined,
      options: item.options?.map(option => ({
        ...option,
        label: this.maskSecretValues(option.label),
        description: option.description ? this.maskSecretValues(option.description) : undefined,
      })),
    }))

    store.run(
      `INSERT INTO questions(id, project_id, run_id, bot_id, session_id, call_id, questions, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      questionId, project.id, run?.id ?? null, bot.id, sessionId, callId,
      JSON.stringify(masked), createdAt, new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
    )

    // 认领审计：谁（bot）在哪个会话替宿主提问，便于回溯「这条提问为何出现在群聊」。
    this.audit({ type: 'bot', id: bot.id }, 'question.claim', 'question', questionId, {
      sessionId, callId, count: masked.length,
    })

    // 群聊里写一条提问卡片消息：状态渲染时查 questions 表，消息体只是纯文本兜底，不承载状态。
    const group = this.groupOf(project.id)
    store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, kind, question_id, created_at)
       VALUES (?, ?, ?, 'system', ?, ?, '[]', 'question', ?, ?)`,
      id('msg'), project.id, group?.id ?? null, bot.id,
      `【提问】${bot.name} 发起提问（${masked.length} 个问题）`, questionId, createdAt,
    )

    return new Promise((resolve, reject) => {
      this.questionPending ??= new Map()
      const timer = setTimeout(() => {
        // 插件侧超时=可答窗口关闭：当轮 reject、条目置 timeout（timed 断开后的迟到作答同样在此截止）。
        this.settleQuestion(questionId, 'timeout', null, null, 'ask_user_question timed out before the user answered')
      }, timeoutMs)
      this.questionPending.set(questionId, { resolve, reject, timer })
      // 宿主侧中止分两种：timed 前台等待到期（reason.code === 'ASK_TIMED_OUT'）宿主语义是
      // {pending:true}、问题保持可答（迟到答案以 answer_to_pending_question 回投）——只断开
      // 前台等待，卡片活到插件窗口；轮次取消/断连等其它 abort 没有迟到作答路径，立即失效。
      req.signal?.addEventListener('abort', () => {
        if (req.signal.reason?.code === 'ASK_TIMED_OUT' && req.agent && callId) {
          this.detachQuestionWait(questionId, req.agent, callId)
        } else {
          this.settleQuestion(questionId, 'expired', null, null, 'ask_user_question aborted')
        }
      }, { once: true })
    })
  },

  // 统一结算：清定时器、出 pending 表、写终态。hostAnswer 非空才向宿主应答；
  // reason 非空则当轮 reject（超时/中止），否则静默收尾（防未处理 rejection）。
  settleQuestion(questionId, status, hostAnswer, answeredBy, reason = null) {
    const pending = this.questionPending?.get(questionId)
    if (pending) {
      clearTimeout(pending.timer)
      this.questionPending.delete(questionId)
    }
    this.store.run(
      `UPDATE questions SET status = ?, answer = ?, answered_by = ?, ended_at = ?
       WHERE id = ? AND status = 'pending'`,
      status, hostAnswer ? JSON.stringify(hostAnswer) : null, answeredBy ?? null, nowIso(), questionId,
    )
    if (!pending) return
    if (hostAnswer) {
      pending.resolve(hostAnswer)
      // timed 断开后的迟到答案：前台 promise 早已 settle（这里的 resolve 是静默 no-op），
      // 答案改经宿主 userQuestions.answer 回投原 agent（见 detachQuestionWait）。
      pending.lateAnswer?.(hostAnswer)
    } else if (reason) {
      pending.reject(new Error(reason))
    }
    // 终态审计：超时/中止都不是人的动作，归因 system；已答由 answerQuestion 单独审计（带答案内容）。
    if (status === 'timeout' || status === 'expired') {
      this.audit({ type: 'system', id: 'system' }, `question.${status}`, 'question', questionId, { reason })
    }
  },

  // 宿主 timed 前台等待到期（ASK_TIMED_OUT abort）：宿主把本次 rejection 映射成 {pending:true}，
  // 问题在宿主侧仍是 continued、可迟到作答。这里只断开前台等待（宿主 ask 无信号竞态，不 settle
  // 就挂死），问题行保持 pending、插件窗口计时器继续走；窗口内迟到作答经 deliverLateAnswer
  // 以 answer_to_pending_question user message 回投原 agent。
  detachQuestionWait(questionId, agent, callId) {
    const pending = this.questionPending?.get(questionId)
    if (!pending) return
    pending.lateAnswer = hostAnswer => this.deliverLateAnswer(questionId, agent, callId, hostAnswer)
    pending.reject(new Error('ask_user_question foreground wait timed out; question stays answerable'))
  },

  // 迟到答案回投：宿主前台等待已断开后用户才作答，waterfall promise 早已 settle，答案只能经
  // 宿主 userQuestions.answer(agent, callId, answers) steer 回原 agent。run 已结束
  // （CALLER_NOT_LIVE 等抛错）或宿主不再认领（返回 false）时投递失败——答案已照常落库置
  // answered，这里只补审计，不改状态、不向作答方抛错。
  async deliverLateAnswer(questionId, agent, callId, hostAnswer) {
    try {
      const userQuestions = this.runtime?.ctx?.get?.('userQuestions')
      if (!userQuestions || typeof userQuestions.answer !== 'function') {
        throw new Error('userQuestions service unavailable')
      }
      const accepted = await userQuestions.answer(agent, callId, hostAnswer)
      if (accepted !== true) throw new Error('question no longer answerable at host')
      this.audit({ type: 'system', id: 'system' }, 'question.steer', 'question', questionId, { callId })
    } catch (error     ) {
      this.audit({ type: 'system', id: 'system' }, 'question.steer_failed', 'question', questionId, {
        callId,
        reason: error?.message ?? String(error),
      })
    }
  },

  // 群聊按钮入口（api action question_answer）。鉴权：仅项目负责人（本地工作台用户）可作答，
  // bot 一律拒绝——提问是人对 bot 的答复，bot 不能自答（配合上下文隔离双保险）。动作写审计。
  async answerQuestion(questionId, submitted, actor = this.actor()) {
    if (actor?.type !== 'user') throw forbidden('仅项目负责人可应答提问，bot 不能自答')
    const row = this.store.get('SELECT * FROM questions WHERE id = ?', questionId)
    if (!row) throw notFound('提问不存在')
    if (row.status !== 'pending') throw conflict('提问已处理')
    const items = jsonParse(row.questions, [])
    if (!Array.isArray(items) || items.length === 0) throw badRequest('提问内容缺失')
    // 以库内问题清单为准拼装应答批次：每个问题恰好一项，未提交的按空选处理，
    // 避免前端漏项导致宿主 BAD_ANSWER（宿主校验「每个问题恰好一次」）。
    const given = new Map(
      (Array.isArray(submitted?.answers) ? submitted.answers : [])
        .map(item => [String(item?.id), item]),
    )
    const answers = items.map(item => {
      const answer = given.get(String(item.id))       
      const selected = (Array.isArray(answer?.selected) ? answer.selected : [])
        .map(value => String(value)).filter(Boolean).slice(0, 20)
      const custom = answer?.custom ? String(answer.custom).slice(0, 2_000) : undefined
      return { id: String(item.id), selected, ...(custom ? { custom } : {}) }
    })
    const decidedBy = `${actor.type}:${actor.id}`
    const hostAnswer = { answers }
    this.settleQuestion(questionId, 'answered', hostAnswer, decidedBy)
    this.audit(actor, 'question.answer', 'question', questionId, { botId: row.bot_id, answers })
    return this.questionView(this.store.get('SELECT * FROM questions WHERE id = ?', questionId))
  },

  questionView(row) {
    const bot = this.store.get('SELECT name FROM bots WHERE id = ?', row.bot_id)
    const expiresAt = Date.parse(row.expires_at)
    return {
      ...row,
      // DSHBOTS-190：answered 终态必须暴露 answered_at（=ended_at）。客户端
      // preserveAnsweredQuestions 以 previous.questions[].answered_at 为本地终态键——
      // 视图缺该字段时，提交作答后的服务端终态覆盖乐观对象即丢键，下一轮旧 pending
      // 轮询快照会把「已回答」卡闪回问题卡；提问卡 pill 的作答时间戳也读它。
      ...(row.status === 'answered' ? { answered_at: row.ended_at } : {}),
      questions: jsonParse(row.questions, []),
      answer: jsonParse(row.answer, null),
      botName: bot?.name ?? 'Bot',
      remainingMs: row.status === 'pending'
        ? Math.max(0, (Number.isFinite(expiresAt) ? expiresAt : Date.parse(row.created_at) + this.config.questionTimeoutMs) - Date.now())
        : 0,
    }
  },

  // state 视图的提问条目：pending 在前（按创建时间倒序），已决的跟在后面供卡片回显结果。
  questionsForProject(projectId) {
    const rows = this.store.all(
      `SELECT * FROM questions WHERE project_id = ?
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 30`,
      projectId,
    )
    return rows.map(row => this.questionView(row))
  },

  // 全局待答视图：跨项目聚合 status='pending'，按创建时间倒序。
  // count 是全库 pending 总数（徽标口径，已决一律不计），items 最多 50 条供顶部入口列明细。
  questionsPending(limit = 50) {
    const rows = this.store.all(
      `SELECT q.*, p.name AS project_name FROM questions q LEFT JOIN projects p ON p.id = q.project_id
       WHERE q.status = 'pending' ORDER BY q.created_at DESC LIMIT ?`,
      limit,
    )
    const count = Number(this.store.get("SELECT COUNT(*) AS count FROM questions WHERE status = 'pending'")?.count ?? 0)
    return {
      count,
      items: rows.map(row => ({ ...this.questionView(row), projectName: row.project_name ?? '' })),
    }
  },
}
