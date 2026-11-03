// DSHBOTS-132：子任务拆解产品化——team_assign_task 暴露 parent_task_id + 任务提示词注入拆解纪律。
// 覆盖：工具 schema 契约（additionalProperties=false 下不声明即传不进）、owner 派单透传落库、
// 任务提示词注入纪律段（与时效/紧急段互不干扰）、非任务运行零注入、
// parent_task_id 空串/不存在/跨项目 → 400（沿用 task-relations 校验，锁不回归）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { installTeamTools } from '../src/tools.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subtask-discipline-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

async function seedProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Nest', key: 'NEST', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project }
}

function ownerSession(store, director, project) {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    'sess-owner', director.id, project.id, 'project', new Date().toISOString(),
  )
  return 'sess-owner'
}

const cleanup = async ({ root, store }) => {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const rowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

test('工具 schema 契约：team_assign_task 声明 parent_task_id 并注明后端校验口径', () => {
  const tools = []
  installTeamTools({ tools: { register: (tool) => tools.push(tool) } }, {})
  const tool = tools.find(item => item.name === 'team_assign_task')
  assert.ok(tool, 'team_assign_task 未注册')
  const field = tool.parameters.properties.parent_task_id
  // additionalProperties=false：schema 不声明就等于派单方永远传不进，产品能力断了最后一环。
  assert.ok(field, 'schema 必须声明 parent_task_id，否则后端 assignFromBot 收不到该参数')
  assert.equal(field.type, 'string')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.match(field.description, /same project/i, 'description 应注明同项目内引用')
  assert.match(field.description, /self-reference is rejected/i, 'description 应注明不许自引用')
  assert.match(field.description, /backend validates/i, 'description 应注明后端校验')
})

test('owner 派单透传：assignFromBot 带 parent_task_id 落到新任务行与 taskView', async () => {
  const ctx = await setup()
  try {
    const { director, dev, project } = await seedProject(ctx.service, ctx.store)
    const sessionId = ownerSession(ctx.store, director, project)
    const main = await ctx.service.createTask(
      { projectId: project.id, title: '主项改造', writeScopes: ['src/main.js'] },
      { type: 'bot', id: director.id },
    )
    assert.equal(main.identifier, 'NEST-1')

    const sub = await ctx.service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '主项下的收口子卡', description: '写范围：tests/sub.js',
      parent_task_id: main.id,
    })
    assert.equal(sub.identifier, 'NEST-2')
    assert.equal(rowOf(ctx.store, sub.id).parent_task_id, main.id, '子卡行应挂主项 parent_task_id')
    assert.equal(ctx.service.taskView(rowOf(ctx.store, sub.id)).parent_task_id, main.id, 'taskView 应透出 parent_task_id')

    // 不带 parent_task_id 的派单不受影响（默认无父）。
    const plain = await ctx.service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '普通卡', description: '写范围：tests/plain.js',
    })
    assert.equal(rowOf(ctx.store, plain.id).parent_task_id, null, '未传 parent_task_id 应为 NULL')
    assert.equal(dev.name, 'Builder')
  } finally {
    await cleanup(ctx)
  }
})

