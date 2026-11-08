// DSHBOTS-334 守门：飞书凭据进设置页（配置才生效）+ 未配置日志只打一次。
// ①未配置=unbound 不连（不建传输不发自检）；②settings 保存后生效进入自检（优先级高于
// patch.yml/env 注入）；③secret 不回显（状态/视图/响应/审计/主库字节均无明文）；
// ④unbound warn 全程只在进入该态时打一次（反复 start 不刷屏）；⑤清除凭据回到 unbound。
// 传输层全 stub（复用 feishu-skeleton 同款口径），不碰网络。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, effectiveFeishuCredentials } from '../src/config.js'
import { openDatabase } from '../src/db.js'
import { TeamService } from '../src/service.js'
import { FeishuChannel } from '../src/feishu/channel.js'
import { FeishuStore } from '../src/feishu/store.js'

const SECRET = 'feishu-saved-secret-sentinel-d334'
const SAVED_APP_ID = 'cli_savedapp0123456'
const CONFIG_APP_ID = 'cli_configapp45678'

function captureLog() {
  const lines: string[] = []
  return {
    lines,
    logger: {
      info: text => lines.push(String(text)),
      warn: text => lines.push(String(text)),
      error: text => lines.push(String(text)),
    },
  }
}

/** 传输桩：只记调用，不碰网络。 */
function transportStub() {
  const calls = { botInfo: 0, stopped: 0 }
  const transport = {
    async botInfo() {
      calls.botInfo += 1
      return { appId: SAVED_APP_ID, botId: 'ou_bot_d334', brand: 'feishu' }
    },
    async reply() {
      return { messageId: 'om_x' }
    },
    async startEvents({ onReady }) {
      onReady?.()
    },
    async stop() {
      calls.stopped += 1
    },
  }
  return { calls, transport }
}

