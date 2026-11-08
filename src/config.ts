import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveModelPrices } from './pricing.js'
import { SEED_BOTS, SEED_OWNER } from './seed-bots.js'

export function defaultWorkspace() {
  const configured = process.env.DSH_TEAM_WORKSPACE?.trim()
  if (configured) return resolve(configured)
  return join(homedir(), '.dsh', 'workspace', 'team-bots')
}

// DSH_TEAM_GITHUB_WATCH 解析：JSON 数组 [{projectKey, repo}]，非法一律 []（B4-②/DSHBOTS-335）。
export function parseGithubWatchEnv(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(String(raw))
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(item => ({ projectKey: String(item?.projectKey ?? '').trim(), repo: String(item?.repo ?? '').trim() }))
      .filter(item => item.projectKey && item.repo)
  } catch {
    return []
  }
}

export const clampGithubPollMinutes = (value) => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.min(1440, Math.trunc(num)) : 0
}

export const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(value))
}

const int = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

// ── 运行时效（全局配置页「运行时效」卡）────────────────────────────────────
// 设置键沿用 settings 表的 snake_case；范围单位为分钟，与页面保存校验一致。
export const RUN_TIMEOUT_KEY = 'run_timeout_minutes'
export const STALL_WATCHDOG_KEY = 'stall_watchdog_minutes'
// 审批等待/提问转接超时（DSHBOTS-309）：分钟整数 [1,60]，默认 10 分钟（原 3 分钟，
// owner 2026-11-07 拍板上调）；空串/越界/非法回退默认，优先级与运行时效同款。
export const APPROVAL_TIMEOUT_KEY = 'approval_timeout_minutes'
export const QUESTION_TIMEOUT_KEY = 'question_timeout_minutes'
export const RUN_LIMIT_RANGES = {
  [RUN_TIMEOUT_KEY]: [1, 360],
  [STALL_WATCHDOG_KEY]: [0, 360],
  [APPROVAL_TIMEOUT_KEY]: [1, 60],
  [QUESTION_TIMEOUT_KEY]: [1, 60],
}

// ── 验收滞留守门（DSHBOTS-194 / DSHBOTS-235）───────────────────────────────
// in_review 任务超阈值分钟无新评论且无关联 run 活动 = 验收滞留；0 = 关闭守门。
export const REVIEW_IDLE_MINUTES_KEY = 'review_idle_minutes'
export const REVIEW_IDLE_MINUTES_RANGE = [0, 1440]
// 三档自动收口（DSHBOTS-235）：总开关（默认开，0 = 关闭自动 accept/return，只提醒）
// 与二次催办倍数（滞留超 阈值×倍数 升级语气再催一次，默认 2）。
export const REVIEW_AUTO_CLOSE_KEY = 'review_auto_close'
export const REVIEW_ESCALATE_KEY = 'review_idle_escalate_multiple'
export const REVIEW_ESCALATE_RANGE = [2, 10]

// ── 会话结转与闲时压缩（DSHBOTS-145 / DSHBOTS-286）─────────────────────────
// 同一绑定会话累计运行轮数超过阈值后结转：先排一次 bot 自写交接摘要，摘要就绪后
// 旧绑定 alias 化并开新会话，摘要注入新会话首条对话提示词。0 = 关闭（阈值不生效）。
// 结转阈值默认 512（DSHBOTS-286 由 256 上调）；alias 会话不重复结转。
export const SESSION_ROLLOVER_TURNS_KEY = 'session_rollover_turns'
export const SESSION_ROLLOVER_TURNS_RANGE = [0, 10_000]

// 每 N 轮闲时总结压缩（DSHBOTS-286）：轮次口径与结转一致（runs 按 session_id
// COUNT(*)）；跨越 N 的倍数且会话闲时入队 kind='session_compact' 总结运行，
// 忙时推后、跨窗口合批。压缩 ≠ 结转（留原会话）。0 = 关闭。
export const SESSION_COMPACT_TURNS_KEY = 'session_compact_turns'
export const SESSION_COMPACT_TURNS_RANGE = [0, 10_000]

