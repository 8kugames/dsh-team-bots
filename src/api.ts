import { AppError } from './errors.js'
import { exportUsageCsv } from './usage-reconcile.js'

const ACTIONS: Set<TeamActionName> = new Set([
  'health', 'state', 'messages_page', 'models', 'bot_detail',
  'create_bot', 'update_bot', 'archive_bot', 'rollback_bot', 'remove_bot_tracking',
  'release_bot_quota',
  'create_project', 'update_project', 'archive_project', 'reopen_project', 'remove_project_tracking', 'browse_dirs',
  'mark_chat_read',
  'add_member', 'remove_member',
  'send_message', 'send_solo_message', 'get_message_image', 'create_task', 'update_task', 'assign_task', 'transition_task', 'add_comment', 'task_detail', 'task_review_delegate', 'task_update_scopes',
  'retry_run', 'cancel_run', 'run_trajectory', 'answer_attention',
  'create_memory', 'update_memory', 'delete_memory', 'search_memories', 'approve_memory', 'reject_memory',
  'create_proposal', 'decide_proposal', 'evaluate_proposal', 'promote_proposal',
  'approval_decide', 'approvals_pending',
  'question_answer', 'questions_pending',
  'sync_skills', 'skill_detail', 'toggle_skill', 'set_skill_binding', 'rollback_skill',
  'save_price', 'reset_price',
  'settings', 'update_settings', 'update_prompt_segment', 'settings_history', 'export_usage_csv', 'usage_window', 'reconcile_usage', 'outbox',
  'dsh_update_info', 'upgrade_dsh', 'reboot_dsh',
  'wechat_status', 'wechat_login', 'wechat_code', 'wechat_logout', 'notify_receipts', 'wechat_triggers',
  'run_command', 'cancel_command', 'terminal_state',
  'list_secrets', 'upsert_secret', 'delete_secret', 'list_secret_requests', 'approve_secret_request', 'deny_secret_request',
])

