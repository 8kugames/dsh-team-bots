// settings.js —— 设置/全局域：全局视图的用量面板、运行上限卡、运维卡、微信卡、密钥卡、
// 设置页与总览渲染（renderGlobal）。用量面板骨架复用同域外的用量 helper（ui/modules/usage.js）。
import { state } from './state.js'
import { t } from './i18n.js'
import { icon } from './icons.js'
import { activeBots, activeProject, attr, botById, esc, formatTime, pathCode, tildePath } from './util.js'
import { loadState } from './api.js'
import { notifyToggleView } from './cards.js'
import { usageBotRow, usageCurrency, usageDayPanel, usageDayTitle, usageListPanel, usageMetricCards, usageModelPanel, usagePageHead, usageProjectRow, usageRunRow, usageSection, usageSnapshot, usageWindowText } from './usage.js'
import { refresh, pendingProposals, noProject } from '../app.js'
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
    model: usageModelPanel(byModel, '分模型', `<span class="meta">${byModel.length} 个</span><button class="btn small" data-action="new-price">设置价格</button>`, currency),
    bot: usageListPanel('分 Bot', byBot.map(item => usageBotRow(item, maxBot, false, currency)), 'Bot'),
    project: usageListPanel('分项目', byProject.map(item => usageProjectRow(item, maxProject, currency)), '项目'),
  }
  // 口径切换只调展示顺序，四个维度始终可见（关键信息不折叠）。
  const order = {
    global: ['days', 'model', 'bot', 'project'],
    model: ['model', 'days', 'bot', 'project'],
    bot: ['bot', 'days', 'model', 'project'],
    project: ['project', 'days', 'model', 'bot'],
  }[focus]
  const overviewNotes = [
    unpriced > 0 ? `<div class="note warn-note">${unpriced} 次调用未配置价格，成本为部分值。</div>` : '',
    Number(reconciliation?.mismatched ?? 0) > 0 ? `<div class="usage-note">${Number(reconciliation.mismatched)} 次运行的用量记录对不上，数据可能不完整。</div>` : '',
  ].join('')
  return `
    ${usagePageHead(usage, '全局口径，不随当前群聊 / 单聊上下文变化')}
    ${usageSection(
      '全局用量总览',
      `四项指标覆盖全部调用来源，按汇总窗口 ${windowText} 统计。`,
      `${overviewNotes}${usageMetricCards(totals, '全局', usage)}`,
    )}
    ${usageSection(
      '分布明细',
      `四个维度始终同时展示；按日面板只画 ${dayTitle}，其余面板与上方汇总同为 ${windowText} 窗口。条形长度 = tokens 占比，琥珀色 = 含未计价调用，空条 = 零用量。`,
      `<div class="usage-grid">${order.map(key => panels[key]).join('')}</div>`,
      `<div class="usage-seg">
        <span class="usage-seg-label">面板顺序</span>
        <div class="seg" role="group" aria-label="面板顺序">
          <button data-action="usage-scope" data-scope="global" aria-pressed="${focus === 'global'}">趋势优先</button>
          <button data-action="usage-scope" data-scope="model" aria-pressed="${focus === 'model'}">模型优先</button>
          <button data-action="usage-scope" data-scope="bot" aria-pressed="${focus === 'bot'}">Bot 优先</button>
          <button data-action="usage-scope" data-scope="project" aria-pressed="${focus === 'project'}">项目优先</button>
        </div>
      </div>`,
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
    unpriced > 0 ? `<div class="note warn-note">${unpriced} 次调用未配置价格，成本为部分值。</div>` : '',
    tier ? '' : '<div class="usage-note">下方分组明细暂不可用，上方汇总仍按本群统计。</div>',
  ].join('')
  return `
    ${usagePageHead(usage, '仅当前群聊内的用量，不含其他群聊', '本群')}
    ${usageSection(
      '本群用量总览',
      `四项指标只统计当前群聊的调用，按汇总窗口 ${windowText} 归集。`,
      `${overviewNotes}${usageMetricCards(totals, '本群', usage)}`,
    )}
    ${usageSection(
      '本群分布明细',
      `按日面板只画 ${dayTitle}，其余面板与上方汇总同为 ${windowText} 窗口；条形长度 = tokens 占比，琥珀色 = 含未计价调用，空条 = 零用量。`,
      `<div class="usage-grid">
        ${usageDayPanel(days)}
        ${usageModelPanel(byModel, '本群分模型', '', currency)}
        ${usageListPanel('本群各 Bot', byBot.map(item => usageBotRow(item, maxBot, true, currency)), 'Bot')}
      </div>`,
    )}
    ${drillBot ? usageSection(
      `${drillBot.name} 在本群的运行记录`,
      '在「本群各 Bot」列表点选可切换查看对象。',
      `<div class="card usage-panel">
        ${drillRuns.length === 0 ? '<div class="faint">该 Bot 在本群还没有运行记录。</div>' : `<div class="run-list">${drillRuns.map(usageRunRow).join('')}</div>`}
      </div>`,
      `<button class="btn small" data-action="usage-clear-drill">${icon('close')}清除选择</button>`,
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
    unpriced > 0 ? `<div class="note warn-note">${unpriced} 次调用未配置价格，成本为部分值。</div>` : '',
    usage.solo && tier ? '' : '<div class="usage-note">该 Bot 的单聊明细暂不可用。</div>',
  ].join('')
  return `
    ${usagePageHead(usage, '仅该 Bot 在项目外（单聊）的用量，不含项目内调用', '该 Bot')}
    ${usageSection(
      '该 Bot 用量总览',
      `四项指标只统计该 Bot 的单聊调用，按汇总窗口 ${windowText} 归集。`,
      `${overviewNotes}${usageMetricCards(totals, '该 Bot', usage)}`,
    )}
    ${usageSection(
      '该 Bot 分布明细',
      `按日面板只画 ${dayTitle}，其余面板与上方汇总同为 ${windowText} 窗口。`,
      `<div class="usage-grid">
        ${usageDayPanel(days)}
        ${usageModelPanel(byModel, '该 Bot 分模型', '', currency)}
      </div>`,
    )}
    ${usageSection(
      '该 Bot 的运行记录',
      '与上方用量同口径：只含项目外（单聊）的运行。',
      `<div class="card usage-panel">
        <div class="card-head"><h3>运行明细</h3><span class="meta">${runs.length} 条</span></div>
        ${runs.length === 0 ? '<div class="faint">该 Bot 在项目外还没有运行记录。</div>' : `<div class="run-list">${runs.map(usageRunRow).join('')}</div>`}
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
  const stallText = limits.stallTimeoutMinutes === 0 ? '看门狗关闭' : `${limits.stallTimeoutMinutes ?? 30} 分钟看门狗`
  return `
    <div class="card form-card g-card">
      <div class="card-head"><h3>运行时效</h3><span class="meta">当前生效 ${limits.runTimeoutMinutes ?? 120} 分钟超时 / ${stallText}</span></div>
      <div class="field-row">
        <div class="field"><label id="settings-run-timeout-label" for="settings-run-timeout">超时中止（分钟）</label><input class="input mono" style="text-align:right" type="number" min="1" max="360" id="settings-run-timeout" name="run_timeout_minutes" value="${attr(runValue)}"></div>
        <div class="field"><label id="settings-stall-watchdog-label" for="settings-stall-watchdog">无进展看门狗（分钟）</label><input class="input mono" style="text-align:right" type="number" min="0" max="360" id="settings-stall-watchdog" name="stall_watchdog_minutes" value="${attr(stallValue)}"></div>
      </div>
      <div class="hint">超时中止 = 单次运行的最长时长（1–360 分钟）；无进展看门狗 = 运行多久没有任何输出即判定卡住（0–360 分钟，0 为关闭）。</div>
      <div class="hint">新值只对之后启动的运行生效，进行中的运行不追溯。</div>
      ${envNames ? `<div class="hint">环境变量 ${envNames} 已显式设置，对应项以环境变量为准，页面保存值不生效。</div>` : ''}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn small" type="button" data-action="save-run-limits">保存运行时效</button>
      </div>
    </div>`
}

