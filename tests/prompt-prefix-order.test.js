// tests/prompt-prefix-order.test.js —— DSHBOTS-152：运行提示词「静态段前置、变化段后置」守门。
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
  const runtime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
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
    assertAscending(prompt, ['收工报告会自动落为本任务评论', 'Do the task in the project workspace'], '静态区内部')
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
    // 指令段前移后，写范围/证据的指代方向必须是 below（字段块在指令之后）。
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
    t.store.run(
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
      run: { kind: 'solo_chat' }, bot: t.dev,
      chatMessage: { id: 'solo_x', body: '在吗' }, sessionId: 'sess-order-solo',
    })
    assertAscending(soloPrompt, ['Reply as Builder in this one-on-one chat', '# Solo message'], 'solo 分支')

    const visionPrompt = t.runtime.promptFor({
      run: { kind: 'vision' }, bot: t.dev, project: t.project,
      chatMessage: { sender_type: 'user', sender_id: 'u1', body: '看看这张图' },
    })
    assertAscending(visionPrompt, ['# Image transcription request', 'Transcription requirements:', 'Original message from user:u1'], 'vision 分支')

    const now = new Date().toISOString()
    const groupChat = t.store.get('SELECT * FROM group_chats WHERE project_id = ?', t.project.id)
    t.store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, kind, created_at)
       VALUES ('msg_ord_g', ?, ?, 'user', 'u1', '群聊历史。', 'text', ?)`,
      t.project.id, groupChat.id, now,
    )
    const groupPrompt = t.runtime.promptFor({
      run: { kind: 'chat' }, bot: t.dev, project: t.project, task: null,
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
