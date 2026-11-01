import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
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
  const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const alpha = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: chief.id, memberIds: [dev.id] })
  const beta = await service.createProject({ name: 'Beta', key: 'BET', ownerBotId: chief.id, memberIds: [dev.id] })
  const slugOf = projectId => store.get('SELECT slug FROM projects WHERE id = ?', projectId).slug
  const envPathOf = projectId => join(workspace, slugOf(projectId), '.team', 'secrets.env')
  const readEnv = async (projectId) => {
    const slug = slugOf(projectId)
    const contents = await readFile(join(workspace, slug, '.team', 'secrets.env'), 'utf8')
    return { contents, gitignore: await readFile(join(workspace, slug, '.gitignore'), 'utf8') }
  }
  return { root, store, service, chief, dev, alpha, beta, workspace, dataDir, envPathOf, readEnv }
}

// 不产生运行，但保持与其它测试相同的关闭顺序。
async function closeQuietly(store) {
  try { store.close() } catch {}
}

test('团队级密钥物化到所有活动项目并带指纹', async () => {
  const { root, store, service, alpha, beta, dataDir, readEnv } = await pipelineSetup()
  try {
    const created = await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' })

    assert.equal(created.name, 'GITHUB_TOKEN')
    assert.equal(created.fingerprint, sha8('ghp_abcdefghijklmnop'))
    const row = store.get("SELECT * FROM secrets WHERE name = 'GITHUB_TOKEN'")
    assert.equal(row.scope, 'team')
    assert.equal(row.fingerprint, sha8('ghp_abcdefghijklmnop'))
    assert.notEqual(row.value_enc, 'ghp_abcdefghijklmnop')

    for (const project of [alpha, beta]) {
      const { contents, gitignore } = await readEnv(project.id)
      assert.ok(contents.includes('GITHUB_TOKEN=ghp_abcdefghijklmnop\n'), project.name)
      assert.match(gitignore, /^\.team\/$/m)
    }
    assert.ok(existsSync(join(dataDir, 'secret.key')))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('项目级密钥只写本项目，更新保持单行且指纹变化', async () => {
  const { root, store, service, alpha, beta, readEnv } = await pipelineSetup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' })
    const first = await service.upsertSecret({ scope: 'project', projectId: alpha.id, name: 'API_KEY', value: 'proj-secret-123456' })

    assert.ok((await readEnv(alpha.id)).contents.includes('API_KEY=proj-secret-123456\n'))
    assert.ok(!(await readEnv(beta.id)).contents.includes('API_KEY='))

    const second = await service.upsertSecret({ scope: 'project', projectId: alpha.id, name: 'API_KEY', value: 'rotated-value-999999' })
    assert.equal(second.id, first.id)
    assert.notEqual(second.fingerprint, first.fingerprint)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM secrets WHERE name = 'API_KEY'").n, 1)
    const { contents } = await readEnv(alpha.id)
    assert.equal((contents.match(/^API_KEY=/gm) ?? []).length, 1)
    assert.ok(contents.includes('API_KEY=rotated-value-999999\n'))
    assert.ok(!contents.includes('proj-secret-123456'))

    await assert.rejects(
      () => service.upsertSecret({ scope: 'team', name: 'TOO_SHORT', value: 'abc' }),
      /至少 8 个字符/,
    )
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('删除密钥重物化，清空后移除 secrets.env', async () => {
  const { root, store, service, alpha, beta, envPathOf, readEnv } = await pipelineSetup()
  try {
    const teamSecret = await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' })
    const projSecret = await service.upsertSecret({ scope: 'project', projectId: alpha.id, name: 'API_KEY', value: 'proj-secret-123456' })

    assert.deepEqual(await service.deleteSecret(projSecret.id), { deleted: true })
    let alphaEnv = (await readEnv(alpha.id)).contents
    assert.ok(!alphaEnv.includes('API_KEY='))
    assert.ok(alphaEnv.includes('GITHUB_TOKEN='))

    assert.deepEqual(await service.deleteSecret(teamSecret.id), { deleted: true })
    assert.equal(store.get('SELECT COUNT(*) AS n FROM secrets').n, 0)
    assert.equal(existsSync(envPathOf(alpha.id)), false)
    assert.equal(existsSync(envPathOf(beta.id)), false)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('群消息持久化前把密钥值掩码为标签', async () => {
  const { root, store, service, alpha, readEnv } = await pipelineSetup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' })

    const messageId = service.insertMessage({
      projectId: alpha.id,
      senderType: 'user',
      senderId: 'user-1',
      body: 'token 是 ghp_abcdefghijklmnop 请检查',
    })

    const row = store.get('SELECT body FROM messages WHERE id = ?', messageId)
    // 占位符就是 env 文件里的变量名（不再带 DSH_SECRET_ 前缀）
    assert.equal(row.body, 'token 是 $GITHUB_TOKEN 请检查')
    const { contents } = await readEnv(alpha.id)
    assert.ok(contents.includes('GITHUB_TOKEN=ghp_abcdefghijklmnop\n'), '占位符名必须与 env 变量名一致')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('Bot 密钥请求规范化名称，批准物化到项目，拒绝不留密钥', async () => {
  const { root, store, service, chief, dev, alpha, beta, envPathOf, readEnv } = await pipelineSetup()
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
    assert.ok((await readEnv(alpha.id)).contents.includes('STRIPE_KEY=sk_live_1234567890\n'))
    assert.equal(existsSync(envPathOf(beta.id)), false)

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

test('生产目录切换：secrets.env 物化到生产目录，切换后旧目录清理、新目录重新物化', async () => {
  const { root, store, service, chief, workspace } = await pipelineSetup()
  try {
    await service.upsertSecret({ scope: 'team', name: 'github token', purpose: 'CI', value: 'ghp_abcdefghijklmnop' })
    const prod1 = join(root, 'repo-one')
    const prod2 = join(root, 'repo-two')
    const project = await service.createProject({ name: 'Ext', key: 'EXT', ownerBotId: chief.id, productionDir: prod1 })
    assert.ok((await readFile(join(prod1, '.team', 'secrets.env'), 'utf8')).includes('GITHUB_TOKEN'))
    assert.equal(existsSync(join(workspace, project.slug, '.team', 'secrets.env')), false, '管理目录不应有明文密钥')

    await service.updateProject(project.id, { productionDir: prod2 })
    assert.equal(existsSync(join(prod1, '.team', 'secrets.env')), false, '旧生产目录的明文必须清掉')
    assert.ok((await readFile(join(prod2, '.team', 'secrets.env'), 'utf8')).includes('GITHUB_TOKEN'))

    await service.updateProject(project.id, { productionDir: '' })
    assert.equal(existsSync(join(prod2, '.team', 'secrets.env')), false, '清空生产目录后旧明文必须清掉')
    assert.ok((await readFile(join(workspace, project.slug, '.team', 'secrets.env'), 'utf8')).includes('GITHUB_TOKEN'))
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
