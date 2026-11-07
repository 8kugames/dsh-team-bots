// tests/task-dispatch-gate.test.ts —— DSHBOTS-303 核验纪律派单闸。
// owner 硬口径：核验/审计/复核类卡不派成员 bot（该类工作由总监自有子代理执行），
// 与 D-302 提示词边界守门（review-auto 源码锚）构成双层防线。守门：
// a) 核验类卡派成员被拒（badRequest + 指引文案，标题/描述/复合词三形态）；
// b) 同卡派 director 放行；
// c) 实施卡含「验证/验收」不误伤（负例）；
// d) 关键词常量锚（保守三词取舍见 task-dispatch.ts 常量注释）；
// e) 重派/改卡路径同闸（改卡面为核验措辞派成员被拒，派 director 放行）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { VERIFICATION_TASK_KEYWORDS } from '../src/services/task-dispatch.js'

// 只记账不回调完成：运行停在 running，任务停在在办状态。
class HoldingRuntime {
  declare started: unknown[]
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push({ id: run.id, kind: run.kind }); return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dispatch-gate-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Gate', key: 'GATE', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-gate-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return { root, store, service, director, dev, project, sessionId }
}

async function cleanup(root, service, store) {
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try { await service.cancelRunInternal(run.id, false) } catch {}
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const rejectsVerificationDispatch = (promise) => assert.rejects(
  promise,
  (error: { status: number; message: string }) => {
    assert.equal(error.status, 400, 'badRequest 同款错误链')
    assert.match(error.message, /核验\/审计\/复核类任务由总监（owner bot）自有子代理执行，不派成员 bot/)
    assert.match(error.message, /如确为实施类工作请改标题\/描述措辞/)
    return true
  },
)

test('a) 核验类卡派成员 bot 被拒：标题/描述/复合词三形态同拒', async () => {
  const t = await setup()
  try {
    await rejectsVerificationDispatch(t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '核验 D-300 交付', description: '实施卡描述', write_scopes: ['src/a.js'],
    }))
    await rejectsVerificationDispatch(t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '普通标题', description: '对最近的交付做子代理核验并给出红验证', write_scopes: ['src/a.js'],
    }))
    await rejectsVerificationDispatch(t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '审计', description: '实施卡描述', write_scopes: ['src/a.js'],
    }))
    await rejectsVerificationDispatch(t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '普通标题', description: '复核一下', write_scopes: ['src/a.js'],
    }))
    assert.equal(t.store.get("SELECT COUNT(*) AS n FROM tasks")?.n ?? 0, 0, '被拒的卡不落库')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('b) 同款核验卡派 director 放行', async () => {
  const t = await setup()
  try {
    const task = await t.service.assignFromBot(t.sessionId, {
      assignee: 'director', title: '核验 D-300 交付', description: '审计复核一遍', write_scopes: ['src/a.js'],
    })
    assert.equal(task.identifier, 'GATE-1', '派总监不受核验闸限制')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('c) 实施卡不误伤：「验证/验收」字样与自校要求放行', async () => {
  const t = await setup()
  try {
    const task = await t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '跑通验证流程', description: '实现验证脚本并跑通验证流程；交付前自跑测试把证据写进交付报告。', write_scopes: ['src/verify.js'],
    })
    assert.equal(task.identifier, 'GATE-1', '含「验证」的实施卡不误伤')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('d) 关键词常量锚：保守三词（核验/审计/复核）', () => {
  assert.deepEqual(VERIFICATION_TASK_KEYWORDS, ['核验', '审计', '复核'],
    '「验收/验证」为实施卡常用词不纳入，复合词（子代理核验/红验证）由「核验」覆盖')
})

test('e) 重派/改卡同闸：卡面改成核验措辞派成员被拒，派 director 放行', async () => {
  const t = await setup()
  try {
    const task = await t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '实施卡', description: '正常实施工作。', write_scopes: ['src/a.js'],
    })
    // 改卡为核验措辞再重派成员：被拒，且原卡未被改成核验措辞（闸在 updateTask 之前）。
    await rejectsVerificationDispatch(t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', task: 'GATE-1', title: '改为核验交付', description: '子代理核验一遍',
    }))
    assert.equal(t.store.get('SELECT title FROM tasks WHERE id = ?', task.id).title, '实施卡', '拒绝发生在改卡生效前')
    // 首卡 autoStart 的施工运行占住换负责人闸门（D-169 既有口径）：取消后再验证 director 放行。
    for (const run of t.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)) {
      await t.service.cancelRunInternal(run.id, false)
    }
    // 同款改卡重派 director：放行。
    const updated = await t.service.assignFromBot(t.sessionId, {
      assignee: 'director', task: 'GATE-1', title: '改为核验交付', description: '子代理核验一遍',
    })
    assert.equal(updated.title, '改为核验交付', '派 director 重派改卡不受限')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})
