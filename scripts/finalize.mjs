#!/usr/bin/env node
// DSHBOTS-273：通用交付收口工具——把「收口」从模型自由行动变成固定步骤的一次调用。
//
// 背景：GS 生产实测发版/交付收口卡连开三次（GS-24/28/29，28 没收干净再开 29），
//       根因是收口全靠模型自由行动，步骤会漏、会重、会半途而废。本工具按固定顺序
//       把收口固化：任何一步不过就中止，不留下半收口状态。
//
// 固定步骤：
//   ① preflight —— 校验分支/工作树/暂存区/卡号/远端；不满足即拒绝（文案 = 原因 + 替代命令，DSHBOTS-269 口径）
//   ② build     —— npm run build
//   ③ typecheck —— tsc --noEmit
//   ④ test      —— npm test；判定口径与 scripts/release.test.ts 同款：AssertionError=0 才算绿
//                  （沙箱 EPERM/EACCES 属环境性假红，不计入红）
//   ⑤ commit    —— 按 --files 清单分批提交（提交信息带项目卡号），逐笔校验落盘
//   ⑥ push      —— 推远端（--push）；空推送按幂等口径拒绝，避免重复收口
//   ⑦ build-remote —— 可选 --build-remote：调用既有远端构建入口（TapTap 项目的
//                  maker_build_current_directory CLI 等价物 = taptap-maker build）；
//                  无此配置则跳过并提示，不算失败
//
// 工作树口径说明：本工具要提交卡面清单里的文件，所以「工作树清洁」= 未声明的改动为零，
//   即脏文件集合与暂存区集合都必须是 --files 清单的子集；清单外的改动一律拒绝
//   （不做 git add -A，避免把别人的改动卷进交付）。
//
// 用法：
//   node scripts/finalize.mjs --files "src/a.ts,src/b.ts;tests/c.test.ts" \
//     --message "feat(x): 交付说明" --card DSHBOTS-273 --push
//   参数：--files <清单>（逗号分隔文件，分号分隔批次） --message <提交信息前缀> --card <项目卡号>
//        --push --build-remote --branch <期望分支，默认 dev> --remote <远端，默认 origin>
//        --skip-version-bump 纯文档/不发版提交不 bump 版本：commit 步骤环境注入
//        DSH_SKIP_VERSION_BUMP=1（与 release.mjs 快照提交同款手法）；未传时注入不在场，行为不变
// 输出：stdout 为结构化 JSON（可直接给脚本消费）；stderr 为过程日志。
// 零依赖：只用 node:child_process / node:fs / node:path / node:url。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根目录由脚本自身位置推导：脚本落在仓库的 scripts/ 下，根就是它的上级目录。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)

// 期望的收口分支：与发版流水线同口径，收口只在长期分支 dev 上做。
const DEFAULT_BRANCH = 'dev'
const DEFAULT_REMOTE = 'origin'
// 项目卡号形态：字母前缀 + 数字序号，例如 DSHBOTS-273。
const CARD_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/

function option(name) {
  const index = argv.indexOf(name)
  if (index >= 0) {
    const value = argv[index + 1]
    return value && !value.startsWith('--') ? value : undefined
  }
  const inline = argv.find(arg => arg.startsWith(`${name}=`))
  return inline ? inline.slice(name.length + 1) : undefined
}

function flag(name) {
  return argv.includes(name)
}

const FILES_RAW = option('--files') ?? ''
const MESSAGE = (option('--message') ?? '').trim()
const CARD_OPTION = (option('--card') ?? '').trim()
const PUSH = flag('--push')
const BUILD_REMOTE = flag('--build-remote')
const SKIP_VERSION_BUMP = flag('--skip-version-bump')
const EXPECTED_BRANCH = (option('--branch') ?? DEFAULT_BRANCH).trim()
const REMOTE = (option('--remote') ?? DEFAULT_REMOTE).trim()

