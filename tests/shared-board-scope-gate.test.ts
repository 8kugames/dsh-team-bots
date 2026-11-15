// tests/shared-board-scope-gate.test.js —— DSHBOTS-270 共享板无主卡领取开工声明闸门守门
// 纯源码级断言（不建库、不 mkdtemp），钉四件事：
// ① 无主卡获得 owner 的两条链路（assignTask 领取 / updateTask 编辑表单指派）都挂闸门：
//    无声明（含全被忽略规则清洗后为空）即拒绝，带声明的卡与改派/重派流程不受影响；
// ② 拒绝文案按 D-269 口径 = 原因（未声明保守串行堵道）+ 替代命令（工作台补 write_scopes
//    或描述行「写范围：a, b」，由 parseWriteScopesFromDescription 兜底解析）；
// ③ 描述行兜底生效：卡面清单为空时回落到描述解析，清洗用既有 filterIgnoredWriteScopes；
// ④ assignFromBot 既有闸门与 scheduler「未声明即串行」语义一行不动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const dispatchSource = read('../src/services/task-dispatch.ts')
const tasksSource = read('../src/services/tasks.ts')
const schedulerSource = read('../src/services/scheduler.ts')

function methodBody(source, signature) {
  const at = source.indexOf(signature)
  assert.ok(at >= 0, `应存在方法 ${signature}`)
  return source.slice(at, source.indexOf('\n  },', at))
}

test('闸门挂点①：assignTask 领取无主卡前过 assertClaimScopes', () => {
  const body = methodBody(dispatchSource, 'async assignTask(')
  assert.ok(body.includes('this.assertClaimScopes(task, project)'), 'assignTask 应调用声明闸门')
  assert.match(
    body,
    /if \(!task\.assignee_bot_id && autoStart !== false\) this\.assertClaimScopes/,
    '闸门只对无主卡领取生效：改派（已有 owner）与 autoStart=false 重派/补挂流程不拦截',
  )
  const at = body.indexOf('assertDispatchTarget(project.id, botId)')
  const gate = body.indexOf('assertClaimScopes(task, project)')
  assert.ok(at >= 0 && gate > at, '闸门应在派发门禁（暂停 bot 校验）之后，不改变既有拒绝文案')
})

test('闸门挂点②：updateTask 编辑表单给无主卡指派 owner 同口径过闸', () => {
  const body = methodBody(tasksSource, 'async updateTask(')
  assert.ok(body.includes('this.assertClaimScopes({'), 'updateTask 指派分支应调用声明闸门')
  assert.match(body, /if \(patch\.assigneeBotId && !task\.assignee_bot_id\)/, '只拦无主卡获得 owner')
  // 补声明后放行：同 patch 带的 write_scopes / 描述写范围行纳入判定，而不是只看库内旧值
  assert.match(body, /patch\.writeScopes === undefined[\s\S]*?parseWriteScopes\(patch\.writeScopes\)/, '同 patch 补的 write_scopes 应参与闸门判定')
  assert.match(body, /patch\.description === undefined \? task\.description/, '同 patch 换的描述应参与兜底解析')
})

test('无声明被拒：拒绝文案 = 原因 + 替代命令（D-269 口径）', () => {
  const body = methodBody(dispatchSource, 'assertClaimScopes(task, project) {')
  assert.match(body, /throw badRequest\(/, '未声明应抛 badRequest 拒绝')
  assert.match(body, /保守串行/, '文案应说明原因：未声明的写运行保守串行')
  assert.match(body, /update_task \/ task_update_scopes/, '文案应给出补 write_scopes 的替代命令')
  assert.match(body, /「写范围：a, b」/, '文案应给出描述行兜底的替代写法')
})

test('补声明后放行 + 描述行兜底生效 + 清洗口径一致', () => {
  const body = methodBody(dispatchSource, 'assertClaimScopes(task, project) {')
  assert.match(body, /if \(scopes\.length\) return/, '带声明（清单非空）直接放行，领取流程不受影响')
  assert.match(
    body,
    /declared\.length \? declared : parseWriteScopesFromDescription\(task\.description\)/,
    '卡面清单为空时回落到描述「写范围：」行解析',
  )
  assert.match(body, /filterIgnoredWriteScopes\(/, '按忽略规则清洗：全被清洗后为空同样算未声明')
  assert.match(body, /\.kept/, '取清洗后保留清单判定')
})

test('assignFromBot 既有闸门行为不动：重派分支不进新闸门', () => {
  const body = methodBody(dispatchSource, 'async assignFromBot(')
  assert.match(body, /派单必须声明写范围：传 write_scopes 路径数组，或在描述里写一行/, '既有新卡拒绝文案前缀保留')
  const reDispatch = body.slice(body.indexOf('if (input.taskId || input.task)'))
  assert.ok(!reDispatch.includes('assertClaimScopes'), '重派已有任务分支不挂新闸门（既有行为不变）')
})

test('scheduler「未声明即串行」语义一行不动', () => {
  assert.match(schedulerSource, /任一未声明（空集合）按保守串行/, '保守串行注释仍在')
  assert.match(schedulerSource, /writeScopesOverlap\(writeScopes, other\)/, '重叠判定仍在')
})
