// DSHBOTS-201：pre-commit 版本 bump 仅 main 分支生效。
// 口径：①main 分支提交前 patch 位 +1 并暂存；②dev 等非 main 分支跳过（退出码 0，版本不变）；
// ③DSH_SKIP_VERSION_BUMP=1 在 main 上仍跳过；④--dry-run 只打印不落盘。
// 端到端跑真脚本：在临时 git 仓库里复制 scripts/version-bump.mjs 后执行，root 由脚本自身位置推导。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptSrc = join(repoRoot, 'scripts', 'version-bump.mjs')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-version-bump-'))
  mkdirSync(join(dir, 'scripts'))
  copyFileSync(scriptSrc, join(dir, 'scripts', 'version-bump.mjs'))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-team-bots', version: '0.2.288' }, null, 2)}\n`)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

function runScript(dir, args = [], env = {}) {
  return spawnSync(process.execPath, [join(dir, 'scripts', 'version-bump.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function readVersion(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
}

test('main 分支提交前 patch 位 +1 并暂存', () => {
  const dir = makeRepo()
  try {
    const result = runScript(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readVersion(dir), '0.2.289')
    assert.match(git(dir, ['show', ':package.json']), /"version": "0\.2\.289"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dev 分支跳过：版本不变、退出码 0', () => {
  const dir = makeRepo()
  try {
    git(dir, ['checkout', '-q', '-b', 'dev'])
    const result = runScript(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readVersion(dir), '0.2.288')
    assert.match(result.stdout, /非 main/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DSH_SKIP_VERSION_BUMP=1 在 main 上仍跳过', () => {
  const dir = makeRepo()
  try {
    const result = runScript(dir, [], { DSH_SKIP_VERSION_BUMP: '1' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readVersion(dir), '0.2.288')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--dry-run 在 main 上只打印不落盘', () => {
  const dir = makeRepo()
  try {
    const result = runScript(dir, ['--dry-run'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readVersion(dir), '0.2.288')
    assert.match(result.stdout, /0\.2\.288 → 0\.2\.289/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('.githooks/pre-commit 仍委托 scripts/version-bump.mjs', () => {
  const hook = readFileSync(join(repoRoot, '.githooks', 'pre-commit'), 'utf8')
  assert.match(hook, /scripts\/version-bump\.mjs/)
})