// 单轮上下文治理 P2：上下文体积判据（token）。会话当前规模 = 该会话最近一次模型调用的
// input+cache_read（usage_events 按调用记账、runs.session_id 归属）。压缩在「跨过 N 轮
// 窗口」之外还要求达到下限（瘦会话不压缩，省一次只读轮）；结转在轮数阈值之外、体积达
// 上限也触发（胖会话不用等到 512 轮）。0 = 关闭体积判据（回到纯轮次口径）。生效链与
// 轮次键一致（env 显式 > settings 表保存值 > 默认，设置页暂未开放）。
export const SESSION_COMPACT_CTX_TOKENS_KEY = 'session_compact_ctx_tokens'
export const SESSION_COMPACT_CTX_TOKENS_RANGE = [0, 10_000_000]
export const SESSION_ROLLOVER_CTX_TOKENS_KEY = 'session_rollover_ctx_tokens'
export const SESSION_ROLLOVER_CTX_TOKENS_RANGE = [0, 10_000_000]

// 保存值必须是范围内的整数；非法或越界按未保存处理（回退默认），不做钳制。
// 空串/null（未保存）必须先于数值化判空：Number('') 是 0，会把「未保存」误判成
// 合法值 0（关闭）。用 Number() 而非 parseInt：parseInt('1.5') 会吞小数当 1。
const savedInt = (value, range) => {
  const raw = String(value ?? '').trim()
  if (raw === '') return null
  const [min, max] = range
  const num = Number(raw)
  return Number.isInteger(num) && num >= min && num <= max ? num : null
}

const envExplicit = (name) => {
  const raw = process.env[name]
  return raw !== undefined && String(raw).trim() !== ''
}

// 代码卫生（DSHBOTS-172）：扫描扩展名白名单覆盖。逗号/空格/分号分隔（如 "js,ts,lua"），
// 数组注入（测试）同样接受；空 = 用 services/hygiene.js 的默认白名单。行数上限是项目级
// 设置（projects.code_hygiene_limit_lines），不经全局配置。
const parseExtList = (value) => {
  if (Array.isArray(value)) return value.map(ext => String(ext ?? '').trim()).filter(Boolean)
  const raw = String(value ?? '').trim()
  if (!raw) return []
  return raw.split(/[\s,;]+/).map(ext => ext.trim()).filter(Boolean)
}

// 运行时效生效值：env 显式设置 > 页面保存值 > 默认。config 值在 resolveConfig
// 里已含 env/注入解析结果，env 显式时直接采用；run*Env/stall*Env 标志供 UI 提示
// 「环境变量已覆盖」。消费点（runtime 运行启动、service.reapStalledRuns）每次
// 现算，新值对之后启动的运行生效，进行中不追溯。
export function effectiveRunLimits(config, getSetting: (key: string) => unknown = () => null) {
  const runEnv = envExplicit('DSH_TEAM_RUN_TIMEOUT_MS')
  const stallEnv = envExplicit('DSH_TEAM_STALL_TIMEOUT_MS')
  const runSaved = savedInt(getSetting(RUN_TIMEOUT_KEY), RUN_LIMIT_RANGES[RUN_TIMEOUT_KEY])
  const stallSaved = savedInt(getSetting(STALL_WATCHDOG_KEY), RUN_LIMIT_RANGES[STALL_WATCHDOG_KEY])
  return {
    runTimeoutMs: !runEnv && runSaved !== null ? runSaved * 60_000 : config.runTimeoutMs,
    stallTimeoutMs: !stallEnv && stallSaved !== null ? stallSaved * 60_000 : config.stallTimeoutMs,
    runTimeoutEnv: runEnv,
    stallTimeoutEnv: stallEnv,
  }
}

// 审批/提问等待生效值（DSHBOTS-309）：优先级与 effectiveRunLimits 同款——env 显式
//（resolveConfig 已烘进 config.*TimeoutMs）> settings 保存分钟数 > 默认 300_000。
// 消费点（approvals/questions 落库 expires_at 时）每次现算，改值对新条目生效。
export function effectiveApprovalTimeoutMs(config, getSetting: (key: string) => unknown = () => null) {
  const env = envExplicit('DSH_TEAM_APPROVAL_TIMEOUT_MS')
  const saved = savedInt(getSetting(APPROVAL_TIMEOUT_KEY), RUN_LIMIT_RANGES[APPROVAL_TIMEOUT_KEY])
  return !env && saved !== null ? saved * 60_000 : config.approvalTimeoutMs
}

