import { state, STATUS, STATUS_ORDER, PRIORITY, BOT_STATUS, SKILL_STATUS, RUN_STATUS, CREATOR_TYPE, EFFORT, COLORS, COLOR_NAMES, stageLabelText } from './state.js'
import { icon } from './icons.js'
import { activeBots, activeProject, attr, avatar, botById, duration, esc, filePolicyOptions, formatCost, formatNumber, formatTime, inSoloContext, pageProject, runDot, sandboxPill, timeAgo, toast } from './util.js'
import { api } from './api.js'
import { mdChatScope, richText } from './markdown.js'
import { t } from './i18n.js'
import { currentSkillVersion, skillVersions, taskUsageBlock } from './tasks.js'
import { ensureComposerImageInput, ensureImageViewer } from './composer.js'
import { app, refresh, panelAttrs, render, updateRunClocks } from '../app.js'
import { modalShell, modalLoading, renderModalLayer } from './modal-layer.js'

function modelOptions(provider, model) {
  const models = state.data?.models ?? []
  if (models.length === 0) return `<option value="">DSH ${t("尚未提供模型")}</option>`
  return models.map(item => `<option value="${attr(item.ref)}" ${item.provider === provider && item.model === model ? 'selected' : ''}>${esc(item.providerName)} / ${esc(item.name)}</option>`).join('')
}

function effortOptions(modelRef, current) {
  const model = (state.data?.models ?? []).find(item => item.ref === modelRef)
  const efforts = model?.efforts ?? []
  if (efforts.length === 0) return `<option value="">${t("模型默认")}${current ? `${t("（当前")} ${esc(EFFORT[current] ?? current)}${t("）")}` : ''}</option>`
  return `<option value="">${t("模型默认")}</option>${efforts.map(effort => `<option value="${attr(effort.id)}" ${current === effort.id ? 'selected' : ''}>${esc(EFFORT[effort.id] ?? effort.name)}</option>`).join('')}`
}

// 备用模型下拉：首项留空即「不启用」；其余与主模型同一模型表。
function fallbackModelOptions(currentRef) {
  const models = state.data?.models ?? []
  const blank = `<option value=""${currentRef ? '' : ' selected'}>${t("不启用（留空）")}</option>`
  if (models.length === 0) return blank
  return blank + models.map(item => `<option value="${attr(item.ref)}" ${item.ref === currentRef ? 'selected' : ''}>${esc(item.providerName)} / ${esc(item.name)}</option>`).join('')
}

// fallback-model:start —— 备用模型字段的纯逻辑（tests/bot-fallback-model.test.js 抽取此块断言）
// ref 形如 provider/model；留空即「不启用」，三个字段一起清空（后端按 null 落库）。
function parseFallbackFields(ref, effort) {
  const value = String(ref ?? '')
  const slash = value.indexOf('/')
  const provider = slash > 0 ? value.slice(0, slash) : null
  const model = slash > 0 ? value.slice(slash + 1) : null
  return {
    fallbackProvider: provider,
    fallbackModel: model,
    fallbackEffort: model ? (effort || null) : null,
  }
}
// fallback-model:end

