// DSHBOTS-162 R1 返工守门：保存界面语言后，热切换必须由保存动作自己触发。
//
// 卡面第 3 条承诺「保存后下次 state 轮询 syncLanguage 热切换即生效」，实测该承诺不成立：
// syncLanguage（ui/app.js:50-60）只被 refresh()（:65）与 init()（:647）调用，
// poll()（:620-642）带回新的 state.language 但不调它，save-ui-language 分支原先也只 loadState。
// 缺这一行时，保存语言后字典不切换，要等下一次 refresh()/init()（切页或刷新）才生效。
//
// 用 tests/question-card-interaction.test.js 的 loadModule 同法求值真实 events-board.js
// （剥 import 行、去 export 前缀），注入可编程桩驱动真实 handleBoardAction('save-ui-language')，
// 断言 syncLanguage 在 loadState 之后被调用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'ui', 'modules', 'events-board.js'), 'utf8')

const noop = () => {}

// 真实模块的 import 名（解析自源码：新增 import 自动纳入，未覆盖的一律 no-op 桩）。
const importNames = [...source.matchAll(/^import \{([^}]*)\} from /gm)]
  .flatMap((match) => match[1].split(',').map((name) => name.trim()).filter(Boolean))

function loadHandleBoardAction(overrides) {
  const stripped = source
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .join('\n')
    .replace(/^export /gm, '')
  const stubs = new Proxy(overrides, { get: (target, key) => (key in target ? target[key] : noop) })
  const documentStub = {
    getElementById: (id) => (id === 'settings-ui-language' ? { value: 'en' } : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const names = [...importNames, 'document']
  const values = [...importNames.map((name) => stubs[name]), documentStub]
  return new Function(...names, `${stripped}\nreturn handleBoardAction`)(...values)
}

test('保存界面语言后立即热切换：handleBoardAction 在 loadState 后调用 syncLanguage（R1）', async () => {
  const calls = []
  const state = { projectId: null, view: 'global', data: null }
  const handle = loadHandleBoardAction({
    state,
    t: (key) => key,
    toast: (message) => calls.push(['toast', message]),
    api: async (action, payload) => { calls.push(['api', action, payload]); return {} },
    loadState: async () => { calls.push(['loadState']); state.data = { language: 'en' } },
    syncLanguage: () => { calls.push(['syncLanguage']) },
  })

  assert.equal(await handle('save-ui-language', {}), true)

  assert.deepEqual(
    calls.find((call) => call[0] === 'api'),
    ['api', 'update_settings', { ui_language: 'en' }],
    '应把下拉值经 update_settings 落库',
  )
  const order = calls.map((call) => call[0])
  const loadAt = order.indexOf('loadState')
  const syncAt = order.indexOf('syncLanguage')
  assert.notEqual(loadAt, -1, '保存后应 loadState 拿回新的 state.language')
  assert.ok(syncAt > loadAt, 'syncLanguage 必须在 loadState 之后调用：轮询不切语言，热切换须由保存动作触发')
  assert.ok(order.includes('toast'), '应给出保存成功反馈')
})