export function effectiveQuestionTimeoutMs(config, getSetting: (key: string) => unknown = () => null) {
  const env = envExplicit('DSH_TEAM_QUESTION_TIMEOUT_MS')
  const saved = savedInt(getSetting(QUESTION_TIMEOUT_KEY), RUN_LIMIT_RANGES[QUESTION_TIMEOUT_KEY])
  return !env && saved !== null ? saved * 60_000 : config.questionTimeoutMs
}

// ── 任务卡缺省时间预算（DSHBOTS-198）────────────────────────────────────────
// 产品规则：每张任务卡必有预算。缺省链 = env 显式 > 无进展看门狗（分钟）生效值 >
// 兜底 20（看门狗未配置与配 0 关闭同值，预算不得变 0/无限）。消费点（createTask
// 建档、assignTask 给存量 NULL 卡补挂）每次现算，改值对之后建档/派发的卡生效。
export const TASK_TIME_BUDGET_FALLBACK_MINUTES = 20
export function effectiveTaskTimeBudgetMinutes(config, getSetting: (key: string) => unknown = () => null) {
  const env = envExplicit('DSH_TEAM_TASK_TIME_BUDGET_MINUTES')
  const stallMinutes = Math.round(effectiveRunLimits(config, getSetting).stallTimeoutMs / 60_000)
  return !env && stallMinutes > 0 ? stallMinutes : config.taskTimeBudgetMinutes
}

// 派单预算优先级分档（DSHBOTS-325）：派单路径（assignFromBot 建卡/重派）漏传
// time_budget_minutes 时的卡级兜底档，按卡 priority 分档落库；显式值永远优先。
// 与全局缺省链（effectiveTaskTimeBudgetMinutes）分工：本表只管派单路径，不经派单
// 的直建卡仍走全局链。无效 priority 与 createTask 同口径回退 medium 档。
export const PRIORITY_BUDGET_MINUTES: Record<string, number> = {
  urgent: 45, high: 45, medium: 30, low: 15, none: 15,
}

// 会话结转阈值生效值（DSHBOTS-145）：优先级与运行时效一致——env 显式 > settings 表
// 保存值 > 默认 512（设置页暂未开放该字段）；0 = 关闭。消费点（runtime 会话复用检查，
// DSHBOTS-289 起为 ensureBotBinding 复用分支）每次现算，改值对下一次会话复用生效。
export function effectiveSessionRolloverTurns(config, getSetting: (key: string) => unknown = () => null) {
  const env = envExplicit('DSH_TEAM_SESSION_ROLLOVER_TURNS')
  const saved = savedInt(getSetting(SESSION_ROLLOVER_TURNS_KEY), SESSION_ROLLOVER_TURNS_RANGE)
  return !env && saved !== null ? saved : config.sessionRolloverTurns
}

// 闲时压缩窗口生效值（DSHBOTS-286）：优先级与结转一致——env 显式 > settings 表保存值 >
// 默认 64（设置页暂未开放该字段）；0 = 关闭。消费点（runtime 会话复用检查）每次现算。
export function effectiveSessionCompactTurns(config, getSetting: (key: string) => unknown = () => null) {
  const env = envExplicit('DSH_TEAM_SESSION_COMPACT_TURNS')
  const saved = savedInt(getSetting(SESSION_COMPACT_TURNS_KEY), SESSION_COMPACT_TURNS_RANGE)
  return !env && saved !== null ? saved : config.sessionCompactTurns
}

// 压缩体积下限生效值（单轮上下文治理 P2）：默认 80,000 token，0 = 关闭体积判据。
export function effectiveSessionCompactCtxTokens(config, getSetting: (key: string) => unknown = () => null) {
  const env = envExplicit('DSH_TEAM_SESSION_COMPACT_CTX_TOKENS')
  const saved = savedInt(getSetting(SESSION_COMPACT_CTX_TOKENS_KEY), SESSION_COMPACT_CTX_TOKENS_RANGE)
  return !env && saved !== null ? saved : config.sessionCompactCtxTokens
}