function modalNewProject() {
  const bots = activeBots()
  return modalShell({
    title: t("新建项目空间"),
    badge: '',
    body: `<form data-form="create-project" id="modal-form">
      <div class="field"><label id="new-project-name-label" for="new-project-name">${t("项目名称")}</label><input class="input" style="width:100%" id="new-project-name" name="name" placeholder="${t("例如：官网重构")}" required maxlength="80" autofocus></div>
      <div class="field-row">
        <div class="field"><label id="new-project-key-label" for="new-project-key">${t("项目")} Key</label><input class="input mono" style="width:100%" id="new-project-key" name="key" placeholder="WEB" maxlength="10" pattern="[A-Za-z][A-Za-z0-9]{0,9}"><div class="hint">${t("任务的编号前缀。")}</div></div>
        <div class="field"><label id="new-project-owner-label" for="new-project-owner">${t("总监")} Bot</label><select class="select" style="width:100%" id="new-project-owner" name="ownerBotId">${bots.map(bot => `<option value="${attr(bot.id)}">${esc(bot.name)} · ${esc(bot.role || t("成员"))}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label id="new-project-description-label" for="new-project-description">${t("项目说明")}</label><textarea class="textarea" id="new-project-description" name="description" placeholder="${t("项目目标、边界和验收标准")}"></textarea></div>
      <div class="field"><label id="new-project-production-label" for="new-project-production">${t("生产目录")}</label><div style="display:flex;gap:8px"><input class="input mono" style="flex:1" id="new-project-production" name="productionDir" placeholder="/Users/you/repos/my-game${t("（可选）")}"><button class="btn" type="button" data-action="pick-dir-open" data-picker-for="new-project-production">${icon('folder')}${t("选择")}</button></div><div class="hint">Bots ${t("的工作目录，可指向既有代码库等本机目录；留空则用默认管理目录。")}</div><div class="dir-picker" id="dir-picker-new-project-production" hidden></div></div>
      ${bots.length > 1 ? `<div class="field"><span class="field-label" id="new-project-members-label">${t("其他成员")}</span><div class="check-list" role="group" aria-labelledby="new-project-members-label">${bots.slice(1).map(bot => `<div class="check-row"><input type="checkbox" id="new-project-member-${attr(bot.id)}" name="memberIds" value="${attr(bot.id)}"><label for="new-project-member-${attr(bot.id)}">${avatar(bot, 'sm')} ${esc(bot.name)}</label><span class="role">${esc(bot.role || '')}</span></div>`).join('')}</div></div>` : ''}
    </form>`,
    footer: `<button class="btn" data-action="close-modal">${t("取消")}</button><button class="btn primary" type="submit" form="modal-form">${icon('plus')}${t("创建项目")}</button>`,
  })
}

// 移除追踪的两步确认弹窗：第一步列后果 + 可选「同时移除生产目录」；
// 第二步输入项目名（完全一致才点亮执行按钮，见 input 监听里的门禁）。
function modalRemoveTracking() {
  const modal = state.modal
  if (modal.step === 2) {
    return modalShell({
      title: t("移除追踪 · 确认执行"),
      badge: t("不可恢复"),
      subtitle: `${t("输入项目名「")}${modal.name}${t("」以确认。")}`,
      body: `<form data-form="remove-tracking" id="modal-form">
        <input type="hidden" name="projectId" value="${attr(modal.projectId)}">
        <input type="hidden" name="purge" value="${modal.purge ? '1' : ''}">
        <div class="field"><label for="remove-tracking-name">${t("项目名称")}</label><input class="input" style="width:100%" id="remove-tracking-name" name="confirmName" placeholder="${esc(modal.name)}" autocomplete="off" autofocus></div>
        <div class="hint">${modal.purge ? t("将删除本项目全部管理数据，并移除项目生产目录（含全部文件）。") : t("将删除本项目全部管理数据；项目生产目录保留。")}${t("此操作不可恢复。")}</div>
      </form>`,
      footer: `<button class="btn" data-action="remove-tracking-back" type="button">${t("上一步")}</button><button class="btn danger" type="submit" form="modal-form" id="remove-tracking-submit" disabled>${t("确认移除追踪")}</button>`,
    })
  }
  return modalShell({
    title: t("移除追踪 · 后果确认"),
    badge: t("不可恢复"),
    subtitle: `${t("将从本工作台移除已归档项目「")}${modal.name}${t("」。")}`,
    body: `
      <ul class="remove-tracking-list">
        <li>${t("本项目全部管理数据将删除：任务、运行记录、聊天消息、成员、记忆、提案、密钥绑定等。")}</li>
        <li>${t("数据库中本项目的记录将一并清理，")}<strong>${t("不可恢复")}</strong>${t("。")}</li>
        <li>${t("项目生产目录默认保留在原处。")}</li>
      </ul>
      <div class="check-row"><input type="checkbox" id="remove-tracking-purge"><label for="remove-tracking-purge">${t("同时移除项目生产目录")}</label></div>
      <div class="hint">${t("勾选后将删除项目生产目录（含目录内全部文件），同样不可恢复；不确定就先不勾。")}</div>`,
    footer: `<button class="btn" data-action="close-modal">${t("取消")}</button><button class="btn danger" data-action="remove-tracking-step2" type="button">${t("继续")}</button>`,
  })
}

// 已归档 Bot 的移除追踪两步确认弹窗（DSHBOTS-193）：与项目侧同构。Bot 侧为软移除——数据与
// 工作区目录全部保留、仅停止追踪，故无 purge 复选框；第二步复用 #remove-tracking-name/
// #remove-tracking-submit 两个 id 让 events-misc 输入门禁免改生效，且不含 form：执行按钮走
// data-action 而非表单提交，不与项目侧 remove-tracking 表单链冲突。
function modalRemoveBotTracking() {
  const modal = state.modal
  if (modal.step === 2) {
    return modalShell({
      title: t("移除追踪 · 确认执行"),
      badge: t("从列表移除"),
      subtitle: `${t("输入 Bot 名称「")}${modal.name}${t("」以确认。")}`,
      body: `<div class="field"><label for="remove-tracking-name">Bot ${t("名称")}</label><input class="input" style="width:100%" id="remove-tracking-name" name="confirmName" placeholder="${esc(modal.name)}" autocomplete="off" autofocus></div>
        <div class="hint">${t("将从工作台列表移除「")}${esc(modal.name)}${t("」；运行记录、单聊消息与工作区文件全部保留，但移除后不能再恢复追踪。")}</div>`,
      footer: `<button class="btn" data-action="bot-remove-tracking-back" type="button">${t("上一步")}</button><button class="btn danger" type="button" id="remove-tracking-submit" data-action="bot-remove-tracking-confirm" disabled>${t("确认移除追踪")}</button>`,
    })
  }
  return modalShell({
    title: t("移除追踪 · 后果确认"),
    badge: t("从列表移除"),
    subtitle: `${t("将停止追踪已归档 Bot「")}${modal.name}${t("」。")}`,
    body: `<ul class="remove-tracking-list"><li>${t("该 Bot 将从工作台 Bots 列表与单聊入口移除，不再显示。")}</li><li>${t("运行记录、单聊消息、版本历史与专属工作区目录")}<strong>${t("全部保留")}</strong>${t("（不做物理删除）。")}</li><li>${t("移除追踪后不能恢复，该 Bot 也不能再被修改或重新启用。")}</li></ul><div class="hint">${t("这是软移除：数据只在数据库中停止展示，不清理任何文件。")}</div>`,
    footer: `<button class="btn" data-action="close-modal">${t("取消")}</button><button class="btn danger" data-action="bot-remove-tracking-step2" type="button">${t("继续")}</button>`,
  })
}

// 生产目录路径选择器：逐级浏览本机目录后回填目标输入框。
// 只改写选择器子树与目标输入框，不触发全局 render，避免重建创建表单丢掉已填内容。
function closeDirPicker(inputId) {
  const box = document.getElementById(`dir-picker-${inputId}`)
  if (box) {
    box.hidden = true
    box.innerHTML = ''
  }
}

async function renderDirPicker(inputId, path) {
  const box = document.getElementById(`dir-picker-${inputId}`)
  if (!box) return
  box.hidden = false
  let data = null
  let error = ''
  try {
    data = await api('browse_dirs', { path }, { quiet: true })
  } catch (err: any) {
    error = err?.message || String(err)
  }
  const current = data?.path ?? path ?? ''
  const head = `\n    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">\n      <button class="btn small" type="button" data-action="pick-dir-up" data-picker-for="${attr(inputId)}" data-path="${attr(current)}" title="${t("上一级")}">↑</button>\n      <button class="btn small" type="button" data-action="pick-dir-home" data-picker-for="${attr(inputId)}">${t("主目录")}</button>\n      <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${attr(current)}">${esc(current)}</span>\n      <button class="btn primary small" type="button" data-action="pick-dir-choose" data-picker-for="${attr(inputId)}" data-path="${attr(current)}">${t("选定此目录")}</button>\n      <button class="btn small" type="button" data-action="pick-dir-close" data-picker-for="${attr(inputId)}" title="${t("关闭")}">✕</button>\n    </div>`
  if (error) {
    box.innerHTML = `${head}<div class="hint" style="color:#c0392b">${esc(error)}</div>`
    return
  }
  const dirs = data?.dirs ?? []
  const list = dirs.length === 0
    ? `<div class="hint">${t("没有子目录")}</div>`
    : dirs.map(name => `
      <button class="btn small" type="button" style="display:block;width:100%;text-align:left;margin-bottom:4px" data-action="pick-dir-nav" data-picker-for="${attr(inputId)}" data-path="${attr(`${current.replace(/\/+$/, '')}/${name}`)}">${icon('folder')} ${esc(name)}</button>`).join('')
  box.innerHTML = `${head}<div style="max-height:220px;overflow:auto">${list}</div>`
}

// 邀请选人弹窗：只列未入本项目且 status 为 active 的 bot，单选后确认提交 add_member。
// 关闭 / 取消 / 遮罩 / ESC 均为零变更（复用 modalShell 骨架）。
function modalInviteMember() {
  const project = activeProject()
  if (!project) {
    return modalShell({
      title: t("邀请加入"),
      body: `<div class="empty-state" style="border:0"><div class="empty-symbol">${icon('bot')}</div><h3>${t("请先进入一个项目")}</h3><p>${t("进入项目后才能邀请成员。")}</p></div>`,
      footer: `<button class="btn" data-action="close-modal">${t("关闭")}</button>`,
      size: 'small',
    })
  }
  const memberIds = new Set((project.members ?? []).map(member => member.id))
  const candidates = (state.data?.bots ?? []).filter(bot => bot.status === 'active' && !memberIds.has(bot.id))
  if (candidates.length === 0) {
    return modalShell({
      title: t("邀请加入"),
      subtitle: `${t("项目：")}${project.name}`,
      body: `<div class="empty-state" style="border:0"><div class="empty-symbol">${icon('bot')}</div><h3>${t("所有可用 Bot 都已在项目中")}</h3><p>${t("先新建一个 Bot，再回来邀请它加入。")}</p></div>`,
      footer: `<button class="btn" data-action="close-modal">${t("取消")}</button><button class="btn" data-action="new-bot">${icon('plus')}${t("新建")} Bot</button>`,
    })
  }
  const selected = state.modal?.botId ?? ''
  return modalShell({
    title: t("邀请加入"),
    subtitle: `${t("项目：")}${project.name}${t("，选择一个 Bot。")}`,
    body: `<form data-form="invite-member" id="modal-form">
      <div class="list">
        ${candidates.map(bot => `
          <label class="list-row" title="${esc(bot.name)} · ${esc(bot.role || t("成员"))}">
            <input type="radio" name="botId" value="${attr(bot.id)}" ${bot.id === selected ? 'checked' : ''}>
            ${avatar(bot, 'sm')}
            <div class="list-main">
              <div class="list-title"><strong>${esc(bot.name)}</strong><span class="member-role">${esc(bot.role || t("成员"))}</span></div>
            </div>
          </label>`).join('')}
      </div>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">${t("取消")}</button><button class="btn primary" type="submit" form="modal-form" id="invite-member-submit" ${selected ? '' : 'disabled'}>${icon('check')}${t("确认邀请")}</button>`,
  })
}

