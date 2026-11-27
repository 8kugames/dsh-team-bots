// 运行提示词「静态段前置、变化段后置」守门。
// 前缀缓存按最长公共前缀匹配：静态指令段若排在每卡变化字段（标题/描述/状态）之后，
// 跨卡派发会在描述处分叉，固定段永远吃不到缓存。本文件按分支锁定段序：
// 任何把静态段挪回变化段之后的改动都会在这里转红。语义口径见 src/services/runtime/prompt.js 头注。
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
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prefix-order-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  config.agentTeam = true // 拉开 parallel 段，锁定其在静态区的位置
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const devView = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const projectView = await service.createProject({ name: 'Order', key: 'ORD', ownerBotId: director.id, memberIds: [devView.id] })
  const dev = store.get('SELECT * FROM bots WHERE id = ?', devView.id)
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const runtime = new DshRuntime({
    ctx: null, config, store, logger: { info() {}, warn() {}, error() {} },
    chatStores: { forRun: run => service.runChatStore(run) },
  })
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, runtime, director, dev, project, config, close }
}

const rowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

// 顺序断言：每个 marker 都在场且严格递增（后一段必须排在前一段之后）。
function assertAscending(prompt, markers, label) {
  let prev = -1
  for (const marker of markers) {
    const at = prompt.indexOf(marker)
    assert.ok(at >= 0, `${label}：缺少片段 ${JSON.stringify(marker)}`)
    assert.ok(at > prev, `${label}：${JSON.stringify(marker)}（pos=${at}）必须排在 ${JSON.stringify(marker === markers[0] ? '开头' : markers[markers.indexOf(marker) - 1])}（pos=${prev}）之后`)
    prev = at
  }
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

test('任务派发分支：纪律段+交付样板+parallel 全部先于每卡字段，时效/豁免/恢复段殿后', async () => {
  const t = await setup()
  try {
    const actor = { type: 'user', id: t.service.localUserId }
    const card = await t.service.createTask(
      { projectId: t.project.id, title: '顺序卡', priority: 'urgent', time_budget_minutes: 30, writeScopes: ['src/a.js'] },
      actor,
    )
    const prompt = t.runtime.promptFor({
      run: { kind: 'task', recovery: 1 }, bot: t.dev, project: t.project, task: rowOf(t.store, card.id),
    })
    assertAscending(prompt, [
      '# Subtask discipline',
      'Do the task in the project workspace',
      '# Parallel work inside this task',
      `# Assigned task ORD-${card.number}`,
      'Description:',
      '# Time budget',
      '# Urgent exemption',
      '# Recovery note',
    ], '任务派发分支')
    // 交付样板两段紧随纪律段：静态区内部相对顺序同样锁定，防止段内漂移。
    assertAscending(prompt, ['List every subtask KEY-N in the closing report', 'Do the task in the project workspace'], '静态区内部')
  } finally { await t.close() }
})

test('缓存收益守门：两张不同卡的公共前缀必须覆盖纪律段与交付样板（静态段可跨卡复用）', async () => {
  const t = await setup()
  try {
    const actor = { type: 'user', id: t.service.localUserId }
    const cardA = await t.service.createTask(
      { projectId: t.project.id, title: '甲卡完全不同的标题', description: '甲卡描述完全不同。', writeScopes: ['src/a/'] },
      actor,
    )
    const cardB = await t.service.createTask(
      { projectId: t.project.id, title: '乙卡毫无交集的标题', description: '乙卡描述毫无交集。', writeScopes: ['src/b/'] },
      actor,
    )
    const promptOf = (card) => t.runtime.promptFor({
      run: { kind: 'task' }, bot: t.dev, project: t.project, task: rowOf(t.store, card.id),
    })
    const a = promptOf(cardA)
    const b = promptOf(cardB)
    const prefix = a.slice(0, commonPrefixLen(a, b))
    assert.ok(prefix.includes('# Subtask discipline'), '公共前缀必须覆盖纪律段，否则静态段吃不到跨卡缓存')
    assert.ok(prefix.includes('Do the task in the project workspace'), '公共前缀必须覆盖交付样板')
    assert.ok(prefix.includes('# Parallel work inside this task'), '公共前缀必须覆盖 parallel 段')
    // 分叉点只允许出现在卡号/标题处：公共前缀不得包含任何一张卡的专属字段。
    assert.ok(!prefix.includes('甲卡') && !prefix.includes('乙卡'), '公共前缀不得吞入每卡变化字段')
  } finally { await t.close() }
})

test('review_delegate 分支：核验指令段先于任务字段块，above→below 措辞到位', async () => {
  const t = await setup()
  try {
    const actor = { type: 'user', id: t.service.localUserId }
    const card = await t.service.createTask(
      { projectId: t.project.id, title: '委派核验卡', description: '核验描述。', writeScopes: ['src/r/'] },
      actor,
    )
    const prompt = t.runtime.promptFor({
      run: { kind: 'review', trigger_type: 'review_delegate' }, bot: t.dev, project: t.project, task: rowOf(t.store, card.id),
    })
    assertAscending(prompt, [
      'The owner delegated the acceptance verification',
      '子代理核验：',
      `# Subagent verification for task ORD-${card.number}`,
      'Description:',
    ], 'review_delegate 分支')
    // 写范围/证据的指代方向必须是 below（字段块在指令之后）。
    assert.ok(prompt.includes('declared write scopes below'), '指代词应随段序改为 below')
    assert.ok(prompt.includes('the evidence below'), '指代词应随段序改为 below')
    assert.ok(!prompt.includes('above'), '不得残留前移后方向不成立的 above')
  } finally { await t.close() }
})

test('owner review 与 handle 分支：处置指令先于任务字段块，失败原因殿后', async () => {
  const t = await setup()
  try {
    const actor = { type: 'user', id: t.service.localUserId }
    const card = await t.service.createTask(
      { projectId: t.project.id, title: '验收卡', description: '验收描述。', writeScopes: ['src/v/'] },
      actor,
    )
    const row = rowOf(t.store, card.id)
    const reviewPrompt = t.runtime.promptFor({
      run: { kind: 'review', trigger_type: 'review_requested' }, bot: t.dev, project: t.project, task: row,
    })
    assertAscending(reviewPrompt, [
      'As the project owner, review the delivered result below',
      `# Review delivery for task ORD-${card.number}`,
      'Description:',
    ], 'owner review 分支')
    assert.ok(!reviewPrompt.includes('above'), 'owner review 不得残留方向不成立的 above')

    const now = new Date().toISOString()
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, idempotency_key, error_code, error_message, queued_at, ended_at)
       VALUES ('run_ord_fail', ?, ?, ?, 'task', 'write', 'task_started', 'failed', 'ik_ord_fail', 'E_UPSTREAM', 'boom', ?, ?)`,
      t.project.id, t.dev.id, card.id, now, now,
    )
    t.store.run("UPDATE tasks SET status = 'blocked' WHERE id = ?", card.id)
    const handlePrompt = t.runtime.promptFor({
      run: { kind: 'handle', trigger_type: 'blocked_handoff' }, bot: t.dev, project: t.project, task: rowOf(t.store, card.id),
    })
    assertAscending(handlePrompt, [
      'As the project owner, handle this blocked task',
      `# Blocked task ORD-${card.number}`,
      'Description:',
      'Last failure: boom',
    ], 'handle 分支')
  } finally { await t.close() }
})

