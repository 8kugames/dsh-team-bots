import { state } from './state.js'
import { t } from './i18n.js'
import { icon } from './icons.js'
import { attr, esc } from './util.js'
import { modalShell } from './modal-layer.js'
import { APPROVAL_RULE_SANDBOXES } from './permissions.js'

// 免审规则新增/编辑弹窗：rule 为 null 即新增。保存走整表替换（events-submit 的
// save-approval-rule）：编辑保 id、新增不带 id 由后端发 arul_*。
export function modalApprovalRule(rule: Record<string, string> | null = null) {
  const bots = (state.data?.bots ?? []) as Array<{ id: string, name: string }>
  const value = (key: string) => attr(String(rule?.[key] ?? ''))
  return modalShell({
    title: rule ? t("编辑免审规则") : t("新增免审规则"),
    badge: '',
    body: `<form data-form="save-approval-rule" id="modal-form">
      <input type="hidden" name="ruleId" value="${value('id')}">
      <div class="field-row">
        <div class="field"><label id="approval-rule-path-label" for="approval-rule-path">${t('global.approvalRulePath')}</label><input class="input mono" style="width:100%" id="approval-rule-path" name="path_prefix" value="${value('path_prefix')}" placeholder="${attr(t('global.approvalRulePathExample'))}" maxlength="500"><div class="hint">${t('global.approvalRulePathHint')}</div></div>
        <div class="field"><label id="approval-rule-command-label" for="approval-rule-command">${t('global.approvalRuleCommand')}</label><input class="input mono" style="width:100%" id="approval-rule-command" name="command" value="${value('command')}" placeholder="${attr(t('global.approvalRuleCommandExample'))}" maxlength="200"><div class="hint">${t('global.approvalRuleCommandHint')}</div></div>
      </div>
      <div class="field-row">
        <div class="field"><label id="approval-rule-bot-label" for="approval-rule-bot">${t('global.approvalRuleBot')}</label><select class="select" style="width:100%" id="approval-rule-bot" name="bot_id"><option value="">${t('global.approvalRuleAny')}</option>${bots.map(bot => `<option value="${attr(bot.id)}" ${bot.id === String(rule?.bot_id ?? '') ? 'selected' : ''}>${esc(bot.name)}</option>`).join('')}</select></div>
        <div class="field"><label id="approval-rule-tool-label" for="approval-rule-tool">${t('global.approvalRuleTool')}</label><input class="input mono" style="width:100%" id="approval-rule-tool" name="tool_name" value="${value('tool_name')}" placeholder="bash" maxlength="100"></div>
        <div class="field"><label id="approval-rule-sandbox-label" for="approval-rule-sandbox">${t('global.approvalRuleSandbox')}</label><select class="select" style="width:100%" id="approval-rule-sandbox" name="sandbox">${APPROVAL_RULE_SANDBOXES.map(tier => `<option value="${tier}" ${tier === String(rule?.sandbox ?? '') ? 'selected' : ''}>${tier === '' ? t('global.approvalRuleAny') : tier}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label id="approval-rule-note-label" for="approval-rule-note">${t('global.approvalRuleNote')}</label><input class="input" style="width:100%" id="approval-rule-note" name="note" value="${value('note')}" maxlength="200"></div>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">${t("取消")}</button><button class="btn primary" type="submit" form="modal-form">${icon('check')}${t("保存规则")}</button>`,
  })
}
