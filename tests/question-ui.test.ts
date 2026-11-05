// DSHBOTS-116 UI：提问卡片四态渲染 + 同卡多问的选项隔离。
// 沿用仓库先例：读源断言（tests/helpers/ui-sources.js）+ 标记块 new Function 执行真实源码
// （tests/approval-ui-states.test.js）。执行的是 ui/app.js 里的实现，不是复制一份到测试里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'
import './helpers/eval-shim.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const uiSource = readUiSource()
const stylesSource = await uiStylesSource()
const utilSource = readFileSync(join(root, 'ui', 'modules', 'util.js'), 'utf8')

const markerBlock = (name) => {
  const match = uiSource.match(new RegExp(`// ===== ${name}:start[\\s\\S]*?// ===== ${name}:end =====`))
  assert.ok(match, `${name} 标记块必须存在`)
  return match[0]
}

const formatTimeSource = utilSource.match(/export function formatTime\(value\) \{[\s\S]*?\n\}/)[0].replace(/^export /, '')
const formatTime = new Function(`${formatTimeSource}\nreturn formatTime`)()
const iconStub = (name) => `<svg data-icon="${name}"></svg>`
const escStub = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

// state 桩与前端同形：questionDraft 是 Map，questionAnswering 是 Set。
function makeState() {
  return { questionDraft: new Map(), questionAnswering: new Set(), data: { questions: [] } }
}

const card = (state) => new Function('state', 'icon', 'esc', 'attr', 'formatTime', `${formatTimeSource}
${markerBlock('question-card')}
return {
  QUESTION_STATUS,
  questionCardMarkup,
  renderQuestionCard,
  questionDraftOf,
  questionDraftSelection,
  questionSelectOption,
  questionOptionButton,
  formatQuestionCountdown,
  questionUrgent,
  questionRemainingFrom,
}`)(state, iconStub, escStub, escStub, formatTime)

const now = Date.now()
const baseQuestion = {
  id: 'qst_1',
  status: 'pending',
  botName: 'director',
  created_at: new Date(now - 1000).toISOString(),
  expires_at: new Date(now + 179_000).toISOString(),
  remainingMs: 179_000,
  questions: [
    { id: 'q1', question: '选哪个分支？', detail: '细节 <b>x</b>', options: [{ label: 'main', description: '主干' }, { label: 'dev' }] },
    { id: 'q2', question: '多选？', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] },
  ],
}

test('四态渲染：pending 可作答带倒计时，已决态只留 pill 与答案回显', () => {
  const state = makeState()
  const ui = card(state)
  const pending = ui.questionCardMarkup(baseQuestion)
  assert.match(pending, /data-action="question-submit"/, 'pending 有提交钮')
  assert.match(pending, /class="question-clock"/, 'pending 有倒计时')
  assert.match(pending, /剩余 2 分 59 秒/, '倒计时口径「剩余 X 分 Y 秒」')
  assert.match(pending, /class="question-progress"/, 'pending 有进度条')
  assert.match(pending, /aria-valuenow="\d+"/, '进度条带 aria-valuenow')
  assert.match(pending, /data-multi="1"/, '多选问题带 data-multi')
  assert.match(pending, /question-custom/, 'pending 每问都有补充说明输入框')

  const answered = ui.questionCardMarkup({
    ...baseQuestion,
    status: 'answered',
    answered_at: new Date(now).toISOString(),
    answer: { answers: [{ id: 'q1', selected: ['dev'], custom: '按现状' }, { id: 'q2', selected: [] }] },
  })
  assert.doesNotMatch(answered, /question-submit/, '已答态无提交钮')
  assert.match(answered, /question-pill is-answered/, '已答 pill')
  assert.match(answered, /dev/, '回显所选 label')
  assert.match(answered, /按现状/, '回显补充说明')
  assert.match(answered, /（未选择）/, '未答项兜底文案')

  assert.match(ui.questionCardMarkup({ ...baseQuestion, status: 'timeout' }), /已超时/, 'timeout pill')
  assert.match(ui.questionCardMarkup({ ...baseQuestion, status: 'expired' }), /已取消/, 'expired pill')
  assert.deepEqual(ui.QUESTION_STATUS, { pending: '等待回答', answered: '已回答', expired: '已取消', timeout: '已超时' })
})