test('memory_review 两分支：Extract/Rules 静态块先于 Task/User message 变化段', async () => {
  const t = await setup()
  try {
    const actor = { type: 'user', id: t.service.localUserId }
    const card = await t.service.createTask(
      { projectId: t.project.id, title: '记忆源卡', description: '记忆描述。', writeScopes: ['src/m/'] },
      actor,
    )
    const now = new Date().toISOString()
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, idempotency_key, output, queued_at, ended_at)
       VALUES ('run_ord_mr', ?, ?, ?, 'task', 'write', 'task_started', 'succeeded', 'ik_ord_mr', '交付：完成。', ?, ?)`,
      t.project.id, t.dev.id, card.id, now, now,
    )
    const taskPrompt = t.runtime.promptFor({
      run: { kind: 'memory_review', trigger_ref: 'run_ord_mr' }, bot: t.dev, project: t.project,
    })
    assertAscending(taskPrompt, [
      '# Memory review for a finished task',
      'Rules:',
      'Task: ORD-',
      'Delivery output:',
    ], 'memory_review 任务分支')

    const groupChat = t.store.get('SELECT * FROM group_chats WHERE project_id = ?', t.project.id)
    t.service.groupChatStore(t.project.id).run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, kind, created_at)
       VALUES ('msg_ord_chat', ?, ?, 'user', 'u1', '历史消息。', 'text', ?)`,
      t.project.id, groupChat.id, now,
    )
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, idempotency_key, output, queued_at, ended_at)
       VALUES ('run_ord_mr_chat', ?, ?, 'chat', 'write', 'mention', 'msg_ord_chat', 'succeeded', 'ik_ord_mr_chat', '回复正文。', ?, ?)`,
      t.project.id, t.dev.id, now, now,
    )
    const chatPrompt = t.runtime.promptFor({
      run: { kind: 'memory_review', trigger_ref: 'run_ord_mr_chat' }, bot: t.dev, project: t.project,
    })
    assertAscending(chatPrompt, [
      '# Memory review for a finished chat reply',
      'Rules:',
      'User message:',
      'Your reply:',
    ], 'memory_review 聊天分支')
  } finally { await t.close() }
})

test('solo/vision/群聊三分支：Reply 指令段先于消息变化段', async () => {
  const t = await setup()
  try {
    const soloPrompt = t.runtime.promptFor({
      run: { kind: 'solo_chat', bot_id: t.dev.id }, bot: t.dev,
      chatMessage: { id: 'solo_x', body: '在吗' }, sessionId: 'sess-order-solo',
    })
    assertAscending(soloPrompt, ['Reply as Builder in this one-on-one chat', '# Solo message'], 'solo 分支')

    const visionPrompt = t.runtime.promptFor({
      run: { kind: 'vision', project_id: t.project.id }, bot: t.dev, project: t.project,
      chatMessage: { sender_type: 'user', sender_id: 'u1', body: '看看这张图' },
    })
    assertAscending(visionPrompt, ['# Image transcription request', 'Transcription requirements:', 'Original message from user:u1'], 'vision 分支')

    const now = new Date().toISOString()
    const groupChat = t.store.get('SELECT * FROM group_chats WHERE project_id = ?', t.project.id)
    t.service.groupChatStore(t.project.id).run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, kind, created_at)
       VALUES ('msg_ord_g', ?, ?, 'user', 'u1', '群聊历史。', 'text', ?)`,
      t.project.id, groupChat.id, now,
    )
    const groupPrompt = t.runtime.promptFor({
      run: { kind: 'chat', project_id: t.project.id }, bot: t.dev, project: t.project, task: null,
      chatMessage: { id: 'msg_ord_new', body: '@builder 看看' }, sessionId: 'sess-order-group',
    })
    assertAscending(groupPrompt, ['Reply as Builder in the project group', '# Group message'], '群聊分支')
    // 变化区内部相对顺序不动：正文→尾窗→Open tasks（与 prompt-watermark 断言同口径）。
    assertAscending(groupPrompt, ['# Group message', 'ids are for team_recall', 'Open tasks:'], '群聊变化区内部')
  } finally { await t.close() }
})

