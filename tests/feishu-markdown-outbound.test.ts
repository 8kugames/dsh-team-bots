// 飞书出站 markdown 守门：飞书卡片富文本组件原生渲染 markdown——
// ①出站一律交互卡片（纯文本消息的 \n 是段落间距，版面松）；
// ②提问/审批卡片按 markdown 写（题头加粗、选项列表化）；
// ③逐通道正文：微信纯文本镜像，飞书 markdown 卡片。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { outboundPayload } from '../src/feishu/channel.js'
import { approvalCard, questionCard } from '../src/feishu/format.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-md-'))
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
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime() as any)
  await service.initialize()
  service.started = true
  return { root, store, service }
}

test('出站一律交互卡片：正文进 markdown 组件，纯文本消息不再用', () => {
  const payload = outboundPayload('第一行\n第二行')
  assert.equal(payload.msgType, 'interactive')
  const card = JSON.parse(payload.content)
  assert.equal(card.elements[0].tag, 'markdown')
  assert.equal(card.elements[0].content, '第一行\n第二行')
})

test('飞书提问卡片是 markdown：题头加粗、选项列表化、带 token 与回复格式', () => {
  const items = [{
    id: 'q1',
    question: 'D1 怪物牌四点照准？',
    options: [
      { label: '照准（推荐）', description: 'A 版绢白纸底' },
      { label: '部分调整' },
    ],
  }]
  const body = questionCard('镜花缘', 'director', items, 'f9288c')
  assert.ok(body.startsWith('**【提问】director（镜花缘）**'))
  assert.ok(body.includes('**Q1: D1 怪物牌四点照准？**'))
  assert.ok(body.includes('- 1. 照准（推荐） — A 版绢白纸底'))
  assert.ok(body.includes('- 2. 部分调整'))
  assert.ok(body.includes('答 f9288c'))
  assert.ok(!body.includes('\r'))
})

test('飞书审批卡片是 markdown：工具/原因/答复格式齐备', () => {
  const body = approvalCard('镜花缘', 'director', 'bash', '需要执行写操作', 'ab12cd')
  assert.ok(body.startsWith('**【审批】director（镜花缘）**'))
  assert.ok(body.includes('工具：bash'))
  assert.ok(body.includes('原因：需要执行写操作'))
  assert.ok(body.includes('批 ab12cd'))
})

test('提问转发逐通道正文：微信纯文本镜像，飞书 markdown 卡片', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'Feishu MD', key: 'FM', ownerBotId: director.id })
    const project = store.get("SELECT * FROM projects WHERE key = 'FM'")
    const wechatPushed: string[] = []
    const feishuPushed: string[] = []
    ;(service as any).wechat = { notify: (text: string) => wechatPushed.push(text) }
    ;(service as any).feishu = { notify: (text: string) => feishuPushed.push(text) }

    const items = [{ id: 'q1', question: '用哪个方案？', options: [{ label: '方案一' }, { label: '方案二' }] }]
    assert.equal(service.wechatQuestion(project, { id: 'qstABC123XYZ', bot_name: director.name }, items), true)
    assert.equal(wechatPushed.length, 1)
    assert.equal(feishuPushed.length, 1)
    // 微信：纯文本镜像，不带 markdown 记号。
    assert.ok(wechatPushed[0].includes('【提问】'))
    assert.ok(!wechatPushed[0].includes('**'))
    // 飞书：markdown 卡片。
    assert.ok(feishuPushed[0].startsWith('**【提问】'))
    assert.ok(feishuPushed[0].includes('- 1. 方案一'))
    assert.ok(feishuPushed[0].includes('答 123xyz'))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
