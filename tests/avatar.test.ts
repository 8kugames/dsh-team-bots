// tests/avatar.test.js —— DSHBOTS-221 守门：头像数据生成与渲染收敛。
// ① initials：英文取首二字母大写、CJK 取首字单字（修复两字竖排撑破头像块）；
// ② identicon：同 seed 同图（确定性）、5x5 镜像对称、坐标界内；
// ③ avatar()：有 avatar_seed 渲染像素块 SVG、无 seed 回落文字头像（唯一渲染出口）；
// ④ 服务层：updateBot 落库 avatarSeed（roll 持久）、空值关闭、非法种子拒绝、旧库迁移补列；
// ⑤ 入口存在性：bot 配置弹窗与 solo 配置页都有 roll 按钮（源码级轻锁）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ---------- 真实源码求值（ui/modules/util.js，构建产物与源码逐行对齐） ----------
const utilSource = readFileSync(join(root, 'ui', 'modules', 'util.js'), 'utf8')
const extract = (name) =>
  utilSource.match(new RegExp(`^export function ${name}\\([\\s\\S]*?^\\}`, 'm'))?.[0].replace(/^export /m, '') ?? ''
const escStub = (value) => String(value ?? '')
const initials = new Function(`${extract('initials')}; return initials`)()
const identiconSvg = new Function(`${extract('identiconSvg')}; return identiconSvg`)()
const avatar = new Function(
  'esc', 'attr', 'initials', 'identiconSvg',
  `${extract('avatar')}; return avatar`,
)(escStub, escStub, initials, identiconSvg)

// ---------- 服务层夹具（对齐 tests/solo-cards.test.js） ----------
class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function makeTempRoot() {
  try {
    return await mkdtemp(join(tmpdir(), 'dsh-avatar-'))
  } catch {
    // 沙箱禁 mkdtemp（已知假红环境）：回退仓库内 .tmp（已 ignore），用例自清。
    const fallback = join(root, '.tmp', 'avatar-test', `${process.pid}-${Date.now().toString(36)}`)
    await mkdir(fallback, { recursive: true })
    return fallback
  }
}

