// tests/prompt-budget.test.ts —— DSHBOTS-254：提示词体量预算守门。
// ① 静态前缀：三段拆卡指引合并去重后合计 ≤1200 字符，旧三标题各至多出现一次，
//    整段静态前缀（header → # Assigned task 之前）不超阈值（防静默回胖）；
// ② 任务分支长描述复用 review/handle 的 8k 截断口径（带盲区标记）；
// ③ 任务评论注入 ≤3 条、合计 ≤1.5k 字符，只取最近。
// 段序与缓存守门另见 tests/prompt-prefix-order.test.ts；短语级语义守门另见
// tests/subtask-discipline.test.ts。
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-prompt-budget-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  config.agentTeam = true // 拉开 parallel 段，预算口径含三段全量
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  store.setSetting('subagent_delivery_gate', '0') // DSHBOTS-311 夹具：本文件用例非闸主题，关闸保持既有交付流
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
  return { store, service, runtime, director, dev, project, close }
}

const rowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

test('静态前缀预算：三段拆卡指引合计 ≤1200，旧三标题各至多一次，整段前缀不超阈值', async () => {
  const t = await setup()
  try {
    const actor = { type: 'user', id: t.service.localUserId }
    const card = await t.service.createTask({ projectId: t.project.id, title: '预算卡', writeScopes: ['src/a.js'] }, actor)
    const prompt = t.runtime.promptFor({
      run: { kind: 'task' }, bot: t.dev, project: t.project, task: rowOf(t.store, card.id),
    })

    // 旧三标题各至多出现一次（合并去重后不允许任何标题重复注入）。
    for (const title of ['# Subtask discipline', '# Splitting for speed', '# Parallel work inside this task']) {
      const count = prompt.split(title).length - 1
      assert.equal(count, 1, `${title} 应恰好出现一次（实测 ${count}）`)
    }

    // 三段各自抽取（标题起到下一段开始，去尾随空白），合计 ≤1200。
    const at = (marker) => prompt.indexOf(marker)
    const sections = [
      prompt.slice(at('# Subtask discipline'), at('# Splitting for speed')),
      prompt.slice(at('# Splitting for speed'), at('Do the task in the project workspace')),
      prompt.slice(at('# Parallel work inside this task'), at('# Assigned task')),
    ].map(text => text.replace(/\s+$/, ''))
    const total = sections.reduce((sum, text) => sum + text.length, 0)
    assert.ok(total <= 1_200, `三段拆卡指引合计应 ≤1200 字符（实测 ${total}）`)
    for (const text of sections) assert.ok(text.length > 0, '三段都应在场（agentTeam 开启）')

    // 整段静态前缀（到 # Assigned task 之前）不超阈值：防后续段落静默回胖。
    const prefix = prompt.slice(0, at('# Assigned task'))
    assert.ok(prefix.length <= 1_900, `静态前缀应 ≤1900 字符（实测 ${prefix.length}）`)
  } finally { await t.close() }
})

test('任务分支 8k 截断：长描述截断带盲区标记，与 review 分支同口径；短描述不截断', async () => {
  const t = await setup()
  try {
    const actor = { type: 'user', id: t.service.localUserId }
    const longText = `long-${'D'.repeat(9_000)}`
    const longCard = await t.service.createTask(
      { projectId: t.project.id, title: '长卡', description: longText, writeScopes: ['src/b/'] },
      actor,
    )
    // 置空时效预算：描述后无其他段落，截断结果可整段度量。
    t.store.run('UPDATE tasks SET time_budget_minutes = NULL WHERE id = ?', longCard.id)
    const prompt = t.runtime.promptFor({
      run: { kind: 'task' }, bot: t.dev, project: t.project, task: rowOf(t.store, longCard.id),
    })

    // 与 review/handle 同一截断标记（同一 truncateTaskDescription 管线）。
    const expectedMarker = `\n\n[Task description is ${longText.length} characters, over the 8000 limit; it is truncated here — the hidden remainder is not shown, so base your conclusions on the truncated description and say so]`
    assert.ok(prompt.includes(expectedMarker.trim()), '长描述必须带 8k 截断盲区标记')
    const descStart = prompt.indexOf('Description:\n') + 'Description:\n'.length
    const injected = prompt.slice(descStart)
    assert.ok(injected.length <= 8_000 + expectedMarker.length, `注入描述应 ≤8k 正文 + 截断标记（实测 ${injected.length}）`)
    assert.equal(injected, longText.slice(0, 8_000) + expectedMarker, '截断结果必须是 前 8000 字符 + 统一标记')

    // 同口径对照：review 分支对同一张卡产出同一标记。
    const reviewPrompt = t.runtime.promptFor({
      run: { kind: 'review', trigger_type: 'review_requested' }, bot: t.dev, project: t.project, task: rowOf(t.store, longCard.id),
    })
    assert.ok(reviewPrompt.includes(`[Task description is ${longText.length} characters, over the 8000 limit`), 'review 分支应带同一截断标记')

    // 短描述不截断、无标记。
    const shortCard = await t.service.createTask(
      { projectId: t.project.id, title: '短卡', description: '短描述。', writeScopes: ['src/c/'] },
      actor,
    )
    t.store.run('UPDATE tasks SET time_budget_minutes = NULL WHERE id = ?', shortCard.id)
    const shortPrompt = t.runtime.promptFor({
      run: { kind: 'task' }, bot: t.dev, project: t.project, task: rowOf(t.store, shortCard.id),
    })
    assert.ok(!shortPrompt.includes('it is truncated here'), '短描述不得出现截断标记')
    assert.ok(shortPrompt.includes('Description:\n短描述。'), '短描述应完整注入')
  } finally { await t.close() }
})

test('评论注入预算：≤3 条、合计 ≤1.5k、只取最近', async () => {
  const t = await setup()
  try {
    const actor = { type: 'user', id: t.service.localUserId }
    const card = await t.service.createTask({ projectId: t.project.id, title: '评论卡', writeScopes: ['src/d/'] }, actor)
    t.store.run('UPDATE tasks SET time_budget_minutes = NULL WHERE id = ?', card.id)
    const base = Date.now()
    for (let i = 1; i <= 4; i++) {
      t.store.run(
        'INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        `cmt_budget_${i}`, card.id, 'user', 'u1', `第${i}条-${'x'.repeat(700)}`, new Date(base + i * 1_000).toISOString(),
      )
    }
    const prompt = t.runtime.promptFor({
      run: { kind: 'task' }, bot: t.dev, project: t.project, task: rowOf(t.store, card.id),
    })
    assert.ok(prompt.includes('Recent task comments:'), '有评论时应注入评论段')
    const lines = prompt.split('\n').filter(line => line.startsWith('- [c_'))
    assert.equal(lines.length, 3, `评论注入应 ≤3 条（实测 ${lines.length}）`)
    const total = lines.join('\n').length
    assert.ok(total <= 1_500, `评论合计应 ≤1.5k 字符（实测 ${total}）`)
    assert.ok(lines.some(line => line.includes('第4条')), '应包含最新一条')
    assert.ok(lines.some(line => line.includes('第2条')), '应包含最近三条中最旧一条')
    assert.ok(!prompt.includes('第1条'), '超出条数上限的最旧评论不得注入')
    // 每条正文 500 上限：行总长不超过 前缀(~60) + 500 + 省略号。
    for (const line of lines) assert.ok(line.length <= 570, `单条评论行应 ≤570 字符（实测 ${line.length}）`)
  } finally { await t.close() }
})
