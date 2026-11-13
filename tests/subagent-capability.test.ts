// tests/subagent-capability.test.ts —— DSHBOTS-238 守门：子代理/智能体团队能力全员化。
// 锁定三件事：
//  ① 成员 bot 的子代理生成能力清单在场（subagent / subagent_fork / spawn_teammate 等），
//     门控 = config.agentTeam 开启且 bot 类型支持（项目内 active bot）；
//  ② director 专权工具（team_assign_task / team_review_task / team_block_task）未被下放——
//     工具层兜底对成员 bot deny，服务层 ownerContextFor 仍是权威闸门；
//  ③ 成员 bot 提示词含静态「# Subagent parallelization」使用指引（何时拆、怎么汇总），
//     且该段位于 system 前缀区（身份提示词），agentTeam 关闭时不注入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import {
  SUBAGENT_GENERATION_TOOLS,
  DIRECTOR_ONLY_TOOLS,
  subagentCapabilityEnabledFor,
  applyBotToolPolicy,
} from '../src/tools.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup({ agentTeam = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-cap-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  config.agentTeam = agentTeam
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const memberView = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const projectView = await service.createProject({ name: 'Cap', key: 'CAP', ownerBotId: director.id, memberIds: [memberView.id] })
  const member = store.get('SELECT * FROM bots WHERE id = ?', memberView.id)
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const runtime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, runtime, director, member, project, config, close }
}

const bindSession = (store, { sessionId, botId, projectId, kind = 'project', taskId = null }) => {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId, botId, projectId, kind, taskId, new Date().toISOString(),
  )
}

test('能力清单：子代理生成工具与总监专权工具边界清晰', () => {
  const generation: readonly string[] = SUBAGENT_GENERATION_TOOLS
  for (const name of ['subagent', 'subagent_fork', 'workflow', 'spawn_teammate']) {
    assert.ok(generation.includes(name), `成员 bot 能力清单应含 ${name}`)
  }
  // 记忆三工具已下放 bot 域自管（服务层 resolveMemoryScopeFor 分层），不再属总监专权清单。
  assert.deepEqual(
    [...DIRECTOR_ONLY_TOOLS],
    ['team_assign_task', 'team_review_task', 'team_block_task', 'team_list_bots', 'team_add_member', 'team_create_bot', 'team_release_bot_quota'],
  )
  // 专权工具不得出现在成员能力清单里（防止「下放」）。
  for (const name of DIRECTOR_ONLY_TOOLS) {
    assert.ok(!generation.includes(name), `${name} 是总监专权，不得进入成员能力清单`)
  }
})

test('门控：agentTeam 开启且 bot 类型支持（项目内 active bot）', async () => {
  const on = await setup({ agentTeam: true })
  const off = await setup({ agentTeam: false })
  try {
    assert.equal(subagentCapabilityEnabledFor(on.member, on.config), true, '成员 bot + agentTeam 开 → 可用')
    assert.equal(subagentCapabilityEnabledFor(on.director, on.config), true, '总监 bot + agentTeam 开 → 可用')
    assert.equal(subagentCapabilityEnabledFor(off.member, off.config), false, 'agentTeam 关 → 不可用')
    assert.equal(subagentCapabilityEnabledFor({ ...on.member, status: 'removed' }, on.config), false, '已移除 bot → 不可用')
    assert.equal(subagentCapabilityEnabledFor(null, on.config), false, '无 bot → 不可用')
  } finally {
    await on.close()
    await off.close()
  }
})

