const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

// DSHBOTS-238：子代理/智能体团队能力全员化。
// 「生成子代理/组建临时团队」能力由宿主 preset 注册（subagent/subagent_fork/workflow 与
// spawn_teammate 等团队工具），插件侧只声明其可用清单与门控，不重复注册。
// DSHBOTS-237：共享板建卡废弃——宿主共享板的建卡工具（task-N 无项目编号卡）
// 不再作为成员能力宣告，新建卡一律走项目编号（team_assign_task 派单链，KEY-N）；
// 存量共享板卡可读不可新建，list/get/update 保留读取与流转能力。
export const SUBAGENT_GENERATION_TOOLS = [
  'subagent',
  'subagent_fork',
  'workflow',
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_list',
  'team_task_get',
  'team_task_update',
] as const

// 总监专权工具：服务层 ownerContextFor 已做权威校验，本清单用于工具层兜底与守门测试。
// team_block_task（DSHBOTS-232）与派单/验收同款总监专属：强制受阻停运行是不可逆控制面操作。
// team_list_bots / team_add_member / team_create_bot（DSHBOTS-229）是团队编制入口：
// 池查询含未入群 bot，加人与建 bot 会改动项目成员或全局 bot 档案。
// team_memory_list / team_memory_write / team_memory_cleanup（DSHBOTS-239）是记忆巡检面：
// 枚举、同名覆盖写与批量终态化清理都只归总监。
export const DIRECTOR_ONLY_TOOLS = [
  'team_assign_task',
  'team_review_task',
  'team_block_task',
  'team_list_bots',
  'team_add_member',
  'team_create_bot',
  'team_memory_list',
  'team_memory_write',
  'team_memory_cleanup',
  'team_release_bot_quota',
] as const

// 门控：agentTeam 开启且 bot 类型支持（项目内 active bot，成员与总监均可用）。
export function subagentCapabilityEnabledFor(bot, config) {
  return Boolean(config?.agentTeam) && Boolean(bot?.id) && bot.status !== 'removed'
}

// 工具层兜底（DSHBOTS-238）：成员 bot 隐藏总监专权工具，避免「误调被拒后才知情」；
// 子代理生成工具由 preset 全局注册，成员 bot 默认可见，无需额外放行。
// DSHBOTS-247：调用点形状不一——session.ts 的结转/复用路径传 resolveAgent 的
// `{ agent }` 包装，新建会话路径传裸 agent。这里归一为句柄后取 restrict，两种形状都生效；
// 旧实现只认包装形状时，裸形状会静默跳过（策略从未生效）或旧构建抛 "reading 'ctx'"。
export function applyBotToolPolicy(resolved, { isOwner, logger }: { isOwner: boolean; logger?: { warn?: (...args: unknown[]) => void } }) {
  if (isOwner) return
  const handle = resolved?.agent ?? resolved
  const restrict = handle?.ctx?.tools?.restrict
  if (typeof restrict !== 'function') return
  try {
    restrict({ deny: [...DIRECTOR_ONLY_TOOLS] })
  } catch (error: any) {
    // 工具层兜底失败不阻断会话：服务层 ownerContextFor 仍是权威闸门。
    logger?.warn?.(`dsh-team: 应用成员 bot 工具策略失败：${error?.message ?? error}`)
  }
}

