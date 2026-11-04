// chat.js —— 聊天域：群聊 / 单聊消息流渲染、输入中状态行、历史分片加载、单聊详情与配置页。
// 输入区（草稿 / 图片 / 发送）在 composer.js，消息卡片在 cards.js，输入中气泡在 typing-linger.js。
import { state, BOT_STATUS, CHAT_ACTIVE_TASK_LIMIT, CHAT_PAGE_SIZE, COLORS, COLOR_NAMES } from './state.js'
import { icon } from './icons.js'
import { activeProject, attr, avatar, botById, duration, esc, filePolicyOptions, formatTime, memberRunDot, pathCode, runDotHtml, timeAgo, toast } from './util.js'
import { mdPlainSummary } from './markdown.js'
import { t } from './i18n.js'
import { api } from './api.js'
import { renderDirectMessagesCard, renderMessage } from './cards.js'
import { attachImageButton, composerImageStrip, currentDraft, pendingImagesFor, sendMessage } from './composer.js'
import { typingLingerRowsHtml } from './typing-linger.js'
import { effortOptions, fallbackModelOptions, modelOptions } from './modal-forms.js'
import { sideRowStatusHtml, runStatusLabel, runKindLabel, render, noProject } from '../app.js'

// typing-status:start —— 消息流末尾「Bot 响应中」状态行的纯逻辑（tests/typing-status.test.js 抽取此块断言）
// 只认 chat / solo_chat 的活跃运行；task、review、handle、dm、dm_reply、memory_review 与已结束运行一律不出行。
function activeTypingRuns(runs, kind) {
  return (runs ?? [])
    .filter(run => run.kind === kind && ['queued', 'running'].includes(run.status))
    .sort((a, b) => String(a.queued_at ?? '').localeCompare(String(b.queued_at ?? '')))
    .map(run => ({
      botId: run.bot_id,
      botName: run.botName ?? 'Bot',
      status: run.status,
      text: run.status === 'queued' ? '排队等待回复…' : '正在思考与回复…',
      // 耗时起点：未开始运行的从排队时刻起算
      startedAt: run.started_at ?? run.queued_at,
    }))
}
// typing-status:end

// 活跃运行的「响应中」行：头像 + 三点跳动 + 状态文案 + 秒表（复用 .run-clock 的每秒刷新 interval）。
function typingRows(runs, kind) {
  return activeTypingRuns(runs, kind).map(row => {
    const bot = botById(row.botId)
    return `<div class="typing-row">
      ${avatar(bot, 'sm')}
      <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <strong class="typing-name">${esc(row.botName)}</strong>
      <span class="typing-text">${row.status === 'queued' ? t('chat.typingQueued') : t('chat.typingRunning')}</span>
      <span class="run-clock" data-started="${attr(row.startedAt ?? '')}">${duration(row.startedAt)}</span>
    </div>`
  }).join('')
}

// chat-pagination:start —— 聊天历史分片加载（DSHBOTS-33）纯逻辑，tests/chat-pagination.test.js 按本标记块抽取断言。
// state 轮询只回最后 CHAT_PAGE_SIZE 条；更早的经 messages_page 手动加载，与轮询结果按 id 去重合并展示。

// 当前会话的分片桶 key：与轮询数据的会话一一对应，切会话即失效（loadOlderMessages 里判断重置）。
function chatKey() {
  if (state.chatMode === 'solo') return state.soloBotId ? `solo:${state.soloBotId}` : null
  const project = activeProject()
  return project ? `group:${project.id}` : null
}

// 合并分片桶与轮询消息：older 在前、latest 在后，按 id 去重以轮询侧为准（轮询是活数据）。
function mergedChatMessages(latest) {
  const key = chatKey()
  const bucket = state.chatOlder.key === key ? state.chatOlder : null
  if (!bucket || !bucket.items.length) return latest ?? []
  const seen = new Set((latest ?? []).map(m => m.id))
  const older = bucket.items.filter(m => !seen.has(m.id))
  return [...older, ...(latest ?? [])]
}

// 未翻过页且首屏已满页时也可能还有更早历史——显示按钮探一页，由 hasMore 收敛。
function canLoadOlder(mergedCount) {
  const key = chatKey()
  const bucket = state.chatOlder.key === key ? state.chatOlder : null
  if (!bucket) return mergedCount >= CHAT_PAGE_SIZE
  if (bucket.loading || !bucket.hasMore) return false
  return true
}

