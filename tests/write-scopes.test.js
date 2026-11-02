import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWriteScopes,
  readWriteScopes,
  writeScopePathsOverlap,
  writeScopesOverlap,
  WRITE_SCOPE_MAX,
  WRITE_SCOPE_MAX_LEN,
} from '../src/service.js'
// 兜底解析函数走域模块直连：门面按 DSHBOTS-16 纪律不加代码。
import { parseWriteScopesFromDescription } from '../src/services/write-scopes.js'

// 写范围判定的纯函数：调度器据此决定同项目的两个写运行能否并行。
// 口径：两侧都声明了写范围且路径前缀互不重叠才放行；任一未声明（空集合）按保守串行。

test('写范围不相交时不冲突', () => {
  assert.equal(writeScopesOverlap(['ui/modules/chat.js'], ['ui/modules/tasks.js']), false)
  assert.equal(writeScopesOverlap(['ui/a.js'], ['src/b.js']), false)
})

test('写范围相等或目录前缀重叠时冲突', () => {
  assert.equal(writeScopesOverlap(['ui/modules/chat.js'], ['ui/modules/chat.js']), true)
  assert.equal(writeScopesOverlap(['ui/modules/chat.js'], ['ui/modules/']), true)
  assert.equal(writeScopesOverlap(['ui/modules/'], ['ui/modules/chat.js']), true)
  assert.equal(writeScopesOverlap(['ui'], ['ui/modules/chat.js']), true)
  // 路径按分段比较：'src2' 不是 'src' 的目录前缀
  assert.equal(writeScopesOverlap(['src'], ['src2/a.js']), false)
  assert.equal(writeScopePathsOverlap('src', 'src2/a.js'), false)
})

test('任一侧未声明写范围时保守判为冲突（串行）', () => {
  assert.equal(writeScopesOverlap([], ['ui/a.js']), true)
  assert.equal(writeScopesOverlap(['ui/a.js'], []), true)
  assert.equal(writeScopesOverlap([], []), true)
  // 库里的坏数据（非法 JSON / 非数组）同样降级为「未声明」
  assert.equal(writeScopesOverlap('{bad json', ['ui/a.js']), true)
  assert.equal(writeScopesOverlap('{"a":1}', ['ui/a.js']), true)
})

test('多元素写范围集合：任一对路径冲突即整体冲突', () => {
  assert.equal(writeScopesOverlap(['ui/a.js', 'ui/b.js'], ['ui/c.js']), false)
  assert.equal(writeScopesOverlap(['ui/a.js', 'ui/b.js'], ['ui/b.js', 'ui/c.js']), true)
  assert.equal(writeScopesOverlap(['ui/a.js', 'docs/b.md'], ['src/c.js', 'docs/b.md']), true)
  assert.equal(writeScopesOverlap(['ui/a.js', 'ui/b.js'], ['docs/x.md', 'docs/y.md']), false)
})

test('写范围输入校验：非法路径直接报错，不静默降级', () => {
  assert.deepEqual(parseWriteScopes(undefined), [])
  assert.deepEqual(parseWriteScopes(null), [])
  assert.deepEqual(parseWriteScopes([]), [])
  assert.deepEqual(parseWriteScopes(['ui/a.js', './ui/b.js', 'ui/c/']), ['ui/a.js', 'ui/b.js', 'ui/c'])
  assert.deepEqual(parseWriteScopes('["ui/a.js"]'), ['ui/a.js'])
  assert.throws(() => parseWriteScopes('not json'), /写范围必须是路径数组/)
  assert.throws(() => parseWriteScopes({ a: 1 }), /写范围必须是路径数组/)
  assert.throws(() => parseWriteScopes(['/etc/passwd']), /写范围包含非法路径/)
  assert.throws(() => parseWriteScopes(['../outside']), /写范围包含非法路径/)
  assert.throws(() => parseWriteScopes(['ui/../../etc']), /写范围包含非法路径/)
  assert.throws(() => parseWriteScopes(['x'.repeat(WRITE_SCOPE_MAX_LEN + 1)]), /写范围路径过长/)
  assert.throws(
    () => parseWriteScopes(Array.from({ length: WRITE_SCOPE_MAX + 1 }, (_, index) => `ui/f${index}.js`)),
    /写范围最多 50 条/,
  )
})

test('读库侧的写范围快照：坏数据降级为空集合（未声明）', () => {
  assert.deepEqual(readWriteScopes('["ui/a.js"]'), ['ui/a.js'])
  assert.deepEqual(readWriteScopes(['ui/a.js']), ['ui/a.js'])
  assert.deepEqual(readWriteScopes(''), [])
  assert.deepEqual(readWriteScopes(null), [])
  assert.deepEqual(readWriteScopes(undefined), [])
  assert.deepEqual(readWriteScopes('{bad json'), [])
  assert.deepEqual(readWriteScopes('["/abs/path"]'), [])
})

test('描述兜底解析：行首「写范围：」/「write_scopes:」行可解析', () => {
  // 中英文冒号、逗号/顿号分隔、每项 trim、空项剔除、去重
  assert.deepEqual(parseWriteScopesFromDescription('做点事\n写范围：ui/a.js, src/b.js'), ['ui/a.js', 'src/b.js'])
  assert.deepEqual(parseWriteScopesFromDescription('write_scopes: ui/a.js、src/b.js'), ['ui/a.js', 'src/b.js'])
  assert.deepEqual(parseWriteScopesFromDescription('write_scopes： ui/a.js ， src/b.js'), ['ui/a.js', 'src/b.js'])
  assert.deepEqual(parseWriteScopesFromDescription('写范围: docs/x.md'), ['docs/x.md'])
  assert.deepEqual(parseWriteScopesFromDescription('写范围：ui/a.js, , ui/a.js'), ['ui/a.js'])
})

test('描述兜底解析：非行首提及与未命中返回空集合', () => {
  // 必须行首，句中提及不算，避免误伤普通叙述
  assert.deepEqual(parseWriteScopesFromDescription('注意本单写范围：ui/a.js'), [])
  assert.deepEqual(parseWriteScopesFromDescription('本单没有写范围行'), [])
  assert.deepEqual(parseWriteScopesFromDescription(undefined), [])
})

test('描述兜底解析：非法路径直接报错，不静默降级', () => {
  assert.throws(() => parseWriteScopesFromDescription('写范围：../outside'), /写范围包含非法路径/)
  assert.throws(() => parseWriteScopesFromDescription('write_scopes: /etc/passwd'), /写范围包含非法路径/)
})
