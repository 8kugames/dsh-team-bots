// 验收滞留守门 + 三档收口规则引擎（DSHBOTS-194 检测/提醒 → DSHBOTS-235 程序化收口）。
// 背景：D-191/192 曾因「核验已闭环但 owner 未收口」滞留待验收面板被用户点名；D-194 只做
// 检测+提醒，收口靠模型自觉。本守门把收口做成规则引擎：scheduler 每轮 tick 调
// runReviewWatchdog，阈值每轮现算、逐卡容错（单卡失败不拖垮整轮扫描）。
//
// 三档判定（证据链不全一律落到 C 只提醒，自动 accept 是强动作）：
//   A 可验证交付：交付报告（最近一次成功 task 运行的 output）含 commit，且该 commit
//     已验证在项目 dev 分支上，且报告含「全量/全部测试通过」证据 → 自动 accept；
//   B 交付方无响应：最近一次 task 运行已中止/死亡（failed/canceled）且此后无进展 → 自动 return；
//     失败 run 之后出现更新的「建议 accept」核验结论时降级 C 仅提醒（时序上较新的合格证据
//     不被自动退回盖过，但也绝不因此自动 accept）；
//   C 不可判定：仅系统提醒（owner_bot 卡同时排总监验收运行，H1），滞留达 2×阈值二次催办升级语气（H2）。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bool, effectiveReviewIdleMinutes, REVIEW_AUTO_CLOSE_KEY, REVIEW_ESCALATE_KEY, REVIEW_ESCALATE_RANGE } from '../config.js'
import { messageLocale, systemAlertLabel } from './locale.js'

// 单卡去重/判定表（settings 键，JSON map）：{ taskId: { tier, verdict, basis, at, action? } }。
// tier = 已提醒到的层级（1 首次、2 二次催办），同层级不重复提醒；卡离开 in_review 即摘除，
// 回到 in_review 重新获得提醒资格。历史部署的 true 值按 tier 1 容忍。task id 全局唯一，
// 无需按项目分键。面板经 reviewIdleView 读取同表展示每张 in_review 卡的判定与依据。
export const REVIEW_IDLE_ALERTED_KEY = 'review_idle_alerted'

export const SYSTEM_ACTOR = { type: 'system', id: 'system' }

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

// 交付报告里的 commit 候选（7–40 位十六进制）；误命中（普通单词）会在 git 验证处自然淘汰。
const COMMIT_CANDIDATE_RE = /\b[0-9a-f]{7,40}\b/g
// 测试绿证据：关键词式（全量/全部/所有 测试/用例 …… 通过/全绿/pass）或计分式（N/N …… 通过）。
const TESTS_GREEN_RE = /(?:全量|全部|所有|all)\s*(?:测试|用例|tests?)[^\n]{0,80}?(?:通过|全绿|绿|pass(?:ed)?)|(\d+)\s*\/\s*\1[^\n]{0,40}?(?:通过|全绿|绿|pass(?:ed)?)/i
const COMMIT_VERIFY_LIMIT = 5

// 核验结论是否明确建议 accept（A 档核验证据链同口径；混入「建议 return」时不算）。
const advisesAccept = (conclusion: string) =>
  conclusion.includes('建议 accept') && !conclusion.includes('建议 return')

// later 是否在时间上严格晚于 earlier（任一端缺失/不可解析按 false：降级只在正证据下发生，
// 时间序无法判定时保持原判定，不因缺时间戳而放宽或收紧）。
const strictlyAfter = (later, earlier) => {
  const laterMs = later ? new Date(later).getTime() : NaN
  const earlierMs = earlier ? new Date(earlier).getTime() : NaN
  return Number.isFinite(laterMs) && Number.isFinite(earlierMs) && laterMs > earlierMs
}

