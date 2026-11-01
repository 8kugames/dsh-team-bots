import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const block = /\/\/ typing-status:start[\s\S]*?\/\/ typing-status:end/.exec(source)?.[0]
assert.ok(block, 'ui/app.js 缺少 typing-status 标记块')

const { activeTypingRuns } = new Function(`${block}\nreturn { activeTypingRuns }`)()

test('无活跃运行不出状态行', () => {
  assert.deepEqual(activeTypingRuns(undefined, 'chat'), [])
  assert.deepEqual(activeTypingRuns([], 'solo_chat'), [])
  assert.deepEqual(activeTypingRuns([
    { kind: 'chat', status: 'succeeded', bot_id: 'b1', botName: 'Alpha', queued_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:00:01Z' },
  ], 'chat'), [])
})

test('chat：queued 显示排队文案、running 显示思考文案，耗时起点分别为 queued_at / started_at', () => {
  const rows = activeTypingRuns([
    { kind: 'chat', status: 'running', bot_id: 'b2', botName: 'Beta', queued_at: '2026-01-01T00:00:01Z', started_at: '2026-01-01T00:00:02Z' },
    { kind: 'chat', status: 'queued', bot_id: 'b1', botName: 'Alpha', queued_at: '2026-01-01T00:00:00Z' },
  ], 'chat')
  assert.equal(rows.length, 2)
  // 按 queued_at 升序排列，与消息流顺序一致
  assert.deepEqual(rows.map(row => row.botName), ['Alpha', 'Beta'])
  assert.equal(rows[0].text, '排队等待回复…')
  assert.equal(rows[0].startedAt, '2026-01-01T00:00:00Z')
  assert.equal(rows[0].botId, 'b1')
  assert.equal(rows[1].text, '正在思考与回复…')
  assert.equal(rows[1].startedAt, '2026-01-01T00:00:02Z')
})

test('solo_chat：单聊活跃运行出状态行，kind 不匹配的 chat 运行不出行', () => {
  const rows = activeTypingRuns([
    { kind: 'solo_chat', status: 'queued', bot_id: 'b1', botName: 'Solo', queued_at: '2026-01-01T00:00:00Z' },
    { kind: 'chat', status: 'running', bot_id: 'b1', queued_at: '2026-01-01T00:00:01Z' },
  ], 'solo_chat')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].botName, 'Solo')
  assert.equal(rows[0].text, '排队等待回复…')
})

test('task、review、handle、dm、dm_reply、memory_review 与已结束运行一律不出行', () => {
  const others = ['task', 'review', 'handle', 'dm', 'dm_reply', 'memory_review'].flatMap(kind => ([
    { kind, status: 'queued', queued_at: '2026-01-01T00:00:00Z' },
    { kind, status: 'running', queued_at: '2026-01-01T00:00:00Z' },
  ]))
  assert.deepEqual(activeTypingRuns(others, 'chat'), [])
  assert.deepEqual(activeTypingRuns(others, 'solo_chat'), [])
  const ended = ['succeeded', 'failed', 'canceled'].map(status => ({ kind: 'chat', status, queued_at: '2026-01-01T00:00:00Z' }))
  assert.deepEqual(activeTypingRuns(ended, 'chat'), [])
})

test('群聊与单聊渲染接线状态行，样式含 .typing-row 与三点跳动 keyframes', () => {
  assert.match(source, /typingRows\(state\.data\.runs, 'chat'\)/)
  assert.match(source, /typingRows\(runs, 'solo_chat'\)/)
  assert.match(source, /class="run-clock" data-started="\$\{attr\(row\.startedAt \?\? ''\)\}"/)
  const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')
  assert.match(css, /\.typing-row\s*\{/)
  assert.match(css, /\.typing-dots i\s*\{/)
  assert.match(css, /@keyframes typing-bounce/)
})
