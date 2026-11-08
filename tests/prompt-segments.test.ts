// tests/prompt-segments.test.ts —— B1/DSHBOTS-324：分段可编辑提示词守门。
// ① 默认组合与硬编码时代逐字节等价（prompt-budget/prefix-order 继续守门）；
// ② 覆盖生效：新会话 identity 含自定义通信纪律、任务卡注入自定义拆分段；
// ③ 保存不唤醒会话：已冻结的旧会话 identity 逐字节不变；
// ④ Default updated 三方取舍：base_hash 过期 → 视图标 defaultChanged，恢复默认后清除；
// ⑤ 预算闸：拆卡段超 1200 三段合计直接拒绝（badRequest），2000 字上限拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { PROMPT_SEGMENT_DEFAULTS, promptOverridesHash } from '../src/services/runtime/prompt.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prompt-segments-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const projectView = await service.createProject({ name: 'Order', key: 'ORD', ownerBotId: director.id })
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const runtime = new DshRuntime({ ctx: {}, config, store, logger: { info() {}, warn() {}, error() {} } })
  // 控制面绑定（kind='bot'）供 identity 求值。
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES ('sess-owner', ?, ?, 'bot', NULL, ?)`,
    director.id, project.id, new Date().toISOString(),
  )
  return { root, store, service, runtime, project, director, config }
}

async function teardown(root, store) {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

test('无覆盖时四段按内置默认组合；覆盖生效于新会话，旧会话冻结不受扰', async () => {
  const { root, store, service, runtime, director, project } = await setup()
  try {
    const identity = runtime.systemPromptFor({ agent: { id: 'sess-owner' } })
    assert.match(identity, /Speak only when someone must act or decide/, '默认通信纪律在场')
    const frozenBefore = runtime.systemPromptFor({ agent: { id: 'sess-owner' } })

    // 覆盖通信纪律：新求值生效。
    const view = service.updatePromptSegment('communication', '只在必须有人动手或拍板时说话。', { type: 'user', id: 'u-local' })
    const communication = view.find(item => item.key === 'communication')
    assert.equal(communication.override.text, '只在必须有人动手或拍板时说话。')
    assert.equal(communication.defaultChanged, false, '保存时的 base_hash 即当前默认指纹')

    // 新会话（未冻结）读到自定义文本；已冻结会话逐字节不变（保存不唤醒）。
    // 同 bot+project 只有一条活跃绑定：按生产结转形态先退役旧绑定再建新绑定。
    store.run("UPDATE session_bindings SET alias = 1 WHERE session_id = 'sess-owner'")
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
       VALUES ('sess-owner2', ?, (SELECT id FROM projects LIMIT 1), 'bot', NULL, ?)`,
      director.id, new Date().toISOString(),
    )
    const identity2 = runtime.systemPromptFor({ agent: { id: 'sess-owner2' } })
    assert.match(identity2, /只在必须有人动手或拍板时说话/)
    assert.doesNotMatch(identity2, /Speak only when someone must act or decide/)
    const frozenAfter = runtime.systemPromptFor({ agent: { id: 'sess-owner' } })
    assert.equal(frozenAfter, frozenBefore, '已冻结会话 identity 逐字节不变')

    // 任务段覆盖：任务卡注入自定义拆分段。
    service.updatePromptSegment('splitting', 'Split only when the director approves a split plan.', { type: 'user', id: 'u-local' })
    const taskView = await service.createTask({ projectId: project.id, title: '分段卡' }, { type: 'user', id: 'u-local' })
    const task = store.get('SELECT * FROM tasks WHERE id = ?', taskView.id)
    const taskPrompt = runtime.promptFor({ run: { kind: 'task' }, bot: director, project, task })
    assert.match(taskPrompt, /Split only when the director approves a split plan\./)
    assert.doesNotMatch(taskPrompt, /Split only when all hold:/)
  } finally {
    await teardown(root, store)
  }
})

test('Default updated 三方取舍：base_hash 过期标记 defaultChanged，恢复默认清除覆盖', async () => {
  const { root, store, service } = await setup()
  try {
    const actor = { type: 'user', id: 'u-local' }
    service.updatePromptSegment('selfcheck', '自定义自校段。', actor)
    // 模拟升级：手工把覆盖的 base_hash 改成旧指纹（默认正文已随发版变化）。
    const overrides = JSON.parse(store.setting('prompt_overrides'))
    overrides.selfcheck.base_hash = 'stale-hash-000'
    store.setSetting('prompt_overrides', JSON.stringify(overrides))
    let view = service.promptSegmentsView().find(item => item.key === 'selfcheck')
    assert.equal(view.defaultChanged, true, '默认指纹与保存时不一致 → 标记 Default updated')
    assert.equal(view.effectiveText, '自定义自校段。', '取舍前仍生效自定义文本（保留我的文本）')

    // 恢复默认：空文本删覆盖，defaultChanged 归零。
    service.updatePromptSegment('selfcheck', '', actor)
    view = service.promptSegmentsView().find(item => item.key === 'selfcheck')
    assert.equal(view.override, null)
    assert.equal(view.defaultChanged, false)
    assert.equal(view.effectiveText, PROMPT_SEGMENT_DEFAULTS.selfcheck)

    // 与默认一致的文本提交同样视为恢复默认（不产生空覆盖）。
    service.updatePromptSegment('selfcheck', PROMPT_SEGMENT_DEFAULTS.selfcheck, actor)
    view = service.promptSegmentsView().find(item => item.key === 'selfcheck')
    assert.equal(view.override, null)
  } finally {
    await teardown(root, store)
  }
})

test('预算闸：拆卡段超三段合计拒收，2000 字上限拒收，未知段拒收', async () => {
  const { root, store, service } = await setup()
  try {
    const actor = { type: 'user', id: 'u-local' }
    assert.throws(
      () => service.updatePromptSegment('subtask', 'B'.repeat(1_900), actor),
      /超预算/,
      '三段合计超 1200 必须拒绝',
    )
    assert.throws(
      () => service.updatePromptSegment('communication', 'C'.repeat(2_100), actor),
      /上限 2000/,
      '单段 2000 字上限必须拒绝',
    )
    assert.throws(
      () => service.updatePromptSegment('nope', 'x', actor),
      /未知提示词段/,
    )
    // 恰好合规的短覆盖可以保存（三段合计仍在预算内）。
    const view = service.updatePromptSegment('subtask', 'Before closing: file subtasks when needed.', actor)
    assert.equal(view.find(item => item.key === 'subtask').override.text, 'Before closing: file subtasks when needed.')
  } finally {
    await teardown(root, store)
  }
})

test('坏数据降级：prompt_overrides 非 JSON/非对象时按空覆盖处理', async () => {
  const { root, store, service } = await setup()
  try {
    store.setSetting('prompt_overrides', 'not-json{{{')
    const view = service.promptSegmentsView()
    assert.equal(view.length, 4)
    for (const segment of view) {
      assert.equal(segment.override, null)
      assert.equal(segment.effectiveText, PROMPT_SEGMENT_DEFAULTS[segment.key])
    }
  } finally {
    await teardown(root, store)
  }
})

test('指纹函数稳定：同文本同指纹，异文本异指纹', () => {
  assert.equal(promptOverridesHash('abc'), promptOverridesHash('abc'))
  assert.notEqual(promptOverridesHash('abc'), promptOverridesHash('abd'))
})