function modalBot(detail) {
  const bot = detail?.bot ?? null
  const modelRef = bot?.modelRef ?? state.data?.models?.[0]?.ref ?? ''
  return modalShell({
    title: bot ? `${t("配置")} ${bot.name}` : t("新建 Bot"),
    subtitle: '',
    badge: '',
    size: 'wide',
    body: `<div class="${bot ? 'task-detail-grid' : ''}">
      <form data-form="${bot ? 'update-bot' : 'create-bot'}" id="modal-form">
        <input type="hidden" name="botId" value="${attr(bot?.id ?? '')}">
        <div class="field-row">
          <div class="field"><label id="bot-name-label" for="bot-name">${t("名称")}</label><input class="input" style="width:100%" id="bot-name" name="name" value="${attr(bot?.name ?? '')}" placeholder="${t("例如：")}Builder" required maxlength="24"></div>
          <div class="field"><label id="bot-role-label" for="bot-role">${t("角色标签")}</label><input class="input" style="width:100%" id="bot-role" name="role" value="${attr(bot?.role ?? '')}" placeholder="${t("例如：开发")}" maxlength="24"></div>
        </div>
        <div class="field-row">
          <div class="field"><label id="bot-model-label" for="bot-model">${t("模型")}</label><select class="select" style="width:100%" id="bot-model" name="modelRef" data-model-select>${modelOptions(bot?.provider, bot?.model)}</select></div>
          <div class="field"><label id="bot-effort-label" for="bot-effort">${t("推理强度")}</label><select class="select" style="width:100%" id="bot-effort" name="effort" data-effort-select>${effortOptions(modelRef, bot?.effort)}</select></div>
          <div class="field"><label id="bot-file-policy-label" for="bot-file-policy">${t("文件权限")}</label><select class="select" style="width:100%" id="bot-file-policy" name="filePolicy" title="Bot ${t("会话内文件操作的沙箱边界，下次运行生效")}">${filePolicyOptions(bot?.file_policy)}</select></div>
        </div>
        <div class="field-row">
          <div class="field"><label id="bot-fallback-model-label" for="bot-fallback-model">${t("备用模型")}</label><select class="select" style="width:100%" id="bot-fallback-model" name="fallbackModelRef" data-fallback-model-select title="${t("主模型不可用时自动接手的备用模型，留空")} = ${t("不启用")}">${fallbackModelOptions(bot?.fallbackModelRef ?? '')}</select></div>
          <div class="field"><label id="bot-fallback-effort-label" for="bot-fallback-effort">${t("备用推理强度")}</label><select class="select" style="width:100%" id="bot-fallback-effort" name="fallbackEffort" data-fallback-effort-select>${effortOptions(bot?.fallbackModelRef ?? '', bot?.fallback_effort)}</select></div>
        </div>
        <div class="field"><span class="field-label" id="bot-color-label">${t("外观颜色")}</span><div class="swatch-row" role="radiogroup" aria-labelledby="bot-color-label">${COLORS.map(color => `<label class="swatch" title="${COLOR_NAMES[color] ?? color}"><input type="radio" name="color" value="${color}" aria-label="${COLOR_NAMES[color] ?? color}" ${(bot?.color ?? COLORS[0]) === color ? 'checked' : ''}><span class="swatch-dot ${color}"></span></label>`).join('')}</div>${bot ? `<div class="avatar-roll-row"><span class="faint">${t("像素头像")}</span><button class="btn small" type="button" data-action="roll-avatar" data-bot-id="${attr(bot.id)}">roll</button><button class="btn small" type="button" data-action="toggle-avatar" data-bot-id="${attr(bot.id)}">${bot.avatar_seed ? t("停用") : t("启用")}</button></div>` : ''}</div>
        <div class="field"><label id="bot-instructions-label" for="bot-instructions">${t("角色指令")}</label><textarea class="textarea" id="bot-instructions" name="instructions" rows="10" placeholder="${t("说明职责、工作方式、边界和交付标准")}">${esc(bot?.instructions ?? '')}</textarea></div>
        ${bot ? `<div class="btn-row"><button class="btn small" type="button" data-action="archive-bot" data-bot-id="${attr(bot.id)}">${t("归档")} Bot</button></div>` : ''}
      </form>
      ${bot ? `<aside class="task-detail-side">
        <div class="eyebrow" style="margin-bottom:9px">${t("版本历史")}</div>
        ${(detail.revisions ?? []).map(revision => `<div class="revision-row"><span class="mono">v${revision.version}</span><span class="faint">${esc(timeAgo(revision.created_at))}</span>${revision.version === bot.current_revision ? '' : `<button class="btn small" data-action="rollback-bot" data-bot-id="${attr(bot.id)}" data-revision-id="${attr(revision.id)}">${t("回滚")}</button>`}</div>`).join('') || `<div class="faint">${t("暂无版本")}</div>`}
        <div class="divider"></div>
        <div class="kv"><span>${t("运行次数")}</span><strong>${bot.stats.runs}</strong></div>
        <div class="kv"><span>${t("成功 / 失败")}</span><strong>${bot.stats.succeeded} / ${bot.stats.failed}</strong></div>
        <div class="kv"><span>${t("长期记忆")}</span><strong>${bot.memoryCount}</strong></div>
        <div class="kv"><span>${t("状态")}</span><strong>${esc(BOT_STATUS[bot.status] ?? bot.status)}</strong></div>
        <div class="usage-note">${t("模型或强度变更会在下一次运行时生效，不会中断当前运行。")}</div>
      </aside>` : ''}
    </div>`,
    footer: `<button class="btn" data-action="close-modal">${t("取消")}</button><button class="btn primary" type="submit" form="modal-form">${bot ? `${icon('check')}${t("保存新版本")}` : `${icon('plus')}${t("创建")} Bot`}</button>`,
  })
}

// 任务关系选项（DSHBOTS-58）：父任务与依赖任务都只从本项目已有任务里选——
// 后端只接受同项目内引用，跨项目与自引用会被直接拒绝，列表因此不给别的项目的任务。
// selectedId（D-63 派生子任务）：给指定任务打 selected，让预填的父任务在下拉里真正选中显示，
// 而不是值带了、显示还停在「无（顶层任务）」。
function taskRelationOptions(selectedId = '') {
  const tasks = state.data?.tasks ?? []
  return tasks.map(task => `<option value="${attr(task.id)}"${task.id === selectedId ? ' selected' : ''}>${esc(task.identifier)} · ${esc(task.title)}</option>`).join('')
}

// time-budget:start —— 「时效要求（分钟）」表单值归一（DSHBOTS-129）
// 空串 / 0 / 负数 / 非数字 → null（视为未提时效，提交时整键不传，服务端按 NULL 处理）；
// 正数向下取整到整数分钟（服务端再钳到 1..10080）。
function normalizeTimeBudgetMinutes(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}
// time-budget:end

