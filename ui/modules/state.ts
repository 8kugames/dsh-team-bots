import { t } from './i18n.js'

const params = new URLSearchParams(location.search)
const initialView = params.get('view')

export const state = {
  data: null,
  view: ['chat', 'solo-config', 'tasks', 'bots-overview', 'members', 'skills', 'memory', 'evolution', 'usage', 'terminal', 'settings', 'global'].includes(initialView) ? initialView : 'chat',
  projectId: params.get('project') || null,
  chatMode: 'group',
  soloBotId: null,
  soloDetail: null,
  modal: null,
  // 草稿按上下文分开记（群聊 group:<projectId>、单聊 solo:<botId>），切换互不覆盖、互不清空。
  chatDrafts: {},
  // composer 手动拖高后的像素高度；null = 自动高度（随内容长高，上限 150px）。
  composerHeight: null,
  // 群聊引用回复：{ id, senderName, excerpt }，非空时 composer 上方显示引用条，随发送/取消清除。
  replyTo: null,
  // composer 待发图片：按上下文分键（与草稿同口径），值为 { key, name, mediaType, bytes, data, previewUrl } 数组。
  // 预览走 blob: URL（不进 DOM），base64 只留在 state 里随 send_message 发出。
  pendingImages: {},
  // 聊天历史分片（DSHBOTS-33）：state 轮询只回最后 200 条，更早的经 messages_page 手动加载后存这里。
  // key 与当前会话对齐（group:<projectId> / solo:<botId>），切会话即失效重置；items 与轮询结果按 id 去重合并。
  chatOlder: { key: null, items: [], hasMore: false, loading: false },
  // 折叠面板（<details data-panel>）展开态的 key 集合，toggle 时增删；render 全量重建后据此恢复 open 属性。
  // 任务面板的分组（task-group:<status>）与子任务（task-children:<taskId>）也走这套 key（DSHBOTS-58）。
  openPanels: new Set(),
  // 连续系统通知折叠的展开态（B8/DSHBOTS-336）：组键=首条消息 id，跨轮询稳定。
  expandedCollapses: new Set(),
  // 顶部「待处理审批」条（DSHBOTS-102）：跨项目 pending 聚合；approvalPanelOpen 是明细面板展开态，
  // approvalDeciding 是正在决策的 approval id 集合（决策中禁用按钮，防重复点击）。
  approvalPanelOpen: false,
  approvalDeciding: new Set(),
  // 顶部「待回答提问」条（DSHBOTS-116）：与审批同构；questionDraft 是卡片内未提交的选择/补充说明，
  // 整页重渲染据此恢复选中态与输入内容（提交成功后清除）。
  questionPanelOpen: false,
  questionAnswering: new Set(),
  questionDraft: new Map(),
  ac: null,
  busy: 0,
  chatAtBottom: true,
  // 渲染窗口闸门：render() 全量重建 DOM 期间为 true，此时到达的聊天滚动事件一律忽略（DSHBOTS-72）。
  rendering: false,
  // 轮询渲染闸门（DSHBOTS-123）：composerInputAt=最近一次 composer 输入事件时间戳，
  // composerComposing=IME 组词中；二者共同决定轮询整页渲染是否为「正在输入」让路。
  composerInputAt: 0,
  composerComposing: false,
  taskFilter: { status: 'all', assignee: 'all', search: '', timeRange: '7d' },
  // 任务面板组内排序（D-63）：默认完成时间新→旧；六档口径见 TASK_SORTS。
  taskSort: 'completed_desc',
  // 用量页三态：global=侧栏「用量统计」的全局视图；domain=群聊 NAV 用量 tab（本群）；solo=单聊 NAV 用量 tab（本 bot）。
  usageMode: 'global',
  // 全局视图内的展示维度：global / model / bot / project（口径切换只保留这四类）。
  usageScope: 'global',
  usageBot: null,
  memoryQuery: '',
  memoryResults: null,
  theme: 'dsh',
  // 明暗偏好三态：auto=跟随宿主/系统，light=日间，dark=夜间（与调色板 theme 正交）。
  colorSchemePref: 'auto',
  tree: { chats: true, bots: true, archived: false },
  // 群聊已读水位：`<projectId>:<最新消息时间>`，用于避免重复上报已读。
  markedRead: null,
  // 乐观切换（DSHBOTS-167）：点击侧栏后先出视图骨架，数据到位再落真实列表。
  // 值为目标上下文 { projectId, chatMode, soloBotId, seq }；renderView 在「已加载数据 ≠ 目标上下文」
  // 时出骨架，数据到位自动落回（对 2.8s 轮询自愈，不会卡骨架）。
  // seq 是取数序号：连续点击时先发的旧响应不得清掉后一次的骨架标志。
  chatPending: null,
  chatRequestSeq: 0,
  bootError: null,
  wechatAuth: null,
  wechatPollTimer: null,
  terminalDraft: '',
  terminalPollTimer: null,
}

// 枚举表键化：值在访问时经 t() 解析（getter），模块加载不固化语言；状态码保持英文原样。
const keyed = (prefix, keys) => {
  const table = {}
  for (const key of keys) {
    Object.defineProperty(table, key, { get: () => t(`${prefix}${key}`), enumerable: true, configurable: true })
  }
  return table
}