// 三档判定（纯函数，证据注入便于测试）：
//   latestTaskRun / latestTaskRunAt：该卡最近一次 task 运行及其活动时间（SUPERSEDED 清理
//   标记除外）；report：最近一次成功 task 运行的 output（交付报告）；reviewConclusion /
//   reviewConcludedAt：最近一次成功核验委派运行的结论及其结束时间（以「子代理核验：」开头、
//   含「建议 accept/return」，用户拍板：核验结论+证据链是自动收口的合法证据源）；
//   verifyCommitOnDev：sha → 是否已在 dev 上（null = 无法验证）。
//   A 的两条证据链：①交付报告 commit 已验证在 dev + 测试绿；②子代理核验结论明确建议 accept。
export function classifyDelivery({ report = '', latestTaskRun = null, latestTaskRunAt = null, reviewConclusion = '', reviewConcludedAt = null, verifyCommitOnDev = null }) {
  if (latestTaskRun && ['failed', 'canceled'].includes(latestTaskRun.status)) {
    const why = latestTaskRun.status === 'failed' ? '失败' : '已中止'
    // B 压 A 时序降级：失败 run 之后出现更新的「建议 accept」核验结论，说明其后实际发生了
    // 被认可的进展，B 档「此后无进展」前提被推翻——降级 C 仅提醒，不自动 return 盖过较新
    // 的合格证据；方向保守，绝不因此自动 accept，裁决交还 owner。
    if (advisesAccept(reviewConclusion) && strictlyAfter(reviewConcludedAt, latestTaskRunAt)) {
      return { verdict: 'C', basis: `交付方运行${why}后有更新的核验结论建议 accept，时序冲突不自动退回（仅提醒）` }
    }
    const code = latestTaskRun.error_code ? `（${latestTaskRun.error_code}）` : ''
    return { verdict: 'B', basis: `交付方运行${why}${code}后无进展` }
  }
  if (advisesAccept(reviewConclusion)) {
    return { verdict: 'A', basis: `子代理核验结论建议 accept（依据=核验证据）` }
  }
  if (latestTaskRun?.status === 'succeeded' && report) {
    const candidates = [...new Set(report.match(COMMIT_CANDIDATE_RE) ?? [])].slice(0, COMMIT_VERIFY_LIMIT)
    const testsGreen = TESTS_GREEN_RE.test(report)
    const onDev = verifyCommitOnDev ? candidates.find(sha => verifyCommitOnDev(sha)) : null
    if (onDev && testsGreen) {
      return { verdict: 'A', basis: `交付报告含 commit ${onDev.slice(0, 7)}（已验证在 dev）与测试通过证据（依据=交付证据）` }
    }
    const missing = []
    if (!candidates.length) missing.push('报告未含 commit')
    else if (!onDev) missing.push(verifyCommitOnDev ? 'commit 未验证在 dev' : '无法验证 commit 是否在 dev')
    if (!testsGreen) missing.push('缺测试通过证据')
    if (reviewConclusion.includes('建议 return')) missing.push('子代理核验建议 return')
    return { verdict: 'C', basis: `证据不全：${missing.join('、')}` }
  }
  return { verdict: 'C', basis: reviewConclusion.includes('建议 return')
    ? '子代理核验建议 return，裁决归 owner（仅提醒）'
    : '无成功交付运行的报告可判定' }
}

