import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { nowIso } from '../src/util.js'

// 手动 runtime：密钥管道本身不启动运行，这里只满足 service 对 runtime 的最低要求。
class ManualRuntime {
  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  sessionBusy() { return false }

  async startRun({ run }) { return `session-${run.id}` }

  async steer() { return true }

  async cancelRun() { return true }
}

const sha8 = value => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)

async function pipelineSetup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-secrets-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const alpha = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: director.id, memberIds: [dev.id] })
  const beta = await service.createProject({ name: 'Beta', key: 'BET', ownerBotId: director.id, memberIds: [dev.id] })
  const slugOf = projectId => store.get('SELECT slug FROM projects WHERE id = ?', projectId).slug
  // DSHBOTS-106：明文一次性文件在数据目录；项目工作区里不应再出现任何密钥明文。
  const runtimeEnvOf = projectId => join(dataDir, 'secrets-runtime', `${projectId}.env`)
  const legacyEnvOf = projectId => join(workspace, slugOf(projectId), '.team', 'secrets.env')
  const noPlaintextAnywhere = (extraProjects = []) => {
    for (const project of [alpha, beta, ...extraProjects]) {
      assert.equal(existsSync(join(dataDir, 'secrets-runtime', `${project.id}.env`)), false, '入库不得物化一次性文件')
      assert.equal(existsSync(join(workspace, project.slug, '.team', 'secrets.env')), false, '项目工作区不得出现明文密钥')
    }
  }
  // 走一遍完整批准流程，拿一个已物化的一次性文件（供焚毁类断言用）。
  const approveFor = async (project, sessionId, name = 'PIPE_KEY', value = 'pipe_live_12345678') => {
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, 'project', ?)",
      sessionId, dev.id, project.id, nowIso(),
    )
    const request = service.requestSecretFromBot({ sessionId, name, reason: '管线测试' })
    return service.approveSecretRequest(request.requestId, { value })
  }
  return { root, store, service, director, dev, alpha, beta, workspace, dataDir, runtimeEnvOf, legacyEnvOf, noPlaintextAnywhere, approveFor }
}

// 不产生运行，但保持与其它测试相同的关闭顺序。
async function closeQuietly(store) {
  try { store.close() } catch {}
}

