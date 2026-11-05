// tasks.js —— 任务面板（排序 / 分组 / 卡片 / 行）、终端面板，以及 bots / members / skills / memory / evolution 各视图。
import { state, STATUS, STATUS_ORDER, PRIORITY, PROPOSAL_STATUS, BOT_STATUS, SKILL_STATUS, MEMORY_STATUS, PROPOSAL_KIND, TERMINAL_STATUS, EFFORT, NAV } from './state.js'
import { icon } from './icons.js'
import { activeProject, actorLabel, attr, avatar, botById, duration, esc, formatCost, formatNumber, formatTime, inSoloContext, memberRunDot, memorySource, pageProject, runDot, tildePath, timeAgo } from './util.js'
import { api } from './api.js'
import { t } from './i18n.js'
import { refresh, startTerminalPoll, panelAttrs, render, noProject } from '../app.js'

// task-sort:start —— 任务面板排序的纯逻辑（tests/task-sort.test.js 按本标记块抽取断言）。
// 权重表把优先级文案映射成「越小越靠前」：紧急(0) → 高(1) → 中(2) → 低(3) → 无(4)。
// 未知或缺失的优先级按 medium（中）处理，旧数据没有 priority 时同样落在中档。
const TASK_PRIORITY_WEIGHT = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
const TASK_PRIORITY_DEFAULT = 'medium'
// 归一化优先级取值：表内值原样返回（大小写不敏感），表外值与缺失一律落到默认档 medium。
function taskPriorityKey(priority) {
  const key = String(priority ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(TASK_PRIORITY_WEIGHT, key) ? key : TASK_PRIORITY_DEFAULT
}
function taskPriorityWeight(priority) {
  return TASK_PRIORITY_WEIGHT[taskPriorityKey(priority)]
}
// 同优先级按 position（看板列内手动顺序）回退，再按 number（任务编号）回退，保证结果稳定。
function compareTasksByPriority(a, b) {
  const byPriority = taskPriorityWeight(a?.priority) - taskPriorityWeight(b?.priority)
  if (byPriority !== 0) return byPriority
  const byPosition = (Number(a?.position) || 0) - (Number(b?.position) || 0)
  if (byPosition !== 0) return byPosition
  return (Number(a?.number) || 0) - (Number(b?.number) || 0)
}
function sortTasksByPriority(tasks) {
  return [...(tasks ?? [])].sort(compareTasksByPriority)
}
// 组内排序口径（D-63）：排序只发生在状态分组的组内兄弟层，不改分组、不动父子挂载——
// 应用点在 renderTaskRows 建树前，父子挂载按 parent_task_id 组装，顺序变化不会拆散树。
// 完成时间排序只有终态任务参与（done→completed_at、canceled→canceled_at，复用 taskTerminalTime）；
// 非终态与缺时间戳的终态没有时间基准，两个方向都排在末尾，不穿插、不当 0 排最前。
const TASK_SORTS = [
  { value: 'created_desc', label: '创建时间 新→旧' },
  { value: 'created_asc', label: '创建时间 旧→新' },
  { value: 'completed_desc', label: '完成时间 新→旧' },
  { value: 'completed_asc', label: '完成时间 旧→新' },
  { value: 'priority_desc', label: '优先级 高→低' },
  { value: 'priority_asc', label: '优先级 低→高' },
]
function sortTasksForPanel(tasks, mode = state.taskSort) {
  const list = [...(tasks ?? [])]
  const created = task => new Date(task?.created_at ?? 0).getTime() || 0
  const number = task => Number(task?.number) || 0
  if (mode === 'created_asc') return list.sort((a, b) => created(a) - created(b) || number(a) - number(b))
  if (mode === 'created_desc') return list.sort((a, b) => created(b) - created(a) || number(b) - number(a))
  if (mode === 'completed_desc' || mode === 'completed_asc') {
    const dir = mode === 'completed_desc' ? -1 : 1
    const timed = list.filter(task => taskTerminalTime(task))
    const untimed = list.filter(task => !taskTerminalTime(task))
    timed.sort((a, b) => (new Date(taskTerminalTime(a)).getTime() - new Date(taskTerminalTime(b)).getTime()) * dir || (number(a) - number(b)) * dir)
    return [...timed, ...untimed]
  }
  if (mode === 'priority_desc') return sortTasksByPriority(list)
  if (mode === 'priority_asc') return sortTasksByPriority(list).reverse()
  return list
}
// task-sort:end

// task-time-range:start —— 终态时间筛选（DSHBOTS-44）：只作用于终态任务（done/canceled），
// 按各自终态时间戳（completed_at / canceled_at）与窗口下限比较；非终态任务不受影响照常显示。
// 终态但缺时间戳（极老数据）在窗口模式下视为窗口外——无法证明在窗口内就不默认放行。
// 窗口口径：「今天」按自然日当天 00:00 起（非 24 小时滚动窗），其余为自当前时刻回溯的滚动窗口。
const TASK_TIME_RANGES = { '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: 0 }
function taskEndsOutsideRange(task, timeRange) {
  if (timeRange === 'all') return false
  if (task.status !== 'done' && task.status !== 'canceled') return false
  const field = task.status === 'done' ? 'completed_at' : 'canceled_at'
  const endedAt = task[field] ? new Date(task[field]).getTime() : NaN
  const cutoff = timeRange === '1d' ? new Date().setHours(0, 0, 0, 0) : Date.now() - (TASK_TIME_RANGES[timeRange] ?? 0)
  return !(Number.isFinite(endedAt) && endedAt >= cutoff)
}
// 终态时间戳取值口径（DSHBOTS-62）：done → completed_at，canceled → canceled_at；非终态没有终态时间。
// 缺终态时间戳的终态任务没有可比的时间基准（老数据，或直接以终态状态建的任务），
// 这类任务不参与时间筛选、始终可见——按窗口外处理会把整个「已完成」分组静默清空
// （库里 1 条 done、面板 0 条的成因）。筛选入口用 taskTerminalTime 做这道门。
function taskTerminalTime(task) {
  if (!task) return null
  if (task.status === 'done') return task.completed_at ?? null
  if (task.status === 'canceled') return task.canceled_at ?? null
  return null
}
// task-time-range:end

function filteredTasks() {
  const filter = state.taskFilter
  return sortTasksByPriority((state.data?.tasks ?? []).filter(task => {
    if (filter.status !== 'all' && task.status !== filter.status) return false
    if (filter.assignee !== 'all' && task.assignee_bot_id !== filter.assignee) return false
    // 时间筛选只对「有终态时间戳」的终态任务生效（DSHBOTS-62）：缺时间戳的终态任务没有时间基准，
    // 参与筛选会被整组清空（库里 done、面板「已完成」0 条的成因）；其余状态照常显示（D-34 口径）。
    if (taskTerminalTime(task) && taskEndsOutsideRange(task, filter.timeRange)) return false
    if (filter.search) {
      const haystack = `${task.identifier} ${task.title} ${task.description} ${task.labels?.join(' ') ?? ''}`.toLowerCase()
      if (!haystack.includes(filter.search.toLowerCase())) return false
    }
    return true
  }))
}

function renderTasks() {
  const project = activeProject()
  if (!project) return noProject()
  const tasks = filteredTasks()
  const members = project.members ?? []
  const filtering = Boolean(state.taskFilter.search) || state.taskFilter.status !== 'all' || state.taskFilter.assignee !== 'all' || state.taskFilter.timeRange !== 'all'
  // 头部计数口径（DSHBOTS-62）：与各分组计数同源，取「各组计数之和」——
  // 头部数字必须等于面板上真正看到的行数之和，不能各算各的（口径不一致就会出现头部与分组对不上）。
  // 与项目总数（设置页「任务总数」同源）的差额单独提示，不混进主计数。
  const groupCounts = STATUS_ORDER.map(status => tasks.filter(task => task.status === status).length)
  const shownCount = groupCounts.reduce((sum, count) => sum + count, 0)
  const totalCount = Number(project.stats?.tasks ?? state.data?.tasks?.length ?? shownCount)
  const hiddenCount = Math.max(0, totalCount - shownCount)
  return `
    <div class="section-head">
      <p>拖拽任务行切换状态，点组头可折叠分组。</p>
      <div class="board-toolbar" style="margin:0">
        <input class="input search" id="task-search" placeholder="搜索任务、编号或标签" aria-label="搜索任务、编号或标签" value="${attr(state.taskFilter.search)}">
        <select class="select" data-task-filter="status">
          <option value="all">全部状态</option>
          ${STATUS_ORDER.map(status => `<option value="${status}" ${state.taskFilter.status === status ? 'selected' : ''}>${STATUS[status]}</option>`).join('')}
        </select>
        <select class="select" data-task-filter="assignee">
          <option value="all">全部成员</option>
          ${members.map(member => `<option value="${attr(member.id)}" ${state.taskFilter.assignee === member.id ? 'selected' : ''}>${esc(member.name)}</option>`).join('')}
        </select>
        <select class="select" data-task-filter="timeRange" aria-label="按终态时间筛选">
          <option value="1d" ${state.taskFilter.timeRange === '1d' ? 'selected' : ''}>今天</option>
          <option value="7d" ${state.taskFilter.timeRange === '7d' ? 'selected' : ''}>近 7 天</option>
          <option value="30d" ${state.taskFilter.timeRange === '30d' ? 'selected' : ''}>近 30 天</option>
          <option value="all" ${state.taskFilter.timeRange === 'all' ? 'selected' : ''}>全部时间</option>
        </select>
        <select class="select" data-task-sort aria-label="任务排序" title="组内排序：不影响分组与父子层级">
          ${TASK_SORTS.map(sort => `<option value="${sort.value}" ${state.taskSort === sort.value ? 'selected' : ''}>${sort.label}</option>`).join('')}
        </select>
        <span class="tag">${shownCount} 个任务</span>
        ${hiddenCount > 0 ? `<span class="faint" title="项目共 ${totalCount} 个任务；当前筛选、时间窗或列表上限隐藏了 ${hiddenCount} 个">项目共 ${totalCount} 个 · 隐藏 ${hiddenCount} 个</span>` : ''}
      </div>
    </div>
    ${tasks.length === 0 ? `<div class="empty-state">
      <div class="empty-symbol">${icon('board')}</div>
      <h3>${filtering ? '没有匹配的任务' : '任务面板还是空的'}</h3>
      <button class="btn" data-action="new-task">${icon('plus')}新建任务</button>
    </div>` : `<div class="board board-list">
      ${STATUS_ORDER.map(status => renderTaskGroup(status, tasks.filter(task => task.status === status))).join('')}
    </div>`}
  `
}

// 任务分组（DSHBOTS-58，参照 Linear）：按状态分组的树形分组列表，组头可折叠。
// 展开态记在 state.openPanels（key: task-group:<status>），组体容器带同一个 data-panel key —— 与 <details data-panel> 同一套通道。
// 组 section 仍然带 data-drop-status：拖拽换状态的通道不变，拖到组头/组体即改状态（DSHBOTS-54 看板联动靠它）。
function taskGroupKey(status) {
  return `task-group:${status}`
}

function renderTaskGroup(status, tasks) {
  const key = taskGroupKey(status)
  const expanded = state.openPanels.has(key)
  // 空组不渲染组体（DSHBOTS-62 P1-4）：只留一行组头，去掉「拖到这里」占位留下的大块竖向空白；
  // 组 section 仍带 data-drop-status，拖到组头照样能改状态，拖放通道不变。
  const body = tasks.length === 0 ? '' : renderTaskRows(tasks)
  return `<section class="column task-group${expanded ? '' : ' collapsed'}" data-drop-status="${status}">
    <div class="column-head task-group-head">
      <button type="button" class="task-group-toggle" data-action="toggle-task-group" data-status="${attr(status)}" aria-expanded="${expanded ? 'true' : 'false'}" title="${expanded ? '折叠' : '展开'}${esc(STATUS[status])}分组">${icon('chevron', `chev${expanded ? ' open' : ''}`)}</button>
      <span class="column-dot ${status}"></span>
      <strong>${STATUS[status]}</strong>
      <span class="column-count">${tasks.length}</span>
    </div>
    ${expanded && body ? `<div class="task-group-body" data-panel="${attr(key)}">${body}</div>` : ''}
  </section>`
}

// Linear 式状态图标：小圆环（待办/进行中/受阻/待验收），已完成是环内对勾，已取消是环内横杠。
// 颜色沿用现有状态色 token（与分组头圆点同色表），形状靠 CSS 画，无需额外图标资源。
function taskStatusIcon(task) {
  const status = task?.status ?? 'todo'
  const label = STATUS[status] ?? status
  return `<span class="task-status-icon ${attr(status)}" title="${attr(label)}" aria-label="${attr(label)}">${status === 'done' ? icon('check') : ''}</span>`
}

// 优先级图标：三档横条 + title 说明（紧急/高/中/低/无），配色沿用现有优先级色（danger/star/accent/ink-3）。
function taskPriorityIcon(task) {
  const key = taskPriorityKey(task?.priority)
  const label = PRIORITY[key] ?? key
  return `<span class="task-priority ${key}" title="优先级：${esc(label)}" aria-label="优先级：${esc(label)}">${icon('priority')}</span>`
}

// task-card:start —— 任务行（DSHBOTS-58，参照 Linear）：紧凑单行 —— 状态图标 + 优先级图标 + 编号 + 标题 + 右簇（标签/依赖/运行态/终态时间/头像）。
// 运行徽标文案来自后端 taskStage 纯函数查表的 stageLabel，不再从 latestRun.status 拼映射。
// 终态（done/canceled → stage 'ended'）一律不渲染任何运行徽标：状态点、运行文案、计时与 running 高亮全部隐藏，
// 已完成/已取消任务上挂着的遗留运行不再误导看板。
// 验收滞留 badge（DSHBOTS-194）：in_review 卡静置超阈值亮「滞留 Xm」，≥2×阈值转红。
// 阈值与后端守门同源（runLimits.reviewIdleMinutes，0=关闭）；锚点取 updated_at 与最近
// run 活动时间的较大者（卡片 payload 不含评论时间戳，权威判定以后端系统提醒为准）；
// 时长内嵌 run-clock 每秒自刷新，着色复用主题 pill 类不写死色值。
function reviewIdleBadge(task) {
  const minutes = Number(state.data?.runLimits?.reviewIdleMinutes ?? 30)
  if (!minutes || task.status !== 'in_review') return ''
  const anchors = [task.updated_at, task.latestRun?.ended_at, task.latestRun?.started_at]
    .filter(Boolean).map(stamp => new Date(stamp).getTime()).filter(ms => Number.isFinite(ms))
  if (!anchors.length) return ''
  const idleMs = Date.now() - Math.max(...anchors)
  if (idleMs < minutes * 60_000) return ''
  const tier = idleMs >= minutes * 120_000 ? 'red' : 'amber'
  const iso = new Date(Math.max(...anchors)).toISOString()
  return `<span class="pill ${tier}" title="验收静置已超 ${minutes} 分钟，请尽快收口">滞留&nbsp;<span class="run-clock" data-started="${attr(iso)}">${duration(iso)}</span></span>`
}
function renderTaskCard(task, options                  = {}) {
  const depth = Number(options.depth ?? 0)
  const childCount = Number(options.childCount ?? 0)
  const expanded = options.expanded === true
  const bot = botById(task.assignee_bot_id)
  const run = task.latestRun
  const stage = task.stage ?? { stage: 'idle' }
  const ended = stage.stage === 'ended'
  const runLabel = ended ? '' : task.stageLabel ?? ''
  const tags = []
  if (task.status === 'in_review') {
    tags.push(task.review_target === 'owner_bot' ? '总监验收中' : '待您验收')
    // 核验可见性（DSHBOTS-113）：自动/手动核验的状态标记——未核验/失败亮出，防止静默漏审。
    if (task.reviewStatus === 'pending') tags.push('核验中')
    else if (task.reviewStatus !== 'done') tags.push('未核验')
  }
  for (const label of task.labels ?? []) tags.push(label)
  const isRunning = stage.stage === 'working' && !stage.action
  // 终态时间小字（DSHBOTS-44）：done 取 completed_at、canceled 取 canceled_at，缺列或非终态不显示。
  const endAt = task.status === 'done' ? task.completed_at : task.status === 'canceled' ? task.canceled_at : null
  // 依赖徽标（DSHBOTS-58）：depsSatisfied=false 即被未完成的任务挡住；blockedByNames 只列未满足项。
  const blockedNames = Array.isArray(task.blockedByNames) ? task.blockedByNames : []
  const depsBlocked = task.depsSatisfied === false && blockedNames.length > 0
  const depsTitle = `被 ${blockedNames.length} 个任务阻塞：${blockedNames.join('、')}`
  return `<article class="task-card${isRunning ? ' running' : ''}${depth > 0 ? ' task-child' : ''}" draggable="true" data-task-id="${attr(task.id)}" data-action="open-task">
    ${taskStatusIcon(task)}
    ${taskPriorityIcon(task)}
    <div class="task-card-top">
      ${childCount > 0 ? `<button type="button" class="task-children-toggle" data-action="toggle-task-children" data-task-id="${attr(task.id)}" aria-expanded="${expanded ? 'true' : 'false'}" title="${expanded ? '折叠' : '展开'}${childCount} 个子任务">${icon('chevron', `chev${expanded ? ' open' : ''}`)}</button>` : ''}
      <span class="task-id">${esc(task.identifier)}</span>
    </div>
    <div class="task-card-title" title="${attr(task.title)}">${esc(task.title)}</div>
    <div class="task-card-foot">
      ${tags.length ? `<span class="task-tags">${tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}</span>` : ''}
      ${reviewIdleBadge(task)}
      ${depsBlocked ? `<span class="task-deps-badge" title="${attr(depsTitle)}">${icon('alert')}被 ${blockedNames.length} 个任务阻塞</span>` : ''}
      ${!ended && run ? runDot(run.status) : ''}
      <span class="task-run-label${stage.stage === 'person' ? ' task-stage-person' : ''}">${runLabel}</span>
      ${isRunning ? `<span class="run-clock" data-started="${attr(run.started_at ?? '')}">${duration(run.started_at)}</span>` : ''}
      ${endAt ? `<span class="task-end-time" title="${attr(endAt)}">${icon('check')} ${formatTime(endAt)}</span>` : ''}
      ${['done', 'canceled'].includes(task.status) ? `<button type="button" class="task-reject" data-action="reject-task" data-task-id="${attr(task.id)}" title="${t('task.rejectTitle')}">${icon('reply')}${t('task.rejectAction')}</button>` : ''}
      ${bot ? avatar(bot, 'sm') : '<span class="faint">未指派</span>'}
    </div>
  </article>`
}
// task-card:end

// 任务父子层级（DSHBOTS-58 第二笔，依赖后端 D-59 落库的 parent_task_id）：
// 分组内按 parent_task_id 组树——子任务挂到父行下方、容器左缩进一级，父行可折叠子行；
// 展开态记在 state.openPanels，key 形如 task-children:<taskId>（与 <details data-panel> 同一套 key 口径）。
// 只有父任务也在本组可见时才挂成子级：父被搜索/筛选掉、或父在别的状态分组时，
// 子任务回到本组顶层，避免任务因为层级关系在看板上凭空消失。
function taskChildrenKey(taskId) {
  return `task-children:${taskId}`
}

function taskParentId(task) {
  return task?.parent_task_id ?? task?.parentTaskId ?? null
}

function renderTaskRows(tasks) {
  // D-63：进组后先按当前排序档重排兄弟顺序，再组树——排序只影响同层先后，
  // 父子挂载按 parent_task_id 判定，不因顺序变化拆树（分组结构在 renderTaskGroup 上游，不在本函数）。
  const sorted = sortTasksForPanel(tasks)
  const visible = new Set(sorted.map(task => task.id))
  const childrenOf = new Map()
  const roots = []
  for (const task of sorted) {
    const parentId = taskParentId(task)
    if (parentId && visible.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, [])
      childrenOf.get(parentId).push(task)
    } else {
      roots.push(task)
    }
  }
  const renderSubtree = (task, depth) => {
    const children = childrenOf.get(task.id) ?? []
    const key = taskChildrenKey(task.id)
    const expanded = children.length > 0 && state.openPanels.has(key)
    const row = renderTaskCard(task, { depth, childCount: children.length, expanded })
    if (!children.length || !expanded) return row
    return `${row}<div class="task-children" data-panel="${attr(key)}">${children.map(child => renderSubtree(child, depth + 1)).join('')}</div>`
  }
  return roots.map(task => renderSubtree(task, 0)).join('')
}

// ── 项目「终端」tab：非交互式命令台（无 PTY/xterm），输入命令 → 项目工作目录执行 → 实时输出 ──
// 实时 tail 由 1s 轮询直更输出区（startTerminalPoll），常规状态走 2.8s poll 的 view.terminal。
function terminalStatusPill(status) {
  const tone = status === 'succeeded' ? 'green' : ['failed', 'timeout', 'interrupted'].includes(status) ? 'red' : status === 'running' ? 'amber' : ''
  return `<span class="pill ${tone}">${esc(TERMINAL_STATUS[status] ?? status)}</span>`
}

function terminalOutputText(terminal) {
  return terminal?.active?.output ?? terminal?.history?.[0]?.output ?? ''
}

function renderTerminal() {
  const project = activeProject()
  if (!project || inSoloContext()) return noProject()
  const terminal = state.data?.terminal ?? { active: null, history: [] }
  const active = terminal.active
  const latest = active ?? terminal.history[0] ?? null
  const output = terminalOutputText(terminal)
  // 有任务类运行在写该项目工作区时只提示不拦截：终端命令与它并发执行的风险由用户自担。
  const taskBusy = (state.data?.runs ?? []).some(run => run.kind === 'task' && ['queued', 'running'].includes(run.status))
  return `
    <div class="terminal-page">
      <div class="terminal-main">
        <div class="card terminal-card${active ? ' is-running' : ''}">
          <div class="terminal-chrome">
            <span class="terminal-chrome-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="terminal-chrome-label">终端</span>
            <span class="terminal-chrome-path" title="${attr(project.workspace_path ?? '')}">${esc(tildePath(project.workspace_path ?? project.name))}</span>
          </div>
          ${active ? `<div class="terminal-active-row">
            ${runDot('running')}
            <code class="terminal-active-cmd">${esc(active.command)}</code>
            <span class="run-clock" data-started="${attr(active.createdAt ?? '')}">${duration(active.createdAt)}</span>
            <button class="btn danger terminal-stop" data-action="terminal-stop" data-command-id="${attr(active.id)}">${icon('stop')}<span class="btn-label">停止</span></button>
          </div>` : ''}
          <div class="terminal-output-wrap">
            <pre class="terminal-output" id="terminal-output" data-command-id="${attr(latest?.id ?? '')}">${output ? esc(output) : ''}</pre>
            ${output ? '' : `<div class="terminal-output-empty">${icon('terminal', 'terminal-empty-icon')}<span>暂无输出。执行一条命令后，这里显示实时输出（最多保留末尾 200KB）。</span></div>`}
          </div>
          <form class="terminal-input-row" data-form="terminal-run">
            <input type="hidden" name="projectId" value="${attr(project.id)}">
            <span class="terminal-prompt" aria-hidden="true">$</span>
            <input class="input terminal-input" id="terminal-cmd-input" name="command" placeholder="${active ? '有命令正在运行…' : '输入命令'} " value="${attr(state.terminalDraft)}" autocomplete="off" autocapitalize="off" spellcheck="false" ${active ? 'disabled' : ''}>
            ${active ? '' : '<span class="terminal-kbd" aria-hidden="true">⌘ / Ctrl ↵</span>'}
            <button class="btn primary" type="submit" ${active ? 'disabled' : ''}>${icon('play')}<span class="btn-label">执行</span></button>
          </form>
        </div>
      </div>
      <aside class="terminal-side">
        ${taskBusy ? `<div class="terminal-warn">${icon('alert', 'terminal-warn-icon')}<span class="terminal-warn-text">有任务正在写该项目工作区，终端命令与它并发需自担风险</span></div>` : ''}
        <div class="card terminal-history-card">
          <div class="terminal-history-head"><span class="eyebrow">命令历史</span><span class="tag">${terminal.history.length} 条</span></div>
          ${terminal.history.length === 0 ? '<div class="terminal-history-empty">还没有执行过命令。</div>' : `<div class="terminal-history">
            ${terminal.history.map(item => `
              <button class="terminal-history-item" data-action="terminal-fill" data-command="${attr(item.command)}" data-status="${attr(item.status ?? '')}" title="点击回填到输入框">
                ${terminalStatusPill(item.status)}
                <code class="terminal-history-cmd">${esc(item.command)}</code>
                <span class="terminal-history-meta">
                  ${item.status === 'running' ? `<span class="run-clock" data-started="${attr(item.createdAt ?? '')}">${duration(item.createdAt)}</span>` : `exit ${item.exitCode ?? '—'} · ${duration(item.createdAt, item.endedAt)}`}
                  · ${formatTime(item.createdAt)}
                </span>
              </button>
            `).join('')}
          </div>`}
        </div>
      </aside>
    </div>
  `
}

function renderBots() {
  const bots = state.data?.bots ?? []
  return `
    ${bots.length === 0 ? `<div class="empty-state">
      <div class="empty-symbol">${icon('bot')}</div><h3>还没有 Bot</h3><p>至少创建一个 Bot 才能运行项目群聊和任务。</p>
      <button class="btn" data-action="new-bot">${icon('plus')}新建 Bot</button>
    </div>` : `<div class="grid bots">
      ${bots.map(bot => `<article class="card bot-card">
        <div class="bot-card-head">
          ${avatar(bot, 'lg')}
          <div class="bot-card-title"><strong>${esc(bot.name)}</strong><span>${esc(bot.role || '通用成员')}</span></div>
          <span class="bot-status ${attr(bot.status)}">${esc(BOT_STATUS[bot.status] ?? bot.status)}</span>
        </div>
        <div class="bot-model"><span>${esc(bot.modelRef ?? '未配置模型')}${bot.effort ? ` · ${esc(EFFORT[bot.effort] ?? bot.effort)}` : ''}</span></div>
        <div class="bot-metrics"><span><strong>${bot.openTasks}</strong> 任务</span><span class="dot-sep"></span><span><strong>${bot.memoryCount}</strong> 记忆</span><span class="dot-sep"></span><span><strong>${bot.stats.succeeded}</strong> 次成功</span></div>
        <div class="bot-card-actions">
          <button class="btn small" data-action="edit-bot" data-bot-id="${attr(bot.id)}">${icon('edit')}配置</button>
          ${bot.status === 'active' ? `<button class="btn small" data-action="solo-bot" data-bot-id="${attr(bot.id)}" title="打开该 Bot 的调度页">调度</button><button class="btn small" data-action="archive-bot" data-bot-id="${attr(bot.id)}">归档</button>` : ''}
          ${bot.status === 'archived' ? `<button class="btn small danger" data-action="bot-remove-tracking-open" data-bot-id="${attr(bot.id)}" title="软移除：数据保留，仅停止展示">移除追踪</button>` : ''}
        </div>
      </article>`).join('')}
    </div>`}
  `
}

// 总览bots：全部 Bot 管理（复用 renderBots）+ 按 bot 分组的待审提案批量审批。
// 进化审批从项目 NAV 移到这里（批量）与单聊 bot tab（逐个），项目群聊不再有进化入口。
function renderBotsOverview() {
  const pending = (state.data?.proposals ?? []).filter(item => item.status === 'pending')
  const groups = new Map()
  for (const item of pending) {
    const key = item.bot_id ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const proposalsSection = pending.length === 0 ? '' : `
    <section class="section">
      <div class="section-head"><h3>待审批提案</h3><span>${pending.length} 条待审</span></div>
      ${[...groups.entries()].map(([botId, items]) => {
        const bot = botById(botId)
        const label = bot ? `${bot.name}（${bot.role || '成员'}）` : '未归属 Bot'
        return `
        <div class="card" style="margin-bottom: 10px;">
          <div class="bot-card-head">
            ${botId ? avatar(bot, 'sm') : `<div class="avatar sm">${icon('bot')}</div>`}
            <div class="bot-card-title"><strong>${esc(label)}</strong><span>${items.length} 条待审提案</span></div>
            <div class="bot-card-actions">
              <button class="btn small" data-action="batch-decide-proposals" data-bot-id="${attr(botId)}" data-decision="approved">${icon('check')}全部通过并应用</button>
              <button class="btn small" data-action="batch-decide-proposals" data-bot-id="${attr(botId)}" data-decision="rejected">全部拒绝</button>
            </div>
          </div>
          <div class="list">
            ${items.map(item => `
              <div class="list-row" title="${esc(item.title ?? '')}">
                ${avatar({ name: label, color: 'gray' }, 'sm')}
                <div class="list-main">
                  <div class="list-title"><strong>${esc(item.title ?? '未命名提案')}</strong><span class="member-role">${esc(PROPOSAL_KIND[item.kind] ?? item.kind)}</span></div>
                  <div class="list-meta"><span>${esc(item.created_at ?? '')}</span></div>
                </div>
              </div>`).join('')}
          </div>
        </div>`
      }).join('')}
    </section>`
  return `
    ${proposalsSection}
    <div class="section-head"><h3>全部 Bots</h3><button class="btn" data-action="new-bot">${icon('plus')}新建 Bot</button></div>
    ${renderBots()}
  `
}

// 项目成员管理页：状态与用量均按当前项目聚合（busy=本项目有排队/运行中运行；
// usage 四项与 cost 为该项目全部运行的累计）。邀请走 add_member API，移除走 remove_member。
// DSHBOTS-52：成员行改卡片式网格；上头像、中名称+角色、下状态点与用量。
// DSHBOTS-57：卡片放大（max-width 320px、头像 56px），中段改三行式——名称 / 角色标签 /
// provider·model 小字，模型不再收进 title 提示，关键信息全部在卡面可见；
// 尺寸与「总览bots」的 bot 卡片同口径，不再锁 0.618:1 宽高比（用户 m_c2ff7f）。
// DSHBOTS-65：卡底去掉与 busy pill 重复的运行状态行，新增「已完成 n · 待办 m」任务统计
// （member.taskStats，待办=未完成且未取消，与右侧 pill 各说各的：pill 说运行态，统计说任务量）。
function renderMembers() {
  const project = activeProject()
  if (!project) return noProject()
  const members = project.members ?? []
  return `
    <div class="section-head">
      <p>成员状态与用量按本项目口径聚合；移除后该 Bot 不再接收本项目的提及与新任务。</p>
      <div class="btn-row">
        <button class="btn" data-action="open-invite-member">${icon('plus')}邀请加入</button>
        <button class="btn" data-action="nav" data-view="bots-overview" title="查看全部 Bot 或新建">${icon('bot')}总览bots</button>
      </div>
    </div>
    <div class="members-grid">
      ${members.map(member => {
        const bot = botById(member.id)
        if (!bot) return ''
        const dot = memberRunDot(member)
        const isOwner = member.member_role === 'owner' || member.id === project.owner_bot_id
        const tokens = Number(member.usage_input ?? 0) + Number(member.usage_cache_read ?? 0) + Number(member.usage_cache_write ?? 0) + Number(member.usage_output ?? 0)
        const modelRef = member.modelRef ?? bot.modelRef ?? bot.model ?? null
        const modelLine = modelRef ? String(modelRef) : '未配置'
        const taskStats = member.taskStats ?? {}
        const taskDone = Number(taskStats.done ?? 0)
        const taskOpen = Number(taskStats.open ?? 0)
        const usageDetail = `输入 ${formatNumber(member.usage_input)} · 缓存读 ${formatNumber(member.usage_cache_read)} · 缓存写 ${formatNumber(member.usage_cache_write)} · 输出 ${formatNumber(member.usage_output)}`
        return `
        <div class="member-card${isOwner ? ' is-owner' : ''}" data-member-card data-bot-id="${attr(member.id)}" title="${esc(bot.name)} · ${esc(bot.role || '成员')} · ${esc(dot.text)}">
          ${isOwner ? '' : `<button class="member-card-remove" data-action="remove-member" data-bot-id="${attr(member.id)}" title="移出项目" aria-label="将 ${esc(bot.name)} 移出项目">${icon('close')}</button>`}
          <div class="member-card-top">${avatar(bot, 'lg')}</div>
          <div class="member-card-mid">
            <div class="member-card-name"><strong>${esc(bot.name)}</strong></div>
            <div class="member-card-role">${isOwner ? '<span class="pill violet">总监</span>' : `<span class="member-role">${esc(bot.role || '成员')}</span>`}</div>
            <div class="member-card-model" title="${esc(modelLine)}">${esc(modelLine)}</div>
          </div>
          <div class="member-card-foot">
            <span class="pill ${member.busy ? 'amber' : 'green'} member-card-busy">${member.busy ? '任务中' : '空闲中'}</span>
            <span class="member-card-tasks" title="本项目任务：已完成 ${taskDone} · 待办 ${taskOpen}（待办不含已取消）">已完成 ${taskDone} · 待办 ${taskOpen}</span>
            <span class="member-card-usage" title="${esc(usageDetail)}">合计 <strong>${formatNumber(tokens)}</strong> tokens</span>
            <span class="member-card-cost"><strong>${formatCost(Number(member.usage_cost ?? 0))}</strong></span>
          </div>
        </div>`
      }).join('')}
    </div>
  `
}

function renderSkills() {
  const skills = state.data?.skills ?? []
  const projectSkills = state.data?.projectSkills ?? []
  const proposals = (state.data?.proposals ?? []).filter(item => item.kind === 'skill' && item.status === 'pending')
  const project = pageProject()
  const disabledSet = new Set(project?.disabledSkills ?? [])
  return `
    <div class="section-head">
      <p>技能变更走提案和审批，不直接覆盖。${project ? `开关只作用于当前项目「${esc(project.name)}」：关闭后补全不再列出，Bot 会被明确告知不要调用；技能池本身不变。` : '进入一个项目后可按项目关闭特定技能。'}</p>
      <div class="btn-row">
        <button class="btn" data-action="sync-skills">${icon('refresh')}重新扫描</button>
      </div>
    </div>
    <div class="card-head" style="margin-bottom:10px"><h3>共享技能池</h3></div>
    <div class="path-row plain" style="margin-bottom:14px"><span>技能根目录</span><code>${esc(state.data.paths.skillRoot)}/skills</code><button class="btn icon small" data-action="copy" data-copy="${attr(state.data.paths.skillRoot + '/skills')}">${icon('copy')}</button></div>
    <div class="card list-card">
      ${skills.length === 0 ? `<div class="empty-state" style="border:0"><div class="empty-symbol">${icon('spark')}</div><h3>技能池为空</h3><p>在技能根目录放置技能文件，或提交一个技能提案并审批。</p></div>` : skills.map(skill => {
        const off = disabledSet.has(skill.slug)
        return `
        <div class="list-row skill-row">
          <div class="empty-symbol" style="width:30px;height:30px;border-radius:9px;margin:0">${icon('spark')}</div>
          <div class="list-main">
            <div class="list-title"><span class="skill-slug">${esc(skill.slug)}</span><span class="faint mono">v${esc(currentSkillVersion(skill))}</span><span class="pill ${skill.status === 'active' ? 'green' : 'red'}">${esc(SKILL_STATUS[skill.status] ?? skill.status)}</span>${off ? '<span class="pill red">本项目已关闭</span>' : ''}</div>
            <div class="list-desc">${esc(skill.description || '无描述')}</div>
            <div class="list-meta"><span>${esc(skill.relativePath)}</span></div>
            ${skillVersions(skill)}
          </div>
          <div class="btn-row">
            <button class="btn small" data-action="skill-detail" data-slug="${attr(skill.slug)}">详情</button>
            ${project ? `<button class="btn small" data-action="toggle-skill" data-slug="${attr(skill.slug)}" data-disabled="${off ? '0' : '1'}">${off ? '恢复' : '本项目关闭'}</button>` : ''}
          </div>
        </div>
      `}).join('')}
    </div>
    ${project ? `<div class="card-head" style="margin-top:24px"><h3>当前项目技能</h3></div>
    <div class="section-head"><p>从项目目录（设了生产目录以生产目录为准，见下方实际路径）的 <code>.agents</code>、<code>.claude</code>、<code>.codex</code> 三个根扫描发现；同名技能按 .agents &gt; .claude &gt; .codex 去重。这些技能只在当前项目可用，且优先于同名共享技能。</p></div>
    ${(state.data.paths.projectSkillRoots ?? []).map(root => `<div class="path-row plain" style="margin-bottom:6px"><span style="text-transform:none">${esc(root.root)}</span><code>${esc(root.path)}/skills</code><button class="btn icon small" data-action="copy" data-copy="${attr(root.path + '/skills')}">${icon('copy')}</button></div>`).join('')}
    <div class="card list-card">
      ${projectSkills.length === 0 ? `<div class="empty-state" style="border:0"><div class="empty-symbol">${icon('spark')}</div><h3>项目内没有技能</h3><p>在项目目录的 .agents、.claude 或 .codex 下放置 skills/&lt;技能名&gt;/SKILL.md 即可。</p></div>` : projectSkills.map(skill => {
        const off = disabledSet.has(skill.name)
        const dupRoots = (skill.roots ?? []).filter(root => root !== skill.root)
        return `
        <div class="list-row skill-row">
          <div class="empty-symbol" style="width:30px;height:30px;border-radius:9px;margin:0">${icon('spark')}</div>
          <div class="list-main">
            <div class="list-title"><span class="skill-slug">${esc(skill.name)}</span><span class="faint mono">v${esc(skill.version ?? '1.0.0')}</span><span class="pill green">${esc(skill.root)}</span>${off ? '<span class="pill red">本项目已关闭</span>' : ''}</div>
            <div class="list-desc">${esc(skill.description || '无描述')}</div>
            <div class="list-meta"><span>${esc(skill.relativePath)}</span></div>
            ${dupRoots.length ? `<div class="list-meta"><span>同名技能也出现在 ${dupRoots.map(root => esc(root)).join('、')}，按 ${esc(skill.root)} 优先取用</span></div>` : ''}
          </div>
          <div class="btn-row">
            <button class="btn small" data-action="copy" data-copy="${attr(skill.path)}">${icon('copy')}复制路径</button>
          </div>
        </div>
      `}).join('')}
    </div>` : ''}
    ${proposals.length ? `<div class="card-head" style="margin-top:24px"><h3>待审批技能提案</h3></div>
    <div class="grid">
      ${proposals.map(item => `<div class="card proposal-card">
        <div class="proposal-head"><div class="empty-symbol" style="width:30px;height:30px;border-radius:9px;margin:0">${icon('spark')}</div><div><h3>${esc(item.title)}</h3><p>${esc(item.rationale)}</p></div></div>
        <div class="proposal-actions"><span class="pill">待审</span><button class="btn small" data-action="decide-proposal" data-proposal-id="${attr(item.id)}" data-decision="approved">${icon('check')}通过</button><button class="btn small" data-action="decide-proposal" data-proposal-id="${attr(item.id)}" data-decision="rejected">拒绝</button></div>
      </div>`).join('')}
    </div>` : ''}
  `
}

function memoryStatusTone(status) {
  if (status === 'active') return 'green'
  if (status === 'pending') return 'amber'
  if (status === 'rejected' || status === 'archived') return 'red'
  return ''
}

function pendingMemoryCount() {
  const list = state.data?.memories
  if (Array.isArray(list)) return list.filter(item => item.status === 'pending').length
  return Number(list?.pending ?? 0)
}

async function searchMemories() {
  const query = String(state.memoryQuery ?? '').trim()
  if (!query) {
    state.memoryResults = null
    render()
    return
  }
  const project = pageProject()
  const payload                    = { query }
  if (project) payload.projectId = project.id
  else if (inSoloContext() && state.soloBotId) payload.botId = state.soloBotId
  const result = await api('search_memories', payload)
  state.memoryResults = Array.isArray(result) ? result : (result?.items ?? [])
  render()
}

function renderMemory() {
  const project = pageProject()
  // 记忆随上下文收敛（DSHBOTS-5）：群聊=当前项目 scope、单聊=该 bot scope，服务端已按上下文过滤，
  // 客户端不再有作用域筛选与「团队记忆」概念。
  const memories = state.data?.memories ?? []
  const pending = pendingMemoryCount()
  const results = state.memoryResults
  return `
    ${memories.length === 0 ? '' : `<div class="board-toolbar">
      <input class="input search" id="memory-search" placeholder="搜索记忆主题或内容" aria-label="搜索记忆主题或内容" value="${attr(state.memoryQuery)}">
      <button class="btn" data-action="search-memories">${icon('search')}搜索</button>
      ${pending ? `<span class="pill amber">${pending} 条待审</span>` : ''}
      <span class="tag" style="margin-left:auto">${memories.length} 条</span>
    </div>`}
    ${results ? `<div class="card list-card" style="margin-bottom:12px">
      <div class="card-head"><h3>搜索结果（${results.length}）</h3><button class="btn small" data-action="clear-memory-search">${icon('close')}清除</button></div>
      ${results.length === 0 ? '<div class="faint">没有匹配的记忆。</div>' : results.map(item => `<div class="list-row">
        <div class="list-main">
          <div class="list-title">${esc(item.topic)}<span class="pill ${memoryStatusTone(item.status)}">${esc(MEMORY_STATUS[item.status] ?? item.status ?? '未知')}</span></div>
          <div class="list-desc">${esc(item.content)}</div>
          <div class="list-meta"><span>${esc(item.scope_type === 'project' ? '项目' : (botById(item.scope_id)?.name ?? 'Bot'))}</span><span>${esc(timeAgo(item.updated_at))}</span></div>
        </div>
      </div>`).join('')}
    </div>` : ''}
    ${!project && !inSoloContext() ? noProject() : memories.length === 0 ? `<div class="empty-state"><div class="empty-symbol">${icon('memory')}</div><h3>还没有记忆</h3><p>任务完成后会自动沉淀交付经验。</p><button class="btn" data-action="new-memory">${icon('plus')}写入记忆</button></div>` : `<div class="grid">
      ${memories.map(memory => {
        const scopeName = memory.scope_type === 'project' ? '项目' : (botById(memory.scope_id)?.name ?? 'Bot')
        const status = memory.status ?? 'active'
        return `<article class="card list-card">
          <div class="list-row">
            <div class="list-main">
              <div class="card-head">
                <div class="list-title">${esc(memory.topic)}<span class="pill ${memoryStatusTone(status)}">${esc(MEMORY_STATUS[status] ?? status)}</span></div>
                <div class="btn-row">
                  ${status === 'pending' ? `<button class="btn small" data-action="approve-memory" data-memory-id="${attr(memory.id)}">${icon('check')}通过</button><button class="btn small" data-action="reject-memory" data-memory-id="${attr(memory.id)}">${icon('close')}拒绝</button>` : ''}
                  <span class="pill">${esc(scopeName)}</span>
                  <button class="btn icon" data-action="edit-memory" data-memory-id="${attr(memory.id)}" title="编辑记忆" aria-label="编辑记忆">${icon('edit')}</button>
                  <button class="btn icon" data-action="delete-memory" data-memory-id="${attr(memory.id)}" title="删除记忆" aria-label="删除记忆">${icon('trash')}</button>
                </div>
              </div>
              <div class="list-desc">${esc(memory.content)}</div>
              <div class="list-meta" style="justify-content:space-between">
                <span>${esc(memorySource(memory.source))}</span>
                <span>${esc(timeAgo(memory.updated_at))} · 置信度 ${Number(memory.confidence ?? 0).toFixed(2)}${memory.approved_by ? ` · 审批人 ${esc(actorLabel(memory.approved_by))}` : ''}</span>
              </div>
            </div>
          </div>
        </article>`
      }).join('')}
    </div>`}
  `
}

function currentSkillVersion(skill) {
  return skill?.currentVersion ?? skill?.version ?? '—'
}

function skillVersions(skill, { rollback = true } = {}) {
  const versions = skill?.versions ?? []
  if (!versions.length) return ''
  const current = String(currentSkillVersion(skill))
  const key = `skill-versions:${skill.slug}`
  return `<details class="skill-versions"${panelAttrs(state, key)}>
    <summary class="summary-link">版本历史（${versions.length}）</summary>
    ${versions.map(version => `<div class="list-meta">
      <span class="mono">v${esc(version.version)}</span>
      <span>${esc(version.status ?? '')}</span>
      <span>${esc(timeAgo(version.created_at))}</span>
      ${String(version.version) !== current && rollback ? `<button class="btn small" data-action="rollback-skill" data-slug="${attr(skill.slug)}" data-version="${attr(version.version)}">回滚</button>` : ''}
    </div>`).join('')}
  </details>`
}

function canaryText(canary) {
  if (!canary) return ''
  if (typeof canary === 'string') return canary
  if (typeof canary === 'object') {
    const parts = Object.entries(canary).map(([key, value]) => {
      const label = key === 'projectIds' ? '项目' : key
      const values = Array.isArray(value) ? value.join('、') : String(value)
      return `${label} ${values}`
    })
    return parts.join(' · ')
  }
  return String(canary)
}

function evaluationText(evaluation) {
  if (!evaluation) return ''
  if (typeof evaluation === 'string') return evaluation
  const verdict = { pass: '通过', fail: '不通过', pending: '待评估' }[evaluation.verdict] ?? evaluation.verdict ?? ''
  const notes = evaluation.notes ? `：${evaluation.notes}` : ''
  const by = evaluation.evaluatedBy ? `（${evaluation.evaluatedBy}）` : ''
  return `${verdict}${notes}${by}`
}

function proposalPreview(proposal) {
  const payload = proposal.payload ?? {}
  if (proposal.kind === 'skill') return payload.content || '技能内容为空'
  if (proposal.kind === 'bot_update') {
    return [payload.role ? `role: ${payload.role}` : '', payload.instructions ? `instructions:\n${payload.instructions}` : '', payload.model ? `model: ${payload.provider}/${payload.model}` : ''].filter(Boolean).join('\n\n') || '无配置内容'
  }
  return JSON.stringify(payload, null, 2)
}

function renderEvolution() {
  const proposals = state.data?.proposals ?? []
  // 单聊进化 tab 只看该 bot 自己的提案（逐个审批）；项目群聊不再挂进化入口（批量审批在「总览bots」）。
  const scoped = inSoloContext() ? proposals.filter(item => item.bot_id === state.soloBotId) : proposals
  const pending = scoped.filter(item => item.status === 'pending')
  const proposalDiff = (proposal) => {
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
  const proposalDiffText = (proposal) => {
    const diff = proposal?.diff
    if (diff && typeof diff === 'object') {
      const blocks = Object.entries(diff                                                  ).map(([field, change]) => {
        const from = change?.from ?? ''
        const to = change?.to ?? ''
        if (!from && !to) return ''
        return `${field}\n- ${from}\n+ ${to}`
      }).filter(Boolean)
      if (blocks.length) return blocks.join('\n\n')
    }
    return proposalDiff(proposal)
  }
  return `
    <div class="section-head">
      <p>变更需经人工审批后生效。</p>
      <div class="btn-row">
        ${pending.length ? `<span class="pill">${pending.length} 个待审批</span>` : ''}
        <button class="btn" data-action="new-proposal" data-kind="bot_update">${icon('plus')}新建提案</button>
      </div>
    </div>
    ${scoped.length === 0 ? `<div class="empty-state"><div class="empty-symbol">${icon('branch')}</div><h3>还没有进化提案</h3><p>Bot 可以提交自我改进建议，但无法自行批准。</p><button class="btn" data-action="new-proposal" data-kind="bot_update">${icon('plus')}新建提案</button></div>` : `<div class="grid" style="gap:16px">
      ${scoped.map(proposal => {
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
          ${proposal.kind === 'workflow' ? '<div class="note">工作流提案尚未支持执行。</div>' : ''}
          <div class="proposal-body" style="margin-top:0">${esc(proposalPreview(proposal).slice(0, 6000))}</div>
          <div class="list-meta"><span>${esc(PROPOSAL_KIND[proposal.kind] ?? proposal.kind)}</span>${proposal.botName ? `<span>${esc(proposal.botName)}</span>` : ''}<span>${esc(timeAgo(proposal.created_at))}</span>${proposal.decided_by ? `<span>由 ${esc(actorLabel(proposal.decided_by))} 决定</span>` : ''}${proposal.approvedBy ? `<span>审批人 ${esc(actorLabel(proposal.approvedBy))}</span>` : ''}${proposal.appliedAt ? `<span>已生效 ${esc(formatTime(proposal.appliedAt))}</span>` : ''}${proposal.canary ? `<span>灰度 ${esc(canaryText(proposal.canary))}</span>` : ''}</div>
          ${proposal.evaluation ? `<div class="list-desc">评估 · ${esc(evaluationText(proposal.evaluation))}</div>` : ''}
          ${proposal.status === 'pending' ? `<details class="proposal-diff"${panelAttrs(state, `proposal:${proposal.id}`)}>
            <summary class="btn small">${icon('chevron', 'chev')}查看差异</summary>
            <div class="proposal-body" style="margin-top:8px">${esc(proposalDiffText(proposal).slice(0, 4000))}</div>
          </details>
          <div class="proposal-actions end">
            <button class="btn small" data-action="evaluate-proposal" data-proposal-id="${attr(proposal.id)}" data-verdict="pass">评估通过</button>
            <button class="btn small" data-action="evaluate-proposal" data-proposal-id="${attr(proposal.id)}" data-verdict="fail">评估不通过</button>
            <button class="btn ${proposal.id === pending[0]?.id ? 'primary' : ''}" data-action="decide-proposal" data-proposal-id="${attr(proposal.id)}" data-decision="approved">${icon('check')}通过并应用</button>
            <button class="btn" data-action="decide-proposal" data-proposal-id="${attr(proposal.id)}" data-decision="rejected">拒绝</button>
          </div>` : ''}
          ${proposal.status === 'canary' ? `<div class="proposal-actions end">
            <button class="btn primary" data-action="promote-proposal" data-proposal-id="${attr(proposal.id)}">${icon('check')}转正全量</button>
          </div>` : ''}
        </article>`
      }).join('')}
    </div>`}
  `
}


export { renderTasks, taskGroupKey, taskChildrenKey, terminalOutputText, renderTerminal, renderBotsOverview, renderMembers, renderSkills, searchMemories, renderMemory, currentSkillVersion, skillVersions, renderEvolution }
