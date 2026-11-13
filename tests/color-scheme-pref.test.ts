// 明暗偏好三档（跟随/日间/夜间）：手动档压过宿主/系统自动判定，auto 档回落自动链。
// 本文件锁三件事：① util.ts 的偏好分流逻辑；② app 启动读取落盘偏好；③ 设置页渲染与事件接线。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const utilSource = readFileSync(join(root, 'ui', 'modules', 'util.js'), 'utf8')
const appSource = readFileSync(join(root, 'ui', 'app.js'), 'utf8')
const settingsSource = readFileSync(join(root, 'ui', 'modules', 'settings.js'), 'utf8')
const boardSource = readFileSync(join(root, 'ui', 'modules', 'events-board.js'), 'utf8')

function fnBody(source, name) {
  const index = source.indexOf(`export function ${name}`)
  assert.ok(index >= 0, `缺少 export function ${name}`)
  const open = source.indexOf('{', index)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error('块花括号不配平')
}

test('normalizeColorSchemePref：只认 light/dark，其余一律回落 auto', () => {
  const body = fnBody(utilSource, 'normalizeColorSchemePref')
  assert.match(body, /value === 'light' \|\| value === 'dark'/)
  assert.match(body, /: 'auto'/, '非法值必须回落 auto，不得静默吞')
})

test('applyColorScheme：手动档直接定，auto 档才走 resolveColorScheme 自动链', () => {
  const body = fnBody(utilSource, 'applyColorScheme')
  assert.match(body, /pref === 'auto' \? resolveColorScheme\(\) : pref/, '手动档须压过自动判定')
  assert.match(body, /setAttribute\('data-color-scheme', scheme\)/)
  assert.match(body, /style\.colorScheme = scheme/)
})

test('setColorSchemePreference：写状态后立即生效，返回偏好档而非生效明暗', () => {
  const body = fnBody(utilSource, 'setColorSchemePreference')
  assert.match(body, /state\.colorSchemePref = pref/, '偏好须写入内存态，供设置页回显')
  assert.match(body, /applyColorScheme\(\)/, '写入后须立即生效')
  // 返回值必须是偏好档：落盘用返回值，返回生效明暗会让「跟随」被存成当时的手动值。
  assert.match(body, /return pref/, '须返回偏好档本身')
  assert.doesNotMatch(body, /return applyColorScheme\(\)/, '不得返回生效明暗，否则「跟随」落盘后变成手动固定')
})

test('app 启动：先读落盘偏好再 initColorScheme，手动档才不会被自动判定覆盖', () => {
  const prefIndex = appSource.indexOf('state.colorSchemePref = readPref(UI_COLOR_SCHEME_KEY)')
  const initIndex = appSource.indexOf('initColorScheme()')
  assert.ok(prefIndex >= 0, 'app.js 启动段应读取落盘的明暗偏好')
  assert.ok(initIndex >= 0, 'app.js 启动段应调用 initColorScheme()')
  assert.ok(prefIndex < initIndex, '偏好读取必须早于 initColorScheme，否则手动档被自动判定盖掉')
  assert.match(appSource, /const UI_COLOR_SCHEME_KEY = 'dshb:ui-color-scheme'/)
})

test('设置页渲染：三档分段开关与偏好回显', () => {
  for (const mode of ['auto', 'light', 'dark']) {
    assert.ok(
      settingsSource.includes(`data-action="set-color-scheme" data-color-scheme="${mode}"`),
      `设置页缺 ${mode} 档开关`,
    )
  }
  assert.match(settingsSource, /aria-pressed="\$\{colorSchemePref === 'auto'\}"/, '当前档须有按下态')
  assert.match(settingsSource, /const colorSchemePref = state\.colorSchemePref \|\| 'auto'/)
})

test('事件接线：切档写内存态、落盘并重渲染', () => {
  assert.match(boardSource, /case 'set-color-scheme'/, 'board 缺 set-color-scheme 分支')
  assert.match(boardSource, /setColorSchemePreference\(target\.dataset\.colorScheme\)/)
  assert.match(boardSource, /localStorage\.setItem\(UI_COLOR_SCHEME_KEY, pref\)/, '偏好须落盘，刷新后保持')
  assert.match(boardSource, /case 'set-color-scheme':[\s\S]*?render\(\)/, '切档后须重渲染以回显按下态')
})