export async function handleAction(service, action: TeamActionName, payload: TeamActionPayload = {}, actor?) {
  if (!ACTIONS.has(action)) throw new AppError('UNKNOWN_ACTION', `未知操作 ${action}`, 404)
  switch (action) {
    case 'health':
      return service.health()
    case 'state':
      return service.state(payload.projectId, payload.soloBotId ?? null)
    case 'messages_page':
      // 聊天历史游标分页：更早的消息按最旧一条 created_at+id 向前翻页。
      return service.messagesPage(payload)
    case 'models':
      return service.models(Boolean(payload.force))
    case 'bot_detail':
      return service.botDetail(required(payload.botId, 'botId'))
    case 'create_bot':
      return service.createBot(payload, actor)
    case 'update_bot':
      return service.updateBot(required(payload.botId, 'botId'), payload.patch ?? payload, actor)
    case 'archive_bot':
      return service.archiveBot(required(payload.botId, 'botId'), actor)
    case 'remove_bot_tracking':
      return service.removeBotTracking(
        required(payload.botId, 'botId'),
        { confirmName: payload.confirmName },
        actor,
      )
    case 'rollback_bot':
      return service.rollbackBot(required(payload.botId, 'botId'), required(payload.revisionId, 'revisionId'), actor)
    case 'release_bot_quota':
      return service.releaseBotQuota(required(payload.botId, 'botId'), actor)
    case 'create_project':
      return service.createProject(payload, actor)
    case 'update_project':
      return service.updateProject(required(payload.projectId, 'projectId'), payload.patch ?? payload, actor)
    case 'archive_project':
      return service.archiveProject(required(payload.projectId, 'projectId'), actor)
    case 'reopen_project':
      return service.reopenProject(required(payload.projectId, 'projectId'), actor)
    case 'remove_project_tracking':
      return service.removeProjectTracking(
        required(payload.projectId, 'projectId'),
        { confirmName: payload.confirmName, deleteProductionDir: payload.deleteProductionDir === true },
        actor,
      )
    case 'add_member':
      return service.addProjectMember(required(payload.projectId, 'projectId'), required(payload.botId, 'botId'), actor)
    case 'remove_member':
      return service.removeProjectMember(required(payload.projectId, 'projectId'), required(payload.botId, 'botId'), actor)
    case 'mark_chat_read':
      // IM 式已读：水位只推到用户看到的那条消息，之后新到的仍算未读。
      return service.markChatRead(required(payload.projectId, 'projectId'), payload.readAt ?? '')
    case 'browse_dirs':
      return service.browseDirectories(payload)
    case 'send_message':
      // body 可缺省（纯图片消息）：服务层校验「正文与图片至少有一项」。
      return service.sendMessage(required(payload.projectId, 'projectId'), payload.body ?? '', actor, payload.replyTo ?? null, payload.images ?? [])
    case 'send_solo_message':
      return service.sendSoloMessage(required(payload.botId, 'botId'), payload.body ?? '', actor, payload.images ?? [])
    case 'get_message_image':
      // 按 id 取聊天图片（含 base64），供前端渲染缩略图。
      return service.messageImage(required(payload.imageId, 'imageId'), actor)
    case 'create_task':
      return service.createTask({ ...payload, projectId: required(payload.projectId, 'projectId') }, actor)
    case 'update_task':
      return service.updateTask(required(payload.taskId, 'taskId'), payload.patch ?? payload, actor)
    // 写范围修改（DSHBOTS-151）：owner-only 由服务层守卫（actor.type!=='user' 拒绝），
    // 与 task_review_delegate 同口径；write_scopes/writeScopes 双口径收参（与 createTask 一致）。
    case 'task_update_scopes':
      return service.taskUpdateScopes(required(payload.taskId, 'taskId'), payload.write_scopes ?? payload.writeScopes, actor)
    case 'assign_task':
      return service.assignTask(required(payload.taskId, 'taskId'), required(payload.botId, 'botId'), actor)
    case 'transition_task':
      return service.transitionTask(required(payload.taskId, 'taskId'), required(payload.status, 'status'), actor)
    case 'add_comment':
      return service.addComment(required(payload.taskId, 'taskId'), required(payload.body, 'body'), actor)
    case 'task_detail':
      return service.taskDetail(required(payload.taskId, 'taskId'))
    // 验收核验委派（DSHBOTS-107）：owner-only 由服务层守卫（actor.type!=='user' 拒绝）；
    // HTTP 入口 actor 恒为本地用户，与终端同一口径。
    case 'task_review_delegate':
      return service.taskReviewDelegate(required(payload.taskId, 'taskId'), actor)
    case 'retry_run':
      return service.retryRun(required(payload.runId, 'runId'), actor)
    case 'cancel_run':
      return service.cancelRun(required(payload.runId, 'runId'), actor)
    case 'run_trajectory':
      return service.runTrajectory(required(payload.runId, 'runId'))
    case 'answer_attention':
      return service.answerAttention(required(payload.runId, 'runId'), required(payload.answer, 'answer'), actor)
    // 终端的安全口径与 Bot 相同：命令以当前用户执行、权限与服务进程一致；
    // HTTP 入口由宿主的 owner 路由鉴权兜底，此处不重复校验。
    case 'run_command':
      return service.runTerminalCommand(required(payload.projectId, 'projectId'), payload.command, actor)
    case 'cancel_command':
      return service.cancelTerminalCommand(required(payload.commandId, 'commandId'), actor)
    case 'terminal_state':
      return service.terminalState(required(payload.projectId, 'projectId'))
    case 'create_memory':
      return service.createMemory({
        scopeType: payload.scopeType,
        scopeId: required(payload.scopeId, 'scopeId'),
        topic: payload.topic,
        content: required(payload.content, 'content'),
        source: `manual:${actor.type}:${actor.id}`,
        confidence: 1,
        createdBy: `${actor.type}:${actor.id}`,
      })
    case 'update_memory':
      return service.updateMemory(required(payload.memoryId, 'memoryId'), payload)
    case 'delete_memory':
      return service.deleteMemory(required(payload.memoryId, 'memoryId'), actor)
    case 'search_memories':
      return service.searchMemories({
        projectId: payload.projectId ?? null,
        botId: payload.botId ?? null,
        query: payload.query ?? '',
        limit: payload.limit ?? 20,
      })
    case 'approve_memory':
      return service.approveMemory(required(payload.memoryId, 'memoryId'), actor)
    case 'reject_memory':
      return service.rejectMemory(required(payload.memoryId, 'memoryId'), actor)
    case 'create_proposal':
      return service.createProposal(payload, actor)
    case 'decide_proposal':
      return service.decideProposal(required(payload.proposalId, 'proposalId'), required(payload.decision, 'decision'), actor)
    case 'approval_decide':
      return service.decideApproval(required(payload.approvalId, 'approvalId'), required(payload.decision, 'decision'), actor)
    case 'approvals_pending':
      return service.approvalsPending()
    case 'question_answer':
      return service.answerQuestion(required(payload.questionId, 'questionId'), payload, actor)
    case 'questions_pending':
      return service.questionsPending()
    case 'evaluate_proposal':
      return service.evaluateProposal(required(payload.proposalId, 'proposalId'), payload.evaluation ?? payload, actor)
    case 'promote_proposal':
      return service.promoteProposal(required(payload.proposalId, 'proposalId'), actor)
    case 'sync_skills':
      return service.syncSkillsNow()
    case 'skill_detail':
      return service.skillDetail(required(payload.slug, 'slug'))
    case 'toggle_skill':
      return service.setProjectSkillDisabled(
        required(payload.projectId, 'projectId'),
        required(payload.slug, 'slug'),
        payload.disabled === true,
        actor,
      )
    case 'set_skill_binding':
      return service.setSkillBinding({
        scopeType: payload.scopeType ?? 'project',
        scopeId: payload.scopeId,
        slug: required(payload.slug, 'slug'),
        version: payload.version,
        status: payload.status ?? 'active',
      }, actor)
    case 'rollback_skill':
      return service.rollbackSkillVersion(required(payload.slug, 'slug'), required(payload.version, 'version'), actor)
    case 'save_price':
      return service.savePrice(payload, actor)
    case 'reset_price':
      return service.resetPrice(payload, actor)
    case 'settings':
      return service.settingsView()
    case 'update_settings':
      // B2/DSHBOTS-325：UI 携带读取时的 settings_revision，不匹配即 409（乐观并发）。
      return service.updateSettings(payload.patch ?? payload, actor, payload.revision)
    case 'settings_history':
      // 设置变更历史（A4/DSHBOTS-330）：audit_log 只读视图。
      return service.settingsHistoryView(Number(payload.limit) || 30)
    case 'update_prompt_segment':
      // 可编辑提示词段（B1/DSHBOTS-324）：空文本=恢复默认；保存经预算校验并审计。
      return service.updatePromptSegment(required(payload.segment, 'segment'), String(payload.text ?? ''), actor)
    case 'export_usage_csv':
      return {
        filename: `dsh-team-usage${payload.window ? `-${payload.window}` : ''}-${new Date().toISOString().slice(0, 10)}.csv`,
        csv: exportUsageCsv(service.store, {
          projectId: payload.projectId ?? null,
          soloBotId: payload.soloBotId ?? null,
          days: payload.days ?? 30,
          window: payload.window ?? null,
        }),
      }
    case 'usage_window':
      // 用量时间窗快照（DSHBOTS-121）：按需取，不进 state 轮询。
      return service.usageWindow(payload.projectId ?? null, payload.soloBotId ?? null, payload.window ?? '30d')
    case 'outbox':
      return service.outboxView()
    case 'reconcile_usage':
      return service.runMaintenance({ force: true })
    case 'dsh_update_info':
      return service.dshUpdateInfo()
    case 'upgrade_dsh':
      return service.upgradeDsh(payload.version)
    case 'reboot_dsh':
      return service.rebootDsh()
    case 'wechat_status':
      return service.wechatStatus()
    case 'notify_receipts':
      // 外发收据流水（A3/DSHBOTS-323）：sent/gone 终态可追责，通道未启用时 available:false。
      return service.notifyReceiptsView(Number(payload.limit) || 50)
    case 'wechat_triggers':
      // 入站触发留痕（B4-①/DSHBOTS-328）：每条入站事件的处置与原因，回答「为什么没触发」。
      return service.wechatTriggersView(Number(payload.limit) || 50)
    case 'wechat_login':
      return service.wechatBeginLogin()
    case 'wechat_code':
      return service.wechatSubmitCode(required(payload.code, 'code'))
    case 'wechat_logout':
      return service.wechatLogout()
    case 'list_secrets':
      return service.listSecrets()
    case 'upsert_secret':
      return service.upsertSecret({
        scope: payload.scope === 'team' ? 'team' : 'project',
        projectId: payload.projectId ?? null,
        name: required(payload.name, 'name'),
        purpose: payload.purpose ?? '',
        value: required(payload.value, 'value'),
      }, actor)
    case 'delete_secret':
      return service.deleteSecret(required(payload.secretId, 'secretId'), actor)
    case 'list_secret_requests':
      return service.listSecretRequests()
    case 'approve_secret_request':
      return service.approveSecretRequest(required(payload.requestId, 'requestId'), { value: required(payload.value, 'value') }, actor)
    case 'deny_secret_request':
      return service.denySecretRequest(required(payload.requestId, 'requestId'), actor)
    default:
      throw new AppError('UNKNOWN_ACTION', `未知操作 ${action}`, 404)
  }
}

function required<T>(value: T, name: string): NonNullable<T> {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new AppError('BAD_REQUEST', `缺少参数 ${name}`, 400)
  }
  return value
}
