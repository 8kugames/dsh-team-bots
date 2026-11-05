// DSHBOTS-265 拆分守门：src/services/tasks.ts 按职责拆到 task-dispatch.ts / task-runs.ts 后，
// ① 每个切片（含编译产物 .js）<800 行，防搬迁后回涨；
// ② 方法体不跨文件重复定义（纯搬迁，不是复制）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SLICES = ['tasks', 'task-dispatch', 'task-runs']

function lines(rel: string) {
  return readFileSync(join(root, rel), 'utf8').split('\n').length
}

test('src/services/tasks*.ts 每个切片 <800 行（800 行铁律）', () => {
  for (const name of SLICES) {
    const n = lines(`src/services/${name}.ts`)
    assert.ok(n < 800, `${name}.ts ${n} 行，超过 800 行铁律`)
  }
})

test('编译产物 src/services/tasks*.js 每个切片 <800 行（行数守门口径）', () => {
  for (const name of SLICES) {
    const n = lines(`src/services/${name}.js`)
    assert.ok(n < 800, `${name}.js ${n} 行，超过 800 行铁律`)
  }
})

test('方法体不跨文件重复定义（搬迁不是复制）', () => {
  const seen = new Map()
  for (const name of SLICES) {
    const source = readFileSync(join(root, `src/services/${name}.ts`), 'utf8')
    for (const match of source.matchAll(/^  (?:async )?([A-Za-z_][A-Za-z0-9_]*)\(/gm)) {
      const method = match[1]
      assert.ok(!seen.has(method), `方法 ${method} 同时出现在 ${seen.get(method)} 与 ${name}.ts`)
      seen.set(method, name)
    }
  }
})
