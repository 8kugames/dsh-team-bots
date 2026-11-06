// 通知通道域（DSHBOTS-243）：成员通知与任务提醒。
// 投递面与留痕分离——宿主会话通道（runtime.steer，即时可达）负责投递，插件 messages
// 落库（进群聊流 / 任务线程）为准绳；任一通道失败只 warn，不阻塞另一通道。
// 宿主 send_message 工具是 Agent Team 作用域的（花名册按根会话隔离，每个项目 bot
// 会话都是自己的 Team Lead），寻址不到另一个项目 bot 的会话；服务层可达的宿主原生
// 投递通道是 sessionController.prompt（runtime.steer 的封装），成员通知的即时投递
// 走它，句柄不可达或目标无绑定会话时降级为群聊流（insertMessage + chat_run）。

import { badRequest, notFound } from '../errors.js'
import { text } from '../util.js'

// ── 防循环三上限（DSHBOTS-267，配置默认值写死常量，KISS）──────────────────
// 真实事故背书：伙伴回执淹没主对话、委派续跑近百轮重发已推翻目标。
// ① 单 run 内经 notify/chat 产生的伙伴提醒（按去重目标计条数）上限：超出静默丢弃并记日志；
// ② 同类提醒事件（同 run + 同目标 bot）每日次数上限：超出静默丢弃并记日志。
// 每条放行的提醒在 run_events 记 type='partner_notice'，message 存 partner_notice:<目标bot>，
// 两条上限都从这张事件流计数，不新建并行状态表。
export const RUN_PARTNER_NOTICE_CAP = 3
export const PARTNER_NOTICE_DAILY_CAP = 5

// ── 滞留阈值兜底（DSHBOTS-280）：in_review/blocked 非施工状态的超时提醒 ─────────
// 只提醒不自动处置：不自动关单、不自动转状态、不重派，验收与解阻由项目总监闭环（DSHBOTS-281 口径）。
export const STALE_REVIEW_HOURS = 24
export const STALE_BLOCKED_HOURS = 48
export const STALE_CARD_NOTICE_PREFIX = '【滞留提醒】'

// 滞留判定（纯函数，供 scheduler 扫描与守门测试共用；阈值内/外两向可测）。
// 基准时间 = tasks.updated_at：blocked 无专门「进入 blocked」时间戳列，用 updated_at 近似
// ——转 blocked 走 updateTask 必刷 updated_at，其后任何卡面更新同样只推迟提醒，不会漏报。
export function staleCardHit({ status, updated_at, now = Date.now() } = {} as any) {
  if (status !== 'in_review' && status !== 'blocked') return null
  const baseMs = updated_at ? new Date(updated_at).getTime() : NaN
  if (!Number.isFinite(baseMs)) return null
  const hours = (now - baseMs) / 3_600_000
  const threshold = status === 'in_review' ? STALE_REVIEW_HOURS : STALE_BLOCKED_HOURS
  return hours > threshold ? { status, hours, threshold } : null
}

// D-269 口径文案 = 原因（滞留时长+阈值）+ 点名总监的处置方向（DSHBOTS-281：处置归项目
// 总监自行闭环，不写「owner 可改/可用」转接话术；blocked 侧重派即自动重置死线窗口）。
export function staleCardNoticeBody({ identifier, status, hours } = {} as any) {
  const idle = Math.floor(hours)
  return status === 'in_review'
    ? `${STALE_CARD_NOTICE_PREFIX}${identifier} 待验收已滞留 ${idle} 小时（阈值 ${STALE_REVIEW_HOURS}h）：待总监验收收口（accept/return）。`
    : `${STALE_CARD_NOTICE_PREFIX}${identifier} 受阻已滞留 ${idle} 小时（阈值 ${STALE_BLOCKED_HOURS}h）：待总监解阻/收口（重派即自动重置死线窗口）。`
}

