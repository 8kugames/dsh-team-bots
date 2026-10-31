const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

export function installTeamTools(ctx, service) {
  if (!ctx.tools?.register) return

  ctx.tools.register({
    name: 'team_assign_task',
    description: 'Assign a task to a project bot. Only the project owner bot may use this. With `task` it re-dispatches that existing task (retry to the same bot, or hand it to a different bot); without it, creates a new task that starts automatically.',
    parameters: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Exact bot name from the project member list' },
        title: { type: 'string', description: 'Short actionable task title (new tasks only)' },
        description: { type: 'string', description: 'Self-contained instructions, constraints and acceptance criteria (new tasks only)' },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low', 'none'], description: 'Task priority' },
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
    name: 'team_remember',
    description: 'Save a durable fact, preference, decision or lesson to long-term memory. Do not store credentials or temporary details.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['bot', 'project'], description: 'bot: only you remember it; project: every project bot can use it' },
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
}
