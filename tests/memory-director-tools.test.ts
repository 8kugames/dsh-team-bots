// tests/memory-director-tools.test.ts —— DSHBOTS-239 守门：总监记忆管理工具集。
// 锁定五件事：
//  ① list 按作用域枚举现存记忆、支持主题子串过滤；
//  ② remember 同名覆盖：同 scope+topic 原地更新（revision+1、事件与审计留痕），不叠新条；
//  ③ cleanup 判定口径：task 口径仅收终态卡（done/canceled）的过程记录，topics 口径点名清理；
//  ④ 清理审计留痕：一笔 memory.cleanup 审计列出被清条目，逐条 memory_events 留痕；
//  ⑤ 非 director（成员会话/未绑定会话）三入口一律拒绝——服务层 ownerContextFor 权威闸门。
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-director-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const memberView = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const projectView = await service.createProject({ name: 'Mem', key: 'MEM', ownerBotId: director.id, memberIds: [memberView.id] })
  const member = store.get('SELECT * FROM bots WHERE id = ?', memberView.id)
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const bindSession = (sessionId: string, botId: string) => {
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
       VALUES (?, ?, ?, 'project', NULL, ?)`,
      sessionId, botId, project.id, new Date().toISOString(),
    )
  }
  const ownerSession = 'sess_owner'
  const memberSession = 'sess_member'
  bindSession(ownerSession, director.id)
  bindSession(memberSession, member.id)
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  const runtime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  return { store, service, runtime, director, member, project, ownerSession, memberSession, close }
}

test('非 director 调用被拒：成员会话与未绑定会话三入口一律 forbidden', async () => {
  const t = await setup()
  try {
    for (const sessionId of [t.memberSession, 'sess_unknown']) {
      // 成员会话命中总监闸门，未绑定会话命中项目群闸门——都必须拒绝。
      assert.throws(() => t.service.memoryListFromBot(sessionId, {}), /总监|项目群/, `list 应拒 ${sessionId}`)
      assert.throws(() => t.service.memoryWriteFromBot(sessionId, { scope: 'project', topic: 'x', content: 'y' }), /总监|项目群/, `write 应拒 ${sessionId}`)
      assert.throws(() => t.service.memoryCleanupFromBot(sessionId, { scope: 'project', topics: ['x'] }), /总监|项目群/, `cleanup 应拒 ${sessionId}`)
    }
  } finally {
    await t.close()
  }
})

test('list 按作用域枚举现存记忆，支持主题子串过滤', async () => {
  const t = await setup()
  try {
    const actor = { type: 'bot' as const, id: t.director.id }
    t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '通知通道口径', content: '任务级走系统消息', actor })
    t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '发布节奏', content: '每周四', actor })
    t.service.createMemory({ scopeType: 'bot', scopeId: t.director.id, topic: '私记', content: '总监备忘', actor })
    t.service.createMemory({ scopeType: 'team', scopeId: 'team', topic: '团队命名约定', content: 'kebab-case', actor })
    t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '已废口径', content: '旧口径', actor, status: 'active' })
    t.service.deleteMemory(
      t.store.get("SELECT id FROM memories WHERE topic = '已废口径'").id,
      actor,
    )

    const projectAll = t.service.memoryListFromBot(t.ownerSession, {})
    assert.equal(projectAll.length, 2, '项目域应枚举 2 条 active（archived 不回灌）')
    const filtered = t.service.memoryListFromBot(t.ownerSession, { topic: '口径' })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].topic, '通知通道口径')
    assert.equal(t.service.memoryListFromBot(t.ownerSession, { scope: 'bot' })[0].topic, '私记', 'bot 域=总监自己')
    assert.equal(t.service.memoryListFromBot(t.ownerSession, { scope: 'team' })[0].topic, '团队命名约定')
    assert.throws(() => t.service.memoryListFromBot(t.ownerSession, { scope: 'bad' }), /作用域无效/)
  } finally {
    await t.close()
  }
})

test('同名覆盖写：同 scope+topic 原地更新不叠条，事件与审计留痕', async () => {
  const t = await setup()
  try {
    const first = t.service.memoryWriteFromBot(t.ownerSession, { scope: 'project', topic: '通知通道口径', content: '第一版：走群聊消息' })
    assert.equal(first.overwritten, false, '首次写入是新建')
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM memories WHERE topic = '通知通道口径' AND status = 'active'").n, 1)
    assert.ok(t.store.get("SELECT id FROM audit_log WHERE action = 'memory.create'"), '新建应审计 memory.create')

    const second = t.service.memoryWriteFromBot(t.ownerSession, { scope: 'project', topic: '通知通道口径', content: '第二版：任务级走系统消息留痕' })
    assert.equal(second.overwritten, true, '同名写入是覆盖')
    assert.equal(second.memory.revision, 2, 'revision 递增')
    assert.equal(second.memory.content, '第二版：任务级走系统消息留痕')
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM memories WHERE topic = '通知通道口径' AND status = 'active'").n, 1, '不叠新条')

    const evt = t.store.get("SELECT * FROM memory_events WHERE action = 'updated' ORDER BY created_at DESC")
    assert.ok(evt, '覆盖应落 memory_events updated')
    assert.equal(evt.before_text, '第一版：走群聊消息')
    assert.equal(evt.after_text, '第二版：任务级走系统消息留痕')
    assert.ok(t.store.get("SELECT id FROM audit_log WHERE action = 'memory.overwrite'"), '覆盖应审计 memory.overwrite')
  } finally {
    await t.close()
  }
})

test('cleanup 判定口径：task 仅收终态卡过程记录，topics 点名清理，作用域不越界', async () => {
  const t = await setup()
  try {
    const actor = { type: 'bot' as const, id: t.director.id }
    const done = await t.service.createTask({ projectId: t.project.id, title: '已闭环卡' })
    const open = await t.service.createTask({ projectId: t.project.id, title: '在办卡' })
    t.store.run("UPDATE tasks SET status = 'done' WHERE id = ?", done.id)
    t.service.createMemory({ scopeType: 'bot', scopeId: t.director.id, topic: `任务 MEM-${done.number}`, content: '过程记录', actor })
    t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: `MEM-${done.number} 交付记录`, content: '交付记录', actor })
    t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '用户拍板口径', content: '保留', actor })

    // 在办卡的 task 口径直接拒绝：判定口径=终态。
    assert.throws(
      () => t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project', task: `MEM-${open.number}` }),
      /仅已闭环/,
    )

    // bot 域 task 口径：只清本域的 任务 MEM-N，项目域交付记录不在本域（missed 报告）。
    const byTask = t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'bot', task: `MEM-${done.number}` })
    assert.equal(byTask.archived, 1)
    assert.equal(byTask.cleaned[0].topic, `任务 MEM-${done.number}`)
    assert.deepEqual(byTask.missed, [`MEM-${done.number} 交付记录`], '跨域主题点名报告为 missed')

    // 项目域 topics 口径：点名清交付记录；用户拍板类不动。
    const byTopics = t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project', topics: [`MEM-${done.number} 交付记录`] })
    assert.equal(byTopics.archived, 1)
    assert.equal(t.store.get("SELECT status FROM memories WHERE topic = '用户拍板口径'").status, 'active', '未点名条目不动')

    assert.throws(() => t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project' }), /至少一项/)
  } finally {
    await t.close()
  }
})

test('bot 点名：总监可代管成员 Bot 的记忆域，未知 Bot 拒绝', async () => {
  const t = await setup()
  try {
    const actor = { type: 'bot' as const, id: t.member.id }
    t.service.createMemory({ scopeType: 'bot', scopeId: t.member.id, topic: '成员私记一', content: 'a', actor })
    t.service.createMemory({ scopeType: 'bot', scopeId: t.member.id, topic: '成员私记二', content: 'b', actor })

    // list 点名成员 Bot：能枚举其 bot 域；不点名仍是总监自己。
    const rows = t.service.memoryListFromBot(t.ownerSession, { scope: 'bot', bot: 'Builder' })
    assert.equal(rows.map(row => row.topic).sort().join(','), '成员私记一,成员私记二')
    assert.equal(t.service.memoryListFromBot(t.ownerSession, { scope: 'bot' }).length, 0, '不点名 bot 域=总监自己')

    // write 点名成员 Bot：同名覆盖写进成员域，不落总监域。
    const written = t.service.memoryWriteFromBot(t.ownerSession, { scope: 'bot', bot: 'Builder', topic: '成员私记一', content: '覆盖版' })
    assert.equal(written.overwritten, true)
    assert.equal(written.memory.scope_id, t.member.id)
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM memories WHERE topic = '成员私记一' AND status = 'active'").n, 1)

    // cleanup 点名成员 Bot：只清成员域，总监域同名主题不越界。
    t.service.createMemory({ scopeType: 'bot', scopeId: t.director.id, topic: '成员私记二', content: '同名', actor: { type: 'bot', id: t.director.id } })
    const cleaned = t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'bot', bot: 'Builder', topics: ['成员私记二'] })
    assert.equal(cleaned.archived, 1)
    assert.equal(t.store.get("SELECT status FROM memories WHERE topic = '成员私记二' AND scope_id = ?", t.member.id).status, 'archived')
    assert.equal(t.store.get("SELECT status FROM memories WHERE topic = '成员私记二' AND scope_id = ?", t.director.id).status, 'active', '总监域同名条目不越界')

    assert.throws(() => t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'bot', bot: 'nobody', topics: ['x'] }), /Bot 不存在/)
    assert.throws(() => t.service.memoryListFromBot(t.memberSession, { scope: 'bot', bot: 'Builder' }), /总监/, '成员点名他人 Bot 仍拒绝')
  } finally {
    await t.close()
  }
})

test('巡检纪律注入总监身份提示词静态段，成员不注入', async () => {
  const t = await setup()
  try {
    const ownerPrompt = t.runtime.systemPromptFor({ agent: { id: t.ownerSession } })
    assert.match(ownerPrompt, /Memory hygiene is director work/, '总监提示词应含记忆巡检纪律')
    assert.match(ownerPrompt, /team_memory_list/, '纪律应教 list 巡检入口')
    assert.match(ownerPrompt, /team_memory_cleanup/, '纪律应教 cleanup 两口径')
    assert.match(ownerPrompt, /team_memory_write/, '纪律应教同名覆盖写')
    assert.match(ownerPrompt, /keep entries recording the user's explicit decisions/, '判定口径应保留用户拍板类')
    assert.match(ownerPrompt, /audited as memory\.cleanup/, '应注明清理审计留痕')
    // 静态段先于每消息变化字段（前缀缓存区），与 # Group message 的既有序断言同口径。
    assert.ok(ownerPrompt.indexOf('Memory hygiene is director work') < ownerPrompt.indexOf('# Group message') || !ownerPrompt.includes('# Group message'))
    const memberPrompt = t.runtime.systemPromptFor({ agent: { id: t.memberSession } })
    assert.doesNotMatch(memberPrompt, /Memory hygiene is director work/, '巡检纪律是总监专属，成员不注入')
  } finally {
    await t.close()
  }
})

test('清理审计留痕：memory.cleanup 一笔列出被清条目，逐条 memory_events 落档', async () => {
  const t = await setup()
  try {
    const actor = { type: 'bot' as const, id: t.director.id }
    t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '旧口径一', content: 'a', actor })
    t.service.createMemory({ scopeType: 'project', scopeId: t.project.id, topic: '旧口径二', content: 'b', actor })
    const result = t.service.memoryCleanupFromBot(t.ownerSession, { scope: 'project', topics: ['旧口径一', '旧口径二'] })

    const auditRow = t.store.get("SELECT * FROM audit_log WHERE action = 'memory.cleanup'")
    assert.ok(auditRow, '清理应审计 memory.cleanup')
    const data = JSON.parse(auditRow.data_json)
    assert.deepEqual(
      data.cleaned.map((item: { topic: string }) => item.topic).sort(),
      ['旧口径一', '旧口径二'],
      '审计应列出被清条目',
    )
    for (const item of result.cleaned) {
      assert.ok(t.store.get('SELECT id FROM memory_events WHERE memory_id = ? AND action = ?', item.id, 'archived'), `${item.topic} 应有 archived 事件`)
    }
  } finally {
    await t.close()
  }
})