test('任务族五分支共享 header 逐字一致：前缀跨模板复用', async () => {
  const t = await setup()
  try {
    const actor = { type: 'user', id: t.service.localUserId }
    const card = await t.service.createTask(
      { projectId: t.project.id, title: 'header 卡', description: '描述。', writeScopes: ['src/h/'] },
      actor,
    )
    const row = rowOf(t.store, card.id)
    const bot = t.dev
    const prompts = [
      t.runtime.promptFor({ run: { kind: 'task' }, bot, project: t.project, task: row }),
      t.runtime.promptFor({ run: { kind: 'review', trigger_type: 'review_delegate' }, bot, project: t.project, task: row }),
      t.runtime.promptFor({ run: { kind: 'review', trigger_type: 'review_requested' }, bot, project: t.project, task: row }),
      t.runtime.promptFor({ run: { kind: 'handle' }, bot, project: t.project, task: row }),
    ]
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, idempotency_key, output, queued_at, ended_at)
       VALUES ('run_ord_hdr', ?, ?, ?, 'task', 'write', 'task_started', 'succeeded', 'ik_ord_hdr', 'out', ?, ?)`,
      t.project.id, t.dev.id, card.id, new Date().toISOString(), new Date().toISOString(),
    )
    prompts.push(t.runtime.promptFor({ run: { kind: 'memory_review', trigger_ref: 'run_ord_hdr' }, bot, project: t.project }))
    const headers = new Set(prompts.map((p) => p.split('\n').slice(0, 3).join('\n')))
    assert.equal(headers.size, 1, `任务族五分支 header 必须逐字一致，实际 ${headers.size} 种：\n${[...headers].join('\n---\n')}`)
    const header = [...headers][0]
    assert.match(header, /Project: Order \(ORD\)/, 'header 第一行是项目行')
    assert.match(header, /Workspace: /, 'header 第二行是工作区行')
    assert.match(header, /You are: Builder/, 'header 第三行是身份行')
  } finally { await t.close() }
})

test('memoryDigest：最近 8 条带内容，其余条目按主题列出且整项截断；审查模板含超量主题规则', async () => {
  const t = await setup()
  try {
    const actor = { type: 'bot' as const, id: t.director.id }
    const base = Date.now()
    const seed = (scope: 'bot' | 'project' | 'team', topics: string[], offsetMs = 0) => {
      const actor = scope === 'bot' ? { type: 'bot' as const, id: t.dev.id } : { type: 'bot' as const, id: t.director.id }
      const scopeId = scope === 'bot' ? t.dev.id : scope === 'project' ? t.project.id : 'team'
      topics.forEach((topic, i) => {
        const memory = t.service.createMemory({ scopeType: scope, scopeId, topic, content: `${topic}的内容`, actor })
        // updated_at 决定「最近 8 条」的口径，逐条错开写入时间。
        t.store.run('UPDATE memories SET updated_at = ? WHERE id = ?', new Date(base + offsetMs + i * 60_000).toISOString(), memory.id)
      })
    }
    seed('project', [...Array(12)].map((_, i) => `近${i}`), 3_000_000)
    const longTopic = (i: number) => `长${i}${'题'.repeat(116)}`
    seed('bot', [...Array(8)].map((_, i) => `bot近${i}`).concat([...Array(6)].map((_, i) => longTopic(i))), 1_000_000)
    // team 作用域塞超预算的长主题行（18×~121 字符 > 2k），验证整行丢弃不留半截主题。
    // 长主题时间戳更早，确保它们落在「其余条目」而不是挤进最近 8 条。
    seed('team', [...Array(8)].map((_, i) => `team近${i}`))
    seed('team', [...Array(18)].map((_, i) => longTopic(100 + i)), -10_000_000)

    const digest = t.runtime.memoryDigest(t.dev, t.project)
    for (const i of [4, 5, 6, 7]) assert.ok(digest.includes(`- 近${i}：`), `最近 8 条应带内容分隔（近${i}）`)
    assert.ok(digest.includes('Other active topics in project scope: '), '超出 8 条的存量应按主题列出')
    for (const i of [0, 1, 2, 3]) assert.ok(new RegExp(`近${i}[、\\n]`).test(digest), `其余主题应出现在清单（近${i}）`)
    // 预算截断：未超预算的 bot 主题行保留，team 作用域的超长主题行整行丢弃，不出现半截主题。
    assert.ok(digest.includes('Other active topics in bot scope: '), 'bot 主题行应在清单')
    for (const i of [0, 5]) assert.ok(digest.includes(longTopic(i)), '未超预算的 bot 主题行应完整保留')
    for (const i of [100, 113]) assert.ok(!digest.includes(longTopic(i)), '超预算的作用域主题行应整行丢弃')
    assert.ok(!digest.includes('Other active topics in team scope'), '超预算的 team 主题行不出现')
    assert.ok(digest.includes('长'), '截断不应把保留行削掉')

    // 两种审查提示词都带上「超量主题只做整篇替换时才复用」规则。
    const now = new Date().toISOString()
    const groupChat = t.store.get('SELECT * FROM group_chats WHERE project_id = ?', t.project.id)
    t.service.groupChatStore(t.project.id).run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, kind, created_at)
       VALUES ('msg_digest_chat', ?, ?, 'user', 'u1', '历史消息。', 'text', ?)`,
      t.project.id, groupChat.id, now,
    )
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, idempotency_key, output, queued_at, ended_at)
       VALUES ('run_digest_chat', ?, ?, 'chat', 'write', 'mention', 'msg_digest_chat', 'succeeded', 'ik_digest_chat', '回复正文。', ?, ?)`,
      t.project.id, t.dev.id, now, now,
    )
    const chatPrompt = t.runtime.promptFor({ run: { kind: 'memory_review', trigger_ref: 'run_digest_chat' }, bot: t.dev, project: t.project })
    const rule = 'Entries beyond the latest eight are listed by topic only: reuse one of those topics only when your content fully replaces what that entry said; if your fact merely adds a detail to it, use a new, specific topic instead.'
    assert.ok(chatPrompt.includes(rule), '聊天审查模板应含超量主题规则')

    const card = await t.service.createTask(
      { projectId: t.project.id, title: '主题清单卡', description: 'd', writeScopes: ['src/d/'] }, { type: 'user', id: t.service.localUserId },
    )
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, idempotency_key, output, queued_at, ended_at)
       VALUES ('run_digest_task', ?, ?, ?, 'task', 'write', 'task_started', 'succeeded', 'ik_digest_task', '交付：完成。', ?, ?)`,
      t.project.id, t.dev.id, card.id, now, now,
    )
    const taskPrompt = t.runtime.promptFor({ run: { kind: 'memory_review', trigger_ref: 'run_digest_task' }, bot: t.dev, project: t.project, task: t.store.get('SELECT * FROM tasks WHERE id = ?', card.id) })
    assert.ok(taskPrompt.includes(rule), '任务审查模板应含超量主题规则')
  } finally {
    await t.close()
  }
})
