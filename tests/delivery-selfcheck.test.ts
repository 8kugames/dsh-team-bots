// tests/delivery-selfcheck.test.ts —— DSHBOTS-276 派单质量前置守门（P1）。
// 治 GS 实测 34% 补丁/返工卡：交付报告缺自跑验证证据 + 同范围勘误碎片化。
// a) 任务模板含交付前自校段，既有锚点前缀不变（含 D-274 时效段 Deadline 结构），
//    只追加（D-269 手法）；review 分支不注入该段；
// b) 勘误并卡提示双条件（标题关键词 + 近 7 天同承接人 done 卡写范围交集）+ 仅追加
//    描述一行、不拦截派单（D-82/D-270 既有拒绝行为不变）；
// c) 负锚：无交集 / 无关键词时不注入提示。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

const PROMPT_SRC = readFileSync(fileURLToPath(new URL('../src/services/runtime/prompt.ts', import.meta.url)), 'utf8')
const DISPATCH_SRC = readFileSync(fileURLToPath(new URL('../src/services/task-dispatch.ts', import.meta.url)), 'utf8')

class ManualRuntime {
  declare started: any[]
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }: any) { this.started.push(run.id); return `session-${run.id}` }
  async steer() { return true }
  async cancelRun() { return true }
}

async function setup(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), `dsh-selfcheck-${prefix}-`))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  service.started = false
  service.executeRun = async () => {}
  const director = store.get('SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)')
  const dev = await service.createBot({ name: 'SelfcheckDev', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Selfcheck', key: 'DSC', ownerBotId: director.id, memberIds: [dev.id] })
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    'sess-dsc', director.id, project.id, 'project', new Date().toISOString(),
  )
  const promptRuntime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const close = async () => {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const active = Number(store.get('SELECT COUNT(*) AS n FROM runs WHERE status IN (\'queued\', \'running\')')?.n ?? 0)
      if (active === 0) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { store, service, promptRuntime, director, dev, project, sessionId: 'sess-dsc', close }
}

const NOTE_MARK = '(note: recent done card'

// ── a) 任务模板：自校段在场 + 既有锚点前缀不变（D-274 Deadline 结构原样）──

test('a1) 源码锚：自校段为固定追加段（marker 对 + 关键文案被钉），位置在 Status 与 Description 之间', () => {
  assert.ok(PROMPT_SRC.includes('// delivery-selfcheck:start') && PROMPT_SRC.includes('// delivery-selfcheck:end'), '自校段须有 start/end marker（沿用既有静态段惯例）')
  const block = PROMPT_SRC.slice(PROMPT_SRC.indexOf('// delivery-selfcheck:start'), PROMPT_SRC.indexOf('// delivery-selfcheck:end'))
  assert.ok(block.includes('# Delivery self-check'), '自校段标题被钉')
  assert.ok(block.includes('put the evidence in the delivery report'), '证据进交付报告口径被钉')
  assert.ok(block.includes('exact test/build commands') && block.includes('list of files you changed'), '测试命令+结果、改动文件清单要求被钉')
  assert.ok(block.includes('counts or links the acceptance criteria name'), '验收标准的计数/链接核对被钉')
  assert.ok(block.includes('Self-checking is always cheaper than rework'), '先自校再报交付的经济口径被钉')
  // 只追加（D-269 手法）：自校段插在卡头 Status 行之后、Description 之前，既有锚点行原样保留。
  assert.ok(PROMPT_SRC.includes('Status: ${task.status}${deliverySelfcheckBlock}\nDescription:'), '注入点钉在 Status 与 Description 之间，Status/Description 既有行不改写')
})

test('a2) 源码锚：D-274 时效段结构原样（Deadline 行 + 时效模板链），自校段不触碰静态前缀三段', () => {
  assert.ok(PROMPT_SRC.includes('Deadline: ${new Date(deadline.deadlineMs).toISOString()} / ${Math.ceil(remainingMs / 60_000)} min remaining.'), 'D-274 剩余时间行原样')
  assert.ok(PROMPT_SRC.includes('this is a wrap-up turn'), 'D-274 耗尽收尾轮文案原样')
  assert.ok(PROMPT_SRC.includes('# Time budget'), '时效段标题锚点原样')
  assert.ok(PROMPT_SRC.includes('${description}${threads}${timeBudgetBlock}${urgentExemptionBlock}${recoveryNoteBlock}'), '任务模板尾部链（描述→评论→时效→豁免→恢复）原样——自校段不插进 8k 截断度量区')
})

test('a3) 运行态：施工提示词注入自校段；review 提示词不注入（该段属任务运行模板）', async () => {
  const t = await setup('prompt')
  try {
    const card = await t.service.createTask({
      projectId: t.project.id, title: '带预算卡', assigneeBotId: t.dev.id,
      timeBudgetMinutes: 30, writeScopes: ['src/**'], description: 'Do it.',
    }, { type: 'user', id: t.service.localUserId })
    const run = t.service.enqueueTaskRun(t.service.taskRow(card.id), 'task_started', { type: 'user', id: 'u1' })
    const runRow = t.store.get('SELECT * FROM runs WHERE id = ?', run)
    const base = { bot: t.dev, project: t.project, sessionId: 's-x' }
    const prompt = t.promptRuntime.promptFor({ run: runRow, ...base, task: t.service.taskRow(card.id) })
    assert.equal(prompt.split('# Delivery self-check').length - 1, 1, '施工提示词恰好注入一段自校段')
    assert.match(prompt, /Deadline: \S+ \/ \d+ min remaining\./, 'D-274 剩余时间行仍注入（不回归）')
    const reviewPrompt = t.promptRuntime.promptFor({
      run: { kind: 'review', task_id: card.id, trigger_type: 'review' } as any, ...base, task: t.service.taskRow(card.id),
    })
    assert.ok(!reviewPrompt.includes('# Delivery self-check'), 'review 分支不注入自校段')
  } finally {
    await t.close()
  }
})

// ── b/c) 勘误并卡提示：双条件 + 仅追加不拦截；负锚不注入 ──

test('b1) 源码锚：关键词 + 交集 + 7 天窗口 + 仅追加（提示路径无 throw，既有拒绝文案原样）', () => {
  assert.ok(DISPATCH_SRC.includes('const CORRECTION_TITLE_RE = /修正|勘误|补充|改写/'), '修正类关键词集合被钉（修正/勘误/补充/改写）')
  assert.ok(DISPATCH_SRC.includes('const RECENT_DONE_WINDOW_MS = 7 * 86_400_000'), '近 7 天窗口常量被钉')
  const helper = DISPATCH_SRC.slice(DISPATCH_SRC.indexOf('findRecentDoneOverlapTask('), DISPATCH_SRC.indexOf('async assignFromBot'))
  assert.ok(helper.includes("status = 'done'"), '只查 done 卡')
  assert.ok(helper.includes('COALESCE(completed_at, updated_at)'), 'done 终态时刻优先（D-69 回填兜底）')
  assert.ok(helper.includes('assignee_bot_id = ?'), '限定同承接人')
  assert.ok(helper.includes('other.some(scope => target.has(scope))'), '写范围交集判定（元素级）')
  // 仅追加不拦截：提示注入代码段（关键词判定 → createTask 前）不含任何 throw。
  const inject = DISPATCH_SRC.slice(DISPATCH_SRC.indexOf('勘误并卡提示（DSHBOTS-276，不强制）'), DISPATCH_SRC.indexOf('const task = await this.createTask'))
  assert.ok(inject.includes('CORRECTION_TITLE_RE.test') && inject.includes('findRecentDoneOverlapTask'), '双条件（关键词 + 交集）同时命中才注入')
  assert.ok(inject.includes(NOTE_MARK), '并卡提示行模板被钉')
  assert.ok(!inject.includes('throw'), '提示路径零拦截（不新增任何拒绝行为）')
  assert.ok(DISPATCH_SRC.includes('派单必须声明写范围'), 'D-26 写范围闸门文案原样（既有拒绝行为不变）')
})

async function doneCardWithScopes(t: any, writeScopes: string[], title: string) {
  const card = await t.service.createTask({
    projectId: t.project.id, title, assigneeBotId: t.dev.id, writeScopes, description: '先做一版.',
  }, { type: 'user', id: t.service.localUserId })
  // 夹具直写终态（todo→done 不经流转校验；SQL 回填先例见 task-deadline 测试回拨 runs）。
  t.store.run(
    "UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?",
    new Date().toISOString(), new Date().toISOString(), card.id,
  )
  return t.service.taskRow(card.id)
}

test('b2/c) 运行态：双条件命中追加提示行且派单不被拦截；无关键词 / 无交集均不注入', async () => {
  const t = await setup('dispatch')
  try {
    const done = await doneCardWithScopes(t, ['src/x/'], '首版交付')
    const actor = { type: 'user', id: t.service.localUserId }
    // b) 命中：标题含关键词 + 同承接人近 7 天 done 卡写范围有交集 → 描述尾部追加提示行，派单照常成立。
    const hit = await t.service.assignFromBot(t.sessionId, {
      assignee: 'SelfcheckDev', title: '修正首版文案', description: '按反馈修正。', write_scopes: ['src/x/'],
    })
    assert.ok(hit.id, '双条件命中时派单不被拦截（仅提示）')
    const hitRow = t.service.taskRow(hit.id)
    assert.ok(hitRow.description.includes(NOTE_MARK), '描述尾部追加并卡提示行')
    assert.ok(hitRow.description.includes(`recent done card DSC-${done.number} `), '提示行点名近期 done 卡号')
    assert.ok(hitRow.description.endsWith('consider merging follow-up corrections into one card)'), '提示行追加在描述尾部')
    assert.ok(hitRow.description.includes('按反馈修正。'), '原描述保留，只追加不改写')
    // c) 负锚一：标题无关键词（仍与 done 卡有交集）→ 不注入。scopes 加一项避开 D-82
    //    完全一致检测（在办卡 DSC-hit 集合不相等即可，交集判定不受影响）。
    const noKeyword = await t.service.assignFromBot(t.sessionId, {
      assignee: 'SelfcheckDev', title: '新增独立功能', description: '全新模块。', write_scopes: ['src/x/', 'src/z/'],
    })
    assert.ok(!t.service.taskRow(noKeyword.id).description.includes(NOTE_MARK), '无修正类关键词时不注入提示')
    // c) 负锚二：写范围无交集（标题含关键词）→ 不注入。
    const noOverlap = await t.service.assignFromBot(t.sessionId, {
      assignee: 'SelfcheckDev', title: '补充新目录脚本', description: '独立目录。', write_scopes: ['src/y/'],
    })
    assert.ok(!t.service.taskRow(noOverlap.id).description.includes(NOTE_MARK), '与近期 done 卡写范围无交集时不注入提示')
    assert.equal(actor.type, 'user')
  } finally {
    await t.close()
  }
})
