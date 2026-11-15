#!/usr/bin/env node
// DSHBOTS-260：发版流水线工具化——一次调用完成整个发版流程，替代手工敲 git 命令序列。
//
// 固定五步（owner 指定顺序）：
//   ① push dev            —— 推当前工作分支 dev
//   ② dev → main          —— 把 dev 落到 main：可快进则 fast-forward，否则按本仓惯例做「树快照」
//                             （main 是发版专用孤儿分支，历史发版均为 dev 树快照提交）。
//                             main 与 dev 已分叉 / main 被改写时如实报错退出，绝不做策略合并。
//   ③ push main + push tag—— tag 名 = package.json version 加 v 前缀，锚定合并后 main 的 HEAD
//   ④ 回 dev 与 main 同步 —— 收尾切回 dev，并校验 dev 的内容不落后于刚发的 main
//   ⑤ 输出结构化结果      —— 每步 ok/fail + 关键输出（commit、tag、远端返回）
//
// 守门：任一步失败立即中止（退出码 1），JSON 里回显已完成步骤，便于人工接管；
//      工作树不干净、tag 已存在、main 与 dev 分叉等情形一律拒绝发版，不做隐式修复。
// 版本口径：tag 名必须与被发布包里的 version 一致，因此 main 上的发布快照提交不触发
//      pre-commit 的版本 bump（DSH_SKIP_VERSION_BUMP=1），tag 取 dev 当前 package.json 的 version。
// 用法：node scripts/release.mjs [--dry-run] [--remote <name>]
// 输出：stdout 为结构化 JSON（可直接给脚本消费）；stderr 为过程日志。
// 零依赖：只用 node:child_process / node:fs / node:path / node:url。
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根目录由脚本自身位置推导：脚本落在仓库的 scripts/ 下，根就是它的上级目录。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const REMOTE = readOption('--remote') ?? 'origin'
// 快照匹配时扫描 dev 历史的提交上限：避免极端仓库下扫描无界。
const SNAPSHOT_SCAN_LIMIT = 800

function readOption(name) {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

class ReleaseError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ReleaseError'
    this.detail = detail
  }
}

const steps = []
let failedStep = null

function log(message) {
  process.stderr.write(`[release] ${message}\n`)
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    // 非交互：凭据缺失时直接失败，不挂在终端上等输入。
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env ?? {}) },
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    code: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error ? result.error.message : undefined,
  }
}

function describe(result) {
  const text = `${result.stderr || ''}${result.stdout || ''}`.trim()
  if (!text) return result.spawnError || `退出码 ${result.code}`
  return text.length > 2000 ? `…${text.slice(-2000)}` : text
}

