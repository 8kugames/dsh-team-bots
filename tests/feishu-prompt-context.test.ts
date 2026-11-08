// tests/feishu-prompt-context.test.ts —— DSHBOTS-330/331 守门：通道直达语境提示块按 trigger_type 分流。
// ① 飞书触发运行注入飞书版语境块（含多轮连续性/建卡派单/ask_user_question 指引，
//    且不含微信专属的「禁 * #」条款——飞书出站走 messages-reply --markdown，原生 Markdown）；
// ② 微信块内容逐字零改动；
// ③ 普通 UI 触发（trigger_type='mention'）两块都不注入；
// ④ DSHBOTS-331：生产入站走 solo 分支（kind='solo_chat'），语境块要注入到 solo：
//    飞书 solo 注入（含建卡指引与无 KEY 追问锚点）/ 微信 solo 注入 / mention solo 不注入
//    且「无项目禁 team_assign_task」禁令仍在。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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

// 微信块现状全文（DSHBOTS-215/283）——内容零改动的逐字锚。
const WECHAT_BLOCK = `

# WeChat direct conversation
This message is from the project owner on WeChat — a real multi-turn conversation, not a one-off command. The project session is shared, so keep continuity across turns instead of restarting context each time. If the owner asks you to get work done, actually create and assign the task (team_assign_task — cards carry the project KEY-N number; do not create project-less task-N cards on the host shared board) instead of only acknowledging it. If you need the owner to decide something, use ask_user_question: it is forwarded to their WeChat and their reply comes back to you. WeChat renders no Markdown: use plain text with blank lines and - lists, never * or #.`

// 微信专属条款（飞书块不得含；mention 块两者都不含）。
const WECHAT_ONLY_CLAUSE = 'WeChat renders no Markdown'
// 飞书专属条款（微信 solo 块不得含）。
const FEISHU_ONLY_CLAUSE = 'Feishu renders Markdown natively'
// 普通 UI 单聊的禁令（mention 保留）。
const SOLO_NO_PROJECT_BAN = 'There is no project here: do not use team_assign_task or team_review_task.'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-prompt-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const projectView = await service.createProject({ name: 'Order', key: 'ORD', ownerBotId: director.id })
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const runtime = new DshRuntime({ ctx: {}, config, store, logger: { info() {}, warn() {}, error() {} } })
  return { root, store, runtime, project, director }
}

