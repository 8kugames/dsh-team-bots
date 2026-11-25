import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { effectiveRunLimits, RUN_LIMIT_RANGES, RUN_TIMEOUT_KEY, STALL_WATCHDOG_KEY, applyRuntimeSettingOverrides } from './config.js'
import { AppError, badRequest, conflict, forbidden, hotUpgradeUnsupported, notFound } from './errors.js'
import { assertInside, botWorkspaceDir, botsHome, ensureDirResilient, ensureExternalDir, ensureProjectWorkspace, ensureSkillRoot, projectDir, SLUG_MAX } from './paths.js'
import { runUsageTotals, usageSnapshot } from './usage.js'
import { applyRetention, exportUsageCsv, monthUsageForProject, monthUsageGlobal, reconcileUsage, setPrice } from './usage-reconcile.js'
import { latestDshVersion, compareVersions, validTargetVersion } from './updater.js'
import { priceKey, seedModelPrices } from './pricing.js'
import { publishSkill, rollbackSkill, skillSnapshot, stageSkill, syncSkills } from './skills.js'
import { projectSkillRoots, scanProjectSkills } from './project-skills.js'
import { deliveryPlan, replyDeliveryPrompt, summarizeForUi, upsertBotMessage } from './botmsg.js'
import { ENV_PREFIX, SecretBox, maskSecrets, materializeEnvFile, normalizeSecretName, secretFingerprint, secretKeyFingerprint } from './secrets.js'
import { clampNumber, jsonParse, nowIso, parseDisabledSkills, parseMentions, projectKey, redactSecrets, sha256, slugify, TASK_ID_PATTERN, sanitizeFilename, writeIfChanged } from './util.js'
import { parseWriteScopes, readWriteScopes, writeScopesOverlap } from './services/write-scopes.js'
import { normalizeFilePolicy } from './services/file-policy.js'
import { sessionViewMethods } from './services/session-view.js'
import { defineMethods } from './services/mixin.js'
import { reviewResult } from './wechat/format.js'
import { botsMethods } from './services/bots.js'
import { projectsMethods } from './services/projects.js'
import { chatMethods } from './services/chat.js'
import { tasksMethods } from './services/tasks.js'
import { taskDispatchMethods } from './services/task-dispatch.js'
import { taskRunMethods } from './services/task-runs.js'
import { taskNotifyMethods } from './services/task-notify.js'
import { notifyMethods } from './services/notify.js'
import { taskReviewMethods } from './services/task-review.js'
import { reviewWatchdogMethods } from './services/review-watchdog.js'
import { runsMethods } from './services/runs.js'
import { runFinishMethods } from './services/run-finish.js'
import { hygieneMethods } from './services/hygiene.js'
import { modelFallbackMethods } from './services/model-fallback.js'
import { botQuotaMethods } from './services/bot-quota.js'
import { schedulerMethods } from './services/scheduler.js'
import { memoryMethods } from './services/memory.js'
import { secretsMethods } from './services/secrets.js'
import { proposalsMethods } from './services/proposals.js'
import { terminalMethods } from './services/terminal.js'
import { usageMethods } from './services/usage.js'
import { systemMethods } from './services/system.js'
import { wechatMethods } from './services/wechat.js'
import { feishuMethods } from './services/feishu.js'
import { githubSourceMethods } from './services/github-source.js'
import { approvalsMethods } from './services/approvals.js'
import { questionsMethods } from './services/questions.js'
import { chatStoreMethods } from './services/chat-stores.js'
import { coreMethods } from './services/core.js'

export { WRITE_SCOPE_MAX, WRITE_SCOPE_MAX_LEN, parseWriteScopes, readWriteScopes, writeScopePathsOverlap, writeScopesOverlap } from './services/write-scopes.js'
export { FILE_POLICIES, FILE_POLICY_LABELS } from './services/file-policy.js'

