// tests/reason-codes.test.ts —— B10/DSHBOTS-337：run_events 事件类型注册表守门。
// 「新闸门必须登记码」的可执行形态：静态扫描全部 run_events type 字面量 ⊆ RUN_EVENT_TYPES。
// ①全集登记：扫描 insertRunEvent/INSERT INTO run_events 两种形态的 type 字面量，未登记即红；
// ②登记条目完整：domain 合法、zh/en 非空；③释义函数按域双语、未知码原样回退；
// ④type 即码、message 为站点语境的设计口径钉在文件头（防未来引入第二层文案真值）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { RUN_EVENT_TYPES, RUN_EVENT_DOMAINS, runEventTypeLabel } from '../src/services/reason-codes.js'

const SRC = join(fileURLToPath(new URL('..', import.meta.url)), 'src')
const tsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name)
  if (entry.isDirectory()) return tsFiles(full)
  return entry.name.endsWith('.ts') ? [full] : []
})

// 两种写入形态的 type 字面量抽取（与 reason-codes.ts 头注同款口径）。
function collectEventTypeLiterals() {
  const found = []
  for (const file of tsFiles(SRC)) {
    if (file.endsWith('reason-codes.ts')) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/insertRunEvent\([^,]+,\s*'([a-z_]+)'/g)) {
      found.push({ file: file.replace(SRC, 'src'), type: match[1] })
    }
    // INSERT 形态：id('evt') 是 id 前缀参数，type 是其后的字面量（id, run_id, type, ...）。
    for (const match of source.matchAll(/INSERT INTO run_events[\s\S]{0,400}?id\('evt'\)[^;]{0,320}?,\s*'([a-z_]+)'/g)) {
      found.push({ file: file.replace(SRC, 'src'), type: match[1] })
    }
  }
  return found
}

test('全集登记：所有 run_events type 字面量均已注册', () => {
  const found = collectEventTypeLiterals()
  assert.ok(found.length >= 30, `扫描应覆盖大量事件点（实测 ${found.length}）`)
  const unregistered = found.filter(({ type }) => !RUN_EVENT_TYPES[type])
  assert.deepEqual(
    unregistered.map(({ file, type }) => `${file}:${type}`),
    [],
    `发现未登记的 run_events 类型——先到 src/services/reason-codes.ts 登记（type 即码）再落码：\n${unregistered.map(({ file, type }) => `${file} '${type}'`).join('\n')}`,
  )
})

test('登记条目完整：domain 合法、双语释义非空', () => {
  const types = Object.keys(RUN_EVENT_TYPES)
  assert.ok(types.length >= 30, `注册表应覆盖全部现行类型（实测 ${types.length}）`)
  for (const [type, entry] of Object.entries(RUN_EVENT_TYPES)) {
    assert.ok(/^[a-z_]+$/.test(type), `type 命名应为小写下划线：${type}`)
    assert.ok(RUN_EVENT_DOMAINS.includes(entry.domain), `${type} 的 domain 非法：${entry.domain}`)
    assert.ok(entry.zh && entry.zh.length > 0, `${type} 缺 zh 释义`)
    assert.ok(entry.en && entry.en.length > 0, `${type} 缺 en 释义`)
  }
})

test('释义函数：双语按域回显，未知码原样回退不抛错', () => {
  assert.equal(runEventTypeLabel('queued', 'zh'), '运行入队')
  assert.equal(runEventTypeLabel('queued', 'en'), 'Run queued')
  assert.equal(runEventTypeLabel('task_deadline', 'zh'), '整卡死线已到，拒绝启动新施工运行')
  assert.equal(runEventTypeLabel('no_such_type', 'zh'), 'no_such_type')
  assert.equal(runEventTypeLabel('no_such_type', 'en'), 'no_such_type')
})

test('设计口径钉住：type 即码、message 为站点语境，不引入第二层文案真值', () => {
  const source = readFileSync(join(SRC, 'services', 'reason-codes.ts'), 'utf8')
  assert.match(source, /run_events\.type 本就是结构化码/, '头注口径在场')
  assert.match(source, /双真值，不引入/, '反双真值裁决在场')
})