function loadOlderButton() {
  const disabled = state.chatOlder.loading ? ' disabled' : ''
  const label = state.chatOlder.loading ? t('chat.loadingOlder') : t('chat.loadOlder', { count: CHAT_PAGE_SIZE })
  return `<button class="load-older" data-action="load-older"${disabled}>${label}</button>`
}

async function loadOlderMessages() {
  const key = chatKey()
  if (!key || state.chatOlder.loading) return
  if (state.chatOlder.key !== key) {
    state.chatOlder = { key, items: [], hasMore: false, loading: false }
  }
  const listEl = document.querySelector('.chat-messages')
  const solo = state.data?.solo?.bot?.id === state.soloBotId ? state.data.solo : null
  const merged = state.chatMode === 'solo'
    ? mergedChatMessages(solo?.messages ?? [])
    : mergedChatMessages(state.data.messages ?? [])
  const oldest = merged[0]
  if (!oldest) return
  state.chatOlder.loading = true
  render()
  try {
    const scope = state.chatMode === 'solo' ? { soloBotId: state.soloBotId } : { projectId: key.slice('group:'.length) }
    const res = await api('messages_page', { ...scope, beforeCreatedAt: oldest.createdAt, beforeId: oldest.id, limit: CHAT_PAGE_SIZE })
    state.chatOlder.items = [...(res.messages ?? []), ...state.chatOlder.items]
    state.chatOlder.hasMore = Boolean(res.hasMore)
    const prevTop = listEl ? listEl.scrollTop : 0
    const prevHeight = listEl ? listEl.scrollHeight : 0
    render()
    // 阅读位补偿：套一层 rAF 排在 render 自身 rAF 的落底滚动之后，避免被 chatAtBottom 分支覆盖。
    requestAnimationFrame(() => {
      if (!listEl || state.chatAtBottom) return
      listEl.scrollTop = prevTop + (listEl.scrollHeight - prevHeight)
    })
  } catch (err) {
    toast(err?.message || t('toast.loadOlderFailed'))
  } finally {
    state.chatOlder.loading = false
    render()
  }
}
// chat-pagination:end

// 群聊右栏「项目成员」概览卡（只读）：DSHBOTS-49 恢复 D-5 信息架构收敛时删掉的面板，
// DSHBOTS-55 按 232f1c8 的双行方案修正——①位置在「项目总监」卡正下方（活跃任务之前）；
// ②成员行剔除总监（总监独占上方自己的 panel），计数同口径；
// ③行样式回到成员两行式 .member-info：第一行 名称+角色标签，第二行 模型小字，状态点留在行尾。
// 数据源与「成员」tab 同一张表（project.members）；状态点走 memberRunDot，与「成员」tab 一致。
// 卡内不含任何管理操作——邀请与移除留在「成员」tab，避免旧版「复选框全量提交」式的误清空成员。
function renderChatMembersCard() {
  const project = activeProject()
  const members = project?.members ?? []
  // 总监独占一张卡，成员卡里不再重复展示总监。
  const memberList = members.filter(member => member.id !== project?.owner_bot_id && member.member_role !== 'owner')
  return `
    <div class="side-card members-overview" data-members-overview>
      <div class="side-card-head"><h3>${t('card.projectMembers')}</h3><span>${memberList.length}</span></div>
      ${memberList.length === 0 ? `<div class="faint">${t('card.noOtherMembers')}</div>` : `<div class="side-list">
        ${memberList.map(member => {
          const bot = botById(member.id)
          if (!bot) return ''
          const dot = memberRunDot(member)
          // modelRef 已是 provider/model 形态（如 deepseek/deepseek-chat），不再拼 provider；缺配置给兜底文案。
          const modelRef = member.modelRef ?? bot.modelRef ?? bot.model ?? null
          const modelLine = modelRef ? String(modelRef) : t('common.modelUnset')
          return `<div class="side-row" title="${esc(bot.name)} · ${esc(bot.role || t('common.member'))} · ${esc(dot.text)}">
            ${avatar(bot, 'sm')}
            <div class="member-info">
              <span class="member-name-line"><strong>${esc(bot.name)}</strong><span class="member-role">${esc(bot.role || t('common.member'))}</span></span>
              <span class="member-model">${esc(modelLine)}</span>
            </div>
            ${runDotHtml(dot)}
          </div>`
        }).join('')}
      </div>`}
    </div>`
}

