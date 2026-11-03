import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('dispatch page subagent card describes real capability, no placeholder', () => {
  const app = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8')
  assert.doesNotMatch(app, /待接入/)
  assert.doesNotMatch(app, /依赖 DSHBOTS-27/)
  assert.match(app, /<h3>\$\{t\('solo\.subagents'\)\}<\/h3>/)
  // DSHBOTS-120 起文案进字典：实质内容锁在 zh/en 字典值里（app.js 只留 t() 接线）。
  const zh = fs.readFileSync(path.join(root, 'ui/i18n/zh.js'), 'utf8')
  const en = fs.readFileSync(path.join(root, 'ui/i18n/en.js'), 'utf8')
  assert.match(zh, /bot 会话已内置 subagent \/ subagent_fork \/ workflow 工具/)
  assert.match(zh, /可在执行中自行派生子智能体并行加速/)
  assert.match(zh, /无需工作台额外编排/)
  assert.match(en, /subagent \/ subagent_fork \/ workflow/)
})

test('collaboration rules include subagent usage guidance', () => {
  const prompt = fs.readFileSync(path.join(root, 'src/services/runtime/prompt.js'), 'utf8')
  assert.match(prompt, /use `subagent` \/ `subagent_fork` to spawn child agents/)
  assert.match(prompt, /not governed by tasks\.write_scopes dispatch gates/)
  assert.match(prompt, /inherit the parent session sandbox/)
  assert.match(prompt, /review child-agent output yourself/)
})
