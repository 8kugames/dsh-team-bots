import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const block = /\/\/ panel-state:start[\s\S]*?\/\/ panel-state:end/.exec(source)?.[0]
assert.ok(block, 'ui/app.js 缺少 panel-state 标记块')

const { panelKey, isPanelOpen, panelOpenAttr, applyPanelToggle } = new Function(
  `${block}\nreturn { panelKey, isPanelOpen, panelOpenAttr, applyPanelToggle }`
)()

const panelState = (keys = []) => ({ openPanels: new Set(keys) })

test('panelKey：取 data-panel 属性值，缺失或空值返回 null', () => {
  assert.equal(panelKey({ getAttribute: (name) => (name === 'data-panel' ? 'dm' : null) }), 'dm')
  assert.equal(panelKey({ getAttribute: () => '' }), null)
  assert.equal(panelKey({ getAttribute: () => null }), null)
  assert.equal(panelKey({}), null)
  assert.equal(panelKey(null), null)
})

test('isPanelOpen / panelOpenAttr：key 在 openPanels 集合中才判展开并输出 open 属性', () => {
  const state = panelState(['dm', 'traj:r1:2'])
  assert.equal(isPanelOpen(state, 'dm'), true)
  assert.equal(isPanelOpen(state, 'traj:r1:2'), true)
  assert.equal(isPanelOpen(state, 'skill-versions:git'), false)
  assert.equal(isPanelOpen(state, ''), false)
  assert.equal(isPanelOpen(state, null), false)
  assert.equal(isPanelOpen({}, 'dm'), false)
  assert.equal(isPanelOpen(panelState(), 'dm'), false)
  assert.equal(panelOpenAttr(state, 'dm'), ' open')
  assert.equal(panelOpenAttr(state, 'other'), '')
})

test('applyPanelToggle：展开记 key、收起删 key、无 key 不写入、重复展开幂等', () => {
  const state = panelState()
  applyPanelToggle(state, 'dm', true)
  assert.deepEqual([...state.openPanels], ['dm'])
  applyPanelToggle(state, 'dm', false)
  assert.deepEqual([...state.openPanels], [])
  applyPanelToggle(state, null, true)
  applyPanelToggle(state, '', true)
  applyPanelToggle(state, 'dm', true)
  applyPanelToggle(state, 'dm', true)
  assert.deepEqual([...state.openPanels], ['dm'])
  // state 无 openPanels 集合时不抛错、原样返回
  assert.deepEqual(applyPanelToggle({}, 'dm', true), {})
})

test('渲染接线：五类折叠 details 都经 panelAttrs 带 data-panel，Bot 私信用固定 key dm', () => {
  assert.match(source, /<details class="chat-subpanel"\$\{panelAttrs\(state, 'dm'\)\}>/)
  assert.match(source, /skill-versions:\$\{skill\.slug\}/)
  assert.match(source, /panelAttrs\(state, `proposal:\$\{proposal\.id\}`\)/)
  assert.match(source, /panelAttrs\(state, `traj:\$\{runId\}:\$\{index\}`\)/)
  assert.match(source, /panelAttrs\(state, `run-output:\$\{run\.id\}`\)/)
  assert.match(source, /openPanels: new Set\(\)/)
})

test('toggle 事件委托：document 捕获阶段监听并写入 applyPanelToggle', () => {
  assert.match(source, /addEventListener\('toggle',[\s\S]*?applyPanelToggle\(state, panelKey\(event\.target\), event\.target\.open\)/)
  assert.match(source, /addEventListener\('toggle', \(event\) => \{[\s\S]*?\}, true\)/)
})

test('轨迹 modal 把 runId 透传到面板 key，条目 key 含索引保持多条目唯一', () => {
  assert.match(source, /state\.modal = \{ type: 'trajectory', detail, runId \}/)
  assert.match(source, /modalTrajectory\(modal\.detail, modal\.runId\)/)
  assert.match(source, /entries\.map\(\(entry, index\) => trajectoryEntry\(entry, index, runId\)\)/)
})
