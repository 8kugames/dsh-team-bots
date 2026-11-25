// tests/tool-families.test.ts —— 宿主集成工具面（MCP 服务器、引擎桥）对团队 bot 按项目「按需」可见：
// 根作用域注册的工具 preset 清单管不到，这里按项目工作区的标记文件决定放行哪一族，其余隐藏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { botToolPolicyFor } from '../src/services/runtime/session.js'
import { DIRECTOR_ONLY_TOOLS, applyBotToolPolicy } from '../src/tools.js'
import {
  DEFAULT_HIDE_TOOL_PREFIXES, hiddenToolNames, parseHideToolPrefixes, parseToolFamilyMarkers, toolPolicyFor,
} from '../src/services/runtime/tool-families.js'

test('解析：隐藏前缀清单（空白/逗号/分号分隔或数组）与「前缀=标记」映射（对象或分号分隔文本）', () => {
  assert.deepEqual(parseHideToolPrefixes('mcp__, godot_ ;x'), ['mcp__', 'godot_', 'x'])
  assert.deepEqual(parseHideToolPrefixes(['a', ' b ']), ['a', 'b'])
  assert.deepEqual(parseHideToolPrefixes(''), [])
  assert.deepEqual(parseToolFamilyMarkers('godot_=project.godot\nbad\nmcp__x__=a/b'), { godot_: 'project.godot', 'mcp__x__': 'a/b' })
  assert.deepEqual(parseToolFamilyMarkers({ godot_: 'project.godot', bad: 3, '': 'x' }), { godot_: 'project.godot' })
})

test('配置：默认隐藏全部 MCP 与 godot_，三族各有工作区标记；env/config 文本可覆盖，空串 = 不隐藏', () => {
  const defaults = resolveConfig({})
  assert.deepEqual(defaults.hideToolPrefixes, [...DEFAULT_HIDE_TOOL_PREFIXES])
  assert.deepEqual(defaults.toolFamilyMarkers, {
    'mcp__codegraph__': '.codegraph', 'mcp__taptap-maker__': '.project/project.json', godot_: 'project.godot',
  })
  const custom = resolveConfig({ hideToolPrefixes: 'mcp__', toolFamilyMarkers: 'godot_=x.godot' } as any)
  assert.deepEqual(custom.hideToolPrefixes, ['mcp__'])
  assert.deepEqual(custom.toolFamilyMarkers, { godot_: 'x.godot' })
  assert.deepEqual(resolveConfig({ hideToolPrefixes: '' } as any).hideToolPrefixes, [])
})