function modalNewTask() {
  const project = activeProject()
  if (!project) return ''
  // 派生子任务入口（D-63）带 parentTaskId 预填；常规新建不带。
  const preselectedParent = state.modal?.parentTaskId ?? ''
  return modalShell({
    title: t("新建任务"),
    subtitle: `${project.key} · ${project.name}`,
    badge: '',
    body: `<form data-form="create-task" id="modal-form">
      <input type="hidden" name="projectId" value="${attr(project.id)}">
      <div class="field"><label id="new-task-title-label" for="new-task-title">${t("标题")}</label><input class="input" style="width:100%" id="new-task-title" name="title" required maxlength="240" placeholder="${t("一个可执行、可验收的结果")}" autofocus></div>
      <div class="field"><label id="new-task-description-label" for="new-task-description">${t("描述")}</label><textarea class="textarea" id="new-task-description" name="description" rows="8" placeholder="${t("背景、范围、约束、验收标准")}"></textarea></div>
      <div class="field-row" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
        <div class="field"><label id="new-task-assignee-label" for="new-task-assignee">${t("指派给")}</label><select class="select" style="width:100%" id="new-task-assignee" name="assigneeBotId">${project.members.map(member => `<option value="${attr(member.id)}">${esc(member.name)} · ${esc(member.bot_role || '')}</option>`).join('')}</select></div>
        <div class="field"><label id="new-task-priority-label" for="new-task-priority">${t("优先级")}</label><select class="select" style="width:100%" id="new-task-priority" name="priority"><option value="medium">${t("中")}</option><option value="high">${t("高")}</option><option value="urgent">${t("紧急")}</option><option value="low">${t("低")}</option><option value="none">${t("无")}</option></select></div>
        <div class="field"><label id="new-task-time-budget-label" for="new-task-time-budget">${t('taskForm.timeBudgetLabel')}</label><input class="input" style="width:100%" id="new-task-time-budget" name="time_budget_minutes" type="number" min="1" max="10080" step="1" placeholder="${attr(t('taskForm.timeBudgetPlaceholder'))}"><div class="usage-note">${t('task.timeBudgetNote')}</div></div>
      </div>
      <div class="field-row">
        <div class="field"><label id="new-task-parent-label" for="new-task-parent">${t("父任务")}</label><select class="select" style="width:100%" id="new-task-parent" name="parentTaskId"><option value="">${t("无（顶层任务）")}</option>${taskRelationOptions(preselectedParent)}</select></div>
        <div class="field"><label id="new-task-blocked-label" for="new-task-blocked">${t("依赖任务")}</label><select class="select" style="width:100%" id="new-task-blocked" name="blockedBy" multiple size="4">${taskRelationOptions()}</select></div>
      </div>
      <div class="usage-note">${t("父任务只影响看板上的层级缩进；依赖任务未完成前，本任务不会被调度执行。")}</div>
      <div class="check-row"><input type="checkbox" id="new-task-autostart" name="autoStart" checked><label for="new-task-autostart">${t("创建后立即进入执行队列")}</label></div>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">${t("取消")}</button><button class="btn primary" type="submit" form="modal-form">${icon('plus')}${t("创建任务")}</button>`,
  })
}

function modalSkill(detail) {
  if (!detail) return modalLoading(t("技能详情"))
  const project = pageProject()
  const off = project?.disabledSkills?.includes(detail.slug) ?? false
  return modalShell({
    title: detail.name || detail.slug,
    subtitle: `/${detail.slug}`,
    badge: t("共享技能"),
    size: 'wide',
    body: `<div class="kv-grid">
        <div><div class="eyebrow">${t("状态")}</div><div class="pill ${detail.status === 'active' ? 'green' : 'red'}">${esc(SKILL_STATUS[detail.status] ?? detail.status)}</div></div>
        <div><div class="eyebrow">${t("版本")}</div><div>v${esc(currentSkillVersion(detail))}</div></div>
        <div><div class="eyebrow">${t("本项目")}</div><div>${off ? `<span class="pill">${t("已停用")}</span>` : `<span class="pill green">${t("可用")}</span>`}</div></div>
      </div>
      <div class="detail-block"><div class="eyebrow">${t("描述")}</div><div>${esc(detail.description || t("无描述"))}</div></div>
      <div class="detail-block"><div class="eyebrow">${t("文件")}</div><code class="mono detail-path">${esc(detail.path || detail.sharedPath || '')}</code></div>
      <div class="divider"></div>
      <div class="eyebrow">SKILL.md ${t("全文")}</div>
      ${detail.readable ? `<pre class="detail-pre">${esc(detail.content)}</pre>` : `<div class="note">${t("技能文件当前不可读（可能已被移动或删除），可尝试重新扫描。")}</div>`}
      ${(detail.versions ?? []).length ? `<div class="divider"></div>
      ${skillVersions(detail)}` : ''}`,
    footer: `<button class="btn" data-action="close-modal">${t("关闭")}</button>${project ? `<button class="btn ${off ? 'primary' : ''}" data-action="toggle-skill" data-slug="${attr(detail.slug)}" data-disabled="${off ? '0' : '1'}">${off ? t("在本项目恢复") : t("在本项目停用")}</button>` : ''}`,
  })
}

const ARTIFACT_IMAGE = /\.(png|jpe?g|gif|webp)$/i
const artifactFileUrl = (runId, path) =>
  `/api/dsh-team/artifact-file?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`

// 已完成写运行的交付产物：默认收起（与「查看输出」同一折叠口径），展开后图片内联预览（点击新窗口打开），其余文件列出路径与扩展名徽标。
function runArtifacts(state, run) {
  const list = Array.isArray(run.artifacts) ? run.artifacts : []
  if (run.status !== 'succeeded' || list.length === 0) return ''
  const rows = []
  for (const item of list) {
    const path = String(item?.path ?? '')
    if (!path) continue
    const url = artifactFileUrl(run.id, path)
    if (ARTIFACT_IMAGE.test(path)) {
      rows.push(`<button type="button" class="artifact-thumb" data-action="open-artifact" data-url="${attr(url)}" title="${attr(path)}"><img src="${attr(url)}" alt="${attr(path)}" loading="lazy"></button>`)
    } else {
      const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'file').toUpperCase().slice(0, 6)
      rows.push(`<a class="artifact-file" href="${attr(url)}" target="_blank" rel="noopener"><span class="artifact-path">${esc(path)}</span><span class="artifact-ext mono">${esc(ext)}</span></a>`)
    }
  }
  if (!rows.length) return ''
  return `<details style="margin-top:6px"${panelAttrs(state, `run-artifacts:${run.id}`)}><summary class="summary-link">${t("交付产物（")}${rows.length}${t("）")}</summary><div class="artifact-list">${rows.join('')}</div></details>`
}

// ===== 思考过程：Bot 运行轨迹（run_trajectory）=====

const TRAJ_LABELS = { thinking: t("思考"), text: t("回复"), tool_call: t("调用工具"), tool_result: t("工具返回"), end: t("运行结束") }

function trajectoryLabel(entry) {
  const kind = String(entry?.kind ?? '')
  const title = String(entry?.title ?? '').trim()
  if (kind === 'tool_call') return title ? (title.startsWith(t("调用工具")) ? title : t("调用工具 ${title}", { title: title })) : TRAJ_LABELS.tool_call
  if (kind === 'tool_result') return title ? (title.startsWith(t("工具")) ? title : t("工具 ${title} 返回", { title: title })) : TRAJ_LABELS.tool_result
  return title || TRAJ_LABELS[kind] || ''
}

function trajectoryEntry(entry, index = 0, runId = '') {
  const kind = String(entry?.kind ?? '')
  const title = String(entry?.title ?? '').trim()
  const detail = String(entry?.detail ?? '')
  const label = trajectoryLabel(entry)
  if (kind === 'turn') {
    return `<div class="traj-turn"><span>${esc(title || `${t("第")} ${entry?.turn ?? ''} ${t("轮")}`)}</span></div>`
  }
  if (kind === 'note') {
    return `<div class="traj-note">${esc([title, detail].filter(Boolean).join(' · '))}</div>`
  }
  if (kind === 'thinking' || kind === 'tool_call' || kind === 'tool_result') {
    const body = detail ? `<div class="traj-detail${kind === 'thinking' ? '' : ' traj-json'}">${esc(detail)}</div>` : ''
    return `<details class="traj-entry traj-fold"${panelAttrs(state, `traj:${runId}:${index}`)}><summary class="traj-entry-head">${esc(label)}</summary>${body}</details>`
  }
  const head = `<div class="traj-entry-head">${esc(label || title || kind)}</div>`
  const body = detail ? `<div class="traj-detail">${esc(detail)}</div>` : ''
  return `<div class="traj-entry${kind === 'end' ? ' traj-end' : ''}">${head}${body}</div>`
}

