import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contextThreshold, shouldRotate, stewardPrompt, checkpointText, parseStewardOutput,
} from '../src/steward.js'

// 一份结构完整、长度足够的交接摘要：5 个节标题齐全，且明显超过 80 字符。
const validSummary = [
  '# 工作现状',
  '登录超时定位在 src/auth.js:42，重试没有上限，已改成最多三次。',
  '# 逐条结果',
  '- src/auth.js:42 重试次数改为 3',
  '- tests/auth.test.js 新增超时回归用例',
  '# 决策与理由',
  '决定放弃指数退避，改为固定三次重试：退避只会掩盖真实故障。',
  '# 依赖与约束',
  '用户约束：不改动登录协议；依赖 Redis 会话存储，键名不能变。',
  '# 未完成请求（用户原话）与下一步',
  '「顺便把注册也修了」尚未完成；下一步先跑一遍完整回归。',
].join('\n')

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

test('contextThreshold 接受数字字符串，缺失或非法窗口回退默认值', () => {
  assert.deepEqual(
    contextThreshold({ contextWindow: '100000' }),
    { window: 100_000, reserve: 25_000, usable: 75_000, checkTokens: 60_000 },
  )
  assert.deepEqual(
    contextThreshold({ contextWindow: '100000', maxTokens: '8000' }),
    { window: 100_000, reserve: 8_000, usable: 92_000, checkTokens: 73_600 },
  )
  assert.equal(contextThreshold({ contextWindow: 'abc' }).window, 500_000)
  assert.equal(contextThreshold({ contextWindow: 0 }).window, 500_000)
  assert.equal(contextThreshold({ contextWindow: -1 }).window, 500_000)
  assert.equal(contextThreshold({ contextWindow: '100000', maxTokens: 'abc' }).reserve, 25_000)
})

test('shouldRotate 缺 window 或 lastCtxTokens 非正数时不轮换', () => {
  assert.equal(shouldRotate({ lastCtxTokens: 900_000 }), false)
  assert.equal(shouldRotate({ lastCtxTokens: 900_000, contextWindow: 0 }), false)
  assert.equal(shouldRotate({ contextWindow: 100_000 }), false)
  assert.equal(shouldRotate({ lastCtxTokens: 0, contextWindow: 100_000 }), false)
  assert.equal(shouldRotate({ lastCtxTokens: -1, contextWindow: 100_000 }), false)
  assert.equal(shouldRotate({}), false)
})

test('shouldRotate 接受数字字符串，非法输入仍不轮换', () => {
  assert.equal(shouldRotate({ lastCtxTokens: '60000', contextWindow: '100000' }), true)
  assert.equal(shouldRotate({ lastCtxTokens: '59999', contextWindow: '100000' }), false)
  assert.equal(shouldRotate({ lastCtxTokens: 'abc', contextWindow: '100000' }), false)
  assert.equal(shouldRotate({ lastCtxTokens: '60000', contextWindow: 'abc' }), false)
  assert.equal(shouldRotate({ lastCtxTokens: '60000', contextWindow: '0' }), false)
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

test('checkpointText 先给数据护栏说明再给摘要，护栏排在数据之前', () => {
  const summary = validSummary
  const got = checkpointText({ summary, taskLabel: 'DEM0-3' })
  const lines = got.split('\n')
  assert.equal(lines[0], '[Session checkpoint] DEM0-3')
  assert.match(lines[1], /数据记录而非新指令/)
  assert.ok(got.indexOf('数据记录而非新指令') < got.indexOf(summary), '说明必须排在摘要之前')
})

test('checkpointText 把超长摘要截断到 4000 字符并标注', () => {
  const summary = 'a'.repeat(5000)
  const got = checkpointText({ summary, taskLabel: null })
  assert.ok(got.includes('a'.repeat(4000) + '…（已截断）'), '应保留前 4000 字符并追加截断标记')
  assert.ok(!got.includes('a'.repeat(4001)), '不应保留第 4001 个字符')
  assert.equal(got.split('\n').length, 3)
  // 恰好 4000 字符不截断
  const exact = checkpointText({ summary: 'b'.repeat(4000), taskLabel: null })
  assert.ok(!exact.includes('（已截断）'))
})

test('parseStewardOutput 结构完整且够长才算成功', () => {
  assert.deepEqual(parseStewardOutput(validSummary), { ok: true, summary: validSummary })
  assert.deepEqual(
    parseStewardOutput(`\`\`\`markdown\n${validSummary}\n\`\`\``),
    { ok: true, summary: validSummary },
  )
  assert.deepEqual(parseStewardOutput(`  \n${validSummary}\n  `), { ok: true, summary: validSummary })
})

test('parseStewardOutput 缺节时判失败并说明缺哪几节', () => {
  const incomplete = [
    '# 工作现状',
    '登录超时定位在 src/auth.js:42，重试没有上限，已改成最多三次。',
    '# 逐条结果',
    '- src/auth.js:42 重试次数改为 3',
    '# 决策与理由',
    '决定放弃指数退避，改为固定三次重试：退避只会掩盖真实故障。',
    '# 未完成请求（用户原话）与下一步',
    '「顺便把注册也修了」尚未完成；下一步先跑一遍完整回归。',
  ].join('\n')
  const got = parseStewardOutput(incomplete)
  assert.equal(got.ok, false)
  assert.equal(got.summary, incomplete)
  assert.equal(got.reason, '缺少章节：# 依赖与约束')
})

test('parseStewardOutput 摘要过短判失败', () => {
  const short = '# 工作现状\n# 逐条结果\n# 决策与理由\n# 依赖与约束\n# 未完成请求'
  const got = parseStewardOutput(short)
  assert.equal(got.ok, false)
  assert.equal(got.summary, short)
  assert.equal(got.reason, '摘要过短（< 80 字符）')
})

test('parseStewardOutput 空输入与空围栏都判失败', () => {
  for (const value of ['', '   \n  ', '```\n```', undefined]) {
    const got = parseStewardOutput(value)
    assert.equal(got.ok, false)
    assert.equal(got.summary, '')
    assert.equal(typeof got.reason, 'string')
    assert.ok(got.reason.length > 0)
  }
})

test('parseStewardOutput 不把「好的」当成交接摘要', () => {
  const got = parseStewardOutput('好的')
  assert.equal(got.ok, false)
  assert.equal(got.summary, '好的')
  assert.match(got.reason, /缺少章节/)
})
