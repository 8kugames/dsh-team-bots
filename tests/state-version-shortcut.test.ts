// tests/state-version-shortcut.test.js —— state 轮询版本短路。
// ① 首次（不带 since）返回全量并携带 version；
// ② 版本未变（同视图、60s 内）带 since 只回 { unchanged, version }，不组装数据；
// ③ 任何写库（total_changes 推进）后版本失配，同 since 重回全量且 version 更新；
// ④ 视图键不同（soloBotId 不同）不命中缓存，回全量；
// ⑤ 客户端接线钉住：loadState 带 since 且 unchanged 时原引用返回（源码扫描）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { ensureApprovalSchema } from '../src/services/approvals.js'
import { ensureQuestionSchema } from '../src/services/questions.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-stub' }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-state-ver-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const project = await service.createProject({ name: 'Ver', key: 'VER', ownerBotId: director.id, memberIds: [] })
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { root, store, service, director, project, close }
}

test('版本未变带 since 只回 unchanged；写库后版本失配重回全量', async () => {
  const t = await setup()
  try {
    const first = await t.service.state(t.project.id)
    assert.ok(first.version, '全量响应携带 version')
    assert.ok(Array.isArray(first.projects), '全量响应含数据体')

    const second = await t.service.state(t.project.id, null, { since: first.version })
    assert.equal(second.unchanged, true, '版本相等只回 unchanged')
    assert.equal(second.version, first.version)
    assert.equal(second.projects, undefined, 'unchanged 不携带数据体')

    // 写库推进 total_changes：同 since 失配，重回全量且 version 前进。
    await t.service.createTask({ projectId: t.project.id, title: '触发写库', postCard: false }, { type: 'user', id: 'user_local' })
    const third = await t.service.state(t.project.id, null, { since: first.version })
    assert.ok(!third.unchanged, '写库后不走短路')
    assert.ok(Array.isArray(third.projects))
    assert.notEqual(third.version, first.version, '版本随写库推进')

    // 新版本再次短路命中。
    const fourth = await t.service.state(t.project.id, null, { since: third.version })
    assert.equal(fourth.unchanged, true)
  } finally { await t.close() }
})

test('视图键不同（soloBotId）不命中短路缓存', async () => {
  const t = await setup()
  try {
    const dev = await t.service.createBot({ name: 'Soloer', role: '开发', instructions: 'X.', provider: 'fake', model: 'm' })
    const group = await t.service.state(t.project.id)
    const solo = await t.service.state(t.project.id, dev.id, { since: group.version })
    assert.ok(!solo.unchanged, 'solo 视图与群聊视图缓存键不同，回全量')
    assert.ok(Array.isArray(solo.projects))
    const soloAgain = await t.service.state(t.project.id, dev.id, { since: solo.version })
    assert.equal(soloAgain.unchanged, true, 'solo 视图自身版本稳定后短路命中')
  } finally { await t.close() }
})