function gitText(args, options = {}) {
  const result = git(args, options)
  if (result.code !== 0) throw new ReleaseError(`git ${args.join(' ')} 失败：${describe(result)}`, result)
  return result.stdout.trim()
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

function lsRemote(kind) {
  const result = git(['ls-remote', kind, REMOTE])
  if (result.code !== 0) {
    throw new ReleaseError(`读取远端${kind === '--heads' ? '分支' : 'tag'}失败：${describe(result)}`, result)
  }
  const entries = {}
  for (const line of result.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (!sha || !ref) continue
    entries[ref.replace(/^refs\/(heads|tags)\//, '').replace(/\^\{\}$/, '')] = sha
  }
  return entries
}

function readVersion() {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  } catch (error) {
    throw new ReleaseError(`读取 package.json 失败：${error.message}`)
  }
  const version = String(manifest.version ?? '')
  if (!/^\d+\.\d+\.\d+([-+].*)?$/.test(version)) {
    throw new ReleaseError(`package.json 的 version 不是 x.y.z 形式：${version}`)
  }
  return version
}

// 发布提交信息：标题取本次发布的变更摘要（来自 docs/release-notes.md 的对应版本小节），
// 机器可读的 dev 快照 sha 放正文 trailer——基点识别优先读该 trailer。
function buildCommitMessage(version, devCommit, summary) {
  return `release: v${version} ${summary}\n\ndev-snapshot: ${devCommit}`
}

// 从提交信息里取 dev 快照 sha：优先读 trailer 里的 dev-snapshot，
// 没有 trailer 的历史提交（老格式「（dev 快照 <sha>）」）退回宽松正则。
function snapshotHintFrom(message) {
  const trailer = /^dev-snapshot:\s*([0-9a-f]{7,40})$/im.exec(message)
  if (trailer) return trailer[1]
  const legacy = /([0-9a-f]{7,40})/i.exec(message)
  return legacy ? legacy[1] : null
}

function treeOf(ref) {
  return gitText(['rev-parse', `${ref}^{tree}`])
}

// ── 发布摘要：取 dev 树里 docs/release-notes.md 的「## v<version>」小节 ──────────
// 发布提交的信息必须反映本版实际变更，不允许占位文案。摘要取中文段里各条目的粗体小标题，
// 没有条目时退回中文段首句；缺失说明文件或该版本小节即拒绝发版。
const RELEASE_NOTES_PATH = 'docs/release-notes.md'
const SUMMARY_MAX = 60

function truncate(text, max = SUMMARY_MAX) {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

// 取「## v<version>」到下一个「## 」之间的正文。
function sectionOf(markdown, version) {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => line.trim() === `## v${version}`)
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^##\s/.test(line))
  return end < 0 ? rest : rest.slice(0, end)
}

// 取小节里的中文段（「### 中文」到「### English」之间）。
function chinesePart(section) {
  const start = section.findIndex(line => line.trim() === '### 中文')
  if (start < 0) return []
  const rest = section.slice(start + 1)
  const end = rest.findIndex(line => /^###\s/.test(line))
  return end < 0 ? rest : rest.slice(0, end)
}

function readReleaseSummary(devRef, version) {
  const shown = git(['show', `${devRef}:${RELEASE_NOTES_PATH}`])
  if (shown.code !== 0) {
    throw new ReleaseError(`dev 树里没有 ${RELEASE_NOTES_PATH}，无法生成发布摘要，拒绝发版`)
  }
  const section = sectionOf(shown.stdout, version)
  if (!section) {
    throw new ReleaseError(`${RELEASE_NOTES_PATH} 里没有「## v${version}」小节，无法生成发布摘要，拒绝发版`)
  }
  const chinese = chinesePart(section)
  if (chinese.length === 0) {
    throw new ReleaseError(`${RELEASE_NOTES_PATH} 的「## v${version}」小节缺少中文段，无法生成发布摘要，拒绝发版`)
  }
  const titles = []
  for (const line of chinese) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (!bullet) continue
    const bold = /\*\*(.+?)\*\*/.exec(bullet[1])
    if (bold) titles.push(bold[1].trim())
  }
  if (titles.length > 0) return truncate(titles.join('、'))
  const paragraph = chinese.map(line => line.trim()).find(line => line && !line.startsWith('#'))
  if (!paragraph) {
    throw new ReleaseError(`${RELEASE_NOTES_PATH} 的「## v${version}」中文段没有可用的变更摘要，拒绝发版`)
  }
  return truncate(paragraph.split(/[。！？]/)[0])
}

// package.json 除 version 外是否完全一致：用于判定「同一份包的快照」。
function onlyVersionDiffers(baseRef, otherRef) {
  let left
  let right
  try {
    left = JSON.parse(gitText(['show', `${baseRef}:package.json`]))
    right = JSON.parse(gitText(['show', `${otherRef}:package.json`]))
  } catch {
    return false
  }
  const { version: leftVersion, ...leftRest } = left
  const { version: rightVersion, ...rightRest } = right
  return JSON.stringify(leftRest) === JSON.stringify(rightRest)
}

// 找出 dev 历史上与 main 当前内容对应的那个快照提交：
// 允许 tree 完全一致，或仅 package.json 的 version 不同（历史发版提交会被版本 bump 钩子改过版本号）。
function findSnapshotBase() {
  const mainTree = treeOf('main')
  const history = gitText(['log', '--format=%H %T', 'dev']).split('\n')
  const commits = history.map(line => line.trim().split(/\s+/)).filter(pair => pair[0]).map(([sha, tree]) => ({ sha, tree }))

  for (const { sha, tree } of commits) {
    if (tree === mainTree) return { sha, match: 'exact' }
  }

  // 提交信息里记着上次的 dev 快照（约定：正文 trailer「dev-snapshot: <sha>」，
  // 历史发版提交是标题里的「（dev 快照 <sha>）」），先试它再全量扫描。
  const message = gitText(['log', '-1', '--format=%B', 'main'])
  const candidates = []
  const hinted = snapshotHintFrom(message)
  if (hinted) candidates.push(hinted)
  for (const { sha } of commits) {
    if (candidates.length >= SNAPSHOT_SCAN_LIMIT) break
    if (!candidates.includes(sha)) candidates.push(sha)
  }

  for (const sha of candidates) {
    if (git(['cat-file', '-e', `${sha}^{commit}`]).code !== 0) continue
    const diff = git(['diff', '--name-only', sha, 'main'])
    if (diff.code !== 0) continue
    if (diff.stdout.trim() !== 'package.json') continue
    if (!onlyVersionDiffers(sha, 'main')) continue
    return { sha, match: 'version-only' }
  }
  return null
}

// 步骤 0：前置校验——任一条不满足即拒绝发版，不做任何自动修复。
function preflight() {
  const inside = git(['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new ReleaseError('当前目录不是 git 仓库，拒绝发版')
  }

  const dirty = gitText(['status', '--porcelain'])
  if (dirty) {
    throw new ReleaseError(`工作树不干净，拒绝发版。待处理：\n${dirty}`)
  }

  const branch = gitText(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (branch !== 'dev') {
    throw new ReleaseError(`当前分支为 ${branch || '(未知)'}，发版必须在 dev 分支执行`)
  }

  for (const name of ['dev', 'main']) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).code !== 0) {
      throw new ReleaseError(`本地缺少分支 ${name}，拒绝发版`)
    }
  }

  if (git(['remote', 'get-url', REMOTE]).code !== 0) {
    throw new ReleaseError(`远端 ${REMOTE} 不存在，拒绝发版`)
  }

  const fetched = git(['fetch', REMOTE])
  if (fetched.code !== 0) {
    throw new ReleaseError(`fetch ${REMOTE} 失败：${describe(fetched)}`, fetched)
  }

  const heads = lsRemote('--heads')
  if (!heads.dev) throw new ReleaseError(`远端 ${REMOTE} 缺少 dev 分支，拒绝发版`)
  if (!heads.main) throw new ReleaseError(`远端 ${REMOTE} 缺少 main 分支，拒绝发版`)

  const localMain = gitText(['rev-parse', 'main'])
  if (localMain !== heads.main) {
    throw new ReleaseError(
      `本地 main（${short(localMain)}）与 ${REMOTE}/main（${short(heads.main)}）不一致：main 落后或已分叉，需人工同步后再发版（不自动策略合并）`,
    )
  }

  // 本地 dev 不得落后于远端 dev，否则推上去的不是最新基线。
  if (git(['merge-base', '--is-ancestor', heads.dev, 'dev']).code !== 0) {
    throw new ReleaseError(`本地 dev 落后于 ${REMOTE}/dev，请先拉取后再发版`)
  }

  const version = readVersion()
  const tag = `v${version}`
  // 发布摘要在 preflight 阶段就取：取不到直接拒绝，不推进任何远端状态。
  const summary = readReleaseSummary('dev', version)

  const localTag = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])
  if (localTag.code === 0) {
    throw new ReleaseError(`本地已存在 tag ${tag}（指向 ${short(localTag.stdout.trim())}），拒绝重复打标`)
  }
  if (lsRemote('--tags')[tag]) {
    throw new ReleaseError(`远端 ${REMOTE} 已存在 tag ${tag}，拒绝重复打标`)
  }

  return {
    branch,
    version,
    tag,
    summary,
    devCommit: short(gitText(['rev-parse', 'dev'])),
    mainCommit: short(localMain),
    remoteDev: short(heads.dev),
    remoteMain: short(heads.main),
  }
}

