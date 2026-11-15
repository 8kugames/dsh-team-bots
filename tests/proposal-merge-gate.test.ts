// tests/proposal-merge-gate.test.js —— DSHBOTS-271 进化 bot_update 融合稿闸门守门
// 纯函数级 + 源码级断言（不建库、不 mkdtemp），钉四件事：
// ① 纯替换稿（保留率低于 MERGE_KEEP_RATIO=0.6）被拒，拒绝文案含融合稿指引（原因+替代，D-269 口径）；
// ② 融合稿（原指令非空行全保留+追加新内容）与首次立指令（原 instructions 为空）放行；
// ③ 应用侧复核与创建侧共用同一校验函数 assertMergeDraft：createProposal 与 applyProposal
//    （decideProposal 审批落地的唯一入口）源码均须调用它，防创建后原稿漂移或绕过创建路径；
// ④ team_propose_evolution 工具描述含 memory-first 口径与融合稿口径，参数 schema 结构不变。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MERGE_KEEP_RATIO,
  MERGE_DRAFT_GUIDANCE,
  mergeKeepRatio,
  assertMergeDraft,
} from '../src/services/proposals.js'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const proposalsSource = read('../src/services/proposals.ts')
const toolsSource = read('../src/tools.ts')

// 从服务文件提取方法体（签名起始到下一个顶层方法收尾），沿用 tool-denial-guidance 手法。
function methodBody(source, signature) {
  const at = source.indexOf(signature)
  assert.ok(at >= 0, `应存在方法 ${signature}`)
  return source.slice(at, source.indexOf('\n  },', at))
}

// 从 tools.ts 提取指定工具的 description 字符串字面量（含转义还原）。
function toolDescription(name) {
  const at = toolsSource.indexOf(`name: '${name}',`)
  assert.ok(at >= 0, `tools.ts 应注册 ${name}`)
  const descAt = toolsSource.indexOf('description: ', at)
  const open = toolsSource.indexOf("'", descAt)
  let out = ''
  for (let i = open + 1; i < toolsSource.length; i++) {
    const ch = toolsSource[i]
    if (ch === '\\') { out += toolsSource[i + 1]; i++; continue }
    if (ch === "'") return out
    out += ch
  }
  throw new Error(`tools.ts 中 ${name} 的 description 未闭合`)
}

test('纯函数：纯替换稿保留率为 0 且被拒，拒绝文案含原因与融合稿指引', () => {
  const original = '你是一名代码审查员。\n逐行核对测试锚点。\n只在证据充分时放行。'
  const replacement = '你是产品经理。\n负责撰写需求文档。\n不参与代码审查。'
  assert.equal(mergeKeepRatio(original, replacement), 0)
  assert.throws(
    () => assertMergeDraft(original, replacement),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, 'BAD_REQUEST')
      assert.match(err.message, /保留率 0%.*低于 60%/, '拒绝文案应先给原因（保留率低于阈值）')
      assert.ok(err.message.includes(MERGE_DRAFT_GUIDANCE), '拒绝文案应含融合稿指引（替代动作）')
      assert.match(err.message, /保留原有指令全文/, '指引须写明保留原有指令全文再写改动')
      return true
    },
  )
})

test('纯函数：融合稿（原文全保留+追加）通过，保留率为 1', () => {
  const original = '你是一名代码审查员。\n逐行核对测试锚点。\n只在证据充分时放行。'
  const merged = `${original}\n新增：审查前先跑 npm test 基线。\n新增：结论必须附命令输出。`
  assert.equal(mergeKeepRatio(original, merged), 1)
  assert.equal(assertMergeDraft(original, merged), 1)
})

test('纯函数：原文为空（首次立指令）保留率恒为 1，直接放行', () => {
  assert.equal(mergeKeepRatio('', '全新的首份指令'), 1)
  assert.equal(mergeKeepRatio(null, '全新的首份指令'), 1)
  assert.equal(assertMergeDraft(undefined, '全新的首份指令'), 1)
})

