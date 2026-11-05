// settings.js —— 设置/全局域：全局用量面板（含模型价格规则卡）、运行时效卡、运维卡、
// 项目设置页与全局配置页（renderGlobal，含 DSH 路径/DSH 服务卡）。通道/密钥页见 global-pages.js。
import { state } from './state.js'
import { t } from './i18n.js'
import { icon } from './icons.js'
import { activeBots, activeProject, attr, botById, esc, pathCode, tildePath } from './util.js'
import { notifyToggleView } from './cards.js'
import { usageBotRow, usageCurrency, usageDayPanel, usageDayTitle, usageListPanel, usageMetricCards, usageModelPanel, usagePageHead, usageProjectRow, usageRunRow, usageSection, usageSnapshot, usageWindowText } from './usage.js'
import { refresh, noProject } from '../app.js'
import { renderPriceCard } from './modal-forms.js'

function renderUsageGlobal() {
  const usage = usageSnapshot()
  const tier = usage.tiers?.global
  const byBot = tier?.byBot ?? usage.byBot ?? []
  const byProject = tier?.byProject ?? usage.byProject ?? []
  const byModel = tier?.byModel ?? usage.byModel ?? []
  const days = tier?.byDay ?? usage.byDay ?? []
  const totals = usage.global ?? {}
  const currency = usageCurrency(usage)
  const windowText = usageWindowText(usage)
  const dayTitle = usageDayTitle(usage)
  const focus = ['global', 'model', 'bot', 'project'].includes(state.usageScope) ? state.usageScope : 'global'
  const maxBot = Math.max(1, ...byBot.map(item => item.totalTokens ?? 0))
  const maxProject = Math.max(1, ...byProject.map(item => item.totalTokens ?? 0))
  const reconciliation = usage.reconciliation ?? null
  const unpriced = Number(totals.unpricedCalls ?? 0)
  const panels = {
    days: usageDayPanel(days),
    model: usageModelPanel(byModel, t('分模型'), `<span class="meta">${t('usage.count', { count: byModel.length })}</span>`, currency),
    bot: usageListPanel(t('分 Bot'), byBot.map(item => usageBotRow(item, maxBot, false, currency)), 'Bot'),
    project: usageListPanel(t('分项目'), byProject.map(item => usageProjectRow(item, maxProject, currency)), t('usage.colProject')),
  }
  // 口径切换只调展示顺序，四个维度始终可见（关键信息不折叠）。
  const order = {
    global: ['days', 'model', 'bot', 'project'],
    model: ['model', 'days', 'bot', 'project'],
    bot: ['bot', 'days', 'model', 'project'],
    project: ['project', 'days', 'model', 'bot'],
  }[focus]
  const overviewNotes = [
    unpriced > 0 ? `<div class="note warn-note">${t('usage.unpricedNote', { count: unpriced })}</div>` : '',
    Number(reconciliation?.mismatched ?? 0) > 0 ? `<div class="usage-note">${Number(reconciliation.mismatched)} ${t('次运行的用量记录对不上，数据可能不完整。')}</div>` : '',
  ].join('')
  return `
    ${usagePageHead(usage, t('usage.headGlobalHint'))}
    ${usageSection(
      t('全局用量总览'),
      t('usage.overviewGlobalDesc', { window: windowText }),
      `${overviewNotes}${usageMetricCards(totals, t('usage.scopeGlobal'), usage)}`,
    )}
    ${usageSection(
      t('usage.distTitle'),
      t('usage.distGlobalDesc', { dayTitle, window: windowText }),
      `<div class="usage-grid">${order.map(key => panels[key]).join('')}</div>`,
      `<div class="usage-seg">
        <span class="usage-seg-label">${t('usage.panelOrder')}</span>
        <div class="seg" role="group" aria-label="${t('usage.panelOrder')}">
          <button data-action="usage-scope" data-scope="global" aria-pressed="${focus === 'global'}">${t('usage.orderGlobal')}</button>
          <button data-action="usage-scope" data-scope="model" aria-pressed="${focus === 'model'}">${t('usage.orderModel')}</button>
          <button data-action="usage-scope" data-scope="bot" aria-pressed="${focus === 'bot'}">${t('usage.orderBot')}</button>
          <button data-action="usage-scope" data-scope="project" aria-pressed="${focus === 'project'}">${t('usage.orderProject')}</button>
        </div>
      </div>`,
    )}
    ${usageSection(
      t('usage.priceTitle'),
      t('usage.priceDesc'),
      renderPriceCard(),
    )}
  `
}

