// DSHBOTS-258 守门：微信自由文本默认投递 director 专属工作区（项目外 director 通道）。
// 口径以第三次 amend 为准：路由收敛为两条——/tr <key>: 显式转发 → 对应项目；
// 其余一切自由文本（含已绑定、单项目、原 <key>: 冒号写法）→ director solo 通道，
// 用户不直接进任何项目群聊；自由文本永不触发 no_target/needPickProject。
// 全部用真 TeamService（临时库）跑，不用桩替代路由链。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { handleCommand } from '../src/wechat/commands.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

const count = (store, sql, ...args) => Number(store.get(sql, ...args)?.n ?? 0)

async function boot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
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
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  // 通道桩：只暴露路由与回程依赖的两个面（admin peer id、notify 采集）。
  ;(service as any).wechat = { notify() {}, status: () => ({ adminPeerId: 'wx_admin_peer' }) }
  return { root, store, service }
}

test('① 无 key 自由文本：一律落 director solo 通道，不进任何项目群聊，不触发 needPickProject', async () => {
  const { root, store, service } = await boot('dsh-wechat-solo-1-')
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    assert.ok(director?.solo_dir, '种子 director 必须带 solo_dir（专属工作区目录，读到哪个是哪个）')
    // 多 active 项目：证明自由文本不随 active 项目数变化
    await service.createProject({ name: 'Alpha', key: 'ALPHA', ownerBotId: director.id })
    await service.createProject({ name: 'Beta', key: 'BETA', ownerBotId: director.id })
    const messagesBefore = count(store, 'SELECT COUNT(*) AS n FROM messages')

    let bound = null
    const reply = await handleCommand(service, '帮我看下今天的安排', {
      boundKey: null,
      bind: key => { bound = key },
    })
    assert.ok(reply.includes('已直达【director】专属工作区'), `首触应回执 director 通道：${reply}`)
    assert.ok(!reply.includes('还没有选定直达的项目'), '自由文本永不触发 needPickProject')
    assert.equal(bound, null, 'director 通道是项目外的，不得回写项目绑定')

    const solo = store.get("SELECT * FROM solo_messages WHERE sender_id = 'wx_admin_peer'")
    assert.ok(solo, '消息必须落 director 的 solo_messages')
    assert.equal(solo.bot_id, director.id)
    assert.equal(solo.sender_type, 'user')
    assert.equal(solo.sender_id, 'wx_admin_peer', '身份用微信 admin 的 peer id，不冒充 localUserId')
    assert.ok(solo.body.startsWith('[微信管理员] '), '正文带来源标记，director 能看出消息来自微信')
    assert.ok(solo.body.endsWith('帮我看下今天的安排'))
    assert.equal(
      count(store, 'SELECT COUNT(*) AS n FROM messages'),
      messagesBefore,
      '不得产生任何项目群聊 messages 行',
    )

    const outbox = store.get("SELECT * FROM outbox WHERE kind = 'solo_chat_run'")
    assert.ok(outbox, '必须入 solo_chat_run outbox 触发一轮 solo 运行')
    assert.equal(outbox.status, 'delivered')
    assert.equal(JSON.parse(outbox.payload_json).origin, 'wechat', '载荷带微信来源标记')

    const run = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ?", solo.id)
    assert.ok(run, '必须派生 solo_chat 运行')
    assert.equal(run.project_id, null, '项目外运行不带项目')
    assert.equal(run.trigger_type, 'wechat', '微信来源的 solo 运行打 wechat 标记（回程推送依据）')

    // 同一通道的第二条：静默直达（回复由回程推送，不逐条回执）
    const second = await handleCommand(service, '另外把周报也发了', { boundKey: null, bind() {} })
    assert.equal(second, '', '首触之后的自由文本静默直达 director')
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM solo_messages WHERE sender_id = 'wx_admin_peer'"), 2)
    assert.equal(
      count(store, 'SELECT COUNT(*) AS n FROM messages'),
      messagesBefore,
      '第二条同样不进项目群聊',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('② /tr <key>: 显式转发一律落 director 专属工作区（携带项目上下文），容忍冒号与空格两种写法（DSHBOTS-299 A 口径）', async () => {
  const { root, store, service } = await boot('dsh-wechat-solo-2-')
  try {
    const director = store.get("SELECT id FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'JHY', key: 'JHY', ownerBotId: director.id })
    // 冒号写法（卡面口径 /tr <key>: <消息>）
    const colon = await handleCommand(service, '/tr jhy: 上线新版官网', { boundKey: null, bind() {}, isAdmin: true })
    assert.ok(colon.includes('已直达【JHY】'), `冒号写法回执照旧指向项目：${colon}`)
    let message = store.get("SELECT * FROM solo_messages WHERE body = ?", '[微信管理员] [项目 JHY] 上线新版官网')
    assert.ok(message, '/tr 消息必须落 director 专属工作区 solo 会话')
    assert.equal(message.bot_id, director.id)
    assert.equal(message.sender_id, 'wx_admin_peer', '身份用微信 admin peer id')
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM messages'), 0, '不得插项目群聊（三分域 A）')
    let run = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ?", message.id)
    assert.ok(run, 'solo_chat 运行必须建行')
    assert.equal(run.trigger_type, 'wechat', '微信直达运行照旧打 wechat 标记')
    assert.equal(run.project_id, null, '微信直达运行不落项目域')
    // 争用口径 A（DSHBOTS-289）：同 bot 至多一条活跃运行——首条 /tr 的 solo 运行
    // 对后续断言只是夹具背景，置终态腾出 director 槽，第二条 /tr 才能再建行。
    store.run(
      "UPDATE runs SET status = 'succeeded', ended_at = ? WHERE bot_id = ? AND status IN ('queued', 'running')",
      new Date().toISOString(), director.id,
    )
    // 空格写法（既有语法不变）
    const space = await handleCommand(service, '/tr jhy 顺带改个样式', { boundKey: null, bind() {}, isAdmin: true })
    assert.ok(space.includes('已直达【JHY】'), `空格写法照旧：${space}`)
    message = store.get("SELECT * FROM solo_messages WHERE body = ?", '[微信管理员] [项目 JHY] 顺带改个样式')
    assert.ok(message)
    run = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ?", message.id)
    assert.ok(run && run.trigger_type === 'wechat', '第二条直达同样落 solo 且打 wechat 标记')
    // key 未命中：可选项目提示
    const miss = await handleCommand(service, '/tr nope 干活', { boundKey: null, bind() {}, isAdmin: true })
    assert.ok(miss.includes('没有找到项目 NOPE'))
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM solo_messages WHERE body LIKE ?', '[微信管理员] [项目 NOPE]%'), 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('③ 已绑定 direct_project_key 且恰有一个 active 项目：自由文本仍必须落 director solo（负向）', async () => {
  const { root, store, service } = await boot('dsh-wechat-solo-3-')
  try {
    const director = store.get("SELECT id FROM bots WHERE name = 'director'")
    // 恰一个 active 项目 + 已绑定：两条旧路由的同时在场也不得改变自由文本去向
    await service.createProject({ name: 'Alpha', key: 'ALPHA', ownerBotId: director.id })
    const messagesBefore = count(store, 'SELECT COUNT(*) AS n FROM messages')

    const reply = await handleCommand(service, '把首页改成深色模式', {
      boundKey: 'ALPHA',
      bind() {},
    })
    // 该管理员在此专属工作区的首条：回执说明去向（绑定与否不影响）
    assert.ok(reply.includes('已直达【director】专属工作区'), '绑定+单项目场景仍回 director 首触回执')
    const solo = store.get("SELECT * FROM solo_messages WHERE sender_id = 'wx_admin_peer'")
    assert.ok(solo, '自由文本必须落 director solo 通道')
    assert.equal(solo.bot_id, director.id)
    assert.ok(!reply.includes('还没有选定直达的项目'), '不得触发 needPickProject')
    assert.equal(
      count(store, 'SELECT COUNT(*) AS n FROM messages'),
      messagesBefore,
      '绑定项目与唯一 active 项目都不得截走自由文本（负向）',
    )

    // 原 <key>: 冒号派单写法也已收编为自由文本：不再路由进项目
    const colon = await handleCommand(service, 'alpha: 上线新版官网', {
      boundKey: 'ALPHA',
      bind() {},
    })
    assert.equal(colon, '', '冒号派单写法按自由文本静默直达 director')
    const solo2 = store.get(
      "SELECT * FROM solo_messages WHERE sender_id = 'wx_admin_peer' AND body LIKE ?",
      '%alpha: 上线新版官网',
    )
    assert.ok(solo2, '冒号写法原文落 director solo，不进项目群聊')
    assert.equal(
      count(store, 'SELECT COUNT(*) AS n FROM messages'),
      messagesBefore,
      '冒号派单写法不得产生项目 messages 行',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('④ / 前缀指令：不进 director 通道（solo_messages 无微信来源行）', async () => {
  const { root, store, service } = await boot('dsh-wechat-solo-4-')
  try {
    const director = store.get("SELECT id FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'Alpha', key: 'ALPHA', ownerBotId: director.id })
    const keys = await handleCommand(service, '/keys', { boundKey: null, bind() {} })
    assert.ok(keys.startsWith('项目 key：'), '/keys 应走固定指令集')
    const help = await handleCommand(service, '/?', { boundKey: null, bind() {} })
    assert.ok(help.includes('可用指令'))
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM solo_messages'), 0, '/ 指令不得触发 solo 通道')
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM runs WHERE kind = 'solo_chat'"), 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('⑥ director 不可达：独立 no_director 出口，绝不触发 no_target/needPickProject', async () => {
  const { root, store, service } = await boot('dsh-wechat-solo-6-')
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'Alpha', key: 'ALPHA', ownerBotId: director.id })
    // 制造通道异常：导演 bot 全部失活（种子其余 bot 无 director/总监角色，不会误命中）
    store.run("UPDATE bots SET status = 'paused' WHERE name = 'director'")

    const reply = await handleCommand(service, '看下部署状态', { boundKey: 'ALPHA', bind() {} })
    assert.ok(reply.includes('导演通道暂不可用'), `应回通道异常文案：${reply}`)
    assert.ok(!reply.includes('还没有选定直达的项目'), 'director 不可达绝不触发 no_target/needPickProject')
    assert.ok(!reply.includes('可选的项目'), '不给选项目清单（那不是本异常的用户动作）')
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM solo_messages'), 0, '无可投目标，不落库')
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM runs WHERE kind = \'solo_chat\''), 0)
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM messages'), 0, '也不得改投项目群聊')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('⑤ solo_dir 为空的 director：仍路由 solo 通道（目录读到哪个是哪个，不写死、不拒投）', async () => {
  const { root, store, service } = await boot('dsh-wechat-solo-5-')
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'Alpha', key: 'ALPHA', ownerBotId: director.id })
    // 制造 solo_dir 为空：解析不过滤该字段，目录兜底由 soloPromptFor 既有链路处理
    store.run("UPDATE bots SET solo_dir = '' WHERE id = ?", director.id)
    const reply = await handleCommand(service, '看下部署状态', { boundKey: null, bind() {} })
    assert.ok(!reply.includes('还没有选定直达的项目'), 'solo_dir 为空也不得触发 needPickProject')
    const solo = store.get("SELECT * FROM solo_messages WHERE sender_id = 'wx_admin_peer'")
    assert.ok(solo, 'solo_dir 为空时消息仍落 director solo 通道')
    assert.equal(solo.bot_id, director.id)
    const run = store.get("SELECT * FROM runs WHERE kind = 'solo_chat' AND trigger_ref = ?", solo.id)
    assert.ok(run, 'solo 运行照常派生（运行时目录由 soloPromptFor 兜底，不在路由层写死）')
    assert.equal(run.trigger_type, 'wechat')
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM messages'), 0, '同样不进项目群聊')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
