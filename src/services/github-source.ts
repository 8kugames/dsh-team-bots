// src/services/github-source.js —— GitHub 只读触发源（B4-②/DSHBOTS-335）。
// 吸收原型 sources 层的读入面（Trigger 翻译 + scope + 留痕），按报告 B4 分步结论只做
// 一个来源且不整套搬 Source 抽象。observe 口径（报告 B3 + B4）：GitHub issue 只产生
// 「候选通知 + 留痕」，绝不直接建卡/派单——权威链仍是 director 派单，人评估后才立卡。
//
// 配置（env，启动 dsh 前导出；缺省全关）：
//   DSH_TEAM_GITHUB_WATCH       JSON 数组 [{"projectKey":"ORD","repo":"owner/name"}]
//   DSH_TEAM_GITHUB_POLL_MINUTES 轮询间隔分钟，0 = 关闭（默认）
// 依赖：宿主机 gh CLI 已登录（gh auth status）。轮询经 service.githubRunner 可注入（测试桩）。

import { spawnSync } from 'node:child_process'
import { nowIso } from '../util.js'
import { recordExternalTrigger } from './external-trigger-schema.js'

export const GITHUB_POLL_INTERVAL_KEY = 'github_last_poll_at'

// env JSON 解析：非法/非数组一律降级为空清单（fail-closed，不抛错不猜）。
export function parseGithubWatch(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(item => ({ projectKey: String(item?.projectKey ?? '').trim(), repo: String(item?.repo ?? '').trim() }))
      .filter(item => item.projectKey && item.repo)
  } catch {
    return []
  }
}

// gh issue list 的 JSON 行 → 触发候选（纯函数，测试直测）。
export function parseGithubIssues(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? '[]'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(item => Number.isFinite(Number(item?.number)) && item?.title)
      .map(item => ({
        number: Number(item.number),
        title: String(item.title),
        url: String(item.url ?? ''),
        updatedAt: String(item.updatedAt ?? ''),
      }))
  } catch {
    return []
  }
}

// 单源轮询：拉 open issues、按 (source, external_id) 去重落痕、新事件向项目群发候选通知。
export async function pollGithubSource(service, { projectKey, repo }) {
  const project = service.store.get(
    "SELECT * FROM projects WHERE key = ? COLLATE NOCASE AND status = 'active'",
    projectKey,
  )
  if (!project) {
    recordExternalTrigger(service.store, {
      source: 'github', externalId: `${repo}:project`, projectKey,
      disposition: 'filtered', route: 'project', reason: `项目 key ${projectKey} 不存在或已归档`,
    })
    return { recorded: 0, notified: 0, filtered: 1 }
  }
  let issues
  try {
    issues = parseGithubIssues(await runGh(service, ['issue', 'list', '-R', repo, '--state', 'open', '--json', 'number,title,url,updatedAt', '--limit', '50']))
  } catch (error: any) {
    recordExternalTrigger(service.store, {
      source: 'github', externalId: `${repo}:poll`, projectKey,
      disposition: 'failed', route: 'gh', reason: String(error?.message ?? error).slice(0, 300),
    })
    return { recorded: 0, notified: 0, failed: 1 }
  }
  let recorded = 0
  let notified = 0
  for (const issue of issues) {
    const outcome = recordExternalTrigger(service.store, {
      source: 'github',
      externalId: `${repo}#${issue.number}`,
      projectKey,
      disposition: 'notified',
      route: 'issue',
      preview: `${issue.title}${issue.url ? ` ${issue.url}` : ''}`,
    })
    if (outcome !== 'recorded') continue
    recorded += 1
    // observe 口径：只发候选通知（需要人评估 = 合法的需人外发，A1 三条件之二），不建卡。
    try {
      service.insertMessage({
        projectId: project.id,
        senderType: 'system',
        senderId: 'system',
        body: `【外部触发】GitHub ${repo}#${issue.number}「${issue.title}」${issue.url}\n候选工作项待评估（observe：不自动建卡，请总监评估后 team_assign_task 或忽略）。`,
        mentions: project.owner_bot_id ? [project.owner_bot_id] : [],
      })
      notified += 1
    } catch (error: any) {
      service.logger?.warn?.('github source: 候选通知失败 %s#%s: %s', repo, issue.number, error?.message ?? error)
    }
  }
  return { recorded, notified }
}

async function runGh(service, args) {
  const runner = service.githubRunner
  if (typeof runner === 'function') return runner(args)
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 20_000 })
  if (result.status !== 0) {
    throw new Error(`gh ${args[0]} 退出码 ${result.status}：${String(result.stderr ?? '').slice(0, 200) || '无 stderr'}`)
  }
  return result.stdout
}

// 调度入口（tick 调用）：间隔闸 + 逐源容错（单源异常只 warn）。
export async function pollGithubSources(service) {
  const sources = service.config.githubWatch ?? []
  const intervalMinutes = Number(service.config.githubPollMinutes) || 0
  if (intervalMinutes <= 0 || sources.length === 0) return { skipped: 'disabled' }
  const last = service.store.setting(GITHUB_POLL_INTERVAL_KEY)
  if (last) {
    const elapsedMs = Date.now() - new Date(last).getTime()
    if (elapsedMs < intervalMinutes * 60_000) return { skipped: 'interval' }
  }
  service.store.setSetting(GITHUB_POLL_INTERVAL_KEY, nowIso())
  const results = []
  for (const source of sources) {
    try {
      results.push({ repo: source.repo, ...(await pollGithubSource(service, source)) })
    } catch (error: any) {
      service.logger?.warn?.('github source poll %s failed: %s', source.repo, error?.message ?? error)
      results.push({ repo: source.repo, error: String(error?.message ?? error) })
    }
  }
  return { results }
}

export const githubSourceMethods = {
  // 外部触发流水（B4-②）：近 N 条 GitHub 触发留痕，回看「为什么触发/没触发」。
  externalTriggersView(limit = 50) {
    const rows = this.store.all(
      `SELECT source, external_id, project_key, disposition, route, reason, preview, created_at
       FROM external_triggers ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      Math.max(1, Math.min(200, Number(limit) || 50)),
    )
    return {
      count: rows.length,
      items: rows.map(row => ({
        source: row.source,
        externalId: row.external_id,
        projectKey: row.project_key,
        disposition: row.disposition,
        route: row.route,
        reason: row.reason,
        preview: row.preview,
        createdAt: row.created_at,
      })),
    }
  },
}