// 群聊「用量」tab：本群消耗汇总 + 本群分模型 + 本群各 bot，内容严格限本群。
function renderUsageDomain() {
  const usage = usageSnapshot()
  const tier = usage.tiers?.project
  const byModel = tier?.byModel ?? []
  const byBot = tier?.byBot ?? []
  const days = tier?.byDay ?? []
  const totals = usage.project ?? {}
  const currency = usageCurrency(usage)
  const windowText = usageWindowText(usage)
  const dayTitle = usageDayTitle(usage)
  const maxBot = Math.max(1, ...byBot.map(item => item.totalTokens ?? 0))
  const drillBot = state.usageBot ? botById(state.usageBot) : null
  const drillRuns = drillBot
    ? (state.data?.runs ?? []).filter(run => run.bot_id === drillBot.id)
    : []
  const unpriced = Number(totals.unpricedCalls ?? 0)
  const overviewNotes = [
    unpriced > 0 ? `<div class="note warn-note">${t('usage.unpricedNote', { count: unpriced })}</div>` : '',
    tier ? '' : `<div class="usage-note">${t('下方分组明细暂不可用，上方汇总仍按本群统计。')}</div>`,
  ].join('')
  return `
    ${usagePageHead(usage, t('usage.headDomainHint'), t('usage.scopeDomain'))}
    ${usageSection(
      t('本群用量总览'),
      t('usage.overviewDomainDesc', { window: windowText }),
      `${overviewNotes}${usageMetricCards(totals, t('usage.scopeDomain'), usage)}`,
    )}
    ${usageSection(
      t('usage.distTitleDomain'),
      t('usage.distDomainDesc', { dayTitle, window: windowText }),
      `<div class="usage-grid">
        ${usageDayPanel(days)}
        ${usageModelPanel(byModel, t('本群分模型'), '', currency)}
        ${usageListPanel(t('本群各 Bot'), byBot.map(item => usageBotRow(item, maxBot, true, currency)), 'Bot')}
      </div>`,
    )}
    ${drillBot ? usageSection(
      t('usage.drillRunsTitle', { name: drillBot.name }),
      t('usage.drillRunsDesc'),
      `<div class="card usage-panel">
        ${drillRuns.length === 0 ? `<div class="faint">${t('usage.drillEmpty')}</div>` : `<div class="run-list">${drillRuns.map(usageRunRow).join('')}</div>`}
      </div>`,
      `<button class="btn small" data-action="usage-clear-drill">${icon('close')}${t('usage.clearDrill')}</button>`,
    ) : ''}
  `
}

// 单聊「用量」tab：本 bot 汇总 + 本 bot 分模型，内容严格限本 bot。
function renderUsageSolo() {
  const usage = usageSnapshot()
  const tier = usage.tiers?.solo
  const byModel = tier?.byModel ?? []
  const days = tier?.byDay ?? []
  const totals = usage.solo ?? {}
  const currency = usageCurrency(usage)
  const windowText = usageWindowText(usage)
  const dayTitle = usageDayTitle(usage)
  const runs = (state.data?.solo?.runs ?? state.data?.runs ?? [])
    .filter(run => run.bot_id === state.soloBotId && (run.project_id ?? null) === null)
  const unpriced = Number(totals.unpricedCalls ?? 0)
  const overviewNotes = [
    unpriced > 0 ? `<div class="note warn-note">${t('usage.unpricedNote', { count: unpriced })}</div>` : '',
    usage.solo && tier ? '' : `<div class="usage-note">${t('该 Bot 的单聊明细暂不可用。')}</div>`,
  ].join('')
  return `
    ${usagePageHead(usage, t('usage.headSoloHint'), t('usage.scopeSolo'))}
    ${usageSection(
      t('该 Bot 用量总览'),
      t('usage.overviewSoloDesc', { window: windowText }),
      `${overviewNotes}${usageMetricCards(totals, t('usage.scopeSolo'), usage)}`,
    )}
    ${usageSection(
      t('usage.distTitleSolo'),
      t('usage.distSoloDesc', { dayTitle, window: windowText }),
      `<div class="usage-grid">
        ${usageDayPanel(days)}
        ${usageModelPanel(byModel, t('该 Bot 分模型'), '', currency)}
      </div>`,
    )}
    ${usageSection(
      t('usage.soloRunsTitle'),
      t('usage.soloRunsDesc'),
      `<div class="card usage-panel">
        <div class="card-head"><h3>${t('usage.runDetailTitle')}</h3><span class="meta">${t('usage.runCount', { count: runs.length })}</span></div>
        ${runs.length === 0 ? `<div class="faint">${t('usage.soloRunsEmpty')}</div>` : `<div class="run-list">${runs.map(usageRunRow).join('')}</div>`}
      </div>`,
    )}
  `
}

