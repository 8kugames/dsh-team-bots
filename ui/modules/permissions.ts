import { state } from './state.js'
import { t } from './i18n.js'
import { icon } from './icons.js'
import { attr, botById, esc } from './util.js'
import { panelAttrs } from '../app.js'

// 免审权限卡（DSHBOTS-365 编辑面在总览 bots 页）：每条规则只露两件事——路径 glob 与命令 glob，
// 其余条件收进「更多条件」里，折叠态一行 chip 摘要占位。
// 服务端权威不变：保存 = 全量收集行 → update_approval_rules 整表替换；删除 = 去行后整表提交；
// 改规则即时生效，每次调用一放行一结。
const APPROVAL_RULE_SANDBOXES = ['', 'workspace-write', 'danger-full-access']

function approvalRuleFields(rule: Record<string, string>) {
  const bots = (state.data?.bots ?? []) as Array<{ id: string, name: string }>
  const hasMore = Boolean(rule.bot_id || rule.tool_name || rule.sandbox || rule.note)
  return `
      <div class="field-row">
        <div class="field">
          <span class="field-label">${t('global.approvalRulePath')}</span>
          <input class="input mono" data-field="path_prefix" value="${attr(rule.path_prefix ?? '')}" placeholder="${attr(t('global.approvalRulePathExample'))}" maxlength="500">
          <div class="hint">${t('global.approvalRulePathHint')}</div>
        </div>
        <div class="field">
          <span class="field-label">${t('global.approvalRuleCommand')}</span>
          <input class="input mono" data-field="command" value="${attr(rule.command ?? '')}" placeholder="${attr(t('global.approvalRuleCommandExample'))}" maxlength="200">
          <div class="hint">${t('global.approvalRuleCommandHint')}</div>
        </div>
      </div>
      <details class="perm-more"${hasMore ? ' open' : ''}>
        <summary class="perm-more-head">${t('global.approvalRuleMore')}</summary>
        <div class="field-row">
          <div class="field">
            <span class="field-label">${t('global.approvalRuleBot')}</span>
            <select class="select" data-field="bot_id"><option value="">${t('global.approvalRuleAny')}</option>${bots.map(bot => `<option value="${attr(bot.id)}" ${bot.id === (rule.bot_id ?? '') ? 'selected' : ''}>${esc(bot.name)}</option>`).join('')}</select>
          </div>
          <div class="field">
            <span class="field-label">${t('global.approvalRuleTool')}</span>
            <input class="input mono" data-field="tool_name" value="${attr(rule.tool_name ?? '')}" placeholder="bash" maxlength="100">
          </div>
          <div class="field">
            <span class="field-label">${t('global.approvalRuleSandbox')}</span>
            <select class="select" data-field="sandbox">${APPROVAL_RULE_SANDBOXES.map(tier => `<option value="${tier}" ${tier === (rule.sandbox ?? '') ? 'selected' : ''}>${tier === '' ? t('global.approvalRuleAny') : tier}</option>`).join('')}</select>
          </div>
          <div class="field">
            <span class="field-label">${t('global.approvalRuleNote')}</span>
            <input class="input" data-field="note" value="${attr(rule.note ?? '')}" maxlength="200">
          </div>
        </div>
      </details>`
}

// 摘要行：只显示已设的条件，标签带在 chip 里，不让占位文案看起来像真值。
function approvalRuleChips(rule: Record<string, string>) {
  const chip = (labelKey: string, value: string) => `<span class="approval-chip mono">${t(labelKey)} ${esc(value)}</span>`
  const chips: string[] = []
  if (rule.path_prefix) chips.push(chip('global.approvalRuleChipPath', rule.path_prefix))
  if (rule.command) chips.push(chip('global.approvalRuleChipCommand', rule.command))
  if (rule.bot_id) chips.push(chip('global.approvalRuleChipBot', botById(rule.bot_id)?.name ?? rule.bot_id))
  if (rule.tool_name) chips.push(chip('global.approvalRuleChipTool', rule.tool_name))
  if (rule.sandbox) chips.push(chip('global.approvalRuleChipSandbox', rule.sandbox))
  if (rule.note) chips.push(chip('global.approvalRuleChipNote', rule.note))
  return chips.join('')
}

function renderApprovalPermissionsCard() {
  const rules = (state.data?.approvalRules ?? []) as Array<Record<string, string>>
  const ruleBody = (rule: Record<string, string>, removeId: string) => `
          <div class="perm-rule-body">
            ${approvalRuleFields(rule)}
            <div class="btn-row">
              ${removeId ? `<button class="btn small danger" type="button" data-action="approval-rule-delete" data-rule-id="${attr(removeId)}">${t('global.approvalRuleDelete')}</button>` : ''}
              <button class="btn small primary" type="button" data-action="save-approval-rules">${t('global.saveApprovalRules')}</button>
            </div>
          </div>`
  return `
    <section class="perm-section">
      <div class="section-head">
        <h3>${t('global.approvalPermissionsTitle')}</h3>
        <span class="meta">${t('global.approvalRulesMeta', { count: rules.length })}</span>
      </div>
      <div class="card perm-card">
        ${rules.length === 0 ? `<div class="faint perm-empty">${t('global.approvalRulesEmpty')}</div>` : ''}
        ${rules.map(rule => `
        <details class="perm-rule" data-approval-rule-id="${attr(rule.id)}"${panelAttrs(state, `approval-rule:${rule.id}`)}>
          <summary class="perm-rule-head">
            ${approvalRuleChips(rule)}
            ${icon('chevron', 'perm-chev')}
          </summary>${ruleBody(rule, rule.id)}
        </details>`).join('')}
        <details class="perm-rule perm-rule-new" id="approval-rule-new"${panelAttrs(state, 'approval-rule:new')}>
          <summary class="perm-rule-head"><span class="perm-add">${icon('plus')}${t('global.approvalRuleAdd')}</span></summary>
          ${ruleBody({ path_prefix: '', command: '', bot_id: '', tool_name: '', sandbox: '', note: '' }, '')}
        </details>
        <div class="hint">${t('global.approvalRulesHint')}</div>
      </div>
    </section>`
}

export { renderApprovalPermissionsCard }
