// 全项目共享的类型契约。此文件只含类型，不产生运行时代码，也不参与 build.mjs。
// 同一概念原先散落在 errors.js / config.js / api.js / tools.js / state.js / DDL 字符串里，
// 这里统一收口，源码通过全局名字直接引用，无需新增 import。

type SqlValue = string | number | bigint | Uint8Array | null
type DbRow = Record<string, SqlValue>

type ActorType = 'user' | 'bot' | 'system' | 'team' | 'project'
interface Actor {
  type: ActorType
  id: string
}

interface DshLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'canceled'
type TaskPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'
type BotStatus = 'active' | 'paused' | 'archived'
type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timeout' | 'interrupted'
type FilePolicy = 'read-only' | 'workspace-write' | 'danger-full-access'
type UiLanguage = 'auto' | 'zh' | 'en'
type UsageWindow = 'today' | '7d' | '30d' | 'all'
type BotColor = 'blue' | 'teal' | 'violet' | 'amber' | 'coral' | 'pink' | 'green' | 'gray'
type ProposalDecision = 'approved' | 'rejected'
type ReviewDecision = 'accept' | 'return'

type TeamActionName =
  | 'health' | 'state' | 'messages_page' | 'models' | 'bot_detail'
  | 'create_bot' | 'update_bot' | 'archive_bot' | 'rollback_bot' | 'remove_bot_tracking'
  | 'release_bot_quota'
  | 'create_project' | 'update_project' | 'archive_project' | 'reopen_project' | 'remove_project_tracking' | 'browse_dirs'
  | 'mark_chat_read' | 'add_member' | 'remove_member'
  | 'send_message' | 'send_solo_message' | 'get_message_image' | 'create_task' | 'update_task'
  | 'assign_task' | 'transition_task' | 'add_comment' | 'task_detail' | 'task_review_delegate' | 'task_update_scopes'
  | 'retry_run' | 'cancel_run' | 'run_trajectory' | 'answer_attention'
  | 'create_memory' | 'update_memory' | 'delete_memory' | 'search_memories' | 'approve_memory' | 'reject_memory'
  | 'create_proposal' | 'decide_proposal' | 'evaluate_proposal' | 'promote_proposal'
  | 'approval_decide' | 'approvals_pending' | 'question_answer' | 'questions_pending'
  | 'sync_skills' | 'skill_detail' | 'toggle_skill' | 'set_skill_binding' | 'rollback_skill'
  | 'save_price' | 'reset_price' | 'settings' | 'update_settings' | 'update_prompt_segment' | 'export_usage_csv' | 'usage_window' | 'reconcile_usage' | 'outbox'
  | 'dsh_update_info' | 'upgrade_dsh' | 'reboot_dsh'
  | 'wechat_status' | 'wechat_login' | 'wechat_code' | 'wechat_logout' | 'notify_receipts'
  | 'run_command' | 'cancel_command' | 'terminal_state'
  | 'list_secrets' | 'upsert_secret' | 'delete_secret' | 'list_secret_requests' | 'approve_secret_request' | 'deny_secret_request'

/** handleAction 的单包入参；整包透传的 action 由服务方法自行取字段。 */
interface TeamActionPayload {
  projectId?: string
  soloBotId?: string | null
  botId?: string
  taskId?: string
  runId?: string
  memoryId?: string
  proposalId?: string
  approvalId?: string
  questionId?: string
  requestId?: string
  revisionId?: string
  imageId?: string
  secretId?: string
  commandId?: string
  slug?: string
  version?: string
  window?: UsageWindow
  name?: string
  purpose?: string
  scope?: string
  scopeType?: string
  scopeId?: string
  topic?: string
  content?: string
  query?: string
  body?: string
  answer?: string
  segment?: string
  text?: string
  command?: string
  code?: string
  decision?: string
  status?: string
  value?: string
  description?: string
  ownerBotId?: string
  path?: string
  productionDir?: string
  model?: string
  provider?: string
  currency?: string
  input_per_mtok?: number
  output_per_mtok?: number
  cache_read_per_mtok?: number
  cache_write_per_mtok?: number
  confirmName?: string
  readAt?: string
  replyTo?: string | null
  force?: boolean
  disabled?: boolean
  deleteProductionDir?: boolean
  days?: number
  limit?: number
  images?: unknown[]
  write_scopes?: unknown
  writeScopes?: unknown
  evaluation?: unknown
  patch?: TeamActionPayload
}

/** 任务树卡片的渲染选项，与 action 入参无关。 */
interface TaskCardOptions {
  depth?: number
  childCount?: number
  expanded?: boolean
}

/** resolveConfig 的输入与返回值共用这组字段。 */
interface TeamConfig {
  dshHome: string
  workspace: string
  dataDir: string
  dbPath: string
  wechatDbPath: string
  secretKeyPath: string
  memoryDir: string
  messageDir: string
  skillRoot: string
  wechat: { enabled: boolean }
  wechatEnabled: boolean
  maxConcurrentRuns: number
  runTimeoutMs: number
  maxRunTokens: number
  stallTimeoutMs: number
  taskTimeBudgetMinutes: number
  sessionRolloverTurns: number
  sessionCompactTurns: number
  reviewIdleMinutes: number
  uiLanguage: UiLanguage
  chatReplyMaxChars: number
  dmArchiveDays: number
  dmKeepRecent: number
  approvalTimeoutMs: number
  questionTimeoutMs: number
  secretsRuntimeTtlMs: number
  imagePngJpegThresholdBytes: number
  agentTeam: boolean
  maxTeammates: number
  routerPreset: string
  workerPreset: string
  visionProxyProvider: string
  visionProxyModel: string
  autoReviewDelegate: boolean
  codeHygieneExts: string[]
  schedulerIntervalMs: number
  modelCacheMs: number
  usageSnapshotCacheMs: number
  catalogStaleMs: number
  terminalTimeoutMs: number
  seedOwnerName: string
  seedOwnerRole: string
  seedOwnerInstructions: string
  seedBots: unknown[]
  allowDevSeed: boolean
  modelPrices: unknown[]
}

/** DSH 宿主注入的 ctx。宿主包不在依赖树里，按实际调用面自绘。 */
interface DshContext {
  llm?: {
    listProviders?: () => unknown[]
    listModels: (provider: string) => unknown[]
    resolveModelInfo?: (provider: string, model: string) => unknown
  }
  tools?: {
    register?: (tool: unknown) => void
    schemas?: () => Array<{ name: string }>
  }
  systemPrompt?: unknown
  sessionController: {
    cancel: (args: { sessionId: string }) => Promise<unknown>
    prompt: (args: unknown) => Promise<unknown>
    selectModel: (args: unknown) => Promise<unknown>
    resolveAgent: (sessionId: string) => unknown
    create: (args: unknown) => Promise<unknown>
  }
  sessionTitle?: { rename: (session: unknown, title: string) => unknown }
  connection: {
    fetch: { register: (entry: unknown) => unknown }
    requestRejection: (req: unknown) => unknown
    authenticatedUrl: (url: string) => string
    authorizeIndex: (req: unknown, res: unknown, secure: boolean) => unknown
  }
  webServer?: {
    protocol?: string
    register: (entry: unknown) => unknown
  }
  get?: (key: string) => unknown
  on?: (event: string, handler: (...args: never[]) => unknown, options?: unknown) => unknown
  effect?: (setup: () => () => void, label?: string) => unknown
  inject?: (decl: unknown, setup: (scope: unknown) => void) => unknown
}