test('纯函数：保留率阈值边界——恰达 0.6 放行，低于 0.6 拒绝；空行与首尾空白不参与计数', () => {
  const fiveLineOriginal = ['第一行职责。', '第二行职责。', '第三行职责。', '第四行职责。', '第五行职责。'].join('\n')
  const keepThree = ['第一行职责。', '第二行职责。', '第三行职责。', '新增职责。'].join('\n')
  const keepTwo = ['第一行职责。', '第二行职责。', '新增职责。', '另一新增职责。'].join('\n')
  assert.ok(Math.abs(mergeKeepRatio(fiveLineOriginal, keepThree) - 0.6) < 1e-9)
  assert.equal(assertMergeDraft(fiveLineOriginal, keepThree), 0.6)
  assert.throws(() => assertMergeDraft(fiveLineOriginal, keepTwo), /保留原有指令全文/)
  // trim 后为空的行不算原稿有效行：五行稿其中一行为空白，只剩四行有效行，保留三行即达标。
  const paddedOriginal = `第一行职责。\n\n  第二行职责。  \n第三行职责。\n第四行职责。`
  const paddedMerged = '第一行职责。\n第二行职责。\n第三行职责。\n新增职责。'
  assert.ok(Math.abs(mergeKeepRatio(paddedOriginal, paddedMerged) - 0.75) < 1e-9)
  assert.doesNotThrow(() => assertMergeDraft(paddedOriginal, paddedMerged))
  assert.equal(MERGE_KEEP_RATIO, 0.6)
})

test('源码：创建侧闸门——createProposal 对 bot_update instructions 调用 assertMergeDraft', () => {
  const body = methodBody(proposalsSource, 'async createProposal(')
  assert.match(body, /kind === 'bot_update' && payload\.instructions !== undefined/, '触发条件应为 bot_update 且 instructions 已提供')
  assert.match(body, /assertMergeDraft\(this\.botRow\(input\.botId\)\.instructions, payload\.instructions\)/, '须以当前原稿为基准校验')
})

test('源码：应用侧复核与创建侧同一校验函数——applyProposal 重跑 assertMergeDraft，decideProposal 审批落地只经 applyProposal', () => {
  const applyBody = methodBody(proposalsSource, 'async applyProposal(')
  assert.match(applyBody, /assertMergeDraft\(this\.botRow\(proposal\.bot_id\)\.instructions, payload\.instructions\)/, '应用前须按最新原稿复核同一闸门')
  const decideBody = methodBody(proposalsSource, 'async decideProposal(')
  assert.match(decideBody, /this\.applyProposal\(proposal, payload, canary, actor\)/, '审批应用入口应委托 applyProposal，不另起校验')
})

test('源码：首次立指令放行在 diff 留痕（firstInstructions 标记）', () => {
  const body = methodBody(proposalsSource, 'botProposalDiff(botId, payload)')
  assert.match(body, /firstInstructions/, '原 instructions 为空时 diff 应标记首立')
})

test('源码：team_propose_evolution 描述含 memory-first 口径与融合稿口径，参数 schema 结构不变', () => {
  const desc = toolDescription('team_propose_evolution')
  assert.match(desc.slice(0, 220), /memory first/i, '描述首部应声明事实/偏好优先走记忆')
  assert.match(desc, /team_remember/, '应点名 team_remember 作为记忆承载命令')
  assert.match(desc, /structural instruction\/skill changes/, '应写明只有结构性改指令/技能才走进化')
  const at = toolsSource.indexOf(`name: 'team_propose_evolution',`)
  const block = toolsSource.slice(at, toolsSource.indexOf('output:', at))
  assert.match(block, /instructions: \{ type: 'string', description: 'For bot_update: 进化指令必须是原指令\+新增内容的融合稿/, 'instructions 参数描述应为融合稿口径')
  assert.match(block, /保留原有指令全文/, '参数描述须写明保留原有指令全文再写改动')
  assert.match(block, /不是全新替换稿也不是增量补丁/, '参数描述须排除纯替换稿与增量补丁两种错误形态')
  assert.match(block, /required: \['kind', 'title', 'rationale'\]/, '参数 schema 的 required 结构不变')
  assert.match(block, /additionalProperties: false/, 'additionalProperties 约束不变')
  const props = [...block.matchAll(/^ {8}(\w+): \{ type: '/gm)].map(m => m[1])
  assert.deepEqual(
    props,
    ['kind', 'title', 'rationale', 'instructions', 'slug', 'name', 'description', 'content', 'version', 'evaluation'],
    '参数集合与顺序不变，不新增/删除参数',
  )
})
