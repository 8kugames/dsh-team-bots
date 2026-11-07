// DSHBOTS-260：发版流水线工具化守门——用临时 git 仓库端到端演练 scripts/release.mjs 的五个步骤。
//
// 覆盖：①正常路径五步全绿：main 是与 dev 无共同历史的孤儿分支、main↔dev 树差异很大（新增/删除/修改并存），
//         read-tree 换树无冲突，发布快照提交前后 package.json 保持 0.2.338 不被 bump，
//         tag 锚定合并后 main 的 HEAD 且与包内 version 一致
//       ②工作树不干净：拒绝发版，远端零改动
//       ③tag 已存在：拒绝重复打标，main 不被推进
//       ④main 有分叉（非快照）：拒绝强行合并，退出后回到 dev，远端无 tag
//       ⑤main 可快进时走 fast-forward 模式，合并后 main == dev 且不新增提交
//
// 临时目录：优先用仓库内 .tmp（项目惯例，RULES.md 要求验证只用仓库内临时目录）；
//          沙箱里 os.tmpdir() 可能 EPERM，此时回退仓库内 .tmp。EPERM/EACCES 属环境性假红，
//          按 skip 处理并注明原因；守门是否绿以 AssertionError 计数为 0 为准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptSrc = join(repoRoot, 'scripts', 'release.mjs')
const bumpSrc = join(repoRoot, 'scripts', 'version-bump.mjs')
const hookSrc = join(repoRoot, '.githooks', 'pre-commit')

const VERSION = '0.2.338'
const PREVIOUS_VERSION = '0.2.337'

// 发布说明文件内容：对应版本小节的中文段带条目粗体小标题，英文段不参与摘要。
function releaseNotes(version: string): string {
  return [
    '# 发版说明',
    '',
    `## v${version}`,
    '',
    '### 中文',
    '',
    '- **第一项变更**：说明文字。',
    '- **第二项变更**：说明文字。',
    '',
    '### English',
    '',
    '- **First change**: english text.',
    '',
  ].join('\n')
}

// 搭建用的 git 命令：显式跳过版本 bump，避免污染测试里的版本号。
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_SKIP_VERSION_BUMP: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

function isEnvironmentError(error) {
  const code = error?.code ?? error?.status
  return code === 'EPERM' || code === 'EACCES' || /EPERM|EACCES/.test(String(error?.message ?? ''))
}

// 临时目录优先放仓库内 .tmp：受管沙箱里 os.tmpdir() 常是 EPERM，仓库内一定可写。
function makeTempDir() {
  try {
    const localRoot = join(repoRoot, '.tmp')
    mkdirSync(localRoot, { recursive: true })
    return mkdtempSync(join(localRoot, 'release-test-'))
  } catch (error) {
    if (!isEnvironmentError(error)) throw error
    return mkdtempSync(join(tmpdir(), 'dsh-release-'))
  }
}