function modalTrajectory(detail, runId) {
  const entries = Array.isArray(detail?.entries) ? detail.entries : []
  const body = entries.length === 0
    ? `<div class="faint">${t("这次运行没有可展示的轨迹。")}</div>`
    : `<div class="traj-stream">${entries.map((entry, index) => trajectoryEntry(entry, index, runId)).join('')}</div>`
  return modalShell({
    title: t("思考过程"),
    subtitle: entries.length ? `${entries.length} ${t("条轨迹记录")}` : '',
    body,
    footer: `<button class="btn" data-action="close-modal">${t("关闭")}</button>`,
    size: 'wide',
  })
}

// 运行行时长（DSHBOTS-154）：running 运行的 duration 无 end、按 Date.now() 计，每秒都变。
// 直接嵌进 modal html 会让 reloadTaskModal 的字符串比对必然不相等 → 正文整段重建（滚动中
// 肉眼可见）。改为稳定占位 + data-started，挂载后由 updateRunClocks 定点刷新文本——与消息流
// typing 行同一通道（区别：那边随 #app 全量重建渲染、初值可以直接是 duration，这里必须稳定）。
function runClockSpan(run) {
  if (run.status === 'running' && run.started_at) {
    return `<span class="run-clock" data-started="${attr(run.started_at)}">…</span>`
  }
  return `<span>${esc(duration(run.started_at, run.ended_at))}</span>`
}

