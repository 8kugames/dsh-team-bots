// DSHBOTS-249 守门：微信 / 前缀固定指令集。
// 覆盖：①七条指令（/? /keys /bots /states /detail /reject /tr）解析与路由；
// ②/reject 缺理由拒绝；③未知 /xxx 回简短帮助提示；④权限门（非 admin 对写操作 /reject /tr 拒绝，
// 只读指令不设门）；⑤无前缀消息仍走 director 对话链路（D-208 行为不动）。
// DSHBOTS-257 守门：⑥写指令权限门 fail-closed（未传 ctx / 未显式 isAdmin=true 即拒）；
// ⑦/detail 指派名走真 TeamService 解析（临时库），不靠桩直造 assigneeName 字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleCommand } from '../src/wechat/commands.js'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

const SERVICE_STUB = (): any => ({
  stateView() {
    return { projects: [{ key: 'web', name: 'Web', tasks: [
      { number: 3, status: 'in_progress', title: '写登录页' },
      { number: 5, status: 'in_review', title: '等验收' },
    ] }] }
  },
  wechatProjectBots(key) {
    return String(key).toLowerCase() === 'web'
      ? [{ name: 'director', member_role: 'owner', status: 'active' }]
      : []
  },
  taskViewByIdentifier(identifier) {
    return { identifier, status: 'in_review', title: '写登录页', assigneeName: 'Builder', comments: [] }
  },
  seen: null,
  wechatReview(identifier, { decision, comment }) {
    this.seen = { identifier, decision, comment }
    return `已驳回 ${identifier}`
  },
  chatted: null,
  async wechatChat(key, body, fallbackKey) {
    this.chatted = { key, body, fallbackKey }
    if (key && key.toLowerCase() !== 'web') return null
    return { project: { id: 'p-web', key: key ? key.toLowerCase() : 'web', name: 'Web' }, messageId: 'msg_1' }
  },
})

const ADMIN_CTX = { boundKey: 'web', bind() {}, isAdmin: true }
const MEMBER_CTX = { boundKey: 'web', bind() {}, isAdmin: false }

test('/? 输出固定指令帮助，含七条指令一行一条', async () => {
  const reply = await handleCommand(SERVICE_STUB(), '/?')
  assert.ok(reply.includes('可用指令'))
  for (const verb of ['/?', '/keys', '/bots', '/states', '/detail', '/reject', '/tr']) {
    assert.ok(reply.includes(verb), `帮助应含 ${verb}`)
  }
})

test('/keys 输出项目清单并标注当前绑定', async () => {
  const reply = await handleCommand(SERVICE_STUB(), '/keys', ADMIN_CTX)
  assert.ok(reply.includes('web  Web（当前）'), '绑定项目应带（当前）标注')
})

test('/bots 输出当前项目机器人清单', async () => {
  const reply = await handleCommand(SERVICE_STUB(), '/bots', ADMIN_CTX)
  assert.ok(reply.includes('director'), '应列出 director bot')
  assert.ok(reply.includes('owner'), '应带成员角色')
})

test('/states 只列 in_review 验收面任务', async () => {
  const reply = await handleCommand(SERVICE_STUB(), '/states')
  assert.ok(reply.includes('web-5 [in_review] 等验收'))
  assert.ok(!reply.includes('web-3'), '进行中任务不进验收面清单')
})

test('/detail 输出任务详情（含指派）', async () => {
  const reply = await handleCommand(SERVICE_STUB(), '/detail web-5')
  assert.ok(reply.includes('web-5'))
  assert.ok(reply.includes('写登录页'))
  assert.ok(reply.includes('指派 Builder'))
})

test('/reject 附理由退回重做，缺理由拒绝', async () => {
  const service = SERVICE_STUB()
  const reply = await handleCommand(service, '/reject web-5 样式崩了', ADMIN_CTX)
  assert.ok(reply.includes('已驳回 web-5'))
  assert.deepEqual(service.seen, { identifier: 'web-5', decision: 'return', comment: '样式崩了' })

  const missing = await handleCommand(service, '/reject web-5', ADMIN_CTX)
  assert.ok(missing.includes('必须带理由'), '缺理由必须拒绝')
})

test('/tr 按 key 跨项目路由并回执', async () => {
  const service = SERVICE_STUB()
  const reply = await handleCommand(service, '/tr web 上线新版官网', ADMIN_CTX)
  assert.ok(reply.includes('已直达【Web】'))
  assert.deepEqual(service.chatted, { key: 'WEB', body: '上线新版官网', fallbackKey: undefined })

  // 缺消息给格式提示；key 未命中给可选项目提示
  assert.ok((await handleCommand(service, '/tr web', ADMIN_CTX)).includes('格式：/tr'))
  assert.ok((await handleCommand(service, '/tr nope 干活', ADMIN_CTX)).includes('没有找到项目 NOPE'))
})