// --files 解析：分号分隔批次，批次内逗号分隔文件。
// 例：--files "a.ts,b.ts;c.ts" → 两批，第一批 [a.ts, b.ts]，第二批 [c.ts]。
function parseBatches(raw) {
  return raw
    .split(';')
    .map(batch => batch.split(',').map(file => file.trim()).filter(Boolean))
    .filter(batch => batch.length > 0)
}

const BATCHES = parseBatches(FILES_RAW)
const DECLARED = [...new Set(BATCHES.flat())]

class FinalizeError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'FinalizeError'
    this.detail = detail
  }
}

const steps = []
let failedStep = null

function log(message) {
  process.stderr.write(`[finalize] ${message}\n`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error ? result.error.message : undefined,
  }
}

function git(args, options = {}) {
  return run('git', args, options)
}

function describe(result) {
  const text = `${result.stderr || ''}${result.stdout || ''}`.trim()
  if (!text) return result.spawnError || `退出码 ${result.code}`
  return text.length > 2000 ? `…${text.slice(-2000)}` : text
}

function gitText(args, options = {}) {
  const result = git(args, options)
  if (result.code !== 0) throw new FinalizeError(`git ${args.join(' ')} 失败：${describe(result)}`, result)
  return result.stdout.trim()
}

// 不做 trim 的 git 输出：git status --porcelain -z 的首条目以「状态位 + 空格」开头，
// trim 会吃掉这个前导空格、把路径首字符削掉（实测出现 "rc/xxx" 这类截断路径）。
function gitRaw(args, options = {}) {
  const result = git(args, options)
  if (result.code !== 0) throw new FinalizeError(`git ${args.join(' ')} 失败：${describe(result)}`, result)
  return result.stdout
}

function short(sha) {
  return String(sha ?? '').slice(0, 7)
}

function runStep(name, fn) {
  const startedAt = Date.now()
  log(`开始：${name}`)
  try {
    const data = fn() ?? {}
    steps.push({ name, ok: true, durationMs: Date.now() - startedAt, ...data })
    log(`完成：${name}`)
    return data
  } catch (error) {
    steps.push({ name, ok: false, durationMs: Date.now() - startedAt, error: error.message })
    failedStep = name
    throw error
  }
}

// git status --porcelain -z 的条目解析：'XY path'，重命名/复制条目后跟一个旧路径条目。
function parsePorcelainZ(raw) {
  const entries = raw.split('\0')
  const paths = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    const status = entry.slice(0, 2)
    paths.push(entry.slice(3))
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return paths.filter(Boolean)
}

function dirtyPaths() {
  return parsePorcelainZ(gitRaw(['status', '--porcelain', '-z', '--untracked-files=all']))
}

// 纯路径列表的解析（git diff --name-only -z / git show --name-only -z）：条目就是路径本身。
function parseNulPaths(raw) {
  return raw.split('\0').map(entry => entry.replace(/^[\r\n]+/, '').trim()).filter(Boolean)
}

function stagedPaths() {
  return parseNulPaths(gitText(['diff', '--cached', '--name-only', '-z']))
}

function currentBranch() {
  return gitText(['symbolic-ref', '--quiet', '--short', 'HEAD'])
}

function isTracked(file) {
  return git(['ls-files', '--error-unmatch', '--', file]).code === 0
}

// 卡号：--card 优先，其次从提交信息里识别；两者都没有即拒绝（提交信息必须带项目卡号）。
function resolveCard() {
  if (CARD_OPTION) return CARD_OPTION
  const matched = /\b([A-Z][A-Z0-9]*-\d+)\b/.exec(MESSAGE)
  return matched ? matched[1] : ''
}

// 提交信息：前缀 + 卡号。前缀里已含卡号时不重复追加。
function composeMessage(card, batchIndex, batchCount) {
  const base = MESSAGE.includes(card) ? MESSAGE : `${MESSAGE}（${card}）`
  return batchCount > 1 ? `${base}（批次 ${batchIndex + 1}/${batchCount}）` : base
}