function renderChat() {
  if (state.chatMode === 'solo') return renderSoloChat()
  const project = activeProject()
  if (!project) return noProject()
  const messages = mergedChatMessages(state.data.messages ?? [])
  const owner = botById(project.owner_bot_id)
  const members = project.members ?? []
  // modelRef 本身已是 provider/model（如 deepseek/deepseek-chat），不再单独拼 provider，避免重复。
  const ownerModelRef = owner ? (owner.modelRef ?? owner.model ?? null) : null
  const ownerModelLine = ownerModelRef ? String(ownerModelRef) : t('common.modelUnset')
  // 总监也是 bot，状态点取同一成员表口径（bot 全局）。
  const ownerMember = members.find(m => m.id === project.owner_bot_id) ?? null
  const ownerDot = ownerMember ? memberRunDot(ownerMember) : null
  const openTasks = (state.data.tasks ?? []).filter(task => !['done', 'canceled'].includes(task.status))
  const open = openTasks.slice(0, CHAT_ACTIVE_TASK_LIMIT)
  return `
    <div class="chat-layout">
      <div class="card chat-panel">
        <div class="chat-head">
          <div>
            <div class="chat-head-title"><span class="chat-hash">#</span>${t('chat.groupTitle')}</div>
            <div class="chat-head-meta"><span>${t('chat.ownerPrefix')} ${esc(owner?.name ?? t('chat.ownerUnset'))}</span><span class="sep"></span><span>${members.length === 1 ? t('chat.memberOne', { count: members.length }) : t('chat.memberMany', { count: members.length })}</span></div>
          </div>
          <div class="member-stack">
            ${members.slice(0, 6).map(member => {
              const bot = botById(member.id)
              return bot ? avatar(bot, 'sm') : ''
            }).join('')}
          </div>
        </div>
        <div class="chat-messages">
          ${canLoadOlder(messages.length) ? loadOlderButton() : ''}
          ${messages.length === 0 ? `<div class="chat-empty">
            <div class="empty-symbol">${icon('message')}</div>
            <h3>${t('chat.emptyTitle')}</h3>
            <p>${t('chat.emptyBody')}</p>
          </div>` : messages.map(renderMessage).join('')}
          ${typingRows(state.data.runs, 'chat')}
          ${typingLingerRowsHtml('chat', state.data.runs)}
        </div>
        ${renderDirectMessagesCard()}
                  <div class="composer">
          ${state.replyTo ? `<div class="reply-bar" id="reply-bar">
            <span class="reply-bar-icon">${icon('quote')}</span>
            <span class="reply-bar-text"><strong>${esc(state.replyTo.senderName)}</strong><span>${esc(mdPlainSummary(state.replyTo.excerpt, 120))}</span></span>
            <button class="reply-bar-cancel" data-action="cancel-reply" title="${t('composer.replyCancelTitle')}" aria-label="${t('composer.replyCancel')}">${icon('close')}</button>
          </div>` : ''}
          <div class="composer-box">
            ${composerImageStrip()}
            <div class="composer-ac" id="composer-ac" role="listbox" aria-label="${t('composer.acLabel')}" hidden></div>
            <div class="composer-resizer" id="composer-resizer" title="${t('composer.resizerTitle')}" role="separator" aria-orientation="horizontal" aria-label="${t('composer.resizerTitle')}"></div>
            <textarea id="composer-input" rows="2" placeholder="${t('composer.groupPlaceholder')}">${esc(currentDraft(state))}</textarea>
            <div class="composer-bottom">
              ${attachImageButton()}
              <span class="composer-hint"><kbd>⌘</kbd><kbd>Enter</kbd> ${t('composer.sendHint')}</span>
              <button class="send-btn" data-action="send-message" ${(currentDraft(state).trim() || pendingImagesFor().length) ? '' : 'disabled'} title="${t('composer.send')}" aria-label="${t('composer.sendMessage')}">${icon('send')}</button>
            </div>
          </div>
        </div>
      </div>
      <aside class="chat-side">
        <div class="side-card">
          <div class="side-card-head"><h3>${t('card.workspace')}</h3></div>
          <div class="path-row">${pathCode(project.workspace_path)}<button class="btn icon small" data-action="copy" data-copy="${attr(project.workspace_path)}" title="${t('common.copyPath')}" aria-label="${t('common.copyPath')}">${icon('copy')}</button></div>
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>${t('card.projectOwner')}</h3></div>
          ${owner ? `<div class="side-row owner-row">
            ${avatar(owner, 'sm')}
            <div class="member-info">
              <span class="member-name-line"><strong>${esc(owner.name)}</strong><span class="member-role">${t('card.ownerRole')}</span></span>
              <span class="member-model">${esc(ownerModelLine)}</span>
            </div>
            ${ownerDot ? runDotHtml(ownerDot) : ''}
          </div>` : `<div class="faint">${t('card.ownerUnset')}</div>`}
        </div>
        ${renderChatMembersCard()}
        <div class="side-card">
          <div class="side-card-head"><h3>${t('card.activeTasks')}</h3><span>${project.stats.openTasks}</span></div>
          ${open.length === 0 ? `<div class="faint">${t('card.noActiveTasks')}</div>` : `<div class="side-list">
            ${open.map(task => {
              const bot = botById(task.assignee_bot_id)
              return `<div class="side-row" data-action="open-task" data-task-id="${attr(task.id)}" style="cursor:pointer">
                ${sideRowStatusHtml(task.status)}
                <strong>${esc(task.identifier)}</strong>
                <span class="side-row-title">${esc(task.title)}</span>
                ${bot ? avatar(bot, 'sm') : ''}
              </div>`
            }).join('')}
          </div>${openTasks.length > CHAT_ACTIVE_TASK_LIMIT ? `<div class="faint">${t('common.more', { count: openTasks.length - CHAT_ACTIVE_TASK_LIMIT })}</div>` : ''}`}
        </div>
      </aside>
    </div>`
}