// 临时仓库：本地 bare 远端 + 工作仓库（dev 分支 + 与 dev 无共同历史的 main 孤儿分支）。
// 仓库里装上真实的 .githooks/pre-commit + scripts/version-bump.mjs：工具若漏传
// DSH_SKIP_VERSION_BUMP=1，快照提交会被 bump 钩子改掉版本号，用例随即失败。
function makeRepo(options: { mainMode?: string; notes?: 'missing' | 'wrong-version' } = {}) {
  const base = makeTempDir()
  const remote = join(base, 'remote.git')
  const work = join(base, 'work')
  mkdirSync(remote)
  mkdirSync(join(work, 'scripts'), { recursive: true })
  mkdirSync(join(work, '.githooks'), { recursive: true })
  mkdirSync(join(work, 'src'), { recursive: true })
  copyFileSync(scriptSrc, join(work, 'scripts', 'release.mjs'))
  copyFileSync(bumpSrc, join(work, 'scripts', 'version-bump.mjs'))
  copyFileSync(hookSrc, join(work, '.githooks', 'pre-commit'))
  chmodSync(join(work, '.githooks', 'pre-commit'), 0o755)
  writeFileSync(join(work, 'package.json'), `${JSON.stringify({ name: 'dsh-team-bots', version: VERSION }, null, 2)}\n`)
  // 发布摘要来源：dev 树里的 docs/release-notes.md 对应版本小节（工具据此生成发布提交标题）。
  if (options.notes !== 'missing') {
    mkdirSync(join(work, 'docs'), { recursive: true })
    const notes = options.notes === 'wrong-version'
      ? releaseNotes('9.9.9')
      : releaseNotes(VERSION)
    writeFileSync(join(work, 'docs', 'release-notes.md'), notes)
  }

  git(remote, ['init', '-q', '--bare'])
  git(work, ['init', '-q', '-b', 'dev'])
  git(work, ['config', 'user.email', 'test@example.com'])
  git(work, ['config', 'user.name', 'test'])
  git(work, ['config', 'commit.gpgsign', 'false'])
  git(work, ['config', 'core.hooksPath', '.githooks'])
  // 基线提交：dev 与 main 的共同起点（main 之后会以它的树为快照基点）。
  writeFileSync(join(work, 'legacy-only.txt'), 'legacy\n')
  writeFileSync(join(work, 'src', 'base.txt'), 'base\n')
  git(work, ['add', '-A'])
  git(work, ['commit', '-q', '-m', 'init'])
  git(work, ['remote', 'add', 'origin', remote])
  git(work, ['push', '-q', '-u', 'origin', 'dev'])

  if (options.mainMode === 'ancestor') {
    // main 与 dev 同历史：dev 的某个祖先，作为 fast-forward 场景。
    const root = git(work, ['rev-list', '--max-parents=0', 'dev'])
    git(work, ['branch', 'main', root])
    git(work, ['push', '-q', '-u', 'origin', 'main'])
  } else {
    // main 是发版专用孤儿分支：内容为 dev 基线的快照（仅版本号不同），与本仓现状一致。
    const base0 = git(work, ['rev-parse', 'dev'])
    git(work, ['checkout', '-q', '--orphan', 'main'])
    git(work, ['read-tree', '--reset', '-u', base0])
    writeFileSync(
      join(work, 'package.json'),
      `${JSON.stringify({ name: 'dsh-team-bots', version: PREVIOUS_VERSION }, null, 2)}\n`,
    )
    git(work, ['add', '-A'])
    git(work, ['commit', '-q', '-m', `release: v${PREVIOUS_VERSION}（dev 快照 ${base0.slice(0, 7)}）`])
    git(work, ['push', '-q', '-u', 'origin', 'main'])
    git(work, ['checkout', '-q', 'dev'])
  }

  // dev 继续演进：删文件、加一批文件、改文件——让 main↔dev 的树差异足够大。
  git(work, ['rm', '-q', 'legacy-only.txt'])
  for (let i = 0; i < 40; i += 1) {
    writeFileSync(join(work, 'src', `feature-${i}.ts`), `export const v${i} = ${i}\n`)
  }
  writeFileSync(join(work, 'src', 'base.txt'), 'base changed\n')
  git(work, ['add', '-A'])
  git(work, ['commit', '-q', '-m', 'dev advance'])
  git(work, ['push', '-q', '-u', 'origin', 'dev'])

  return { base, work, remote }
}

function runRelease(work, args = []) {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  // 工具进程本身不能带着 DSH_SKIP_VERSION_BUMP：用例要能抓住工具漏传该变量的回归。
  delete env.DSH_SKIP_VERSION_BUMP
  return spawnSync(process.execPath, [join(work, 'scripts', 'release.mjs'), ...args], {
    cwd: work,
    encoding: 'utf8',
    env,
  })
}

type ReleaseStep = { name: string; ok: boolean; error?: string; mode?: string; sameTree?: boolean; dryRun?: boolean }
type ReleaseResult = {
  ok: boolean
  version: string | null
  tag: string | null
  dryRun: boolean
  failedStep: string | null
  error: string | null
  steps: ReleaseStep[]
  summary: Record<string, unknown>
}

function parseResult(run): ReleaseResult | null {
  try {
    return JSON.parse(run.stdout) as ReleaseResult
  } catch {
    return null
  }
}

function remoteSha(work, ref) {
  const line = git(work, ['ls-remote', 'origin', ref])
  return line.split(/\s+/)[0] ?? ''
}

function setup(t, options: { mainMode?: string; notes?: 'missing' | 'wrong-version' } = {}) {
  try {
    return makeRepo(options)
  } catch (error) {
    if (isEnvironmentError(error)) {
      t.skip(`环境受限（EPERM/EACCES）：${String((error as Error)?.message ?? error)}`)
      return null
    }
    throw error
  }
}

