// global-pages.ts —— 全局一级页：通道页、密钥页。卡片自全局配置页原样迁入：
// 控件、data-action / data-form 链路、设置键不变，事件仍走全局委托。
// 与用量统计/全局配置共用 page-shell 页壳（页头 + 序号分组 + 12 列槽位），
// 四页的信息架构与视觉语言一致。
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
    disabled: '未启用', unbound: '未绑定', connecting: '连接中', connected: '已连接',
    reconnecting: '重连中', needs_reauth: '凭证失效', scanning: '待扫码',
    verification: '待输验证码',
  }
  const auth = state.wechatAuth
  const pillClass = wechat.phase === 'connected' ? 'green' : ['needs_reauth'].includes(wechat.phase) ? 'amber' : ''
  return `
    <div class="card form-card g-card wechat-card" id="wechat-card">
      <div class="wechat-card-main">
        <div class="wechat-status">
          <span class="pill ${pillClass}">${phaseText[wechat.phase] ?? wechat.phase}</span>
          ${wechat.adminPeerId ? `<span class="wechat-admin">管理员 <strong>${esc(String(wechat.adminPeerId).slice(0, 12))}…</strong></span>` : ''}
        </div>
        ${wechat.error ? `<div class="hint" style="color:var(--coral,#e5484d)">${esc(wechat.error)}</div>` : ''}
        ${auth?.qrSvg ? `
          <div class="hint wechat-qr-hint">微信扫码授权 ClawBot；手机上确认后此处会自动变为已连接。</div>` : ''}
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
        <div class="hint">扫码授权成功后自动把授权者绑定为管理员；任务完成会主动推送。</div>
      </div>
      ${auth?.qrSvg ? `<div class="wechat-qr">${auth.qrSvg}</div>` : ''}
    </div>`
}

// 密钥待审请求卡：Bot 发起的密钥请求，批准时填写密钥值。
function secretRequestsCard(requests) {
  if (requests.length === 0) return '<div class="faint">暂无待审请求。</div>'
  return `<div class="secret-block">
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
  </div>`
}

// 密钥列表卡：团队/项目两级密钥，值只显示指纹。
function secretListCard(secrets) {
  if (secrets.length === 0) return '<div class="faint">还没有密钥。</div>'
  return `<div class="secret-list">
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
  </div>`
}

// 新增密钥卡：作用域/项目/名称/用途/值，保存后不再回显。
function secretAddCard(projects) {
  return `
    <form class="card form-card g-card" data-form="upsert-secret">
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
    </form>`
}

// 通道页：微信等外部消息通道的绑定与状态。
export function renderChannel() {
  const card = wechatCard()
  return pageShell(
    pageHead('CHANNELS', t('viewTitle.channel'), t('channel.desc'), refreshAction()),
    '',
    [pageSection({
      index: '01', id: 'c-wechat', title: t('channel.sectionWechat'), desc: t('channel.sectionWechatDesc'),
      body: slot('full', card || `<div class="card"><div class="empty-state" style="border:0"><div class="empty-symbol">${icon('message')}</div><h3>微信通道未启用</h3><p>在服务端启用 wechat 通道后，这里会出现扫码绑定入口。</p></div></div>`),
    })],
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
        headExtra: `<span class="meta">${requests.length} 待审</span>`,
      }),
      pageSection({
        index: '02', id: 's-list', title: t('secrets.sectionList'), desc: t('secrets.sectionListDesc'),
        body: slot('full', `<div class="card form-card g-card">${secretListCard(secrets)}</div>`),
        headExtra: `<span class="meta">${secrets.length} 条</span>`,
      }),
      pageSection({
        index: '03', id: 's-add', title: t('secrets.sectionAdd'), desc: t('secrets.sectionAddDesc'),
        body: slot('full', secretAddCard(projects)),
      }),
    ],
  )
}
