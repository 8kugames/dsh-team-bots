// 共享测试骨架：mkdtemp 工作区 + resolveConfig + 内存级 SQLite + TeamService 挂桩并启动。
// 只服务与该骨架逐字同构的 setup；有额外种子/目录/配置差异的测试仍各自展开。
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/db.js'
import { resolveConfig } from '../../src/config.js'
import { TeamService } from '../../src/service.js'

export async function setupTeam(opts: {
  prefix: string
  schedulerIntervalMs: number
  runtime?: object
}) {
  const root = await mkdtemp(join(tmpdir(), opts.prefix))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir,
    skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0,
    schedulerIntervalMs: opts.schedulerIntervalMs,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(opts.runtime ?? new (await import('./runtime-stub.js')).StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}
