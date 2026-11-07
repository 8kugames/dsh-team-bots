// tests/communication-discipline.test.ts —— A1/DSHBOTS-321：通信纪律身份段守门。
// 吸收 superagent 原型 prompts/team/communication.md 的「默认沉默、只在需人时外发、
// 一次一个具体问题、发送前逐句裁剪」，落点为项目会话身份段的 owner/member 变体
// （COMMUNICATION_RULES，src/services/runtime/prompt.ts）。
// 守门三点：① owner 变体在；② member 变体在；③ 作用域锁——任务会话与单聊身份段
// 不注入（任务交付纪律归 deliverySelfcheckBlock D-276，单聊是用户主动问的直接应答面），
// 防止「少说话」纪律误伤必需的交付报告。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { DshRuntime } from '../src/runtime.js'

const ANCHORS = [
  /Speak only when someone must act or decide/,
  /one concrete question at a time/,
  /reread the draft and cut every sentence/,
]

async function closeQuietly(store, timeout = 2000) {
  if (!store) return
  const timer = new Promise(resolve => setTimeout(resolve, timeout))
  try { await Promise.race([store.close(), timer]) } catch { /* 已关闭或句柄失效则忽略 */ }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-comm-discipline-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  const now = new Date().toISOString()
  // b1 为项目 owner（owner 变体），b2 为普通成员（member 变体）。
  store.run(
    `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, created_at, updated_at)
     VALUES ('b1', 'Director', '总监', '', 'blue', 'active', 0, ?, ?)`, now, now,
  )
  store.run(
    `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, created_at, updated_at)
     VALUES ('b2', 'Builder', '开发', '', 'green', 'active', 0, ?, ?)`, now, now,
  )
  store.run(
    `INSERT INTO projects(id, key, name, slug, owner_bot_id, status, created_at, updated_at)
     VALUES ('p1', 'DEMO', 'Demo', 'demo', 'b1', 'active', ?, ?)`, now, now,
  )
  store.run(
    `INSERT INTO project_members(project_id, member_type, member_id, member_role, joined_at)
     VALUES ('p1', 'bot', 'b2', 'member', ?)`, now,
  )
  // 控制面绑定按现行口径 kind='bot'（D-285）：owner/member 带项目维度，solo 是 project_id NULL。
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES ('sess-owner', 'b1', 'p1', 'bot', NULL, ?)`, now,
  )
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES ('sess-member', 'b2', 'p1', 'bot', NULL, ?)`, now,
  )
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES ('sess-solo', 'b2', NULL, 'bot', NULL, ?)`, now,
  )
  const runtime = new DshRuntime({ ctx: {}, config: { workspace: join(root, 'workspace') }, store, logger: { warn() {} } as any })
  return { root, store, runtime }
}

test('项目会话 owner 身份段含通信纪律三行', async () => {
  const { root, store, runtime } = await harness()
  try {
    const prompt = runtime.systemPromptFor({ agent: { id: 'sess-owner' } })
    for (const anchor of ANCHORS) assert.match(prompt, anchor)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('项目会话 member 身份段含通信纪律三行', async () => {
  const { root, store, runtime } = await harness()
  try {
    const prompt = runtime.systemPromptFor({ agent: { id: 'sess-member' } })
    for (const anchor of ANCHORS) assert.match(prompt, anchor)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('作用域锁：任务会话与单聊身份段不注入通信纪律', async () => {
  const { root, store, runtime } = await harness()
  try {
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id, created_at, updated_at)
       VALUES ('t1', 'p1', 1, '任务', 'in_progress', 'medium', 'user', 'u1', ?, ?)`, now, now,
    )
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
       VALUES ('sess-task', 'b2', 'p1', 'task', 't1', ?)`, now,
    )
    const taskPrompt = runtime.systemPromptFor({ agent: { id: 'sess-task' } })
    const soloPrompt = runtime.systemPromptFor({ agent: { id: 'sess-solo' } })
    for (const anchor of ANCHORS) {
      assert.doesNotMatch(taskPrompt, anchor, '任务会话不注入通信纪律（交付纪律归 deliverySelfcheckBlock）')
      assert.doesNotMatch(soloPrompt, anchor, '单聊不注入通信纪律（直接应答面）')
    }
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