test('密钥入库只落密文：不物化一次性文件，项目工作区无明文', async () => {
  const { root, store, service, director, alpha, beta, dataDir, noPlaintextAnywhere } = await pipelineSetup()
  try {
    const created = await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' })

    assert.equal(created.name, 'GITHUB_TOKEN')
    assert.equal(created.fingerprint, sha8('ghp_abcdefghijklmnop'))
    const row = store.get("SELECT * FROM secrets WHERE name = 'GITHUB_TOKEN'")
    assert.equal(row.scope, 'team')
    assert.equal(row.fingerprint, sha8('ghp_abcdefghijklmnop'))
    assert.notEqual(row.value_enc, 'ghp_abcdefghijklmnop')
    // team 密钥已存在的情形下建新项目（projects.js 的物化调用点）也不再写任何明文。
    const gamma = await service.createProject({ name: 'Gamma', key: 'GAM', ownerBotId: director.id })
    noPlaintextAnywhere([gamma])
    assert.ok(existsSync(join(dataDir, 'secret.key')))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('项目级密钥只入本项目，轮换保持单行且指纹变化', async () => {
  const { root, store, service, alpha, noPlaintextAnywhere } = await pipelineSetup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' })
    const first = await service.upsertSecret({ scope: 'project', projectId: alpha.id, name: 'API_KEY', value: 'proj-secret-123456' })
    noPlaintextAnywhere()

    const second = await service.upsertSecret({ scope: 'project', projectId: alpha.id, name: 'API_KEY', value: 'rotated-value-999999' })
    assert.equal(second.id, first.id)
    assert.notEqual(second.fingerprint, first.fingerprint)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM secrets WHERE name = 'API_KEY'").n, 1)
    assert.notEqual(store.get("SELECT value_enc FROM secrets WHERE name = 'API_KEY'").value_enc, 'rotated-value-999999')
    noPlaintextAnywhere()

    await assert.rejects(
      () => service.upsertSecret({ scope: 'team', name: 'TOO_SHORT', value: 'abc' }),
      /至少 8 个字符/,
    )
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('删除密钥即焚一次性文件并留审计', async () => {
  const { root, store, service, alpha, beta, runtimeEnvOf, noPlaintextAnywhere, approveFor } = await pipelineSetup()
  try {
    const teamSecret = await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' })
    const approved = await approveFor(alpha, 'sess-del-1', 'API_KEY', 'proj-secret-123456')
    assert.equal(existsSync(runtimeEnvOf(alpha.id)), true, '批准后一次性文件应存在')
    assert.ok((await readFile(runtimeEnvOf(alpha.id), 'utf8')).includes('GITHUB_TOKEN=ghp_abcdefghijklmnop'))

    assert.deepEqual(await service.deleteSecret(approved.id), { deleted: true })
    assert.equal(existsSync(runtimeEnvOf(alpha.id)), false, '删除项目密钥必须焚毁一次性文件')

    assert.deepEqual(await service.deleteSecret(teamSecret.id), { deleted: true })
    assert.equal(store.get('SELECT COUNT(*) AS n FROM secrets').n, 0)
    assert.equal(existsSync(runtimeEnvOf(alpha.id)), false)
    assert.equal(existsSync(runtimeEnvOf(beta.id)), false)
    noPlaintextAnywhere()
    const burns = store.all("SELECT * FROM audit_log WHERE action = 'secret.burn' AND target_id = ?", alpha.id)
    assert.ok(burns.some(row => JSON.parse(row.data_json).reason === 'secret_delete'), '删除焚毁要留审计')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('群消息持久化前把密钥值掩码为标签', async () => {
  const { root, store, service, alpha, noPlaintextAnywhere } = await pipelineSetup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' })

    const messageId = service.insertMessage({
      projectId: alpha.id,
      senderType: 'user',
      senderId: 'user-1',
      body: 'token 是 ghp_abcdefghijklmnop 请检查',
    })

    const row = store.get('SELECT body FROM messages WHERE id = ?', messageId)
    // 占位符与一次性 env 文件里的变量名保持一致（不再带 DSH_SECRET_ 前缀）
    assert.equal(row.body, 'token 是 $GITHUB_TOKEN 请检查')
    noPlaintextAnywhere()
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('Bot 密钥请求规范化名称，批准物化到数据目录，拒绝不留密钥', async () => {
  const { root, store, service, dev, alpha, beta, workspace, dataDir, runtimeEnvOf, legacyEnvOf, noPlaintextAnywhere } = await pipelineSetup()
  try {
    const sessionId = 'sess-secrets-1'
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, 'project', ?)",
      sessionId, dev.id, alpha.id, nowIso(),
    )

    const request = service.requestSecretFromBot({ sessionId, name: '$env:STRIPE_KEY', reason: '支付联调' })
    assert.equal(request.name, 'STRIPE_KEY')
    assert.equal(request.status, 'pending')
    const reqRow = store.get('SELECT * FROM secret_requests WHERE id = ?', request.requestId)
    assert.equal(reqRow.name, 'STRIPE_KEY')
    assert.equal(reqRow.status, 'pending')
    assert.equal(reqRow.project_id, alpha.id)
    assert.equal(reqRow.bot_id, dev.id)
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '%STRIPE_KEY%'", alpha.id).n,
      1,
    )

    const approved = await service.approveSecretRequest(request.requestId, { value: 'sk_live_1234567890' })
    assert.equal(approved.name, 'STRIPE_KEY')
    assert.equal(approved.fingerprint, sha8('sk_live_1234567890'))
    const secretRow = store.get("SELECT * FROM secrets WHERE name = 'STRIPE_KEY'")
    assert.equal(secretRow.scope, 'project')
    assert.equal(secretRow.project_id, alpha.id)
    assert.equal(secretRow.fingerprint, sha8('sk_live_1234567890'))
    assert.equal(store.get('SELECT status FROM secret_requests WHERE id = ?', request.requestId).status, 'approved')
    // 一次性文件在数据目录，内容含明文；项目工作区与其它项目都没有。
    const envPath = runtimeEnvOf(alpha.id)
    assert.equal(existsSync(envPath), true)
    assert.ok((await readFile(envPath, 'utf8')).includes('STRIPE_KEY=sk_live_1234567890\n'))
    assert.equal(existsSync(runtimeEnvOf(beta.id)), false)
    assert.equal(existsSync(legacyEnvOf(alpha.id)), false)
    assert.ok(!existsSync(join(workspace, alpha.slug ?? '', '.team')), '项目工作区不得出现 .team 明文目录')
    // 批准回执向 Bot 披露数据目录里的一次性路径与即焚语义，而不是项目内路径。
    const receipt = store.get(
      "SELECT * FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '%已批准%' ORDER BY created_at DESC LIMIT 1",
      alpha.id,
    )
    assert.ok(receipt.body.includes(join(dataDir, 'secrets-runtime')), '回执必须给出数据目录里的一次性文件路径')
    assert.ok(receipt.body.includes('自动焚毁'), '回执必须说明即焚语义')
    assert.ok(!receipt.body.includes('.team/secrets.env'), '回执不得再指向项目内路径')
    assert.ok(
      store.all("SELECT * FROM audit_log WHERE action = 'secret.materialize' AND target_id = ?", alpha.id).length >= 1,
      '物化要留审计',
    )

    const denied = service.requestSecretFromBot({ sessionId, name: 'OLD_KEY', reason: '旧密钥下线' })
    assert.deepEqual(await service.denySecretRequest(denied.requestId), { denied: true })
    assert.equal(store.get('SELECT status FROM secret_requests WHERE id = ?', denied.requestId).status, 'denied')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM secrets WHERE name = 'OLD_KEY'").n, 0)
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND body LIKE '%被拒绝%'", alpha.id).n,
      1,
    )
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('生产目录切换不再物化；旧 .team/secrets.env 残留被清理', async () => {
  const { root, store, service, director, workspace, runtimeEnvOf } = await pipelineSetup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' })
    const prod1 = join(root, 'repo-one')
    const prod2 = join(root, 'repo-two')
    const project = await service.createProject({ name: 'Ext', key: 'EXT', ownerBotId: director.id, productionDir: prod1 })
    assert.equal(existsSync(join(prod1, '.team', 'secrets.env')), false, '建项目不得再物化明文')
    assert.equal(existsSync(join(workspace, project.slug, '.team', 'secrets.env')), false)
    assert.equal(existsSync(runtimeEnvOf(project.id)), false)

    // 模拟旧架构残留：生产目录与项目管理目录各躺一个 .team/secrets.env。
    await mkdir(join(prod1, '.team'), { recursive: true })
    await writeFile(join(prod1, '.team', 'secrets.env'), 'GITHUB_TOKEN=ghp_abcdefghijklmnop\n')
    await mkdir(join(workspace, project.slug, '.team'), { recursive: true })
    await writeFile(join(workspace, project.slug, '.team', 'secrets.env'), 'GITHUB_TOKEN=ghp_abcdefghijklmnop\n')

    await service.updateProject(project.id, { productionDir: prod2 })
    assert.equal(existsSync(join(prod1, '.team', 'secrets.env')), false, '切生产目录后旧明文必须清掉')
    assert.equal(existsSync(join(prod2, '.team', 'secrets.env')), false, '新生产目录不得被写入明文')
    assert.equal(existsSync(join(workspace, project.slug, '.team', 'secrets.env')), false, '管理目录残留也应被顺带清理')
    assert.equal(existsSync(runtimeEnvOf(project.id)), false, '切目录不触发一次性物化')

    await service.updateProject(project.id, { productionDir: '' })
    assert.equal(existsSync(join(prod2, '.team', 'secrets.env')), false)
    assert.equal(existsSync(join(workspace, project.slug, '.team', 'secrets.env')), false)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
