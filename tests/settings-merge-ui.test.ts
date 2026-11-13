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
  assert.match(boardSource, /\{ patch: \{ \.\.\.patch \}, revision: state\.data\?\.settingsRevision \}/, '保存载荷必须为 { patch, revision } 形态')
  assert.match(boardSource, /error\?\.code !== 'CONFLICT'/, '冲突分支按 CONFLICT 类别接管')
  assert.match(boardSource, /mergeSettingsDraft\(baseSettings, patch, state\.data\?\.settings \?\? \{\}\)/, '冲突后必须与最新服务端值三方合并')
  assert.match(boardSource, /input\.value = String\(value\)/, '对方未动字段的草稿必须贴回表单')
  // 三处设置保存（系统/运行时效/界面语言）全部走 { patch, revision } 契约。
  assert.match(boardSource, /\{ patch: \{ ui_language: value \} \}/, '语言保存必须走 patch 形态')
  assert.match(boardSource, /languagePayload\.revision = state\.data\?\.settingsRevision/)
})

// 冲突路径端到端可达性：修复前 api 回退整个扁平载荷、revision 混进 patch 被白名单拒绝，
// 409 分支从未走到。用可编程桩驱动真实 events-board.js 的 save-settings，
// 断言 CONFLICT 后合并回贴表单、复核文案正确、且请求体是 { patch, revision } 契约形态。
test('冲突路径真实可达：CONFLICT 后三方合并回贴表单并提示复核', async () => {
  const { mergeSettingsDraft } = build()
  const boardJs = readFileSync(join(root, 'modules', 'events-board.js'), 'utf8')
  const importNames = [...boardJs.matchAll(/^import \{([^}]*)\} from /gm)]
    .flatMap((match) => match[1].split(',').map((name) => name.trim()).filter(Boolean))
  const stripped = boardJs
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .join('\n')
    .replace(/^export /gm, '')
  const noop = () => {}
  const inputValues = {
    'settings-currency': 'USD',
    'settings-memory-review': '1',
    'settings-global-token-budget': '5000',
    'settings-global-cost-budget': '',
    'settings-retention-usage': '30',
    'settings-retention-run': '7',
    'settings-retention-message': '90',
  }
  const inputs = {}
  const draft = {
    budget_currency: 'USD',
    memory_review: '1',
    global_token_budget: '5000',
    global_cost_budget: '',
    retention_usage_days: '30',
    retention_run_event_days: '7',
    retention_message_days: '90',
  }
  const baseSettings = { ...draft, budget_currency: 'CNY' }
  const serverNow = { ...baseSettings, budget_currency: 'EUR' }
  const state = { projectId: 'p1', view: 'global', data: { settings: baseSettings, settingsRevision: 0 } }
  const calls = []
  const documentStub = {
    getElementById: (id) => (inputs[id] ??= { value: inputValues[id] ?? '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const overrides = {
    state,
    t: (key) => key,
    toast: (message) => calls.push(['toast', message]),
    api: async (action, payload) => {
      calls.push(['api', action, payload])
      const error = new Error('配置已被其他人或窗口修改，本次保存被拒绝；请刷新后基于最新值重新编辑')
      error.code = 'CONFLICT'
      error.status = 409
      throw error
    },
    loadState: async () => { calls.push(['loadState']); state.data = { settings: serverNow, settingsRevision: 1 } },
    mergeSettingsDraft,
  }
  const stubs = new Proxy(overrides, { get: (target, key) => (key in target ? target[key] : noop) })
  const names = [...importNames, 'document']
  const values = [...importNames.map((name) => stubs[name]), documentStub]
  const handle = new Function(...names, `${stripped}\nreturn handleBoardAction`)(...values)

  assert.equal(await handle('save-settings', {}), true)

  const apiCall = calls.find((call) => call[0] === 'api')
  assert.equal(apiCall[1], 'update_settings')
  assert.deepEqual(apiCall[2], { patch: { ...draft }, revision: 0 }, '保存请求必须是 { patch, revision } 契约形态')
  // 对方未动的 global_token_budget 草稿贴回表单；双方都改的 budget_currency 以服务端为准。
  assert.equal(inputs['settings-global-token-budget'].value, '5000', '对方未动字段的草稿必须贴回表单')
  const toastMessage = calls.filter((call) => call[0] === 'toast').map((call) => call[1]).join('\n')
  assert.match(toastMessage, /配置已被他人修改.*budget_currency/, '双改字段必须点名复核')
})
