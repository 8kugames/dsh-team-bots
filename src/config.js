import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveModelPrices } from './pricing.js'
import { SEED_BOTS, SEED_OWNER } from './seed-bots.js'

// Inside the container this is always the bound project workspace. Outside a
// container it usually does not exist, and defaulting to it would create a
// directory at the filesystem root, so fall back to the user's own workspace.
const CONTAINER_WORKSPACE = '/workspace'

export function defaultWorkspace(isDirectory = path => {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}) {
  const configured = process.env.DSH_TEAM_WORKSPACE?.trim()
  if (configured) return resolve(configured)
  if (isDirectory(CONTAINER_WORKSPACE)) return CONTAINER_WORKSPACE
  return join(homedir(), 'workspace')
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
    skillRoot: join(workspace, '.agents'),
    maxConcurrentRuns: int(config.maxConcurrentRuns ?? process.env.DSH_TEAM_MAX_RUNS, 3, 1, 16),
    runTimeoutMs: int(config.runTimeoutMs ?? process.env.DSH_TEAM_RUN_TIMEOUT_MS, 15 * 60_000, 30_000, 6 * 60 * 60_000),
    // 0 关闭：单次运行的 token 上限，超出即中止，避免一个运行吃掉整月预算。
    maxRunTokens: int(config.maxRunTokens ?? process.env.DSH_TEAM_MAX_RUN_TOKENS, 0, 0, 500_000_000),
    // 0 关闭：运行多久没有任何事件就判定卡住。
    stallTimeoutMs: int(config.stallTimeoutMs ?? process.env.DSH_TEAM_STALL_TIMEOUT_MS, 10 * 60_000, 0, 6 * 60 * 60_000),
    // 群聊只放结论，完整交付进任务评论。
    chatReplyMaxChars: int(config.chatReplyMaxChars ?? process.env.DSH_TEAM_CHAT_MAX_CHARS, 800, 80, 8_000),
    // 官方 Agent Teams 由 profile 层提供；这里只控制提示词与调度侧的启用状态。
    agentTeam: bool(config.agentTeam ?? process.env.DSH_TEAM_AGENT_TEAM, false),
    maxTeammates: int(config.maxTeammates ?? process.env.DSH_TEAM_MAX_TEAMMATES, 3, 1, 8),
    // 会话使用的 agent preset：Router 会话不带写工具时，在这里指向一个受限 preset。
    routerPreset: String(config.routerPreset ?? process.env.DSH_TEAM_ROUTER_PRESET ?? '').trim(),
    workerPreset: String(config.workerPreset ?? process.env.DSH_TEAM_WORKER_PRESET ?? '').trim(),
    schedulerIntervalMs: int(config.schedulerIntervalMs, 1_500, 250, 30_000),
    modelCacheMs: int(config.modelCacheMs, 8_000, 0, 120_000),
    seedOwnerName: String(config.seedOwnerName ?? SEED_OWNER.name).slice(0, 40),
    seedOwnerRole: String(config.seedOwnerRole ?? SEED_OWNER.role).slice(0, 24),
    seedOwnerInstructions: String(config.seedOwnerInstructions ?? SEED_OWNER.instructions),
    // 首次启动时随负责人一起出场的默认伙伴；传 [] 可禁用。
    seedBots: Array.isArray(config.seedBots) ? config.seedBots : SEED_BOTS,
    allowDevSeed: bool(config.allowDevSeed ?? process.env.DSH_TEAM_DEV_SEED, false),
    modelPrices: resolveModelPrices(config),
  }
}