// 全局配置页「运行时效」卡：超时中止与无进展看门狗（分钟），保存走 update_settings。
// 输入框回填保存值（未保存时回填当前生效值）；卡头显示生效值。
function renderRunLimitsCard() {
  const settings = state.data.settings ?? {}
  const limits = state.data.runLimits ?? {}
  const savedRun = settings.run_timeout_minutes ?? ''
  const savedStall = settings.stall_watchdog_minutes ?? ''
  const runValue = savedRun !== '' ? savedRun : String(limits.runTimeoutMinutes ?? 120)
  // 看门狗保存值 '0'（关闭）合法，不能用 || 短路吞掉。
  const stallValue = savedStall !== '' ? savedStall : String(limits.stallTimeoutMinutes ?? 30)
  const envNames = [
    limits.runTimeoutEnv ? 'DSH_TEAM_RUN_TIMEOUT_MS' : '',
    limits.stallTimeoutEnv ? 'DSH_TEAM_STALL_TIMEOUT_MS' : '',
  ].filter(Boolean).join(' / ')
  const stallText = limits.stallTimeoutMinutes === 0
    ? t('global.stallOff')
    : t('global.stallMinutes', { minutes: limits.stallTimeoutMinutes ?? 30 })
  return `
    <div class="card form-card g-card">
      <div class="card-head"><h3>${t('global.cardRunLimits')}</h3><span class="meta">${t('global.runLimitsCurrent', { timeout: limits.runTimeoutMinutes ?? 120, stall: stallText })}</span></div>
      <div class="field-row">
        <div class="field"><label id="settings-run-timeout-label" for="settings-run-timeout">${t('global.runTimeoutLabel')}</label><input class="input mono" style="text-align:right" type="number" min="1" max="360" id="settings-run-timeout" name="run_timeout_minutes" value="${attr(runValue)}"></div>
        <div class="field"><label id="settings-stall-watchdog-label" for="settings-stall-watchdog">${t('global.stallWatchdogLabel')}</label><input class="input mono" style="text-align:right" type="number" min="0" max="360" id="settings-stall-watchdog" name="stall_watchdog_minutes" value="${attr(stallValue)}"></div>
      </div>
      <div class="hint">${t('global.runLimitsHint1')}</div>
      <div class="hint">${t('global.runLimitsHint2')}</div>
      ${envNames ? `<div class="hint">${t('global.runLimitsEnv', { names: envNames })}</div>` : ''}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn small" type="button" data-action="save-run-limits">${t('global.saveRunLimits')}</button>
      </div>
    </div>`
}