async function setup({ configCreds = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-cred-'))
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  const config = resolveConfig({
    dataDir,
    feishuEnabled: true,
    ...(configCreds
      ? { feishuAppId: CONFIG_APP_ID, feishuAppSecret: 'config-secret-not-sentinel' }
      : { feishuAppId: '', feishuAppSecret: '' }),
  })
  const db = openDatabase(config.dbPath)
  const { logger, lines } = captureLog()
  const service = new TeamService({ store: db, config, logger })
  const feishuStore = await new FeishuStore(config.feishuDbPath).open()
  const { calls, transport } = transportStub()
  const channel = new FeishuChannel({ store: feishuStore, config, log: logger, transport })
  channel.setService(service)
  service.feishu = channel
  return { root, config, db, service, channel, calls, lines, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** 扫描数据目录里 team.sqlite* 的原始字节，找明文哨兵。 */
function scanDbBytes(dataDir, needle) {
  const hits: string[] = []
  for (const name of readdirSync(dataDir).filter(name => name.startsWith('team.sqlite'))) {
    if (readFileSync(join(dataDir, name)).includes(needle)) hits.push(name)
  }
  return hits
}

test('① 未配置=unbound 不连：无任何来源凭据时不建传输不发自检', async () => {
  const ctx = await setup({ configCreds: false })
  try {
    await ctx.channel.start()
    assert.equal(ctx.channel.phase, 'unbound', '未配置应保持 unbound')
    assert.equal(ctx.calls.botInfo, 0, '未配置不得发起身份自检（不连）')
    assert.equal(ctx.service.feishuStatus().credentials.source, 'none', '凭据来源应为 none')
    assert.equal(ctx.service.feishuStatus().credentials.appIdMasked, null, '未配置不显示脱敏 AppID')
    // 生效值纯函数：saved/config 都空 = none（成对语义）。
    assert.equal(effectiveFeishuCredentials({ feishu: { appId: '', appSecret: '' } }).source, 'none')
    assert.equal(effectiveFeishuCredentials({ feishu: { appId: 'a', appSecret: '' } }).source, 'none', '半对凭据不与注入混拼')
  } finally {
    await ctx.cleanup()
  }
})

test('② settings 保存后生效进入自检：优先级高于 patch.yml/env，保存即重连', async () => {
  const ctx = await setup()
  try {
    // 基线：仅注入来源（config）→ start 走注入凭据自检。
    await ctx.channel.start()
    assert.equal(ctx.channel.phase, 'ready', '注入凭据可用时应完成自检进入 ready')
    assert.ok(ctx.calls.botInfo >= 1, '应发起身份自检')
    assert.equal(ctx.service.feishuCredentialView().source, 'config', '未保存前来源为 config')

    // 通道页保存（DSHBOTS-334）：secrets 表加密落库 + 保存即触发重连。
    const before = ctx.calls.botInfo
    const response = await ctx.service.saveFeishuCredentials({ appId: SAVED_APP_ID, appSecret: SECRET })
    assert.equal(ctx.calls.botInfo, before + 1, '保存后重连应重新自检')
    assert.equal(ctx.channel.phase, 'ready', '保存有效凭据后应回 ready')
    const view = (response as any).credentials
    assert.equal(view.source, 'saved', '保存后来源应为 saved（覆盖 patch.yml/env）')
    assert.equal(view.appIdMasked, 'cli_save…', '脱敏 AppID = 前 8 位+…')
    assert.ok(!JSON.stringify(response).includes(SECRET), '保存响应不得回显 secret 明文')
  } finally {
    await ctx.cleanup()
  }
})

test('③ secret 不回显：状态/视图/审计/主库字节均无明文', async () => {
  const ctx = await setup({ configCreds: false })
  try {
    await ctx.service.saveFeishuCredentials({ appId: SAVED_APP_ID, appSecret: SECRET })
    assert.ok(!JSON.stringify(ctx.service.feishuStatus()).includes(SECRET), 'feishuStatus 不得含 secret 明文')
    assert.ok(!JSON.stringify(ctx.service.feishuCredentialView()).includes(SECRET), '凭据视图不得含 secret 明文')
    const audits = ctx.db.all('SELECT data_json FROM audit_log').map(row => String(row.data_json))
    assert.ok(audits.length > 0, '保存应留审计')
    assert.ok(audits.every(text => !text.includes(SECRET)), '审计不得落 secret 明文')
    assert.deepEqual(scanDbBytes(join(ctx.config.dataDir), SECRET), [], '主库字节不得含 secret 明文（SecretBox 加密）')
  } finally {
    await ctx.cleanup()
  }
})

test('④ 日志去噪：unbound warn 只在进入该态时打一次，反复 start 不刷屏', async () => {
  const ctx = await setup({ configCreds: false })
  try {
    for (let round = 0; round < 3; round += 1) await ctx.channel.start()
    const count = ctx.lines.filter(line => line.includes('未配置飞书应用凭据')).length
    assert.equal(count, 1, '连续 3 轮 start，未配置 warn 应恰打 1 次')
    // 状态变化再进入 unbound（ready→unbound）允许各打一次：与「持续态不刷屏」区分。
    await ctx.service.saveFeishuCredentials({ appId: SAVED_APP_ID, appSecret: SECRET })
    assert.equal(ctx.channel.phase, 'ready', '保存后应进入 ready')
    await ctx.service.clearFeishuCredentials()
    const countAfterClear = ctx.lines.filter(line => line.includes('未配置飞书应用凭据')).length
    assert.equal(countAfterClear, 2, '清除后重进 unbound 应再打一次（共 2 次），仍不得逐轮刷屏')
  } finally {
    await ctx.cleanup()
  }
})

test('⑤ 清除凭据回到 unbound：来源归零、secrets 行删除、后续启动不连', async () => {
  const ctx = await setup({ configCreds: false })
  try {
    await ctx.service.saveFeishuCredentials({ appId: SAVED_APP_ID, appSecret: SECRET })
    assert.equal(ctx.channel.phase, 'ready', '前置：已配置已连接')
    const response = await ctx.service.clearFeishuCredentials()
    assert.equal((response as any).phase, 'unbound', '清除后应回到 unbound')
    assert.equal((response as any).credentials.source, 'none', '清除后来源应为 none')
    const rows = ctx.db.all("SELECT name FROM secrets WHERE name LIKE 'FEISHU_%'")
    assert.deepEqual(rows, [], 'secrets 表两行应已删除')
    // 清除后的新通道实例：无凭据来源 → 不连（模拟宿主重启后的启动路径）。
    const freshStore = await new FeishuStore(ctx.config.feishuDbPath).open()
    const freshCalls = transportStub()
    const fresh = new FeishuChannel({ store: freshStore, config: ctx.config, log: { info: () => {}, warn: () => {}, error: () => {} }, transport: freshCalls.transport })
    fresh.setService(ctx.service)
    await fresh.start()
    assert.equal(fresh.phase, 'unbound', '宿主重启后未配置应保持 unbound 不连')
    assert.equal(freshCalls.calls.botInfo, 0, '清除后不得再发自检')
  } finally {
    await ctx.cleanup()
  }
})
