// DSHBOTS-282 展示层路径 home 前缀转 ~：displayPath 纯函数行为 + prompt.ts 展示点源码锚。
// 原则守门：displayPath 只进提示词/文本输出层，真实路径解析/读写一律消费原始绝对路径。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { displayPath } from '../src/paths.js'

const HOME = '/home/alice'

test('displayPath：home 前缀绝对路径转 ~/ 形式', () => {
  assert.equal(displayPath('/home/alice/work/x', HOME), '~/work/x')
  assert.equal(displayPath('/home/alice', HOME), '~')
})

test('displayPath：非 home 前缀路径原样返回（含相似前缀兄弟目录）', () => {
  assert.equal(displayPath('/var/folders/tmp/x', HOME), '/var/folders/tmp/x')
  assert.equal(displayPath('/home/alice-public/x', HOME), '/home/alice-public/x')
  assert.equal(displayPath('relative/path', HOME), 'relative/path')
})

test('displayPath：已 ~ 形式幂等', () => {
  assert.equal(displayPath('~/work/x', HOME), '~/work/x')
  const once = displayPath('/home/alice/work/x', HOME)
  assert.equal(displayPath(once, HOME), once)
})

test('displayPath：空值安全', () => {
  assert.equal(displayPath('', HOME), '')
  assert.equal(displayPath(null, HOME), '')
  assert.equal(displayPath(undefined, HOME), '')
})

test('prompt.ts 展示点源码锚：Workspace/技能库/技能池挂载均套用 displayPath', () => {
  const source = readFileSync('src/services/runtime/prompt.ts', 'utf8')
  assert.match(source, /- Workspace: \$\{displayPath\(project\.production_dir \|\| join\(this\.config\.workspace, project\.slug\)\)\}/)
  assert.match(source, /Workspace: \$\{displayPath\(project\.production_dir \|\| join\(this\.config\.workspace, project\.slug\)\)\}/)
  assert.match(source, /mounted at \\`\$\{displayPath\(sharedSkills\)\}\/skills/)
  assert.match(source, /mounted at \\`\$\{displayPath\(projectDir\)\}\/\.agents\/skills/)
  assert.match(source, /conversation is \\`\$\{displayPath\(workspace\)\}/)
  assert.match(source, /Workspace: \$\{displayPath\(join\(this\.config\.workspace, '_the_bots', bot\.solo_dir\)\)\}/)
  // 裸注入旧写法不得回归
  assert.ok(!source.includes('${project.production_dir || join('))
  assert.ok(!source.includes('${this.config.skillRoot}'))
  assert.ok(!source.includes('${workspace}'))
  assert.ok(!source.includes('${projectDir}/'))
})
