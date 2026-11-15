#!/usr/bin/env node
// 推送前预检：与 .github/workflows/ci.yml 完全同源的两道闸（typecheck + test），
// 外加工作区净树检查——并行会话的在途改动一旦被快照/打包进推送树，就是这次
// CI 事故的根因。任一项失败即非零退出，pre-push 钩子据此拦截推送。
import { execSync } from 'node:child_process'

const root = execSync('git rev-parse --show-toplevel').toString().trim()
const run = (cmd) => {
  try { execSync(cmd, { stdio: 'inherit', cwd: root }) } catch (e) { process.exit(e.status ?? 1) }
}

const dirty = execSync('git status --porcelain').toString().trim()
if (dirty) {
  console.error('[preflight] 工作区不干净，存在未提交改动——推送树可能与验证树不一致：')
  console.error(dirty)
  console.error('先提交、暂存（stash）或移除这些改动，再推送。确认要带脏推送时用 DSH_SKIP_PREFLIGHT=1。')
  process.exit(1)
}

console.log('[preflight] npm run typecheck')
run('npm run typecheck')
console.log('[preflight] npm test')
run('npm test')
console.log('[preflight] 全部通过')
