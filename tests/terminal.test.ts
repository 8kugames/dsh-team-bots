import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class ManualRuntime {
  setCompletionHandler() {}
  setMask() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-x' }
  async steer() { return true }
  async cancelRun() { return true }
}

async function terminalSetup({ terminalTimeoutMs }: { terminalTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-term-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 60_000,
    ...(terminalTimeoutMs ? { terminalTimeoutMs } : {}),
  })
  const store = openDatabase(config.dbPath)
  const makeService = () => {
    const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
    service.attachRuntime(new ManualRuntime())
    return service
  }
  const service = makeService()
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const project = await service.createProject({ name: 'Terminal', key: 'TERM', ownerBotId: director.id })
  return { root, workspace, store, config, service, makeService, project }
}

async function closeQuietly(store, timeout = 3000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    try {
      const running = store.get("SELECT COUNT(*) AS n FROM terminal_commands WHERE status = 'running'")?.n ?? 0
      if (running === 0) break
    } catch {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  try { store.close() } catch {}
}

// 等命令脱离 running：轮询库表，避免依赖进程事件的时序。
async function waitFinished(store, commandId, timeoutMs = 10_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const row = store.get('SELECT status FROM terminal_commands WHERE id = ?', commandId)
    if (row && row.status !== 'running') return row.status
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`terminal command ${commandId} still running after ${timeoutMs}ms`)
}

