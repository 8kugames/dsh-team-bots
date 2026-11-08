// tests/after-commit.test.ts —— B7/DSHBOTS-332：afterCommit 副作用纪律守门（源码级扫描）。
// 契约（src/db.ts transaction 注释）：事务回调内只做本库写——宿主副作用（起会话/steer/
// 微信推送/tick/沙箱应用）一律在提交后执行；outbox「先落库后同栈投递」在事务内只发生
// runs/outbox 行写入。本测试用花括号配平扫描全部 transaction 回调体：
// ① 宿主副作用模式零命中；② 事务内 enqueueOutbox 站点必须登记在允许清单（新增站点
// 必须显式核对「回调内只写库」后更新清单）；③ BEGIN IMMEDIATE/ROLLBACK 锚点在场。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const SRC = join(fileURLToPath(new URL('..', import.meta.url)), 'src')
const tsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name)
  if (entry.isDirectory()) return tsFiles(full)
  return entry.name.endsWith('.ts') ? [full] : []
})

// 事务回调体提取：this.store.transaction(() => { ... })，花括号配平（上限 8000 字符兜底）。
function transactionBodies(source) {
  const bodies = []
  const pattern = /this\.store\.transaction\(\s*\(\)\s*=>\s*\{/g
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf('{', match.index + match[0].length - 1)
    let depth = 0
    let end = -1
    for (let i = open; i < Math.min(open + 8000, source.length); i++) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    if (end > 0) bodies.push({ line: source.slice(0, match.index).split('\n').length, body: source.slice(open + 1, end) })
  }
  return bodies
}

// 宿主副作用模式：任何命中即违反 afterCommit 纪律（logger 调用属可观测面，允许）。
const HOST_PATTERNS = [
  /this\.runtime[?.!]*\.\w+\(/,
  /this\.wechat[?.!]*\./,
  /void this\.tick\(\)/,
  /applyFilePolicy\(/,
  /selectModel\(/,
  /sessionController/,
]

test('全部事务回调内零宿主副作用', () => {
  const violations = []
  for (const file of tsFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const { line, body } of transactionBodies(source)) {
      for (const pattern of HOST_PATTERNS) {
        if (pattern.test(body)) {
          violations.push(`${file.replace(SRC, 'src')}:${line} 命中 ${pattern}`)
        }
      }
    }
  }
  assert.deepEqual(violations, [], `事务回调内不得出现宿主副作用：\n${violations.join('\n')}`)
})

test('事务内 enqueueOutbox 站点登记在允许清单（新增站点须显式核对后更新）', () => {
  // 允许清单：站点已逐行核对——回调内只写库（outbox 行 + dispatch 家族的 runs/run_events
  // 行写入，同一 BEGIN IMMEDIATE 内原子），宿主 startRun 由提交后的 tick/领取路径执行。
  const ALLOWED = new Set(['src/services/chat.ts'])
  const sites = []
  for (const file of tsFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const { line, body } of transactionBodies(source)) {
      if (body.includes('enqueueOutbox')) sites.push(file.replace(SRC, 'src'))
    }
  }
  const outside = sites.filter((site) => !ALLOWED.has(site))
  assert.deepEqual(outside, [], `事务内 enqueueOutbox 新站点须核对「回调内只写库」并更新允许清单：\n${outside.join('\n')}`)
})

test('store.transaction 纪律注释与 BEGIN IMMEDIATE/ROLLBACK 锚点在场', () => {
  const dbSource = readFileSync(join(SRC, 'db.ts'), 'utf8')
  assert.match(dbSource, /事务纪律（B7\/DSHBOTS-332）/, 'transaction 方法带纪律注释')
  assert.match(dbSource, /BEGIN IMMEDIATE/, '写事务用 BEGIN IMMEDIATE（并发下排队而非脏读）')
  assert.match(dbSource, /ROLLBACK/, '异常路径回滚')
  const schedulerSource = readFileSync(join(SRC, 'services', 'scheduler.ts'), 'utf8')
  assert.match(schedulerSource, /事务性 outbox：记录先落库，再立即投递/, 'enqueueOutbox 契约注释在场')
})