// 调度页侧栏列表的显示上限：后端已按 50 条封顶，侧栏再截断并给出剩余条数提示。
const DISPATCH_LIST_LIMIT = 10
function dispatchListNote(total) {
  return total > DISPATCH_LIST_LIMIT ? `<div class="faint">${t('common.more', { count: total - DISPATCH_LIST_LIMIT })}</div>` : ''
}

// 调度页任务行：编号 + 标题 + 状态 + 项目名；点击跳到该项目的任务页。
function dispatchTaskRow(task) {
  return `<div class="side-row" data-action="nav" data-view="tasks" data-project-id="${attr(task.project_id ?? '')}" style="cursor:pointer" title="${esc(`${task.identifier ?? ''} · ${task.title ?? ''} · ${task.projectName ?? ''}`)}">
    ${sideRowStatusHtml(task.status)}
    <strong>${esc(task.identifier ?? '')}</strong>
    <span class="side-row-title">${esc(task.title ?? '')}</span>
    <span class="faint">${esc(task.projectName ?? '')}</span>
  </div>`
}

// 调度页运行行：类型 + 状态点 + 项目 + 已运行时长（run-clock 每秒自刷新）。
function dispatchRunRow(run) {
  const started = run.started_at ?? run.queued_at ?? ''
  return `<div class="side-row" title="${esc(`${runKindLabel(run.kind)} · ${runStatusLabel(run.status)}`)}">
    <span class="run-dot ${attr(run.status ?? '')}"></span>
    <strong>${esc(runKindLabel(run.kind) ?? '')}</strong>
    <span class="side-row-title">${esc(run.projectKey == null || run.projectKey === '单聊' ? t('common.soloChat') : run.projectKey)}</span>
    <span class="run-clock" data-started="${attr(started)}">${duration(started)}</span>
  </div>`
}