export const notifyMethods = {
  // 伙伴提醒配额闸（DSHBOTS-267）：放行返回 true；超限静默丢弃（warn 留痕）返回 false。
  // run 归属不到（发起方无活跃运行）时不设限——空闲/人工会话的零星通知无循环风险。
  allowPartnerNotice(runId, targetId) {
    if (!runId || !targetId) return true
    const distinctTargets = this.store.get(
      "SELECT COUNT(DISTINCT message) AS n FROM run_events WHERE run_id = ? AND type = 'partner_notice'",
      runId,
    ).n
    if (distinctTargets >= RUN_PARTNER_NOTICE_CAP) {
      this.logger.warn?.('dsh-team: 伙伴提醒超单 run 上限（%s 个目标），静默丢弃：run=%s target=%s', RUN_PARTNER_NOTICE_CAP, runId, targetId)
      return false
    }
    const todayCount = this.store.get(
      "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'partner_notice' AND message = ? AND date(created_at) = date('now')",
      runId, `partner_notice:${targetId}`,
    ).n
    if (todayCount >= PARTNER_NOTICE_DAILY_CAP) {
      this.logger.warn?.('dsh-team: 伙伴提醒超每日上限（%s 次/日），静默丢弃：run=%s target=%s', PARTNER_NOTICE_DAILY_CAP, runId, targetId)
      return false
    }
    return true
  },

  // 记一条放行的伙伴提醒事件（配额闸通过后调用；chat 唤醒路径共用同一事件流）。
  recordPartnerNotice(runId, targetId) {
    if (!runId || !targetId) return
    this.insertRunEvent(runId, 'partner_notice', `partner_notice:${targetId}`)
  },

  // 滞留提醒投递（DSHBOTS-280）：等价 owner 通知通道——与 D-274 死线升级同款
  // （insertMessage 系统留痕进任务线程 + mentions 点名项目 owner）。
  // 防重＝同卡每日 ≤1 条，以当日已有同前缀系统留痕为准，超限静默（只 warn 不投递）。
  // 口径说明：D-267 配额闸（allowPartnerNotice）按 run_events type='partner_notice'
  // 的 run 维度计数，run_id 非空挂不上无 run 的 scheduler 扫描；带 run 上下文的
  // notifyMemberFromBot 路径照旧走同一配额流，本扫描路径的防重落点即消息留痕流。
  notifyStaleCardOwner({ project, task, hit }) {
    const identifier = `${project.key}-${task.number}`
    const already = this.store.get(
      "SELECT id FROM messages WHERE task_id = ? AND sender_type = 'system' AND body LIKE ? AND date(created_at) = date('now') LIMIT 1",
      task.id, `${STALE_CARD_NOTICE_PREFIX}%`,
    )
    if (already) {
      this.logger.warn?.('dsh-team: 滞留提醒同卡每日上限（1 条），静默跳过：%s', identifier)
      return false
    }
    this.insertMessage({
      projectId: project.id,
      senderType: 'system',
      senderId: 'system',
      taskId: task.id,
      body: staleCardNoticeBody({ identifier, status: hit.status, hours: hit.hours }),
      mentions: project.owner_bot_id ? [project.owner_bot_id] : [],
    })
    return true
  },

  // 工具入口：target=member 通知本项目另一成员；target=task 提醒本项目执行中任务。
  // 鉴权：调用者必须是本项目成员（memberContextFor），目标成员/任务都锁在本项目内，
  // 跨项目 ref 一律解析不到（notFound），不泄露他项目是否存在同名目标。
  async notifyFromBot(sessionId, input) {
    const target = String(input?.target ?? '')
    if (target !== 'member' && target !== 'task') throw badRequest('target 只能是 member 或 task')
    const body = text(input?.message, 5_000)
    if (!body) throw badRequest('通知内容不能为空')
    const { project, bot } = this.memberContextFor(sessionId)
    return target === 'member'
      ? this.notifyMemberFromBot({ project, from: bot, memberName: input?.member, body })
      : this.notifyTaskFromBot({ project, from: bot, ref: input?.task, body })
  },

  // 成员通知：宿主通道（目标项目会话 steer）+ 插件落库双写。
  // 留痕恒定先落（来源 bot、@目标、进群聊流）；投递失败只 warn，转群聊流兜底。
  async notifyMemberFromBot({ project, from, memberName, body }) {
    const name = String(memberName ?? '').trim()
    const target = this.membersOf(project.id)
      .find(member => member.name.toLowerCase() === name.toLowerCase())
    if (!target) throw notFound(`项目 ${project.name} 里没有叫 ${memberName} 的成员 Bot`)
    if (target.id === from.id) throw badRequest('不能给自己发通知')
    // 暂停/不可用目标不投递（DSHBOTS-262）：通知即唤醒信号，暂停中先恢复再通知。
    if (target.status === 'paused') throw badRequest(`Bot ${target.name} 已暂停，先恢复再通知`)
    if (target.status !== 'active') throw badRequest(`Bot ${target.name} 当前不可用（${target.status}）`)
    // DSHBOTS-267 防循环上限：归属发起方当前活跃运行，配额闸不通过即静默丢弃（不落留痕不投递）。
    const activeRun = this.store.get(
      "SELECT id FROM runs WHERE bot_id = ? AND project_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      from.id, project.id,
    )
    if (!this.allowPartnerNotice(activeRun?.id, target.id)) {
      return `伙伴提醒已达防循环上限，本次已静默丢弃（详见运行日志）。`
    }
    this.recordPartnerNotice(activeRun?.id, target.id)
    const notice = `【通知】${from.name}：${body}`
    const messageId = this.insertMessage({
      projectId: project.id,
      senderType: 'bot',
      senderId: from.id,
      body: notice,
      mentions: [target.id],
    })
    // DSHBOTS-293 旧车道残留修复：四车道收敛后（DSHBOTS-288/289）活跃绑定只有
    // kind='bot' 一道，原 kind='project' 查询恒落空——成员通知的宿主通道永远降级
    // 群聊流。改为按 bot 唯一控制面绑定解析（与 runs.ts/runtime/session.ts 同款），
    // 不按 project_id 过滤：多项目 bot 的单条控制面绑定 project_id 只属创建时的项目。
    const binding = this.store.get(
      "SELECT * FROM session_bindings WHERE bot_id = ? AND kind = 'bot' AND alias = 0",
      target.id,
    )
    if (binding && typeof this.runtime?.steer === 'function') {
      try {
        await this.runtime.steer(binding.session_id, notice)
        return `已通知 ${target.name}（宿主通道投递${messageId ? `，群聊留痕 ${messageId.slice(-6)}` : ''}）。`
      } catch (error: any) {
        this.logger.warn?.('dsh-team: 成员通知宿主通道投递失败 %s: %s', target.name, error?.message ?? error)
      }
    }
    // 降级：群聊流可达（成员会话经 chat_run 监听群消息）。
    if (messageId) {
      this.enqueueOutbox({
        kind: 'chat_run',
        payload: { projectId: project.id, botId: target.id, messageId },
        projectId: project.id,
        sourceId: messageId,
        idempotencyKey: `chat:${messageId}:${target.id}`,
      })
      // enqueueOutbox 同事务落库后立即 applyOutboxRow（chat_run → enqueueChatRun），无需再触发 tick。
    }
    return `已通知 ${target.name}（群聊流投递${messageId ? `，留痕 ${messageId.slice(-6)}` : ''}）。`
  },

  // 任务提醒：留痕落任务线程（owner 验收面板可见）；有活跃运行（running + 会话）
  // 再经宿主通道 steer 注入（复用 D-232 改卡通知第二段机制）。
  async notifyTaskFromBot({ project, from, ref, body }) {
    const task = this.resolveBotTask(project, ref)
    const identifier = `${project.key}-${task.number}`
    // 负责人暂停/不可用时提醒不投递（DSHBOTS-262）：提醒即唤醒信号，暂停中先恢复再提醒。
    if (task.assignee_bot_id) {
      const assignee = this.store.get('SELECT name, status FROM bots WHERE id = ?', task.assignee_bot_id)
      if (assignee?.status === 'paused') throw badRequest(`任务 ${identifier} 负责人 ${assignee.name} 已暂停，先恢复再提醒`)
      if (!assignee || assignee.status !== 'active') throw badRequest(`任务 ${identifier} 负责人当前不可用`)
    }
    // DSHBOTS-267 单跟进者在途幂等：每张任务同时只允许一个跟进提醒在途。
    // 在途判定=最近一条任务提醒落库后，该任务没有启动过新运行（提醒尚未被任何运行消费）；
    // 重复提醒静默吸收（不落新留痕、不注入、不计新），warn 留痕。
    const lastNotice = this.store.get(
      "SELECT created_at FROM messages WHERE task_id = ? AND sender_type = 'bot' AND body LIKE '【任务提醒】%' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      task.id,
    )
    if (lastNotice && !this.store.get(
      'SELECT id FROM runs WHERE task_id = ? AND started_at > ? LIMIT 1',
      task.id, lastNotice.created_at,
    )) {
      this.logger.warn?.('dsh-team: 任务 %s 已有在途跟进提醒，重复提醒静默吸收', identifier)
      return `任务 ${identifier} 已有在途跟进提醒，本次重复未投递（幂等去重，不计数）。`
    }
    const notice = `【任务提醒】${from.name}：${body}`
    const messageId = this.insertMessage({
      projectId: project.id,
      senderType: 'bot',
      senderId: from.id,
      body: notice,
      taskId: task.id,
      mentions: task.assignee_bot_id ? [task.assignee_bot_id] : [],
    })
    const run = this.store.get(
      "SELECT id, session_id FROM runs WHERE task_id = ? AND status = 'running' AND session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      task.id,
    )
    if (run && typeof this.runtime?.steer === 'function') {
      try {
        await this.runtime.steer(run.session_id, `Task reminder from ${from.name}: ${body}`)
        this.insertRunEvent(run.id, 'notified', `任务提醒已注入（${identifier}）`)
        return `已向任务 ${identifier} 的活跃运行注入提醒（留痕 ${messageId?.slice(-6) ?? '无'}）。`
      } catch (error: any) {
        this.logger.warn?.('dsh-team: 任务提醒注入失败 %s: %s', identifier, error?.message ?? error)
      }
    }
    return `已向任务 ${identifier} 落线程提醒（无活跃运行可注入；留痕 ${messageId?.slice(-6) ?? '无'}）。`
  },
}
