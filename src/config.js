import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveModelPrices } from './pricing.js'
import { SEED_BOTS, SEED_OWNER } from './seed-bots.js'

export function defaultWorkspace() {
  const configured = process.env.DSH_TEAM_WORKSPACE?.trim()
  if (configured) return resolve(configured)
  return join(homedir(), '.dsh', 'workspace', 'team-bots')
}

const bool = (value, fallback = false) => {
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
export const RUN_LIMIT_RANGES = {
  [RUN_TIMEOUT_KEY]: [1, 360],
  [STALL_WATCHDOG_KEY]: [0, 360],
}

// 保存值必须是范围内的整数分钟；非法或越界按未保存处理（回退默认），不做钳制。
// 空串/null（未保存）必须先于数值化判空：Number('') 是 0，会把「未保存」误判成
// 看门狗合法值 0（关闭）。用 Number() 而非 parseInt：parseInt('1.5') 会吞小数当 1。
const savedMinutes = (value, range) => {
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

// 运行时效生效值：env 显式设置 > 页面保存值 > 默认。config 值在 resolveConfig
// 里已含 env/注入解析结果，env 显式时直接采用；run*Env/stall*Env 标志供 UI 提示
// 「环境变量已覆盖」。消费点（runtime 运行启动、service.reapStalledRuns）每次
// 现算，新值对之后启动的运行生效，进行中不追溯。
export function effectiveRunLimits(config, getSetting = () => null) {
  const runEnv = envExplicit('DSH_TEAM_RUN_TIMEOUT_MS')
  const stallEnv = envExplicit('DSH_TEAM_STALL_TIMEOUT_MS')
  const runSaved = savedMinutes(getSetting(RUN_TIMEOUT_KEY), RUN_LIMIT_RANGES[RUN_TIMEOUT_KEY])
  const stallSaved = savedMinutes(getSetting(STALL_WATCHDOG_KEY), RUN_LIMIT_RANGES[STALL_WATCHDOG_KEY])
  return {
    runTimeoutMs: !runEnv && runSaved !== null ? runSaved * 60_000 : config.runTimeoutMs,
    stallTimeoutMs: !stallEnv && stallSaved !== null ? stallSaved * 60_000 : config.stallTimeoutMs,
    runTimeoutEnv: runEnv,
    stallTimeoutEnv: stallEnv,
  }
}

export function resolveConfig(config = {}) {
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
    // 密钥主文件：备份必须连它一起带走，缺了既有密文就再也解不开。
    secretKeyPath: join(dataDir, 'secret.key'),
    // 个人微信通道（腾讯 iLink 官方协议）：默认关闭，扫码授权后生效。
    wechat: {
      enabled: bool(config.wechatEnabled ?? process.env.DSH_TEAM_WECHAT, false),
    },
    memoryDir: join(dataDir, 'memory'),
    messageDir: join(dataDir, 'messages'),
    // 共享技能池固定在本机 ~/.agents，与用户其他 agent 工具共用同一目录；测试可注入临时目录。
    skillRoot: resolve(config.skillRoot?.trim() || join(homedir(), '.agents')),
    // 并行的安全边界由写范围闸门保证（同项目写运行只在双方声明且路径不相交时才并行），
    // 这里的总数上限只防主机过载；读运行（chat/dm）与写运行共用一个池子，给到 6 才不至于让
    // 一两条对话运行把写任务的并发位吃干。
    maxConcurrentRuns: int(config.maxConcurrentRuns ?? process.env.DSH_TEAM_MAX_RUNS, 6, 1, 16),
    runTimeoutMs: int(config.runTimeoutMs ?? process.env.DSH_TEAM_RUN_TIMEOUT_MS, 120 * 60_000, 30_000, 6 * 60 * 60_000),
    // 0 关闭：单次运行的 token 上限，超出即中止，避免一个运行吃掉整月预算。
    maxRunTokens: int(config.maxRunTokens ?? process.env.DSH_TEAM_MAX_RUN_TOKENS, 0, 0, 500_000_000),
    // 0 关闭：运行多久没有任何事件就判定卡住。
    stallTimeoutMs: int(config.stallTimeoutMs ?? process.env.DSH_TEAM_STALL_TIMEOUT_MS, 30 * 60_000, 0, 6 * 60 * 60_000),
    // 群聊只放结论，完整交付进任务评论。
    chatReplyMaxChars: int(config.chatReplyMaxChars ?? process.env.DSH_TEAM_CHAT_MAX_CHARS, 800, 80, 8_000),
    // 原生 Agent Teams 由 profile 层提供；这里只控制提示词与调度侧的启用状态。
    agentTeam: bool(config.agentTeam ?? process.env.DSH_TEAM_AGENT_TEAM, false),
    maxTeammates: int(config.maxTeammates ?? process.env.DSH_TEAM_MAX_TEAMMATES, 3, 1, 8),
    // 会话使用的 agent preset：Router 会话不带写工具时，在这里指向一个受限 preset。
    routerPreset: String(config.routerPreset ?? process.env.DSH_TEAM_ROUTER_PRESET ?? '').trim(),
    workerPreset: String(config.workerPreset ?? process.env.DSH_TEAM_WORKER_PRESET ?? '').trim(),
    schedulerIntervalMs: int(config.schedulerIntervalMs, 1_500, 250, 30_000),
    modelCacheMs: int(config.modelCacheMs, 8_000, 0, 120_000),
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