test('任务提示词注入纪律段：拆解义务 + 产品级子卡要求 + KEY-N 清单，与时效/紧急段互不干扰', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await seedProject(ctx.service, ctx.store)
    const runtime = new DshRuntime({ ctx: null, config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    const botRow = ctx.store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const projectRow = ctx.store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const actor = ctx.service.actor()
    const plain = await ctx.service.createTask({ projectId: project.id, title: '普通任务', writeScopes: ['src/a.js'] }, actor)
    const urgentBudgeted = await ctx.service.createTask(
      { projectId: project.id, title: '紧急限时任务', priority: 'urgent', time_budget_minutes: 30, writeScopes: ['src/b.js'] },
      actor,
    )

    const promptOf = (row) => runtime.promptFor({ run: { kind: 'task' }, bot: botRow, project: projectRow, task: rowOf(ctx.store, row.id) })

    const plainPrompt = promptOf(plain)
    assert.match(plainPrompt, /# Subtask discipline/, '所有任务卡都应注入纪律段标题')
    assert.match(plainPrompt, /team_assign_task[\s\S]*parent_task_id/, '应指示用 team_assign_task 传 parent_task_id 立子卡')
    assert.match(plainPrompt, /收口条件/, '应覆盖「新收口条件」触发口径')
    assert.match(plainPrompt, /通用能力、完整测试、真实落库/, '子卡应要求产品级实现')
    assert.match(plainPrompt, /禁止临时补丁或为单次场景写死/, '应禁止临时补丁与场景写死')
    assert.match(plainPrompt, /能.*做完的不拆|一次做完的不拆/, '应约束能一次做完的不拆')
    assert.match(plainPrompt, /KEY-N/, '应要求收工报告列出子卡 KEY-N 清单')
    assert.ok(!plainPrompt.includes('# Time budget'), '普通卡不应误入时效段')
    assert.ok(!plainPrompt.includes('# Urgent exemption'), '普通卡不应误入紧急豁免段')

    // 互不干扰：urgent + 时效任务三段并存，各自完整。
    const mixed = promptOf(urgentBudgeted)
    for (const marker of ['# Time budget', '# Urgent exemption', '# Subtask discipline']) {
      assert.ok(mixed.includes(marker), `混合卡应同时含 ${marker}`)
    }
    assert.match(mixed, /within 30 minutes/, '时效段数值不受纪律段影响')
  } finally {
    await cleanup(ctx)
  }
})

test('非任务运行零注入：群聊运行提示词不含拆解纪律段', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await seedProject(ctx.service, ctx.store)
    const runtime = new DshRuntime({ ctx: null, config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    const botRow = ctx.store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const projectRow = ctx.store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const chatPrompt = runtime.promptFor({
      run: { kind: 'chat' }, bot: botRow, project: projectRow, task: null,
      chatMessage: { id: 'msg-x', body: '在吗' },
    })
    assert.match(chatPrompt, /# Group message/, 'chat 运行应走群聊提示词分支')
    assert.ok(!chatPrompt.includes('# Subtask discipline'), '非任务运行不得注入拆解纪律段')
    assert.ok(!chatPrompt.includes('parent_task_id'), '群聊提示词不应出现 parent_task_id 纪律文案')
  } finally {
    await cleanup(ctx)
  }
})

test('parent_task_id 空串或不存在的任务 → 400：拒单不落卡（task-relations 校验不回归）', async () => {
  const ctx = await setup()
  try {
    const { director, project } = await seedProject(ctx.service, ctx.store)
    const sessionId = ownerSession(ctx.store, director, project)
    const main = await ctx.service.createTask(
      { projectId: project.id, title: '主项', writeScopes: ['src/main.js'] },
      { type: 'bot', id: director.id },
    )
    const countBefore = Number(ctx.store.get('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?', project.id)?.n ?? 0)

    await assert.rejects(
      () => ctx.service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '空串父', description: '写范围：tests/empty.js', parent_task_id: '',
      }),
      (error) => {
        assert.equal(error.status, 400)
        assert.equal(error.code, 'BAD_REQUEST')
        assert.match(error.message, /不能为空字符串/)
        return true
      },
    )
    await assert.rejects(
      () => ctx.service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '幽灵父', description: '写范围：tests/ghost.js', parent_task_id: 'task_does_not_exist',
      }),
      (error) => {
        assert.equal(error.status, 400)
        assert.equal(error.code, 'BAD_REQUEST')
        assert.match(error.message, /父任务 task_does_not_exist 不存在/)
        return true
      },
    )
    const countAfter = Number(ctx.store.get('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?', project.id)?.n ?? 0)
    assert.equal(countAfter, countBefore, '两次拒单都不得落卡')
    assert.equal(main.identifier, 'NEST-1')
  } finally {
    await cleanup(ctx)
  }
})

test('跨项目父任务 → 400：parent 必须同项目（task-relations 同项目校验不回归）', async () => {
  const ctx = await setup()
  try {
    const { director, project } = await seedProject(ctx.service, ctx.store)
    const other = await ctx.service.createProject({ name: 'Other', key: 'OTH', ownerBotId: director.id, memberIds: [] })
    const foreignMain = await ctx.service.createTask(
      { projectId: other.id, title: '别项目主项', writeScopes: ['src/x.js'] },
      { type: 'bot', id: director.id },
    )
    const sessionId = ownerSession(ctx.store, director, project)
    await assert.rejects(
      () => ctx.service.assignFromBot(sessionId, {
        assignee: 'Builder', title: '跨项目子卡', description: '写范围：tests/cross.js', parent_task_id: foreignMain.id,
      }),
      (error) => {
        assert.equal(error.status, 400)
        assert.equal(error.code, 'BAD_REQUEST')
        assert.match(error.message, /不在当前项目内/)
        return true
      },
    )
    assert.equal(
      Number(ctx.store.get('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?', project.id)?.n ?? 0),
      0,
      '拒单不得在当前项目落卡',
    )
  } finally {
    await cleanup(ctx)
  }
})
