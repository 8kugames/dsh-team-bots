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
  const config = resolveConfig({ workspace, dataDir, modelCacheMs: 0, schedulerIntervalMs: 20 })
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

test('project-level skill toggle flows through service, api and system prompt', async () => {
  const { root, store, service, config } = await setup()
  try {
    const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
    const project = await service.createProject({ name: 'Demo', key: 'DEMO', ownerBotId: chief.id })
    assert.deepEqual(project.disabledSkills, [])

    // 关闭：API 层进、projectView 出
    const actor = { type: 'user', id: 'u1' }
    const off = await handleAction(service, 'toggle_skill', { projectId: project.id, slug: 'review', disabled: true }, actor)
    assert.deepEqual(off.disabledSkills, ['review'])
    const row = store.get('SELECT disabled_skills FROM projects WHERE id = ?', project.id)
    assert.equal(JSON.parse(row.disabled_skills).length, 1)

    // 系统提示带上禁用清单
    const runtime = new DshRuntime({ ctx: {}, config, store, logger: { info() {}, warn() {}, error() {} } })
    const sessionId = bindSession(store, chief.id, project.id)
    const prompt = runtime.systemPromptFor({ agent: { id: sessionId } })
    assert.ok(prompt.includes('disabled for this project'), 'prompt 应包含禁用声明')
    assert.ok(prompt.includes('`review`'), 'prompt 应包含被禁技能 slug')

    // 恢复后提示回到默认文案
    const on = await handleAction(service, 'toggle_skill', { projectId: project.id, slug: 'review', disabled: false }, actor)
    assert.deepEqual(on.disabledSkills, [])
    const promptAfter = runtime.systemPromptFor({ agent: { id: sessionId } })
    assert.ok(!promptAfter.includes('disabled for this project'))

    // 未知技能与未知项目报错
    await assert.rejects(() => service.setProjectSkillDisabled(project.id, 'nope', true, actor), /不存在/)
    await assert.rejects(() => service.setProjectSkillDisabled('p_missing', 'review', true, actor), /不存在/)
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
