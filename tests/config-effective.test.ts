// tests/config-effective.test.ts —— DSHBOTS-309 审批/提问等待超时生效链守门。
// 默认 3→10 分钟（600_000ms）；settings 键 approval_timeout_minutes / question_timeout_minutes
// （分钟整数 [1,60]，越界/非法回退默认）；优先级与 run_timeout 同款——env 显式最高
// （resolveConfig 已烘进 config.*TimeoutMs）> settings > 默认。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveConfig, effectiveApprovalTimeoutMs, effectiveQuestionTimeoutMs, RUN_LIMIT_RANGES, APPROVAL_TIMEOUT_KEY, QUESTION_TIMEOUT_KEY } from '../src/config.js'

const cfg = (env: Record<string, string> = {}) => resolveConfig({ workspace: '/tmp/dsh-cfg-ws', dataDir: '/tmp/dsh-cfg-data', env: env as any } as any)

test('a) 默认 10 分钟生效：resolveConfig 默认值与 effective 空回退同为 600_000', () => {
  const savedA = process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
  const savedQ = process.env.DSH_TEAM_QUESTION_TIMEOUT_MS
  delete process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
  delete process.env.DSH_TEAM_QUESTION_TIMEOUT_MS
  try {
    const config = resolveConfig({ workspace: '/tmp/w', dataDir: '/tmp/d' } as any)
    assert.equal(config.approvalTimeoutMs, 600_000, 'approval 默认 600s（DSHBOTS-309 由 180s 上调）')
    assert.equal(config.questionTimeoutMs, 600_000, 'question 默认 600s')
    assert.equal(effectiveApprovalTimeoutMs(config), 600_000, '无 settings 回退默认')
    assert.equal(effectiveQuestionTimeoutMs(config), 600_000, '无 settings 回退默认')
  } finally {
    if (savedA === undefined) delete process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
    else process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS = savedA
    if (savedQ === undefined) delete process.env.DSH_TEAM_QUESTION_TIMEOUT_MS
    else process.env.DSH_TEAM_QUESTION_TIMEOUT_MS = savedQ
  }
})

test('b) settings 覆盖生效：分钟整数 [1,60] 生效，越界/非法回退默认', () => {
  const config = resolveConfig({ workspace: '/tmp/w', dataDir: '/tmp/d' } as any)
  const get = (v: string) => (key: string) => (key === APPROVAL_TIMEOUT_KEY ? v : null)
  assert.equal(effectiveApprovalTimeoutMs(config, get('5')), 300_000, 'settings 5 分钟 → 300s')
  assert.equal(effectiveQuestionTimeoutMs(config, (key: string) => (key === QUESTION_TIMEOUT_KEY ? '1' : null)), 60_000, 'question settings 1 分钟')
  for (const bad of ['0', '61', 'abc', '7.5', '']) {
    assert.equal(effectiveApprovalTimeoutMs(config, get(bad)), 600_000, `非法值 ${bad || '(空)'} 回退默认`)
  }
  assert.deepEqual(RUN_LIMIT_RANGES[APPROVAL_TIMEOUT_KEY], [1, 60], '范围表登记')
  assert.deepEqual(RUN_LIMIT_RANGES[QUESTION_TIMEOUT_KEY], [1, 60], '范围表登记')
})

test('c) env 显式最高（与 run_timeout 同款优先序）：env 在场时压过 settings', () => {
  const saved = process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
  try {
    process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS = '120000'
    const config = resolveConfig({ workspace: '/tmp/w', dataDir: '/tmp/d' } as any)
    assert.equal(config.approvalTimeoutMs, 120_000, 'env 烘进 resolveConfig')
    assert.equal(effectiveApprovalTimeoutMs(config, (key: string) => (key === APPROVAL_TIMEOUT_KEY ? '5' : null)), 120_000, 'env 显式 > settings（锚：与 effectiveRunLimits 同款优先序）')
  } finally {
    if (saved === undefined) delete process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS
    else process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS = saved
  }
})

test('d) UI 字段键存在（中英各一份，zh/en 键齐平）', () => {
  const zh = readFileSync(fileURLToPath(new URL('../ui/i18n/zh/settings.ts', import.meta.url)), 'utf8')
  const en = readFileSync(fileURLToPath(new URL('../ui/i18n/en/settings.ts', import.meta.url)), 'utf8')
  for (const key of ['global.approvalTimeoutLabel', 'global.questionTimeoutLabel']) {
    assert.ok(zh.includes(`"${key}"`), `zh 缺 ${key}`)
    assert.ok(en.includes(`"${key}"`), `en 缺 ${key}`)
  }
  const settingsModule = readFileSync(fileURLToPath(new URL('../ui/modules/settings.ts', import.meta.url)), 'utf8')
  assert.ok(settingsModule.includes('name="approval_timeout_minutes"'), '设置页审批字段输入框')
  assert.ok(settingsModule.includes('name="question_timeout_minutes"'), '设置页提问字段输入框')
})
