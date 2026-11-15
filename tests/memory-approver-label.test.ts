import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'

const source = readUiSource()

function helper() {
  const matched = /function actorLabel\(raw\) \{[\s\S]*?\n {2}\}/.exec(source)
  assert.ok(matched, 'ui/app.js 需提供 actorLabel 助手统一渲染审批人')
  return matched[0]
}

test('审批人 bot 映射为「名称·角色标签」', () => {
  const body = helper()
  assert.match(body, /type === 'bot'/, '需识别 bot: 前缀的审批人标识')
  assert.match(body, /botById\(id\)/, 'bot 审批人需用 botById 查出名称与角色标签')
  assert.match(body, /\$\{bot\.name\}·\$\{bot\.role \|\| t\("成员"\)\}/, '需渲染为「名称·角色标签」')
  assert.match(body, /type === 'user'/, 'user/owner 侧需单独识别')
})

test('bot 已删除时回退短 id，不暴露完整原始 id', () => {
  const body = helper()
  assert.match(body, /已删除 Bot/, '需有删除回退标记')
  assert.match(body, /shortRefId\(id\)/, '回退需使用短 id')
  assert.match(
    source,
    /const shortRefId = \(id\) => String\(id \?\? ''\)\.slice\(-6\)/,
    '短 id 口径为末 6 位，对齐 team_recall 的 m_短id 写法',
  )
  assert.doesNotMatch(source, /esc\(memory\.approved_by\)/, '记忆卡不得再直接输出原始 approved_by')
})

test('记忆卡与提案卡走同一套名称映射', () => {
  assert.match(source, /\$\{t\("审批人"\)\} \$\{esc\(actorLabel\(memory\.approved_by\)\)\}/, '记忆卡审批人需走 actorLabel')
  assert.match(source, /\$\{t\("审批人"\)\} \$\{esc\(actorLabel\(proposal\.approvedBy\)\)\}/, '提案审批人需走 actorLabel')
  assert.match(source, /\$\{t\("由"\)\} \$\{esc\(actorLabel\(proposal\.decided_by\)\)\} \$\{t\("决定"\)\}/, '提案决定人需走 actorLabel')
})