export const STATUS = keyed('status.', ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled'])
export const STATUS_ORDER = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled']
// 任务分组默认全展开（DSHBOTS-58）：预置循环在 app.js 入口执行（taskGroupKey 定义在
// app.js 侧）——这里不许引用 app.js 的局部函数：模块顶层 ReferenceError 会让整张
// 模块图加载失败，工作台卡在「正在连接团队空间」。
export const PRIORITY = keyed('priority.', ['urgent', 'high', 'medium', 'low', 'none'])
export const PROPOSAL_STATUS = keyed('proposalStatus.', ['pending', 'canary', 'approved', 'rejected'])
export const COLORS = ['teal', 'blue', 'violet', 'amber', 'coral', 'pink', 'green', 'gray']
export const COLOR_NAMES = keyed('colorName.', ['teal', 'blue', 'violet', 'amber', 'coral', 'pink', 'green', 'gray'])
export const BOT_STATUS = keyed('botStatus.', ['active', 'paused', 'archived'])
export const RUN_STATUS = keyed('runStatus.', ['queued', 'running', 'succeeded', 'failed', 'canceled'])
// 调度页「正在调度」列表用的运行类型名；未知 kind 直接显示原值，不静默吞掉。
export const RUN_KIND = keyed('runKind.', ['task_run', 'owner_task_run', 'solo_chat_run', 'chat_run', 'dm_run', 'dm_reply', 'memory_review'])
// 聊天历史分片大小：与后端 messagesPage 的默认/上限一致（state 轮询同口径）。
export const CHAT_PAGE_SIZE = 200
// 群聊右栏「活跃任务」列表显示上限：标题右侧计数仍显示项目在办任务总数，超出部分用「还有 N 条」提示。
export const CHAT_ACTIVE_TASK_LIMIT = 9
export const SKILL_STATUS = keyed('skillStatus.', ['active', 'missing'])
export const MEMORY_STATUS = keyed('memoryStatus.', ['active', 'pending', 'frozen', 'rejected', 'archived'])
export const PROPOSAL_KIND = keyed('proposalKind.', ['bot_update', 'skill', 'workflow'])
export const TERMINAL_STATUS = keyed('terminalStatus.', ['running', 'succeeded', 'failed', 'timeout', 'canceled', 'interrupted'])
export const CREATOR_TYPE = keyed('creatorType.', ['bot', 'user'])
export const EFFORT = keyed('effort.', ['minimal', 'low', 'medium', 'high', 'max'])
export const FILE_POLICY = keyed('filePolicy.', ['read-only', 'workspace-write', 'danger-full-access'])
export const DEFAULT_FILE_POLICY = 'workspace-write'

// 标签表翻译：表内命中 → t(前缀 + 键)，未命中回退键名本身（未知枚举不静默吞）。
// 各视图展示状态/优先级等枚举时统一走这里，避免硬编码中文字面量绕过 i18n。
export function labelText(table, key, prefix) {
  return Object.prototype.hasOwnProperty.call(table, key) ? t(`${prefix}${key}`) : key
}

// 后端 taskStageLabel 下发的中文阶段文案（task-stage.js 查表结果）：按「原文即键」入典翻译，
// 未收录的文案回退原值并 warn，不静默吞。
export function stageLabelText(label) {
  return label ? t(label) : ''
}

// The one action in the top-right belongs to the page you are on.
// label 不落地展示：顶栏按钮统一取 t('viewAction.' + view)，故此处只保留行为字段。
export const VIEW_ACTION = {
  tasks: { action: 'new-task', icon: 'plus' },
  memory: { action: 'new-memory', icon: 'plus' },
  skills: { action: 'new-proposal', icon: 'plus', kind: 'skill' },
  settings: { icon: 'check', submit: 'project-settings-form' },
  'solo-config': { icon: 'check', submit: 'solo-config-form' },
}
// 项目导航：进化只挂在单聊 bot tab（逐个审批）与「总览bots」（批量审批），项目 NAV 不再出现。
// 「用量」tab 只看本群；全局用量走侧栏「用量统计」。
// 元组为 [view, icon]：展示名统一取 t('nav.' + view)（单聊 chat 用 nav.soloChat）。
export const NAV = [
  ['chat', 'message'],
  ['tasks', 'board'],
  ['members', 'users'],
  ['skills', 'spark'],
  ['memory', 'memory'],
  ['usage', 'chart'],
  ['terminal', 'terminal'],
  ['settings', 'settings'],
]
// 1V1 上下文的导航：调度窗口 + 集中配置页 + 团队级页面（技能/记忆/进化）+ 本 bot 用量。
// 首个 tab 展示名是「调度」——单聊页已升级为调度页（对话 + 任务 + 运行一览）。
export const SOLO_NAV = [
  ['chat', 'message'],
  ['solo-config', 'settings'],
  ['skills', 'spark'],
  ['memory', 'memory'],
  ['evolution', 'branch'],
  ['usage', 'chart'],
]