async function teardown(root, store) {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

test('飞书触发运行注入飞书版语境块：含关键指引锚点、不含微信专属禁用条款', async () => {
  const { root, store, runtime, project, director } = await setup()
  try {
    const prompt = runtime.promptFor({
      run: { kind: 'chat', trigger_type: 'feishu' },
      bot: director,
      project,
      chatMessage: { id: 'm-1', body: '帮我看下这个需求', sender_type: 'user', sender_id: 'u-local' },
    })
    assert.match(prompt, /# Feishu direct conversation/, '飞书语境块在场')
    assert.match(prompt, /multi-turn conversation/, '多轮连续性指引在场')
    assert.match(prompt, /team_assign_task/, '建卡派单纪律在场')
    assert.match(prompt, /ask_user_question/, 'ask_user_question 指引在场')
    assert.match(prompt, /Feishu renders Markdown natively/, '按飞书口径写渲染差异')
    assert.doesNotMatch(prompt, new RegExp(WECHAT_ONLY_CLAUSE), '不含微信专属 Markdown 禁用条款')
    assert.doesNotMatch(prompt, /never \* or #/, '不含微信专属的禁 * # 条款')
    assert.doesNotMatch(prompt, /# WeChat direct conversation/, '不注入微信块')
  } finally {
    await teardown(root, store)
  }
})

test('微信触发运行语境块逐字零改动', async () => {
  const { root, store, runtime, project, director } = await setup()
  try {
    const prompt = runtime.promptFor({
      run: { kind: 'chat', trigger_type: 'wechat' },
      bot: director,
      project,
      chatMessage: { id: 'm-2', body: '帮我看下这个需求', sender_type: 'user', sender_id: 'u-local' },
    })
    assert.ok(prompt.includes(WECHAT_BLOCK), '微信块全文逐字不变')
    assert.match(prompt, /# WeChat direct conversation/)
    assert.doesNotMatch(prompt, /# Feishu direct conversation/, '不注入飞书块')
  } finally {
    await teardown(root, store)
  }
})

test('普通 UI 触发（mention）两块都不注入', async () => {
  const { root, store, runtime, project, director } = await setup()
  try {
    const prompt = runtime.promptFor({
      run: { kind: 'chat', trigger_type: 'mention' },
      bot: director,
      project,
      chatMessage: { id: 'm-3', body: '帮我看下这个需求', sender_type: 'user', sender_id: 'u-local' },
    })
    assert.doesNotMatch(prompt, /# WeChat direct conversation/, 'mention 不注入微信块')
    assert.doesNotMatch(prompt, /# Feishu direct conversation/, 'mention 不注入飞书块')
    assert.doesNotMatch(prompt, /multi-turn conversation/)
    assert.doesNotMatch(prompt, new RegExp(WECHAT_ONLY_CLAUSE))
  } finally {
    await teardown(root, store)
  }
})

// DSHBOTS-331：生产入站（微信/飞书直达落 director 专属工作区 solo 会话）走 solo 分支，
// 语境块必须落在这里——群聊分支那份对真实通道直达是死代码。
test('飞书 solo 运行注入飞书版语境块：含建卡指引与无 KEY 追问锚点', async () => {
  const { root, store, runtime, director } = await setup()
  try {
    const prompt = runtime.promptFor({
      run: { kind: 'solo_chat', trigger_type: 'feishu' },
      bot: director,
      chatMessage: { id: 'sm-1', body: '帮我把这个需求派下去', sender_type: 'user', sender_id: 'ou-admin' },
    })
    assert.match(prompt, /# Feishu direct conversation/, '飞书 solo 语境块在场')
    assert.match(prompt, /multi-turn conversation/, '多轮连续性指引在场')
    assert.match(prompt, /team_assign_task/, '建卡派单指引在场')
    assert.match(prompt, /cards carry the project KEY-N number/, '建卡口径在位（项目 KEY-N 编号）')
    assert.match(prompt, /carries a project key such as \[项目 ORD\]/, '带 [项目 KEY] 时定向该项目的锚点在场')
    assert.match(prompt, /carries no key, first ask the owner which project it belongs to/, '无 KEY 先追问落哪个项目的锚点在场')
    assert.match(prompt, /ask_user_question/, '追问工具指引在场')
    assert.match(prompt, /Feishu renders Markdown natively/, '按飞书口径写渲染差异')
    assert.doesNotMatch(prompt, new RegExp(WECHAT_ONLY_CLAUSE), '不含微信专属 Markdown 禁用条款')
    assert.doesNotMatch(prompt, /never \* or #/, '不含微信专属的禁 * # 条款')
    assert.doesNotMatch(prompt, /# WeChat direct conversation/, '不注入微信块')
    assert.doesNotMatch(prompt, new RegExp(SOLO_NO_PROJECT_BAN), '通道来源运行不再带「无项目禁派活」禁令')
    assert.match(prompt, /arrived from the Feishu channel/, '派活放开的口径在位')
  } finally {
    await teardown(root, store)
  }
})

test('微信 solo 运行注入微信版语境块', async () => {
  const { root, store, runtime, director } = await setup()
  try {
    const prompt = runtime.promptFor({
      run: { kind: 'solo_chat', trigger_type: 'wechat' },
      bot: director,
      chatMessage: { id: 'sm-2', body: '帮我把这个需求派下去', sender_type: 'user', sender_id: 'wx-admin' },
    })
    assert.match(prompt, /# WeChat direct conversation/, '微信 solo 语境块在场')
    assert.match(prompt, /team_assign_task/, '建卡派单指引在场')
    assert.match(prompt, /carries a project key such as \[项目 ORD\]/, '带 [项目 KEY] 时定向该项目的锚点在场')
    assert.match(prompt, /carries no key, first ask the owner which project it belongs to/, '无 KEY 先追问落哪个项目的锚点在场')
    assert.match(prompt, new RegExp(WECHAT_ONLY_CLAUSE), '按微信口径写渲染差异（禁 * #）')
    assert.doesNotMatch(prompt, new RegExp(FEISHU_ONLY_CLAUSE), '不含飞书专属渲染条款')
    assert.doesNotMatch(prompt, /# Feishu direct conversation/, '不注入飞书块')
    assert.doesNotMatch(prompt, new RegExp(SOLO_NO_PROJECT_BAN), '通道来源运行不再带「无项目禁派活」禁令')
    assert.match(prompt, /arrived from the WeChat channel/, '派活放开的口径在位')
  } finally {
    await teardown(root, store)
  }
})

test('普通 UI 单聊（mention）solo 不注入通道块且禁令仍在', async () => {
  const { root, store, runtime, director } = await setup()
  try {
    const prompt = runtime.promptFor({
      run: { kind: 'solo_chat', trigger_type: 'mention' },
      bot: director,
      chatMessage: { id: 'sm-3', body: '帮我看下这个需求', sender_type: 'user', sender_id: 'u-local' },
    })
    assert.doesNotMatch(prompt, /# WeChat direct conversation/, 'mention solo 不注入微信块')
    assert.doesNotMatch(prompt, /# Feishu direct conversation/, 'mention solo 不注入飞书块')
    assert.doesNotMatch(prompt, /multi-turn conversation/, 'mention solo 无通道语境')
    assert.doesNotMatch(prompt, /arrived from the /, 'mention solo 无通道来源口径')
    assert.ok(prompt.includes(SOLO_NO_PROJECT_BAN), 'mention solo 保留「无项目禁派活」禁令')
  } finally {
    await teardown(root, store)
  }
})