function renderOpsCard() {
  const settings = state.data.settings ?? {}
  const outbox = state.data.outbox ?? { pending: 0, failed: 0, delivered: 0 }
  const reconciliation = state.data.usage?.reconciliation ?? null
  const currency = settings.budget_currency || 'CNY'
  const num = value => (value === '' || value === undefined || value === null ? '' : String(value))
  return `
    <div class="card form-card g-card">
      <div class="card-head"><h3>系统与运维</h3></div>
      <div class="field-row">
        <div class="field">
          <label id="settings-currency-label" for="settings-currency">预算币种</label>
          <select class="select" id="settings-currency" name="budget_currency">
            ${['CNY', 'USD'].map(code => `<option value="${code}" ${code === currency ? 'selected' : ''}>${code}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label id="settings-memory-review-label" for="settings-memory-review">记忆自动审查</label>
          <select class="select" id="settings-memory-review" name="memory_review">
            <option value="1" ${settings.memory_review !== '0' ? 'selected' : ''}>开启</option>
            <option value="0" ${settings.memory_review === '0' ? 'selected' : ''}>关闭</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label id="settings-global-token-budget-label" for="settings-global-token-budget">全局 Token 预算</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-global-token-budget" name="global_token_budget" value="${attr(num(settings.global_token_budget))}" placeholder="不限制"></div>
        <div class="field"><label id="settings-global-cost-budget-label" for="settings-global-cost-budget">全局成本预算</label><input class="input mono" style="text-align:right" type="number" min="0" step="0.01" id="settings-global-cost-budget" name="global_cost_budget" value="${attr(num(settings.global_cost_budget))}" placeholder="不限制"></div>
      </div>
      <div class="field-row">
        <div class="field"><label id="settings-retention-usage-label" for="settings-retention-usage">用量保留天数</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-retention-usage" name="retention_usage_days" value="${attr(num(settings.retention_usage_days))}" placeholder="永久"></div>
        <div class="field"><label id="settings-retention-run-label" for="settings-retention-run">运行事件保留天数</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-retention-run" name="retention_run_event_days" value="${attr(num(settings.retention_run_event_days))}" placeholder="永久"></div>
      </div>
      <div class="field"><label id="settings-retention-message-label" for="settings-retention-message">消息保留天数</label><input class="input mono" style="text-align:right" type="number" min="0" id="settings-retention-message" name="retention_message_days" value="${attr(num(settings.retention_message_days))}" placeholder="永久"></div>
      <div class="hint">全局预算对所有项目生效；保留天数按天清理过期用量、运行事件与消息，0 表示永久保留。</div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn small" type="button" data-action="save-settings">保存系统设置</button>
      </div>
      ${Number(outbox.failed ?? 0) > 0 ? `<div class="kv" style="margin-top:12px"><span>投递队列</span><strong>${outbox.failed} 条消息投递失败</strong></div>` : ''}
    </div>`
}

function renderWechatCard() {
  const wechat = state.data.wechat ?? { enabled: false, phase: 'disabled' }
  if (!wechat.enabled) return ''
  const phaseText = {
    disabled: '未启用', unbound: '未绑定', connecting: '连接中', connected: '已连接',
    reconnecting: '重连中', needs_reauth: '凭证失效', scanning: '待扫码',
    verification: '待输验证码',
  }
  const auth = state.wechatAuth
  const pillClass = wechat.phase === 'connected' ? 'green' : ['needs_reauth'].includes(wechat.phase) ? 'amber' : ''
  return `
    <div class="card form-card g-card" id="wechat-card">
      <div class="card-head"><h3>微信通道</h3><span class="pill ${pillClass}">${phaseText[wechat.phase] ?? wechat.phase}</span></div>
      ${wechat.adminPeerId ? `<div class="kv"><span>管理员</span><strong>${esc(String(wechat.adminPeerId).slice(0, 12))}…</strong></div>` : ''}
      ${wechat.error ? `<div class="hint" style="color:var(--coral,#e5484d)">${esc(wechat.error)}</div>` : ''}
      ${auth?.qrSvg ? `
        <div class="wechat-qr">${auth.qrSvg}</div>
        <div class="hint">微信扫码授权 ClawBot；手机上确认后此处会自动变为已连接。</div>` : ''}
      ${wechat.phase === 'verification' || auth?.verification ? `
        <div class="field-row" style="margin-top:8px">
          <div class="field"><label for="wechat-code">微信验证码</label><input class="input mono" id="wechat-code" inputmode="numeric" placeholder="扫码后手机上的验证码"></div>
          <div class="field"><label>&nbsp;</label><button class="btn small" type="button" data-action="wechat-code">提交验证码</button></div>
        </div>` : ''}
      <div class="btn-row" style="margin-top:12px">
        ${['connected', 'reconnecting', 'connecting'].includes(wechat.phase)
          ? '<button class="btn small danger" type="button" data-action="wechat-logout">退出绑定</button>'
          : '<button class="btn small" type="button" data-action="wechat-login">扫码绑定</button>'}
      </div>
      <div class="hint">扫码授权成功后自动把授权者绑定为管理员；之后可用：状态 / 详情 web-3 / 验收 web-3 / 驳回 web-3 理由。任务完成会主动推送。</div>
      <div class="g-move-note">计划迁移 · 通道页</div>
    </div>`
}

// 密钥管理：团队/项目两级密钥列表 + Bot 发起的待审请求，均来自 state.secrets / state.secretRequests。
function renderSecretsCard() {
  const secrets = state.data?.secrets ?? []
  const requests = state.data?.secretRequests ?? []
  const projects = (state.data?.projects ?? []).filter(project => project.status === 'active')
  return `
    <div class="card form-card g-card">
      <div class="card-head"><h3>密钥管理</h3><span class="meta">${secrets.length} 条 · ${requests.length} 待审</span></div>
      <div class="hint" style="margin:2px 0 12px">密钥加密存储；团队级密钥对所有活动项目生效，Bot 可以直接使用。</div>
      ${requests.length === 0 ? '' : `<div class="secret-block">
        ${requests.map(request => `
          <form class="secret-request" data-form="approve-secret">
            <input type="hidden" name="requestId" value="${attr(request.id)}">
            <div class="secret-request-info">
              <strong>${esc(request.botName)}</strong>
              <span>请求 <code>${esc(request.name)}</code></span>
              ${request.projectName ? `<span class="faint">${esc(request.projectName)}</span>` : ''}
              <span class="faint">${esc(formatTime(request.createdAt))}</span>
            </div>
            ${request.reason ? `<div class="secret-request-reason">${esc(request.reason)}</div>` : ''}
            <div class="secret-request-actions">
              <input class="input mono" type="password" name="value" minlength="8" autocomplete="new-password" placeholder="填写密钥值（至少 8 个字符）后批准">
              <button class="btn primary small" type="submit">批准</button>
              <button class="btn small" type="button" data-action="deny-secret-request" data-request-id="${attr(request.id)}">拒绝</button>
            </div>
          </form>`).join('')}
      </div>`}
      ${secrets.length === 0 ? '<div class="faint" style="padding:6px 0 12px">还没有密钥。</div>' : `<div class="secret-list">
        ${secrets.map(secret => `
          <div class="secret-row">
            <span class="pill ${secret.scope === 'team' ? 'violet' : ''}">${secret.scope === 'team' ? '团队' : '项目'}</span>
            <strong class="mono">${esc(secret.name)}</strong>
            ${secret.scope === 'project' && secret.projectName ? `<span class="faint">${esc(secret.projectName)}</span>` : ''}
            <span class="secret-purpose">${esc(secret.purpose || '')}</span>
            <span class="subpanel-tag" title="值指纹（sha256 前 8 位）">${esc(secret.fingerprint)}</span>
            <span class="faint">${esc(formatTime(secret.updatedAt))}</span>
            <span class="faint">${esc(secret.updatedBy ?? '')}</span>
            <button class="btn icon small" type="button" data-action="delete-secret" data-secret-id="${attr(secret.id)}" data-secret-name="${attr(secret.name)}" title="删除密钥" aria-label="删除密钥 ${attr(secret.name)}">${icon('trash')}</button>
          </div>`).join('')}
      </div>`}
      <form data-form="upsert-secret" style="margin-top:12px">
        <div class="field-row">
          <div class="field"><label for="secret-scope">作用域</label>
            <select class="select" id="secret-scope" name="scope">
              <option value="team">团队（全部活动项目）</option>
              <option value="project">单个项目</option>
            </select>
          </div>
          <div class="field"><label for="secret-project">所属项目</label>
            <select class="select" id="secret-project" name="projectId">
              <option value="">团队级无需选择</option>
              ${projects.map(project => `<option value="${attr(project.id)}">${esc(project.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label for="secret-name">名称</label><input class="input mono" id="secret-name" name="name" maxlength="64" placeholder="如 DEPLOY_TOKEN" required></div>
          <div class="field"><label for="secret-purpose">用途说明</label><input class="input" id="secret-purpose" name="purpose" maxlength="200" placeholder="选填"></div>
        </div>
        <div class="field"><label for="secret-value">密钥值</label>
          <input class="input mono" id="secret-value" name="value" type="password" minlength="8" autocomplete="new-password" placeholder="至少 8 个字符，保存后不再回显">
          <div class="hint">至少 8 个字符；同作用域同名会覆盖旧值。</div>
        </div>
        <div class="btn-row"><button class="btn small" type="submit">${icon('check')}保存密钥</button></div>
      </form>
      <div class="g-move-note">计划迁移 · 密钥页</div>
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
function gsec(index, id, title, desc, meta, body) {
  return `
      <section class="gsec" id="${id}" aria-labelledby="${id}-title">
        <div class="gsec-head">
          <span class="gsec-index mono">${index}</span>
          <div class="gsec-copy">
            <h3 class="gsec-title" id="${id}-title">${title}</h3>
            <p class="gsec-desc">${desc}</p>
          </div>
          <span class="gsec-meta">${meta}</span>
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
  const bots = data.bots ?? []
  const activeBots = bots.filter(bot => bot.status === 'active')
  const pending = pendingProposals()
  const notify = notifyToggleView()
  const copyPath = value => `<button class="btn icon small" type="button" data-action="copy" data-copy="${attr(value)}" title="复制路径" aria-label="复制路径">${icon('copy')}</button>`
  // 「DSH 服务」卡检查结果（DSHBOTS-143）：loadState 只换 state.data，dshUpdate 存这里不被轮询盖掉。
  const update = state.dshUpdate
  const latestCell = (latest, available) => latest == null
    ? '<strong>—</strong>'
    : available
      ? `<strong>${esc(latest)} <span class="pill amber">可升级</span></strong>`
      : `<strong>${esc(latest)} <span class="pill green">最新</span></strong>`
  const wechatCard = renderWechatCard()
  return `
    <div class="global-page">
      <header class="global-head">
        <div class="global-head-copy">
          <p class="global-eyebrow">GLOBAL CONFIGURATION</p>
          <h2 class="global-title">团队级配置</h2>
          <p class="global-desc">跨项目生效的团队设置，按「偏好 → 运行 → 环境 → 接入」分组。改动即时生效的项在卡片内就地保存；标了「计划迁移」的模块在迁移完成前仍在本页可用。</p>
        </div>
        <div class="global-metrics">
          <div class="global-metric"><span class="global-metric-label">活跃 Bot</span><strong class="global-metric-value">${activeBots.length} / ${bots.length}</strong></div>
          <div class="global-metric"><span class="global-metric-label">群聊 / 项目</span><strong class="global-metric-value">${data.projects.length}</strong></div>
          <div class="global-metric"><span class="global-metric-label">共享技能</span><strong class="global-metric-value">${(data.skills ?? []).length}</strong></div>
          <div class="global-metric"><span class="global-metric-label">待审提案</span><strong class="global-metric-value">${pending}</strong></div>
          <div class="global-metric"><span class="global-metric-label">模型价格规则</span><strong class="global-metric-value">${data.usage?.priceCount ?? 0}</strong></div>
          <p class="global-metrics-note">团队与资源概览 · 与「总览」页重复，计划迁出本页</p>
        </div>
      </header>
      <nav class="global-nav" aria-label="配置分组导航">
        <a class="global-nav-item" href="#g-pref">偏好</a>
        <a class="global-nav-item" href="#g-runtime">运行与预算</a>
        <a class="global-nav-item" href="#g-env">环境与版本</a>
        <a class="global-nav-item" href="#g-integrations">接入与计价</a>
      </nav>
      ${gsec('01', 'g-pref', '偏好', '只影响这台机器上的显示方式，保存后立即生效。', '1 个模块 · 1 处保存', `
            <div class="g-slot g-slot--full">
            <div class="card form-card g-card">
              <div class="card-head">
                <h3>界面</h3>
                <div class="btn-row"><button class="btn small" type="button" data-action="reset-scale">${icon('refresh')}重置</button></div>
              </div>
              <div class="g-fields">
                <div class="field">
                  <label id="ui-scale-label" for="ui-scale">界面字号 <span class="mono" id="ui-scale-value">${Math.round(scale * 100)}%</span></label>
                  <input type="range" id="ui-scale" class="range" min="1" max="1.4" step="0.05" value="${scale}">
                  <div class="scale-row">
                    <span class="faint">小</span>
                    <span class="faint" style="margin-left:auto">大</span>
                  </div>
                </div>
                <div class="field">
                  <span class="field-label" id="ui-theme-label">配色</span>
                  <div class="seg" role="group" aria-labelledby="ui-theme-label">
                    <button data-action="set-theme" data-theme="dsh" aria-pressed="${state.theme === 'dsh'}">DSH</button>
                    <button data-action="set-theme" data-theme="catppuccin" aria-pressed="${state.theme === 'catppuccin'}">Catppuccin</button>
                  </div>
                </div>
                <div class="field">
                  <span class="field-label" id="desktop-notify-label">桌面通知</span>
                  <div><button class="btn small" type="button" data-action="toggle-notify" aria-labelledby="desktop-notify-label" aria-pressed="${notify.on ? 'true' : 'false'}"${notify.disabled ? ' disabled' : ''}>${esc(notify.label)}</button></div>
                  <div class="hint">${esc(notify.hint)}</div>
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
                  <div class="kv"><span>缩放范围</span><strong>100% – 140%</strong></div>
                  <div class="kv"><span>偏好存储</span><strong>本地浏览器（语言除外）</strong></div>
                </div>
                <div class="btn-row"><button class="btn small primary" type="button" data-action="save-ui-language">${esc(t('settings.uiLanguageSave'))}</button></div>
              </div>
            </div>
            </div>`)}
      ${gsec('02', 'g-runtime', '运行与预算', '影响所有项目运行的行为与开销上限：超时中止、无进展看门狗、预算与数据保留。', '2 个模块 · 2 处保存', `<div class="g-slot g-slot--half">${renderRunLimitsCard()}</div><div class="g-slot g-slot--half">${renderOpsCard()}</div>`)}
      ${gsec('03', 'g-env', '环境与版本', '本机路径与 DSH 版本状态。这两块计划迁往「关于」页，迁移完成前仍在本页可用。', '2 个模块 · 计划迁移', `
            <div class="g-slot g-slot--half">
            <div class="card form-card g-card">
              <div class="card-head">
                <h3>DSH 路径</h3>
                <button class="btn small" data-action="sync-skills">${icon('refresh')}重新扫描技能</button>
              </div>
              <div class="path-row"><span>DSH 目录</span>${pathCode(data.paths.dshHome ?? '~/.dsh')}${copyPath(data.paths.dshHome ?? '')}</div>
              <div class="path-row"><span>工作区</span>${pathCode(tildePath(data.paths.workspace))}${copyPath(data.paths.workspace)}</div>
              <div class="path-row"><span>共享</span>${pathCode(data.paths.skillRoot)}${copyPath(data.paths.skillRoot)}</div>
              <div class="path-row"><span>数据</span>${pathCode(data.paths.dataDir)}${copyPath(data.paths.dataDir)}</div>
              <div class="g-move-note">计划迁移 · 关于页</div>
            </div>
            </div>
            <div class="g-slot g-slot--half">
            <div class="card form-card g-card">
              <div class="card-head">
                <h3>DSH 服务</h3>
                <button class="btn small" data-action="check-dsh-update">${icon('refresh')}检查更新</button>
              </div>
              <div class="kv"><span>dsh 当前版本</span><strong>${esc(data.dsh?.version ?? 'unknown')}</strong></div>
              <div class="kv"><span>dsh 最新版本</span>${latestCell(update?.latest, update?.updateAvailable)}</div>
              <div class="kv"><span>dsh-team-bots 当前版本</span><strong>${esc(data.pluginVersion ?? 'unknown')}</strong></div>
              <div class="kv"><span>dsh-team-bots 最新版本</span>${latestCell(update?.pluginLatest, update?.pluginUpdateAvailable)}</div>
              <div class="g-move-note">计划迁移 · 关于页</div>
            </div>
            </div>`)}
      ${gsec('04', 'g-integrations', '接入与计价', '外部通道、密钥与模型价格规则，分别计划迁往「通道」「密钥」「用量」页，迁移完成前仍在本页可用。', `${wechatCard ? 3 : 2} 个模块 · 计划迁移`, (wechatCard ? `<div class="g-slot g-slot--third">${wechatCard}</div>` : '') + `<div class="g-slot g-slot--two-thirds">${renderSecretsCard()}</div><div class="g-slot g-slot--full">${renderPriceCard()}</div>`)}
    </div>
  `
}


export { renderUsageGlobal, renderUsageDomain, renderUsageSolo, renderRunLimitsCard, renderOpsCard, renderWechatCard, renderSecretsCard, renderSettings, currentScale, renderGlobal }
