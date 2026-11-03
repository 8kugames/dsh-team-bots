// 全局状态与枚举常量表：state 对象（URL 初始 view/project 在此解析）与导航表。
// task-group:<status> 面板 key 的预置循环在 app.js 入口执行（依赖 tasks 侧的 taskGroupKey）。
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
  ac: null,
  busy: 0,
  chatAtBottom: true,
  // 渲染窗口闸门：render() 全量重建 DOM 期间为 true，此时到达的聊天滚动事件一律忽略（DSHBOTS-72）。
  rendering: false,
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
  tree: { chats: true, bots: true, archived: false },
  // 群聊已读水位：`<projectId>:<最新消息时间>`，用于避免重复上报已读。
  markedRead: null,
  bootError: null,
  wechatAuth: null,
  wechatPollTimer: null,
  terminalDraft: '',
  terminalPollTimer: null,
}

export const STATUS = {
  backlog: '待规划',
  todo: '待执行',
  in_progress: '进行中',
  blocked: '受阻',
  in_review: '待验收',
  done: '已完成',
  canceled: '已取消',
}
export const STATUS_ORDER = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled']
// 任务分组默认全展开（DSHBOTS-58）：预置循环在 app.js 入口执行（taskGroupKey 定义在
// app.js 侧）——这里不许引用 app.js 的局部函数：模块顶层 ReferenceError 会让整张
// 模块图加载失败，工作台卡在「正在连接团队空间」。
export const PRIORITY = { urgent: '紧急', high: '高', medium: '中', low: '低', none: '无' }
export const PROPOSAL_STATUS = { pending: '待审', canary: '灰度中', approved: '已通过', rejected: '已拒绝' }
export const COLORS = ['teal', 'blue', 'violet', 'amber', 'coral', 'pink', 'green', 'gray']
export const COLOR_NAMES = { teal: '青', blue: '蓝', violet: '紫', amber: '琥珀', coral: '珊瑚', pink: '粉', green: '绿', gray: '灰' }
export const BOT_STATUS = { active: '运行中', paused: '已暂停', archived: '已归档' }
export const RUN_STATUS = { queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', canceled: '已取消' }
// 调度页「正在调度」列表用的运行类型名；未知 kind 直接显示原值，不静默吞掉。
export const RUN_KIND = {
  task_run: '任务运行',
  owner_task_run: '总监任务',
  solo_chat_run: '单聊回复',
  chat_run: '群聊运行',
  dm_run: '私信运行',
  dm_reply: '私信回复',
  memory_review: '记忆复核',
}
// 聊天历史分片大小：与后端 messagesPage 的默认/上限一致（state 轮询同口径）。
export const CHAT_PAGE_SIZE = 200
// 群聊右栏「活跃任务」列表显示上限：标题右侧计数仍显示项目在办任务总数，超出部分用「还有 N 条」提示。
export const CHAT_ACTIVE_TASK_LIMIT = 9
export const SKILL_STATUS = { active: '启用中', missing: '已失效' }
export const MEMORY_STATUS = { active: '已生效', pending: '待审', frozen: '已冻结', rejected: '已拒绝', archived: '已归档' }
export const PROPOSAL_KIND = { bot_update: 'Bot 更新', skill: '技能更新', workflow: '流程更新' }
export const TERMINAL_STATUS = { running: '运行中', succeeded: '已完成', failed: '失败', timeout: '超时', canceled: '已停止', interrupted: '已中断' }
export const CREATOR_TYPE = { bot: 'Bot', user: '用户' }
export const EFFORT = { minimal: '最低', low: '低', medium: '中', high: '高', max: '最高' }
export const FILE_POLICY = { 'read-only': '只读', 'workspace-write': '工作区内修改', 'danger-full-access': '完全访问' }
export const DEFAULT_FILE_POLICY = 'workspace-write'

// The one action in the top-right belongs to the page you are on.
export const VIEW_ACTION = {
  tasks: { label: '新建任务', action: 'new-task', icon: 'plus' },
  memory: { label: '写入记忆', action: 'new-memory', icon: 'plus' },
  skills: { label: '新建提案', action: 'new-proposal', icon: 'plus', kind: 'skill' },
  settings: { label: '保存设置', icon: 'check', submit: 'project-settings-form' },
  'solo-config': { label: '保存配置', icon: 'check', submit: 'solo-config-form' },
}
// 项目导航：进化只挂在单聊 bot tab（逐个审批）与「总览bots」（批量审批），项目 NAV 不再出现。
// 「用量」tab 只看本群；全局用量走侧栏「用量统计」。
export const NAV = [
  ['chat', '群聊', 'message'],
  ['tasks', '任务', 'board'],
  ['members', '成员', 'users'],
  ['skills', '技能', 'spark'],
  ['memory', '记忆', 'memory'],
  ['usage', '用量', 'chart'],
  ['terminal', '终端', 'terminal'],
  ['settings', '设置', 'settings'],
]
// 1V1 上下文的导航：调度窗口 + 集中配置页 + 团队级页面（技能/记忆/进化）+ 本 bot 用量。
// 首个 tab 展示名是「调度」——单聊页已升级为调度页（对话 + 任务 + 运行一览）。
export const SOLO_NAV = [
  ['chat', '调度', 'message'],
  ['solo-config', '配置', 'settings'],
  ['skills', '技能', 'spark'],
  ['memory', '记忆', 'memory'],
  ['evolution', '进化', 'branch'],
  ['usage', '用量', 'chart'],
]

