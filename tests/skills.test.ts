import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { handleAction } from '../src/api.js'
import { id, nowIso } from '../src/util.js'

class FakeRuntime {
  declare service: TeamService
  declare models: { ref: string; provider: string; providerName: string; model: string; name: string; efforts: { id: string; name: string }[]; defaultEffort: string }[]
  declare handler: (result: { runId: string; status: string; output: string; error: null }) => unknown

  constructor(service) {
    this.service = service
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return this.models }

  async validateBotConfig() {}

  async startRun({ run, bot }) {
    setImmediate(() => {
      void this.handler({
        runId: run.id,
        status: 'succeeded',
        output: `Reply from ${bot.name}.`,
        error: null,
      })
    })
    return `session-${run.id}`
  }

  async cancelRun() { return true }
}

async function closeQuietly(store, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    let active = 1
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch { break }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try { store.close() } catch {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills', 'review'), { recursive: true })
  await writeFile(
    join(workspace, '.agents', 'skills', 'review', 'SKILL.md'),
    `---\nname: review\ndescription: Review code\nversion: 1.0.0\n---\n\nReview carefully.\n`,
  )
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new FakeRuntime(service))
  await service.initialize()
  service.started = true
  return { root, workspace, dataDir, config, store, service }
}

function bindSession(store, botId, projectId) {
  const sessionId = id('sess')
  store.run(
    "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, 'project', ?)",
    sessionId, botId, projectId, nowIso(),
  )
  return sessionId
}

test('skill detail returns full markdown content and version history', async () => {
  const { root, store, service } = await setup()
  try {
    const detail = await service.skillDetail('review')
    assert.equal(detail.slug, 'review')
    assert.ok(detail.content.includes('Review carefully.'))
    assert.ok(detail.readable)
    assert.ok(detail.versions.length >= 1)
    assert.equal(detail.versions[0].version, '1.0.0')
    await assert.rejects(() => service.skillDetail('nope'), /不存在/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('skill pool only lists skills that still exist in the skill root', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    const before = await (service.state as () => Promise<{ skills: Array<{ slug: string; status: string }> }>)()
    assert.deepEqual(before.skills.map(skill => skill.slug), ['review'])
    assert.equal(before.skills[0].status, 'active')

    // 技能文件被移出技能根目录后，重新扫描即失效
    await rm(join(workspace, '.agents', 'skills', 'review'), { recursive: true, force: true })
    const synced = await service.syncSkillsNow()
    assert.equal(synced.count, 0)
    assert.deepEqual(synced.skills, [])

    const after = await (service.state as () => Promise<{ skills: Array<{ slug: string; status: string }> }>)()
    assert.deepEqual(after.skills.map(skill => skill.slug), [])
    // 失效记录仍留在库里，便于追溯
    assert.equal(store.get('SELECT status FROM skills WHERE slug = ?', 'review')?.status, 'missing')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('project-level skill toggle flows through service, api and system prompt', async () => {
  const { root, store, service, config } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'Demo', key: 'DEMO', ownerBotId: director.id })
    assert.deepEqual(project.disabledSkills, [])

    // 关闭：API 层进、projectView 出
    const actor = { type: 'user', id: 'u1' }
    const off = await handleAction(service, 'toggle_skill', { projectId: project.id, slug: 'review', disabled: true }, actor)
    assert.deepEqual(off.disabledSkills, ['review'])
    const row = store.get('SELECT disabled_skills FROM projects WHERE id = ?', project.id)
    assert.equal(JSON.parse(row.disabled_skills).length, 1)

    // 系统提示带上禁用清单
    const runtime = new DshRuntime({ ctx: {}, config, store, logger: { info() {}, warn() {}, error() {} } })
    const sessionId = bindSession(store, director.id, project.id)
    const prompt = runtime.systemPromptFor({ agent: { id: sessionId } })
    assert.ok(prompt.includes('disabled for this project'), 'prompt 应包含禁用声明')
    assert.ok(prompt.includes('`review`'), 'prompt 应包含被禁技能 slug')
    assert.ok(!prompt.includes('Long-term memory'), '记忆块不进 system 区')

    // 恢复后：同会话 system 区已按 session id 冻结（字节不变），新会话回到默认文案
    const on = await handleAction(service, 'toggle_skill', { projectId: project.id, slug: 'review', disabled: false }, actor)
    assert.deepEqual(on.disabledSkills, [])
    const promptAfter = runtime.systemPromptFor({ agent: { id: sessionId } })
    assert.equal(promptAfter, prompt, '同 session 二次求值应逐字节相同（会话级冻结）')
    // 新会话看默认文案：同 bot+project 的 project 绑定有唯一索引，换 programmer 开新会话
    const programmer = store.get("SELECT * FROM bots WHERE name = 'programmer'")
    const freshPrompt = runtime.systemPromptFor({ agent: { id: bindSession(store, programmer.id, project.id) } })
    assert.ok(!freshPrompt.includes('disabled for this project'), '新会话不应再看到禁用声明')

    // 未知技能与未知项目报错
    await assert.rejects(() => service.setProjectSkillDisabled(project.id, 'nope', true, actor), /不存在/)
    await assert.rejects(() => service.setProjectSkillDisabled('p_missing', 'review', true, actor), /不存在/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