// 结转体积上限生效值（单轮上下文治理 P2）：默认 150,000 token，0 = 关闭体积判据。
export function effectiveSessionRolloverCtxTokens(config, getSetting: (key: string) => unknown = () => null) {
  const env = envExplicit('DSH_TEAM_SESSION_ROLLOVER_CTX_TOKENS')
  const saved = savedInt(getSetting(SESSION_ROLLOVER_CTX_TOKENS_KEY), SESSION_ROLLOVER_CTX_TOKENS_RANGE)
  return !env && saved !== null ? saved : config.sessionRolloverCtxTokens
}

// 验收滞留阈值生效值（DSHBOTS-194）：优先级与会话结转一致——env 显式 > 保存值 >
// 默认 30 分钟；0 = 关闭。消费点（scheduler 验收守门、runLimitsView 透出）每次
// 现算，改值对下一轮扫描生效；env 标志供 UI 提示「环境变量已覆盖」。
export function effectiveReviewIdleMinutes(config, getSetting: (key: string) => unknown = () => null) {
  const env = envExplicit('DSH_TEAM_REVIEW_IDLE_MINUTES')
  const saved = savedInt(getSetting(REVIEW_IDLE_MINUTES_KEY), REVIEW_IDLE_MINUTES_RANGE)
  return {
    minutes: !env && saved !== null ? saved : config.reviewIdleMinutes,
    env,
  }
}

// 结转摘要的 settings 键（DSHBOTS-145）：按「bot + 上下文」隔离——同一 bot 的项目会话与
// 单聊会话各自独立结转，互不串档；单聊（无项目）用 'solo' 占位。
export const rolloverSummaryKey = (botId, projectId) => `rollover_summary:${botId}:${projectId ?? 'solo'}`

// 结转摘要的待注入目标会话键（DSHBOTS-213）：结转开新会话时记录新会话 id，摘要只允许被
// 该目标会话的提示词消费，防止被其他会话的普通轮次提前清零。
export const rolloverPendingKey = (botId, projectId) => `rollover_pending:${botId}:${projectId ?? 'solo'}`

// 闲时压缩的窗口标记键（DSHBOTS-286）：按会话隔离，值 = 已被压缩运行覆盖到的轮数
// （窗口下界）。忙时推后依赖「标记不动」，闲时跨越窗口才入队并推进标记。
export const sessionCompactMarkerKey = (sessionId) => `session_compact_marker:${sessionId}`

// ── UI 语言（DSHBOTS-162）─────────────────────────────────────────────────
// 全局配置页语言下拉：auto = 跟随 DSH 宿主设定（缺省），zh/en = 显式覆盖。
// env DSH_TEAM_UI_LANGUAGE 可覆盖页面保存值（不强制）。
export const UI_LANGUAGE_KEY = 'ui_language'
export const UI_LANGUAGE_VALUES = ['auto', 'zh', 'en']

// 收敛到合法取值；非法/空一律回 'auto'（= 跟随宿主）。
const normalizeUiLanguage = (value) => {
  const raw = String(value ?? '').trim().toLowerCase()
  return UI_LANGUAGE_VALUES.includes(raw) ? raw : 'auto'
}

// 保存值必须是合法取值；非法/空按未保存处理（回退默认），不做钳制。
const savedUiLanguage = (value) => {
  const raw = String(value ?? '').trim().toLowerCase()
  return UI_LANGUAGE_VALUES.includes(raw) ? raw : null
}

// UI 语言生效值：env 显式合法值 > 页面保存值 > 默认。'auto' 语义 = 跟随 DSH 宿主，
// 交 resolveDshUiLanguage 三级兜底（loader → patch 文件 → navigator）。
export function effectiveUiLanguage(config, getSetting: (key: string) => unknown = () => null) {
  const envRaw = String(process.env.DSH_TEAM_UI_LANGUAGE ?? '').trim().toLowerCase()
  const envValue = UI_LANGUAGE_VALUES.includes(envRaw) ? envRaw : null
  const saved = savedUiLanguage(getSetting(UI_LANGUAGE_KEY))
  return envValue ?? saved ?? config.uiLanguage
}