test('正常路径：孤儿 main 落 dev 树快照，五步全绿且包内版本不被 bump', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    const run = runRelease(work)
    const result = parseResult(run)
    assert.equal(run.status, 0, run.stderr)
    assert.ok(result, 'stdout 应输出结构化 JSON')
    assert.equal(result.ok, true)
    assert.deepEqual(
      result.steps.map(step => step.name),
      ['preflight', 'push-dev', 'merge-main', 'push-main', 'push-tag', 'sync-dev'],
    )
    for (const step of result.steps) assert.equal(step.ok, true, `${step.name}: ${step.error ?? ''}`)
    assert.equal(result.version, VERSION)
    assert.equal(result.tag, `v${VERSION}`)

    const mergeStep = result.steps.find(step => step.name === 'merge-main')
    assert.equal(mergeStep.mode, 'snapshot', '孤儿 main 应走树快照模式')

    // 快照换树无冲突：发布后 main 的树与 dev 的树完全一致。
    const devTree = git(work, ['rev-parse', 'dev^{tree}'])
    assert.equal(git(work, ['rev-parse', 'origin/main^{tree}']), devTree, '远端 main 的树应等于 dev 的树')
    assert.equal(git(work, ['rev-parse', 'main^{tree}']), devTree)

    // dev 新增的文件进了发布树，dev 已删的文件从发布树消失。
    assert.match(git(work, ['ls-tree', '--name-only', 'origin/main', 'src/']), /feature-39\.ts/)
    assert.equal(git(work, ['ls-tree', '--name-only', 'origin/main', 'legacy-only.txt']), '')

    // 版本号不被 bump 钩子改动：tag 名必须与被发布包的 version 一致。
    const released = JSON.parse(git(work, ['show', 'origin/main:package.json']))
    assert.equal(released.version, VERSION)

    // tag 锚定合并后 main 的 HEAD，且已推上远端。
    const mainSha = remoteSha(work, 'refs/heads/main')
    assert.equal(remoteSha(work, `refs/tags/v${VERSION}`), mainSha)
    assert.match(git(work, ['log', '-1', '--format=%s', 'origin/main']), /^release: v0\.2\.338/)
    // 发布提交标题取 release-notes.md 的变更摘要：不含占位信息，摘要来自中文段条目粗体小标题。
    const subject = git(work, ['log', '-1', '--format=%s', 'origin/main'])
    assert.match(subject, /第一项变更、第二项变更/)
    assert.doesNotMatch(subject, /dev 快照/)
    assert.doesNotMatch(subject, /dev-snapshot/)
    const body = git(work, ['log', '-1', '--format=%B', 'origin/main'])
    assert.match(body, /^dev-snapshot: [0-9a-f]{40}$/m, '正文 trailer 应带 dev 快照 sha')
    // 英文段不参与摘要。
    assert.doesNotMatch(subject, /First change/)

    // 收尾回到 dev，且 dev 与 main 内容同步。
    assert.equal(git(work, ['symbolic-ref', '--short', 'HEAD']), 'dev')
    assert.equal(result.steps.find(step => step.name === 'sync-dev').sameTree, true)
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('工作树不干净：拒绝发版，远端零改动', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    writeFileSync(join(work, 'dirty.txt'), 'uncommitted\n')
    const headsBefore = git(work, ['ls-remote', '--heads', 'origin'])
    const run = runRelease(work)
    const result = parseResult(run)
    assert.notEqual(run.status, 0, '脏工作树应拒绝发版')
    assert.equal(result.ok, false)
    assert.equal(result.failedStep, 'preflight')
    assert.match(result.error, /工作树不干净/)
    assert.equal(git(work, ['ls-remote', '--heads', 'origin']), headsBefore, '远端分支不应变化')
    assert.equal(git(work, ['ls-remote', '--tags', 'origin']).trim(), '', '远端不应出现 tag')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('tag 已存在：拒绝重复打标，main 不被推进', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    git(work, ['tag', `v${VERSION}`])
    git(work, ['push', '-q', 'origin', `refs/tags/v${VERSION}`])
    const headsBefore = git(work, ['ls-remote', '--heads', 'origin'])
    const run = runRelease(work)
    const result = parseResult(run)
    assert.notEqual(run.status, 0, 'tag 已存在应拒绝发版')
    assert.equal(result.ok, false)
    assert.equal(result.failedStep, 'preflight')
    assert.match(result.error, /tag/)
    assert.equal(git(work, ['ls-remote', '--heads', 'origin']), headsBefore, '远端分支不应变化')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('main 有分叉（非快照）：拒绝强行合并，退出后回到 dev', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    // main 上多一个与 dev 无关的提交：不再是 dev 的快照，必须拒绝。
    git(work, ['checkout', '-q', 'main'])
    writeFileSync(join(work, 'rogue.txt'), 'main only\n')
    git(work, ['add', '-A'])
    git(work, ['commit', '-q', '-m', 'rogue commit on main'])
    git(work, ['push', '-q', 'origin', 'main'])
    git(work, ['checkout', '-q', 'dev'])
    const mainBefore = remoteSha(work, 'refs/heads/main')

    const run = runRelease(work)
    const result = parseResult(run)
    assert.notEqual(run.status, 0, 'main 分叉时应拒绝发版')
    assert.equal(result.ok, false)
    assert.equal(result.failedStep, 'merge-main')
    assert.match(result.error, /快照|分叉/)
    assert.equal(remoteSha(work, 'refs/heads/main'), mainBefore, 'main 不应被推进')
    assert.equal(git(work, ['ls-remote', '--tags', 'origin']).trim(), '', '远端不应出现 tag')
    assert.equal(git(work, ['symbolic-ref', '--short', 'HEAD']), 'dev', '失败后应回到 dev')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('main 可快进时走 fast-forward：合并后 main == dev 且不新增提交', (t) => {
  const repo = setup(t, { mainMode: 'ancestor' })
  if (!repo) return
  const { work } = repo
  try {
    const run = runRelease(work)
    const result = parseResult(run)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(result.ok, true)
    const mergeStep = result.steps.find(step => step.name === 'merge-main')
    assert.equal(mergeStep.mode, 'fast-forward')
    const devSha = git(work, ['rev-parse', 'dev'])
    assert.equal(git(work, ['rev-parse', 'main']), devSha, '快进后 main 应等于 dev')
    assert.equal(remoteSha(work, 'refs/heads/main'), devSha)
    assert.equal(remoteSha(work, `refs/tags/v${VERSION}`), devSha)
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('缺 docs/release-notes.md：拒绝发版，远端零改动', (t) => {
  const repo = setup(t, { notes: 'missing' })
  if (!repo) return
  const { work } = repo
  try {
    const headsBefore = git(work, ['ls-remote', '--heads', 'origin'])
    const run = runRelease(work)
    const result = parseResult(run)
    assert.notEqual(run.status, 0, '缺发版说明应拒绝发版')
    assert.equal(result.ok, false)
    assert.equal(result.failedStep, 'preflight')
    assert.match(result.error, /release-notes\.md/)
    assert.equal(git(work, ['ls-remote', '--heads', 'origin']), headsBefore, '远端分支不应变化')
    assert.equal(git(work, ['ls-remote', '--tags', 'origin']).trim(), '', '远端不应出现 tag')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('release-notes.md 缺对应版本小节：拒绝发版，远端零改动', (t) => {
  const repo = setup(t, { notes: 'wrong-version' })
  if (!repo) return
  const { work } = repo
  try {
    const headsBefore = git(work, ['ls-remote', '--heads', 'origin'])
    const run = runRelease(work)
    const result = parseResult(run)
    assert.notEqual(run.status, 0, '缺对应版本小节应拒绝发版')
    assert.equal(result.ok, false)
    assert.equal(result.failedStep, 'preflight')
    assert.match(result.error, /v0\.2\.338/)
    assert.equal(git(work, ['ls-remote', '--heads', 'origin']), headsBefore, '远端分支不应变化')
    assert.equal(git(work, ['ls-remote', '--tags', 'origin']).trim(), '', '远端不应出现 tag')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('main 提交信息为新格式（dev-snapshot trailer）：快照基点仍能识别（格式兼容回归，非 trailer 解析承重）', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    // 把 main 的发版提交改成新格式：标题带摘要、正文带 dev-snapshot trailer。
    const base = git(work, ['rev-parse', 'main'])
    git(work, ['checkout', '-q', 'main'])
    git(work, ['commit', '--amend', '-q', '-m', 'release: v0.2.337 摘要标题', '-m', `dev-snapshot: ${base}`])
    git(work, ['push', '-q', '--force', 'origin', 'main'])
    git(work, ['checkout', '-q', 'dev'])

    const run = runRelease(work)
    const result = parseResult(run)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(result.ok, true)
    const mergeStep = result.steps.find(step => step.name === 'merge-main')
    assert.equal(mergeStep.mode, 'snapshot', '新格式提交信息下仍应识别出快照基点')
    assert.equal(mergeStep.baseMatch, 'version-only')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('dry-run：只做校验不动仓库，远端与本地零改动', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    const headsBefore = git(work, ['ls-remote', '--heads', 'origin'])
    const mainBefore = git(work, ['rev-parse', 'main'])
    const run = runRelease(work, ['--dry-run'])
    const result = parseResult(run)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(result.summary.mergeMode, 'snapshot', 'dry-run 应给出落点方式')
    assert.equal(git(work, ['ls-remote', '--heads', 'origin']), headsBefore, 'dry-run 不应推送')
    assert.equal(git(work, ['ls-remote', '--tags', 'origin']).trim(), '', 'dry-run 不应打 tag')
    assert.equal(git(work, ['rev-parse', 'main']), mainBefore, 'dry-run 不应改动 main')
    assert.equal(git(work, ['symbolic-ref', '--short', 'HEAD']), 'dev')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})