export class TeamService {
  constructor({ store, config, logger = console as DshLogger }) {
    this.store = store
    // config 是存活覆盖视图（全局设置「运行参数」卡）：settings 表保存值在 env 未
    // 显式时覆盖启动默认，所有 this.config.* 读点即时生效，无需改各消费点。
    // 按 settings_revision 缓存：保存一次才重算，调度热路径零开销。
    this.baseConfig = config
    this.configCache = null
    this.configCacheRev = -1
    Object.defineProperty(this, 'config', {
      get() {
        const rev = Number(this.store?.setting?.('settings_revision', '0')) || 0
        if (this.configCache && this.configCacheRev === rev) return this.configCache
        this.configCache = applyRuntimeSettingOverrides(this.baseConfig, key => this.store?.setting(key))
        this.configCacheRev = rev
        return this.configCache
      },
      configurable: true,
    })
    this.logger = logger
    this.runtime = null
    this.localUserId = 'user_local'
    this.timer = null
    this.ticking = false
    this.started = false
    // 停机标志：插件卸载后实例必须完全静默（库已关闭，任何再触发的写库都是错的）。
    this.stopped = false
    this.bootTimer = null
    this.ready = null
    this.rate = {}
    // 只读运行开始时的项目工作区指纹，用于事后发现“只读会话改了文件”。
    this.fingerprints = new Map()
    // 已告警过的只读审计指纹（project.id:after 的 sha256 → run.id，DSHBOTS-96 P1-2）：
    // 同一指纹跨运行只点名一次，重复只记 run_event，不重复插群消息。
    this.readAuditAlerted = new Map()
    this.lastMaintenanceAt = 0
    // 最近一次全量调度拍的时间戳（空载门 tickIdleGate 的基准；0 = 首拍必全量）。
    this.lastFullTickAt = 0
    // state 轮询版本短路缓存（system.state）：单槽存最近一次组装的 key/版本/时间。
    this.stateCache = null
    this.wechat = null
    // GitHub 触发源的 gh 执行钩子（B4-②/DSHBOTS-335）：生产用 spawnSync('gh', ...)，
    // 测试注入桩替换；未设置时走真实 gh CLI。
    this.githubRunner = null
    // 运行中的终端命令：commandId → { child, buffer, startedAtMs, timedOut, cancelRequested, timer }。
    // 进程引用与实时 tail 只放内存；结束即释放，历史落 terminal_commands 表。
    this.terminalActive = new Map()
  }

  /** 微信管理员指令：按 <key-N> 定位并验收/退回任务。回执排版集中在 wechat/format.js（DSHBOTS-211）。 */
  async wechatReview(identifier, { decision, comment }) {
    await this.initialize()
    if (!['accept', 'return'].includes(decision)) throw badRequest('验收结果只能是 accept 或 return')
    const { project, task } = this.resolveTaskByIdentifier(identifier)
    const view = await this.applyReview(task, project, decision, comment, { type: 'user', id: this.localUserId })
    return reviewResult(identifier, view.title, decision)
  }
}

// 业务域方法按域拆到 src/services/*.js，这里挂回 TeamService 原型：
// 对外仍是 service.method(...) 的调用方式，方法体内的 this 语义与拆分前完全一致。
defineMethods(TeamService.prototype, [
  botsMethods,
  projectsMethods,
  chatMethods,
  tasksMethods,
  taskDispatchMethods,
  taskRunMethods,
  taskNotifyMethods,
  notifyMethods,
  taskReviewMethods,
  reviewWatchdogMethods,
  runsMethods,
  runFinishMethods,
  hygieneMethods,
  modelFallbackMethods,
  botQuotaMethods,
  schedulerMethods,
  memoryMethods,
  secretsMethods,
  proposalsMethods,
  terminalMethods,
  usageMethods,
  systemMethods,
  wechatMethods,
  feishuMethods,
  githubSourceMethods,
  approvalsMethods,
  questionsMethods,
  chatStoreMethods,
  sessionViewMethods,
  coreMethods,
])
