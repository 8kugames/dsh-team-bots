const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

export function installTeamTools(ctx, service) {
  if (!ctx.tools?.register) return

  ctx.tools.register({
    name: 'team_assign_task',
    description: 'Assign a task to a project bot. Only the project owner bot may use this. With `task` it re-dispatches that existing task (retry to the same bot, or hand it to a different bot); without it, creates a new task that starts automatically. A new task whose write scopes exactly match an unfinished task in the same project is rejected as a duplicate dispatch; merge the cards into the existing task instead, or pass force_duplicate to override (audited).',
    parameters: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Exact bot name from the project member list' },
        title: { type: 'string', description: 'Short actionable task title (new tasks only)' },
        description: { type: 'string', description: 'Self-contained instructions, constraints and acceptance criteria (new tasks only)' },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low', 'none'], description: 'Task priority' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths this task will modify (new tasks only); the scheduler runs tasks with disjoint scopes in parallel. Omit to parse a `写范围：`/`write_scopes:` line from the description instead' },
        force_duplicate: { type: 'boolean', description: 'Escape hatch (new tasks only): skip the same-write-scope duplicate check when an unfinished task in this project already declares identical write scopes. Use only when a second task on the same paths is intentional; every use is audited as dispatch_force_duplicate' },
        time_budget_minutes: { type: 'integer', description: 'Expected delivery time limit in minutes (new tasks only, 1-10080): injected into the task prompt as a soft on-schedule delivery constraint. Omit when there is no time requirement; the global run timeout still applies regardless' },
        task: { type: 'string', description: 'Existing task to re-dispatch, as KEY-N (for example DEMO-3). Omit to create a new task' },
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
    name: 'team_review_task',
    description: 'Accept or return a delivered task that is waiting for owner review. Only the project owner bot may use this. `accept` marks the task done; `return` sends it back to the assignee for rework (a reason is required).',
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
}
