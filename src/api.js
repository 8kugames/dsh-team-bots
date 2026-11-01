import { AppError } from './errors.js'

const ACTIONS = new Set([
  'health', 'state', 'models', 'bot_detail',
  'create_bot', 'update_bot', 'archive_bot', 'rollback_bot',
  'create_project', 'update_project', 'archive_project',
  'send_message', 'create_task', 'update_task', 'assign_task', 'transition_task', 'add_comment', 'task_detail',
  'retry_run', 'cancel_run',
  'create_memory', 'update_memory', 'delete_memory',
  'create_proposal', 'decide_proposal',
  'sync_skills', 'skill_detail', 'toggle_skill', 'save_price', 'reset_price',
  'dsh_update_info', 'upgrade_dsh', 'reboot_dsh',
])

export async function handleAction(service, action, payload = {}, actor) {
  if (!ACTIONS.has(action)) throw new AppError('UNKNOWN_ACTION', `未知操作 ${action}`, 404)
  switch (action) {
    case 'health':
      return service.health()
    case 'state':
      return service.state(payload.projectId)
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
    case 'rollback_bot':
      return service.rollbackBot(required(payload.botId, 'botId'), required(payload.revisionId, 'revisionId'), actor)
    case 'create_project':
      return service.createProject(payload, actor)
    case 'update_project':
      return service.updateProject(required(payload.projectId, 'projectId'), payload.patch ?? payload, actor)
    case 'archive_project':
      return service.archiveProject(required(payload.projectId, 'projectId'), actor)
    case 'send_message':
      return service.sendMessage(required(payload.projectId, 'projectId'), required(payload.body, 'body'), actor)
    case 'create_task':
      return service.createTask({ ...payload, projectId: required(payload.projectId, 'projectId') }, actor)
    case 'update_task':
      return service.updateTask(required(payload.taskId, 'taskId'), payload.patch ?? payload, actor)
    case 'assign_task':
      return service.assignTask(required(payload.taskId, 'taskId'), required(payload.botId, 'botId'), actor)
    case 'transition_task':
      return service.transitionTask(required(payload.taskId, 'taskId'), required(payload.status, 'status'), actor)
    case 'add_comment':
      return service.addComment(required(payload.taskId, 'taskId'), required(payload.body, 'body'), actor)
    case 'task_detail':
      return service.taskDetail(required(payload.taskId, 'taskId'))
    case 'retry_run':
      return service.retryRun(required(payload.runId, 'runId'), actor)
    case 'cancel_run':
      return service.cancelRun(required(payload.runId, 'runId'), actor)
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
    case 'create_proposal':
      return service.createProposal(payload, actor)
    case 'decide_proposal':
      return service.decideProposal(required(payload.proposalId, 'proposalId'), required(payload.decision, 'decision'), actor)
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
    case 'save_price':
      return service.savePrice(payload, actor)
    case 'reset_price':
      return service.resetPrice(payload, actor)
    case 'dsh_update_info':
      return service.dshUpdateInfo()
    case 'upgrade_dsh':
      return service.upgradeDsh(payload.version, actor)
    case 'reboot_dsh':
      return service.rebootDsh(actor)
    default:
      throw new AppError('UNKNOWN_ACTION', `未知操作 ${action}`, 404)
  }
}

function required(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new AppError('BAD_REQUEST', `缺少参数 ${name}`, 400)
  }
  return value
}
