// proposal-card.ts —— 进化提案卡：进化页与收件箱共用同一张卡（差异、评估、审批按钮）。
import { state, PROPOSAL_STATUS, PROPOSAL_KIND } from './state.js'
import { icon } from './icons.js'
import { actorLabel, attr, botById, canaryText, esc, evaluationText, formatTime, proposalPreview, timeAgo } from './util.js'
import { t } from './i18n.js'
import { panelAttrs } from '../app.js'

// 提案差异文本：bot_update 逐字段对照当前档案，skill 给全文，其余回落到预览。
function proposalDiffBlocks(proposal) {
  const payload = proposal.payload ?? {}
  const bot = proposal.bot_id ? botById(proposal.bot_id) : null
  const blocks = []
  if (proposal.kind === 'bot_update' && bot) {
    const fields = [
      ['role', bot.role, payload.role],
      ['instructions', bot.instructions, payload.instructions],
      ['model', bot.modelRef ?? bot.model, payload.model ? `${payload.provider ?? bot.provider}/${payload.model}` : ''],
      ['effort', bot.effort, payload.effort]
    ]
    for (const [field, before, after] of fields) {
      if (!after || String(before ?? '') === String(after)) continue
      blocks.push(`${field}\n- ${before}\n+ ${after}`)
    }
  }
  if (proposal.kind === 'skill') {
    blocks.push(`skill ${payload.slug ?? payload.name ?? 'new'}\n+ ${payload.content ?? proposalPreview(proposal)}`)
  }
  if (!blocks.length) blocks.push(proposalPreview(proposal))
  return blocks.join('\n\n')
}

function proposalDiffView(proposal) {
  const diff = proposal?.diff
  if (diff && typeof diff === 'object') {
    const blocks = Object.entries(diff as Record<string, { from?: string; to?: string }>).map(([field, change]) => {
      const from = change?.from ?? ''
      const to = change?.to ?? ''
      if (!from && !to) return ''
      return `${field}\n- ${from}\n+ ${to}`
    }).filter(Boolean)
    if (blocks.length) return blocks.join('\n\n')
  }
  return proposalDiffBlocks(proposal)
}

// 提案卡（进化页与收件箱共用）：pending 出评估/通过并应用/拒绝，canary 出转正全量。
// primary 指定哪一张的「通过并应用」用主按钮，由调用方按待办顺序决定。
export function proposalCardMarkup(proposal, { primary = false } = {}) {
  const tone = proposal.status === 'approved' ? 'green' : proposal.status === 'rejected' ? 'red' : ''
  return `<article class="card proposal-card">
    <div class="card-head">
      <div class="proposal-head" style="flex:1;min-width:0">
        <div class="empty-symbol" style="width:34px;height:34px;border-radius:9px;margin:0">${icon(proposal.kind === 'skill' ? 'spark' : 'branch')}</div>
        <div class="list-main">
          <h3>${esc(proposal.title)}</h3>
          <p>${esc(proposal.rationale)}</p>
        </div>
      </div>
      <span class="pill ${tone}">${esc(PROPOSAL_STATUS[proposal.status] ?? proposal.status)}</span>
    </div>
    ${proposal.kind === 'workflow' ? `<div class="note">${t("工作流提案尚未支持执行。")}</div>` : ''}
    <div class="proposal-body" style="margin-top:0">${esc(proposalPreview(proposal).slice(0, 6000))}</div>
    <div class="list-meta"><span>${esc(PROPOSAL_KIND[proposal.kind] ?? proposal.kind)}</span>${proposal.botName ? `<span>${esc(proposal.botName)}</span>` : ''}<span>${esc(timeAgo(proposal.created_at))}</span>${proposal.decided_by ? `<span>${t("由")} ${esc(actorLabel(proposal.decided_by))} ${t("决定")}</span>` : ''}${proposal.approvedBy ? `<span>${t("审批人")} ${esc(actorLabel(proposal.approvedBy))}</span>` : ''}${proposal.appliedAt ? `<span>${t("已生效")} ${esc(formatTime(proposal.appliedAt))}</span>` : ''}${proposal.canary ? `<span>${t("灰度")} ${esc(canaryText(proposal.canary))}</span>` : ''}</div>
    ${proposal.evaluation ? `<div class="list-desc">${t("评估")} · ${esc(evaluationText(proposal.evaluation))}</div>` : ''}
    ${proposal.status === 'pending' ? `<details class="proposal-diff"${panelAttrs(state, `proposal:${proposal.id}`)}>
      <summary class="btn small">${icon('chevron', 'chev')}${t("查看差异")}</summary>
      <div class="proposal-body" style="margin-top:8px">${esc(proposalDiffView(proposal).slice(0, 4000))}</div>
    </details>
    <div class="proposal-actions end">
      <button class="btn small" data-action="evaluate-proposal" data-proposal-id="${attr(proposal.id)}" data-verdict="pass">${t("评估通过")}</button>
      <button class="btn small" data-action="evaluate-proposal" data-proposal-id="${attr(proposal.id)}" data-verdict="fail">${t("评估不通过")}</button>
      <button class="btn ${primary ? 'primary' : ''}" data-action="decide-proposal" data-proposal-id="${attr(proposal.id)}" data-decision="approved">${icon('check')}${t("通过并应用")}</button>
      <button class="btn" data-action="decide-proposal" data-proposal-id="${attr(proposal.id)}" data-decision="rejected">${t("拒绝")}</button>
    </div>` : ''}
    ${proposal.status === 'canary' ? `<div class="proposal-actions end">
      <button class="btn primary" data-action="promote-proposal" data-proposal-id="${attr(proposal.id)}">${icon('check')}${t("转正全量")}</button>
    </div>` : ''}
  </article>`
}
