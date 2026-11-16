// DSHBOTS-365：提权按规则免审——路径/命令 glob 规则命中即不落待办卡，
// 插件即时替 owner 应答 allowed-once 并留痕（approvals 行 allowed + decided_by=auto:rule:*，
// 审计事件 approval.auto_allow）。未命中走原卡流程逐字不变；bot 写规则被拒；danger 档可配。
// 增量：出厂预置关键词 glob 三条（**/temp/**、**/.tmp/**、**/tmp/**，任意沙箱档，仅键为 null 时播种）；
// 存量预置行（绝对前缀枚举）启动时迁移为新 glob，owner 自建行不动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { approvalGlobMatch, approvalRuleMatches, DEFAULT_APPROVAL_AUTO_RULES, ensureApprovalSchema, parseApprovalRules } from '../src/services/approvals.js'
import { readUiSource } from './helpers/ui-sources.js'
import './helpers/eval-shim.js'

const here = dirname(fileURLToPath(import.meta.url))

class StubRuntime { declare ctx: unknown;
  constructor(ctx = null) {
    this.ctx = ctx
  }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

// 与 tests/approval.test.ts 同款：按注册序瀑布流，prepend 插队首，未调 next() 截断链路。
class FakeCordisCtx { declare hooks: Map<unknown, Array<{ listener: (...args: unknown[]) => unknown }>>;
  constructor() {
    this.hooks = new Map()
  }
  on(name, listener, options: { prepend?: boolean } = {}) {
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
}

const now = () => new Date().toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function setup({ ctx = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-approval-auto-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime(ctx))
  await service.initialize()
  service.started = true
  service.config.approvalTimeoutMs = 60
  return { root, store, service, config }
}

function primeProject(store, service, name) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  return service.createProject({ name, key: name.replace(/[^A-Za-z]/g, '').slice(0, 8).toUpperCase(), ownerBotId: director.id })
}

function bindSession(store, { sessionId, botId, projectId, kind = 'project' }) {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)`,
    sessionId, botId, projectId, kind, now(),
  )
}

function makeReq({ sessionId, toolName = 'bash', callId = null, zh = null }) {
  const controller = new AbortController()
  return {
    req: { agent: { session: { id: sessionId } }, toolName, callId, reason: 'run elevated command', displayReason: zh ? { zh } : undefined, signal: controller.signal },
    controller,
  }
}

// 直写规则表（绕过编辑面）：单测匹配语义用；链路用例走 service.updateApprovalRules。
const seedRules = (store, rules) => store.setSetting('approval_auto_rules', JSON.stringify(rules))
const rule = (fields) => ({ id: 'arul_t1', path_prefix: '', command: '', bot_id: '', tool_name: '', sandbox: '', note: '', ...fields })

// ===== 纯函数 =====

test('parseApprovalRules：坏数据/非数组降级为空规则，不抛错', () => {
  assert.deepEqual(parseApprovalRules('not-json{{{'), [])
  assert.deepEqual(parseApprovalRules('{"a":1}'), [])
  assert.deepEqual(parseApprovalRules(''), [])
  assert.deepEqual(parseApprovalRules(null), [])
  assert.deepEqual(parseApprovalRules(JSON.stringify([{ command: 'git push' }])), [{ command: 'git push' }])
})

test('approvalRuleMatches：路径按目录边界、命令按词边界、辅维度空 = 通配', () => {
  const dims = { botId: 'bot_a', toolName: 'bash', sandbox: 'workspace-write' }
  // 路径边界：/tmp/x 不匹配 /tmp/xxfoo，匹配自身与其子路径。
  assert.equal(approvalRuleMatches(rule({ path_prefix: '/tmp/x' }), { ...dims, target: '/tmp/x' }), true)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '/tmp/x' }), { ...dims, target: '/tmp/x/build/a.js' }), true)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '/tmp/x' }), { ...dims, target: '/tmp/xxfoo/a.js' }), false)
  // 命令词边界：git push 匹配 git push origin dev，不匹配 git-push。
  assert.equal(approvalRuleMatches(rule({ command: 'git push' }), { ...dims, target: 'git push origin dev' }), true)
  assert.equal(approvalRuleMatches(rule({ command: 'git push' }), { ...dims, target: 'git push' }), true)
  assert.equal(approvalRuleMatches(rule({ command: 'git push' }), { ...dims, target: 'git-push' }), false)
  assert.equal(approvalRuleMatches(rule({ command: 'git push' }), { ...dims, target: 'git pushx' }), false)
  // 辅维度：留空通配，填了必须精确相等。
  assert.equal(approvalRuleMatches(rule({ command: 'ls', bot_id: 'bot_a' }), { ...dims, target: 'ls' }), true)
  assert.equal(approvalRuleMatches(rule({ command: 'ls', bot_id: 'bot_b' }), { ...dims, target: 'ls' }), false)
  assert.equal(approvalRuleMatches(rule({ command: 'ls', tool_name: 'bash' }), { ...dims, target: 'ls' }), true)
  assert.equal(approvalRuleMatches(rule({ command: 'ls', tool_name: 'edit' }), { ...dims, target: 'ls' }), false)
  assert.equal(approvalRuleMatches(rule({ command: 'ls', sandbox: 'workspace-write' }), { ...dims, target: 'ls' }), true)
  assert.equal(approvalRuleMatches(rule({ command: 'ls', sandbox: 'danger-full-access' }), { ...dims, target: 'ls' }), false)
  // 目标为空（无 callId 缓存）一律不命中。
  assert.equal(approvalRuleMatches(rule({ command: 'ls' }), { ...dims, target: null }), false)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '/tmp' }), { ...dims, target: '' }), false)
})

test('approvalRuleMatches：含通配符的规则走 glob（** 跨目录、* 不跨目录），命中即整串匹配', () => {
  const dims = { botId: 'bot_a', toolName: 'bash', sandbox: 'workspace-write' }
  // 关键词 glob：**/tmp/** 命中路径中任意层级的 tmp 目录（含命令串里的路径）。
  for (const target of ['/tmp/a.js', '/tmp', '/var/tmp/a.js', '/private/tmp/a/b.js', '/Users/x/work/tmp/a.js', 'rm -rf /tmp/a.js']) {
    assert.equal(approvalRuleMatches(rule({ path_prefix: '**/tmp/**' }), { ...dims, target }), true, `**/tmp/** 应命中 ${target}`)
  }
  for (const target of ['/tmpfoo/a.js', '/mytmp/a.js', '/var/tmpx/a.js', 'ls -la']) {
    assert.equal(approvalRuleMatches(rule({ path_prefix: '**/tmp/**' }), { ...dims, target }), false, `**/tmp/** 不应命中 ${target}`)
  }
  // **/temp/** 与 **/.tmp/** 同口径。
  assert.equal(approvalRuleMatches(rule({ path_prefix: '**/temp/**' }), { ...dims, target: '/var/temp/build.log' }), true)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '**/temp/**' }), { ...dims, target: '/var/tempo/build.log' }), false)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '**/.tmp/**' }), { ...dims, target: '/Users/x/.tmp/cache' }), true)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '**/.tmp/**' }), { ...dims, target: '/Users/x/tmp/cache' }), false)
  // 单星不跨目录：/a/* 只命中 /a/ 下一层。
  assert.equal(approvalRuleMatches(rule({ path_prefix: '/a/*' }), { ...dims, target: '/a/b.txt' }), true)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '/a/*' }), { ...dims, target: '/a/b/c.txt' }), false)
  // 命令同样走 glob：git push* 命中带参命令，** 跨任意字符。
  assert.equal(approvalRuleMatches(rule({ command: 'git push*' }), { ...dims, target: 'git push origin dev' }), true)
  assert.equal(approvalRuleMatches(rule({ command: 'git push*' }), { ...dims, target: 'git push' }), true)
  assert.equal(approvalRuleMatches(rule({ command: 'git push*' }), { ...dims, target: 'git-pull' }), false)
  assert.equal(approvalRuleMatches(rule({ command: '**rm -rf*' }), { ...dims, target: 'sudo rm -rf build' }), true)
})

test('approvalRuleMatches：~ 开头的路径规则匹配时展开为当前用户家目录', () => {
  const dims = { botId: 'bot_a', toolName: 'bash', sandbox: 'workspace-write' }
  const home = homedir()
  // 无通配符：~ 与 ~/… 按展开后的目录边界前缀匹配。
  assert.equal(approvalRuleMatches(rule({ path_prefix: '~' }), { ...dims, target: home }), true)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '~' }), { ...dims, target: `${home}/work/a.js` }), true)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '~/work' }), { ...dims, target: `${home}/work/a.js` }), true)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '~/work' }), { ...dims, target: `${home}/workbook/a.js` }), false)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '~/work' }), { ...dims, target: '/opt/work/a.js' }), false)
  // 含通配符：展开后再走 glob。
  assert.equal(approvalRuleMatches(rule({ path_prefix: '~/work/**' }), { ...dims, target: `${home}/work/a/b.js` }), true)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '~/work/**' }), { ...dims, target: `${home}/work` }), true)
  assert.equal(approvalRuleMatches(rule({ path_prefix: '~/work/**' }), { ...dims, target: '/opt/work/a.js' }), false)
})

test('glob 匹配器：** 跨目录、* 不跨目录、? 单字符，尾部 /** 也命中目录自身', () => {
  assert.equal(approvalGlobMatch('**/tmp/**', '/tmp/a/b'), true)
  assert.equal(approvalGlobMatch('**/tmp/**', '/tmp'), true)
  assert.equal(approvalGlobMatch('**/tmp/**', '/tmpfoo'), false)
  assert.equal(approvalGlobMatch('/tmp/**', '/tmp/a'), true)
  assert.equal(approvalGlobMatch('/tmp/**', '/tmp'), true)
  assert.equal(approvalGlobMatch('/tmp/*', '/tmp/a'), true)
  assert.equal(approvalGlobMatch('/tmp/*', '/tmp/a/b'), false)
  assert.equal(approvalGlobMatch('/tmp/?.txt', '/tmp/a.txt'), true)
  assert.equal(approvalGlobMatch('/tmp/?.txt', '/tmp/ab.txt'), false)
  assert.equal(approvalGlobMatch('*.txt', 'a.txt'), true)
  assert.equal(approvalGlobMatch('*.txt', 'dir/a.txt'), false)
  assert.equal(approvalGlobMatch('**', 'anything at all'), true)
  assert.equal(approvalGlobMatch('', 'x'), false)
  assert.equal(approvalGlobMatch('*', ''), false)
})

// ===== 链路：命中免审 =====

test('命中命令规则：即时 allowed-once，行落 allowed + decided_by=auto:rule:*，审计留痕，无待办卡', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Auto Cmd')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-auto-cmd', botId: director.id, projectId: project.id })
    seedRules(store, [rule({ id: 'arul_push', command: 'git push' })])

    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-push-1', arguments: { command: 'git push origin dev\necho done' } }, () => Promise.resolve('ok'))
    let nexted = false
    const { req } = makeReq({ sessionId: 'sess-auto-cmd', callId: 'call-push-1', zh: '需要推送开发分支' })
    const outcome = service.handleApprovalRequest(req, () => { nexted = true })

    assert.equal(await outcome, 'allowed-once')
    assert.equal(nexted, false, '插件已认领应答，不透传')
    const row = store.get('SELECT * FROM approvals')
    assert.equal(row.status, 'allowed')
    assert.equal(row.decided_by, 'auto:rule:arul_push')
    assert.ok(row.decided_at, '免审也必须留决策时间')
    assert.equal(row.tool_target, 'git push origin dev')
    // 无待办卡 / 无群聊锚点 / 无通知面：pending 计数为 0，messages 零审批锚点。
    assert.equal(service.approvalsPending().count, 0)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'approval'").n, 0)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM solo_messages').n, 0)
    // 留痕事件：approval.auto_allow 审计行存在且带规则 id。
    const auditRow = store.get("SELECT * FROM audit_log WHERE action = 'approval.auto_allow' AND target_id = ?", row.id)
    assert.ok(auditRow, '免审放行必须写审计事件')
    assert.equal(JSON.parse(auditRow.data_json).ruleId, 'arul_push')
    // 决策入口对已决条目拒绝重复应答。
    await assert.rejects(() => service.decideApproval(row.id, 'allow'), /已处理/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('命中工作区外目录前缀：edit 提权直接放行；边界外（/tmp/xxfoo）回落原卡流程', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Auto Path')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-auto-path', botId: director.id, projectId: project.id })
    seedRules(store, [rule({ id: 'arul_tmp', path_prefix: '/tmp/auto-allow' })])

    await ctx.waterfall({}, 'tools/pre-execute', { name: 'edit', callId: 'call-path-1', arguments: { file_path: '/tmp/auto-allow/src/app.js' } }, () => Promise.resolve('ok'))
    const allowed = service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-path', toolName: 'edit', callId: 'call-path-1' }).req, () => {})
    assert.equal(await allowed, 'allowed-once')
    const allowedRow = store.get("SELECT * FROM approvals WHERE status = 'allowed'")
    assert.equal(allowedRow.decided_by, 'auto:rule:arul_tmp')

    // 边界外：前缀相同字符串开头但目录边界不匹配 → 原卡流程（pending + 群聊锚点）。
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'edit', callId: 'call-path-2', arguments: { file_path: '/tmp/auto-allowance/x.js' } }, () => Promise.resolve('ok'))
    const pending = service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-path', toolName: 'edit', callId: 'call-path-2' }).req, () => {})
    const pendingRow = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.ok(pendingRow, '未命中规则必须回落原卡流程')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM messages WHERE approval_id = ?', pendingRow.id).n, 1)
    service.settleApproval(pendingRow.id, 'cancelled', 'rejected', null)
    await pending
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ===== 链路：未命中与辅维度 =====

test('未命中（无目标缓存不命中规则）：原卡流程逐字不变——pending + 锚点 + owner 可 decide + 审计 approval.allow', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Auto Miss')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-auto-miss', botId: director.id, projectId: project.id })
    const { req } = makeReq({ sessionId: 'sess-auto-miss', zh: '需要执行一次提权 bash 命令' })
    const outcome = service.handleApprovalRequest(req, () => {})
    const row = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.ok(row)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'approval'").n, 1)
    const view = await service.decideApproval(row.id, 'allow')
    assert.equal(view.status, 'allowed')
    assert.equal(view.decided_by, 'user:user_local')
    assert.equal(await outcome, 'allowed-once')
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'approval.allow' AND target_id = ?", row.id))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('辅维度：bot / 工具不匹配回落原卡；匹配才放行', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Auto Dims')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-auto-dims', botId: director.id, projectId: project.id })
    const fire = callId => ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId, arguments: { command: 'ls -la' } }, () => Promise.resolve('ok'))

    seedRules(store, [rule({ id: 'arul_bot', command: 'ls', bot_id: 'bot_other' })])
    await fire('call-dims-1')
    const other = service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-dims', callId: 'call-dims-1' }).req, () => {})
    assert.ok(store.get("SELECT * FROM approvals WHERE status = 'pending'"), 'bot 维度不匹配回落原卡')
    service.settleApproval(store.get("SELECT id FROM approvals WHERE status = 'pending'").id, 'cancelled', 'rejected', null)
    await other

    seedRules(store, [rule({ id: 'arul_tool', command: 'ls', tool_name: 'edit' })])
    await fire('call-dims-2')
    const toolMiss = service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-dims', callId: 'call-dims-2' }).req, () => {})
    assert.ok(store.get("SELECT * FROM approvals WHERE status = 'pending'"), '工具维度不匹配回落原卡')
    service.settleApproval(store.get("SELECT id FROM approvals WHERE status = 'pending'").id, 'cancelled', 'rejected', null)
    await toolMiss

    seedRules(store, [rule({ id: 'arul_ok', command: 'ls', bot_id: director.id, tool_name: 'bash' })])
    await fire('call-dims-3')
    const hit = service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-dims', callId: 'call-dims-3' }).req, () => {})
    assert.equal(await hit, 'allowed-once')
    assert.equal(store.get("SELECT * FROM approvals WHERE status = 'allowed'").decided_by, 'auto:rule:arul_ok')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('沙箱档维度：任意档命中；限档不匹配回落；danger-full-access 可配且命中（默认规则集为空不含）', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Auto Sandbox')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-auto-sbx', botId: director.id, projectId: project.id })

    // 默认预置（增量后）只放行 temp 目录前缀：command 类目标不命中任何默认行，danger 请求照常落卡。
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-d0', arguments: { command: 'deploy --prod', sandbox_permissions: 'danger-full-access' } }, () => Promise.resolve('ok'))
    const noRule = service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-sbx', callId: 'call-d0' }).req, () => {})
    assert.ok(store.get("SELECT * FROM approvals WHERE status = 'pending'"), '命令类目标不命中 temp 目录预置，走原卡流程')
    service.settleApproval(store.get("SELECT id FROM approvals WHERE status = 'pending'").id, 'cancelled', 'rejected', null)
    await noRule

    // 规则不限档（sandbox 空 = 任意）：danger 请求命中。
    seedRules(store, [rule({ id: 'arul_any', command: 'deploy' })])
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-d1', arguments: { command: 'deploy --prod', sandbox_permissions: 'danger-full-access' } }, () => Promise.resolve('ok'))
    assert.equal(await service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-sbx', callId: 'call-d1' }).req, () => {}), 'allowed-once')

    // 规则限 workspace-write：danger 请求不命中，回落原卡。
    seedRules(store, [rule({ id: 'arul_ww', command: 'deploy', sandbox: 'workspace-write' })])
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-d2', arguments: { command: 'deploy --prod', sandbox_permissions: 'danger-full-access' } }, () => Promise.resolve('ok'))
    const limited = service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-sbx', callId: 'call-d2' }).req, () => {})
    assert.ok(store.get("SELECT * FROM approvals WHERE status = 'pending'"), '限档与请求档不符回落原卡')
    service.settleApproval(store.get("SELECT id FROM approvals WHERE status = 'pending'").id, 'cancelled', 'rejected', null)
    await limited

    // danger 档规则：owner 显式配置后命中 danger 请求。
    seedRules(store, [rule({ id: 'arul_danger', command: 'deploy', sandbox: 'danger-full-access' })])
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-d3', arguments: { command: 'deploy --prod', sandbox_permissions: 'danger-full-access' } }, () => Promise.resolve('ok'))
    assert.equal(await service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-sbx', callId: 'call-d3' }).req, () => {}), 'allowed-once')
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ===== 编辑面与权限 =====

test('updateApprovalRules：bot actor 被拒（不能自批），user 可写并留审计；state 视图透出规则', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(store, service, 'Auto Edit')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    // 全新库 initialize 已播种 3 条出厂默认（增量语义）；bot 写被拒必须保持存量不动。
    const presetRules = service.approvalRulesView()
    const storedPreset = store.setting('approval_auto_rules')
    assert.equal(presetRules.length, DEFAULT_APPROVAL_AUTO_RULES.length, '全新库已播种出厂默认规则')
    await assert.rejects(
      () => service.updateApprovalRules([{ command: 'rm -rf /' }], { type: 'bot', id: director.id }),
      /不能自批/,
    )
    assert.deepEqual(service.approvalRulesView(), presetRules, 'bot 写入必须整体被拒，不留半截')
    assert.equal(store.setting('approval_auto_rules'), storedPreset, '被拒时不落库')

    const view = await service.updateApprovalRules([{ path_prefix: '/tmp/x/', command: '', note: '构建产物' }])
    assert.equal(view.length, 1)
    assert.equal(view[0].path_prefix, '/tmp/x', '尾斜杠归一')
    assert.match(view[0].id, /^arul_/)
    assert.equal(view[0].updated_by, 'user:user_local')
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'approval_rules.update' AND target_id = 'approval_auto_rules'"))
    const state = await service.state(project.id)
    assert.deepEqual(state.approvalRules, view, 'state 视图与编辑面同源')

    // 非法输入：主维度全空 / 相对路径（无通配符）/ 未知沙箱档 / 未知 bot / 非数组 / 超量。
    await assert.rejects(() => service.updateApprovalRules([{ note: 'x' }]), /至少填一项/)
    await assert.rejects(() => service.updateApprovalRules([{ path_prefix: 'tmp/x' }]), /绝对路径/)
    await assert.rejects(() => service.updateApprovalRules([{ command: 'ls', sandbox: 'root' }]), /沙箱档/)
    await assert.rejects(() => service.updateApprovalRules([{ command: 'ls', bot_id: 'bot_ghost' }]), /不存在/)
    await assert.rejects(() => service.updateApprovalRules('nope' as any), /数组/)
    await assert.rejects(() => service.updateApprovalRules(Array.from({ length: 51 }, () => ({ command: 'ls' }))), /最多/)
    // 含通配符的关键词规则不必是绝对路径（glob 方言）。
    const globView = await service.updateApprovalRules([{ path_prefix: '**/tmp/**', command: '' }])
    assert.equal(globView[0].path_prefix, '**/tmp/**', '关键词 glob 规则可保存')
    // 坏存量数据（直写库）降级为空规则，不影响编辑面读取。
    store.setSetting('approval_auto_rules', 'not-json{{{')
    assert.deepEqual(service.approvalRulesView(), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ===== 出厂预置默认规则（DSHBOTS-365 增量）=====

test('全新库 initialize 播种关键词 glob 默认规则（系统 tmpdir 未被覆盖时多一行），重复执行幂等', async () => {
  const { root, store, service } = await setup()
  try {
    const rules = service.approvalRulesView()
    assert.ok(rules.every(rule => rule.id.startsWith('arul_default_')), 'id 固定 arul_default_*')
    assert.ok(rules.every(rule => rule.sandbox === '' && rule.bot_id === '' && rule.tool_name === ''), '预置行任意档、bot/tool 留空')
    assert.deepEqual(rules.slice(0, 3).map(rule => rule.path_prefix), ['**/temp/**', '**/.tmp/**', '**/tmp/**'], '前三条是关键词 glob')
    // 系统 tmpdir：关键词覆盖不到时单独一行（macOS 的 /var/folders/<user>/<hash>/T）。
    const osTmpdir = tmpdir().replace(/[/\\]+$/, '')
    if (approvalGlobMatch('**/tmp/**', osTmpdir)) {
      assert.equal(rules.length, 3, '系统 tmpdir 已被关键词覆盖时不多加一行')
    } else {
      assert.equal(rules.length, 4, '系统 tmpdir 单独一行')
      assert.equal(rules[3].id, 'arul_default_tmpdir')
      assert.equal(rules[3].path_prefix, `${osTmpdir}/**`, '系统 tmpdir 规则覆盖该目录及其子路径')
    }
    assert.ok(store.setting('approval_auto_rules'), '键已初始化（非 null）')
    // 幂等：ensureApprovalSchema 重复执行（二段 initialize 同路径）不重复播种。
    ensureApprovalSchema(store)
    ensureApprovalSchema(store)
    const again = service.approvalRulesView()
    assert.equal(again.length, rules.length)
    assert.equal(new Set(again.map(rule => rule.id)).size, rules.length, '无重复行')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('存量预置行迁移：旧的绝对前缀枚举换成当前预置集合，owner 自建行不动，重复执行幂等', async () => {
  const { root, store, service } = await setup()
  try {
    store.setSetting('approval_auto_rules', JSON.stringify([
      { id: 'arul_default_tmp', path_prefix: '/tmp', command: '', bot_id: '', tool_name: '', sandbox: '', note: '默认' },
      { id: 'arul_default_private_tmp', path_prefix: '/private/tmp', command: '', bot_id: '', tool_name: '', sandbox: '', note: '默认' },
      { id: 'arul_mine', path_prefix: '/opt/build', command: '', bot_id: '', tool_name: '', sandbox: '', note: '构建' },
    ]))
    ensureApprovalSchema(store)
    const migrated = service.approvalRulesView()
    const presetPaths = DEFAULT_APPROVAL_AUTO_RULES.map(rule => rule.path_prefix)
    assert.deepEqual(migrated.map(rule => rule.path_prefix), [...presetPaths, '/opt/build'], '旧预置行换成当前预置集合，owner 行保留')
    assert.equal(migrated.at(-1).id, 'arul_mine', 'owner 行 id 不变')
    ensureApprovalSchema(store)
    assert.equal(service.approvalRulesView().length, presetPaths.length + 1, '迁移幂等，不重复插入')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('已迁到关键词 glob 的存量库补上系统 tmpdir 行；owner 改过路径的预置行不动', async () => {
  const { root, store, service } = await setup()
  try {
    const osTmpdir = tmpdir().replace(/[/\\]+$/, '')
    store.setSetting('approval_auto_rules', JSON.stringify([
      { id: 'arul_default_temp', path_prefix: '**/temp/**', command: '', bot_id: '', tool_name: '', sandbox: '', note: '' },
      { id: 'arul_default_dot_tmp', path_prefix: '**/.tmp/**', command: '', bot_id: '', tool_name: '', sandbox: '', note: '' },
      { id: 'arul_default_tmp', path_prefix: '**/tmp/**', command: '', bot_id: '', tool_name: '', sandbox: '', note: '' },
    ]))
    ensureApprovalSchema(store)
    const migrated = service.approvalRulesView()
    const presetPaths = DEFAULT_APPROVAL_AUTO_RULES.map(rule => rule.path_prefix)
    assert.deepEqual(migrated.map(rule => rule.path_prefix), presetPaths, '存量关键词行对齐当前预置集合')
    if (!approvalGlobMatch('**/tmp/**', osTmpdir)) {
      assert.ok(migrated.some(rule => rule.path_prefix === `${osTmpdir}/**`), '系统 tmpdir 行补齐')
    }
    // owner 改过路径的预置行按自有行保留，不被预置集合覆盖。
    store.setSetting('approval_auto_rules', JSON.stringify([
      { id: 'arul_default_tmp', path_prefix: '/opt/custom-tmp', command: '', bot_id: '', tool_name: '', sandbox: '', note: '' },
    ]))
    ensureApprovalSchema(store)
    assert.deepEqual(service.approvalRulesView().map(rule => rule.path_prefix), ['/opt/custom-tmp'], '改过路径的预置行不被覆盖')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('播种不覆盖：已配规则或显式清空（[]）后 ensureApprovalSchema 不回播', async () => {
  const { root, store, service } = await setup()
  try {
    const custom = [{ id: 'arul_mine', path_prefix: '/opt/data', command: '', bot_id: '', tool_name: '', sandbox: '', note: '' }]
    store.setSetting('approval_auto_rules', JSON.stringify(custom))
    ensureApprovalSchema(store)
    const afterCustom = service.approvalRulesView()
    assert.equal(afterCustom.length, 1)
    assert.equal(afterCustom[0].id, 'arul_mine', 'owner 已配数据不被默认播种覆盖')

    store.setSetting('approval_auto_rules', '[]')
    ensureApprovalSchema(store)
    assert.deepEqual(service.approvalRulesView(), [], '显式清空（[]）永不回播')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('链路命中默认行：/tmp 与 /var/temp 下的 edit 提权即时放行并留痕，不产卡', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Preset Hit')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-preset-hit', botId: director.id, projectId: project.id })
    const cases = [
      ['call-preset-tmp', '/tmp/preset-hit/a.js'],
      ['call-preset-temp', '/var/temp/preset-hit/b.js'],
    ]
    for (const [callId, filePath] of cases) {
      await ctx.waterfall({}, 'tools/pre-execute', { name: 'edit', callId, arguments: { file_path: filePath } }, () => Promise.resolve('ok'))
      assert.equal(await service.handleApprovalRequest(makeReq({ sessionId: 'sess-preset-hit', toolName: 'edit', callId }).req, () => {}), 'allowed-once')
    }
    const rows = store.all("SELECT * FROM approvals WHERE status = 'allowed'")
    assert.equal(rows.length, 2)
    assert.ok(rows.every(row => row.decided_by.startsWith('auto:rule:arul_default_')), 'decided_by 指向默认行')
    assert.ok(rows.every(row => row.decided_at))
    assert.equal(store.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'approval.auto_allow'").n, 2, '每次默认放行都留审计事件')
    assert.equal(service.approvalsPending().count, 0, '无待办卡')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'approval'").n, 0, '无群聊锚点')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('默认行任意档：danger-full-access 请求落在 temp 目录同样命中（预置行 sandbox=\'\'）', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    // 规则级：每条默认行对 danger 档输入都放行（sandbox 空 = 任意档）。
    const osTmpdir = tmpdir().replace(/[/\\]+$/, '')
    const samples = {
      '**/temp/**': '/var/temp/build.sh',
      '**/.tmp/**': '/Users/x/.tmp/build.sh',
      '**/tmp/**': '/var/tmp/build.sh',
      [`${osTmpdir}/**`]: `${osTmpdir}/build.sh`,
    }
    for (const preset of service.approvalRulesView()) {
      assert.equal(approvalRuleMatches(preset, { botId: 'bot_x', toolName: 'bash', target: samples[preset.path_prefix], sandbox: 'danger-full-access' }), true, `${preset.path_prefix} 应命中对应 temp 路径`)
    }
    // 链路级：bash 直接调用 /tmp 下脚本（目标以 /tmp/ 开头）且请求 danger 档 → 命中默认行。
    const project = await primeProject(store, service, 'Preset Danger')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-preset-danger', botId: director.id, projectId: project.id })
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-danger-tmp', arguments: { command: '/tmp/preset-build.sh --flag', sandbox_permissions: 'danger-full-access' } }, () => Promise.resolve('ok'))
    assert.equal(await service.handleApprovalRequest(makeReq({ sessionId: 'sess-preset-danger', callId: 'call-danger-tmp' }).req, () => {}), 'allowed-once')
    const row = store.get("SELECT * FROM approvals WHERE status = 'allowed'")
    assert.equal(row.decided_by, 'auto:rule:arul_default_tmp')
    assert.ok(store.get("SELECT * FROM audit_log WHERE action = 'approval.auto_allow' AND target_id = ?", row.id))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('每次调用一放行一结：清空规则后同类请求回落原卡；规则现读无缓存', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Auto Once')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-auto-once', botId: director.id, projectId: project.id })
    seedRules(store, [rule({ id: 'arul_ls', command: 'ls' })])
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-once-1', arguments: { command: 'ls -la' } }, () => Promise.resolve('ok'))
    assert.equal(await service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-once', callId: 'call-once-1' }).req, () => {}), 'allowed-once')

    await service.updateApprovalRules([])
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-once-2', arguments: { command: 'ls -la' } }, () => Promise.resolve('ok'))
    const second = service.handleApprovalRequest(makeReq({ sessionId: 'sess-auto-once', callId: 'call-once-2' }).req, () => {})
    const pendingRow = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.ok(pendingRow, '规则删除即时生效，第二次同类请求回落原卡')
    service.settleApproval(pendingRow.id, 'cancelled', 'rejected', null)
    await second
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ===== 豁免与透传 =====

test('超时 timer 与 abort 对 auto-allowed 条目不误触：状态保持 allowed', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Auto Exempt')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-auto-exempt', botId: director.id, projectId: project.id })
    service.config.approvalTimeoutMs = 30
    seedRules(store, [rule({ id: 'arul_fast', command: 'ls' })])
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-exempt-1', arguments: { command: 'ls -la' } }, () => Promise.resolve('ok'))
    const { req, controller } = makeReq({ sessionId: 'sess-auto-exempt', callId: 'call-exempt-1' })
    const outcome = service.handleApprovalRequest(req, () => {})
    assert.equal(await outcome, 'allowed-once')
    controller.abort()
    await sleep(70)
    const row = store.get("SELECT * FROM approvals WHERE status = 'allowed'")
    assert.equal(row.status, 'allowed', '已决条目不受超时 timer / abort / 看门狗影响')
    assert.equal((service as any).approvalPending.size, 0, '免审不进 pending 表，无遗留 timer')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('未绑定会话透传不受规则影响：next() 接管，不落审批', async () => {
  const { root, store, service } = await setup()
  try {
    seedRules(store, [rule({ id: 'arul_wild', path_prefix: '/tmp' })])
    let nexted = false
    const { req } = makeReq({ sessionId: 'sess-not-bound' })
    const result = await service.handleApprovalRequest(req, () => { nexted = true; return 'unavailable' })
    assert.equal(nexted, true)
    assert.equal(result, 'unavailable')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM approvals').n, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ===== 前端：卡片回显 auto-allowed =====

const ui = (() => {
  const uiSource = readUiSource()
  const extract = marker => {
    const match = uiSource.match(new RegExp(`// ===== ${marker}:start[\\s\\S]*?// ===== ${marker}:end =====`))
    assert.ok(match, `${marker} 标记块必须存在`)
    return match[0]
  }
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const attr = value => esc(value).replace(/"/g, '&quot;')
  // t 由 eval-shim 提供（文案回键）。approval-v2 依赖 approval-ux 的辅助函数。
  return new Function('icon', 'esc', 'attr', 'formatTime', `${extract('approval-ux')}\n${extract('approval-v2')}
    return { approvalCardMarkup }`)(
    () => '<svg></svg>', esc, attr, () => '12:00',
  )
})()

test('卡片回显：auto-allowed 显示「规则自动放行」并在 title 带 decided_by；人工放行仍显示「已允许一次」', () => {
  const auto = ui.approvalCardMarkup({
    id: 'apr_auto', status: 'allowed', botName: 'Builder', tool_name: 'bash',
    display_reason: '需要推送', created_at: '2026-11-14T12:00:00.000Z', expires_at: '2026-11-14T12:10:00.000Z',
    decided_at: '2026-11-14T12:00:01.000Z', decided_by: 'auto:rule:arul_push', tool_target: 'git push origin dev',
  })
  assert.ok(auto.includes('规则自动放行'), '自动放行有独立状态文案')
  assert.ok(auto.includes('auto:rule:arul_push'), 'decided_by 进 title 展示')
  assert.ok(!auto.includes('data-action="approval-decide"'), '已决卡片无按钮')

  const human = ui.approvalCardMarkup({
    id: 'apr_human', status: 'allowed', botName: 'Builder', tool_name: 'bash',
    display_reason: '需要推送', created_at: '2026-11-14T12:00:00.000Z', expires_at: '2026-11-14T12:10:00.000Z',
    decided_at: '2026-11-14T12:00:01.000Z', decided_by: 'user:local',
  })
  assert.ok(human.includes('已允许一次'))
  assert.ok(!human.includes('规则自动放行'))
})

// ===== 读源断言：留痕红线与透传次序 =====

test('读源断言：免审分支在认领链内（INSERT 之后、锚点之前），不碰 pending 链路本体', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(join(here, '..', 'src', 'services', 'approvals.ts'), 'utf8')
  const insertAt = source.indexOf('INSERT INTO approvals')
  const autoAt = source.indexOf('matchApprovalAutoRule({ botId')
  const anchorAt = source.indexOf('// 卡片锚点：群聊落 messages')
  assert.ok(insertAt > 0 && autoAt > insertAt && anchorAt > autoAt, '免审判定夹在落行与锚点之间：命中则不落锚点/通知')
  assert.match(source, /'approval\.auto_allow'/)
  assert.match(source, /`auto:rule:\$\{autoRule\.id\}`/)
})

test('追溯放行：规则保存后重判已 pending 的审批，命中即时 allowed-once 并留痕', async () => {
  const ctx = new FakeCordisCtx()
  const { root, store, service } = await setup({ ctx })
  try {
    const project = await primeProject(store, service, 'Retro Allow')
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    bindSession(store, { sessionId: 'sess-retro', botId: director.id, projectId: project.id })
    seedRules(store, [])
    service.config.approvalTimeoutMs = 10_000

    // 发起时规则表为空 → 落 pending 卡，宿主侧 Promise 仍挂起。
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-retro-1', arguments: { command: 'taptap-maker preview --target-dir /Users/x/.taptap-maker/preview' } }, () => Promise.resolve('ok'))
    let nexted = false
    const outcome = service.handleApprovalRequest(makeReq({ sessionId: 'sess-retro', callId: 'call-retro-1', zh: '需要开真窗口' }).req, () => { nexted = true })
    const pendingRow = store.get("SELECT * FROM approvals WHERE status = 'pending'")
    assert.ok(pendingRow, '无规则时必须落 pending 卡')
    assert.equal(nexted, false)

    // owner 补规则（保存动作触发追溯重判）→ pending 卡即时放行，挂起的请求 resolve。
    await service.updateApprovalRules([{ command: '**taptap-maker preview**' }])
    assert.equal(await outcome, 'allowed-once', '挂起中的提权请求应被追溯放行结果唤醒')
    const row = store.get('SELECT * FROM approvals WHERE id = ?', pendingRow.id)
    assert.equal(row.status, 'allowed')
    assert.match(row.decided_by, /^auto:rule:/)
    const auditRow = store.get("SELECT * FROM audit_log WHERE action = 'approval.auto_allow' AND target_id = ?", row.id)
    assert.ok(auditRow, '追溯放行必须写审计事件')
    assert.equal(JSON.parse(auditRow.data_json).retroactive, true)
    // 未命中的 pending 卡不受影响。
    await ctx.waterfall({}, 'tools/pre-execute', { name: 'bash', callId: 'call-retro-2', arguments: { command: 'rm -rf /elsewhere' } }, () => Promise.resolve('ok'))
    const other = service.handleApprovalRequest(makeReq({ sessionId: 'sess-retro', callId: 'call-retro-2' }).req, () => {})
    const otherRow = store.get("SELECT * FROM approvals WHERE status = 'pending' AND call_id = 'call-retro-2'")
    assert.ok(otherRow, '未命中的 pending 卡保持原样')
    service.settleApproval(otherRow.id, 'cancelled', 'rejected', null)
    await other
  } finally { await rm(root, { recursive: true, force: true }) }
})
