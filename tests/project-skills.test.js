import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { resolveProjectDirFromStore, resolveProjectSkillDir, scanProjectSkills } from '../src/project-skills.js'
import { skillProvider } from '../src/skills.js'
import { id, nowIso } from '../src/util.js'

class FakeRuntime {
  constructor() {
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }

  async catalog() { return this.models }

  setCompletionHandler(handler) { this.handler = handler }

  async validateBotConfig() {}

  async startRun() { return 'session-run' }

  async cancelRun() { return true }
}

async function writeSkill(dir, { name, description, version = '1.0.0', content = 'Body' }) {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\n---\n\n${content}\n`,
  )
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-skills-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  // 共享技能池
  await writeSkill(join(workspace, '.agents', 'skills', 'review'), {
    name: 'review', description: 'Shared review', content: 'Shared body',
  })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new FakeRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const project = await service.createProject({ name: 'Demo', key: 'DEMO', ownerBotId: director.id })
  return { root, workspace, dataDir, config, store, service, project }
}

test('project skill pool discovers .agents, .claude and .codex and dedups by name', async () => {
  const { root, workspace, store, service, project } = await setup()
  try {
    const projectDir = join(workspace, project.slug)
    await writeSkill(join(projectDir, '.agents', 'skills', 'review'), {
      name: 'review', description: 'Project review', version: '2.0.0',
    })
    await writeSkill(join(projectDir, '.claude', 'skills', 'review'), {
      name: 'review', description: 'Claude review',
    })
    await writeSkill(join(projectDir, '.codex', 'skills', 'deploy'), {
      name: 'deploy', description: 'Deploy helper',
    })

    const { skills } = scanProjectSkills(projectDir)
    assert.deepEqual(skills.map(skill => skill.name).sort(), ['deploy', 'review'])
    const review = skills.find(skill => skill.name === 'review')
    // 同名按 .agents > .claude > .codex 去重
    assert.equal(review.root, '.agents')
    assert.equal(review.description, 'Project review')
    assert.equal(review.version, '2.0.0')
    assert.deepEqual(review.roots, ['.agents', '.claude'])
    assert.deepEqual(review.duplicates.map(item => item.root), ['.claude'])
    assert.equal(review.relativePath, '.agents/skills/review/SKILL.md')
    assert.equal(skills.find(skill => skill.name === 'deploy').root, '.codex')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('project skill pool skips packages without a valid name', async () => {
  const { root, workspace, store, service, project } = await setup()
  try {
    const projectDir = join(workspace, project.slug)
    await writeSkill(join(projectDir, '.agents', 'skills', 'Bad Name'), {
      name: 'Bad Name', description: 'invalid name',
    })
    await mkdir(join(projectDir, '.agents', 'skills', 'nodoc'), { recursive: true })
    await writeFile(join(projectDir, '.agents', 'skills', 'nodoc', 'SKILL.md'), '---\nname: nodoc\n---\n\nBody only\n')

    const { skills, skipped } = scanProjectSkills(projectDir)
    // frontmatter 没有描述时回退正文首段；目录名不合法则整包跳过
    assert.deepEqual(skills.map(skill => skill.name), ['nodoc'])
    assert.equal(skills[0].description, 'Body only')
    assert.equal(skipped, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveProjectSkillDir only accepts a direct project directory of the workspace', async () => {
  const { root, workspace, store, service } = await setup()
  try {
    assert.equal(resolveProjectSkillDir(workspace, join(workspace, 'demo')), join(workspace, 'demo'))
    assert.equal(resolveProjectSkillDir(workspace, join(workspace, '_the_bots', 'director')), null)
    assert.equal(resolveProjectSkillDir(workspace, join(workspace, '.agents')), null)
    assert.equal(resolveProjectSkillDir(workspace, join(workspace, 'demo', 'nested')), null)
    assert.equal(resolveProjectSkillDir(workspace, '/tmp/elsewhere'), null)
    assert.equal(resolveProjectSkillDir(workspace, null), null)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('state exposes the project skill pool of the selected project', async () => {
  const { root, workspace, store, service, project } = await setup()
  try {
    const projectDir = join(workspace, project.slug)
    await writeSkill(join(projectDir, '.claude', 'skills', 'deploy'), {
      name: 'deploy', description: 'Deploy helper',
    })

    const view = await service.state()
    assert.equal(view.project.slug, project.slug)
    assert.deepEqual(view.projectSkills.map(skill => skill.name), ['deploy'])
    assert.equal(view.projectSkills[0].root, '.claude')
    assert.equal(view.projectSkills[0].relativePath, '.claude/skills/deploy/SKILL.md')
    assert.deepEqual(view.paths.projectSkillRoots.map(item => item.root), ['.agents', '.claude', '.codex'])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('skill provider lists project skills by cwd and prefers them over shared skills', async () => {
  const { root, workspace, config, store, service, project } = await setup()
  try {
    const projectDir = join(workspace, project.slug)
    await writeSkill(join(projectDir, '.agents', 'skills', 'review'), {
      name: 'review', description: 'Project review',
    })
    await writeSkill(join(projectDir, '.codex', 'skills', 'deploy'), {
      name: 'deploy', description: 'Deploy helper',
    })

    const provider = skillProvider(config.skillRoot, {
      resolveProjectDir: cwd => resolveProjectSkillDir(config.workspace, cwd),
    })

    const withoutProject = await provider.list({ cwd: join(workspace, '_the_bots', 'director') })
    assert.deepEqual(withoutProject.map(item => item.name), ['review'])
    assert.equal(withoutProject[0].source, 'workspace')

    const withProject = await provider.list({ cwd: projectDir })
    assert.deepEqual(withProject.map(item => item.name).sort(), ['deploy', 'review'])
    const review = withProject.find(item => item.name === 'review')
    // 项目技能优先于同名共享技能
    assert.equal(review.source, 'project')
    assert.equal(review.rank, 100)
    assert.equal(review.description, 'Project review')
    const deploy = withProject.find(item => item.name === 'deploy')
    assert.equal(deploy.rank, 120)

    const loaded = await provider.get(review)
    assert.ok(loaded.content.includes('Body'))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('project session prompt tells the bot about the project skill pool', async () => {
  const { root, workspace, config, store, service, project } = await setup()
  try {
    await writeSkill(join(workspace, project.slug, '.claude', 'skills', 'deploy'), {
      name: 'deploy', description: 'Deploy helper',
    })
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const sessionId = id('sess')
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, 'project', ?)",
      sessionId, director.id, project.id, nowIso(),
    )
    const runtime = new DshRuntime({ ctx: {}, config, store, logger: { info() {}, warn() {}, error() {} } })
    const prompt = runtime.systemPromptFor({ agent: { id: sessionId } })
    assert.ok(prompt.includes('Project skill pools are mounted at'), 'prompt 应说明项目技能池位置')
    assert.ok(prompt.includes(`${workspace}/${project.slug}/.agents/skills`), 'prompt 应带出项目技能根路径')
    assert.ok(prompt.includes('`deploy`'), 'prompt 应列出可用项目技能')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('生产目录：会话 cwd、prompt 与项目技能池都以生产目录为准', async () => {
  const { root, workspace, config, store, service, project } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const prod = join(root, 'existing-repo')
    await mkdir(prod, { recursive: true })
    // 技能池以生产目录为准：deploy 放生产目录；管理目录只放一个旧技能，证明不再进池
    await writeSkill(join(prod, '.agents', 'skills', 'deploy'), {
      name: 'deploy', description: 'Deploy helper',
    })
    await writeSkill(join(workspace, project.slug, '.codex', 'skills', 'legacy'), {
      name: 'legacy', description: 'Stale management-dir skill',
    })
    const updated = await service.updateProject(project.id, { productionDir: prod })
    const prodReal = updated.workspace_path

    const created = []
    const runtime = new DshRuntime({
      ctx: {
        sessionController: {
          create: async payload => { created.push(payload); return { sessionId: 'sess-prod' } },
          resolveAgent: async () => ({ agent: { session: {} } }),
          selectModel: async () => ({}),
        },
      },
      config, store, logger: { info() {}, warn() {}, error() {} },
    })
    const row = store.get('SELECT * FROM projects WHERE id = ?', project.id)
    await runtime.ensureSession(director, row, { sessionKind: 'project' })
    assert.equal(created.length, 1)
    assert.equal(created[0].cwd, prodReal, '会话 cwd 应是生产目录')

    const prompt = runtime.promptFor({ run: { kind: 'task' }, project: row, bot: director })
    assert.ok(prompt.includes(`Workspace: ${prodReal}`), '运行 prompt 应带生产目录')
    const system = runtime.systemPromptFor({ agent: { id: 'sess-prod' } })
    assert.ok(system.includes(`- Workspace: ${prodReal}`), '身份 prompt 应带生产目录')
    assert.ok(system.includes(`${prodReal}/.agents/skills`), '技能池 mount 应指向生产目录')
    assert.ok(!system.includes(`${workspace}/${project.slug}/.agents/skills`), '技能池 mount 不应再指向管理目录')
    assert.ok(system.includes('`deploy`'), 'prompt 应列出生产目录技能')
    assert.ok(!system.includes('`legacy`'), '管理目录旧技能不应进池')

    const view = await service.state()
    assert.deepEqual(view.projectSkills.map(skill => skill.name), ['deploy'], '项目技能卡应扫生产目录')
    assert.ok(view.paths.projectSkillRoots.some(item => item.path === join(prodReal, '.agents')), '技能根路径应是生产目录')

    // 会话 cwd 在工作区之外时，反解要靠 projects 表里的生产目录登记
    assert.equal(resolveProjectDirFromStore(store, workspace, prodReal), prodReal)
    assert.equal(resolveProjectDirFromStore(store, workspace, join(root, 'elsewhere')), null)
    assert.equal(resolveProjectDirFromStore(store, workspace, join(workspace, 'demo')), join(workspace, 'demo'))

    const provider = skillProvider(config.skillRoot, {
      resolveProjectDir: cwd => resolveProjectDirFromStore(store, config.workspace, cwd),
    })
    const listed = await provider.list({ cwd: prodReal })
    assert.ok(listed.some(item => item.name === 'deploy' && item.source === 'project'), 'Bot 会话里应能看到生产目录项目技能')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