// 步骤 ①：push dev。
function pushDev() {
  const result = git(['push', REMOTE, 'dev'])
  if (result.code !== 0) throw new ReleaseError(`push ${REMOTE} dev 失败：${describe(result)}`, result)
  const commit = gitText(['rev-parse', 'dev'])
  return {
    branch: 'dev',
    commit: short(commit),
    upToDate: /Everything up-to-date/i.test(describe(result)),
    remoteOutput: describe(result),
  }
}

// 只读判定 dev 落到 main 的方式：fast-forward / 树快照 / 不可落（main 有分叉）。
function detectMergeMode() {
  if (git(['merge-base', '--is-ancestor', 'main', 'dev']).code === 0) {
    return { mode: 'fast-forward' }
  }
  const base = findSnapshotBase()
  if (!base) {
    return {
      mode: null,
      reason: 'main 与 dev 无共同历史，且 main 的内容不是 dev 的历史快照（main 有分叉或被改写），拒绝强行合并；请人工确认 main 状态',
    }
  }
  return { mode: 'snapshot', base }
}

// 步骤 ②：把 dev 落到 main。可快进则 fast-forward；否则要求 main 的内容确实是 dev 的历史快照，
//         再按本仓惯例做一次树快照提交。main 有分叉/被改写时拒绝强行合并。
function landDevOnMain(version, summary) {
  const before = gitText(['rev-parse', 'main'])
  const devCommit = gitText(['rev-parse', 'dev'])
  const detected = detectMergeMode()
  if (!detected.mode) throw new ReleaseError(detected.reason)

  const checkout = git(['checkout', 'main'])
  if (checkout.code !== 0) throw new ReleaseError(`切换到 main 失败：${describe(checkout)}`, checkout)

  if (detected.mode === 'fast-forward') {
    const merge = git(['merge', '--ff-only', 'dev'])
    if (merge.code !== 0) {
      throw new ReleaseError(`main 与 dev 无法 fast-forward 合并，拒绝强行合并：${describe(merge)}`, merge)
    }
    const after = gitText(['rev-parse', 'main'])
    return {
      mode: 'fast-forward',
      from: short(before),
      to: short(after),
      commit: short(after),
      devSnapshot: short(devCommit),
      remoteOutput: describe(merge),
    }
  }

  const base = detected.base
  // 快照提交：把 dev 的树整体落到 main（等价于一次树快照发布提交，不做三方合并）。
  const readTree = git(['read-tree', '--reset', '-u', devCommit])
  if (readTree.code !== 0) {
    throw new ReleaseError(`把 dev 的树快照到 main 失败：${describe(readTree)}`, readTree)
  }

  const staged = git(['diff', '--cached', '--quiet'])
  if (staged.code === 0) {
    const after = gitText(['rev-parse', 'main'])
    return { mode: 'snapshot', from: short(before), to: short(after), commit: short(after), devSnapshot: short(devCommit), baseSnapshot: short(base.sha), unchanged: true }
  }

  const message = buildCommitMessage(version, devCommit, summary)
  // DSH_SKIP_VERSION_BUMP=1：main 上的发布快照不消耗版本号，保证 tag 名与包内 version 一致。
  const commit = git(['commit', '-m', message], { env: { DSH_SKIP_VERSION_BUMP: '1' } })
  if (commit.code !== 0) {
    throw new ReleaseError(`在 main 上创建发布快照提交失败：${describe(commit)}`, commit)
  }
  const after = gitText(['rev-parse', 'main'])
  return {
    mode: 'snapshot',
    from: short(before),
    to: short(after),
    commit: short(after),
    devSnapshot: short(devCommit),
    baseSnapshot: short(base.sha),
    baseMatch: base.match,
    message,
    remoteOutput: describe(commit),
  }
}

