// 验收滞留守门（DSHBOTS-194）：in_review 卡静置检测 + owner 系统提醒。
// 背景：D-191/192 曾因「核验已闭环但 owner 未收口」滞留待验收面板被用户点名，
// 本守门把兜底做成产品：scheduler 每轮 tick 调 runReviewWatchdog，仿 D-172
// 代码卫生（hygiene.js）的独立服务形态——阈值每轮现算、全程容错不破坏主循环。
import { effectiveReviewIdleMinutes } from '../config.js'

// 单卡去重表（settings 键，JSON map：{taskId: true}）：每卡只提醒一次；
// 卡离开 in_review 即摘除，回到 in_review 重新获得提醒资格。task id 全局唯一，
// 无需按项目分键（与 hygiene 按项目分键的差别：那是文件路径按项目隔离）。
export const REVIEW_IDLE_ALERTED_KEY = 'review_idle_alerted'

// 滞留锚点 = max(tasks.updated_at, 最新 task_comments.created_at, 最新关联 run 活动时间)。
// 三者任一更新都视为「有活动」，静置时长从锚点起算；空值跳过，全空返回 null（无法判定）。
export function latestAnchorMs({ updated_at = null, last_comment_at = null, last_run_at = null } = {}) {
  let latest = null
  for (const stamp of [updated_at, last_comment_at, last_run_at]) {
    if (!stamp) continue
    const ms = new Date(stamp).getTime()
    if (!Number.isFinite(ms)) continue
    if (latest === null || ms > latest) latest = ms
  }
  return latest
}

// 扫一轮全部 in_review 卡：滞留者按 hygiene 手法注入 owner 群聊系统提醒。
// 返回 { skipped?: 'disabled', alerted: [taskId], recovered: [taskId], error? }；
// 任何异常只 warn 不抛，调度主循环不因守门中断。
export function runReviewWatchdog(service) {
  try {
    const { minutes } = effectiveReviewIdleMinutes(service.config, key => service.store.setting(key))
    const rows = service.store.all(`
      SELECT t.id, t.project_id, t.updated_at, p.key AS project_key, t.number,
        (SELECT MAX(c.created_at) FROM task_comments c WHERE c.task_id = t.id) AS last_comment_at,
        (SELECT MAX(COALESCE(r.last_progress_at, r.ended_at, r.started_at, r.queued_at))
           FROM runs r WHERE r.task_id = t.id) AS last_run_at
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'in_review'
    `)
    const map = JSON.parse(service.store.setting(REVIEW_IDLE_ALERTED_KEY) ?? '{}')
    const inReviewIds = new Set(rows.map(row => row.id))
    // 去重表回收：已离开 in_review（或已删除）的卡摘除，恢复再报资格。
    const recovered = Object.keys(map).filter(id => !inReviewIds.has(id))
    for (const id of recovered) delete map[id]
    if (minutes <= 0) {
      if (recovered.length > 0) service.store.setSetting(REVIEW_IDLE_ALERTED_KEY, JSON.stringify(map))
      return { skipped: 'disabled', alerted: [], recovered }
    }
    const alerted = []
    for (const row of rows) {
      if (map[row.id]) continue
      const anchorMs = latestAnchorMs(row)
      if (anchorMs === null) continue
      const idleMinutes = Math.floor((Date.now() - anchorMs) / 60_000)
      if (idleMinutes <= minutes) continue
      const body = `【系统指令】${row.project_key}-${row.number} 验收已滞留 ${idleMinutes} 分钟，核验若已闭环请尽快收口（accept/return）。`
      service.insertMessage({ projectId: row.project_id, senderType: 'system', senderId: 'system', taskId: row.id, body })
      map[row.id] = true
      alerted.push(row.id)
    }
    if (alerted.length > 0 || recovered.length > 0) {
      service.store.setSetting(REVIEW_IDLE_ALERTED_KEY, JSON.stringify(map))
    }
    return { alerted, recovered }
  } catch (error) {
    service.logger?.warn?.('review watchdog failed: %s', error?.message ?? error)
    return { alerted: [], recovered: [], error: String(error?.message ?? error) }
  }
}
