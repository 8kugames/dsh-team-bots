import { format } from 'node:util'
import { resolveConfig } from './src/config.js'
import { openDatabase } from './src/db.js'
import { installHttp } from './src/http.js'
import { DshRuntime } from './src/runtime.js'
import { TeamService } from './src/service.js'
import { installSkillProvider } from './src/skills.js'
import { installSubagentLedger } from './src/subagent-ledger.js'
import { installTeamTools } from './src/tools.js'

export const name = 'dsh-team-bots'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessionTitle', 'connection', 'webServer']

// 前缀并入首参格式串后再交给 console.*：Node 只格式化首参，'[dsh-team]' 独占首参时
// 后续参数里的 %s/%d 永不插值（owner 看到的字面 %s 即此缺陷）。
export function createLogger() {
  const prefixed = write => (...args) => write(`[dsh-team] ${format(...args)}`)
  return {
    info: prefixed(console.log),
    warn: prefixed(console.warn),
    error: prefixed(console.error),
  }
}

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const logger = createLogger()
  const store = openDatabase(resolved.dbPath)
  const service = new TeamService({ store, config: resolved, logger })
  // 聊天分库：运行时按运行归属路由正文读写到对应聊天库；
  // 注入解析器而非库本身，懒打开与 LRU 都收敛在 service 侧。
  const runtime = new DshRuntime({ ctx, config: resolved, store, logger, chatStores: { forRun: (run: any) => (service as any).runChatStore(run) } })
  service.attachRuntime(runtime)
  runtime.attach()
  installTeamTools(ctx, service)
  // 账本事件住运行归属聊天库，与 DshRuntime 同款路由器。
  installSubagentLedger(ctx, store, logger, { forRun: (run: any) => (service as any).runChatStore(run) })
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
