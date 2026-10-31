import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveModelPrices } from './pricing.js'

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
  const workspace = resolve(
    config.workspace
      || process.env.DSH_TEAM_WORKSPACE?.trim()
      || '/workspace',
  )
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
    memoryDir: join(dataDir, 'memory'),
    messageDir: join(dataDir, 'messages'),
    skillRoot: join(workspace, '.agents'),
    maxConcurrentRuns: int(config.maxConcurrentRuns ?? process.env.DSH_TEAM_MAX_RUNS, 3, 1, 16),
    runTimeoutMs: int(config.runTimeoutMs ?? process.env.DSH_TEAM_RUN_TIMEOUT_MS, 15 * 60_000, 30_000, 6 * 60 * 60_000),
    schedulerIntervalMs: int(config.schedulerIntervalMs, 1_500, 250, 30_000),
    modelCacheMs: int(config.modelCacheMs, 8_000, 0, 120_000),
    seedOwnerName: String(config.seedOwnerName ?? 'Chief').slice(0, 40),
    seedOwnerRole: String(config.seedOwnerRole ?? '负责人').slice(0, 24),
    seedOwnerInstructions: String(config.seedOwnerInstructions
      ?? '你是团队的负责人。你负责理解目标、拆分工作、通过任务面板分配任务，并汇总团队结果。不要代替其他 Bot 执行已分配的任务。'),
    allowDevSeed: bool(config.allowDevSeed ?? process.env.DSH_TEAM_DEV_SEED, false),
    modelPrices: resolveModelPrices(config),
  }
}
