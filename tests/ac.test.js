import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const block = /\/\/ ac-core:start[\s\S]*?\/\/ ac-core:end/.exec(source)?.[0]
assert.ok(block, 'ui/app.js 缺少 ac-core 标记块')

const { detectAcToken, buildAcItems } = new Function(`${block}\nreturn { detectAcToken, buildAcItems }`)()

test('slash 令牌只在消息开头识别（与服务端命令锚定一致）', () => {
  assert.deepEqual(detectAcToken('/ta', 3), { mode: 'slash', from: 0, to: 3, query: 'ta' })
  assert.deepEqual(detectAcToken('/task', 5), { mode: 'slash', from: 0, to: 5, query: 'task' })
  assert.deepEqual(detectAcToken('/task 标题', 5), { mode: 'slash', from: 0, to: 5, query: 'task' })
  assert.equal(detectAcToken('/task 标题', 10), null) // 光标已进入标题区（clamp 到 8 > end 5）
  assert.equal(detectAcToken('你好 /ta', 7), null)   // 不在开头，不触发命令补全
})

test('@ 令牌要求前面是行首或空白（与 parseMentions 一致）', () => {
  assert.deepEqual(detectAcToken('@ch', 3), { mode: 'mention', from: 0, to: 3, query: 'ch' })
  assert.deepEqual(detectAcToken('/task @', 7), { mode: 'mention', from: 6, to: 7, query: '' })
  assert.deepEqual(detectAcToken('你好 @张 三', 5), { mode: 'mention', from: 3, to: 5, query: '张' })
  assert.equal(detectAcToken('a@b', 3), null)     // @ 前是文字
  assert.equal(detectAcToken('标题@chi', 6), null)
})

test('buildAcItems 过滤命令、技能与成员，清单不截断', () => {
  const sources = {
    skills: [
      { slug: 'release-check', name: '发布检查', description: '上线前检查' },
      { slug: 'art-review', name: '美术评审', description: '' },
    ],
    members: [
      { id: 'b1', name: 'director', role: '架构', color: 'teal', owner: true },
      { id: 'b2', name: 'Artist', role: '美术', color: 'pink', owner: false },
    ],
  }
  const slash = buildAcItems('slash', 'ta', sources)
  assert.ok(slash.some(item => item.label === '/task'))
  assert.ok(!slash.some(item => item.label === '/remember'))
  assert.deepEqual(buildAcItems('slash', '发布', sources).map(item => item.label), ['/release-check'])
  const mention = buildAcItems('mention', 'ar', sources)
  assert.deepEqual(mention.map(item => item.label), ['@Artist'])
  assert.ok(mention[0].insert.endsWith(' ')) // 尾随空格满足 parseMentions 边界
  const ownerItem = buildAcItems('mention', 'di', sources)[0]
  assert.equal(ownerItem.desc, '总监 · 架构')
  const full = buildAcItems('slash', '', {
    skills: Array.from({ length: 12 }, (_, i) => ({ slug: `s${i}`, name: `技能${i}` })),
    members: [],
  })
  assert.equal(full.length, 15) // 3 命令 + 12 技能，全量展示，弹层自身滚动
})