// 步骤 ③（上）：push main。
function pushMain() {
  const commit = gitText(['rev-parse', 'main'])
  const result = git(['push', REMOTE, 'main'])
  if (result.code !== 0) throw new ReleaseError(`push ${REMOTE} main 失败：${describe(result)}`, result)
  return { branch: 'main', commit: short(commit), remoteOutput: describe(result) }
}

// 步骤 ③（下）：push tag，锚定合并后 main 的 HEAD。
function pushTag(tag) {
  const target = gitText(['rev-parse', 'main'])
  const created = git(['tag', tag, target])
  if (created.code !== 0) throw new ReleaseError(`创建 tag ${tag} 失败：${describe(created)}`, created)
  const pushed = git(['push', REMOTE, `refs/tags/${tag}`])
  if (pushed.code !== 0) {
    throw new ReleaseError(
      `push tag ${tag} 失败：${describe(pushed)}。本地 tag 已创建，续发请手工执行 git push ${REMOTE} ${tag}`,
      pushed,
    )
  }
  return { tag, commit: short(target), remoteOutput: describe(pushed) }
}

// 步骤 ④：回到 dev 并与 main 同步（内容口径：dev 的树必须与 main 一致，或 dev 已包含 main 的历史）。
function syncDev() {
  const checkout = git(['checkout', 'dev'])
  if (checkout.code !== 0) throw new ReleaseError(`切回 dev 失败：${describe(checkout)}`, checkout)

  const sameTree = treeOf('dev') === treeOf('main')
  const containsMain = git(['merge-base', '--is-ancestor', 'main', 'dev']).code === 0
  if (!sameTree && !containsMain) {
    throw new ReleaseError('dev 与 main 内容不一致（dev 落后于刚发的 main），同步失败')
  }

  const localDev = gitText(['rev-parse', 'dev'])
  const heads = lsRemote('--heads')
  let repushed = false
  if (heads.dev && heads.dev !== localDev) {
    const push = git(['push', REMOTE, 'dev'])
    if (push.code !== 0) throw new ReleaseError(`回推 dev 失败：${describe(push)}`, push)
    repushed = true
  }
  return {
    branch: 'dev',
    commit: short(localDev),
    sameTree,
    containsMain,
    aheadMain: gitText(['rev-list', '--count', 'dev..main']),
    repushed,
  }
}

