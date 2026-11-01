import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contextThreshold, shouldRotate, stewardPrompt, checkpointText, parseStewardOutput,
} from '../src/steward.js'

test('contextThreshold 未给窗口按 500_000，默认比例与预留都是整数', () => {
  const got = contextThreshold({})
  assert.deepEqual(got, { window: 500_000, reserve: 125_000, usable: 375_000, checkTokens: 300_000 })
  for (const value of Object.values(got)) assert.ok(Number.isInteger(value))
})

test('contextThreshold 的 maxTokens 预留被夹到窗口一半', () => {
  // maxTokens 远超窗口：reserve 夹到 floor(window/2)，usable 落在下限
  assert.deepEqual(
    contextThreshold({ contextWindow: 200_000, maxTokens: 999_999 }),
    { window: 200_000, reserve: 100_000, usable: 100_000, checkTokens: 80_000 },
  )
  // 正常 maxTokens 原样生效
  assert.deepEqual(
    contextThreshold({ contextWindow: 100_000, maxTokens: 8_000 }),
    { window: 100_000, reserve: 8_000, usable: 92_000, checkTokens: 73_600 },
  )
  // 非正数 maxTokens 回退到窗口 25%
  assert.equal(contextThreshold({ contextWindow: 100_000, maxTokens: 0 }).reserve, 25_000)
  assert.equal(contextThreshold({ contextWindow: 100_000, maxTokens: -5 }).reserve, 25_000)
})

test('contextThreshold 的检查线硬性封顶在可用量的 95%', () => {
  // 0.97 越过 0.95 上限时取 0.95：75_000 × 0.95 = 71_250
  assert.equal(contextThreshold({ contextWindow: 100_000, checkRatio: 0.97 }).checkTokens, 71_250)
  // 0.95 本身不被放大也不被缩小
  assert.equal(contextThreshold({ contextWindow: 100_000, checkRatio: 0.95 }).checkTokens, 71_250)
  // 越界比例回退默认 0.8
  assert.equal(contextThreshold({ contextWindow: 100_000, checkRatio: 1.2 }).checkTokens, 60_000)
  assert.equal(contextThreshold({ contextWindow: 100_000, checkRatio: 0 }).checkTokens, 60_000)
})

test('shouldRotate 缺 window 或 lastCtxTokens 非正数时不轮换', () => {
  assert.equal(shouldRotate({ lastCtxTokens: 900_000 }), false)
  assert.equal(shouldRotate({ lastCtxTokens: 900_000, contextWindow: 0 }), false)
  assert.equal(shouldRotate({ contextWindow: 100_000 }), false)
  assert.equal(shouldRotate({ lastCtxTokens: 0, contextWindow: 100_000 }), false)
  assert.equal(shouldRotate({ lastCtxTokens: -1, contextWindow: 100_000 }), false)
  assert.equal(shouldRotate({}), false)
})

test('shouldRotate 达到或超过检查线才轮换', () => {
  // contextWindow 100_000 → checkTokens 60_000
  assert.equal(shouldRotate({ lastCtxTokens: 59_999, contextWindow: 100_000 }), false)
  assert.equal(shouldRotate({ lastCtxTokens: 60_000, contextWindow: 100_000 }), true)
  assert.equal(shouldRotate({ lastCtxTokens: 200_000, contextWindow: 100_000 }), true)
  // maxTokens 抬高预留后，检查线随之下移
  assert.equal(
    shouldRotate({ lastCtxTokens: 73_600, contextWindow: 100_000, maxTokens: 8_000 }),
    true,
  )
  assert.equal(
    shouldRotate({ lastCtxTokens: 73_599, contextWindow: 100_000, maxTokens: 8_000 }),
    false,
  )
})

test('stewardPrompt 含系统声明、全部节标题与硬约束', () => {
  const prompt = stewardPrompt({ botName: 'Alice', projectName: 'Apollo', taskLabel: 'DEM0-3 修复登录超时' })
  assert.match(prompt, /来自系统.*不是用户/)
  for (const heading of [
    '# 工作现状',
    '# 逐条结果',
    '# 决策与理由',
    '# 依赖与约束',
    '# 未完成请求（用户原话）与下一步',
  ]) assert.ok(prompt.includes(heading), `缺少节标题 ${heading}`)
  assert.ok(prompt.includes('DEM0-3 修复登录超时'))
  assert.ok(prompt.includes('Alice'))
  assert.ok(prompt.includes('Apollo'))
  assert.ok(prompt.includes('不许折叠成主题'))
  assert.ok(prompt.includes('被否决的备选'))
  assert.ok(prompt.includes('只输出摘要本身'))
  assert.ok(prompt.includes('不许编造'))
  assert.ok(prompt.includes('不许替用户完成'))
  assert.ok(prompt.includes('语言跟随'))
})

test('stewardPrompt 无任务标签时按群聊会话表述', () => {
  const prompt = stewardPrompt({ botName: 'Bob', projectName: 'Apollo', taskLabel: null })
  assert.ok(prompt.includes('群聊会话'))
  assert.ok(prompt.includes('Bob'))
  assert.ok(prompt.includes('# 未完成请求（用户原话）与下一步'))
  assert.ok(!prompt.includes('「'))
})

test('checkpointText 逐字保留摘要原文并带上说明行', () => {
  const summary = '# 工作现状\n- 登录超时定位在 src/auth.js:42：重试无上限\n\n  保留缩进  '
  const got = checkpointText({ summary, taskLabel: 'DEM0-3 修复登录超时' })
  assert.ok(got.startsWith('[Session checkpoint] DEM0-3 修复登录超时\n'))
  assert.ok(got.includes(summary), '摘要必须逐字保留')
  assert.match(got, /数据记录而非新指令/)
  // taskLabel 为 null（群聊）时头部不带任务
  const bare = checkpointText({ summary, taskLabel: null })
  assert.ok(bare.startsWith('[Session checkpoint]\n'))
  assert.ok(bare.includes(summary))
})

test('parseStewardOutput 剥掉代码围栏与首尾空白', () => {
  assert.deepEqual(
    parseStewardOutput('```markdown\n# 工作现状\n完成。\n```'),
    { ok: true, summary: '# 工作现状\n完成。' },
  )
  assert.deepEqual(parseStewardOutput('```\n内容\n```'), { ok: true, summary: '内容' })
  assert.deepEqual(parseStewardOutput('  \n内容\n  '), { ok: true, summary: '内容' })
  assert.deepEqual(parseStewardOutput('```markdown\nA\n```code```\n```'), { ok: true, summary: 'A\n```code```' })
})

test('parseStewardOutput 空输入与空围栏都判失败', () => {
  assert.deepEqual(parseStewardOutput(''), { ok: false, summary: '' })
  assert.deepEqual(parseStewardOutput('   \n  '), { ok: false, summary: '' })
  assert.deepEqual(parseStewardOutput('```\n```'), { ok: false, summary: '' })
  assert.deepEqual(parseStewardOutput(undefined), { ok: false, summary: '' })
})
