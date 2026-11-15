// tests/doctor-exit.test.ts —— A5/DSHBOTS-329：doctor 退出码分级守门（源码级）。
// 0=ok、1=目录/权限（环境可修复）、2=host refs（人工配置）、3=两类并存。
// 巡检 prompt 文档不入库（docs 不进 git 树拍板口径，本机留存）：守门不断言树外文件，
// 保持 CI fresh clone 密闭——27fa5d8 的循环依赖（文档因测试在场、测试因文档红）就此解开。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractHostRefs } from '../scripts/doctor.mjs'

// 读 .mts 源（RULES：.js/.mjs 是构建产物不手改，守门钉源文件）。
const doctorSource = readFileSync(fileURLToPath(new URL('../scripts/doctor.mts', import.meta.url)), 'utf8')

test('doctor 退出码四态分级表达式在场，语义注释完整', () => {
  assert.match(doctorSource, /退出码分级（A5\/DSHBOTS-329/, '分级语义注释在场')
  assert.match(doctorSource, /pathProblems > 0 && refProblems > 0 \? 3 : refProblems > 0 \? 2 : 1/, '退出码表达式：两类并存取 3、单类各取对应码')
  assert.match(doctorSource, /process\.exit\(problems === 0 \? 0 /, '全绿退出 0')
  assert.match(doctorSource, /refProblems \+= 1/, 'host refs 缺失计入独立类')
  assert.match(doctorSource, /pathProblems \+= 1/, '目录/权限问题计入独立类')
})

test('extractHostRefs 行为不回归（医生既有导出继续可用）', () => {
  assert.deepEqual(extractHostRefs('# c\n- /opt/a/bin\n'), ['/opt/a/bin'])
})