const result = {
  ok: false,
  tool: 'release',
  repo: ROOT,
  remote: REMOTE,
  dryRun: DRY_RUN,
  version: null,
  tag: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  steps,
  failedStep: null,
  error: null,
  restoredBranch: null,
  summary: {},
}

try {
  const pre = runStep('preflight', preflight)
  result.version = pre.version
  result.tag = pre.tag
  result.summary.devCommit = pre.devCommit
  result.summary.releaseSummary = pre.summary
  result.summary.mainCommitBefore = pre.mainCommit

  if (DRY_RUN) {
    // dry-run 仍做只读的落点判定：提前暴露「main 有分叉、无法落 dev」这类硬阻塞。
    const detected = detectMergeMode()
    if (!detected.mode) throw new ReleaseError(detected.reason)
    const plan = [
      ['push-dev', `git push ${REMOTE} dev`],
      ['merge-main', detected.mode === 'fast-forward' ? 'dev → main：fast-forward 合并' : `dev → main：树快照提交（基点 ${short(detected.base.sha)}，匹配 ${detected.base.match}）`],
      ['push-main', `git push ${REMOTE} main`],
      ['push-tag', `git tag ${pre.tag} <main HEAD> && git push ${REMOTE} refs/tags/${pre.tag}`],
      ['sync-dev', 'git checkout dev（校验 dev 内容不落后 main）'],
    ]
    for (const [name, command] of plan) {
      steps.push({ name, ok: true, dryRun: true, plan: command })
      log(`dry-run：${command}`)
    }
    result.summary.mergeMode = detected.mode
  } else {
    runStep('push-dev', pushDev)
    const landed = runStep('merge-main', () => landDevOnMain(pre.version, pre.summary))
    result.summary.mergeMode = landed.mode
    result.summary.mainCommit = landed.commit
    runStep('push-main', pushMain)
    runStep('push-tag', () => pushTag(pre.tag))
    runStep('sync-dev', syncDev)
  }

  result.ok = true
  log(`发版完成：${pre.tag} 已推送到 ${REMOTE}（main 与 dev 已同步）`)
} catch (error) {
  result.ok = false
  result.failedStep = failedStep
  result.error = error.message
  // 失败后尽力切回 dev：把工作区交回人工接管，不把仓库停在 main 上。
  const restore = git(['checkout', 'dev'])
  result.restoredBranch = restore.code === 0
  const done = steps.filter(step => step.ok).map(step => step.name)
  log(`发版失败（步骤 ${failedStep ?? '未知'}）：${error.message}`)
  log(`已完成步骤：${done.length ? done.join(', ') : '（无）'}`)
}

result.finishedAt = new Date().toISOString()
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(result.ok ? 0 : 1)
