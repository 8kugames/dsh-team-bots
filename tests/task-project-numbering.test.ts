// tests/task-project-numbering.test.ts —— DSHBOTS-237 守门：建卡强制项目编号（KEY-N），
// 禁止把任务卡建到宿主共享板（task-N 无项目编号卡）。锁四件事：
//  ① 无项目语境建卡 → createTask 直接报错引导「请指定项目」，不落库；
//  ② 有项目语境建卡 → 编号落库为「项目 KEY-N」（项目内自增 number + identifier）；
//  ③ 共享板兼容口径 = 可读不可新建：成员能力清单不再宣告 team_task_create，
//     list/get/update（读与流转）保留；
//  ④ 教学面守门：插件源码（工具声明 + 运行提示词）不再引导 bots 用共享板建卡。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { SUBAGENT_GENERATION_TOOLS } from '../src/tools.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-numbering-'))
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
  const projectView = await service.createProject({ name: 'Numbering', key: 'PN', ownerBotId: director.id })
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, director, project, close }
}

test('无项目语境建卡：报错引导「请指定项目」，不落库', async () => {
  const t = await setup()
  try {
    for (const projectId of [undefined, null, '', '   ']) {
      await assert.rejects(
        () => t.service.createTask({ projectId, title: '无项目卡' } as any),
        /建卡必须归属项目：请指定项目/,
        `projectId=${String(projectId)} 应报引导错误`,
      )
    }
    // 传了但查无此项目：仍是「项目不存在」，与缺项目语境的引导分开。
    await assert.rejects(
      () => t.service.createTask({ projectId: 'proj_no_such', title: '幽灵项目' }),
      /项目不存在/,
    )
    assert.equal(t.store.get('SELECT COUNT(*) AS n FROM tasks')?.n, 0, '全部被拒后 tasks 表应无落库')
  } finally { await t.close() }
})

test('有项目语境建卡：编号落库为项目 KEY-N（项目内自增）', async () => {
  const t = await setup()
  try {
    const first = await t.service.createTask({ projectId: t.project.id, title: '一号卡', postCard: false })
    assert.equal(first.identifier, 'PN-1', '首卡编号应为 PN-1')
    assert.equal(first.number, 1)
    const second = await t.service.createTask({ projectId: t.project.id, title: '二号卡', postCard: false })
    assert.equal(second.identifier, 'PN-2', '同项目第二卡编号应为 PN-2')
    const row = t.store.get('SELECT id, project_id, number FROM tasks WHERE id = ?', second.id)
    assert.equal(row.project_id, t.project.id, '落库行必须归属项目')
    assert.equal(row.number, 2, '项目内自增 number 落库')
    // 另一项目各自从 1 起：编号与项目绑定，不存在跨项目共享的 task-N 口径。
    const otherView = await t.service.createProject({ name: 'Other', key: 'OT', ownerBotId: t.director.id })
    const other = await t.service.createTask({ projectId: otherView.id, title: '别项目首卡', postCard: false })
    assert.equal(other.identifier, 'OT-1', '新项目首卡应从 OT-1 起')
  } finally { await t.close() }
})

test('共享板口径：成员能力清单不再宣告 team_task_create（可读不可新建）', () => {
  const generation: readonly string[] = SUBAGENT_GENERATION_TOOLS
  assert.ok(!generation.includes('team_task_create'), '共享板建卡工具不得再作为成员能力宣告')
  for (const name of ['team_task_list', 'team_task_get', 'team_task_update']) {
    assert.ok(generation.includes(name), `存量共享板卡可读可流转，${name} 应保留`)
  }
})

test('教学面守门：插件源码不再引导共享板建卡（task-N 口径废弃）', async () => {
  const toolsSrc = await readFile(new URL('../src/tools.ts', import.meta.url), 'utf8')
  const promptSrc = await readFile(new URL('../src/services/runtime/prompt.ts', import.meta.url), 'utf8')
  assert.ok(!toolsSrc.includes('team_task_create'), 'src/tools.ts 不应再出现 team_task_create（能力宣告与注释均不引导）')
  assert.ok(!promptSrc.includes('team_task_create'), '运行提示词不应再教 bots 用共享板建卡')
  assert.match(promptSrc, /never on the host shared task board/, '并行拆分指引应明确「不落共享板」')
  assert.match(promptSrc, /cards carry the project KEY-N number/, '微信 owner 链路应明确「卡带项目编号」')
})