test('同卡多问选项隔离：一问的单选不得清掉另一问的选择', () => {
  const state = makeState()
  const ui = card(state)
  const [q1, q2] = baseQuestion.questions
  const draft = ui.questionDraftOf(baseQuestion.id)
  // 先点 q1 的 main，再点 q2 的 x：两次点击应各自独立落桶。
  ui.questionSelectOption(draft, q1, 'main', false)
  assert.ok(draft.selected instanceof Map, '选择态按 itemId 分桶（Map）')
  assert.deepEqual([...ui.questionDraftSelection(draft, 'q1')], ['main'])
  assert.deepEqual([...ui.questionDraftSelection(draft, 'q2')], [], 'q2 仍为空，未被 q1 的单选清空')
  assert.match(ui.questionOptionButton(baseQuestion, q1, { label: 'main' }), /is-selected/, 'q1 main 渲染为选中')
  assert.doesNotMatch(ui.questionOptionButton(baseQuestion, q2, { label: 'x' }), /is-selected/, 'q2 未选时不得带选中态')
  // 再点 q2 的 x，q1 的 main 必须还在。
  ui.questionSelectOption(draft, q2, 'x', false)
  assert.match(ui.questionOptionButton(baseQuestion, q2, { label: 'x' }), /is-selected/, 'q2 x 渲染为选中')
  assert.deepEqual([...ui.questionDraftSelection(draft, 'q1')], ['main'], 'q1 选择未被 q2 覆盖')
  assert.deepEqual([...ui.questionDraftSelection(draft, 'q2')], ['x'])
})

test('单选互斥、多选可叠加，且 label 走转义', () => {
  const state = makeState()
  const ui = card(state)
  const [q1, q2] = baseQuestion.questions
  const draft = ui.questionDraftOf(baseQuestion.id)
  ui.questionSelectOption(draft, q1, 'main', false)
  // 同问改选 dev：单选互斥。
  ui.questionSelectOption(draft, q1, 'dev', false)
  assert.deepEqual([...ui.questionDraftSelection(draft, 'q1')], ['dev'])
  // 再点一次已选项 = 取消。
  ui.questionSelectOption(draft, q1, 'dev', false)
  assert.deepEqual([...ui.questionDraftSelection(draft, 'q1')], [])
  // 多选叠加，再点可取消。
  ui.questionSelectOption(draft, q2, 'x', true)
  ui.questionSelectOption(draft, q2, 'y', true)
  assert.deepEqual([...ui.questionDraftSelection(draft, 'q2')].sort(), ['x', 'y'])
  ui.questionSelectOption(draft, q2, 'x', true)
  assert.deepEqual([...ui.questionDraftSelection(draft, 'q2')], ['y'])
  // label 转义：尖括号不得原样进 data-label。
  const html = ui.questionOptionButton(baseQuestion, q1, { label: '<script>' })
  assert.doesNotMatch(html, /data-label="<script>"/)
  assert.match(html, /data-label="&lt;script&gt;"/)
})

test('renderQuestionCard 以 state.data.questions 为准，查不到退化为纯文本', () => {
  const state = makeState()
  const ui = card(state)
  state.data.questions = [baseQuestion]
  assert.match(ui.renderQuestionCard({ kind: 'question', question_id: 'qst_1', body: 'x' }), /question-card/)
  assert.match(ui.renderQuestionCard({ kind: 'question', question_id: 'missing', body: '兜底' }), /message-system/)
})

test('CSS：提问卡与窄条只用语义 token，无字面颜色', () => {
  const block = stylesSource.slice(
    stylesSource.indexOf('.question-card'),
    stylesSource.indexOf('.task-chip-line'),
  )
  assert.ok(block.length > 200, '提问卡 CSS 区块存在')
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, '不得出现字面十六进制颜色')
  assert.doesNotMatch(block, /\brgba?\(/, '不得出现 rgb/rgba 字面颜色')
  for (const selector of ['.question-card', '.question-option', '.question-custom', '.question-banner']) {
    assert.ok(block.includes(selector), `${selector} 有样式`)
  }
})
