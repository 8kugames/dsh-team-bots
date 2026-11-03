// tests/lifecycle-slim.test.js —— DSHBOTS-96 P2+P3：生命周期消息压缩、Open tasks 瘦身、
// 短状态通知不进尾窗（P3-1）、密钥长理由围栏化（P3-2）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { nowIso } from '../src/util.js'

class ManualRuntime {
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-x' }
  async steer() { return true }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-slim-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const project = await service.createProject({ name: 'Slim', key: 'SLM', ownerBotId: director.id, memberIds: [dev.id] })
  const runtime = new DshRuntime({ ctx: null, config, store, logger: { info() {}, warn() {}, error() {} } })
  const botRow = store.get('SELECT * FROM bots WHERE id = ?', dev.id)
  const projectRow = store.get('SELECT * FROM projects WHERE id = ?', project.id)
  return {
    root, store, service, director, dev, botRow, projectRow, runtime,
    say: body => service.insertMessage({ projectId: project.id, senderType: 'user', senderId: 'u1', body }),
    system: body => service.insertMessage({ projectId: project.id, senderType: 'system', senderId: 'system', body }),
    close: async () => {
      try { store.close() } catch {}
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('P3-1：无信息量 system 短状态不进尾窗，有信息量的照常进', async () => {
  const t = await setup()
  try {
    await t.system('已写入项目记忆。')
    await t.system('任务 SLM-1 验收通过。')
    await t.system('密钥 DEPLOY_KEY 的请求被拒绝。')
    await t.system('任务 SLM-2 被总监退回重做。')
    await t.say('普通消息正文')
    const prompt = t.runtime.promptFor({
      run: { kind: 'chat', mode: 'read' }, bot: t.botRow, project: t.projectRow,
      task: null, chatMessage: null, sessionId: 's-noise',
    })
    assert.ok(!prompt.includes('已写入项目记忆'), '记忆写入回执不进尾窗')
    assert.ok(!prompt.includes('验收通过'), '验收通过短状态不进尾窗（Open tasks 已覆盖）')
    assert.ok(!prompt.includes('被拒绝'), '密钥拒绝短状态不进尾窗')
    assert.ok(prompt.includes('被总监退回重做'), '白名单外的 system 消息照常进窗')
    assert.ok(prompt.includes('普通消息正文'), '普通消息照常进窗')
  } finally { await t.close() }
})

test('P2-2：Open tasks 注入收紧到 5 条', async () => {
  const t = await setup()
  try {
    for (let i = 1; i <= 7; i++) {
      await t.service.createTask({ projectId: t.projectRow.id, title: `任务零${i}`, assigneeBotId: t.dev.id, postCard: false })
    }
    const prompt = t.runtime.promptFor({
      run: { kind: 'chat', mode: 'read' }, bot: t.botRow, project: t.projectRow,
      task: null, chatMessage: null, sessionId: 's-tasks',
    })
    const listed = prompt.match(/^- SLM-\d+ \[.*$/gm) ?? []
    assert.equal(listed.length, 5, 'Open tasks 最多列 5 条')
  } finally { await t.close() }
})

test('P2-1：创建卡消息压缩为「已创建 → @负责人」，不再重复携带标题', async () => {
  const t = await setup()
  try {
    await t.service.createTask({ projectId: t.projectRow.id, title: '落地看板联动', assigneeBotId: t.dev.id })
    const card = t.store.get(
      "SELECT body FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '任务 SLM-%'",
      t.projectRow.id,
    )
    assert.ok(card, '创建卡应照常投递')
    assert.equal(card.body, '任务 SLM-1 已创建 → @Builder')
    assert.ok(!card.body.includes('落地看板联动'), '标题不重复携带（任务详情在卡与看板里）')
    const unassigned = await t.service.createTask({ projectId: t.projectRow.id, title: '无主任务', postCard: true })
    const card2 = t.store.get('SELECT body FROM messages WHERE body LIKE ?', `任务 SLM-${unassigned.number} 已创建%`)
    assert.equal(card2.body, `任务 SLM-${unassigned.number} 已创建`, '无负责人时不带指派尾巴')
  } finally { await t.close() }
})

test('P3-2：密钥请求理由 >100 字符进围栏，短理由保持单行', async () => {
  const t = await setup()
  try {
    const sessionId = 'sess-slim-1'
    t.store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, 'project', ?)",
      sessionId, t.dev.id, t.projectRow.id, nowIso(),
    )
    const longReason = '需要在 CI 流水线里拉取私有 npm 包做端到端安装验证，本地已用只读 token 验证过 registry 可达性、鉴权头格式与包元数据拉取，当前缺正式发布凭据，无法在干净环境复现完整安装链路，详情见任务卡里的联调记录与回执截图说明。'
    t.service.requestSecretFromBot({ sessionId, name: 'NPM_TOKEN', reason: longReason })
    const longBody = t.store.get("SELECT body FROM messages WHERE body LIKE '%NPM_TOKEN%' AND body LIKE '%理由%'").body
    assert.ok(longBody.includes(`理由：\n\`\`\`\n${longReason}\n\`\`\``), '长理由独立成围栏块')

    t.service.requestSecretFromBot({ sessionId, name: 'SHORT_KEY', reason: '支付联调' })
    const shortBody = t.store.get("SELECT body FROM messages WHERE body LIKE '%SHORT_KEY%' AND body LIKE '%理由%'").body
    assert.ok(shortBody.includes('\n理由：支付联调\n'), '短理由保持单行不围栏')
  } finally { await t.close() }
})