function renderOpsCard() {
  const settings = state.data.settings ?? {}
  const currency = settings.budget_currency || 'CNY'
  const num = value => (value === '' || value === undefined || value === null ? '' : String(value))
  return `
    <div class="card form-card g-card">
      <div class="card-head"><h3>${t('global.cardOps')}</h3></div>
      <div class="field-row">
        <div class="field">
          <label id="settings-currency-label" for="settings-currency">${t('global.budgetCurrency')}</label>
          <select class="select" id="settings-currency" name="budget_currency">
            ${['CNY', 'USD'].map(code => `<option value="${code}" ${code === currency ? 'selected' : ''}>${code}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label id="settings-memory-review-label" for="settings-memory-review">${t('global.memoryReview')}</label>
          <select class="select" id="settings-memory-review" name="memory_review">
            <option value="1" ${settings.memory_review !== '0' ? 'selected' : ''}>${t('global.on')}</option>
            <option value="0" ${settings.memory_review === '0' ? 'selected' : ''}>${t('global.off')}</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label id="settings-global-token-budget-label" for="settings-global-token-budget">${t('global.tokenBudget')}</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-global-token-budget" name="global_token_budget" value="${attr(num(settings.global_token_budget))}" placeholder="${t('global.unlimited')}"></div>
        <div class="field"><label id="settings-global-cost-budget-label" for="settings-global-cost-budget">${t('global.costBudget')}</label><input class="input mono" style="text-align:right" type="number" min="0" step="0.01" id="settings-global-cost-budget" name="global_cost_budget" value="${attr(num(settings.global_cost_budget))}" placeholder="${t('global.unlimited')}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label id="settings-retention-usage-label" for="settings-retention-usage">${t('global.retentionUsage')}</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-retention-usage" name="retention_usage_days" value="${attr(num(settings.retention_usage_days))}" placeholder="${t('global.forever')}"></div>
        <div class="field"><label id="settings-retention-run-label" for="settings-retention-run">${t('global.retentionRun')}</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-retention-run" name="retention_run_event_days" value="${attr(num(settings.retention_run_event_days))}" placeholder="${t('global.forever')}"></div>
      </div>
      <div class="field"><label id="settings-retention-message-label" for="settings-retention-message">${t('global.retentionMessage')}</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-retention-message" name="retention_message_days" value="${attr(num(settings.retention_message_days))}" placeholder="${t('global.forever')}"></div>
      <div class="hint">${t('global.opsHint')}</div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn small" type="button" data-action="save-settings">${t('global.saveSettings')}</button>
      </div>
    </div>`
}

// DSH 路径卡：只读展示本机 DSH 目录、工作区、共享技能根与数据目录。
function dshPathsCard() {
  const paths = state.data.paths ?? {}
  const copyPath = value => `<button class="btn icon small" type="button" data-action="copy" data-copy="${attr(value)}" title="${t('common.copyPath')}" aria-label="${t('common.copyPath')}">${icon('copy')}</button>`
  return `
    <div class="card form-card g-card">
      <div class="card-head"><h3>${t('global.cardDshPaths')}</h3><span class="meta">${t('global.readonly')}</span></div>
      <div class="path-row"><span>${t('global.pathDshHome')}</span>${pathCode(paths.dshHome ?? '~/.dsh')}${copyPath(paths.dshHome ?? '')}</div>
      <div class="path-row"><span>${t('global.pathWorkspace')}</span>${pathCode(tildePath(paths.workspace))}${copyPath(paths.workspace)}</div>
      <div class="path-row"><span>${t('global.pathSkills')}</span>${pathCode(paths.skillRoot)}${copyPath(paths.skillRoot)}</div>
      <div class="path-row"><span>${t('global.pathData')}</span>${pathCode(paths.dataDir)}${copyPath(paths.dataDir)}</div>
      <div class="hint">${t('global.dshPathsHint')}</div>
    </div>`
}

// DSH 服务卡：版本检查 + 投递失败提示（投递失败 kv 落在本卡尾部）。
function dshServiceCard() {
  const data = state.data
  // @ts-ignore 「DSH 服务」卡检查结果：loadState 只换 state.data，dshUpdate 存这里不被轮询盖掉。
  const update = state.dshUpdate
  const latestCell = (latest, available) => latest == null
    ? '<strong>—</strong>'
    : available
      ? `<strong>${esc(latest)} <span class="pill amber">${t('global.upgradable')}</span></strong>`
      : `<strong>${esc(latest)} <span class="pill green">${t('global.latest')}</span></strong>`
  const outbox = data.outbox ?? { pending: 0, failed: 0, delivered: 0 }
  return `
    <div class="card form-card g-card">
      <div class="card-head">
        <h3>${t('global.cardDshService')}</h3>
        <button class="btn small" data-action="check-dsh-update">${icon('refresh')}${t('global.checkUpdate')}</button>
      </div>
      <div class="kv"><span>${t('global.dshCurrentVersion')}</span><strong>${esc(data.dsh?.version ?? 'unknown')}</strong></div>
      <div class="kv"><span>${t('global.dshLatestVersion')}</span>${latestCell(update?.latest, update?.updateAvailable)}</div>
      <div class="kv"><span>${t('global.pluginCurrentVersion')}</span><strong>${esc(data.pluginVersion ?? 'unknown')}</strong></div>
      <div class="kv"><span>${t('global.pluginLatestVersion')}</span>${latestCell(update?.pluginLatest, update?.pluginUpdateAvailable)}</div>
      ${Number(outbox.failed ?? 0) > 0 ? `<div class="kv" style="margin-top:12px"><span>${t('global.outboxQueue')}</span><strong>${t('global.outboxFailed', { count: outbox.failed })}</strong></div>` : ''}
    </div>`
}

function renderSettings() {
  const project = activeProject()
  const copyPath = value => `<button class="btn icon small" type="button" data-action="copy" data-copy="${attr(value)}" title="复制路径" aria-label="复制路径">${icon('copy')}</button>`
  if (!project) return noProject()
  const members = activeBots()
  const owner = botById(project.owner_bot_id)
  return `
    <form id="project-settings-form" data-form="save-project">
      <div class="settings-grid">
        <div>
          <div class="card form-card">
            <div class="card-head"><h3>项目资料</h3><span class="meta">${esc(project.key ?? project.id)}</span></div>
            <input type="hidden" name="projectId" value="${attr(project.id)}">
            <div class="field"><label id="settings-name-label" for="settings-name">项目名称</label><input class="input" id="settings-name" name="name" value="${attr(project.name)}" maxlength="80"></div>
            <div class="field"><label id="settings-description-label" for="settings-description">项目描述</label><textarea class="textarea" id="settings-description" name="description">${esc(project.description || '')}</textarea></div>
            <div class="field-row">
              <div class="field"><label id="settings-owner-label" for="settings-owner">总监 Bot</label><select class="select" id="settings-owner" name="ownerBotId">${members.map(bot => `<option value="${attr(bot.id)}" ${bot.id === project.owner_bot_id ? 'selected' : ''}>${esc(bot.name)}</option>`).join('')}</select></div>
              <div class="field"><label id="settings-reply-mode-label" for="settings-reply-mode">群聊回复模式</label><select class="select" id="settings-reply-mode" name="replyMode"><option value="owner_first" ${project.group?.reply_mode !== 'everyone' ? 'selected' : ''}>总监优先</option><option value="everyone" ${project.group?.reply_mode === 'everyone' ? 'selected' : ''}>全员响应</option></select></div>
            </div>
          </div>
          <div class="card form-card" style="margin-top:12px">
            <div class="card-head"><h3>月度预算</h3></div>
            <div class="field-row">
              <div class="field"><label id="settings-token-budget-label" for="settings-token-budget">Token 预算</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-token-budget" name="tokenBudget" value="${project.token_budget ?? ''}" placeholder="不限制"></div>
              <div class="field"><label id="settings-cost-budget-label" for="settings-cost-budget">成本预算</label><input class="input mono" style="text-align:right" type="number" min="0" step="0.01" id="settings-cost-budget" name="costBudget" value="${project.cost_budget ?? ''}" placeholder="不限制"></div>
            </div>
            <div class="hint">超出预算时项目会提示预算已用尽。成本预算与模型价格使用同一币种计价。</div>
          </div>
          <div class="card form-card" style="margin-top:12px">
            <div class="card-head"><h3>${t('settings.codeHygieneTitle')}</h3></div>
            <div class="field">
              <label id="settings-code-hygiene-label" for="settings-code-hygiene">${t('settings.codeHygieneLimit')}</label>
              <input class="input mono" style="text-align:right" type="number" min="0" max="100000" id="settings-code-hygiene" name="codeHygieneLimitLines" value="${project.code_hygiene_limit_lines ?? ''}" placeholder="800">
              <div class="hint">${t('settings.codeHygieneHint')}</div>
            </div>
          </div>
        </div>
        <div>
          <div class="card form-card">
            <div class="card-head"><h3>工作区路径</h3></div>
            <div class="field">
              <label id="settings-production-label" for="settings-production">生产目录</label>
              <div style="display:flex;gap:8px"><input class="input mono" style="flex:1" id="settings-production" name="productionDir" value="${attr(project.production_dir ?? '')}" placeholder="/Users/you/repos/my-game（可选）"><button class="btn" type="button" data-action="pick-dir-open" data-picker-for="settings-production">${icon('folder')}选择</button></div>
              <div class="hint">Bots 的工作目录，可指向既有代码库；留空则用默认管理目录，切换后已有密钥会自动迁移并清理旧目录。</div>
              <div class="dir-picker" id="dir-picker-settings-production" hidden></div>
            </div>
            <div class="path-row"><span>当前生效</span>${pathCode(tildePath(project.workspace_path))}${copyPath(project.workspace_path)}</div>
            <div class="path-row"><span>管理数据</span>${pathCode(project.data_path ?? '')}${copyPath(project.data_path ?? '')}</div>
          </div>
          <div class="card form-card" style="margin-top:12px">
            <div class="card-head"><h3>项目状态</h3>${project.status === 'active' ? '<span class="pill green">运行中</span>' : '<span class="pill amber">已归档</span>'}</div>
            <div class="kv"><span>总监</span><strong>${esc(owner?.name ?? '未设置')}</strong></div>
            <div class="kv"><span>任务总数</span><strong>${project.stats.tasks}</strong></div>
            <div class="kv"><span>运行总数</span><strong>${project.stats.runs}</strong></div>
            ${project.status === 'active'
              ? `<div class="btn-row settings-danger-row" style="margin-top:12px;justify-content:flex-end"><button class="btn small danger" type="button" data-action="archive-project" data-project-id="${attr(project.id)}">归档项目</button></div>`
              : `<div class="hint" style="margin-top:10px">已归档项目停止新运行，工作区文件保留。项目再开会恢复为进行中；移除追踪会清理本项目的管理数据。</div>
                <div class="btn-row" style="margin-top:12px;justify-content:flex-end"><button class="btn small" type="button" data-action="remove-tracking-open" data-project-id="${attr(project.id)}" data-project-name="${attr(project.name)}">移除追踪</button><button class="btn small primary" type="button" data-action="reopen-project" data-project-id="${attr(project.id)}">项目再开</button></div>`}
          </div>
        </div>
      </div>
    </form>
  `
}

function currentScale() {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))
  return Number.isFinite(value) && value > 0 ? value : 1
}

// 分组信息架构（DSHBOTS-184）：一节 = 一组 = 一个锚点；组内是 12 列槽位，
// 槽位负责跨列排布，modal-forms 的价格卡因此不必改自己的结构。
function gsec(index, id, title, desc, body) {
  return `
      <section class="gsec" id="${id}" aria-labelledby="${id}-title">
        <div class="gsec-head">
          <span class="gsec-index mono">${index}</span>
          <div class="gsec-copy">
            <h3 class="gsec-title" id="${id}-title">${title}</h3>
            <p class="gsec-desc">${desc}</p>
          </div>
        </div>
        <div class="gsec-body">${body}</div>
      </section>`
}

function renderGlobal() {
  const data = state.data
  const scale = currentScale()
  // 语言下拉回填保存值；'auto' = 跟随 DSH 宿主 Language 设定（未保存时也按 auto 展示）。
  // 用 || 而非 ??：settingsView() 对未保存键返回 ''（见 core.js），空串必须回落 auto，否则三选项都不选中。
  const uiLanguage = data.settings?.ui_language || 'auto'
  const notify = notifyToggleView()
  return `
    <div class="global-page">
      <header class="global-head">
        <div class="global-head-copy">
          <p class="global-eyebrow">GLOBAL CONFIGURATION</p>
          <h2 class="global-title">${t('global.title')}</h2>
          <p class="global-desc">${t('global.desc')}</p>
        </div>
      </header>
      <nav class="global-nav" aria-label="${t('global.navLabel')}">
        <a class="global-nav-item" href="#g-pref">${t('global.groupPref')}</a>
        <a class="global-nav-item" href="#g-runtime">${t('global.groupRuntime')}</a>
        <a class="global-nav-item" href="#g-about">${t('global.groupAbout')}</a>
      </nav>
      ${gsec('01', 'g-pref', t('global.groupPref'), t('global.groupPrefDesc'), `
            <div class="g-slot g-slot--full">
            <div class="card form-card g-card">
              <div class="card-head">
                <h3>${t('global.cardUi')}</h3>
                <div class="btn-row"><button class="btn small" type="button" data-action="reset-scale">${icon('refresh')}${t('global.reset')}</button></div>
              </div>
              <div class="g-fields">
                <div class="field">
                  <label id="ui-scale-label" for="ui-scale">${t('global.uiScale')} <span class="mono" id="ui-scale-value">${Math.round(scale * 100)}%</span></label>
                  <input type="range" id="ui-scale" class="range" min="1" max="1.4" step="0.05" value="${scale}">
                  <div class="scale-row">
                    <span class="faint">${t('global.uiScaleSmall')}</span>
                    <span class="faint" style="margin-left:auto">${t('global.uiScaleLarge')}</span>
                  </div>
                </div>
                <div class="field">
                  <span class="field-label" id="ui-theme-label">${t('global.theme')}</span>
                  <div class="seg" role="group" aria-labelledby="ui-theme-label">
                    <button data-action="set-theme" data-theme="dsh" aria-pressed="${state.theme === 'dsh'}">DSH</button>
                    <button data-action="set-theme" data-theme="catppuccin" aria-pressed="${state.theme === 'catppuccin'}">Catppuccin</button>
                  </div>
                </div>
                <div class="field">
                  <span class="field-label" id="desktop-notify-label">桌面通知</span>
                  <div><button class="btn small" type="button" data-action="toggle-notify" aria-labelledby="desktop-notify-label" aria-pressed="${notify.on ? 'true' : 'false'}"${notify.disabled ? ' disabled' : ''}>${esc(t(notify.label))}</button></div>
                  <div class="hint">${esc(t(notify.hint))}</div>
                </div>
                <div class="field">
                  <label id="settings-ui-language-label" for="settings-ui-language">${t('settings.uiLanguage')}</label>
                  <select class="select" id="settings-ui-language" name="ui_language">
                    <option value="auto" ${uiLanguage === 'auto' ? 'selected' : ''}>${esc(t('settings.uiLanguageAuto'))}</option>
                    <option value="zh" ${uiLanguage === 'zh' ? 'selected' : ''}>${esc(t('settings.uiLanguageZh'))}</option>
                    <option value="en" ${uiLanguage === 'en' ? 'selected' : ''}>${esc(t('settings.uiLanguageEn'))}</option>
                  </select>
                  <div class="hint">${esc(t('settings.uiLanguageHint'))}</div>
                </div>
              </div>
              <div class="g-foot">
                <div class="g-kvs">
                  <div class="kv"><span>${t('global.scaleRange')}</span><strong>100% – 140%</strong></div>
                  <div class="kv"><span>${t('global.prefStorage')}</span><strong>${t('global.prefStorageValue')}</strong></div>
                </div>
                <div class="btn-row"><button class="btn small primary" type="button" data-action="save-ui-language">${esc(t('settings.uiLanguageSave'))}</button></div>
              </div>
            </div>
            </div>`)}
      ${gsec('02', 'g-runtime', t('global.groupRuntime'), t('global.groupRuntimeDesc'), `<div class="g-slot g-slot--half">${renderRunLimitsCard()}</div><div class="g-slot g-slot--half">${renderOpsCard()}</div>`)}
      ${gsec('03', 'g-about', t('global.groupAbout'), t('global.groupAboutDesc'), `<div class="g-slot g-slot--half">${dshPathsCard()}</div><div class="g-slot g-slot--half">${dshServiceCard()}</div>`)}
    </div>
  `
}

export { renderUsageGlobal, renderUsageDomain, renderUsageSolo, renderRunLimitsCard, renderOpsCard, gsec, renderSettings, currentScale, renderGlobal }
