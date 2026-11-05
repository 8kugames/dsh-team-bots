// src/services/workspace-groups.js —— bot 会话挂到 DSH 原生工作区分组
// 原生侧栏按 workspaceRegistry 的 sessionIds 归组，找不到就落「未分组」；
// 本模块负责把 bot 会话（新建即时挂载 + 启动时历史回填）挂到对应工作区。
// registry 是宿主可选服务（@deepseek-ai/dsh-workspace），取不到或挂载失败一律降级，
// 绝不阻断会话创建与运行。

import { botWorkspaceDir, ensureExternalDir, ensureProjectWorkspace } from '../paths.js'

// workspace-group:start —— 纯逻辑，供 tests/workspace-groups.test.js 直接 import

// 会话 cwd 推导：与 ensureSession 的派发口径一致——单聊落 bot 专属目录，
// 项目会话落生产目录（外部目录）或项目工作区。solo 时 project 可为 null，
// 因此属性访问必须在 solo 短路之后。
export async function resolveSessionCwd(config, { solo, bot, project }) {
  return solo
    ? await botWorkspaceDir(config.workspace, bot.solo_dir)
    : project.production_dir
      ? await ensureExternalDir(project.production_dir)
      : await ensureProjectWorkspace(config.workspace, project.slug)
}

// 分组标题口径：项目内会话（project/task/dm）统一归项目组，一个项目一组；
// 单聊 cwd 是 bot 专属目录，天然一个 bot 一组。
export function workspaceGroupTitle({ kind, project, bot }) {
  if (kind === 'solo') return `${bot.name} · 单聊`
  return project.name ?? project.slug
}

// 同一 canonical 路径已注册则复用既有 workspace（registry.create 的复用语义），
// 否则以同一 cwd 建组——attachSession 会校验 cwd 与 workspace path 完全相等，
// 所以这里绝不自己拼路径，一律用与建会话时相同的 cwd。
export async function ensureWorkspaceForCwd(registry, { cwd, title }) {
  const entity = await registry.resolveByPath(cwd) ?? await registry.create(cwd, title)
  return entity
}

// 挂载失败只 warn 不抛：宿主工作区是可选增强，任何异常都不得影响会话创建与运行。
export async function attachSessionToWorkspace(registry, { cwd, title, sessionId }, logger = console) {
  if (!registry || !cwd || !sessionId) return false
  try {
    const entity = await ensureWorkspaceForCwd(registry, { cwd, title })
    await entity.attachSession(sessionId)
    return true
  } catch (error     ) {
    logger.warn?.(`dsh-team: 会话挂工作区分组失败（不影响会话运行）: ${error?.message ?? error}`)
    return false
  }
}

// workspace-group:end

// 历史会话回填：遍历 session_bindings 按推导 cwd 分组，每组先 ensure 再逐个 attach；
// 单条失败 catch 后继续，末尾记一条汇总。幂等靠 settings 标记——标记只用于避免
// 每次启动全量扫，新增会话由 ensureSession 即时挂载覆盖。
export async function backfillWorkspaceGroupBindings(service) {
  if (service.store.setting('workspace_group_backfill') === '1') return false
  const registry = service.ctx?.get?.('workspaceRegistry')
  if (!registry) return false
  const rows = service.store.all(`
    SELECT b.session_id, b.kind, p.slug, p.name AS project_name, p.production_dir,
           bt.solo_dir, bt.name AS bot_name
    FROM session_bindings b
    LEFT JOIN projects p ON p.id = b.project_id
    LEFT JOIN bots bt ON bt.id = b.bot_id`)
  const groups = new Map()
  for (const row of rows) {
    const bot = { name: row.bot_name, solo_dir: row.solo_dir }
    const project = { name: row.project_name, slug: row.slug, production_dir: row.production_dir }
    try {
      const cwd = await resolveSessionCwd(service.config, { solo: row.kind === 'solo', bot, project })
      const group = groups.get(cwd) ?? {
        title: workspaceGroupTitle({ kind: row.kind, project, bot }),
        sessionIds: [],
      }
      group.sessionIds.push(row.session_id)
      groups.set(cwd, group)
    } catch (error     ) {
      // 项目/单聊目录已不可推导（如记录残留）时只跳过该条会话。
      service.logger.warn?.(`dsh-team: 回填跳过会话 ${row.session_id}（工作区路径不可用）: ${error?.message ?? error}`)
    }
  }
  let attached = 0
  let failed = 0
  for (const [cwd, group] of groups) {
    try {
      const entity = await ensureWorkspaceForCwd(registry, { cwd, title: group.title })
      for (const sessionId of group.sessionIds) {
        try {
          await entity.attachSession(sessionId)
          attached += 1
        } catch {
          failed += 1
        }
      }
    } catch {
      failed += group.sessionIds.length
    }
  }
  service.store.setSetting('workspace_group_backfill', '1')
  service.logger.info?.(`dsh-team: 历史会话工作区分组回填完成：挂载 ${attached}，失败 ${failed}`)
  return true
}
