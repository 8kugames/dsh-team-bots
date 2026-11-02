import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const block = /\/\/ fallback-model:start[\s\S]*?\/\/ fallback-model:end/.exec(source)?.[0]
assert.ok(block, 'ui/app.js 缺少 fallback-model 标记块')

const { parseFallbackFields } = new Function(`${block}\nreturn { parseFallbackFields }`)()

test('备用模型 ref 拆成 provider/model，effort 可空', () => {
  assert.deepEqual(parseFallbackFields('deepseek/deepseek-chat', 'high'), {
    fallbackProvider: 'deepseek',
    fallbackModel: 'deepseek-chat',
    fallbackEffort: 'high',
  })
  assert.deepEqual(parseFallbackFields('deepseek/deepseek-chat', ''), {
    fallbackProvider: 'deepseek',
    fallbackModel: 'deepseek-chat',
    fallbackEffort: null,
  })
})

test('留空 = 不启用：三个字段一起清空', () => {
  assert.deepEqual(parseFallbackFields('', 'high'), {
    fallbackProvider: null,
    fallbackModel: null,
    fallbackEffort: null,
  })
  assert.deepEqual(parseFallbackFields(undefined, undefined), {
    fallbackProvider: null,
    fallbackModel: null,
    fallbackEffort: null,
  })
})

test('单聊配置页有备用模型与备用推理强度两个下拉', () => {
  const solo = /function renderSoloConfig\(\)[\s\S]*?\n  \}/.exec(source)?.[0]
  assert.ok(solo, '找不到 renderSoloConfig')
  assert.match(solo, /name="fallbackModelRef" data-fallback-model-select/, '单聊页有备用模型下拉')
  assert.match(solo, /name="fallbackEffort" data-fallback-effort-select/, '单聊页有备用推理强度下拉')
  assert.match(solo, /fallbackModelOptions\(bot\.fallbackModelRef \?\? ''\)/, '单聊页回填当前备用模型')
})

test('总览 bots 表单有备用模型与备用推理强度两个下拉', () => {
  const modal = /function modalBot\(detail\)[\s\S]*?\n  \}/.exec(source)?.[0]
  assert.ok(modal, '找不到 modalBot')
  assert.match(modal, /id="bot-fallback-model" name="fallbackModelRef" data-fallback-model-select/, '总览表单有备用模型下拉')
  assert.match(modal, /id="bot-fallback-effort" name="fallbackEffort" data-fallback-effort-select/, '总览表单有备用推理强度下拉')
  assert.match(modal, /fallbackModelOptions\(bot\?\.fallbackModelRef \?\? ''\)/, '总览表单回填当前备用模型')
})

test('备用模型下拉首项为「不启用（留空）」，选项取自同一模型表', () => {
  const fn = /function fallbackModelOptions\(currentRef\)[\s\S]*?\n  \}/.exec(source)?.[0]
  assert.ok(fn, '找不到 fallbackModelOptions')
  assert.match(fn, /<option value=""\$\{currentRef \? '' : ' selected'\}>不启用（留空）<\/option>/, '首项留空即不启用')
  assert.match(fn, /state\.data\?\.models \?\? \[\]/, '选项与主模型同一张模型表')
})

test('备用推理强度跟随备用模型变化', () => {
  assert.match(source, /if \(el\.matches\('\[data-fallback-model-select\]'\)\) updateFallbackEffortOptions\(el\)/, '切换备用模型时刷新强度选项')
  const fn = /function updateFallbackEffortOptions\(select\)[\s\S]*?\n  \}/.exec(source)?.[0]
  assert.ok(fn, '找不到 updateFallbackEffortOptions')
  assert.match(fn, /\[data-fallback-effort-select\]/, '刷新的是备用强度下拉')
  assert.match(fn, /effortOptions\(select\.value, ''\)/, '强度选项按当前备用模型取')
})

test('保存走既有 update bot 通道，带上三个备用字段', () => {
  const handler = /if \(type === 'create-bot' \|\| type === 'update-bot'\) \{[\s\S]*?\n      \}/.exec(source)?.[0]
  assert.ok(handler, '找不到 bot 表单提交处理')
  assert.match(handler, /parseFallbackFields\(payload\.fallbackModelRef, payload\.fallbackEffort\)/, '提交前解析备用字段')
  assert.match(handler, /fallbackProvider: fallback\.fallbackProvider/, '提交带 fallbackProvider')
  assert.match(handler, /fallbackModel: fallback\.fallbackModel/, '提交带 fallbackModel')
  assert.match(handler, /fallbackEffort: fallback\.fallbackEffort/, '提交带 fallbackEffort')
  assert.match(handler, /api\('update_bot', \{ botId: payload\.botId, patch: common \}\)/, '走既有 update_bot 通道')
})