// 项目外单聊（已升级为「调度页」）：每个 Bot 一条独立会话，运行目录在 _the_bots/<bot> 下。
function renderSoloChat() {
  const bots = (state.data?.bots ?? []).filter(bot => bot.status === 'active')
  if (bots.length === 0) {
    return `<div class="empty-state">
      <div class="empty-symbol">${icon('bot')}</div>
      <h3>${t('solo.noBotsTitle')}</h3>
      <p>${t('solo.noBotsBody')}</p>
      <button class="btn primary" data-action="new-bot">${icon('plus')}${t('solo.newBot')}</button>
    </div>`
  }
  if (!state.soloBotId || !bots.some(bot => bot.id === state.soloBotId)) state.soloBotId = bots[0].id
  const bot = botById(state.soloBotId)
  const solo = state.data?.solo?.bot?.id === bot.id ? state.data.solo : null
  const messages = mergedChatMessages(solo?.messages ?? [])
  const runs = solo?.runs ?? []
  const running = runs.filter(run => run.status === 'running' || run.status === 'queued').length
  // 调度数据只认当前 bot 的那一段：切 bot 后旧数据不得串台。
  const dispatch = state.data?.dispatch?.botId === bot.id ? state.data.dispatch : null
  const dispatchActive = dispatch?.tasks?.active ?? []
  const dispatchPending = dispatch?.tasks?.pending ?? []
  const dispatchRuns = dispatch?.runs ?? []
  return `
    <div class="chat-layout">
      <div class="card chat-panel">
        <div class="chat-head">
          <div>
            <div class="chat-head-title">${avatar(bot, 'sm')}<span>@${esc(bot.name)}</span></div>
            <div class="chat-head-meta"><span>${esc(bot.role || t('solo.roleFallback'))}</span><span class="sep"></span><span>${esc(bot.modelRef ?? t('common.modelUnset'))}</span>${running > 0 ? `<span class="sep"></span><span class="run-dot"></span><span>${t('solo.runningCount', { count: running })}</span>` : ''}</div>
          </div>
          <div class="chat-head-actions">
            <button class="btn small" data-action="nav" data-view="solo-config" title="${t('solo.openConfig')}">${icon('settings')}${t('solo.configButton')}</button>
          </div>
        </div>
        <div class="chat-messages">
          ${canLoadOlder(messages.length) ? loadOlderButton() : ''}
          ${messages.length === 0 ? `<div class="chat-empty">
            <div class="empty-symbol">${icon('message')}</div>
            <h3>${t('solo.emptyTitle', { name: bot.name })}</h3>
            <p>${t('solo.emptyBody')}</p>
          </div>` : messages.map(renderMessage).join('')}
          ${typingRows(runs, 'solo_chat')}
          ${typingLingerRowsHtml('solo_chat', runs)}
        </div>
        <div class="composer">
          <div class="composer-box">
            ${composerImageStrip()}
            <div class="composer-resizer" id="composer-resizer" title="${t('composer.resizerTitle')}" role="separator" aria-orientation="horizontal" aria-label="${t('composer.resizerTitle')}"></div>
            <textarea id="composer-input" rows="2" placeholder="${t('composer.soloPlaceholder', { name: bot.name })}">${esc(currentDraft(state))}</textarea>
            <div class="composer-bottom">
              ${attachImageButton()}
              <span class="composer-hint"><kbd>⌘</kbd><kbd>Enter</kbd> ${t('composer.sendHint')}</span>
              <button class="send-btn" data-action="send-message" ${(currentDraft(state).trim() || pendingImagesFor().length) ? '' : 'disabled'} title="${t('composer.send')}" aria-label="${t('composer.sendMessage')}">${icon('send')}</button>
            </div>
          </div>
        </div>
      </div>
      <aside class="chat-side">
        <div class="side-card">
          <div class="side-card-head"><h3>${t('solo.dispatchTarget')}</h3></div>
          <div class="owner-row">
            ${avatar(bot, 'lg')}
            <div class="owner-info"><strong>${esc(bot.name)}</strong><span>${esc(bot.role || t('solo.roleFallback'))} · ${esc(bot.modelRef ?? t('common.modelUnset'))}</span></div>
          </div>
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>${t('solo.activeTasks')}</h3><span>${dispatchActive.length}</span></div>
          ${dispatchActive.length === 0 ? `<div class="faint">${t('solo.noActive')}</div>` : `<div class="side-list">
            ${dispatchActive.slice(0, DISPATCH_LIST_LIMIT).map(dispatchTaskRow).join('')}
          </div>${dispatchListNote(dispatchActive.length)}`}
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>${t('solo.pendingTasks')}</h3><span>${dispatchPending.length}</span></div>
          ${dispatchPending.length === 0 ? `<div class="faint">${t('solo.noPending')}</div>` : `<div class="side-list">
            ${dispatchPending.slice(0, DISPATCH_LIST_LIMIT).map(dispatchTaskRow).join('')}
          </div>${dispatchListNote(dispatchPending.length)}`}
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>${t('solo.dispatching')}</h3><span>${dispatchRuns.length}</span></div>
          ${dispatchRuns.length === 0 ? `<div class="faint">${t('solo.noDispatching')}</div>` : `<div class="side-list">
            ${dispatchRuns.slice(0, DISPATCH_LIST_LIMIT).map(dispatchRunRow).join('')}
          </div>${dispatchListNote(dispatchRuns.length)}`}
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>${t('solo.subagents')}</h3></div>
          <div class="faint">${t('solo.subagentsBody')}</div>
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>${t('solo.recentRuns')}</h3><span>${runs.length}</span></div>
          ${runs.length === 0 ? `<div class="faint">${t('solo.noRuns')}</div>` : `<div class="side-list">
            ${runs.slice(0, 5).map(run => `<div class="side-row">
              <span class="run-dot ${attr(run.status)}"></span>
              <strong>${esc(runStatusLabel(run.status))}</strong>
              <span class="side-row-title">${esc(formatTime(run.queued_at))}</span>
            </div>`).join('')}
          </div>`}
        </div>
        <div class="side-card">
          <div class="side-card-head"><h3>${t('solo.workspace')}</h3></div>
          <div class="path-row">${pathCode(bot.soloWorkspace)}<button class="btn icon small" data-action="copy" data-copy="${attr(bot.soloWorkspace ?? '')}" title="${t('common.copyPath')}" aria-label="${t('common.copyPath')}">${icon('copy')}</button></div>
        </div>
      </aside>
    </div>`
}

