import { state } from './state.js'
import { icon } from './icons.js'
import { t } from './i18n.js'
import { attr, esc, formatTime } from './util.js'
import { pageHead, pageNav, pageSection, pageShell, refreshAction, slot } from './page-shell.js'

// 微信通道卡（自配置页迁入）：绑定状态、扫码授权、验证码与退出。
function wechatCard() {
  const wechat = state.data.wechat ?? { enabled: false, phase: 'disabled' }
  if (!wechat.enabled) return ''
  const phaseText = {
    disabled: t("未启用"), unbound: t("未绑定"), connecting: t("连接中"), connected: t("已连接"),
    reconnecting: t("重连中"), needs_reauth: t("凭证失效"), scanning: t("待扫码"),
    verification: t("待输验证码"),
  }
  const auth = state.wechatAuth
  const pillClass = wechat.phase === 'connected' ? 'green' : ['needs_reauth'].includes(wechat.phase) ? 'amber' : ''
  return `
    <div class="card form-card g-card wechat-card" id="wechat-card">
      <div class="wechat-card-main">
        <div class="wechat-status">
          <span class="pill ${pillClass}">${phaseText[wechat.phase] ?? wechat.phase}</span>
          ${wechat.adminPeerId ? `<span class="wechat-admin" title="${attr(wechat.adminPeerId)}">${t("管理员")} <strong>${esc(String(wechat.adminPeerId))}</strong></span>` : ''}
        </div>
        ${wechat.error ? `<div class="hint" style="color:var(--coral,#e5484d)">${esc(wechat.error)}</div>` : ''}
        ${wechat.phase === 'verification' || auth?.verification ? `
          <div class="field-row" style="margin-top:8px">
            <div class="field"><label for="wechat-code">${t("微信验证码")}</label><input class="input mono" id="wechat-code" inputmode="numeric" placeholder="${t("扫码后手机上的验证码")}"></div>
            <div class="field"><label>&nbsp;</label><button class="btn small" type="button" data-action="wechat-code">${t("提交验证码")}</button></div>
          </div>` : ''}
        <div class="btn-row" style="margin-top:12px">
          ${['connected', 'reconnecting', 'connecting'].includes(wechat.phase)
            ? `<button class="btn small danger" type="button" data-action="wechat-logout">${t("退出绑定")}</button>`
            : `<button class="btn small" type="button" data-action="wechat-login">${t("扫码绑定")}</button>`}
        </div>
      </div>
      ${auth?.qrSvg ? `<div class="wechat-qr">${auth.qrSvg}</div>` : ''}
    </div>`
}

// 飞书通道卡（只读状态，DSHBOTS-327）：绑定态、管理员 ou_id 与机器人元信息。
// 飞书没有扫码流程：凭据在 lark-cli 侧由 operator 配置，UI 只读状态，不给绑定按钮。
function feishuCard() {
  const feishu = state.data?.feishu ?? { enabled: false, phase: 'disabled' }
  if (!feishu.enabled) return ''
  // 相位口径与 src/feishu/channel.ts 一致：ready=已连接、unbound=未绑定、conflict=连接冲突。
  const phaseText = {
    disabled: t("未启用"), unbound: t("未绑定"), ready: t("已连接"),
    reconnecting: t("重连中"), conflict: t("连接冲突"),
  }
  const pillClass = feishu.phase === 'ready' ? 'green' : feishu.phase === 'conflict' ? 'amber' : ''
  return `
    <div class="card form-card g-card feishu-card" id="feishu-card">
      <div class="feishu-status">
        <span class="pill ${pillClass}">${phaseText[feishu.phase] ?? feishu.phase}</span>
        ${feishu.adminOuId ? `<span class="feishu-admin" title="${attr(feishu.adminOuId)}">${t("管理员")} <strong>${esc(String(feishu.adminOuId))}</strong></span>` : ''}
      </div>
      ${feishu.phase === 'conflict' ? `<div class="hint feishu-conflict">${t("检测到连接冲突：同一 App ID 在多处登录（exceed_conn_limit），请先退出其他实例。")}</div>` : ''}
      ${feishu.error ? `<div class="hint feishu-error">${esc(feishu.error)}</div>` : ''}
      ${feishu.phase === 'unbound' ? `<div class="hint">${t("配置 lark-cli 后自动连接，无需扫码。")}</div>` : ''}
      <div class="feishu-meta">
        ${feishu.botId ? `<span>${t("机器人 ID")} <span class="mono">${esc(String(feishu.botId))}</span></span>` : ''}
        ${feishu.appId ? `<span>${t("App ID")} <span class="mono">${esc(String(feishu.appId))}</span></span>` : ''}
      </div>
    </div>`
}

// 密钥待审请求卡：Bot 发起的密钥请求，批准时填写密钥值。
function secretRequestsCard(requests) {
  if (requests.length === 0) return `<div class="faint">${t("暂无待审请求。")}</div>`
  return `<div class="secret-block">
    ${requests.map(request => `
      <form class="secret-request" data-form="approve-secret">
        <input type="hidden" name="requestId" value="${attr(request.id)}">
        <div class="secret-request-info">
          <strong>${esc(request.botName)}</strong>
          <span>${t("请求")} <code>${esc(request.name)}</code></span>
          ${request.projectName ? `<span class="faint">${esc(request.projectName)}</span>` : ''}
          <span class="faint">${esc(formatTime(request.createdAt))}</span>
        </div>
        ${request.reason ? `<div class="secret-request-reason">${esc(request.reason)}</div>` : ''}
        <div class="secret-request-actions">
          <input class="input mono" type="password" name="value" minlength="8" autocomplete="new-password" placeholder="${t("填写密钥值（至少 8 个字符）后批准")}">
          <button class="btn primary small" type="submit">${t("批准")}</button>
          <button class="btn small" type="button" data-action="deny-secret-request" data-request-id="${attr(request.id)}">${t("拒绝")}</button>
        </div>
      </form>`).join('')}
  </div>`
}