// commit-on-dev 验证器：项目生产目录是 git 仓库才可用（merge-base --is-ancestor），
// 任何失败（无 dev 分支 / sha 无效 / git 不可用）按「未验证」处理，绝不放宽到 A。
export function commitOnDevVerifier(dir) {
  if (!dir || !existsSync(join(dir, '.git'))) return null
  return (sha) => {
    try {
      execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', sha, 'dev'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}

// 二次催办倍数：保存值非法/未保存回退默认 2（≥2 才构成「升级」，上限 10 防误配成天级）。
export function effectiveReviewEscalateMultiple(getSetting) {
  const [min, max] = REVIEW_ESCALATE_RANGE
  const raw = Number.parseInt(String(getSetting?.(REVIEW_ESCALATE_KEY) ?? ''), 10)
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : min
}

// 自动收口总开关：默认开（程序化收口是本卡产品目标），0 = 关闭自动 accept/return 只提醒。
export function reviewAutoCloseEnabled(service) {
  return bool(service.store.setting(REVIEW_AUTO_CLOSE_KEY, '1'), true)
}

const alertedTier = (value) => {
  if (value === true) return 1
  return value && Number.isFinite(value.tier) ? value.tier : 0
}

const judgeCard = (service, row) => {
  const latestTaskRun = service.store.get(
    `SELECT id, status, error_code, COALESCE(ended_at, queued_at) AS last_activity_at
       FROM runs WHERE task_id = ? AND kind = 'task'
       AND COALESCE(error_code, '') <> 'SUPERSEDED'
     ORDER BY COALESCE(ended_at, queued_at) DESC LIMIT 1`,
    row.id,
  )
  const delivery = service.store.get(
    `SELECT output FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'succeeded'
       AND COALESCE(error_code, '') <> 'SUPERSEDED'
     ORDER BY ended_at DESC LIMIT 1`,
    row.id,
  )
  // 子代理核验结论（DSHBOTS-235 用户拍板）：最近一次成功核验委派运行的 output（含结束时间，
  // 供 B 压 A 时序降级比较「建议 accept」是否晚于失败 run）。
  const review = service.store.get(
    `SELECT output, ended_at FROM runs WHERE task_id = ? AND trigger_type = 'review_delegate' AND status = 'succeeded'
     ORDER BY ended_at DESC LIMIT 1`,
    row.id,
  )
  const report = delivery?.output ?? ''
  const verify = report
    ? commitOnDevVerifier(service.projectWorkDir(service.projectRow(row.project_id)))
    : null
  return classifyDelivery({
    report,
    latestTaskRun,
    latestTaskRunAt: latestTaskRun?.last_activity_at ?? null,
    reviewConclusion: review?.output ?? '',
    reviewConcludedAt: review?.ended_at ?? null,
    verifyCommitOnDev: verify,
  })
}

// 自动收口动作：applyReview 是验收/退回的单一触发点（状态流转、通知、消息全走它）；
// 失败（如并发下卡刚被人工收口）只 warn 不重试，去重表已记录本档位不会反复开火。
const autoClose = (service, row, judgment, tier) => {
  const decision = judgment.verdict === 'A' ? 'accept' : 'return'
  const comment = decision === 'accept'
    ? `程序化收口：${judgment.basis}`
    : `交付方无响应：${judgment.basis}`
  const task = service.taskRow(row.id)
  const project = service.projectRow(row.project_id)
  service.applyReview(task, project, decision, comment, SYSTEM_ACTOR)
    .then(() => {
      service.audit(SYSTEM_ACTOR, 'review.auto_close', 'task', row.id, {
        decision, verdict: judgment.verdict, basis: judgment.basis, tier,
      })
    })
    .catch((error: any) => {
      service.logger?.warn?.('review watchdog auto %s %s failed: %s', decision, row.id, error?.message ?? error)
    })
}

// 扫一轮全部 in_review 卡（归档项目不扫）：滞留者按三档判定收口/提醒。
// 返回 { skipped?: 'disabled', alerted, escalated, recovered, error? }；
// 逐卡 try/catch，单卡异常只 warn 不抛，且每卡处理完即落去重表（H5）。
export function runReviewWatchdog(service) {
  try {
    const { minutes } = effectiveReviewIdleMinutes(service.config, key => service.store.setting(key))
    const escalateMultiple = effectiveReviewEscalateMultiple(key => service.store.setting(key))
    const autoCloseEnabled = reviewAutoCloseEnabled(service)
    const rows = service.store.all(`
      SELECT t.id, t.project_id, t.updated_at, t.assignee_bot_id, p.key AS project_key, t.number,
        t.review_target,
        (SELECT MAX(c.created_at) FROM task_comments c WHERE c.task_id = t.id) AS last_comment_at,
        (SELECT MAX(COALESCE(r.last_progress_at, r.ended_at, r.started_at, r.queued_at))
           FROM runs r WHERE r.task_id = t.id) AS last_run_at
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'in_review' AND p.status = 'active'
    `)
    const map = JSON.parse(service.store.setting(REVIEW_IDLE_ALERTED_KEY) ?? '{}')
    const inReviewIds = new Set(rows.map(row => row.id))
    // 去重表回收：已离开 in_review（或已删除）的卡摘除，恢复再报资格。
    const recovered = Object.keys(map).filter(id => !inReviewIds.has(id))
    for (const id of recovered) delete map[id]
    const persist = () => service.store.setSetting(REVIEW_IDLE_ALERTED_KEY, JSON.stringify(map))
    // 回收即落库（H5）：卡离开 in_review 的摘除不依赖后续是否有卡触发提醒。
    if (recovered.length > 0) persist()
    if (minutes <= 0) {
      return { skipped: 'disabled', alerted: [], escalated: [], recovered }
    }
    const alerted = []
    const escalated = []
    for (const row of rows) {
      try {
        const anchorMs = latestAnchorMs(row)
        if (anchorMs === null) continue
        const idleMs = Date.now() - anchorMs
        // 两端口径同源（H3）：后端与 UI badge 都用「静置毫秒严格大于阈值」判滞留。
        const tier = idleMs > minutes * escalateMultiple * 60_000 ? 2 : idleMs > minutes * 60_000 ? 1 : 0
        if (tier === 0) continue
        const prevTier = alertedTier(map[row.id])
        if (prevTier >= tier) continue
        // 首次接触一律从一档话术起（二次催办必须先有一次催办）：巡检接手时已过 2×阈值
        // 的卡先按一档提醒，跨档升级由下一轮扫描完成，避免一口气连发两档消息。
        const fireTier = prevTier === 0 ? 1 : tier
        const judgment = judgeCard(service, row)
        const actionable = autoCloseEnabled
          && (judgment.verdict === 'A' || (judgment.verdict === 'B' && row.assignee_bot_id))
        const entry: any = { tier: fireTier, verdict: judgment.verdict, basis: judgment.basis, at: new Date().toISOString() }
        if (actionable) entry.action = judgment.verdict === 'A' ? 'accept' : 'return'
        map[row.id] = entry
        persist()
        const label = `${row.project_key}-${row.number}`
        const idleMinutes = Math.floor(idleMs / 60_000)
        if (actionable) {
          autoClose(service, row, judgment, fireTier)
        } else {
          // C（或开关关闭）：仅提醒；滞留达阈值×倍数升级语气二次催办（H2）。
          // 前缀按 locale 落库（DSHBOTS-228）：缺省英文 [SYSTEM ALERT]，中文环境【系统指令】。
          const alertPrefix = systemAlertLabel(messageLocale(service.config, key => service.store.setting(key), service.runtime?.ctx?.get?.('loader')))
          const body = fireTier === 2
            ? `${alertPrefix}${label} 验收已滞留 ${idleMinutes} 分钟（超过 ${minutes * escalateMultiple} 分钟二次催办），请立即收口（accept/return），否则将按三档规则持续评估自动收口。`
            : `${alertPrefix}${label} 验收已滞留 ${idleMinutes} 分钟，核验若已闭环请尽快收口（accept/return）。`
          service.insertMessage({ projectId: row.project_id, senderType: 'system', senderId: 'system', taskId: row.id, body })
          // H1：提醒不触发收口的老缺口——owner_bot 卡同时给总监排一次验收运行
          // （复用 owner_task_run outbox，消息本身仍不触发任何 bot 运行）；幂等键绑档位，
          // 去重表保证同档位只排一次。user 卡裁决归工作台 owner，只提醒不排运行。
          if ((row.review_target ?? 'user') === 'owner_bot') {
            service.enqueueOutbox({
              kind: 'owner_task_run',
              payload: { taskId: row.id, reviewKind: 'review' },
              projectId: row.project_id,
              taskId: row.id,
              idempotencyKey: `owner_review:${row.id}:watchdog:t${fireTier}`,
            })
          }
        }
        ;(fireTier === 2 ? escalated : alerted).push(row.id)
      } catch (cardError: any) {
        service.logger?.warn?.('review watchdog card %s failed: %s', row.id, cardError?.message ?? cardError)
      }
    }
    return { alerted, escalated, recovered }
  } catch (error: any) {
    service.logger?.warn?.('review watchdog failed: %s', error?.message ?? error)
    return { alerted: [], escalated: [], recovered: [], error: String(error?.message ?? error) }
  }
}

// 面板同源视图（H3）：taskView 对 in_review 卡透出与守门同一 SQL 口径的滞留锚点
// （含最新评论与 run 活动，UI badge 不再自算口径）+ 生效阈值/升级线 + 最近一次判定与依据。
export const reviewWatchdogMethods = {
  reviewIdleView(task) {
    const anchors = this.store.get(
      `SELECT
         (SELECT MAX(c.created_at) FROM task_comments c WHERE c.task_id = ?) AS last_comment_at,
         (SELECT MAX(COALESCE(r.last_progress_at, r.ended_at, r.started_at, r.queued_at))
            FROM runs r WHERE r.task_id = ?) AS last_run_at`,
      task.id, task.id,
    )
    const anchorMs = latestAnchorMs({
      updated_at: task.updated_at,
      last_comment_at: anchors?.last_comment_at ?? null,
      last_run_at: anchors?.last_run_at ?? null,
    })
    const { minutes } = effectiveReviewIdleMinutes(this.config, key => this.store.setting(key))
    const escalateMinutes = minutes > 0 ? minutes * effectiveReviewEscalateMultiple(key => this.store.setting(key)) : 0
    const verdictEntry = JSON.parse(this.store.setting(REVIEW_IDLE_ALERTED_KEY) ?? '{}')[task.id]
    return {
      anchorMs,
      anchorIso: anchorMs === null ? null : new Date(anchorMs).toISOString(),
      thresholdMinutes: minutes,
      escalateMinutes,
      verdict: verdictEntry && verdictEntry !== true ? verdictEntry : null,
    }
  },
}
