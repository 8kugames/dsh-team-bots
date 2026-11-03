// 工作台启动冒烟：D-15 拆分后 ui 模块图必须在模块求值层不炸。
// 背景（2026-11-03 生产事故）：state.js 顶层曾引用 app.js 局部函数 taskGroupKey，
// 模块图 ReferenceError → app.js 永不执行 → 工作台卡「正在连接团队空间」。
// 既有读源码测试（helpers/ui-sources.js 拼接 app.js+modules）发现不了这类断裂，
// 本文件用真实 ESM 导入补上这层保障。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('ui/modules/state.js 可完整求值：不引用 app.js 局部函数', async () => {
  globalThis.location = new URL('http://127.0.0.1:3080/api/dsh-team/ui?view=chat')
  const mod = await import(pathToFileURL(join(root, 'ui/modules/state.js')))
  assert.equal(mod.state.view, 'chat')
  assert.ok(Array.isArray(mod.STATUS_ORDER))
})

test('ui/modules/state.js 源码不再出现 taskGroupKey 可执行引用（防回归锁）', async () => {
  const src = await readFile(join(root, 'ui/modules/state.js'), 'utf8')
  const code = src.replace(/^[^\S\n]*\/\/[^\n]*/gm, '') // 只查可执行行，注释允许提及
  assert.doesNotMatch(code, /taskGroupKey/, '出现可执行引用即会在浏览器炸掉模块图')
})

test('app.js 入口持有 task-group 预置循环（搬迁去向回归锁）', async () => {
  const src = await readFile(join(root, 'ui/app.js'), 'utf8')
  assert.match(src, /for \(const status of STATUS_ORDER\) state\.openPanels\.add\(taskGroupKey\(status\)\)/)
})