// 密钥列表卡：团队/项目两级密钥，值只显示指纹。
function secretListCard(secrets) {
  if (secrets.length === 0) return `<div class="faint">${t("还没有密钥。")}</div>`
  return `<div class="secret-list">
    ${secrets.map(secret => `
      <div class="secret-row">
        <span class="pill ${secret.scope === 'team' ? 'violet' : ''}">${secret.scope === 'team' ? t("团队") : t("项目")}</span>
        <strong class="mono">${esc(secret.name)}</strong>
        ${secret.scope === 'project' && secret.projectName ? `<span class="faint">${esc(secret.projectName)}</span>` : ''}
        <span class="secret-purpose">${esc(secret.purpose || '')}</span>
        <span class="subpanel-tag" title="${t("值指纹（sha256 前 8 位）")}">${esc(secret.fingerprint)}</span>
        <span class="faint">${esc(formatTime(secret.updatedAt))}</span>
        <span class="faint">${esc(secret.updatedBy ?? '')}</span>
        <button class="btn icon small" type="button" data-action="delete-secret" data-secret-id="${attr(secret.id)}" data-secret-name="${attr(secret.name)}" title="${t("删除密钥")}" aria-label="${t("删除密钥")} ${attr(secret.name)}">${icon('trash')}</button>
      </div>`).join('')}
  </div>`
}

// 新增密钥卡：作用域/项目/名称/用途/值，保存后不再回显。
function secretAddCard(projects) {
  return `
    <form class="card form-card g-card" data-form="upsert-secret">
      <div class="field-row">
        <div class="field"><label for="secret-scope">${t("作用域")}</label>
          <select class="select" id="secret-scope" name="scope">
            <option value="team">${t("团队（全部活动项目）")}</option>
            <option value="project">${t("单个项目")}</option>
          </select>
        </div>
        <div class="field"><label for="secret-project">${t("所属项目")}</label>
          <select class="select" id="secret-project" name="projectId">
            <option value="">${t("团队级无需选择")}</option>
            ${projects.map(project => `<option value="${attr(project.id)}">${esc(project.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label for="secret-name">${t("名称")}</label><input class="input mono" id="secret-name" name="name" maxlength="64" placeholder="${t("如")} DEPLOY_TOKEN" required></div>
        <div class="field"><label for="secret-purpose">${t("用途说明")}</label><input class="input" id="secret-purpose" name="purpose" maxlength="200" placeholder="${t("选填")}"></div>
      </div>
      <div class="field"><label for="secret-value">${t("密钥值")}</label>
        <input class="input mono" id="secret-value" name="value" type="password" minlength="8" autocomplete="new-password" placeholder="${t("至少 8 个字符，保存后不再回显")}">
        <div class="hint">${t("同作用域同名会覆盖旧值。")}</div>
      </div>
      <div class="btn-row"><button class="btn small" type="submit">${icon('check')}${t("保存密钥")}</button></div>
    </form>`
}

// 通道页：微信等外部消息通道的绑定与状态。
export function renderChannel() {
  const card = wechatCard()
  const feishu = feishuCard()
  return pageShell(
    pageHead('CHANNELS', t('viewTitle.channel'), t('channel.desc'), refreshAction()),
    '',
    [
      pageSection({
        index: '01', id: 'c-wechat', title: t('channel.sectionWechat'), desc: t('channel.sectionWechatDesc'),
        body: slot('full', card || `<div class="card"><div class="empty-state" style="border:0"><div class="empty-symbol">${icon('message')}</div><h3>${t("微信通道未启用")}</h3><p>${t("在服务端启用 wechat 通道后，这里会出现扫码绑定入口。")}</p></div></div>`),
      }),
      // 飞书未启用时整段不渲染（不显示死卡）：凭据与连接都在 operator 侧，UI 只读状态。
      ...(feishu ? [pageSection({
        index: '02', id: 'c-feishu', title: t('channel.sectionFeishu'), desc: t('channel.sectionFeishuDesc'),
        body: slot('full', feishu),
      })] : []),
    ],
  )
}

// 密钥页：团队与项目两级密钥 + Bot 密钥请求审批。
export function renderSecretsPage() {
  const secrets = state.data?.secrets ?? []
  const requests = state.data?.secretRequests ?? []
  const projects = (state.data?.projects ?? []).filter(project => project.status === 'active')
  return pageShell(
    pageHead('SECRETS', t('viewTitle.secrets'), t('secrets.desc'), refreshAction()),
    pageNav([
      { id: 's-requests', label: t('secrets.sectionRequests') },
      { id: 's-list', label: t('secrets.sectionList') },
      { id: 's-add', label: t('secrets.sectionAdd') },
    ], t('secrets.navLabel')),
    [
      pageSection({
        index: '01', id: 's-requests', title: t('secrets.sectionRequests'), desc: t('secrets.sectionRequestsDesc'),
        body: slot('full', secretRequestsCard(requests)),
        headExtra: `<span class="meta">${requests.length} ${t("待审")}</span>`,
      }),
      pageSection({
        index: '02', id: 's-list', title: t('secrets.sectionList'), desc: t('secrets.sectionListDesc'),
        body: slot('full', `<div class="card form-card g-card">${secretListCard(secrets)}</div>`),
        headExtra: `<span class="meta">${secrets.length} ${t("条")}</span>`,
      }),
      pageSection({
        index: '03', id: 's-add', title: t('secrets.sectionAdd'), desc: t('secrets.sectionAddDesc'),
        body: slot('full', secretAddCard(projects)),
      }),
    ],
  )
}
