// DSHBOTS-328：任务通知域的出站通道扇出守门。
// task-created / task-done 两个锚点此前硬编码 this.wechat?.notify——任务创建/完成事件
// 「只到微信不到飞书」。本卡改走 core.ts 的 channelNotify（DSHBOTS-326 落码）：
// ①两通道都启用→同一事件两边各收一条（正文一致、各沿用既有收据键）；
// ②仅微信启用→与现状零回归（单发一条、同一收据键、飞书未挂载不报错）；
// ③飞书失败→微信照收且留痕 warn（单通道失败不阻断另一通道）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-notify-fanout-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace,
    dataDir: join(root, 'data'),
    skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0,
    schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  const warnings: string[] = []
  const service = new TeamService({
    store,
    config,
    logger: {
      info() {},
      warn(...args: unknown[]) { warnings.push(args.map(arg => String(arg)).join(' ')) },
      error() {},
    },
  })
  service.attachRuntime(new StubRuntime() as any)
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  await service.createProject({ name: 'Task Fanout Demo', key: 'TFN', ownerBotId: director.id })
  const project = store.get("SELECT * FROM projects WHERE key = 'TFN'")
  return { root, store, service, project, director, warnings }
}

/** 通道桩：记录 (text, opts)；fail=true 时抛错模拟通道故障。 */
function channelStub(record: Array<{ text: string, opts: any }>, fail = false) {
  return {
    notify(text: string, opts: any) {
      if (fail) throw new Error('通道推送失败（模拟）')
      record.push({ text, opts })
    },
  }
}

/** 无负责人的卡：不会派单起跑，测试期内只观察通知扇出。 */
async function createPlainTask(service, project, title: string) {
  return service.createTask({ projectId: project.id, title, status: 'todo', postCard: false })
}

/** 走真实状态机到 done（todo → in_progress → in_review → done），done 收口即 notifyTaskDone。 */
async function completeTask(service, taskId: string) {
  const actor = { type: 'user', id: service.localUserId }
  await service.transitionTask(taskId, 'in_progress', actor)
  await service.transitionTask(taskId, 'in_review', actor)
  await service.transitionTask(taskId, 'done', actor)
}

test('任务通知扇出：task-created / task-done 两通道各收一条（正文一致、收据键沿用既有键）', async () => {
  const { root, store, service, project } = await setup()
  try {
    const wechatPushed: Array<{ text: string, opts: any }> = []
    const feishuPushed: Array<{ text: string, opts: any }> = []
    ;(service as any).wechat = channelStub(wechatPushed)
    ;(service as any).feishu = channelStub(feishuPushed)

    const task = await createPlainTask(service, project, '扇出任务')
    assert.equal(wechatPushed.length, 1, '微信收到创建通知')
    assert.equal(feishuPushed.length, 1, '飞书收到同一创建通知')
    assert.equal(wechatPushed[0].text, feishuPushed[0].text, '两通道创建通知正文一致')
    assert.equal(wechatPushed[0].opts.receiptKey, `task-created:${task.id}`, '创建收据键沿用 task-created:<id>')
    assert.equal(feishuPushed[0].opts.receiptKey, `task-created:${task.id}`, '两通道同一收据键（各库内各自幂等）')
    assert.ok(wechatPushed[0].text.includes('已创建'))

    await completeTask(service, task.id)
    assert.equal(wechatPushed.length, 2, '微信收到完成通知')
    assert.equal(feishuPushed.length, 2, '飞书收到同一完成通知')
    assert.equal(wechatPushed[1].text, feishuPushed[1].text, '两通道完成通知正文一致')
    assert.equal(wechatPushed[1].opts.receiptKey, `task-done:${task.id}`, '完成收据键沿用 task-done:<id>')
    assert.equal(feishuPushed[1].opts.receiptKey, `task-done:${task.id}`)
    assert.ok(wechatPushed[1].text.includes('已完成'))
    assert.equal(service.taskRow(task.id).status, 'done')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('任务通知扇出：仅微信启用时零回归（单发一条、同一收据键，飞书未挂载不报错）', async () => {
  const { root, store, service, project } = await setup()
  try {
    const wechatPushed: Array<{ text: string, opts: any }> = []
    ;(service as any).wechat = channelStub(wechatPushed)
    ;(service as any).feishu = null

    const task = await createPlainTask(service, project, '仅微信任务')
    assert.equal(wechatPushed.length, 1, '只推一条，不重复')
    assert.equal(wechatPushed[0].opts.receiptKey, `task-created:${task.id}`)
    assert.ok(wechatPushed[0].text.includes('已创建'))

    await completeTask(service, task.id)
    assert.equal(wechatPushed.length, 2, '完成只推一条')
    assert.equal(wechatPushed[1].opts.receiptKey, `task-done:${task.id}`)
    assert.ok(wechatPushed[1].text.includes('已完成'))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('任务通知扇出：飞书失败不阻断微信（微信照收，失败留痕 warn）', async () => {
  const { root, store, service, project, warnings } = await setup()
  try {
    const wechatPushed: Array<{ text: string, opts: any }> = []
    ;(service as any).wechat = channelStub(wechatPushed)
    ;(service as any).feishu = channelStub([], true)

    const task = await createPlainTask(service, project, '飞书故障任务')
    assert.equal(wechatPushed.length, 1, '飞书失败不影响微信收到创建通知')
    assert.ok(
      warnings.some(line => line.includes('feishu') && line.includes('通道推送失败')),
      `飞书失败必须留痕，实际：${JSON.stringify(warnings)}`,
    )

    await completeTask(service, task.id)
    assert.equal(wechatPushed.length, 2, '完成通知同样飞书失败微信照收')
    assert.equal(service.taskRow(task.id).status, 'done', '通知失败不影响已落库的状态变更')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
