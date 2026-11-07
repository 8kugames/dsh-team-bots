// tests/doctor-exit.test.ts —— A5/DSHBOTS-329：doctor 退出码分级守门（源码级）。
// 0=ok、1=目录/权限（环境可修复）、2=host refs（人工配置）、3=两类并存；巡检 prompt
// 文档在场（docs/patrol-prompt.md，gitignore 不入库但本机随仓走）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { extractHostRefs } from '../scripts/doctor.mjs'

// 读 .mts 源（RULES：.js/.mjs 是构建产物不手改，守门钉源文件）。
const doctorSource = readFileSync(fileURLToPath(new URL('../scripts/doctor.mts', import.meta.url)), 'utf8')
const here = fileURLToPath(new URL('..', import.meta.url))

test('doctor 退出码四态分级表达式在场，语义注释完整', () => {
  assert.match(doctorSource, /退出码分级（A5\/DSHBOTS-329/, '分级语义注释在场')
  assert.match(doctorSource, /pathProblems > 0 && refProblems > 0 \? 3 : refProblems > 0 \? 2 : 1/, '退出码表达式：两类并存取 3、单类各取对应码')
  assert.match(doctorSource, /process\.exit\(problems === 0 \? 0 /, '全绿退出 0')
  assert.match(doctorSource, /refProblems \+= 1/, 'host refs 缺失计入独立类')
  assert.match(doctorSource, /pathProblems \+= 1/, '目录/权限问题计入独立类')
})

test('巡检 prompt 文档在场且覆盖五类核对对象', () => {
  const patrolPath = join(here, 'docs', 'patrol-prompt.md')
  assert.ok(existsSync(patrolPath), 'docs/patrol-prompt.md 应存在')
  const patrol = readFileSync(patrolPath, 'utf8')
  for (const anchor of ['outbox', 'needsYou.stale', 'review_watchdog_observe', 'secrets', 'wechatStatus', 'npm run doctor']) {
    assert.ok(patrol.includes(anchor), `巡检 prompt 应覆盖 ${anchor}`)
  }
})

test('extractHostRefs 行为不回归（医生既有导出继续可用）', () => {
  assert.deepEqual(extractHostRefs('# c\n- /opt/a/bin\n'), ['/opt/a/bin'])
})
