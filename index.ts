import { resolveConfig } from './src/config.js'
import { openDatabase } from './src/db.js'
import { installHttp } from './src/http.js'
import { DshRuntime } from './src/runtime.js'
import { TeamService } from './src/service.js'
import { installSkillProvider } from './src/skills.js'
import { installTeamTools } from './src/tools.js'

export const name = 'dsh-team-bots'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessionTitle', 'connection', 'webServer']

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const logger = {
    info: (...args) => console.log('[dsh-team]', ...args),
    warn: (...args) => console.warn('[dsh-team]', ...args),
    error: (...args) => console.error('[dsh-team]', ...args),
  }
  const store = openDatabase(resolved.dbPath)
  const service = new TeamService({ store, config: resolved, logger })
  const runtime = new DshRuntime({ ctx, config: resolved, store, logger })
  service.attachRuntime(runtime)
  runtime.attach()
  installTeamTools(ctx, service)
  installSkillProvider(ctx, resolved, logger, store)
  installHttp(ctx, service, logger)

  ctx.effect?.(() => () => {
    service.stop()
    store.close()
  }, 'dsh-team: shutdown')

  const boot = service.initialize().then(() => {
    service.start()
    logger.info('ready: workspace=%s data=%s', resolved.workspace, resolved.dataDir)
  }).catch(error => {
    logger.error('startup failed: %s', error?.stack ?? error)
  })
  service.boot = boot
  return { service, runtime, store }
}