test('成员 bot 身份提示词含静态子代理使用指引，且位于 system 前缀区', async () => {
  const t = await setup({ agentTeam: true })
  try {
    bindSession(t.store, { sessionId: 'sess-member', botId: t.member.id, projectId: t.project.id })
    const prompt = t.runtime.systemPromptFor({ agent: { id: 'sess-member' } })
    assert.match(prompt, /# Subagent parallelization/, '成员 bot 应有子代理使用指引段')
    assert.match(prompt, /two or more independent parts with disjoint write scopes/, '应给出「何时拆」判据')
    assert.match(prompt, /merge their results into your report/, '应给出「结果如何汇总」')
    assert.match(prompt, /review their output yourself/, '应要求自行复核子代理产出')
    // 静态段必须在场且先于任何每卡变化字段（身份提示词整体即前缀区）。
    assert.ok(prompt.indexOf('# Subagent parallelization') < prompt.indexOf('# Group message') || !prompt.includes('# Group message'))
    // 成员协作规则不再引导调用总监专权工具。
    assert.match(prompt, /director-only/, '成员规则应注明派单/验收为总监专权')
  } finally { await t.close() }
})

test('总监 bot 身份提示词不注入成员子代理指引（其能力由运行提示词 # Parallel work 承载）', async () => {
  const t = await setup({ agentTeam: true })
  try {
    bindSession(t.store, { sessionId: 'sess-director', botId: t.director.id, projectId: t.project.id })
    const prompt = t.runtime.systemPromptFor({ agent: { id: 'sess-director' } })
    assert.doesNotMatch(prompt, /# Subagent parallelization/, '总监不应注入成员版指引（避免与 # Parallel work 重复）')
    assert.match(prompt, /Use `team_assign_task` to hand concrete work/, '总监规则应保留派单指引')
  } finally { await t.close() }
})

test('agentTeam 关闭：成员 bot 不注入子代理使用指引', async () => {
  const t = await setup({ agentTeam: false })
  try {
    bindSession(t.store, { sessionId: 'sess-member', botId: t.member.id, projectId: t.project.id })
    const prompt = t.runtime.systemPromptFor({ agent: { id: 'sess-member' } })
    assert.doesNotMatch(prompt, /# Subagent parallelization/, 'agentTeam 关闭时不应注入')
  } finally { await t.close() }
})

test('工具层兜底：成员 bot 隐藏总监专权工具，总监不受影响', () => {
  const calls = []
  const resolved = { agent: { ctx: { tools: { restrict: (filter) => calls.push(filter) } } } }
  applyBotToolPolicy(resolved, { isOwner: false, logger: { warn() {} } })
  assert.equal(calls.length, 1, '成员 bot 应调用一次 restrict')
  assert.deepEqual([...calls[0].deny], [...DIRECTOR_ONLY_TOOLS], 'deny 清单应为总监专权工具')

  const ownerCalls = []
  applyBotToolPolicy({ agent: { ctx: { tools: { restrict: (filter) => ownerCalls.push(filter) } } } }, { isOwner: true })
  assert.equal(ownerCalls.length, 0, '总监不应被限制')

  // 宿主未暴露 restrict（或 resolved 带 error）时静默跳过，不抛错。
  assert.doesNotThrow(() => applyBotToolPolicy({ error: new Error('x') }, { isOwner: false }))
  assert.doesNotThrow(() => applyBotToolPolicy({ agent: { ctx: { tools: {} } } }, { isOwner: false }))
})

test('工具层兜底：包装与裸 agent 两种形状都生效（DSHBOTS-247）', () => {
  // 结转/复用路径传 resolveAgent 的 { agent } 包装。
  const wrappedCalls = []
  applyBotToolPolicy(
    { agent: { ctx: { tools: { restrict: (filter) => wrappedCalls.push(filter) } } } },
    { isOwner: false, logger: { warn() {} } },
  )
  assert.equal(wrappedCalls.length, 1, '包装形状应调用一次 restrict')
  assert.deepEqual([...wrappedCalls[0].deny], [...DIRECTOR_ONLY_TOOLS], 'deny 清单应为总监专权工具')

  // 新建会话路径传裸 agent（session.ts:336）——旧实现只认包装形状会静默跳过。
  const bareCalls = []
  applyBotToolPolicy(
    { ctx: { tools: { restrict: (filter) => bareCalls.push(filter) } } },
    { isOwner: false, logger: { warn() {} } },
  )
  assert.equal(bareCalls.length, 1, '裸 agent 形状也应调用一次 restrict（不再静默跳过）')
  assert.deepEqual([...bareCalls[0].deny], [...DIRECTOR_ONLY_TOOLS], '裸形状 deny 清单也应为总监专权工具')

  // isOwner 短路不变：两种形状都不应触发 restrict。
  const ownerWrapped = []
  applyBotToolPolicy({ agent: { ctx: { tools: { restrict: (filter) => ownerWrapped.push(filter) } } } }, { isOwner: true })
  const ownerBare = []
  applyBotToolPolicy({ ctx: { tools: { restrict: (filter) => ownerBare.push(filter) } } }, { isOwner: true })
  assert.equal(ownerWrapped.length, 0, '总监（包装形状）不应被限制')
  assert.equal(ownerBare.length, 0, '总监（裸形状）不应被限制')

  // 无 restrict / 带 error 的形状仍静默跳过，不抛错。
  assert.doesNotThrow(() => applyBotToolPolicy({ error: new Error('x') }, { isOwner: false }))
  assert.doesNotThrow(() => applyBotToolPolicy({ ctx: { tools: {} } }, { isOwner: false }))
})

test('工具层兜底：restrict 以方法调用发出、保留接收者（DSHBOTS-359）', () => {
  // 宿主 dsh-tools 的 ToolsService.restrict 首行读 this.ctx；摘下函数裸调用时
  // this===undefined，抛 "reading 'ctx'" 被 try/catch 吞成 warn——工具层兜底从未生效。
  // 替身必须写成依赖 this 的方法形态，否则测不出接收者丢失。
  const calls = []
  const warnings = []
  const tools = {
    ctx: { scope: 'agent' },
    restrict(filter) {
      if (!this?.ctx) throw new TypeError("Cannot read properties of undefined (reading 'ctx')")
      calls.push({ filter, receiver: this })
    },
  }
  applyBotToolPolicy(
    { agent: { ctx: { tools } } },
    { isOwner: false, logger: { warn: (msg: unknown) => warnings.push(String(msg)) } },
  )
  assert.equal(calls.length, 1, '成员 bot 应调用一次 restrict')
  assert.equal(calls[0].receiver, tools, 'restrict 应以 tools 对象为接收者调用')
  assert.deepEqual([...calls[0].filter.deny], [...DIRECTOR_ONLY_TOOLS], 'deny 清单应为总监专权工具')
  assert.deepEqual(warnings, [], '不应产生策略失败 warn')

  // 裸 agent 形状同样保留接收者。
  const bareCalls = []
  const bareTools = {
    ctx: { scope: 'agent' },
    restrict(filter) {
      if (!this?.ctx) throw new TypeError("Cannot read properties of undefined (reading 'ctx')")
      bareCalls.push({ filter, receiver: this })
    },
  }
  applyBotToolPolicy(
    { ctx: { tools: bareTools } },
    { isOwner: false, logger: { warn: (msg: unknown) => warnings.push(String(msg)) } },
  )
  assert.equal(bareCalls.length, 1, '裸 agent 形状也应调用一次 restrict')
  assert.equal(bareCalls[0].receiver, bareTools, '裸形状也须保留接收者')
  assert.deepEqual([...bareCalls[0].filter.deny], [...DIRECTOR_ONLY_TOOLS], '裸形状 deny 清单也应为总监专权工具')
  assert.deepEqual(warnings, [], '裸形状不应产生策略失败 warn')
})

test('服务层权威闸门：成员 bot 调 team_assign_task 仍被拒（专权未下放）', async () => {
  const t = await setup({ agentTeam: true })
  try {
    bindSession(t.store, { sessionId: 'sess-member', botId: t.member.id, projectId: t.project.id })
    await assert.rejects(
      () => t.service.assignFromBot('sess-member', { assignee: 'Builder', title: 'x', write_scopes: ['src/a/'] }),
      /只有项目总监 Bot 可以执行该操作/,
      '成员 bot 派单应被 ownerContextFor 拒绝',
    )
    bindSession(t.store, { sessionId: 'sess-director', botId: t.director.id, projectId: t.project.id })
    const created = await t.service.assignFromBot('sess-director', { assignee: 'Builder', title: 'x', write_scopes: ['src/a/'] })
    assert.ok(created?.id, '总监派单应成功')
  } finally { await t.close() }
})