// ── 微信通道开关生效值（DSHBOTS-334）────────────────────────────────────────
// 通道页启停开关的 settings 键：'1'/'0' 为显式覆盖；未保存（空）回退服务端
// 注入默认（cordis.patch.yml / env，保留为初始默认）。消费点：core 挂载决策与
// services/wechat 的即时 mount/unmount（applyWechatChannelEnabled）。
export const WECHAT_CHANNEL_ENABLED_KEY = 'wechat_channel_enabled'
export function effectiveWechatEnabled(config, getSetting: (key: string) => unknown = () => null) {
  const saved = String(getSetting(WECHAT_CHANNEL_ENABLED_KEY) ?? '').trim()
  if (saved === '1') return true
  if (saved === '0') return false
  return Boolean(config.wechat?.enabled)
}

// ── 飞书凭据生效值（DSHBOTS-334）────────────────────────────────────────────
// 优先级：通道页保存（secrets 表加密的 AppID/Secret 对）> 服务端注入
// （cordis.patch.yml / env，即 config.feishu）。凭据成对生效：保存对不完整
// 不得与注入对混拼；两边都没有 = 不生效（通道保持 unbound 不连）。
// savedGetter 由 services/feishu.ts 提供（读 SecretBox 解密后的两键）。
export function effectiveFeishuCredentials(config, savedGetter: () => { appId?: unknown; appSecret?: unknown } | null = () => null) {
  const savedAppId = String(savedGetter()?.appId ?? '').trim()
  const savedSecret = String(savedGetter()?.appSecret ?? '').trim()
  if (savedAppId && savedSecret) {
    return { appId: savedAppId, appSecret: savedSecret, source: 'saved' as const }
  }
  const configAppId = String(config.feishu?.appId ?? '').trim()
  const configSecret = String(config.feishu?.appSecret ?? '').trim()
  if (configAppId && configSecret) {
    return { appId: configAppId, appSecret: configSecret, source: 'config' as const }
  }
  return { appId: '', appSecret: '', source: 'none' as const }
}

