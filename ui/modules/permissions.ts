import { state } from './state.js'
import { t } from './i18n.js'
import { icon } from './icons.js'
import { attr, botById, esc } from './util.js'

// 免审权限卡（DSHBOTS-365 编辑面在总览 bots 页）：每条规则一张独立卡片，只读展示 chip 摘要；
// 新增/编辑一律拉起 modal（modal-forms 的 approval-rule 弹窗）。
// 服务端权威不变：保存 = 弹窗整行提交 → update_approval_rules 整表替换；删除 = 去行后整表提交；
// 改规则即时生效，每次调用一放行一结。
const APPROVAL_RULE_SANDBOXES = ['', 'workspace-write', 'danger-full-access']
export { APPROVAL_RULE_SANDBOXES }

// 摘要行：只显示已设的条件，标签带在 chip 里，不让占位文案看起来像真值。
function approvalRuleChips(rule: Record<string, string>) {
  const chip = (labelKey: string, value: string) => `<span class="approval-chip mono" title="${attr(value)}">${t(labelKey)} ${esc(value)}</span>`
  const chips: string[] = []
  if (rule.path_prefix) chips.push(chip('global.approvalRuleChipPath', rule.path_prefix))
  if (rule.command) chips.push(chip('global.approvalRuleChipCommand', rule.command))
  if (rule.bot_id) chips.push(chip('global.approvalRuleChipBot', botById(rule.bot_id)?.name ?? rule.bot_id))
  if (rule.tool_name) chips.push(chip('global.approvalRuleChipTool', rule.tool_name))
  if (rule.sandbox) chips.push(chip('global.approvalRuleChipSandbox', rule.sandbox))
  return chips.join('')
}

function renderApprovalPermissionsCard() {
  const rules = (state.data?.approvalRules ?? []) as Array<Record<string, string>>
  // 完全权限总开关：卡顶独立开关行，开关态随 state.approvalFullAccess 下发。
  const fullAccess = Boolean(state.data?.approvalFullAccess)
  return `
    <section class="perm-section">
      <div class="section-head">
        <h3>${t('global.approvalPermissionsTitle')}</h3>
        <span class="meta">${t('global.approvalRulesMeta', { count: rules.length })}</span>
      </div>
      <div class="card perm-card">
        <div class="perm-full-access">
          <div class="perm-full-access-main">
            <div class="perm-full-access-title">${t('global.approvalFullAccess')}</div>
            <div class="perm-full-access-hint">${t('global.approvalFullAccessHint')}</div>
          </div>
          <button type="button" class="switch" role="switch" aria-checked="${fullAccess ? 'true' : 'false'}" aria-label="${attr(t('global.approvalFullAccess'))}" data-action="toggle-full-access" data-next="${fullAccess ? '0' : '1'}"><span class="switch-knob"></span></button>
        </div>
        ${rules.length === 0 ? `<div class="faint perm-empty">${t('global.approvalRulesEmpty')}</div>` : ''}
        <div class="perm-rule-grid">
          ${rules.map(rule => `
          <div class="perm-rule-card" data-approval-rule-id="${attr(rule.id)}">
            <div class="perm-rule-card-main">
              <div class="perm-rule-chips">${approvalRuleChips(rule) || `<span class="faint">${t('global.approvalRuleAny')}</span>`}</div>
              ${rule.note ? `<div class="perm-note" title="${attr(rule.note)}">${esc(rule.note)}</div>` : ''}
            </div>
            <div class="perm-rule-actions">
              <button class="btn small" type="button" data-action="approval-rule-edit" data-rule-id="${attr(rule.id)}">${icon('edit')}${t('global.approvalRuleEdit')}</button>
              <button class="btn small danger" type="button" data-action="approval-rule-delete" data-rule-id="${attr(rule.id)}">${t('global.approvalRuleDelete')}</button>
            </div>
          </div>`).join('')}
        </div>
        <div class="btn-row perm-add-row">
          <button class="btn small primary" type="button" data-action="approval-rule-new">${icon('plus')}${t('global.approvalRuleAdd')}</button>
        </div>
        <div class="hint">${t('global.approvalRulesHint')}</div>
      </div>
    </section>`
}

export { renderApprovalPermissionsCard }
