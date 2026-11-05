// DSHBOTS-241：bot 额度墙状态的展示块。
// 主 provider 耗尽期内派发走备用模型或排队等待；这里给出恢复时间与「解除额度耗尽」入口
// （立即恢复派发，服务端限 owner/总监，见 src/services/bot-quota.ts）。
import { attr, esc, formatTime } from './util.js'
import { t } from './i18n.js'

export function botQuotaBlock(bot) {
  const quota = bot?.quota
  const primary = quota?.primary
  if (!primary) return ''
  const exhausted = Boolean(quota?.exhausted)
  const status = exhausted ? t("额度耗尽") : t("额度正常")
  const reset = exhausted && primary.resetAt
    ? `<div class="kv"><span>${t("预计恢复")}</span><strong>${esc(formatTime(primary.resetAt))}</strong></div>`
    : ''
  const fallback = quota?.fallback?.exhausted
    ? `<div class="kv"><span>${t("备用模型")}</span><strong>${t("同样耗尽")}</strong></div>`
    : ''
  const action = exhausted
    ? `<button class="btn small" type="button" data-action="release-bot-quota" data-bot-id="${attr(bot.id)}">${t("解除额度耗尽")}</button>`
    : ''
  return `<div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:9px">${t("额度状态")}</div>
        <div class="kv"><span>${t("主模型")}</span><strong>${esc(primary.provider ?? '')}</strong></div>
        <div class="kv"><span>${t("额度")}</span><strong>${status}</strong></div>
        ${reset}${fallback}${action}`
}