function modalTask(task) {
  if (!task) return modalLoading(t("任务"))
  const project = activeProject()
  const activeRun = (task.runs ?? []).find(run => ['queued', 'running'].includes(run.status))
  const latestFailed = (task.runs ?? []).find(run => ['failed', 'canceled'].includes(run.status))
  // 终态时间小字（DSHBOTS-44）：与任务卡同口径——done 取 completed_at、canceled 取 canceled_at，缺列不造占位。
  // 终态下 stageLabel 为 null（DSHBOTS-42 口径），badge 槽正好空出，用「完成于/取消于 + 时间」补位。
  const endAt = task.status === 'done' ? task.completed_at : task.status === 'canceled' ? task.canceled_at : null
  // 任务关系（DSHBOTS-58）：父任务取本项目任务表里的那条，依赖只列未满足项（blockedByNames）。
  const parentTask = (state.data?.tasks ?? []).find(item => item.id === (task.parent_task_id ?? task.parentTaskId ?? null)) ?? null
  const blockedNames = Array.isArray(task.blockedByNames) ? task.blockedByNames : []
  // 写范围（DSHBOTS-124）：并行调度依据——同项目内两侧都声明且路径互不重叠才并行，任一未声明按保守串行。
  // 数据源是 taskView.writeScopes（src/services/tasks.js），空数组 = 未声明。
  const writeScopes = Array.isArray(task.writeScopes) ? task.writeScopes.filter(item => typeof item === 'string' && item) : []
  // 写范围编辑态（DSHBOTS-155）：只读展示与编辑表单两态切换；编辑态挂在当前 modal 上，
  // 保存后由 reloadTaskModal 换掉 state.modal，编辑态随之复位，不进全局轮询状态。
  const editingScopes = state.modal?.type === 'task' && state.modal?.detail?.id === task.id && state.modal.editingScopes === true
  // 终态卡不进编辑态——与后端 taskUpdateScopes 的终态拒改（任务已结束）同口径。
  const scopesEditable = !['done', 'canceled'].includes(task.status)
  const scopesView = writeScopes.length
    ? `<div class="scope-chips">${writeScopes.map(scope => `<span class="approval-chip mono" title="${attr(scope)}">${esc(scope)}</span>`).join('')}</div>`
    : `<div class="scope-empty">${t("未声明（保守串行）")}</div>`
  const scopesEdit = `<div class="field">
            <label id="task-write-scopes-label" for="task-write-scopes">${t("写范围路径")}</label>
            <input class="input mono" style="width:100%" id="task-write-scopes" placeholder="${t("逗号或空格分隔路径")}" value="${attr(writeScopes.join(', '))}">
            <div class="btn-row" style="margin-top:7px"><button class="btn small primary" type="button" data-action="update-scopes" data-task-id="${attr(task.id)}">${icon('check')}${t("保存")}</button><button class="btn small" type="button" data-action="cancel-scopes-edit">${t("取消")}</button></div>
            <div class="hint" style="margin-top:6px">${t("保存后立即生效于排队中的运行；运行中的运行不受影响")}</div>
          </div>`
  return modalShell({
    title: `${task.identifier} · ${task.title}`,
    // 任务阶段徽标走 taskStage 查表口径（DSHBOTS-42）：ended → stageLabel 为 null → 不显示。
    badge: task.stageLabel ? esc(stageLabelText(task.stageLabel)) : endAt ? esc(`${task.status === 'done' ? t("完成于") : t("取消于")} ${formatTime(endAt)}`) : '',
    size: 'task',
    body: `<div class="task-detail-grid">
      <div class="task-detail-main">
        <form data-form="update-task" id="task-form">
          <input type="hidden" name="taskId" value="${attr(task.id)}">
          <input type="hidden" name="version" value="${task.version}">
          <div class="field"><label id="task-title-label" for="task-title">${t("标题")}</label><input class="input" style="width:100%" id="task-title" name="title" value="${attr(task.title)}" required maxlength="240"></div>
          <div class="field"><label id="task-description-label" for="task-description">${t("描述")}</label><textarea class="textarea" id="task-description" name="description" rows="9">${esc(task.description || '')}</textarea></div>
          <div class="field-row">
            <div class="field"><label id="task-status-label" for="task-status">${t("状态")}</label><select class="select" style="width:100%" id="task-status" name="status">${STATUS_ORDER.map(status => `<option value="${status}" ${task.status === status ? 'selected' : ''}>${STATUS[status]}</option>`).join('')}</select></div>
            <div class="field"><label id="task-priority-label" for="task-priority">${t("优先级")}</label><select class="select" style="width:100%" id="task-priority" name="priority">${Object.entries(PRIORITY).map(([key, label]) => `<option value="${key}" ${task.priority === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label id="task-assignee-label" for="task-assignee">${t("负责人")}</label><select class="select" style="width:100%" id="task-assignee" name="assigneeBotId"><option value="">${t("未指派")}</option>${project.members.map(member => `<option value="${attr(member.id)}" ${task.assignee_bot_id === member.id ? 'selected' : ''}>${esc(member.name)} · ${esc(member.bot_role || '')}</option>`).join('')}</select></div>
        </form>
        ${(parentTask || blockedNames.length) ? `<div class="note">${parentTask ? `${t("父任务：")}${esc(parentTask.identifier)} · ${esc(parentTask.title)}` : ''}${parentTask && blockedNames.length ? ' · ' : ''}${blockedNames.length ? `${t("被")} ${blockedNames.length} ${t("个任务阻塞：")}${esc(blockedNames.join(t("、")))}` : ''}</div>` : ''}
        <div class="scope-block">
          <div class="eyebrow" style="margin-bottom:6px">${t("写范围")}</div>
          ${editingScopes ? scopesEdit : `${scopesEditable ? `<div class="btn-row" style="margin-bottom:6px"><button class="btn small" type="button" data-action="edit-scopes" data-task-id="${attr(task.id)}">${icon('edit')}${t("编辑")}</button></div>` : ''}${scopesView}
          <div class="hint" style="margin-top:6px">${t("写范围是并行调度依据：同项目内路径互不重叠的任务才会并行。")}</div>`}
        </div>
        ${task.timeBudgetMinutes ? `<div class="scope-block">
          <div class="eyebrow" style="margin-bottom:6px">${t('taskForm.timeBudgetLabel')}</div>
          <div class="note" style="color:var(--ink)">${t('task.timeBudgetValue', { minutes: Number(task.timeBudgetMinutes) })}</div>
          <div class="hint" style="margin-top:6px">${t('task.timeBudgetNote')}</div>
        </div>` : ''}
        <div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:6px">${t("评论")}</div>
        ${(task.comments ?? []).length === 0 ? `<div class="note">${t("还没有评论。")}</div>` : task.comments.map(comment => `<div class="comment">
          ${avatar(comment.author_type === 'bot' ? (botById(comment.author_id) ?? { name: comment.authorName, color: 'gray' }) : { name: t("我"), color: 'teal' }, 'sm')}
          <div class="comment-main"><div class="comment-head"><strong>${esc(comment.authorName)}</strong><span>${esc(timeAgo(comment.created_at))}</span></div><div class="comment-body">${richText(comment.body, mdChatScope())}</div></div>
        </div>`).join('')}
        <form data-form="add-comment" style="margin-top:14px">
          <input type="hidden" name="taskId" value="${attr(task.id)}">
          <textarea class="textarea" id="task-comment-body" name="body" rows="3" aria-label="${t("评论内容")}" placeholder="${t("补充说明、验收意见或阻塞原因")}"></textarea>
          <div class="btn-row" style="margin-top:7px"><button class="btn small" type="submit">${icon('send')}${t("添加评论")}</button></div>
        </form>
      </div>
      <aside class="task-detail-side">
        ${taskUsageBlock(task.usage)}
        <div class="eyebrow">${t("运行记录")}</div>
        ${(activeRun || latestFailed) ? `<div class="btn-row" style="margin:9px 0 2px">${activeRun ? `<button class="btn danger small" type="button" data-action="cancel-run" data-run-id="${attr(activeRun.id)}">${icon('stop')}${t("停止运行")}</button>` : ''}${latestFailed ? `<button class="btn small" type="button" data-action="retry-run" data-run-id="${attr(latestFailed.id)}">${icon('refresh')}${t("重试")}</button>` : ''}</div>` : ''}
        <div style="margin-top:8px">${(task.runs ?? []).length === 0 ? `<div class="note">${t("还没有运行。")}</div>` : task.runs.map(run => `<div class="run-row">
          <div class="run-row-top">${runDot(run.status)}<strong>#${run.attempt}</strong><span>${esc(RUN_STATUS[run.status] ?? run.status)}</span><span style="margin-left:auto">${esc(timeAgo(run.queued_at))}</span></div>
          <div class="run-row-meta">${runClockSpan(run)}<span>${formatNumber(run.usage_input + run.usage_output)} tok</span>${run.usage_cost !== null && run.usage_cost !== undefined ? `<span>${formatCost(run.usage_cost)}</span>` : ''}${sandboxPill(run.sandboxMode)}</div>
          ${run.error_message ? `<div class="run-output error">${esc(run.error_message)}</div>` : ''}
          ${run.output ? `<details style="margin-top:6px"${panelAttrs(state, `run-output:${run.id}`)}><summary class="summary-link">${t("查看输出")}</summary><div class="run-output">${esc(run.output)}</div></details>` : ''}
          ${runArtifacts(state, run)}
        </div>`).join('')}</div>
        <div class="divider"></div>
        <div class="eyebrow" style="margin-bottom:7px">${t("详情")}</div>
        <div class="kv"><span>${t("编号")}</span><strong>${esc(task.identifier)}</strong></div>
        <div class="kv"><span>${t("负责人")}</span><strong>${esc(task.assignee_name || t("未指派"))}</strong></div>
        <div class="kv"><span>${t("创建者")}</span><strong>${esc(CREATOR_TYPE[task.creator_type] ?? task.creator_type)}</strong></div>
        <div class="kv"><span>${t("更新时间")}</span><strong>${esc(timeAgo(task.updated_at))}</strong></div>
        ${(task.dependencies ?? []).length ? `<div class="divider"></div><div class="eyebrow" style="margin-bottom:7px">${t("依赖")}</div>${task.dependencies.map(dep => `<div class="kv"><span>${esc(dep.title)}</span><strong>${esc(STATUS[dep.status] ?? dep.status)}</strong></div>`).join('')}` : ''}
      </aside>
    </div>`,
    footer: `<button class="btn" data-action="close-modal">${t("关闭")}</button>${['done', 'canceled'].includes(task.status) ? `<button class="btn danger" type="button" data-action="reject-task" data-task-id="${attr(task.id)}" title="${t('task.rejectTitle')}">${icon('reply')}${t('task.rejectAction')}</button>` : ''}<button class="btn" type="button" data-action="derive-subtask" data-task-id="${attr(task.id)}" title="${t("以本任务为父任务新建子任务")}">${icon('branch')}${t("派生子任务")}</button>${task.status === 'in_review' ? `<button class="btn" type="button" data-action="review-delegate" data-task-id="${attr(task.id)}" title="${t("委派总监 Bot 的子代理并行核验交付，结论写回任务评论，裁决仍由您执行")}">${icon('spark')}${t("子代理核验")}</button>` : ''}<button class="btn" type="button" data-action="run-task" data-task-id="${attr(task.id)}">${icon('play')}${t("保存并运行")}</button><button class="btn primary" type="submit" form="task-form">${icon('check')}${t("保存")}</button>`,
  })
}

function modalMemory(memory) {
  // 写作入口随上下文收敛（DSHBOTS-5）：群聊只写当前项目记忆，单聊只写该 bot 记忆，不再可选 Bot 列表。
  const project = pageProject()
  const soloBot = inSoloContext() ? botById(state.soloBotId) : null
  const scope = soloBot
    ? `bot:${attr(soloBot.id)}`
    : project ? `project:${attr(project.id)}` : ''
  const disabledText = soloBot ? `Bot · ${esc(soloBot.name)}` : t("项目记忆")
  return modalShell({
    title: memory ? t("编辑记忆") : t("写入记忆"),
    badge: '',
    body: `<form data-form="${memory ? 'update-memory' : 'create-memory'}" id="modal-form">
      <input type="hidden" name="memoryId" value="${attr(memory?.id ?? '')}">
      <div class="field"><label id="memory-scope-label" for="memory-scope">${t("作用域")}</label>${memory
        ? `<input class="input" style="width:100%" id="memory-scope" value="${esc(memory.scope_type === 'project' ? t("项目记忆") : `Bot · ${botById(memory.scope_id)?.name ?? ''}`)}" disabled>`
        : `<input class="input" style="width:100%" id="memory-scope" value="${esc(disabledText)}" disabled>${scope ? `<input type="hidden" name="scope" value="${attr(scope)}">` : ''}`}</div>
      <div class="field"><label id="memory-topic-label" for="memory-topic">${t("主题")}</label><input class="input" style="width:100%" id="memory-topic" name="topic" value="${attr(memory?.topic ?? '')}" maxlength="120" placeholder="${t("例如：发布流程约束")}" required></div>
      <div class="field"><label id="memory-content-label" for="memory-content">${t("内容")}</label><textarea class="textarea" id="memory-content" name="content" rows="9" required placeholder="${t("写清楚背景、结论和适用范围")}">${esc(memory?.content ?? '')}</textarea><div class="hint">${t("密钥、密码和 token 会被自动过滤为")} [REDACTED]${t("。")}</div></div>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">${t("取消")}</button><button class="btn primary" type="submit" form="modal-form">${memory ? `${icon('check')}${t("保存记忆")}` : `${icon('plus')}${t("写入记忆")}`}</button>`,
  })
}

function modalProposal(kind = 'bot_update') {
  // 单聊上下文发起的提案不挂任何项目（团队级提案）。
  const project = pageProject()
  return modalShell({
    title: t("新建进化提案"),
    subtitle: t("审批通过后才会生效。"),
    badge: '',
    size: 'wide',
    body: `<form data-form="create-proposal" id="modal-form">
      <input type="hidden" name="projectId" value="${attr(project?.id ?? '')}">
      <div class="field-row">
        <div class="field"><label id="proposal-kind-label" for="proposal-kind">${t("提案类型")}</label><select class="select" style="width:100%" id="proposal-kind" name="kind" data-proposal-kind><option value="bot_update" ${kind === 'bot_update' ? 'selected' : ''}>Bot ${t("指令更新")}</option><option value="skill" ${kind === 'skill' ? 'selected' : ''}>${t("共享技能")}</option></select></div>
        <div class="field" data-field="bot"><label id="proposal-bot-label" for="proposal-bot">${t("目标")} Bot</label><select class="select" style="width:100%" id="proposal-bot" name="botId">${activeBots().map(bot => `<option value="${attr(bot.id)}">${esc(bot.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label id="proposal-title-label" for="proposal-title">${t("标题")}</label><input class="input" style="width:100%" id="proposal-title" name="title" required maxlength="200" placeholder="${t("一句话说明变更")}"></div>
      <div class="field"><label id="proposal-rationale-label" for="proposal-rationale">${t("变更理由")}</label><textarea class="textarea" id="proposal-rationale" name="rationale" rows="4" required placeholder="${t("为什么需要变更，来自哪些失败或重复模式")}"></textarea></div>
      <div data-section="bot"><div class="field"><label id="proposal-instructions-label" for="proposal-instructions">${t("新的角色指令")}</label><textarea class="textarea" id="proposal-instructions" name="instructions" rows="9" placeholder="${t("完整替换现有指令，而不是追加")}"></textarea></div></div>
      <div data-section="skill" style="display:none">
        <div class="field-row"><div class="field"><label id="proposal-slug-label" for="proposal-slug">${t("技能标识")}</label><input class="input mono" style="width:100%" id="proposal-slug" name="slug" placeholder="${t("发布检查")}"></div><div class="field"><label id="proposal-version-label" for="proposal-version">${t("版本")}</label><input class="input" style="width:100%" id="proposal-version" name="version" value="1.0.0"></div></div>
        <div class="field-row"><div class="field"><label id="proposal-name-label" for="proposal-name">${t("显示名称")}</label><input class="input" style="width:100%" id="proposal-name" name="name"></div><div class="field"><label id="proposal-description-label" for="proposal-description">${t("描述")}</label><input class="input" style="width:100%" id="proposal-description" name="description"></div></div>
        <div class="field"><label id="proposal-content-label" for="proposal-content">${t("技能内容（Markdown）")}</label><textarea class="textarea" id="proposal-content" name="content" rows="10" placeholder="## When to use&#10;..."></textarea></div>
      </div>
      <div class="field"><label id="proposal-evaluation-label" for="proposal-evaluation">${t("评估方式")}</label><textarea class="textarea" id="proposal-evaluation" name="evaluation" rows="3" placeholder="${t("审批前如何验证：回归任务、失败案例、人工检查点")}"></textarea></div>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">${t("取消")}</button><button class="btn primary" type="submit" form="modal-form">${icon('branch')}${t("提交提案")}</button>`,
  })
}

function priceDefaults() {
  return state.data?.priceDefaults ?? []
}

function defaultPriceFor(model) {
  const key = String(model ?? '').toLowerCase()
  return priceDefaults().find(item => item.model.toLowerCase() === key)
}

function modalPrice(seed: TeamActionPayload = {}) {
  const editing = Boolean(seed.model)
  const catalogModels = (state.data?.models ?? []).map(item => item.model)
  const knownModels = [...new Set([...catalogModels, ...priceDefaults().map(item => item.model)])]
  const providers = [...new Set((state.data?.models ?? []).map(item => item.provider))]
  const fallback = defaultPriceFor(seed.model)
  const hint = fallback
    ? t('price.hintDefault', { cacheRead: fallback.cacheReadPerMtok, input: fallback.inputPerMtok, output: fallback.outputPerMtok, currency: fallback.currency })
    : t('price.hintCustom')
  const overridden = Boolean(editing && fallback) && (
    Number(seed.cache_read_per_mtok) !== Number(fallback.cacheReadPerMtok)
    || Number(seed.input_per_mtok) !== Number(fallback.inputPerMtok)
    || Number(seed.output_per_mtok) !== Number(fallback.outputPerMtok)
    || String(seed.currency ?? fallback.currency).toUpperCase() !== String(fallback.currency).toUpperCase()
  )
  return modalShell({
    title: editing ? t('price.modalEdit', { model: seed.model }) : t('price.modalAdd'),
    subtitle: t('price.modalSubtitle'),
    badge: '',
    body: `<form data-form="save-price" id="modal-form">
      <div class="field-row"><div class="field"><label id="price-provider-label" for="price-provider">${t('price.providerLabel')}</label><input class="input mono" style="width:100%" id="price-provider" name="provider" list="price-providers" value="${attr(seed.provider ?? '')}" placeholder="${t('price.providerPlaceholder')}"></div><div class="field"><label id="price-model-label" for="price-model">${t('price.modelLabel')}</label><input class="input mono" style="width:100%" id="price-model" name="model" list="price-models" value="${attr(seed.model ?? '')}" placeholder="deepseek-flash" required autofocus></div></div>
      <div class="field-row"><div class="field"><label id="price-input-label" for="price-input">${t('price.inputLabel')}</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-input" name="inputPerMtok" required value="${attr(seed.input_per_mtok ?? fallback?.inputPerMtok ?? '')}" placeholder="2"></div><div class="field"><label id="price-output-label" for="price-output">${t('price.outputLabel')}</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-output" name="outputPerMtok" required value="${attr(seed.output_per_mtok ?? fallback?.outputPerMtok ?? '')}" placeholder="8"></div></div>
      <div class="field-row"><div class="field"><label id="price-cache-read-label" for="price-cache-read">${t('price.cacheReadLabel')}</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-cache-read" name="cacheReadPerMtok" value="${attr(seed.cache_read_per_mtok ?? fallback?.cacheReadPerMtok ?? '')}" placeholder="0.2"></div><div class="field"><label id="price-cache-write-label" for="price-cache-write">${t('price.cacheWriteLabel')}</label><input class="input" style="width:100%" type="number" min="0" step="0.0001" id="price-cache-write" name="cacheWritePerMtok" value="${attr(seed.cache_write_per_mtok ?? fallback?.cacheWritePerMtok ?? '')}" placeholder="0"></div></div>
      <div class="field"><label id="price-currency-label" for="price-currency">${t('price.currencyLabel')}</label><input class="input mono" style="width:100%" id="price-currency" name="currency" value="${attr(seed.currency ?? fallback?.currency ?? 'CNY')}" placeholder="CNY"></div>
      <div class="hint">${esc(hint)}</div>
      ${overridden ? `<div class="btn-row"><button class="btn danger" type="button" data-action="reset-price" data-model="${attr(seed.model)}" data-provider="${attr(seed.provider ?? '')}">${t('price.reset')}</button></div>` : ''}
      <datalist id="price-models">${knownModels.map(model => `<option value="${attr(model)}"></option>`).join('')}</datalist>
      <datalist id="price-providers">${providers.map(provider => `<option value="${attr(provider)}"></option>`).join('')}</datalist>
    </form>`,
    footer: `<button class="btn" data-action="close-modal">${t('price.cancel')}</button><button class="btn primary" type="submit" form="modal-form">${icon('check')}${t('price.save')}</button>`,
  })
}

function renderPriceCard() {
  const prices = state.data?.prices ?? []
  const defaults = priceDefaults()
  const missing = defaults.filter(item => !prices.some(price => price.model.toLowerCase() === item.model.toLowerCase()))
  const rows = prices.map(price => {
    const fallback = defaultPriceFor(price.model)
    const builtin = Boolean(fallback)
      && Number(price.cache_read_per_mtok) === Number(fallback.cacheReadPerMtok)
      && Number(price.cache_write_per_mtok) === Number(fallback.cacheWritePerMtok)
      && Number(price.input_per_mtok) === Number(fallback.inputPerMtok)
      && Number(price.output_per_mtok) === Number(fallback.outputPerMtok)
    const provider = price.provider ? price.provider : t('price.anyProvider')
    return `<tr>
      <td class="price-model">${esc(price.model)}<span class="pill ${builtin ? 'green' : 'violet'}">${builtin ? t('price.builtin') : t('price.custom')}</span></td>
      <td class="num mono">${esc(price.cache_read_per_mtok)}</td>
      <td class="num mono">${esc(price.input_per_mtok)}</td>
      <td class="num mono">${esc(price.output_per_mtok)}</td>
      <td>${esc(price.currency)}</td>
      <td>${esc(provider)}</td>
      <td class="num"><button class="btn small" data-action="edit-price" data-model="${attr(price.model)}" data-provider="${attr(price.provider)}">${icon('edit')}${t('price.edit')}</button></td>
    </tr>`
  }).join('')
  const body = prices.length
    ? `<table class="usage-table price-table">
        <thead><tr>
          <th class="eyebrow mono">${t('模型')}</th>
          <th class="eyebrow mono num">${t('price.colCacheRead')}</th>
          <th class="eyebrow mono num">${t('price.colInput')}</th>
          <th class="eyebrow mono num">${t('price.colOutput')}</th>
          <th class="eyebrow mono">${t('price.colCurrency')}</th>
          <th class="eyebrow mono">${t('price.colProvider')}</th>
          <th class="eyebrow mono num"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<div class="empty-state"><div class="empty-symbol">${icon('chart')}</div><h3>${t('price.emptyTitle')}</h3><p>${t('price.emptyDesc')}</p></div>`
  return `<div class="card price-card">
    <div class="card-head">
      <h3>${t('price.title')}</h3>
      <div class="btn-row">
        <span class="meta">${t('price.rulesCount', { count: prices.length })}</span>
        <button class="btn" data-action="new-price">${icon('plus')}${t('price.add')}</button>
      </div>
    </div>
    ${body}
    <div class="usage-note">${t('price.note')}${missing.length ? t('price.noteMissing', { models: missing.map(item => esc(item.model)).join(t('price.modelSeparator')) }) : ''}</div>
  </div>`
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
let lastFocused = null

function focusableItems(root) {
  if (!root) return []
  return Array.from(root.querySelectorAll(FOCUSABLE) as NodeListOf<HTMLElement>)
    .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement)
}

function focusModal() {
  const modal = document.querySelector('.modal') as HTMLElement | null
  if (!modal) return
  const body = modal.querySelector('.modal-body')
  const preferred = body?.querySelector('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])') as HTMLElement | null
  const items = focusableItems(modal)
  ;(preferred ?? items[0] ?? modal).focus()
}

function restoreFocus() {
  const target = lastFocused && document.contains(lastFocused) ? lastFocused : document.getElementById('main-content')
  lastFocused = null
  if (target) target.focus()
}

function trapModalFocus(event) {
  const modal = document.querySelector('.modal') as HTMLElement | null
  if (!modal) return false
  const items = focusableItems(modal)
  if (items.length === 0) {
    event.preventDefault()
    modal.focus()
    return true
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (event.shiftKey && (active === first || !modal.contains(active))) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && (active === last || !modal.contains(active))) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}

// modal 开合只同步 #modal-root，不走 render() 全量重建（DSHBOTS-90）：
// 开弹窗不再重建背后整页，关弹窗不再拆掉重排后的列表——滚动位与列表状态原样保留。
function openModal(modal) {
  state.modal = modal
  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  renderModalLayer()
  focusModal()
}

function closeModal() {
  if (!state.modal) return
  state.modal = null
  renderModalLayer()
  restoreFocus()
}

async function openTask(taskId) {
  openModal({ type: 'task', loading: true, title: t("任务详情") })
  try {
    const detail = await api('task_detail', { taskId })
    if (state.modal?.type !== 'task') return
    state.modal = { type: 'task', detail }
    renderModalLayer()
  } catch {
    closeModal()
  }
}

async function openSkillDetail(slug) {
  openModal({ type: 'skill-detail', loading: true, title: t("技能详情") })
  try {
    const detail = await api('skill_detail', { slug })
    if (state.modal?.type !== 'skill-detail') return
    state.modal = { type: 'skill-detail', detail }
    renderModalLayer()
  } catch {
    closeModal()
  }
}

async function openTrajectory(runId) {
  openModal({ type: 'trajectory', loading: true, title: t("思考过程") })
  try {
    const detail = await api('run_trajectory', { runId }, { quiet: true })
    if (state.modal?.type !== 'trajectory') return
    state.modal = { type: 'trajectory', detail, runId }
    renderModalLayer()
  } catch (error: any) {
    closeModal()
    toast(error?.message || t("读取思考过程失败"), 'error')
  }
}

async function openBot(botId) {
  openModal({ type: 'edit-bot', loading: true, title: t("Bot 配置") })
  try {
    const detail = await api('bot_detail', { botId })
    if (state.modal?.type !== 'edit-bot') return
    state.modal = { type: 'edit-bot', detail }
    renderModalLayer()
  } catch {
    closeModal()
  }
}

async function reloadTaskModal(taskId) {
  const detail = await api('task_detail', { taskId }, { quiet: true })
  if (state.modal?.type === 'task') {
    state.modal = { type: 'task', detail }
    renderModalLayer()
  }
}

function bindProposalForm() {
  const kind = document.querySelector('[data-proposal-kind]') as HTMLInputElement | null
  if (!kind) return
  const apply = () => {
    const value = kind.value
    document.querySelectorAll<HTMLElement>('[data-section]').forEach(section => {
      section.style.display = section.dataset.section === value ? '' : 'none'
    })
    const botField = document.querySelector('[data-field="bot"]') as HTMLElement | null
    if (botField) botField.style.display = value === 'bot_update' ? '' : 'none'
  }
  kind.addEventListener('change', apply)
  apply()
}

function updateEffortOptions(select) {
  const form = select.closest('form')
  const effort = form?.querySelector('[data-effort-select]')
  if (!effort) return
  effort.innerHTML = effortOptions(select.value, '')
}

// 备用模型的推理强度跟随备用模型变化，选项来源与主模型同一张表。
function updateFallbackEffortOptions(select) {
  const form = select.closest('form')
  const effort = form?.querySelector('[data-fallback-effort-select]')
  if (!effort) return
  effort.innerHTML = effortOptions(select.value, '')
}

export { modalNewProject, modalRemoveTracking, modalRemoveBotTracking, modalBot, modalInviteMember, modalNewTask, modalTask, modalSkill, modalMemory, modalProposal, modalPrice, modalTrajectory, openModal, closeModal, openTask, openSkillDetail, openTrajectory, openBot, reloadTaskModal, bindProposalForm, updateEffortOptions, updateFallbackEffortOptions, trapModalFocus, renderDirPicker, closeDirPicker, parseFallbackFields, normalizeTimeBudgetMinutes, modelOptions, effortOptions, fallbackModelOptions, renderPriceCard }
