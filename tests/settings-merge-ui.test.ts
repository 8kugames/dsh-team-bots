// tests/settings-merge-ui.test.ts —— B2/DSHBOTS-325：设置三方合并 UI 守门。
// 前端用例沿用仓库先例：标记块 new Function 执行真实源码。守门三点：
// ① mergeSettingsDraft 纯函数三向（未改字段不参与/对方未动保留草稿/双改以服务端为准）；
// ② api() 客户端错误带 code/status（CONFLICT/409 可按类别接管）；
// ③ 保存链路接线（saveSettingsWithMerge 带 revision、冲突分支调用合并、三处保存走同一助手）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readUiSource } from './helpers/ui-sources.js'

const root = join(fileURLToPath(new URL('..', import.meta.url)), 'ui')
const apiSource = readFileSync(join(root, 'modules', 'api.ts'), 'utf8')
const boardSource = readFileSync(join(root, 'modules', 'events-board.ts'), 'utf8')
readUiSource() // 保持与既有 UI 用例相同的源可读性校验（app.js + modules 拼接）

const markerBlock = (source, name) => {
  const match = source.match(new RegExp(`// ===== ${name}:start[\\s\\S]*?// ===== ${name}:end =====`))
  assert.ok(match, `${name} 标记块必须存在`)
  return match[0]
}

const build = () => new Function(`${markerBlock(apiSource, 'settings-merge').replaceAll('export function', 'function')}
return { mergeSettingsDraft }`)()

test('mergeSettingsDraft：未改字段不参与，对方未动保留草稿，双改以服务端为准', () => {
  const { mergeSettingsDraft } = build()
  const base = { budget_currency: 'CNY', memory_review: '1', global_token_budget: '' }
  const patch = { budget_currency: 'USD', memory_review: '0', global_token_budget: '' }
  // 对方只改了 budget_currency：用户的 memory_review 草稿保留，budget_currency 冲突。
  const { merged, conflicts } = mergeSettingsDraft(base, patch, { budget_currency: 'EUR', memory_review: '1', global_token_budget: '' })
  assert.deepEqual(merged, { memory_review: '0' })
  assert.deepEqual(conflicts, ['budget_currency'])
  // 对方没动任何字段：全部草稿保留，零冲突。
  const clean = mergeSettingsDraft(base, patch, base)
  assert.deepEqual(clean.merged, { budget_currency: 'USD', memory_review: '0' })
  assert.deepEqual(clean.conflicts, [])
  // 用户没改的字段不参与合并（保持服务端值）。
  const idle = mergeSettingsDraft(base, { global_token_budget: '' }, { global_token_budget: '5000' })
  assert.deepEqual(idle.merged, {})
  assert.deepEqual(idle.conflicts, [])
})

test('api() 客户端错误带 code/status；保存链路带 revision 且冲突走合并', () => {
  assert.match(apiSource, /error\.code = body\?\.error\?\.code/, 'api() 必须把服务端错误码挂到 Error 上')
  assert.match(apiSource, /error\.status = response\.status/, 'api() 必须把 HTTP 状态挂到 Error 上')
  assert.match(boardSource, /saveSettingsWithMerge\(/, '保存必须走共享助手')
  assert.match(boardSource, /revision: state\.data\?\.settingsRevision/, '保存必须携带读取时的 revision')
  assert.match(boardSource, /error\?\.code !== 'CONFLICT'/, '冲突分支按 CONFLICT 类别接管')
  assert.match(boardSource, /mergeSettingsDraft\(baseSettings, patch, state\.data\?\.settings \?\? \{\}\)/, '冲突后必须与最新服务端值三方合并')
  assert.match(boardSource, /input\.value = String\(value\)/, '对方未动字段的草稿必须贴回表单')
  // 三处设置保存（系统/运行时效/界面语言）全部带 revision。
  assert.match(boardSource, /languagePatch\.revision = state\.data\?\.settingsRevision/)
})