async function setup() {
  const temp = await makeTempRoot()
  const workspace = join(temp, 'workspace')
  const dataDir = join(temp, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const close = async () => {
    try { store.close() } catch {}
    await rm(temp, { recursive: true, force: true })
  }
  return { temp, workspace, store, service, config, close }
}

test('initials：英文取首二字母大写，CJK 取首字单字', () => {
  assert.equal(initials('策划'), '策', '纯中文名取第一个字')
  assert.equal(initials('编剧'), '编', '纯中文名取第一个字')
  assert.equal(initials('Alice'), 'AL', '英文名取首二字母并大写')
  assert.equal(initials('builder'), 'BU', '小写英文名同样大写')
  assert.equal(initials('Builder构建'), 'BU', '英文开头按英文口径取二字母')
  assert.equal(initials('_dev'), '_', '非字母开头（下划线）取首字符单字')
  assert.equal(initials('  导演  '), '导', '首尾空白先裁再取')
})

test('identicon：同 seed 同图，不同 seed 出不同图', () => {
  assert.equal(identiconSvg('roll-abc123'), identiconSvg('roll-abc123'), '同 seed 必须逐字节同图')
  assert.notEqual(identiconSvg('roll-abc123'), identiconSvg('roll-xyz789'), '不同 seed 应产生不同图案')
})

test('identicon：5x5 镜像对称且坐标界内', () => {
  const html = identiconSvg('mirror-seed')
  assert.match(html, /<svg class="identicon" viewBox="0 0 5 5"/, 'SVG 骨架与视口正确')
  const coords = [...html.matchAll(/<rect x="(\d)" y="(\d)" width="1" height="1"\/>/g)]
    .map(m => [Number(m[1]), Number(m[2])])
  assert.ok(coords.length > 0 && coords.length <= 25, '填充块数量在 1..25')
  const set = new Set(coords.map(([x, y]) => `${x},${y}`))
  for (const [x, y] of coords) {
    assert.ok(x >= 0 && x <= 4 && y >= 0 && y <= 4, '坐标必须在 5x5 网格内')
    assert.ok(set.has(`${4 - x},${y}`), `(${x},${y}) 的镜像格 (${4 - x},${y}) 必须同样填充`)
  }
})

test('avatar()：有 avatar_seed 渲染像素块，无 seed 回落文字（唯一渲染出口）', () => {
  const identicon = avatar({ name: '策划', color: 'blue', avatar_seed: 'roll-abc123' })
  assert.match(identicon, /^<div class="avatar blue ">/, '色类沿用 bot 外观色')
  assert.match(identicon, /<svg class="identicon"/, '有 seed 渲染像素块 SVG')
  assert.doesNotMatch(identicon, />策<\/div>/, '像素块模式不渲染文字')
  const text = avatar({ name: '策划', color: 'blue' })
  assert.match(text, /^<div class="avatar blue ">/, '无 seed 仍是色类头像块')
  assert.match(text, />策<\/div>/, 'CJK 名回落首字单字')
  assert.doesNotMatch(text, /<svg/, '文字模式不渲染 SVG')
  assert.match(avatar({ name: 'alice' }), />AL<\/div>/, '英文回落首二字母大写')
})

test('入口存在性：bot 配置弹窗与 solo 配置页都有 roll 按钮，点击链路唯一', () => {
  const modalSource = readFileSync(join(root, 'ui', 'modules', 'modal-forms.js'), 'utf8')
  const chatSource = readFileSync(join(root, 'ui', 'modules', 'chat.js'), 'utf8')
  const clickSource = readFileSync(join(root, 'ui', 'modules', 'events-click.js'), 'utf8')
  assert.match(modalSource, /data-action="roll-avatar" data-bot-id=/, 'bot 配置弹窗外观颜色右侧有 roll 按钮')
  assert.match(chatSource, /data-action="roll-avatar" data-bot-id=/, 'solo 配置页外观颜色右侧有 roll 按钮')
  assert.match(clickSource, /case 'roll-avatar':/, '点击分发有 roll-avatar 分支')
})

test('服务层：updateBot 落库 avatarSeed，view 暴露，空值关闭，非法拒绝', async () => {
  const t = await setup()
  try {
    const created = await t.service.createBot({ name: '策划', role: '规划', provider: 'fake', model: 'model-a' })
    const rolled = await t.service.updateBot(created.id, { avatarSeed: 'roll-abc123' }, { type: 'user', id: 'owner' })
    assert.equal(rolled.avatar_seed, 'roll-abc123', 'botView 暴露 avatar_seed')
    assert.equal(t.store.get('SELECT avatar_seed FROM bots WHERE id = ?', created.id).avatar_seed, 'roll-abc123', '种子已落库持久')
    await t.service.updateBot(created.id, { avatarSeed: 'roll-xyz789' }, { type: 'user', id: 'owner' })
    assert.equal(t.store.get('SELECT avatar_seed FROM bots WHERE id = ?', created.id).avatar_seed, 'roll-xyz789', '可重复 roll 覆盖旧种子')
    await t.service.updateBot(created.id, { avatarSeed: null }, { type: 'user', id: 'owner' })
    assert.equal(t.store.get('SELECT avatar_seed FROM bots WHERE id = ?', created.id).avatar_seed, null, 'null 关闭像素头像')
    await t.service.updateBot(created.id, { avatarSeed: '' }, { type: 'user', id: 'owner' })
    assert.equal(t.store.get('SELECT avatar_seed FROM bots WHERE id = ?', created.id).avatar_seed, null, '空串同样视为关闭')
    await assert.rejects(
      () => t.service.updateBot(created.id, { avatarSeed: '非法种子!' }, { type: 'user', id: 'owner' }),
      /头像种子格式无效/,
      '含非法字符的种子被拒绝',
    )
  } finally { await t.close() }
})

test('旧库迁移：bots 缺 avatar_seed 列时重开库自动补列', async () => {
  const t = await setup()
  try {
    t.store.exec('ALTER TABLE bots DROP COLUMN avatar_seed')
    assert.equal(t.store.db.prepare('PRAGMA table_info(bots)').all().some(column => column.name === 'avatar_seed'), false)
    // 迁移入口在 openDatabase（SCHEMA + runMigrations）：重开同一库文件即触发补列。
    t.store.close()
    const reopened = openDatabase(t.config.dbPath)
    assert.ok(
      reopened.db.prepare('PRAGMA table_info(bots)').all().some(column => column.name === 'avatar_seed'),
      '迁移应补回 avatar_seed 列',
    )
    reopened.close()
  } finally { await t.close() }
})