export function installTeamTools(ctx, service) {
  if (!ctx.tools?.register) return

  ctx.tools.register({
    name: 'team_assign_task',
    description: 'The regular path to dispatch project work to a bot: create a new task card or re-dispatch/amend an existing one. Only the project owner bot may use this. With `task` it re-dispatches that existing task (retry to the same bot, or hand it to a different bot); passing title/description/priority alongside `task` amends the card — the assignee is immediately notified to correct course per the new card. Without `task`, creates a new task that starts automatically. A new task whose write scopes exactly match an unfinished task in the same project is rejected as a duplicate dispatch; merge the cards into the existing task instead, or pass force_duplicate to override (audited). Consolidate before dispatch: one requirement goes into one card — amend and re-dispatch the existing card (or add subtask cards with parent_task_id for genuinely independent parts) instead of opening several sibling cards for the same need.',
    parameters: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Exact bot name from the project member list' },
        title: { type: 'string', description: 'Short actionable task title (new tasks; on re-dispatch it amends the card)' },
        description: { type: 'string', description: 'Self-contained instructions, constraints and acceptance criteria (new tasks; on re-dispatch it amends the card and the assignee is notified to correct course)' },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low', 'none'], description: 'Task priority (new tasks and card amendment on re-dispatch)' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths this task will modify (new tasks only); the scheduler runs tasks with disjoint scopes in parallel. Omit to parse a `写范围：`/`write_scopes:` line from the description instead' },
        force_duplicate: { type: 'boolean', description: 'Escape hatch (new tasks only): skip the same-write-scope duplicate check when an unfinished task in this project already declares identical write scopes. Use only when a second task on the same paths is intentional; every use is audited as dispatch_force_duplicate' },
        time_budget_minutes: { type: 'integer', description: 'Required delivery time limit in minutes (new tasks only, 1-10080): injected into the task prompt, and the run is aborted when the budget expires. The effective timeout is the smaller of this budget and the global run timeout. Omit to take the default budget (env DSH_TEAM_TASK_TIME_BUDGET_MINUTES > stall-watchdog minutes > fallback 20 minutes)' },
        parent_task_id: { type: 'string', description: 'Nest the new task as a subtask under this main task id (new tasks only): pass it when the main item cannot be finished in this run or a new closing condition emerged, so follow-up work lands as a product-grade card instead of a verbal note; also pass it to split a large task into parallel subtask cards for speed (independent parts, disjoint write_scopes, so the cards run concurrently). Must reference an existing task in the same project; self-reference is rejected. The backend validates' },
        task: { type: 'string', description: 'Existing task to re-dispatch, as KEY-N (for example DEMO-3). Omit to create a new task' },
        sandbox: { type: 'string', enum: ['inherit', 'workspace-write', 'read-only'], default: 'inherit', description: 'Sandbox tier for this task\'s runs (new tasks and re-dispatch); default inherit = follow the assignee bot\'s configured file policy, so a development task is never tightened to read-only unless the card says so. inherit also clears any stored override on re-dispatch. workspace-write/read-only must not be wider than that configuration (tighten-only; every run of the task starts under the effective tier, recorded as a sandbox_mode run event). Use read-only to run a development task in review mode' },
      },
      required: ['assignee'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      if (!args.task && !args.title) throw new Error('Creating a new task requires title')
      const task = await service.assignFromBot(sessionId, args)
      return args.task
        ? `Re-dispatched ${task.identifier} to ${task.assignee_name ?? args.assignee} (status: ${task.status}).`
        : `Created ${task.identifier} and assigned it to ${task.assignee_name ?? args.assignee}.`
    },
  })

  ctx.tools.register({
    name: 'team_block_task',
    description: 'The regular path to force-stop a task: force-move an in-progress task to blocked and abort its queued/running runs. Only the project owner bot may use this. The stop rides the existing abort chain and is audited as task.force_blocked (run error code TASK_FORCE_BLOCKED). Use it to stop a runaway or wrong-headed execution; typically followed by re-dispatching the same task with an amended card.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task to force-block, as KEY-N (for example DEMO-3)' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const task = await service.forceBlockFromBot(sessionId, args)
      return `Force-blocked ${task.identifier} (status: ${task.status}); its queued/running runs were aborted.`
    },
  })

  ctx.tools.register({
    name: 'team_review_task',
    description: 'The one and only regular path to close or return a delivered task: `accept` marks a waiting-for-review card done; `return` sends it back to the assignee for rework (a reason is required). Hand-editing the store or any side door does not close a card — when the delivery is not reviewable yet, wait for the assignee to deliver, or amend and re-dispatch it with team_assign_task. Only the project owner bot may use this.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task to review, as KEY-N (for example DEMO-3)' },
        decision: { type: 'string', enum: ['accept', 'return'], description: 'accept approves the delivery; return sends it back for rework' },
        comment: { type: 'string', description: 'Acceptance note, or the required rework reason when returning' },
      },
      required: ['task', 'decision'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const task = await service.reviewFromBot(sessionId, args)
      return `${task.identifier} review ${args.decision === 'accept' ? 'accepted' : 'returned for rework'} (status: ${task.status}).`
    },
  })

  // DSHBOTS-229：成员查询——项目群内任意成员可查本项目名单/角色/状态。
  ctx.tools.register({
    name: 'team_list_members',
    description: 'List the bots in this project group with their project role, job role and status. Any bot in the project group may use this. The result is limited to this project\'s members; it never exposes other projects\' data.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      return service.listMembersFromBot(sessionId)
    },
  })

  // DSHBOTS-229：bots 池查询——总监可见含未入群的 bot；成员调用被服务层拒绝。
  ctx.tools.register({
    name: 'team_list_bots',
    description: 'List the team bot pool for this project, including bots that are not in the project group yet, with their status and whether they already belong to this project. Only the project owner bot may use this. It shows each bot\'s own profile and this project\'s membership only; it never exposes other projects\' data.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      return service.listBotsPoolFromBot(sessionId)
    },
  })

  // DSHBOTS-229：加人申请——复用 addProjectMember 的校验、审计与入群通知。
  ctx.tools.register({
    name: 'team_add_member',
    description: 'Invite an existing bot into this project group by its exact name. Only the project owner bot may use this. The invite rides the normal membership path: the bot must be active and cannot already be a member, the join is audited, and the other members are announced in the group automatically.',
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Exact bot name from the team bot pool' },
      },
      required: ['bot'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const result = await service.addMemberFromBot(sessionId, args)
      return `Added ${result.member.name} to ${result.project.key} as ${result.member.member_role}.`
    },
  })

  // DSHBOTS-229：建 bot 申请——仅申请入口，复用 createBot 的全部校验与审计。
  ctx.tools.register({
    name: 'team_create_bot',
    description: 'Request a brand-new bot for the team. Only the project owner bot may use this. The request goes through the normal bot creation path, so name format/uniqueness and provider/model validation still apply, and the audit records you as the requester. The new bot is not added to this project automatically; invite it with team_add_member.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bot name (Chinese/letters/digits/underscore/hyphen, up to 24 chars)' },
        role: { type: 'string', description: 'Short job role, for example 开发 or 设计' },
        instructions: { type: 'string', description: 'Standing instructions for the new bot' },
        provider: { type: 'string', description: 'Model provider (must pair with model)' },
        model: { type: 'string', description: 'Model id (must pair with provider)' },
        effort: { type: 'string', description: 'Optional reasoning effort' },
        fallbackProvider: { type: 'string', description: 'Optional fallback model provider (must pair with fallbackModel)' },
        fallbackModel: { type: 'string', description: 'Optional fallback model id' },
        fallbackEffort: { type: 'string', description: 'Optional fallback reasoning effort' },
        color: { type: 'string', description: 'Avatar color: blue/teal/violet/amber/coral/pink/green/gray' },
        filePolicy: { type: 'string', enum: ['workspace-write', 'read-only', 'danger-full-access'], description: 'File sandbox tier for the new bot; omit to use the default workspace-write' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const bot = await service.createBotFromBot(sessionId, args)
      return `Created bot ${bot.name} (status: ${bot.status}). Invite it to a project with team_add_member.`
    },
  })

  ctx.tools.register({
    name: 'team_recall',
    description: 'Expand one truncated context item by its reference id. Accepts a message id (m_xxxxxx), a task comment id (c_xxxxxx), a run id (run_xxxxxx), or a task number such as DEMO-7. Returns the full stored text for that project only.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Reference id copied from the prompt or a previous tool result' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      return service.recall(sessionId, args.ref)
    },
  })

  ctx.tools.register({
    name: 'team_remember',
    description: 'Save a durable fact, preference, decision or lesson to long-term memory. Do not store credentials or temporary details.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['bot', 'project', 'team'], description: 'bot: only you remember it; project: every project bot can use it; team: shared by the whole team (owner bots only)' },
        topic: { type: 'string', description: 'Short topic label' },
        content: { type: 'string', description: 'The durable memory, with enough context to be useful later' },
      },
      required: ['scope', 'topic', 'content'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const memory = service.rememberFromBot(sessionId, args)
      return `Saved ${memory.scope_type} memory "${memory.topic}".`
    },
  })

  // ── 总监记忆管理工具集（DSHBOTS-239）：list / 同名覆盖写 / 批量清理 ──
  // 服务层 ownerContextFor 权威鉴权；此处注册形态与 DIRECTOR_ONLY_TOOLS 兜底同源。

  ctx.tools.register({
    name: 'team_memory_list',
    description: 'List existing long-term memories in one scope (bot / project / team) for hygiene inspection: entries with short id, topic, updated time and a content preview, optionally filtered by topic substring. Director-only.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['bot', 'project', 'team'], description: 'Which memory scope to enumerate: bot = your own memories, project = this project, team = whole team. Default project' },
        topic: { type: 'string', description: 'Optional substring filter on the topic label' },
        limit: { type: 'integer', description: 'Max entries to return (1-200, default 50)' },
      },
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const rows = service.memoryListFromBot(sessionId, args)
      if (!rows.length) return 'No active memories in this scope.'
      return rows
        .map(row => `- [${row.id.slice(-6)}] ${row.topic} (${row.scope_type}, updated ${row.updated_at})\n  ${String(row.content).replace(/\s+/g, ' ').slice(0, 240)}`)
        .join('\n')
    },
  })

  ctx.tools.register({
    name: 'team_memory_write',
    description: 'Write a durable memory with same-name overwrite: an active memory with the same scope+topic is updated in place (revision bumps, event trail kept) instead of appending a duplicate entry; otherwise a new memory is created. Use it to refresh a wording to the latest final state instead of piling up near-duplicates. Scope rules: bot = your own, project = this project, team = whole team. Never store secrets or credentials. Director-only.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['bot', 'project', 'team'], description: 'bot: only you remember it; project: every project bot can use it; team: shared by the whole team (owner bots only)' },
        topic: { type: 'string', description: 'Short topic label; same topic in the same scope is overwritten in place' },
        content: { type: 'string', description: 'The durable memory, with enough context to be useful later' },
      },
      required: ['scope', 'topic', 'content'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const { memory, overwritten } = service.memoryWriteFromBot(sessionId, args)
      return `${overwritten ? 'Overwrote' : 'Saved'} ${memory.scope_type} memory "${memory.topic}" (rev ${memory.revision}).`
    },
  })

  ctx.tools.register({
    name: 'team_memory_cleanup',
    description: 'Batch-deprecate stale memories in one scope: matched entries are archived (terminal — excluded from recall), each keeps its memory_events trail, and the batch is audited as memory.cleanup with the cleaned entries listed. Two criteria, combinable: `task` archives a closed card\'s process records (its 任务 KEY-N / KEY-N 交付记录 topics; the task must already be done or canceled); `topics` archives the explicitly listed topics — use it for older wordings that conflict with a newer final decision. Do not archive entries recording the user\'s explicit decisions. Director-only.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['bot', 'project', 'team'], description: 'Which memory scope to clean: bot = your own, project = this project, team = whole team' },
        topics: { type: 'array', items: { type: 'string' }, description: 'Exact topic labels to archive in this scope' },
        task: { type: 'string', description: 'Closed card (KEY-N) whose process-record memories should be archived; rejected unless the task is done or canceled' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const result = service.memoryCleanupFromBot(sessionId, args)
      const cleaned = result.cleaned.map(item => `"${item.topic}"`).join(', ') || 'none'
      const missed = result.missed.length ? ` Not found (skipped): ${result.missed.map(topic => `"${topic}"`).join(', ')}.` : ''
      return `Archived ${result.archived} ${result.archived === 1 ? 'entry' : 'entries'}: ${cleaned}.${missed}`
    },
  })

  ctx.tools.register({
    name: 'team_release_bot_quota',
    description: 'Clear a bot\'s provider quota-exhausted state immediately so its queued task runs dispatch again now, instead of waiting for the provider\'s reset time. Use when the provider says the quota already reset, or the bot must work before the recorded reset time. Idempotent: releasing an already-clear bot is a no-op. Director-only; the human owner can do the same from the bot detail panel.',
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot id or exact bot name whose quota state should be cleared' },
      },
      required: ['bot'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const view = service.releaseBotQuotaFromBot(sessionId, args.bot)
      return `Cleared quota state for ${view.name ?? args.bot}.`
    },
  })

  ctx.tools.register({
    name: 'team_propose_evolution',
    description: 'Propose a versioned change to your own instructions or to the shared skill library. A human must review and approve it; this tool never applies the change.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['bot_update', 'skill'], description: 'bot_update changes your role/instructions; skill publishes a reusable skill proposal' },
        title: { type: 'string', description: 'Short proposal title' },
        rationale: { type: 'string', description: 'Why this change is useful and what evidence supports it' },
        instructions: { type: 'string', description: 'For bot_update: the complete replacement instructions' },
        slug: { type: 'string', description: 'For skill: lowercase skill slug' },
        name: { type: 'string', description: 'For skill: display name' },
        description: { type: 'string', description: 'For skill: one-line description' },
        content: { type: 'string', description: 'For skill: complete SKILL.md body in Markdown' },
        version: { type: 'string', description: 'For skill: semantic version, for example 1.0.0' },
        evaluation: { type: 'string', description: 'How the change should be evaluated before approval' },
      },
      required: ['kind', 'title', 'rationale'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const payload = args.kind === 'skill'
        ? { slug: args.slug, name: args.name, description: args.description, content: args.content, version: args.version }
        : { instructions: args.instructions }
      if (args.kind === 'bot_update' && !args.instructions) throw new Error('bot_update proposal requires instructions')
      if (args.kind === 'skill' && (!args.slug || !args.content)) throw new Error('skill proposal requires slug and content')
      const proposal = service.proposeFromBot(sessionId, {
        kind: args.kind,
        title: args.title,
        rationale: args.rationale,
        payload,
        evaluation: args.evaluation,
      })
      return `Created proposal ${proposal.id}. It is pending human approval.`
    },
  })

  ctx.tools.register({
    name: 'team_message_bot',
    description: 'Send a direct message to another bot in the same project and get its reply delivered back into your current conversation later. Idempotent: repeating the same request_id with the same text never duplicates the work, it just returns the current status.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Exact bot name from the project member list' },
        request_id: { type: 'string', description: 'Stable name for this logical request (for example review-login-error); reuse it to poll or resend the same text without duplicating work. A different text under the same request_id is rejected as a conflict, so use a new request_id for a new request' },
        text: { type: 'string', description: 'Self-contained question or instruction for the other bot' },
      },
      required: ['to', 'request_id', 'text'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const result = service.messageFromBot({
        sessionId,
        toName: args.to,
        requestId: args.request_id,
        textBody: args.text,
      })
      return `[dm ${result.messageId}] ${result.created ? 'delivered to' : 'already known to'} ${args.to}: status=${result.status}. ${result.hint}`
    },
  })

  ctx.tools.register({
    name: 'team_request_secret',
    description: 'Ask the human to provision a named secret (credential) for this project. The value never passes through you: once approved, a one-time env file is written outside the workspace and the approval receipt names its exact path; source it in shell (`set -a; . <path>; set +a`). That file is burned when the next task run finishes or its TTL expires, so re-using the credential requires a fresh request and approval.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Secret name, uppercase with underscores (for example GITHUB_TOKEN); a $env:/DSH_SECRET_ prefix is stripped automatically' },
        reason: { type: 'string', description: 'What the secret is needed for and what it will be used to do' },
      },
      required: ['name', 'reason'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      const request = service.requestSecretFromBot({
        sessionId,
        name: args.name,
        reason: args.reason,
      })
      return `Secret request ${request.requestId.slice(-6)} for ${request.name} is pending human approval.`
    },
  })

  // DSHBOTS-243：通知通道产品化——成员通知 / 任务提醒，项目内任意成员可用。
  // 投递面是宿主会话通道（runtime.steer），插件 messages 落库为准绳；跨项目目标一律拒绝。
  ctx.tools.register({
    name: 'team_notify',
    description: 'Send a notification inside this project. Any project member may use this. `target=member` notifies another member bot of this project: the host session channel delivers it immediately when reachable, and the notification is always recorded in the group chat (sender = you, mention = the target). `target=task` reminds a task of this project: if the task has an active run, the reminder is steered into that run session (re-read the card and act on it); otherwise it lands as a task-thread message the owner can see on the review panel. Only members and tasks of this project are addressable; cross-project targets are rejected. A channel failure only warns and never blocks the other channel.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['member', 'task'], description: 'member = notify another project member bot; task = remind a task of this project' },
        member: { type: 'string', description: 'Exact bot name from the project member list (required when target=member)' },
        task: { type: 'string', description: 'Task to remind, as KEY-N (required when target=task)' },
        message: { type: 'string', description: 'Self-contained notification body' },
      },
      required: ['target', 'message'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      if (args.target === 'member' && !args.member) throw new Error('target=member 需要 member（目标 bot 名称）')
      if (args.target === 'task' && !args.task) throw new Error('target=task 需要 task（KEY-N 任务编号）')
      return service.notifyFromBot(sessionId, args)
    },
  })
}