// 步骤 ①：前置校验。任何一条不满足即拒绝，不做任何隐式修复。
function preflight() {
  const inside = git(['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new FinalizeError('当前目录不是 git 仓库，拒绝收口：请在目标仓库根目录执行 node scripts/finalize.mjs')
  }

  const branch = currentBranch()
  if (branch !== EXPECTED_BRANCH) {
    throw new FinalizeError(
      `当前分支为 ${branch || '(未知)'}，收口必须在 ${EXPECTED_BRANCH} 分支执行：`
      + `请先 git checkout ${EXPECTED_BRANCH} 后重跑，或用 --branch ${EXPECTED_BRANCH} 指定本次收口分支。`,
    )
  }

  const card = resolveCard()
  if (!card) {
    throw new FinalizeError(
      '提交信息缺少项目卡号，拒绝收口：请用 --card <项目卡号>（如 DSHBOTS-273）指定，'
      + '或在 --message 里带上卡号后重跑。',
    )
  }
  if (!CARD_PATTERN.test(card)) {
    throw new FinalizeError(`项目卡号 ${card} 不是「前缀-序号」形态（如 DSHBOTS-273），拒绝收口：请用 --card 传入正确的卡号。`)
  }
  if (!MESSAGE) {
    throw new FinalizeError(
      '缺少提交信息前缀，拒绝收口：请用 --message "feat(x): 交付说明" 传入，'
      + '工具会按「前缀（项目卡号）」组装提交信息。',
    )
  }

  if (!DECLARED.length) {
    throw new FinalizeError(
      '缺少交付文件清单，拒绝收口：请用 --files "a.ts,b.ts" 传入本次要提交的文件，'
      + '工具不做 git add -A，避免把无关改动卷进交付。',
    )
  }

  const missing = DECLARED.filter(file => !existsSync(join(ROOT, file)) && !isTracked(file))
  if (missing.length) {
    throw new FinalizeError(
      `交付文件不存在：${missing.join('、')}；请核对 --files 清单（路径相对仓库根），或先创建/恢复这些文件后重跑。`,
    )
  }

  // 工作树清洁：脏文件与暂存区内容都必须是声明清单的子集。
  const dirty = dirtyPaths()
  const stray = dirty.filter(file => !DECLARED.includes(file))
  if (stray.length) {
    throw new FinalizeError(
      `工作树不干净：存在未声明的改动 ${stray.join('、')}；`
      + '请把它们一并写进 --files 清单，或先 git restore / git add 后单独提交，再重跑收口。',
    )
  }
  const staged = stagedPaths()
  const strayStaged = staged.filter(file => !DECLARED.includes(file))
  if (strayStaged.length) {
    throw new FinalizeError(
      `暂存区有未声明的内容 ${strayStaged.join('、')}；`
      + '请先 git restore --staged <路径> 把它们移出暂存区，避免被本次收口一并提交。',
    )
  }

  if (PUSH && git(['remote', 'get-url', REMOTE]).code !== 0) {
    throw new FinalizeError(
      `远端 ${REMOTE} 不存在，拒绝收口：请先 git remote add ${REMOTE} <url> 后重跑。`,
    )
  }

  return { branch, card, dirty, declared: DECLARED, batches: BATCHES.map(batch => batch.length) }
}

// 步骤 ②：构建。
function build() {
  const result = run('npm', ['run', 'build'])
  if (result.code !== 0) {
    throw new FinalizeError(`npm run build 失败：${describe(result)}`, result)
  }
  return { output: describe(result) }
}

// 步骤 ③：类型检查。tsc 优先用仓库本地安装，缺失时退到全局 npx（--no-install，避免联网拉包）。
function resolveTsc() {
  const local = join(ROOT, 'node_modules', '.bin', 'tsc')
  if (existsSync(local)) return { command: local, args: ['--noEmit'] }
  if (run('npx', ['--no-install', 'tsc', '--version']).code === 0) {
    return { command: 'npx', args: ['--no-install', 'tsc', '--noEmit'] }
  }
  return { command: 'npx', args: ['tsc', '--noEmit'] }
}

function typecheck() {
  const tsc = resolveTsc()
  const result = run(tsc.command, tsc.args)
  if (result.code !== 0) {
    throw new FinalizeError(`tsc --noEmit 失败：${describe(result)}`, result)
  }
  return { command: [tsc.command, ...tsc.args].join(' '), output: describe(result) }
}

// 步骤 ④：测试。判定口径与 scripts/release.test.ts 同款：AssertionError=0 才算绿。
// 沙箱里 EPERM/EACCES 属环境性假红（脚本 skip），不计入红；断言失败才是真红。
//
// 注意：不能拿输出里出现的字面量 "AssertionError" 计数——用例标题/日志里出现这个词
// （例如守门自身的用例名）会让全绿套件被误判成红。改为解析测试运行器的失败统计：
//   · TAP 汇总 "# fail N"、spec 汇总 "ℹ fail N"
//   · 逐行失败标记 "not ok N"（TAP）、"✖ 用例名"（spec）
// 三者取最大值，得到真实失败用例数。
function countTestFailures(output) {
  // 先剥 ANSI 颜色码（TTY 下 node 的 spec 输出会给 "✖"/"ℹ fail" 上色），否则行首匹配不到。
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '')
  // 权威计数：测试运行器的失败汇总（TAP "# fail N" / spec "ℹ fail N"）。
  const counters = []
  for (const match of plain.matchAll(/^\s*#\s*fail\s+(\d+)\s*$/gm)) counters.push(Number(match[1]))
  for (const match of plain.matchAll(/^\s*ℹ\s*fail\s+(\d+)\s*$/gm)) counters.push(Number(match[1]))
  if (counters.length) return Math.max(...counters)
  // 没有汇总行（进程中途崩溃等）：退回逐行失败标记。
  const notOkLines = (plain.match(/^\s*not ok \d+/gm) ?? []).length
  const specFailLines = (plain.match(/^\s*✖\s+/gm) ?? []).length
  return Math.max(0, notOkLines, specFailLines)
}

function test() {
  // node --test 会给子进程打 NODE_TEST_CONTEXT 标记；若收口工具本身跑在测试进程里，
  // 内层 npm test 会被判定为「递归调用」而跳过用例（假绿）。这里清掉标记，保证测试真的跑。
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_TEST_WORKER_ID: undefined }
  const result = run('npm', ['test'], { env })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  const assertionErrors = countTestFailures(output)
  const environmentBlocked = /EPERM|EACCES/.test(output)
  const tail = output.trim().length > 2000 ? `…${output.trim().slice(-2000)}` : output.trim()
  if (assertionErrors > 0) {
    throw new FinalizeError(
      `npm test 失败：AssertionError 计数 ${assertionErrors}（须为 0 才算绿）。测试输出尾部：\n${tail}`,
      result,
    )
  }
  // 退出码非零且没有真实失败用例：EPERM/EACCES 属环境性假红（沙箱限制），不算交付失败；
  // 其余非零退出（进程崩溃、用例异常退出等）一律算红，收口中止。
  if (result.code !== 0 && !environmentBlocked) {
    throw new FinalizeError(
      `npm test 失败：退出码 ${result.code} 且 AssertionError 计数为 0（既非断言失败也非 EPERM/EACCES 环境性假红）。`
      + `测试输出尾部：\n${tail}`,
      result,
    )
  }
  return {
    exitCode: result.code,
    assertionErrors,
    // 退出码非零但没有真实失败用例：按环境性假红处理（如沙箱 EPERM），不算交付失败。
    environmentBlocked: result.code !== 0 && environmentBlocked,
    output: tail,
  }
}

// 步骤 ⑤：分批提交。每批一次提交，逐笔校验落盘（提交内容含该批文件、工作区与 HEAD 一致）。
function commit() {
  const card = resolveCard()
  const commits = []
  BATCHES.forEach((batch, index) => {
    // 待提交判定走 status：已修改/已暂存/未跟踪都算待提交（未跟踪文件不落在 HEAD diff 里）。
    const pending = batch.filter(file => gitText(['status', '--porcelain', '--', file]).length > 0)
    if (!pending.length) {
      commits.push({ batch: index + 1, files: batch, skipped: true, reason: '该批文件无未提交改动' })
      log(`批次 ${index + 1}/${BATCHES.length}：无改动，跳过`)
      return
    }

    const add = git(['add', '--', ...pending])
    if (add.code !== 0) {
      throw new FinalizeError(`批次 ${index + 1} 暂存失败（${pending.join('、')}）：${describe(add)}`, add)
    }

    const message = composeMessage(card, index, BATCHES.length)
    // --skip-version-bump：commit 环境注入 DSH_SKIP_VERSION_BUMP=1，跳过 .githooks/pre-commit
    // 的版本 bump（与 release.mjs 快照提交同款手法）；未传参数时注入不在场，行为不变。
    const commitResult = git(
      ['commit', '-m', message],
      SKIP_VERSION_BUMP ? { env: { DSH_SKIP_VERSION_BUMP: '1' } } : {},
    )
    if (commitResult.code !== 0) {
      throw new FinalizeError(`批次 ${index + 1} 提交失败：${describe(commitResult)}`, commitResult)
    }

    const sha = gitText(['rev-parse', 'HEAD'])
    const committed = parseNulPaths(gitText(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD']))
    const landed = pending.filter(file => committed.includes(file))
    if (landed.length !== pending.length) {
      throw new FinalizeError(
        `批次 ${index + 1} 落盘校验失败：提交 ${short(sha)} 未包含 ${pending.filter(file => !landed.includes(file)).join('、')}；`
        + '请检查 .gitattributes / .gitignore 是否把交付文件排除在提交之外。',
      )
    }
    const unlanded = pending.filter(file => git(['diff', '--quiet', 'HEAD', '--', file]).code !== 0)
    if (unlanded.length) {
      throw new FinalizeError(
        `批次 ${index + 1} 落盘校验失败：${unlanded.join('、')} 与 HEAD 仍有差异；请检查提交是否被钩子改写。`,
      )
    }
    // 钩子可能追加文件（如版本 bump 改的 package.json），如实记录，便于审计。
    const extra = committed.filter(file => !pending.includes(file))
    commits.push({ batch: index + 1, files: pending, commit: short(sha), sha, message, extraFiles: extra })
    log(`批次 ${index + 1}/${BATCHES.length}：已提交 ${short(sha)}（${pending.join('、')}）`)
  })

  const real = commits.filter(entry => !entry.skipped)
  if (!real.length) {
    throw new FinalizeError(
      '没有可提交的改动，拒绝收口：--files 清单里的文件都已提交（收口可能已做过一次）；'
      + '若确需重跑，请核对清单或用 git log -1 查看最近一次提交。',
    )
  }
  return { commits, count: real.length }
}

// 步骤 ⑥：推送。远端已含本地 HEAD 时按幂等口径拒绝空推送。
function push() {
  const local = gitText(['rev-parse', 'HEAD'])
  const branch = currentBranch()
  const remoteRef = `refs/heads/${branch}`
  const lsRemote = git(['ls-remote', '--heads', REMOTE, remoteRef])
  if (lsRemote.code !== 0) {
    throw new FinalizeError(`读取远端 ${REMOTE} 分支失败：${describe(lsRemote)}`, lsRemote)
  }
  const remoteSha = (lsRemote.stdout.trim().split(/\s+/)[0] ?? '')
  if (remoteSha && remoteSha === local) {
    throw new FinalizeError(
      `远端 ${REMOTE}/${branch} 已包含本地 HEAD（${short(local)}），没有待推送内容，拒绝空推送：`
      + '若本次不需要推送，请去掉 --push 重新执行。',
    )
  }
  const args = ['push', REMOTE, `HEAD:${remoteRef}`]
  if (!remoteSha) args.unshift('-u')
  const result = git(args)
  if (result.code !== 0) {
    throw new FinalizeError(`push ${REMOTE} ${branch} 失败：${describe(result)}`, result)
  }
  return {
    branch,
    commit: short(local),
    created: !remoteSha,
    remoteOutput: describe(result),
  }
}

// 步骤 ⑦：远端构建（可选）。
// 配置来源：仓库根 .finalize.json 的 buildRemote（{"command":"...","args":[...]} 或数组）；
// 没有配置时按 TapTap 项目约定探测 .project/project.json + taptap-maker CLI；
// 两者都没有就跳过并提示（不算失败）。
function readBuildRemoteConfig() {
  const configPath = join(ROOT, '.finalize.json')
  if (!existsSync(configPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    const entry = parsed?.buildRemote
    if (!entry) return null
    if (Array.isArray(entry)) {
      const [command, ...args] = entry.map(String)
      return command ? { command, args } : null
    }
    if (typeof entry === 'string') {
      const parts = entry.split(/\s+/).filter(Boolean)
      const [command, ...args] = parts
      return command ? { command, args } : null
    }
    if (typeof entry.command === 'string') {
      return { command: entry.command, args: (entry.args ?? []).map(String) }
    }
    return null
  } catch (error) {
    throw new FinalizeError(`读取 .finalize.json 失败：${error.message}`)
  }
}

function buildRemote() {
  let plan = readBuildRemoteConfig()
  if (!plan && existsSync(join(ROOT, '.project', 'project.json'))) {
    // TapTap Maker 项目：maker_build_current_directory 的 CLI 等价物。
    plan = { command: 'taptap-maker', args: ['build', '--target-dir', ROOT, '--json'] }
  }
  if (!plan) {
    return {
      skipped: true,
      reason: '未配置远端构建入口，已跳过远端构建',
      hint: '如需远端构建：在仓库根写 .finalize.json（{"buildRemote":{"command":"taptap-maker","args":["build","--target-dir","<项目路径>","--json"]}}），或改用 --build-remote 在 TapTap Maker 项目中执行。',
    }
  }
  const result = run(plan.command, plan.args)
  if (result.spawnError && /ENOENT/.test(result.spawnError)) {
    return {
      skipped: true,
      reason: `远端构建命令 ${plan.command} 不存在，已跳过`,
      hint: `请安装 ${plan.command} 或在 .finalize.json 里改成可用的构建入口后重跑。`,
    }
  }
  if (result.code !== 0) {
    throw new FinalizeError(`远端构建失败（${plan.command}）：${describe(result)}`, result)
  }
  return { command: [plan.command, ...plan.args].join(' '), output: describe(result) }
}

const result = {
  ok: false,
  tool: 'finalize',
  repo: ROOT,
  branch: EXPECTED_BRANCH,
  remote: REMOTE,
  card: CARD_OPTION || null,
  push: PUSH,
  buildRemote: BUILD_REMOTE,
  skipVersionBump: SKIP_VERSION_BUMP,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  steps,
  failedStep: null,
  error: null,
  summary: {},
}

try {
  const pre = runStep('preflight', preflight)
  result.card = pre.card
  result.branch = pre.branch

  runStep('build', build)
  runStep('typecheck', typecheck)
  runStep('test', test)

  const committed = runStep('commit', commit)
  result.summary.commits = committed.commits
  result.summary.commitCount = committed.count

  if (PUSH) {
    const pushed = runStep('push', push)
    result.summary.pushed = pushed
  } else {
    result.summary.pushed = null
    log('未指定 --push：跳过推送')
  }

  if (BUILD_REMOTE) {
    const remoteBuild = runStep('build-remote', buildRemote)
    result.summary.buildRemote = remoteBuild
    if (remoteBuild.skipped) log(`远端构建已跳过：${remoteBuild.reason}。${remoteBuild.hint ?? ''}`)
  }

  result.ok = true
  log('收口完成')
} catch (error) {
  result.ok = false
  result.failedStep = failedStep
  result.error = error.message
  const done = steps.filter(step => step.ok).map(step => step.name)
  log(`收口失败（步骤 ${failedStep ?? '未知'}）：${error.message}`)
  log(`已完成步骤：${done.length ? done.join(', ') : '（无）'}`)
}

result.finishedAt = new Date().toISOString()
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(result.ok ? 0 : 1)