// 单聊 Bot 的集中配置页：身份、模型、指令、运行统计与版本历史在一页完成。
async function loadSoloDetail() {
  const botId = state.soloBotId
  if (!botId) return
  state.soloDetail = null
  try {
    const detail = await api('bot_detail', { botId })
    if (state.view === 'solo-config' && state.soloBotId === botId) {
      state.soloDetail = detail
      render()
    }
  } catch {}
}

function renderSoloConfig() {
  const bot = botById(state.soloBotId)
  if (!bot) {
    return `<div class="empty-state">
      <div class="empty-symbol">${icon('bot')}</div>
      <h3>还没有选择 Bot</h3>
      <p>从左侧 Bots 树点一个 Bot 进入调度页，再点「配置」来到这里。</p>
      <button class="btn primary" data-action="nav" data-view="chat">返回对话</button>
    </div>`
  }
  const revisions = state.soloDetail?.revisions ?? []
  return `
    <div class="task-detail-grid">
      <div class="card config-card">
        <div class="owner-row" style="margin-bottom:16px">
          ${avatar(bot, 'lg')}
          <div class="owner-info"><strong style="font-size:var(--fs-title)">${esc(bot.name)}</strong><span>${esc(bot.role || '团队成员')} · ${esc(bot.modelRef ?? '未配置模型')} · ${esc(BOT_STATUS[bot.status] ?? bot.status)}</span></div>
        </div>
        <form data-form="update-bot" id="solo-config-form">
          <input type="hidden" name="botId" value="${attr(bot.id)}">
          <div class="field-row">
            <div class="field"><label for="solo-bot-name">名称</label><input class="input" style="width:100%" id="solo-bot-name" name="name" value="${attr(bot.name)}" placeholder="例如：Builder" required maxlength="24"></div>
            <div class="field"><label for="solo-bot-role">角色标签</label><input class="input" style="width:100%" id="solo-bot-role" name="role" value="${attr(bot.role ?? '')}" placeholder="例如：开发" maxlength="24"></div>
          </div>
          <div class="field-row">
            <div class="field"><label for="solo-bot-model">模型</label><select class="select" style="width:100%" id="solo-bot-model" name="modelRef" data-model-select>${modelOptions(bot.provider, bot.model)}</select></div>
            <div class="field"><label for="solo-bot-effort">推理强度</label><select class="select" style="width:100%" id="solo-bot-effort" name="effort" data-effort-select>${effortOptions(bot.modelRef ?? '', bot.effort)}</select></div>
            <div class="field"><label for="solo-bot-file-policy">文件权限</label><select class="select" style="width:100%" id="solo-bot-file-policy" name="filePolicy" title="Bot 会话内文件操作的沙箱边界，下次运行生效">${filePolicyOptions(bot.file_policy)}</select></div>
          </div>
          <div class="field-row">
            <div class="field"><label for="solo-bot-fallback-model">备用模型</label><select class="select" style="width:100%" id="solo-bot-fallback-model" name="fallbackModelRef" data-fallback-model-select title="主模型不可用时自动接手的备用模型，留空 = 不启用">${fallbackModelOptions(bot.fallbackModelRef ?? '')}</select></div>
            <div class="field"><label for="solo-bot-fallback-effort">备用推理强度</label><select class="select" style="width:100%" id="solo-bot-fallback-effort" name="fallbackEffort" data-fallback-effort-select>${effortOptions(bot.fallbackModelRef ?? '', bot.fallback_effort)}</select></div>
          </div>
          <div class="field"><span class="field-label" id="solo-bot-color-label">外观颜色</span><div class="swatch-row" role="radiogroup" aria-labelledby="solo-bot-color-label">${COLORS.map(color => `<label class="swatch" title="${COLOR_NAMES[color] ?? color}"><input type="radio" name="color" value="${color}" aria-label="${COLOR_NAMES[color] ?? color}" ${(bot.color ?? COLORS[0]) === color ? 'checked' : ''}><span class="swatch-dot ${color}"></span></label>`).join('')}</div></div>
          <div class="field"><label for="solo-bot-instructions">角色指令</label><textarea class="textarea" style="width:100%" id="solo-bot-instructions" name="instructions" rows="12" placeholder="说明职责、工作方式、边界和交付标准">${esc(bot.instructions ?? '')}</textarea></div>
        </form>
        <div class="divider"></div>
        <div class="btn-row">
          <button class="btn primary" type="submit" form="solo-config-form">${icon('check')}保存新版本</button>
          ${bot.status === 'active' ? `<button class="btn small" data-action="archive-bot" data-bot-id="${attr(bot.id)}">归档 Bot</button>` : ''}
        </div>
      </div>
      <aside class="task-detail-side">
        <div class="eyebrow" style="margin-bottom:9px">运行统计</div>
        <div class="kv"><span>运行次数</span><strong>${bot.stats.runs}</strong></div>
        <div class="kv"><span>成功 / 失败</span><strong>${bot.stats.succeeded} / ${bot.stats.failed}</strong></div>
        <div class="kv"><span>长期记忆</span><strong>${bot.memoryCount}</strong></div>
        <div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:6px">专属工作区</div>
        <div class="path-row">${pathCode(bot.soloWorkspace)}<button class="btn icon small" data-action="copy" data-copy="${attr(bot.soloWorkspace ?? '')}" title="复制路径" aria-label="复制路径">${icon('copy')}</button></div>
        <div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:9px">版本历史</div>
        ${revisions.length === 0 ? '<div class="faint">' + (state.soloDetail ? '暂无版本' : '加载中…') + '</div>' : revisions.map(revision => `<div class="revision-row"><span class="mono">v${revision.version}</span><span class="faint">${esc(timeAgo(revision.created_at))}</span>${revision.version === bot.current_revision ? '' : `<button class="btn small" data-action="rollback-bot" data-bot-id="${attr(bot.id)}" data-revision-id="${attr(revision.id)}">回滚</button>`}</div>`).join('')}
        <div class="usage-note">模型或强度变更会在下一次运行时生效，不会中断当前运行。</div>
      </aside>
    </div>`
}



export { activeTypingRuns, typingRows, chatKey, mergedChatMessages, canLoadOlder, loadOlderButton, loadOlderMessages, renderChatMembersCard, renderChat, DISPATCH_LIST_LIMIT, dispatchListNote, dispatchTaskRow, dispatchRunRow, renderSoloChat, loadSoloDetail, renderSoloConfig }