export function resolveConfig(config: Partial<TeamConfig> = {}) {
  const dshHome = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  const workspace = resolve(config.workspace || defaultWorkspace())
  const dataDir = resolve(
    config.dataDir
      || process.env.DSH_TEAM_DATA?.trim()
      || join(workspace, '.data'),
  )
  return {
    dshHome,
    workspace,
    dataDir,
    dbPath: join(dataDir, 'team.sqlite'),
    wechatDbPath: join(dataDir, 'wechat-channel.sqlite'),
    feishuDbPath: join(dataDir, 'feishu-channel.sqlite'),
    // 密钥主文件：备份必须连它一起带走，缺了既有密文就再也解不开。
    secretKeyPath: join(dataDir, 'secret.key'),
    // 个人微信通道（腾讯 iLink 官方协议）：默认关闭，扫码授权后生效。
    wechat: {
      enabled: bool(config.wechatEnabled ?? process.env.DSH_TEAM_WECHAT, false),
    },
    // 飞书机器人通道（DSHBOTS-333）：默认关闭，DSH_BOTS_FEISHU=1 开启。
    // 传输层为进程内官方 SDK（@larksuiteoapi/node-sdk）：凭据 AppID/Secret 注入即连。
    // 这里只是「服务端注入」兜底来源（cordis.patch.yml / env）；生效优先级见
    // effectiveFeishuCredentials（DSHBOTS-334：通道页保存的凭据优先）。
    feishu: {
      enabled: bool(config.feishuEnabled ?? process.env.DSH_BOTS_FEISHU, false),
      appId: String(config.feishuAppId ?? process.env.DSH_BOTS_FEISHU_APP_ID ?? '').trim(),
      appSecret: String(config.feishuAppSecret ?? process.env.DSH_BOTS_FEISHU_APP_SECRET ?? '').trim(),
    },
    memoryDir: join(dataDir, 'memory'),
    messageDir: join(dataDir, 'messages'),
    // 共享技能池固定在本机 ~/.agents，与用户其他 agent 工具共用同一目录；测试可注入临时目录。
    skillRoot: resolve(config.skillRoot?.trim() || join(homedir(), '.agents')),
    // 并行的安全边界由写范围闸门保证（同项目写运行只在双方声明且路径不相交时才并行），
    // 这里的总数上限只防主机过载；读运行（chat/dm）与写运行共用一个池子，给到 6 才不至于让
    // 一两条对话运行把写任务的并发位吃干。
    maxConcurrentRuns: int(config.maxConcurrentRuns ?? process.env.DSH_TEAM_MAX_RUNS, 6, 1, 16),
    runTimeoutMs: int(config.runTimeoutMs ?? process.env.DSH_TEAM_RUN_TIMEOUT_MS, 60 * 60_000, 30_000, 6 * 60 * 60_000),
    // 0 关闭：单次运行的 token 上限，超出即中止，避免一个运行吃掉整月预算。
    maxRunTokens: int(config.maxRunTokens ?? process.env.DSH_TEAM_MAX_RUN_TOKENS, 0, 0, 500_000_000),
    // 0 关闭：运行多久没有任何事件就判定卡住。
    stallTimeoutMs: int(config.stallTimeoutMs ?? process.env.DSH_TEAM_STALL_TIMEOUT_MS, 20 * 60_000, 0, 6 * 60 * 60_000),
    // 任务卡缺省时间预算（DSHBOTS-198）：env 解析结果或兜底 20；生效缺省链见
    // effectiveTaskTimeBudgetMinutes（env > 看门狗生效值 > 本兜底）。
    taskTimeBudgetMinutes: int(
      config.taskTimeBudgetMinutes ?? process.env.DSH_TEAM_TASK_TIME_BUDGET_MINUTES,
      TASK_TIME_BUDGET_FALLBACK_MINUTES, 1, 10_080,
    ),
    // 会话结转阈值（DSHBOTS-145）：0 = 关闭；「轮次」口径 = runs 表按 session_id 的
    // COUNT(*)（不限 status——失败运行的提示词同样已进会话历史，count-all 才与真实
    // 增长一致）。生效值可被 settings 表 session_rollover_turns 覆盖（env 显式 > 表值 > 默认，
    // 设置页暂未开放该字段，见 effectiveSessionRolloverTurns）。
    sessionRolloverTurns: int(config.sessionRolloverTurns ?? process.env.DSH_TEAM_SESSION_ROLLOVER_TURNS, 512, 0, 10_000),
    // 闲时总结压缩窗口（DSHBOTS-286）：默认每 64 轮，0 = 关闭；生效值见
    // effectiveSessionCompactTurns（env 显式 > settings 表保存值 > 默认，设置页暂未开放）。
    sessionCompactTurns: int(config.sessionCompactTurns ?? process.env.DSH_TEAM_SESSION_COMPACT_TURNS, 64, 0, 10_000),
    // 上下文体积判据（单轮上下文治理 P2）：压缩下限默认 80k、结转上限默认 150k token，
    // 0 = 关闭体积判据；生效值见 effectiveSession{Compact,Rollover}CtxTokens。
    sessionCompactCtxTokens: int(config.sessionCompactCtxTokens ?? process.env.DSH_TEAM_SESSION_COMPACT_CTX_TOKENS, 80_000, 0, 10_000_000),
    sessionRolloverCtxTokens: int(config.sessionRolloverCtxTokens ?? process.env.DSH_TEAM_SESSION_ROLLOVER_CTX_TOKENS, 150_000, 0, 10_000_000),
    // 验收滞留守门（DSHBOTS-194）：in_review 卡静置超此分钟数 = 滞留。生效值可被
    // 全局设置 review_idle_minutes 覆盖（effectiveReviewIdleMinutes），0 = 关闭。
    reviewIdleMinutes: int(config.reviewIdleMinutes ?? process.env.DSH_TEAM_REVIEW_IDLE_MINUTES, 30, 0, 1440),
    // UI 语言（DSHBOTS-162）：auto = 跟随 DSH 宿主（缺省），zh/en = 显式覆盖。
    // 生效值由全局配置页 ui_language 覆盖，解析见 effectiveUiLanguage。
    uiLanguage: normalizeUiLanguage(config.uiLanguage ?? process.env.DSH_TEAM_UI_LANGUAGE ?? 'auto'),
    // 群聊只放结论，完整交付进任务评论。
    chatReplyMaxChars: int(config.chatReplyMaxChars ?? process.env.DSH_TEAM_CHAT_MAX_CHARS, 800, 80, 8_000),
    // 私信自动归档（DSHBOTS-171）：单聊默认视图只留「每 bot 最近 keep 条 且 days 天内」的
    // 交集，超出任一阈值即归档（默认视图隐去，数据保留，messagesPage 翻页仍可查回）。
    // 0 = 关闭该维过滤。
    dmArchiveDays: int(config.dmArchiveDays ?? process.env.DSH_TEAM_DM_ARCHIVE_DAYS, 7, 0, 3650),
    dmKeepRecent: int(config.dmKeepRecent ?? process.env.DSH_TEAM_DM_KEEP_RECENT, 100, 0, 10_000),
    // 宿主审批请求在群聊条目上的等待时长：到时向宿主回 rejected、条目置 timeout。
    // 默认 5 分钟（DSHBOTS-313 终调：3→10（D-309）→5），settings approval_timeout_minutes 可调。
    approvalTimeoutMs: int(config.approvalTimeoutMs ?? process.env.DSH_TEAM_APPROVAL_TIMEOUT_MS, 300_000, 5_000, 3_600_000),
    // 提问转接超时（DSHBOTS-116）：与审批同默认 5 分钟（DSHBOTS-313 同步终调），最短 5s、最长 1 小时。
    questionTimeoutMs: int(config.questionTimeoutMs ?? process.env.DSH_TEAM_QUESTION_TIMEOUT_MS, 300_000, 5_000, 3_600_000),
    // 一次性密钥运行时文件（<dataDir>/secrets-runtime/<projectId>.env）的存活窗口：
    // 批准后生成，项目下一条 task 运行结束或窗口到期先到即焚，再次使用需重新批准。
    secretsRuntimeTtlMs: int(config.secretsRuntimeTtlMs ?? process.env.DSH_TEAM_SECRETS_TTL_MS, 30 * 60_000, 1_000, 24 * 60 * 60_000),
    // 大 PNG 入库/上传前转 JPEG 的体积阈值（字节，0 关闭）：PNG 大图 base64 体积大、上传慢、
    // 部分模型处理效率低；超过阈值先转 JPEG（质量 85、最长边 2048）再落库与传模型。
    // gif/webp 语义保留不转；无解码能力（sharp）或转码失败一律回退原图，不阻塞发送。
    imagePngJpegThresholdBytes: int(
      config.imagePngJpegThresholdBytes ?? process.env.DSH_TEAM_IMAGE_PNG_JPEG_THRESHOLD_BYTES,
      512 * 1024, 0, 5 * 1024 * 1024,
    ),
    // 原生 Agent Teams 由 profile 层提供；这里只控制提示词与调度侧的启用状态。
    // 缺省开启（DSHBOTS-230）：默认部署即注入并行拆分引导；显式传 0/false 可关闭。
    // GitHub 只读触发源（B4-②/DSHBOTS-335）：env JSON 清单 [{projectKey, repo}]，
    // 缺省空 + 轮询 0 分钟 = 全关；非法 JSON 降级空清单（fail-closed）。
    githubWatch: parseGithubWatchEnv(config.githubWatch ?? process.env.DSH_TEAM_GITHUB_WATCH),
    githubPollMinutes: clampGithubPollMinutes(config.githubPollMinutes ?? process.env.DSH_TEAM_GITHUB_POLL_MINUTES),
    agentTeam: bool(config.agentTeam ?? process.env.DSH_TEAM_AGENT_TEAM, true),
    maxTeammates: int(config.maxTeammates ?? process.env.DSH_TEAM_MAX_TEAMMATES, 3, 1, 8),
    // 会话使用的 agent preset：Router 会话不带写工具时，在这里指向一个受限 preset。
    routerPreset: String(config.routerPreset ?? process.env.DSH_TEAM_ROUTER_PRESET ?? '').trim(),
    workerPreset: String(config.workerPreset ?? process.env.DSH_TEAM_WORKER_PRESET ?? '').trim(),
    // 读图代理（DSHBOTS-112）：Bot 主模型无视觉能力收图时，自动派生 kind='vision' 只读
    // 转写运行所用的代理模型（provider/model）。两个都非空才启用；任一为空 = 不启用，
    // 此时按现状直接报「模型不支持图片」，不做任何派生。
    visionProxyProvider: String(config.visionProxyProvider ?? process.env.DSH_TEAM_VISION_PROXY_PROVIDER ?? '').trim(),
    visionProxyModel: String(config.visionProxyModel ?? process.env.DSH_TEAM_VISION_PROXY_MODEL ?? '').trim(),
    // 记忆审查专用模型（可选）：memory_review 派生运行改用的小模型（provider/model），
    // 两个都非空才启用；任一为空 = 沿用 Bot 主模型。审查提示词自包含且只产 JSON
    // 数组，不挑模型能力，配便宜模型可再压审查成本。
    memoryReviewProvider: String(config.memoryReviewProvider ?? process.env.DSH_TEAM_MEMORY_REVIEW_PROVIDER ?? '').trim(),
    memoryReviewModel: String(config.memoryReviewModel ?? process.env.DSH_TEAM_MEMORY_REVIEW_MODEL ?? '').trim(),
    // 验收自动委派（DSHBOTS-113）：任务交付迁移 in_review 时自动派生子代理核验运行
    // （与手动「子代理核验」按钮同一入口）。总监裁决不受影响：owner_bot 卡在核验运行
    // 结束后再触发总监验收；user 卡核验结论写回评论，裁决仍归工作台 owner。
    autoReviewDelegate: bool(config.autoReviewDelegate ?? process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE, true),
    // 代码卫生（DSHBOTS-172）：扫描扩展名白名单覆盖（默认白名单见 services/hygiene.js）。
    codeHygieneExts: parseExtList(config.codeHygieneExts ?? process.env.DSH_TEAM_CODE_HYGIENE_EXTS),
    schedulerIntervalMs: int(config.schedulerIntervalMs, 1_500, 250, 30_000),
    modelCacheMs: int(config.modelCacheMs, 8_000, 0, 120_000),
    // 用量快照缓存：state() 每轮轮询都跑 30d 全口径聚合（生产库实测约 500ms），
    // 这里做 TTL 缓存把 state() 拉回几十毫秒。0 = 关闭缓存（每次重算）。
    // 用量页默认最多滞后 30s；明细 / 对账 / 价目写回会立即失效缓存。
    usageSnapshotCacheMs: int(config.usageSnapshotCacheMs ?? process.env.DSH_TEAM_USAGE_SNAPSHOT_CACHE_MS, 30_000, 0, 300_000),
    // 模型目录 stale-while-revalidate：stale 但在该窗口内立即返回旧值并后台刷新，
    // 避免 catalog 过期时逐 provider 串行 listModels 阻塞 state()。0 = 关闭 SWR（回到旧语义）。
    catalogStaleMs: int(config.catalogStaleMs ?? process.env.DSH_TEAM_CATALOG_STALE_MS, 300_000, 0, 3_600_000),
    // 终端命令硬超时：默认 120s；测试可注入更短值（下限 500ms）。
    terminalTimeoutMs: int(config.terminalTimeoutMs, 120_000, 500, 600_000),
    seedOwnerName: String(config.seedOwnerName ?? SEED_OWNER.name).slice(0, 40),
    seedOwnerRole: String(config.seedOwnerRole ?? SEED_OWNER.role).slice(0, 24),
    seedOwnerInstructions: String(config.seedOwnerInstructions ?? SEED_OWNER.instructions),
    // 首次启动时随总监一起出场的默认伙伴；传 [] 可禁用。
    seedBots: Array.isArray(config.seedBots) ? config.seedBots : SEED_BOTS,
    allowDevSeed: bool(config.allowDevSeed ?? process.env.DSH_TEAM_DEV_SEED, false),
    modelPrices: resolveModelPrices(config),
  }
}
