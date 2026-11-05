// DSHBOTS-172 代码卫生：单文件行数约定。
// 覆盖：默认 800 与 110% 判定线（880 不报、881 报）、0 关闭、项目级配置读写与钳制、
// 白名单/忽略表排除（隐藏目录/node_modules/assets/锁文件/非白名单扩展）、超大文件跳过、
// 告警去重（同文件不重复报、回落后再超标重报）、run-finish 钩子触发与 run_event 留痕。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import {
  CODE_HYGIENE_DEFAULT_LIMIT,
  countTextLines,
  effectiveCodeHygieneExtensions,
  effectiveCodeHygieneLimit,
  scanCodeHygieneFiles,
} from '../src/services/hygiene.js'
import { messageLocale, systemAlertLabel } from '../src/services/locale.js'

// startRun 只记账不回调完成：run 停在 running，finishRun 由测试显式调用。
class HoldingRuntime { declare started: unknown[];
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push(run.id); return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hygiene-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

async function seedProject(service, key = 'HYG') {
  const director = service.store.get("SELECT * FROM bots WHERE name = 'director'")
  const project = await service.createProject({ name: `卫生-${key}`, key, ownerBotId: director.id })
  return { director, project }
}

const lines = (n) => 'x\n'.repeat(n)
const workFile = async (service, project, rel, content) => {
  const full = join(service.projectWorkDir(project), rel)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
  return rel
}

// 系统告警消息按前缀取回（DSHBOTS-228 后前缀随 locale：缺省英文 / 中文【系统指令】）。
const systemAlerts = (store, projectId) =>
  store.all("SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' AND (body LIKE '[SYSTEM ALERT]%' OR body LIKE '【系统指令】%') ORDER BY rowid", projectId)

test('countTextLines：空文件 0、末行无换行计 1、尾换行不虚增', () => {
  assert.equal(countTextLines(''), 0)
  assert.equal(countTextLines('a'), 1)
  assert.equal(countTextLines('a\nb'), 2)
  assert.equal(countTextLines('a\nb\n'), 2)
  assert.equal(countTextLines('\n\n\n'), 3)
})

test('effectiveCodeHygieneLimit：NULL/非法 → 默认 800；0 保留为关闭；负数收敛 0', () => {
  assert.equal(effectiveCodeHygieneLimit({}), CODE_HYGIENE_DEFAULT_LIMIT)
  assert.equal(effectiveCodeHygieneLimit({ code_hygiene_limit_lines: null }), 800)
  assert.equal(effectiveCodeHygieneLimit({ code_hygiene_limit_lines: 100 }), 100)
  assert.equal(effectiveCodeHygieneLimit({ code_hygiene_limit_lines: 0 }), 0)
  assert.equal(effectiveCodeHygieneLimit({ code_hygiene_limit_lines: -5 }), 0)
  assert.equal(effectiveCodeHygieneLimit({ code_hygiene_limit_lines: 'abc' }), 800)
})

test('effectiveCodeHygieneExtensions：默认白名单收敛带点小写；config 覆盖优先', () => {
  const defaults = effectiveCodeHygieneExtensions({})
  assert.ok(defaults.has('.js'))
  assert.ok(defaults.has('.ts'))
  assert.ok(!defaults.has('.md'))
  const custom = effectiveCodeHygieneExtensions({ codeHygieneExts: ['Lua', '.PY', ' '] })
  assert.ok(custom.has('.lua'))
  assert.ok(custom.has('.py'))
  assert.equal(custom.size, 2)
})

test('scanCodeHygieneFiles：隐藏目录/node_modules/assets/锁文件/非白名单扩展/超大文件一律排除', async () => {
  const { root, store, service } = await setup()
  try {
    const { project } = await seedProject(service, 'SCAN')
    const dir = service.projectWorkDir(project)
    const put = (rel, content) => workFile(service, project, rel, content)
    await put('src/big.js', lines(900))
    await put('node_modules/dep.js', lines(900))
    await put('assets/art.js', lines(900))
    await put('.git/hooks.js', lines(900))
    await put('.codegraph/data.js', lines(900))
    await put('src/package-lock.json', lines(900))
    await put('src/data.bin', lines(900))
    await put('src/huge.js', 'x'.repeat(2 * 1024 * 1024 + 10))
    const files = scanCodeHygieneFiles(dir, { exts: effectiveCodeHygieneExtensions({}) })
    const paths = files.map(file => file.path)
    assert.deepEqual(paths, ['src/big.js'])
    assert.equal(files[0].lines, 900)
  } finally {
    await rm(root, { recursive: true, force: true })
    store.close()
  }
})

test('默认 800：880 行不报、881 行即报，消息含文件/行数/上限/判定线与拆分要求', async () => {
  const { root, store, service } = await setup()
  try {
    const { project } = await seedProject(service)
    await workFile(service, project, 'src/edge.js', lines(880))
    let result = service.runCodeHygieneScan(project)
    assert.equal(result.skipped, undefined)
    assert.deepEqual(result.alerted, [])
    assert.equal(systemAlerts(store, project.id).length, 0)

    await workFile(service, project, 'src/big.js', lines(881))
    result = service.runCodeHygieneScan(project)
    assert.deepEqual(result.alerted, ['src/big.js'])
    const alerts = systemAlerts(store, project.id)
    assert.equal(alerts.length, 1)
    const body = alerts[0].body
    assert.ok(body.startsWith('[SYSTEM ALERT] 代码卫生告警'))
    assert.ok(body.includes('src/big.js（881 行）'))
    assert.ok(body.includes('约定上限 800 行'))
    assert.ok(body.includes('判定线 880 行 = 110%'))
    assert.ok(body.includes('请项目总监安排拆分卡'))
    assert.equal(alerts[0].sender_id, 'system')
    // edge.js 880 行恰在判定线上，不进告警也不进任何列表
    assert.ok(!body.includes('edge.js'))
  } finally {
    await rm(root, { recursive: true, force: true })
    store.close()
  }
})

test('i18n 前缀（DSHBOTS-228）：缺省英文 [SYSTEM ALERT]，ui_language=zh 时为【系统指令】', async () => {
  // 标签纯函数：zh* → 【系统指令】；en/auto/未知 → [SYSTEM ALERT] （缺省英文，注意拼写 ALERT）。
  assert.equal(systemAlertLabel('zh'), '【系统指令】')
  assert.equal(systemAlertLabel('zh-CN'), '【系统指令】')
  assert.equal(systemAlertLabel('en'), '[SYSTEM ALERT] ')
  assert.equal(systemAlertLabel('auto'), '[SYSTEM ALERT] ')
  assert.equal(messageLocale({ uiLanguage: 'auto' }, () => null, null), 'en', 'auto 且无 loader → 缺省 en')
  assert.equal(messageLocale({ uiLanguage: 'auto' }, () => 'zh'), 'zh', '保存值 zh 优先于 auto 缺省')
  assert.equal(messageLocale({ uiLanguage: 'en' }, () => null), 'en', 'config 显式 en 生效')

  const { root, store, service } = await setup()
  try {
    const { project } = await seedProject(service, 'I18N')
    await workFile(service, project, 'src/big.js', lines(881))
    service.runCodeHygieneScan(project)
    assert.ok(systemAlerts(store, project.id)[0].body.startsWith('[SYSTEM ALERT] 代码卫生告警'))

    // 显式 zh：前缀切换为【系统指令】，正文其余不变。
    store.setSetting('ui_language', 'zh')
    await workFile(service, project, 'src/another.js', lines(881))
    service.runCodeHygieneScan(project)
    const alerts = systemAlerts(store, project.id)
    assert.equal(alerts.length, 2)
    assert.ok(alerts[1].body.startsWith('【系统指令】代码卫生告警'))
  } finally {
    await rm(root, { recursive: true, force: true })
    store.close()
  }
})

test('项目级配置：codeHygieneLimitLines 读写、空串回 NULL、越界钳制、判定线随之变化', async () => {
  const { root, store, service } = await setup()
  try {
    const { project } = await seedProject(service, 'CONF')
    await service.updateProject(project.id, { codeHygieneLimitLines: 100 })
    assert.equal(service.projectRow(project.id).code_hygiene_limit_lines, 100)
    await workFile(service, project, 'src/a.js', lines(110))
    await workFile(service, project, 'src/b.js', lines(111))
    const result = service.runCodeHygieneScan(service.projectRow(project.id))
    assert.deepEqual(result.alerted, ['src/b.js'])
    assert.ok(systemAlerts(store, project.id)[0].body.includes('判定线 110 行'))

    // 空串/非法 → NULL（回到默认 800）；越界钳到 100000
    await service.updateProject(project.id, { codeHygieneLimitLines: '' })
    assert.equal(service.projectRow(project.id).code_hygiene_limit_lines, null)
    await service.updateProject(project.id, { codeHygieneLimitLines: 'abc' })
    assert.equal(service.projectRow(project.id).code_hygiene_limit_lines, null)
    await service.updateProject(project.id, { codeHygieneLimitLines: 999999 })
    assert.equal(service.projectRow(project.id).code_hygiene_limit_lines, 100000)
  } finally {
    await rm(root, { recursive: true, force: true })
    store.close()
  }
})

test('0 = 关闭：扫描跳过、不落任何告警', async () => {
  const { root, store, service } = await setup()
  try {
    const { project } = await seedProject(service, 'OFF')
    await service.updateProject(project.id, { codeHygieneLimitLines: 0 })
    await workFile(service, project, 'src/big.js', lines(5000))
    const result = service.runCodeHygieneScan(service.projectRow(project.id))
    assert.deepEqual(result, { skipped: 'disabled' })
    assert.equal(systemAlerts(store, project.id).length, 0)
    assert.equal(store.setting(`code_hygiene_alerted:${project.id}`), null)
  } finally {
    await rm(root, { recursive: true, force: true })
    store.close()
  }
})

test('告警去重：同文件不重复报，回落到判定线内解除，再超标重报', async () => {
  const { root, store, service } = await setup()
  try {
    const { project } = await seedProject(service, 'DEDUP')
    const key = `code_hygiene_alerted:${project.id}`
    await workFile(service, project, 'src/big.js', lines(900))
    service.runCodeHygieneScan(project)
    assert.equal(systemAlerts(store, project.id).length, 1)
    assert.equal(store.setting(key), '{"src/big.js":true}')

    // 同一状态再扫：不再发
    const again = service.runCodeHygieneScan(project)
    assert.deepEqual(again.alerted, [])
    assert.equal(systemAlerts(store, project.id).length, 1)

    // 回落到判定线以内：解除告警记忆（值回落到不再越线，即摘除）
    await workFile(service, project, 'src/big.js', lines(800))
    const recovered = service.runCodeHygieneScan(project)
    assert.deepEqual(recovered.recovered, ['src/big.js'])
    assert.equal(store.setting(key), '{}')

    // 再次超标：重新告警
    await workFile(service, project, 'src/big.js', lines(950))
    const reAlerted = service.runCodeHygieneScan(project)
    assert.deepEqual(reAlerted.alerted, ['src/big.js'])
    assert.equal(systemAlerts(store, project.id).length, 2)
    assert.ok(systemAlerts(store, project.id)[1].body.includes('src/big.js（950 行）'))
  } finally {
    await rm(root, { recursive: true, force: true })
    store.close()
  }
})

test('run-finish 钩子：每轮运行结束触发扫描，告警挂 run_id 并留 code_hygiene_alert 事件', async () => {
  const { root, store, service } = await setup()
  try {
    const { director, project } = await seedProject(service, 'HOOK')
    // 关闭群聊记忆审查派生，避免派生 run 悬挂干扰断言
    store.setSetting('chat_memory_review', '0')
    await workFile(service, project, 'src/big.js', lines(881))

    const runId = 'run_hygiene_hook_1'
    const now = new Date().toISOString()
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at, started_at)
       VALUES (?, ?, ?, 'chat', 'read', 'chat', 'running', 1, ?, ?, ?)`,
      runId, project.id, director.id, `test:${runId}`, now, now,
    )
    await service.finishRun({ runId, status: 'succeeded', output: 'ok' } as any)

    const alerts = systemAlerts(store, project.id)
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].run_id, runId)
    assert.ok(alerts[0].body.includes('src/big.js（881 行）'))
    const events = store.all("SELECT * FROM run_events WHERE run_id = ? AND type = 'code_hygiene_alert'", runId)
    assert.equal(events.length, 1)
    assert.ok(events[0].message.includes('880'))

    // 第二轮运行结束（文件未变）：去重生效，不再发新告警
    const runId2 = 'run_hygiene_hook_2'
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at, started_at)
       VALUES (?, ?, ?, 'chat', 'read', 'chat', 'running', 1, ?, ?, ?)`,
      runId2, project.id, director.id, `test:${runId2}`, now, now,
    )
    await service.finishRun({ runId: runId2, status: 'succeeded', output: 'ok' } as any)
    assert.equal(systemAlerts(store, project.id).length, 1)
    assert.equal(store.all("SELECT * FROM run_events WHERE run_id = ? AND type = 'code_hygiene_alert'", runId2).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
    store.close()
  }
})
