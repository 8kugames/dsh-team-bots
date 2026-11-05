// tests/tmp-dirs.test.js —— DSHBOTS-225 守门：工作区临时文件纪律。
// 建群生成 .tmp/bots/ 且含 ignore 文件（内容 *，整个 .tmp 不入 git）；
// 成员入群生成 .tmp/bots/{bot名}/ 子目录；目录创建失败静默降级不阻塞建群/入群；
// 提示词注入 bot 自己的临时目录路径与纪律；bot 名目录名安全化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { sanitizeTmpBotDirName } from '../src/paths.js'

// 只需 runtime 存在：目录与提示词逻辑不启动 run。
class StubRuntime { declare models: any[]
  constructor() {
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }
  setCompletionHandler() {}
  async catalog() { return this.models }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tmp-dirs-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const close = async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
  return { root, workspace, store, service, config, close }
}

const now = () => new Date().toISOString()

function bindSession(store, { sessionId, botId, projectId, kind = 'project', taskId = null }) {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId, botId, projectId, kind, taskId, now(),
  )
}

test('建项目生成 .tmp/bots/ 与 ignore 文件（内容 *），初始成员各有子目录', async () => {
  const t = await setup()
  try {
    const director = t.store.get("SELECT * FROM bots WHERE name = 'director'")
    const dev = await t.service.createBot({ name: 'Builder', role: '开发', provider: 'fake', model: 'model-a' })
    const view = await t.service.createProject({ name: 'Tmp 项目', key: 'TMPD', ownerBotId: director.id, memberIds: [dev.id] })
    const botsDir = join(t.workspace, view.slug, '.tmp', 'bots')
    assert.ok((await stat(botsDir)).isDirectory(), '.tmp/bots/ 目录应存在')
    assert.equal(await readFile(join(t.workspace, view.slug, '.tmp', '.gitignore'), 'utf8'), '*\n', 'ignore 文件内容应为 *（整个 .tmp 不入 git）')
    for (const name of ['director', 'Builder']) {
      assert.ok((await stat(join(botsDir, sanitizeTmpBotDirName(name)))).isDirectory(), `成员 ${name} 的临时目录应存在`)
    }
  } finally { await t.close() }
})

test('加 bot 入群生成 .tmp/bots/{bot名}/ 子目录', async () => {
  const t = await setup()
  try {
    const director = t.store.get("SELECT * FROM bots WHERE name = 'director'")
    const architect = await t.service.createBot({ name: '架构师', role: '架构', provider: 'fake', model: 'model-a' })
    const view = await t.service.createProject({ name: 'Join 项目', key: 'JOIN', ownerBotId: director.id })
    await t.service.addProjectMember(view.id, architect.id, { type: 'user', id: 'owner' })
    const botsDir = join(t.workspace, view.slug, '.tmp', 'bots')
    assert.ok((await stat(join(botsDir, '架构师'))).isDirectory(), '入群成员应有自己的临时目录')
    assert.ok((await stat(join(botsDir, 'director'))).isDirectory(), '建群时的总监目录仍在')
  } finally { await t.close() }
})

test('目录创建失败静默降级：.tmp 被同名文件占位时建群与入群均不抛错', async () => {
  const t = await setup()
  try {
    const director = t.store.get("SELECT * FROM bots WHERE name = 'director'")
    const dev = await t.service.createBot({ name: 'Builder', role: '开发', provider: 'fake', model: 'model-a' })
    // 预置项目目录并在 .tmp 位置放普通文件：ensureBotTmpDirs 必然失败
    const slug = 'degr'
    await mkdir(join(t.workspace, slug), { recursive: true })
    await writeFile(join(t.workspace, slug, '.tmp'), 'not a dir')
    const view = await t.service.createProject({ name: 'Degr 项目', key: 'DEGR', ownerBotId: director.id })
    assert.equal(view.slug, slug, '降级不阻塞建群主流程')
    const added = await t.service.addProjectMember(view.id, dev.id, { type: 'user', id: 'owner' })
    assert.ok(added.members.some(member => member.name === 'Builder'), '降级不影响成员入库')
  } finally { await t.close() }
})

test('提示词注入：项目会话 identity 含 .tmp/bots/{bot名}/ 纪律行，solo 会话不含', async () => {
  const t = await setup()
  try {
    const director = t.store.get("SELECT * FROM bots WHERE name = 'director'")
    const dev = await t.service.createBot({ name: 'Builder', role: '开发', provider: 'fake', model: 'model-a' })
    const view = await t.service.createProject({ name: 'Prompt 项目', key: 'PTMP', ownerBotId: director.id, memberIds: [dev.id] })
    const runtime = new DshRuntime({ ctx: { on() {} }, config: t.config, store: t.store, logger: { info() {}, warn() {}, error() {} } })
    bindSession(t.store, { sessionId: 'sess-tmp-project', botId: dev.id, projectId: view.id })
    bindSession(t.store, { sessionId: 'sess-tmp-solo', botId: dev.id, projectId: null, kind: 'solo' })
    const projectPrompt = runtime.systemPromptFor({ agent: { id: 'sess-tmp-project' } })
    assert.match(projectPrompt, /\.tmp\/bots\/Builder\//, '项目会话提示词应告知 bot 自己的临时目录路径')
    assert.match(projectPrompt, /Never scatter temp files elsewhere/, '应注入临时文件纪律（不许四处散放）')
    assert.doesNotMatch(
      runtime.systemPromptFor({ agent: { id: 'sess-tmp-solo' } }),
      /\.tmp\/bots\//,
      'solo 会话走 soloPromptFor，不注入项目临时目录纪律',
    )
  } finally { await t.close() }
})

test('sanitizeTmpBotDirName：非法字符替换、空白归一、首尾点连字符剥离、空回退', () => {
  assert.equal(sanitizeTmpBotDirName('dev/bot:*?"<>|x'), 'dev-bot-------x')
  assert.equal(sanitizeTmpBotDirName('高级 程序猿'), '高级-程序猿')
  assert.equal(sanitizeTmpBotDirName('  ..希望..  '), '希望')
  assert.equal(sanitizeTmpBotDirName('.hidden-bot'), 'hidden-bot')
  assert.equal(sanitizeTmpBotDirName('..'), 'bot')
  assert.equal(sanitizeTmpBotDirName(null), 'bot')
})