test('成功执行：cwd 是项目工作目录、exit_code 0、输出落库', async () => {
  const { root, workspace, store, service, project } = await terminalSetup()
  try {
    const row = store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const expectedDir = row.production_dir || join(workspace, row.slug)
    const started = service.runTerminalCommand(project.id, 'pwd && echo hello-dsh')
    const status = await waitFinished(store, started.id)
    assert.equal(status, 'succeeded')
    const finished = store.get('SELECT * FROM terminal_commands WHERE id = ?', started.id)
    assert.equal(finished.exit_code, 0)
    assert.ok(finished.output.includes(expectedDir), `输出应含项目工作目录 ${expectedDir}，实际：${finished.output}`)
    assert.ok(finished.output.includes('hello-dsh'))
    assert.ok(finished.ended_at)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('密钥值在输出落库前被掩码', async () => {
  const { root, store, service, project } = await terminalSetup()
  try {
    const secretValue = 'sk-term-secret-token-1234567890'
    await service.upsertSecret({ scope: 'project', projectId: project.id, name: 'GITHUB_TOKEN', purpose: '终端掩码测试', value: secretValue })
    const started = service.runTerminalCommand(project.id, `echo ${secretValue}`)
    await waitFinished(store, started.id)
    const finished = store.get('SELECT * FROM terminal_commands WHERE id = ?', started.id)
    assert.ok(finished.output.includes('$GITHUB_TOKEN'), `输出应掩码为 $GITHUB_TOKEN，实际：${finished.output}`)
    assert.ok(!finished.output.includes(secretValue), '密钥原文不得落库（output 列）')
    assert.ok(!finished.command.includes(secretValue), '密钥原文不得落库（command 列）')
    const auditRow = store.get("SELECT data_json FROM audit_log WHERE action = 'terminal.run' ORDER BY rowid DESC LIMIT 1")
    assert.ok(!auditRow.data_json.includes(secretValue), '审计里的命令原文同样过掩码')
    // terminalState 的实时/历史视图同样不得带出密钥原文
    const state = service.terminalState(project.id)
    assert.ok(!JSON.stringify(state).includes(secretValue), 'terminalState 视图不得带出密钥原文')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('硬超时：超时后置 timeout 并杀进程组', async () => {
  const { root, store, service, project } = await terminalSetup({ terminalTimeoutMs: 600 })
  try {
    const started = service.runTerminalCommand(project.id, 'sleep 30')
    const status = await waitFinished(store, started.id, 5000)
    assert.equal(status, 'timeout')
    const finished = store.get('SELECT * FROM terminal_commands WHERE id = ?', started.id)
    assert.match(finished.error_message, /超时/)
    assert.ok(finished.ended_at, '超时命令应记录 ended_at')
    // 进程组被杀后表内不再有 running 残留
    assert.equal(store.get("SELECT COUNT(*) AS n FROM terminal_commands WHERE status = 'running'").n, 0)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('手动停止：置 canceled', async () => {
  const { root, store, service, project } = await terminalSetup()
  try {
    const started = service.runTerminalCommand(project.id, 'sleep 30')
    await new Promise(resolve => setTimeout(resolve, 150))
    service.cancelTerminalCommand(started.id)
    const status = await waitFinished(store, started.id, 5000)
    assert.equal(status, 'canceled')
    const finished = store.get('SELECT * FROM terminal_commands WHERE id = ?', started.id)
    assert.match(finished.error_message, /停止/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('同项目并发第二条被 conflict 拒绝', async () => {
  const { root, store, service, project } = await terminalSetup()
  try {
    const first = service.runTerminalCommand(project.id, 'sleep 30')
    assert.throws(() => service.runTerminalCommand(project.id, 'echo nope'), /运行/)
    service.cancelTerminalCommand(first.id)
    await waitFinished(store, first.id, 5000)
    // 停止后可以再跑
    const second = service.runTerminalCommand(project.id, 'echo again')
    assert.equal(await waitFinished(store, second.id), 'succeeded')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('历史每项目只保留最近 20 条', async () => {
  const { root, store, service, project } = await terminalSetup()
  try {
    for (let index = 0; index < 25; index += 1) {
      store.run(
        `INSERT INTO terminal_commands(id, project_id, command, status, exit_code, output, created_at, ended_at)
         VALUES (?, ?, ?, 'succeeded', 0, '', ?, ?)`,
        `term-old${index}`, project.id, `echo ${index}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      )
    }
    const state = service.terminalState(project.id)
    assert.equal(state.history.length, 20)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM terminal_commands WHERE project_id = ?', project.id).n, 20)
    // 保留的是最新的 20 条（created_at 降序，第 0 条是 index 24）
    assert.equal(state.history[0].command, 'echo 24')
    assert.equal(state.history[19].command, 'echo 5')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('服务重启把遗留 running 置 interrupted', async () => {
  const { root, store, config, service, makeService, project } = await terminalSetup()
  try {
    // 模拟重启前留下的 running 行：不在新实例的内存 Map 里。
    // sleep 3 控制孤儿进程存活时长，避免测试进程等它等到超时。
    const started = service.runTerminalCommand(project.id, 'sleep 3')
    const rebooted = makeService()
    await rebooted.initialize()
    const row = store.get('SELECT * FROM terminal_commands WHERE id = ?', started.id)
    assert.equal(row.status, 'interrupted')
    assert.equal(row.error_message, '服务重启中断')
    // interrupted 之后该项目的并发锁解除，可以再跑新命令
    const second = rebooted.runTerminalCommand(project.id, 'echo after-reboot')
    assert.equal(await waitFinished(store, second.id), 'succeeded')
    // 对已结束（interrupted）的命令再取消会被 conflict 拒绝
    assert.throws(() => rebooted.cancelTerminalCommand(started.id), /已结束/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('参数校验：空命令与超过 4000 字符的命令被拒绝', async () => {
  const { root, store, service, project } = await terminalSetup()
  try {
    assert.throws(() => service.runTerminalCommand(project.id, '   '), /不能为空/)
    assert.throws(() => service.runTerminalCommand(project.id, 'x'.repeat(4001)), /过长/)
    const exactly = service.runTerminalCommand(project.id, `echo ${'y'.repeat(4000 - 5)}`)
    assert.equal(await waitFinished(store, exactly.id), 'succeeded')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('审计日志记录 terminal.run 与 terminal.cancel', async () => {
  const { root, store, service, project } = await terminalSetup()
  try {
    const started = service.runTerminalCommand(project.id, 'sleep 30')
    service.cancelTerminalCommand(started.id)
    await waitFinished(store, started.id, 5000)
    const actions = store.all("SELECT action, target_type FROM audit_log WHERE action LIKE 'terminal.%' ORDER BY rowid")
    assert.deepEqual(actions.map(item => item.action), ['terminal.run', 'terminal.cancel'])
    const runEntry = store.get("SELECT data_json FROM audit_log WHERE action = 'terminal.run'")
    assert.ok(runEntry.data_json.includes('sleep 30'), '审计应记录命令原文')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
