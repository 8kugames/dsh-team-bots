// global-pages.js —— 全局一级页：通道页、密钥页。卡片自全局配置页原样迁入：
// 控件、data-action / data-form 链路、设置键不变，事件仍走全局委托。
// 单模块页只保留 pageHead 一层壳，标题与简介各出现一次；版面复用 D-184 槽位体系
// （g-slot / global-head），不新造设计。
import { state } from './state.js'
import { icon } from './icons.js'
import { attr, esc, formatTime } from './util.js'

// 页头复用配置页 global-head 样式；团队统计口径在「总览」页，这里不放指标带。
function pageHead(eyebrow, title, desc) {
  return `
      <header class="global-head">
        <div class="global-head-copy">
          <p class="global-eyebrow">${eyebrow}</p>
          <h2 class="global-title">${title}</h2>
          <p class="global-desc">${desc}</p>
        </div>
      </header>`
}

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
    <div class="card form-card g-card" id="wechat-card">
      <div class="card-head" style="justify-content:flex-end"><span class="pill ${pillClass}">${phaseText[wechat.phase] ?? wechat.phase}</span></div>
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
      <div class="hint">扫码授权成功后自动把授权者绑定为管理员；任务完成会主动推送。</div>
    </div>`
}

// 密钥管理卡（自配置页迁入）：团队/项目两级密钥列表 + Bot 发起的待审请求。
function secretsCard() {
  const secrets = state.data?.secrets ?? []
  const requests = state.data?.secretRequests ?? []
  const projects = (state.data?.projects ?? []).filter(project => project.status === 'active')
  return `
    <div class="card form-card g-card">
      <div class="card-head" style="justify-content:flex-end"><span class="meta">${secrets.length} 条 · ${requests.length} 待审</span></div>
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
    </div>`
}

// 通道页：微信等外部消息通道的绑定与状态。
export function renderChannel() {
  const card = wechatCard()
  return `
    <div class="global-page">
      ${pageHead('CHANNELS', '通道', '外部消息通道的绑定与运行状态。')}
      <div class="gsec-body">
        ${card
          ? `<div class="g-slot g-slot--two-thirds">${card}</div>`
          : `<div class="g-slot g-slot--two-thirds"><div class="card"><div class="empty-state" style="border:0"><div class="empty-symbol">${icon('message')}</div><h3>微信通道未启用</h3><p>在服务端启用 wechat 通道后，这里会出现扫码绑定入口。</p></div></div></div>`}
      </div>
    </div>
  `
}

// 密钥页：团队与项目两级密钥 + Bot 密钥请求审批。
export function renderSecretsPage() {
  return `
    <div class="global-page">
      ${pageHead('SECRETS', '密钥管理', '团队与项目两级密钥的加密存储，以及 Bot 发起的密钥请求审批。')}
      <div class="gsec-body">
        <div class="g-slot g-slot--full">${secretsCard()}</div>
      </div>
    </div>
  `
}
