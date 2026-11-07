// tests/control-plane-subagent.test.ts —— 子智能体化解除后的执行口径守门。
// 锁三组锚点：
//  ① 施工方式自选——亲做或派专属子代理均可、派时命名 <bot 名>-<任务号>、不许多卡并给
//     一个子代理（强制每卡子代理 + 交付硬闸已解除，治施工堵塞）；
//  ② 写范围/沙箱继承——子代理写继承控制面会话沙箱、不受任务写范围调度闸门约束，
//     卡面声明写范围作为子智能体提示词的写入边界（ADR §2.4 三层补偿之②）；
//  ③ 交付模板——子智能体回报（变更/验证/风险）→ bot 合并并亲自审查 → 再出交付报告。
// 预算与段序红线由 tests/prompt-budget.test.ts / tests/prompt-prefix-order.test.ts 守门，
// 本文件只钉新段内容与门控。
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

async function setup({ agentTeam = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cp-subagent-'))
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
  const devView = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const projectView = await service.createProject({ name: 'Order', key: 'ORD', ownerBotId: director.id, memberIds: [devView.id] })
  const dev = store.get('SELECT * FROM bots WHERE id = ?', devView.id)
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const runtime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, runtime, dev, project, close }
}

const rowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

test('任务提示词三组锚点：按任务号开子智能体 + 写范围/沙箱继承 + 交付模板', async () => {
  const t = await setup()
  try {
    const actor = { type: 'user', id: t.service.localUserId }
    const card = await t.service.createTask({ projectId: t.project.id, title: '子智能体卡', writeScopes: ['src/a.js'] }, actor)
    const prompt = t.runtime.promptFor({
      run: { kind: 'task' }, bot: t.dev, project: t.project, task: rowOf(t.store, card.id),
    })
    // ① 施工方式自选：亲做或派子代理、派时命名 bot 名+任务号、不并卡。
    assert.match(prompt, /# Child agents by task number/, '应有子智能体执行口径段')
    assert.match(prompt, /Execute each card yourself, or hand it to a dedicated child agent/, '亲做与派子代理均为合法路径')
    assert.match(prompt, /named <your bot name>-<task number>/, '派子代理命名 bot 名+任务号')
    assert.match(prompt, /never merge cards into one agent/, '不许把多张卡合并给一个子智能体')
    assert.doesNotMatch(prompt, /every card runs in a dedicated child agent/, '强制每卡子代理口径已解除')
    // ② 写范围/沙箱继承：继承控制面沙箱、绕过调度闸门、卡面写范围=写入边界。
    assert.match(prompt, /Child writes inherit your session sandbox, not the task write-scope gates/, '应声明写继承沙箱且不受任务写范围调度闸门约束')
    assert.match(prompt, /pass the card's declared write scopes as the child's write boundary/, '卡面声明写范围应作为子智能体写入边界')
    // ③ 交付模板：子智能体回报 → 合并并亲自审查 → 再交付。
    assert.match(prompt, /Children report changed paths, verification with results, risks/, '子智能体交付模板=变更/验证/风险回报')
    assert.match(prompt, /merge and review their output yourself before delivering/, 'bot 合并并亲自审查后才出交付报告')
    // 指令段恒英文（与 subtask-discipline 同口径）。
    const body = prompt.split('# Child agents by task number\n')[1]?.split('\n\n#')[0] ?? ''
    assert.ok(body, '子智能体段应在场')
    assert.ok(!/[\u4e00-\u9fff]/.test(body), '子智能体段正文必须恒英文')
  } finally { await t.close() }
})

test('段序与门控：新段位于静态区（Parallel work 之前、Do the task 之后），agentTeam 关闭不注入', async () => {
  const on = await setup({ agentTeam: true })
  const off = await setup({ agentTeam: false })
  try {
    const actor = { type: 'user', id: on.service.localUserId }
    const card = await on.service.createTask({ projectId: on.project.id, title: '顺序卡', writeScopes: ['src/b/'] }, actor)
    const prompt = on.runtime.promptFor({
      run: { kind: 'task' }, bot: on.dev, project: on.project, task: rowOf(on.store, card.id),
    })
    const at = (marker) => prompt.indexOf(marker)
    assert.ok(at('Do the task in the project workspace') < at('# Child agents by task number'), '新段应在交付样板段之后')
    assert.ok(at('# Child agents by task number') < at('# Parallel work inside this task'), '新段应在 Parallel work 段之前（后者引用 the child agents above）')
    assert.ok(at('# Parallel work inside this task') < at('# Assigned task'), '静态区整体先于每卡字段')
    assert.match(prompt, /the child agents above/, 'Parallel work 段应引用新段定义的子智能体')

    const offCard = await off.service.createTask({ projectId: off.project.id, title: '关闭卡', writeScopes: ['src/c/'] }, { type: 'user', id: off.service.localUserId })
    const offPrompt = off.runtime.promptFor({
      run: { kind: 'task' }, bot: off.dev, project: off.project, task: rowOf(off.store, offCard.id),
    })
    assert.ok(!offPrompt.includes('# Child agents by task number'), 'agentTeam 关闭时不得注入子智能体段')
    assert.ok(!offPrompt.includes('# Parallel work inside this task'), 'agentTeam 关闭时 parallel 段同样不注入')
  } finally {
    await on.close()
    await off.close()
  }
})
