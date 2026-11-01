import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDirResilient, ensureSkillRoot } from '../src/paths.js'

async function tempRoot() {
  return realpath(await mkdtemp(join(tmpdir(), 'dsh-paths-')))
}

test('ensureSkillRoot replaces a self-referencing .agents symlink', async () => {
  const root = await tempRoot()
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    const workspaceReal = await realpath(workspace)
    await symlink('.agents', join(workspaceReal, '.agents'))

    const real = await ensureSkillRoot(workspaceReal)

    assert.equal(real, join(workspaceReal, '.agents'))
    assert.equal(await readlink(join(workspaceReal, '.agents')).catch(() => null), null)
    await writeFile(join(real, 'skills', 'probe.md'), 'ok')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureSkillRoot keeps a symlinked pool that stays inside the workspace', async () => {
  const root = await tempRoot()
  const workspace = join(root, 'workspace')
  try {
    await mkdir(join(workspace, 'skills-cache'), { recursive: true })
    const workspaceReal = await realpath(workspace)
    const link = join(workspaceReal, '.agents')
    await symlink(join(workspaceReal, 'skills-cache'), link)

    const real = await ensureSkillRoot(workspaceReal)

    assert.equal(real, join(workspaceReal, 'skills-cache'))
    assert.equal(await readlink(link), join(workspaceReal, 'skills-cache'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureSkillRoot rejects a symlink that escapes the workspace', async () => {
  const root = await tempRoot()
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    const workspaceReal = await realpath(workspace)
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(workspaceReal, '.agents'))
    await assert.rejects(() => ensureSkillRoot(workspaceReal), /共享技能池越界/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureDirResilient is idempotent and rejects a file at the target path', async () => {
  const root = await tempRoot()
  const directory = join(root, 'nested', 'target')
  try {
    await ensureDirResilient(directory)
    await ensureDirResilient(directory)
    await writeFile(join(root, 'file'), 'x')
    await assert.rejects(() => ensureDirResilient(join(root, 'file')), /不是目录/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
