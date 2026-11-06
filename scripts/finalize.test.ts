// DSHBOTS-273：通用交付收口工具 finalize.mjs 守门——用临时 git 仓库端到端演练固定收口步骤。
//
// 覆盖：
//   ①正常路径：分批 commit 逐笔落盘（提交信息带项目卡号，每批文件各自成笔）+ push 成功
//   ②工作树不干净：preflight 拒绝，文案带原因与替代命令（D-269 口径），远端零变化
//   ③分支不对：preflight 拒绝（非 dev 分支）
//   ④测试红即中止：AssertionError>0 时在 test 步中止，不产生任何提交
//   ⑤测试假红（EPERM 且无断言失败）：按环境性假红处理，不算交付失败
//   ⑥push 幂等拒绝：远端已含本地 HEAD 时拒绝空推送
//   ⑦重复收口被拒：清单文件已提交时在 commit 步拒绝（防收口卡连开）
//
// 临时目录：优先用仓库内 .tmp（项目惯例）；沙箱里 os.tmpdir() 可能 EPERM，此时回退仓库内 .tmp。
// EPERM/EACCES 属环境性假红，按 skip 处理并注明原因；守门是否绿以 AssertionError 计数为 0 为准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptSrc = join(repoRoot, 'scripts', 'finalize.mjs')
const bumpSrc = join(repoRoot, 'scripts', 'version-bump.mjs')
const hookSrc = join(repoRoot, '.githooks', 'pre-commit')

const CARD = 'DSHBOTS-273'

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
    return mkdtempSync(join(localRoot, 'finalize-test-'))
  } catch (error) {
    if (!isEnvironmentError(error)) throw error
    return mkdtempSync(join(tmpdir(), 'dsh-finalize-'))
  }
}