test('作用域口径：懒建表齐备时视图无关写入不再打穿短路（usage_events 实证）', async () => {
  const t = await setup()
  try {
    // 懒建表补齐后版本基线走作用域口径（否则整段回退全库 changes()，本用例失败暴露）。
    ensureApprovalSchema(t.store)
    ensureQuestionSchema(t.store)
    const first = await t.service.state(t.project.id)
    // 视图无关的高频写入：usage_events / 普通 outbox 投递。
    t.store.run('INSERT INTO usage_events(id, source_key, project_id, bot_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'ue1', 'sk1', t.project.id, t.director.id, new Date().toISOString(), new Date().toISOString())
    t.store.run("INSERT INTO outbox(id, kind, payload_json, available_at, created_at) VALUES (?, 'wechat', '{}', ?, ?)", 'ob1', new Date().toISOString(), new Date().toISOString())
    const afterChurn = await t.service.state(t.project.id, null, { since: first.version })
    assert.equal(afterChurn.unchanged, true, 'usage_events/普通 outbox 写入不该让轮询重回全量')
    // 视图相关写入仍然失效短路：新群消息必须回全量。
    const groupChat = t.store.get('SELECT id FROM group_chats WHERE project_id = ?', t.project.id)?.id
      ?? (() => { t.store.run('INSERT INTO group_chats(id, project_id, title, owner_bot_id, created_at) VALUES (?, ?, ?, ?, ?)', 'gc1', t.project.id, 'Ver', t.director.id, new Date().toISOString()); return 'gc1' })()
    t.store.run('INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'msg1', t.project.id, groupChat, 'user', 'user_local', 'hi', new Date().toISOString())
    const afterMessage = await t.service.state(t.project.id, null, { since: first.version })
    assert.ok(!afterMessage.unchanged, 'messages 新行必须重回全量')
  } finally { await t.close() }
})

test('切换回看过的视图直接回放缓存载荷，不再重组', async () => {
  const t = await setup()
  try {
    const dev = await t.service.createBot({ name: 'Soloer', role: '开发', instructions: 'X.', provider: 'fake', model: 'm' })
    let assemblies = 0
    const original = (t.service as any).projectView.bind(t.service)
    ;(t.service as any).projectView = (...args: unknown[]) => { assemblies += 1; return original(...args) }
    const a1 = await t.service.state(t.project.id)
    const b1 = await t.service.state(t.project.id, dev.id, { since: a1.version })
    assert.ok(Array.isArray(b1.projects), '不同视图键回全量')
    const a2 = await t.service.state(t.project.id, null, { since: b1.version })
    assert.equal(assemblies, 2, '切回已缓存视图不得再次组装')
    assert.ok(Array.isArray(a2.projects) && a2.project?.id === t.project.id, '缓存回放要带完整数据体')
    const a3 = await t.service.state(t.project.id, null, { since: a2.version })
    assert.equal(a3.unchanged, true, '同视图轮询仍走 unchanged')
    assert.equal(assemblies, 2, 'unchanged 不得触发组装')
  } finally { await t.close() }
})

test('切换 SWR：缓存视图版本已变仍即时回放，后台重组入缓存', async () => {
  const t = await setup()
  try {
    let assemblies = 0
    const original = (t.service as any).projectView.bind(t.service)
    ;(t.service as any).projectView = (...args: unknown[]) => { assemblies += 1; return original(...args) }
    const a1 = await t.service.state(t.project.id)
    assert.equal(assemblies, 1)
    // 版本推进（新消息）后切回：SWR 立即回放旧载荷，不等重组。
    t.store.run('INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'msg-swr', t.project.id, (t.store.get('SELECT id FROM group_chats WHERE project_id = ?', t.project.id)?.id ?? ''), 'bot', 'director', 'x', new Date().toISOString())
    const a2 = await t.service.state(t.project.id, null, { since: 'other@1' })
    assert.ok(Array.isArray(a2.projects) && a2.project?.id === t.project.id, 'SWR 回放要带完整数据体')
    assert.equal(assemblies, 1, '同步路径不得重组')
    assert.ok(!(a2.messages ?? []).some((item: { id?: string }) => item.id === 'msg-swr'), 'SWR 回放的是旧视图，不含新消息')
    // 后台重组最终入缓存。
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(assemblies >= 2, '后台重组要执行')
    // SWR 回放配的是旧视图自己的版本号：下一拍同视图轮询必须版本失配拿到含新消息的
    // 新数据（来自缓存回放或重组均可）——不得因缓存同版本而被 unchanged 卡在旧消息上。
    const a3 = await t.service.state(t.project.id, null, { since: a2.version })
    assert.ok(!a3.unchanged, 'SWR 之后的轮询必须回全量新数据')
    assert.ok((a3.messages ?? []).some((item: { id?: string }) => item.id === 'msg-swr'), '新数据必须含新消息')
  } finally { await t.close() }
})

test('接线钉住：loadState 带 since、unchanged 原引用返回；poll 数据零变化跳过渲染', async () => {
  const apiModule = readFileSync(new URL('../ui/modules/api.ts', import.meta.url), 'utf8')
  assert.match(apiModule, /since: state\.data\?\.version \?\? undefined/, 'loadState 必须携带上次 version')
  assert.match(apiModule, /if \(response\?\.unchanged\) return state\.data/, 'unchanged 时原引用返回')
  const app = readFileSync(new URL('../ui/app.ts', import.meta.url), 'utf8')
  assert.match(app, /if \(state\.data === previousData\) return/, 'poll 在数据零变化时跳过渲染与通知重算')
})
