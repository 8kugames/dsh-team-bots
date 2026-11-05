import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDirResilient, ensureSkillRoot } from '../src/paths.js'

async function tempRoot() {
  return realpath(await mkdtemp(join(tmpdir(), 'dsh-paths-')))
}

test('ensureSkillRoot replaces a self-referencing skill-root symlink', async () => {
  const root = await tempRoot()
  const pool = join(root, 'agents')
  try {
    await symlink('agents', pool)

    const real = await ensureSkillRoot(pool)

    assert.equal(real, join(root, 'agents'))
    assert.equal(await readlink(pool).catch(() => null), null)
    await writeFile(join(real, 'skills', 'probe.md'), 'ok')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureSkillRoot keeps a symlinked pool and ensures the skills directory', async () => {
  const root = await tempRoot()
  const pool = join(root, 'agents')
  const cache = join(root, 'skills-cache')
  try {
    await mkdir(cache, { recursive: true })
    await symlink(cache, pool)

    const real = await ensureSkillRoot(pool)

    assert.equal(real, cache)
    assert.equal(await readlink(pool), cache)
    await writeFile(join(real, 'skills', 'probe.md'), 'ok')
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