test('按项目工作区标记放行：有 project.godot 才放行 godot_，有 .codegraph 才放行 codegraph；没有项目目录不隐藏', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-families-'))
  try {
    const config = resolveConfig({})
    assert.deepEqual(toolPolicyFor(config, root), { hide: [...DEFAULT_HIDE_TOOL_PREFIXES], allow: [] }, '没有标记：全部隐藏')
    await writeFile(join(root, 'project.godot'), '[application]')
    assert.deepEqual(toolPolicyFor(config, root).allow, ['godot_'])
    await mkdir(join(root, '.codegraph'))
    await mkdir(join(root, '.project'))
    await writeFile(join(root, '.project', 'project.json'), '{}')
    assert.deepEqual(toolPolicyFor(config, root).allow, ['mcp__codegraph__', 'mcp__taptap-maker__', 'godot_'], '三族各有标记就都放行')
    assert.deepEqual(toolPolicyFor(config, join(root, 'missing')), { hide: [...DEFAULT_HIDE_TOOL_PREFIXES], allow: [] }, '项目目录不存在视同没有标记')
    assert.deepEqual(toolPolicyFor(config, null), { hide: [], allow: [] }, '单聊没有项目目录：不隐藏')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('会话口径：按项目目录（production_dir 优先，其次 workspace/slug）判定，单聊返回空口径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-families-rt-'))
  try {
    const workspace = join(root, 'ws')
    await mkdir(join(workspace, 'demo'), { recursive: true })
    await writeFile(join(workspace, 'demo', 'project.godot'), '[application]')
    await mkdir(join(root, 'elsewhere'))
    const config = { ...resolveConfig({}), workspace }
    assert.deepEqual(botToolPolicyFor(config, { slug: 'demo' }).allow, ['godot_'])
    assert.deepEqual(botToolPolicyFor(config, { slug: 'demo', production_dir: join(root, 'elsewhere') }).allow, [], 'production_dir 优先于 workspace/slug')
    assert.deepEqual(botToolPolicyFor(config, null), { hide: [], allow: [] }, '单聊不隐藏')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('hiddenToolNames：命中的前缀隐藏，放行的前缀保留，其余工具不动', () => {
  const names = ['mcp__taptap-maker__generate_image', 'godot_command', 'mcp__codegraph__codegraph_explore', 'bash', 'team_assign_task']
  assert.deepEqual(
    hiddenToolNames({ hide: ['mcp__', 'godot_'], allow: ['godot_'] }, names),
    ['mcp__taptap-maker__generate_image', 'mcp__codegraph__codegraph_explore'],
  )
})

test('applyBotToolPolicy：总监与成员都隐藏宿主集成工具，成员另隐藏总监专权；会话复用只补新出现的工具', () => {
  const names = ['mcp__taptap-maker__generate_image', 'godot_command', 'bash', 'team_assign_task']
  const policy = { hide: ['mcp__', 'godot_'], allow: ['godot_'] }
  const make = () => {
    const calls = []
    return { calls, tools: { definitions: () => names.map(name => ({ name })), restrict: filter => calls.push(filter) } }
  }
  const owner = make()
  applyBotToolPolicy({ agent: { ctx: { tools: owner.tools } } }, { isOwner: true, toolPolicy: policy })
  assert.deepEqual(owner.calls, [{ deny: ['mcp__taptap-maker__generate_image'] }], '总监只隐藏宿主集成工具')

  const member = make()
  const handle = { ctx: { tools: member.tools } }
  const denied = new WeakMap<object, Set<string>>()
  applyBotToolPolicy(handle, { isOwner: false, toolPolicy: policy, denied })
  assert.deepEqual(member.calls, [{ deny: [...DIRECTOR_ONLY_TOOLS] }, { deny: ['mcp__taptap-maker__generate_image'] }])
  applyBotToolPolicy(handle, { isOwner: false, toolPolicy: policy, denied })
  assert.equal(member.calls.length, 3, '复用时成员兜底照做，宿主集成工具没有新名字就不重复叠层')
  member.tools.definitions = () => [...names, 'mcp__late__tool'].map(name => ({ name }))
  applyBotToolPolicy(handle, { isOwner: false, toolPolicy: policy, denied })
  assert.deepEqual(member.calls.slice(3), [{ deny: [...DIRECTOR_ONLY_TOOLS] }, { deny: ['mcp__late__tool'] }], '后注册的工具在下一次经过时补隐藏')
})

test('applyBotToolPolicy：没有口径（单聊）或宿主无 definitions 时不隐藏；隐藏失败只告警，不挡成员兜底', () => {
  const calls = []
  const warn = []
  const logger = { warn: message => warn.push(message) }
  const bare = { restrict: filter => calls.push(filter) }
  applyBotToolPolicy({ ctx: { tools: bare } }, { isOwner: true, toolPolicy: { hide: ['mcp__'], allow: [] }, logger })
  assert.deepEqual(calls, [], '宿主没有 definitions：无从取名，不隐藏')
  applyBotToolPolicy({ ctx: { tools: bare } }, { isOwner: false, toolPolicy: { hide: ['mcp__'], allow: [] }, logger })
  assert.deepEqual(calls, [{ deny: [...DIRECTOR_ONLY_TOOLS] }], '成员兜底不受影响')
  applyBotToolPolicy({ ctx: { tools: { definitions: () => [{ name: 'mcp__x__tool' }], restrict: filter => calls.push(filter) } } }, { isOwner: true, toolPolicy: null, logger })
  assert.equal(calls.length, 1, '单聊没有口径：不隐藏')
  let thrown = 0
  applyBotToolPolicy(
    { ctx: { tools: { definitions: () => [{ name: 'mcp__x__tool' }], restrict: () => { thrown += 1; throw new Error('names unknown global tool') } } } },
    { isOwner: false, toolPolicy: { hide: ['mcp__'], allow: [] }, logger },
  )
  assert.equal(thrown, 2, '成员兜底与隐藏各尝试一次')
  assert.equal(warn.length, 2)
  assert.match(warn[1], /隐藏宿主集成工具失败：names unknown global tool/)
})
