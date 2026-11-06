// tests/tool-denial-guidance.test.js —— DSHBOTS-269 工具失败语义引导 + 命令面显式化守门
// 纯源码级断言（不建库、不 mkdtemp），钉两件事：
// ① 命令面显式化：team_review_task 描述首屏声明「验收关单/退回的唯一正规路径」；
//    team_assign_task / team_block_task 描述首行说明用途与总监专属正规性。
// ② 失败语义引导：三类高频拒绝文案各含「原因 + 替代命令/正确下一步」——
//    a) 非 in_review 调 team_review_task（applyReview 状态校验）→ 提示等交付或 team_assign_task 改卡重派；
//    b) 权限不足（ownerContextFor 总监校验）→ 提示由项目 owner 总监 Bot 执行或项目群内请求；
//    c) 同写范围重复派单（assignFromBot 重复检测）→ 提示 team_assign_task 改卡重派而非新开卡。
// 边界：本守门只约束工具调用返回给调用方 bot 的错误文案层；run-finish 四出口的失败终态
// 白名单（D-267，群聊/微信层只透类别+摘要）是另一层，互不影响，此文件不碰。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const toolsSource = read('../src/tools.ts')
const reviewSource = read('../src/services/task-review.ts')
const dispatchSource = read('../src/services/task-dispatch.ts')

// 从 tools.ts 提取指定工具的 description 字符串字面量（含转义还原）。
function toolDescription(name) {
  const at = toolsSource.indexOf(`name: '${name}',`)
  assert.ok(at >= 0, `tools.ts 应注册 ${name}`)
  const descAt = toolsSource.indexOf('description: ', at)
  const open = toolsSource.indexOf("'", descAt)
  let out = ''
  for (let i = open + 1; i < toolsSource.length; i++) {
    const ch = toolsSource[i]
    if (ch === '\\') { out += toolsSource[i + 1]; i++; continue }
    if (ch === "'") return out
    out += ch
  }
  throw new Error(`tools.ts 中 ${name} 的 description 未闭合`)
}

// 从服务文件提取方法体（签名起始到下一个顶层方法收尾）。
function methodBody(source, signature) {
  const at = source.indexOf(signature)
  assert.ok(at >= 0, `应存在方法 ${signature}`)
  return source.slice(at, source.indexOf('\n  },', at))
}

test('命令面显式化：team_review_task 描述首屏含「唯一正规路径」表述', () => {
  const desc = toolDescription('team_review_task')
  assert.match(
    desc.slice(0, 200),
    /the one and only regular path/i,
    '首屏应声明验收关单/退回的唯一正规路径',
  )
  assert.match(desc, /Only the project owner bot may use this/, '描述应保留总监专属正规性')
})

test('命令面显式化：team_assign_task / team_block_task 描述首行说明用途与正规性', () => {
  for (const name of ['team_assign_task', 'team_block_task']) {
    const desc = toolDescription(name)
    assert.match(desc.slice(0, 120), /^The regular path to /, `${name} 首行应说明正规用途`)
    assert.match(
      desc.slice(0, 400),
      /Only the project owner bot may use this/,
      `${name} 首屏应声明总监专属`,
    )
  }
})

test('失败语义引导 a：非 in_review 调验收的拒绝文案带替代下一步', () => {
  const body = methodBody(reviewSource, 'async applyReview(')
  assert.match(body, /不在待验收状态/, '保留原因前缀（既有断言锚点）')
  assert.match(body, /team_review_task 只验收已交付/, '点明命令的正规适用前提')
  assert.match(body, /等负责人交付/, '正确下一步：先等交付')
  assert.match(body, /team_assign_task 重派原任务/, '替代命令：amend 重派')
})

test('失败语义引导 b：权限不足的拒绝文案带替代执行路径', () => {
  const body = methodBody(dispatchSource, 'ownerContextFor(sessionId) {')
  assert.match(body, /只有项目总监 Bot 可以执行该操作/, '保留原因前缀（既有断言锚点）')
  assert.match(body, /team_assign_task/, '点名替代命令之一')
  assert.match(body, /team_review_task/, '点名验收关单命令')
  assert.match(body, /项目 owner 总监 Bot 调用/, '正确下一步：由 owner 总监执行')
  assert.match(body, /项目群内.{0,4}向总监请求/, '或走群内请求路径')
})

test('失败语义引导 c：重复派单拒绝文案带 amend 既有卡的替代命令', () => {
  const body = methodBody(dispatchSource, 'async assignFromBot(')
  assert.match(body, /已存在同写范围任务/, '保留原因前缀（既有断言锚点）')
  assert.match(body, /请勿重复派单/, '点明拒绝原因')
  assert.match(body, /team_assign_task 重派原任务改卡/, '替代命令：改卡重派而非新开')
  assert.match(body, /force_duplicate/, '逃生口参数保留提示')
})

test('层级边界：本卡改文案的三处均在工具调用返回层，未触碰 D-267 白名单层', () => {
  // 三处引导文案确实存在（源码级存在性）；run-finish 的失败终态透传不在本卡写范围，
  // 这里只断言引导文案挂在 services 校验层（tools.ts 包装层无新增 throw 文案）。
  assert.match(reviewSource, /DSHBOTS-269 失败语义引导/, 'task-review.ts 应带引导注释锚点')
  const toolThrows = toolsSource.match(/throw new Error\('[^']*'\)/g) ?? []
  assert.deepEqual(
    toolThrows.filter(msg => /总监|验收|重复派单|正规/.test(msg)),
    [],
    'tools.ts 包装层不得另起拒绝文案（权威文案在 services 校验层）',
  )
})