// 临时仓库：本地 bare 远端 + 工作仓库（dev 分支）。
// 仓库里装上真实的 .githooks/pre-commit + scripts/version-bump.mjs，验证收口工具与版本 bump 钩子共存：
// 钩子会改 package.json 并追加进同一笔提交（工具需如实记录为 extraFiles）。
function makeRepo(options: { redTest?: boolean; epermTest?: boolean; wordyGreenTest?: boolean } = {}) {
  const base = makeTempDir()
  const remote = join(base, 'remote.git')
  const work = join(base, 'work')
  mkdirSync(remote)
  mkdirSync(join(work, 'scripts'), { recursive: true })
  mkdirSync(join(work, '.githooks'), { recursive: true })
  mkdirSync(join(work, 'tests'), { recursive: true })
  mkdirSync(join(work, 'node_modules', '.bin'), { recursive: true })
  copyFileSync(scriptSrc, join(work, 'scripts', 'finalize.mjs'))
  copyFileSync(bumpSrc, join(work, 'scripts', 'version-bump.mjs'))
  copyFileSync(hookSrc, join(work, '.githooks', 'pre-commit'))
  chmodSync(join(work, '.githooks', 'pre-commit'), 0o755)
  // post-commit 自动推送钩子：只在存在标记文件 .git/auto-push 时生效（标记在 .git 里，不污染工作树）。
  writeFileSync(
    join(work, '.githooks', 'post-commit'),
    '#!/bin/sh\n[ -f "$(git rev-parse --git-dir)/auto-push" ] || exit 0\nexec git push -q origin HEAD:refs/heads/dev\n',
  )
  chmodSync(join(work, '.githooks', 'post-commit'), 0o755)
  // 类型检查替身：固定可用的 tsc 入口，避免测试依赖网络或全局 tsc。
  writeFileSync(join(work, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(work, 'node_modules', '.bin', 'tsc'), 0o755)
  writeFileSync(join(work, '.gitignore'), 'node_modules\n')
  writeFileSync(join(work, 'build.mjs'), 'console.log("build ok")\n')
  // 测试脚本：默认跑 node --test tests/（绿色）；可切换成红色断言或 EPERM 假红。
  const testScript = options.epermTest
    ? 'node eperm.mjs'
    : options.redTest
      ? 'node --test tests/'
      : 'node --test tests/'
  writeFileSync(
    join(work, 'package.json'),
    `${JSON.stringify(
      {
        name: 'finalize-fixture',
        version: '0.2.350',
        type: 'module',
        scripts: { build: 'node build.mjs', test: testScript },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(work, 'tests', 'green.test.js'), "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\ntest('green', () => { assert.equal(1, 1) })\n")
  if (options.redTest) {
    writeFileSync(
      join(work, 'tests', 'red.test.js'),
      "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\ntest('red', () => { assert.equal(1, 2) })\n",
    )
  }
  // 用例名里出现 "AssertionError" 字样的绿色用例：守门不能把它误判成红。
  if (options.wordyGreenTest) {
    writeFileSync(
      join(work, 'tests', 'wordy.test.js'),
      "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\n"
      + "test('AssertionError 计数口径：全绿仍算绿', () => { assert.equal(1, 1) })\n",
    )
  }
  if (options.epermTest) {
    writeFileSync(join(work, 'eperm.mjs'), "console.error('EPERM: operation not permitted, open \'tsc\'\n')\nprocess.exit(1)\n")
  }

  git(remote, ['init', '-q', '--bare'])
  git(work, ['init', '-q', '-b', 'dev'])
  git(work, ['config', 'user.email', 'test@example.com'])
  git(work, ['config', 'user.name', 'test'])
  git(work, ['config', 'commit.gpgsign', 'false'])
  git(work, ['config', 'core.hooksPath', '.githooks'])
  git(work, ['add', '-A'])
  git(work, ['commit', '-q', '-m', 'init'])
  git(work, ['remote', 'add', 'origin', remote])
  git(work, ['push', '-q', '-u', 'origin', 'dev'])

  return { base, work, remote }
}

function runFinalize(work, args = []) {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.DSH_SKIP_VERSION_BUMP
  return spawnSync(process.execPath, [join(work, 'scripts', 'finalize.mjs'), ...args], {
    cwd: work,
    encoding: 'utf8',
    env,
  })
}

type FinalizeStep = { name: string; ok: boolean; error?: string }
type FinalizeResult = {
  ok: boolean
  card: string | null
  failedStep: string | null
  error: string | null
  steps: FinalizeStep[]
  summary: {
    commits?: { batch: number; files: string[]; commit?: string; message?: string; extraFiles?: string[]; skipped?: boolean }[]
    commitCount?: number
    pushed?: { branch: string; commit: string; created?: boolean } | null
    buildRemote?: { skipped?: boolean; reason?: string } | null
  }
}

function parseResult(run): FinalizeResult | null {
  try {
    return JSON.parse(run.stdout) as FinalizeResult
  } catch {
    return null
  }
}

function remoteSha(work, ref) {
  const line = git(work, ['ls-remote', 'origin', ref])
  return line.split(/\s+/)[0] ?? ''
}

function setup(t, options: { redTest?: boolean; epermTest?: boolean; wordyGreenTest?: boolean } = {}) {
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

test('正常路径：分批 commit 逐笔落盘（信息带卡号）并 push 到远端', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    writeFileSync(join(work, 'a.txt'), 'a\n')
    writeFileSync(join(work, 'b.txt'), 'b\n')
    writeFileSync(join(work, 'c.txt'), 'c\n')
    const run = runFinalize(work, [
      '--files',
      'a.txt,b.txt;c.txt',
      '--message',
      'feat(fixture): 交付样例',
      '--card',
      CARD,
      '--push',
    ])
    const result = parseResult(run)
    assert.ok(result, 'stdout 应输出结构化 JSON')
    assert.equal(run.status, 0, run.stderr)
    assert.equal(result.ok, true)
    assert.equal(result.card, CARD)
    assert.deepEqual(
      result.steps.map(step => step.name),
      ['preflight', 'build', 'typecheck', 'test', 'commit', 'push'],
    )
    for (const step of result.steps) assert.equal(step.ok, true, `${step.name}: ${step.error ?? ''}`)

    // 分批 commit：两笔提交，每笔只含自己那批文件，提交信息都带项目卡号。
    const commits = result.summary.commits ?? []
    assert.equal(commits.length, 2)
    assert.deepEqual(commits[0].files, ['a.txt', 'b.txt'])
    assert.deepEqual(commits[1].files, ['c.txt'])
    assert.match(commits[0].message ?? '', new RegExp(CARD))
    assert.match(commits[1].message ?? '', new RegExp(CARD))
    assert.match(commits[1].message ?? '', /批次 2\/2/)

    const subjects = git(work, ['log', '-2', '--format=%s']).split('\n')
    assert.equal(subjects.length, 2)
    for (const subject of subjects) assert.match(subject, new RegExp(CARD))
    const firstBatch = git(work, ['show', '--name-only', '--format=', 'HEAD~1']).split('\n').filter(Boolean)
    const secondBatch = git(work, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean)
    assert.ok(firstBatch.includes('a.txt') && firstBatch.includes('b.txt'), `第一批应含 a.txt/b.txt：${firstBatch.join(',')}`)
    assert.ok(!firstBatch.includes('c.txt'), `第一批不应含 c.txt：${firstBatch.join(',')}`)
    assert.ok(secondBatch.includes('c.txt'), `第二批应含 c.txt：${secondBatch.join(',')}`)
    // 逐笔落盘校验：工作树里这些文件都已进 HEAD。
    for (const file of ['a.txt', 'b.txt', 'c.txt']) {
      assert.ok(git(work, ['ls-tree', '--name-only', 'HEAD', file]).includes(file), `${file} 应已落入 HEAD`)
    }
    // 与版本 bump 钩子共存：package.json 被钩子追加进提交，工具需如实记录 extraFiles。
    assert.ok((commits[0].extraFiles ?? []).includes('package.json'), '钩子追加的 package.json 应记录在 extraFiles')
    const bumped = JSON.parse(git(work, ['show', 'HEAD:package.json']))
    assert.notEqual(bumped.version, '0.2.350', '版本应被钩子 bump')

    // push：远端 dev 与本地 HEAD 一致。
    assert.equal(result.summary.pushed?.branch, 'dev')
    assert.equal(remoteSha(work, 'refs/heads/dev'), git(work, ['rev-parse', 'HEAD']))
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('工作树不干净：preflight 拒绝并给出替代命令，远端零变化', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    writeFileSync(join(work, 'a.txt'), 'a\n')
    writeFileSync(join(work, 'stray.txt'), 'not declared\n')
    // 已入库文件的改动排在 porcelain 列表首位：路径必须原样出现在拒绝文案里（不被截首字符）。
    writeFileSync(join(work, 'build.mjs'), 'console.log("build changed")\n')
    const headsBefore = git(work, ['ls-remote', '--heads', 'origin'])
    const run = runFinalize(work, ['--files', 'a.txt', '--message', `feat(fixture): 交付（${CARD}）`, '--push'])
    const result = parseResult(run)
    assert.notEqual(run.status, 0, '脏工作树应拒绝收口')
    assert.equal(result.ok, false)
    assert.equal(result.failedStep, 'preflight')
    assert.match(result.error, /工作树不干净/)
    assert.match(result.error, /build\.mjs/, '拒绝文案应原样给出路径')
    assert.match(result.error, /stray\.txt/)
    assert.match(result.error, /git restore/, '拒绝文案应带替代命令（D-269 口径）')
    assert.equal(git(work, ['ls-remote', '--heads', 'origin']), headsBefore, '远端分支不应变化')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('分支不对：preflight 拒绝（收口只在 dev 分支执行）', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    git(work, ['checkout', '-q', '-b', 'feature/closeout'])
    writeFileSync(join(work, 'a.txt'), 'a\n')
    const run = runFinalize(work, ['--files', 'a.txt', '--message', `feat(fixture): 交付（${CARD}）`, '--push'])
    const result = parseResult(run)
    assert.notEqual(run.status, 0, '非 dev 分支应拒绝收口')
    assert.equal(result.ok, false)
    assert.equal(result.failedStep, 'preflight')
    assert.match(result.error, /分支/)
    assert.match(result.error, /git checkout dev/, '拒绝文案应带替代命令（D-269 口径）')
    assert.equal(git(work, ['symbolic-ref', '--short', 'HEAD']), 'feature/closeout', '失败后不应切分支')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('测试红即中止：AssertionError>0 时在 test 步中止，不产生任何提交', (t) => {
  const repo = setup(t, { redTest: true })
  if (!repo) return
  const { work } = repo
  try {
    writeFileSync(join(work, 'a.txt'), 'a\n')
    const headBefore = git(work, ['rev-parse', 'HEAD'])
    const run = runFinalize(work, ['--files', 'a.txt', '--message', `feat(fixture): 交付（${CARD}）`, '--push'])
    const result = parseResult(run)
    assert.notEqual(run.status, 0, `测试红应拒绝收口：${run.stdout.slice(-2000)}\n${run.stderr.slice(-1000)}`)
    assert.equal(result.ok, false)
    assert.equal(result.failedStep, 'test')
    assert.match(result.error, /AssertionError/)
    assert.equal(git(work, ['rev-parse', 'HEAD']), headBefore, '不应产生新提交')
    assert.equal(git(work, ['status', '--porcelain', '--', 'a.txt']).includes('a.txt'), true, '文件应保持未提交')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('用例名里出现 "AssertionError" 字样的全绿套件：不得误判成红', (t) => {
  const repo = setup(t, { wordyGreenTest: true })
  if (!repo) return
  const { work } = repo
  try {
    writeFileSync(join(work, 'a.txt'), 'a\n')
    const run = runFinalize(work, ['--files', 'a.txt', '--message', `feat(fixture): 交付（${CARD}）`])
    const result = parseResult(run)
    assert.ok(result, 'stdout 应输出结构化 JSON')
    assert.equal(result.ok, true, `全绿套件应判绿：${result.error ?? ''}`)
    const testStep = result.steps.find(step => step.name === 'test')
    assert.ok(testStep, '应有 test 步骤')
    assert.equal(testStep.ok, true)
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('测试假红（EPERM 且无断言失败）：按环境性假红处理，不算交付失败', (t) => {
  const repo = setup(t, { epermTest: true })
  if (!repo) return
  const { work } = repo
  try {
    writeFileSync(join(work, 'a.txt'), 'a\n')
    const run = runFinalize(work, ['--files', 'a.txt', '--message', `feat(fixture): 交付（${CARD}）`])
    const result = parseResult(run)
    assert.ok(result, 'stdout 应输出结构化 JSON')
    assert.equal(result.ok, true, `EPERM 假红不应判失败：${result.error ?? ''}`)
    const testStep = result.steps.find(step => step.name === 'test')
    assert.equal(testStep?.ok, true)
    assert.equal(result.failedStep, null)
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('push 幂等拒绝：远端已含本地 HEAD 时拒绝空推送', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    // post-commit 钩子自动把每笔提交推上远端：收口工具到 push 步时远端已等于本地 HEAD。
    writeFileSync(join(work, '.git', 'auto-push'), 'on\n')
    writeFileSync(join(work, 'a.txt'), 'a\n')
    const run = runFinalize(work, ['--files', 'a.txt', '--message', `feat(fixture): 交付（${CARD}）`, '--push'])
    const result = parseResult(run)
    assert.notEqual(run.status, 0, '空推送应被拒绝')
    assert.equal(result.ok, false)
    assert.equal(result.failedStep, 'push')
    assert.match(result.error, /拒绝空推送|已包含本地 HEAD/)
    assert.equal(remoteSha(work, 'refs/heads/dev'), git(work, ['rev-parse', 'HEAD']), '远端应仍等于本地 HEAD')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('重复收口被拒：清单文件已提交时在 commit 步拒绝（防收口卡连开）', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    writeFileSync(join(work, 'a.txt'), 'a\n')
    const first = runFinalize(work, ['--files', 'a.txt', '--message', `feat(fixture): 交付（${CARD}）`, '--push'])
    const firstResult = parseResult(first)
    assert.equal(first.status, 0, first.stderr)
    assert.equal(firstResult.ok, true)
    const headAfterFirst = git(work, ['rev-parse', 'HEAD'])

    const second = runFinalize(work, ['--files', 'a.txt', '--message', `feat(fixture): 交付（${CARD}）`, '--push'])
    const secondResult = parseResult(second)
    assert.notEqual(second.status, 0, '重复收口应被拒绝')
    assert.equal(secondResult.ok, false)
    assert.equal(secondResult.failedStep, 'commit')
    assert.match(secondResult.error, /没有可提交的改动/)
    assert.equal(git(work, ['rev-parse', 'HEAD']), headAfterFirst, '不应产生新的提交')
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('可选远端构建：无配置时跳过并提示，不算失败', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    writeFileSync(join(work, 'a.txt'), 'a\n')
    const run = runFinalize(work, ['--files', 'a.txt', '--message', `feat(fixture): 交付（${CARD}）`, '--build-remote'])
    const result = parseResult(run)
    assert.ok(result, 'stdout 应输出结构化 JSON')
    assert.equal(result.ok, true, `无远端构建配置时应跳过而非失败：${result.error ?? ''}`)
    const step = result.steps.find(item => item.name === 'build-remote')
    assert.ok(step, '应有 build-remote 步骤')
    assert.equal(step.ok, true)
    assert.equal(result.summary.buildRemote?.skipped, true)
    assert.match(result.summary.buildRemote?.reason ?? '', /跳过/)
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})

test('收口工具随仓库分发：调用方式与参数齐备', (t) => {
  const repo = setup(t)
  if (!repo) return
  const { work } = repo
  try {
    const source = readFileSync(scriptSrc, 'utf8')
    assert.match(source, /--files/, '应支持 --files 清单参数')
    assert.match(source, /--message/, '应支持 --message 提交信息参数')
    assert.match(source, /--push/, '应支持 --push')
    assert.match(source, /--build-remote/, '应支持 --build-remote')
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    assert.equal(typeof pkg.scripts?.finalize, 'string', 'package.json 应提供 finalize 入口')
    assert.equal(pkg.scripts.finalize, 'node scripts/finalize.mjs')
    assert.match(git(work, ['log', '-1', '--format=%s']), /./)
  } finally {
    rmSync(repo.base, { recursive: true, force: true })
  }
})
