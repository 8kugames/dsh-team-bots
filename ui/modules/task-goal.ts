// 任务 Goal（版本化锚点）：新建弹窗的填写字段、详情弹窗的版本展示与编辑态。
// 独立成模块同 bot-quota.ts：modal-forms.ts / tasks.ts 都已贴到 800 行铁律。
import { state } from './state.js'
import { attr, esc } from './util.js'
import { icon } from './icons.js'
import { t } from './i18n.js'

// goal-fields:start —— Goal 表单字段的纯逻辑（tests/task-goal-ui.test.js 抽取此块断言）
// 完成标准按行拆分：逐行去首尾空白、丢空行。
function splitGoalCriteria(text) {
  return String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}
// 两个 textarea 的值 → { goal, error }。两项全空 = 未设置（goal=null、error=''）；只填一项不完整，
// error 带提示文案。required=true（改目标）时两项全空同样按不完整处理：update_task 的 goal 补丁
// 没有「清空」语义。
function parseGoalFields(statementText, criteriaText, { required = false } = {}) {
  const statement = String(statementText ?? '').trim()
  const criteria = splitGoalCriteria(criteriaText)
  if (!statement && criteria.length === 0 && !required) return { goal: null, error: '' }
  if (!statement || criteria.length === 0) return { goal: null, error: t("设置 Goal 需要同时填写目标陈述和至少一条完成标准") }
  return { goal: { statement, criteria }, error: '' }
}
// goal-fields:end

// 两个选填字段：目标陈述 + 完成标准（每行一条）。新建表单与详情编辑态共用，idPrefix 区分控件 id；
// hint 挂在完成标准下方（新建表单讲填写规则，编辑态不留，改由按钮下方讲保存后果）。
function goalFieldsHtml(idPrefix, { statement = '', criteria = [], hint = '' } = {}) {
  return `<div class="field"><label id="${idPrefix}-statement-label" for="${idPrefix}-statement">${t("目标陈述")}</label><textarea class="textarea" id="${idPrefix}-statement" name="goal_statement" rows="3" maxlength="2000" placeholder="${t("这个任务要达成的结果")}">${esc(statement)}</textarea></div>
      <div class="field"><label id="${idPrefix}-criteria-label" for="${idPrefix}-criteria">${t("完成标准（每行一条）")}</label><textarea class="textarea" id="${idPrefix}-criteria" name="completion_criteria" rows="4">${esc(criteria.join('\n'))}</textarea>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`
}

// 详情弹窗的 Goal 块（与写范围段同构）：查看态 = 版本徽标 + 目标陈述 + 编号完成标准；
// 编辑态 = 两个 textarea 预填当前内容 + 保存/取消。终态卡（done/canceled）不给入口，与写范围终态闸同口径。
function taskGoalBlock(task) {
  const modal = state.modal?.type === 'task' && state.modal?.detail?.id === task.id ? state.modal : null
  const editing = modal?.editingGoal === true
  const editable = !['done', 'canceled'].includes(task.status)
  const goal = task.goal ?? null
  const criteria = Array.isArray(goal?.criteria) ? goal.criteria : []
  const head = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div class="eyebrow">Goal</div>${goal ? `<span class="pill">v${esc(goal.version)}</span>` : ''}${editable && !editing ? `<button class="btn small" type="button" style="margin-left:auto" data-action="edit-goal" data-task-id="${attr(task.id)}">${icon('edit')}${goal ? t("编辑") : t("设置 Goal")}</button>` : ''}</div>`
  const view = goal
    ? `<div class="note" style="color:var(--ink);white-space:pre-wrap">${esc(goal.statement)}</div>
          <div class="note" style="color:var(--ink);display:grid;gap:4px;margin-top:4px">${criteria.map((item, index) => `<div><span class="mono">${esc(item?.id ?? `C${index + 1}`)}.</span> ${esc(item?.text ?? '')}</div>`).join('')}</div>
          <div class="hint" style="margin-top:6px">${t("验收时会对照当前版本逐条核对；修改会产生新版本")}</div>`
    : `<div class="scope-empty">${t("尚未设置 Goal")}</div>`
  const edit = `${goalFieldsHtml('task-goal', { statement: goal?.statement ?? '', criteria: criteria.map(item => String(item?.text ?? '')) })}
          <div class="btn-row" style="margin-top:7px"><button class="btn small primary" type="button" data-action="update-goal" data-task-id="${attr(task.id)}">${icon('check')}${t("保存")}</button><button class="btn small" type="button" data-action="cancel-goal-edit">${t("取消")}</button></div>
          <div class="hint" style="margin-top:6px">${t("保存后生成新版本并通知负责人；内容未变则不升版本")}</div>`
  return `<div class="scope-block">
          ${head}
          ${editing ? edit : view}
        </div>`
}

export { parseGoalFields, goalFieldsHtml, taskGoalBlock }
