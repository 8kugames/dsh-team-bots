import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const block = /\/\/ task-sort:start[\s\S]*?\/\/ task-sort:end/.exec(source)?.[0]
assert.ok(block, 'ui/app.js 缺少 task-sort 标记块')

const { TASK_PRIORITY_WEIGHT, taskPriorityKey, taskPriorityWeight, compareTasksByPriority, sortTasksByPriority } =
  new Function(`${block}\nreturn { TASK_PRIORITY_WEIGHT, taskPriorityKey, taskPriorityWeight, compareTasksByPriority, sortTasksByPriority }`)()

test('权重表把优先级映射为「越小越靠前」', () => {
  assert.deepEqual(TASK_PRIORITY_WEIGHT, { urgent: 0, high: 1, medium: 2, low: 3, none: 4 })
})

test('优先级权重：合法值取表内权重，未知值/缺失按 medium', () => {
  assert.equal(taskPriorityWeight('urgent'), 0)
  assert.equal(taskPriorityWeight('high'), 1)
  assert.equal(taskPriorityWeight('medium'), 2)
  assert.equal(taskPriorityWeight('low'), 3)
  assert.equal(taskPriorityWeight('none'), 4)
  // 旧数据没有 priority、或出现表外取值，都落在中档
  assert.equal(taskPriorityWeight(undefined), 2)
  assert.equal(taskPriorityWeight(null), 2)
  assert.equal(taskPriorityWeight(''), 2)
  assert.equal(taskPriorityWeight('critical'), 2)
  assert.equal(taskPriorityWeight('URGENT'), 0)
})

test('归一化：表内值原样返回，表外值与缺失落到 medium', () => {
  assert.equal(taskPriorityKey('urgent'), 'urgent')
  assert.equal(taskPriorityKey('none'), 'none')
  assert.equal(taskPriorityKey(undefined), 'medium')
  assert.equal(taskPriorityKey(''), 'medium')
  assert.equal(taskPriorityKey('critical'), 'medium')
})

test('排序按优先级从高到低（紧急在最上、无在最下）', () => {
  const tasks = [
    { number: 1, priority: 'low' },
    { number: 2, priority: 'urgent' },
    { number: 3, priority: 'none' },
    { number: 4, priority: 'high' },
    { number: 5, priority: 'medium' },
  ]
  const sorted = sortTasksByPriority(tasks)
  assert.deepEqual(sorted.map(task => task.priority), ['urgent', 'high', 'medium', 'low', 'none'])
  assert.deepEqual(sorted.map(task => task.number), [2, 4, 5, 1, 3])
})

test('同优先级按 position 回退，再按 number 回退', () => {
  const tasks = [
    { number: 10, priority: 'high', position: 2 },
    { number: 11, priority: 'high', position: 1 },
    { number: 12, priority: 'high', position: 1 },
  ]
  assert.deepEqual(sortTasksByPriority(tasks).map(task => task.number), [11, 12, 10])
  // position 缺失时按 0 参与比较
  assert.deepEqual(
    sortTasksByPriority([{ number: 20, priority: 'high' }, { number: 21, priority: 'high', position: 1 }]).map(task => task.number),
    [20, 21],
  )
})

test('未知优先级与 medium 视为同档，混排时仍按 position/number 稳定回退', () => {
  const tasks = [
    { number: 1, priority: undefined },
    { number: 2, priority: 'medium' },
    { number: 3, priority: 'weird' },
  ]
  assert.deepEqual(sortTasksByPriority(tasks).map(task => task.number), [1, 2, 3])
})

test('排序是纯函数，不改原数组', () => {
  const tasks = [{ number: 1, priority: 'low' }, { number: 2, priority: 'urgent' }]
  const copy = [...tasks]
  sortTasksByPriority(tasks)
  assert.deepEqual(tasks, copy)
  assert.deepEqual(sortTasksByPriority(undefined), [])
})

test('比较器返回值的符号方向正确（负数表示 a 排在 b 前）', () => {
  assert.ok(compareTasksByPriority({ priority: 'urgent' }, { priority: 'low' }) < 0)
  assert.ok(compareTasksByPriority({ priority: 'low' }, { priority: 'urgent' }) > 0)
  assert.equal(compareTasksByPriority({ priority: 'high', position: 1, number: 1 }, { priority: 'high', position: 1, number: 1 }), 0)
})

test('看板接线：filteredTasks 走排序，看板列沿用该顺序', () => {
  assert.match(source, /return sortTasksByPriority\(\(state\.data\?\.tasks \?\? \[\]\)\.filter/)
  // 列内顺序直接来自 filteredTasks 的结果，不再另行排序
  assert.match(source, /const column = tasks\.filter\(task => task\.status === status\)/)
  assert.match(source, /\$\{column\.map\(renderTaskCard\)\.join\(''\)\}/)
  // 卡片上的优先级标签也走归一化，旧数据不再显示空白
  assert.match(source, /PRIORITY\[taskPriorityKey\(task\.priority\)\]/)
})