test('未知 /xxx 回简短可用指令提示', async () => {
  const reply = await handleCommand(SERVICE_STUB(), '/detial web-3')
  assert.ok(reply.includes('没有这个指令'))
  assert.ok(reply.includes('/?'), '提示应指向 /?')
})

test('权限门：非 admin 对写操作（/reject /tr）拒绝，只读指令不设门', async () => {
  const service = SERVICE_STUB()
  assert.ok((await handleCommand(service, '/reject web-5 差', MEMBER_CTX)).includes('仅限管理员'))
  assert.ok((await handleCommand(service, '/tr web 干活', MEMBER_CTX)).includes('仅限管理员'))
  assert.equal(service.seen, null, '写操作被拒后不得触达 service')
  assert.equal(service.chatted, null, '/tr 被拒后不得进入直达路由')

  // 只读指令对群成员开放
  assert.ok((await handleCommand(service, '/states', MEMBER_CTX)).includes('web-5'))
  assert.ok((await handleCommand(service, '/detail web-5', MEMBER_CTX)).includes('写登录页'))
  assert.ok((await handleCommand(service, '/keys', MEMBER_CTX)).includes('web'))
})

test('权限门 fail-closed：未传 ctx 或未显式 isAdmin=true 拒绝写指令，只读照常放行（DSHBOTS-257）', async () => {
  const service = SERVICE_STUB()
  assert.ok((await handleCommand(service, '/reject web-5 差')).includes('仅限管理员'), '未传 ctx 必须拒绝写指令')
  assert.ok((await handleCommand(service, '/tr web 干活')).includes('仅限管理员'), '未传 ctx 必须拒绝 /tr')
  assert.ok(
    (await handleCommand(service, '/tr web 干活', { boundKey: 'web', bind() {} })).includes('仅限管理员'),
    'ctx 未显式 isAdmin=true 不得视为管理员',
  )
  assert.equal(service.seen, null, '写操作被拒后不得触达 service')
  assert.equal(service.chatted, null, '/tr 被拒后不得进入直达路由')

  // 只读指令不设门：无 ctx 也能查
  assert.ok((await handleCommand(service, '/states')).includes('web-5'))
  assert.ok((await handleCommand(service, '/detail web-5')).includes('写登录页'))
  assert.ok((await handleCommand(service, '/keys')).includes('web'))
})

// DSHBOTS-257 守门①：/detail 指派名走真 TeamService（临时库）解析——taskViewByIdentifier
// 按 assignee_bot_id 产出 assigneeName，不靠桩直造字段（此前生产恒显「暂未指派」的回归）。
class RealServiceRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

test('/detail 指派名走真 service 解析：已指派显示 bot 名，未指派显示暂未指派（DSHBOTS-257）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-detail-'))
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
  service.attachRuntime(new RealServiceRuntime())
  await service.initialize()
  service.started = true
  ;(service as any).wechat = { notify() {}, status: () => ({ adminPeerId: 'wx_admin_peer' }) }
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.createProject({ name: 'Detail Demo', key: 'DETAIL', ownerBotId: director.id })
    const projectId = store.get("SELECT id FROM projects WHERE key = 'DETAIL'").id
    await service.createTask({ projectId, title: '写登录页', assigneeBotId: director.id, postCard: false })
    await service.createTask({ projectId, title: '未指派卡', postCard: false })

    const assigned = await handleCommand(service, '/detail DETAIL-1')
    assert.ok(assigned.includes('指派 director'), `已指派卡应显示 bot 名：${assigned}`)
    assert.ok(!assigned.includes('暂未指派'), '已指派卡不得回退为暂未指派')

    const unassigned = await handleCommand(service, '/detail DETAIL-2')
    assert.ok(unassigned.includes('暂未指派'), `未指派卡显示暂未指派：${unassigned}`)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('无前缀消息仍走 director 对话链路，不被固定指令截获', async () => {
  const service = SERVICE_STUB()
  const silent = await handleCommand(service, '把首页改成深色模式', ADMIN_CTX)
  assert.equal(silent, '', '非首触自由文本静默直达 director')
  // DSHBOTS-258 绝对口径：自由文本不传绑定（路由层无绑定判断），key 恒为 null
  assert.deepEqual(service.chatted, { key: null, body: '把首页改成深色模式', fallbackKey: undefined })

  // 旧触发式指令词也已收编：作为普通文本进对话，不再被指令层拦截
  await handleCommand(service, '验收 web-5 干得漂亮', ADMIN_CTX)
  assert.deepEqual(service.chatted, { key: null, body: '验收 web-5 干得漂亮', fallbackKey: undefined })
  assert.equal(service.seen, null, '旧触发词不得再触发验收路由')
})
