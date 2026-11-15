// src/services/runs.js —— 运行生命周期域
// 运行的入队、取消、重试、执行、轨迹/产物读取与只读工作区审计。
// 运行结束后的收尾与交付派发见 ./run-finish.js。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { existsSync, realpathSync, statSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { assertInside } from '../paths.js'
import { deliveryPlan, replyDeliveryPrompt } from '../botmsg.js'
import { id, jsonParse, nowIso, sha256, text } from '../util.js'
import { readWriteScopes, writeScopePathsOverlap } from './write-scopes.js'
import { isProviderUnavailableCode } from './model-fallback.js'
import { effectiveSandbox, PROMPT_SEGMENT_DEFAULTS, parsePromptOverrides } from './runtime/prompt.js'
import { ensureAttentionSchema, parseAttention } from './attention-schema.js'

// 合批窗口与上限默认值（DSHBOTS-231/287，DSHBOTS-290 随语义回补从 scheduler.ts 迁来）：
// 只合并入队时间相差 30 秒内的挂起消息，单组消息总数封顶 5；settings 可覆盖
// （coalesce_window_ms / coalesce_max_messages）。
const COALESCE_MAX_MESSAGES_DEFAULT = 5
const COALESCE_WINDOW_MS_DEFAULT = 30_000

/**
 * origin→trigger_type 映射（DSHBOTS-329）：通道来源的直达运行打来源通道标记
 * （'wechat' 微信 / 'feishu' 飞书），运行收尾据此把回复推回该通道管理员；
 * 普通 UI 消息（origin 空）与未映射的值都落 'mention'，不推任何通道。
 */
export function originTriggerType(origin) {
  return origin === 'wechat' || origin === 'feishu' ? origin : 'mention'
}

// ── 只读运行工作区审计归因（DSHBOTS-94）─────────────────────────────────
// 指纹行形如 " M dir/file"（前两字符状态位 + 空格 + 路径）；重命名 "R  old -> new"
// 的新旧路径都算被触碰。带引号的 quoted 路径不解析（与产物清单同一口径，跳过）。
export function porcelainTouchedPaths(output) {
  const paths = new Set()
  for (const line of String(output ?? '').split('\n')) {
    if (line.length < 4) continue
    const path = line.slice(3).trim()
    if (!path || path.startsWith('"')) continue
    const arrow = path.indexOf(' -> ')
    if (arrow === -1) {
      paths.add(path)
      continue
    }
    const left = path.slice(0, arrow).trim()
    const right = path.slice(arrow + 4).trim()
    if (left) paths.add(left)
    if (right) paths.add(right)
  }
  return paths
}

// 归因判定（纯函数，供测试直接锚定）：before/after 为 read 运行起止两次
// `git status --porcelain` 指纹；concurrentWrites 为窗口内并发的写运行
// [{ id, label, scopes }]，scopes 是归一化写范围数组（空数组 = 未声明，
// 视为可能写任何路径）。返回 { silent, suspects, unattributedPaths }：
// - 无并发写运行，或有路径不落在任何并发写范围 → 不静默，suspects 供告警点名；
// - 变化全部可归因（含并发写未声明范围的保守情形）→ 静默不打扰用户。
export function attributeWorkspaceChange({ before, after, concurrentWrites = [] }) {
  const beforeLines = new Set(String(before ?? '').split('\n'))
  const afterLines = new Set(String(after ?? '').split('\n'))
  const changedLines = []
  for (const line of beforeLines) if (!afterLines.has(line)) changedLines.push(line)
  for (const line of afterLines) if (!beforeLines.has(line)) changedLines.push(line)
  const writes = concurrentWrites.filter(item => item && item.id)
  const unattributedPaths = []
  for (const path of porcelainTouchedPaths(changedLines.join('\n'))) {
    const covered = writes.some(write =>
      !write.scopes?.length || write.scopes.some(scope => writeScopePathsOverlap(path, scope)))
    if (!covered) unattributedPaths.push(path)
  }
  if (!writes.length || unattributedPaths.length) {
    return { silent: false, suspects: writes.map(write => write.label ?? write.id), unattributedPaths }
  }
  return { silent: true, attributedTo: writes.map(write => write.label ?? write.id) }
}


export const runsMethods = {

  // ── 争用口径 A（DSHBOTS-289，ADR §5.2-2，owner 拍板）─────────────────────────
  // one_active_run_per_bot 激活后，bot 忙（有 queued/running 运行）时入站消息不落 runs 行
  // （第二条 queued 会直接撞唯一索引），挂入按 bot 的待处理队列（settings 持久化，重启不丢）；
  // bot 空闲时 drainPendingMessages 把挂起消息建回运行——chat/solo_chat 同类合批成一条，
  // dm/dm_reply 按一条来信一条回信契约逐条放行不合批；task/review 运行照常落 runs 行排队，
  // 不被消息合批吞并（与本队列互斥串行，靠 claimKey=bot 的领取闸保证）。
  // DSHBOTS-300：busy 闸是先查后插，多进程共享 team.sqlite 时两进程可同拍过检后各自
  // INSERT，后者撞 one_active_run_per_bot——以唯一索引为串行化真值，命中即视为
  // 「查后插之间 bot 转忙」，入队路径按争用口径 A 落挂起队列返 null（outbox 对 null
  // 按「已消费/挂起」收单），绝不向上抛（直抛会被计为投递失败重试耗尽置 failed）。
  // task_id 维度的 one_active_run_per_task 撞车不在内：重试下一拍 active 预检即自愈。
  isRunBotUniqueViolation(error) {
    const message = String(error?.message ?? error)
    // DSHBOTS-308：索引改 (bot_id, COALESCE(project_id,'~solo')) 表达式后，撞车文本可能
    // 只含 COALESCE 列名而不再含 runs.bot_id——放宽匹配并保持旧文本兼容；task 维度的
    // one_active_run_per_task 撞车仍不在内（口径不变）。
    return message.includes('UNIQUE')
      && (message.includes('runs.bot_id') || message.includes('one_active_run_per_bot')
        || message.includes('COALESCE(project_id'))
  },
  // DSHBOTS-304 同拍双投合并辅助：按幂等键 / task_id 找既有 active 运行（双投胜利方）。
  activeRunByIdempotencyKey(key) {
    return this.store.get(
      "SELECT id FROM runs WHERE idempotency_key = ? AND status IN ('queued', 'running')",
      key,
    )?.id ?? null
  },
  activeRunByTaskId(taskId) {
    return this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      taskId,
    )?.id ?? null
  },
  // DSHBOTS-304：挂起项是否已被既有运行覆盖或作废（true=drain 清扫时丢弃）。双投失败方的
  // 挂起项与胜利方运行共存的两类恶果：消息族 drain 建回永撞全局 UNIQUE idempotency_key
  // （任意状态）→返 null 永不消费→每 tick 队头 break 阻塞该 bot 全部挂起组；任务族幂等键
  // 恒新会在原运行结束后重复建行。清扫口径：消息族=同幂等键运行已存在（胜利方已处理，
  // 副本作废）；task/owner_task=active 运行已在（跨进程合并消算）或任务已终态/不存在（快照作废）。
  heldItemSuperseded(botId, item) {
    if (item?.kind === 'task' || item?.kind === 'owner_task') {
      if (this.activeRunByTaskId(item.taskId)) return true
      const task = this.store.get('SELECT status FROM tasks WHERE id = ?', item.taskId)
      return !task || task.status === 'done' || task.status === 'canceled'
    }
    const idem = item?.kind === 'chat' ? `chat:${item.messageId}:${botId}`
      : item?.kind === 'solo_chat' ? `solo_chat:${item.messageId}`
        : item?.kind === 'dm' ? `dm:${item.messageId}`
          : item?.kind === 'dm_reply' ? `dm_reply:${item.messageId}` : null
    if (!idem) return true
    return Boolean(this.store.get('SELECT id FROM runs WHERE idempotency_key = ?', idem))
  },
  // DSHBOTS-308（owner 拍板跨工作区并行）：bot 串行域从 bot 全局收窄为 (bot, 工作区)，
  // domain = project_id ?? '~solo'，与 D-299 one_bot_binding 的 COALESCE 口径一致——
  // 不同工作区的运行互不占位，可并行。
  // 任务运行豁免（单 bot 多任务并行）：任务在独立任务会话执行，不再占消息族的
  // bot 车道——busy 判定只看非任务运行，chat/dm/solo 消息不必等任务跑完。
  botBusy(botId, domain) {
    return Boolean(this.store.get(
      "SELECT id FROM runs WHERE bot_id = ? AND COALESCE(project_id, '~solo') = ? AND status IN ('queued', 'running') AND kind <> 'task'",
      botId,
      domain,
    ))
  },
  pendingMessagesKey(botId, domain) {
    return `bot_pending_msgs:${botId}:${domain}`
  },
  holdPendingMessage(botId, domain, item) {
    const key = this.pendingMessagesKey(botId, domain)
    const list = jsonParse(this.store.setting(key), [])
    const safe = Array.isArray(list) ? list : []
    if (safe.some(existing => existing?.messageId === item.messageId)) return
    this.store.setSetting(key, JSON.stringify([...safe, item]))
  },
  // 建回运行（drainPendingMessages 专用）：直接落 runs 行（含合批 merged_messages），
  // UNIQUE 撞车（并发领取窗口）返回 null 交由调用方把消息留队列下一拍重试。
  insertHeldMessageRun(bot, group) {
    const item = group.first
    const mergedIds = group.merge.map(entry => entry.messageId)
    const createdAt = nowIso()
    const runId = id('run')
    // 任务挂起项（DSHBOTS-290 busy 闸）：按入队时快照建回写运行——列面与
    // enqueueTaskRun 的直接 INSERT 一致（task_id/write_scopes/备用模型三列），
    // UNIQUE 撞车（并发领取窗口）与消息族同口径返回 null 留队列。
    if (item.kind === 'task') {
      const routing = item.routing ?? {}
      try {
        this.store.run(
          `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
            attempt, idempotency_key, write_scopes, model_provider, model_model, model_effort, queued_at)
           VALUES (?, ?, ?, ?, 'task', 'write', ?, ?, 'queued', 1, ?, ?, ?, ?, ?, ?)`,
          runId, item.projectId, bot.id, item.taskId, item.triggerType, item.taskId,
          `task:${item.taskId}:${Date.now()}:${runId}`, item.writeScopes ?? '[]',
          routing.provider ?? null, routing.model ?? null, routing.effort ?? null, createdAt,
        )
      } catch (error: any) {
        if (String(error).includes('UNIQUE')) return null
        throw error
      }
      this.insertRunEvent(runId, 'queued', `bot 空闲，挂起任务建回运行（由 ${item.actorType}:${item.actorId} 触发）`)
      if (routing.mode === 'fallback') {
        this.insertRunEvent(runId, 'quota_fallback', `主 provider 额度耗尽，本次直接走备用模型 ${routing.ref ?? ''}（预计 ${routing.resetAt ?? '未知'} 恢复）`)
      } else if (routing.mode === 'wait') {
        this.insertRunEvent(runId, 'quota_wait', `主 provider 额度耗尽且无可用备用模型，排队等待至 ${routing.resetAt ?? '恢复'}`)
      }
      if (item.triggerType === 'board_resume') {
        this.insertRunEvent(runId, 'board_resume', '看板拖入执行中，系统指令自动开工')
      }
      return runId
    }
    // owner 任务运行挂起项（review/handle/review_delegate，DSHBOTS-290 busy 闸）：
    // 只读任务运行，按入队时快照建回，列面与 enqueueOwnerTaskRun 一致。
    // DSHBOTS-358：额度路由快照随挂起项带回来，建回时同样落 model_* 三列。
    if (item.kind === 'owner_task') {
      const routing = item.routing ?? {}
      try {
        this.store.run(
          `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
            attempt, idempotency_key, model_provider, model_model, model_effort, queued_at)
           VALUES (?, ?, ?, ?, ?, 'read', ?, ?, 'queued', 1, ?, ?, ?, ?, ?)`,
          runId, item.projectId, bot.id, item.taskId, item.runKind, item.triggerType, item.taskId,
          `${item.triggerType}:${item.taskId}:${Date.now()}:${runId}`,
          routing.mode === 'fallback' ? routing.provider ?? null : null,
          routing.mode === 'fallback' ? routing.model ?? null : null,
          routing.mode === 'fallback' ? routing.effort ?? null : null,
          createdAt,
        )
      } catch (error: any) {
        if (String(error).includes('UNIQUE')) return null
        throw error
      }
      this.insertRunEvent(runId, 'queued', 'bot 空闲，挂起的 owner 任务运行建回（验收/接管）')
      if (routing.mode === 'fallback') {
        this.insertRunEvent(runId, 'quota_fallback', `主 provider 额度耗尽，本次直接走备用模型 ${routing.ref ?? ''}`)
      } else if (routing.mode === 'wait') {
        this.insertRunEvent(runId, 'quota_wait', `主 provider 额度耗尽且无可用备用模型，排队等待至 ${routing.resetAt ?? '恢复'}`)
      }
      return runId
    }
    const spec = item.kind === 'chat'
      ? { projectId: item.projectId, mode: 'read', trigger: originTriggerType(item.origin), idem: `chat:${item.messageId}:${bot.id}` }
      : item.kind === 'solo_chat'
        ? { projectId: null, mode: 'write', trigger: originTriggerType(item.triggerType), idem: `solo_chat:${item.messageId}` }
        : item.kind === 'dm'
          ? { projectId: item.projectId, mode: 'read', trigger: 'dm', idem: `dm:${item.messageId}` }
          : { projectId: item.projectId, mode: 'read', trigger: 'dm_reply', idem: `dm_reply:${item.messageId}` }
    try {
      this.store.run(
        `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status,
          attempt, idempotency_key, merged_messages, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?)`,
        runId, spec.projectId, bot.id, item.kind, spec.mode, spec.trigger, item.messageId,
        spec.idem, mergedIds.length ? JSON.stringify(mergedIds) : null, createdAt,
      )
    } catch (error: any) {
      if (String(error).includes('UNIQUE')) return null
      throw error
    }
    if (item.kind === 'dm') {
      this.store.run(
        "UPDATE bot_messages SET status = 'delivered', run_id = ? WHERE id = ?",
        runId, item.messageId,
      )
    }
    this.insertRunEvent(runId, 'queued',
      `bot 空闲，待处理消息建回运行${mergedIds.length ? `（合批 ${mergedIds.length} 条）` : ''}`)
    return runId
  },
  // D-272 用户提问判定（挂起消息向，DSHBOTS-290 语义回补）：按触发消息的 sender_type
  // 判定——chat 查 messages、solo_chat 查 solo_messages（单聊消息独立表）。用户发的消息
  // 是「提问」，bot 触发（通知降级、@mention 唤醒、回信）不算。
  // 注：卡面原文写「chat/solo_chat 查 messages」，实测单聊落 solo_messages 表，按实际表改；
  // dm/dm_reply 查 bot_messages（DSHBOTS-291 覆盖补测实测）——该表无 sender_type 列且
  // from_bot_id 恒为 bot（bot 间私信），不存在用户触发形态，恒为 false（逐条放行不参与合批，
  // 该标记对 dm 组也无分组意义）。
  heldItemIsUserQuestion(item) {
    if (item?.kind === 'chat') {
      const row = this.store.get('SELECT sender_type FROM messages WHERE id = ?', item.messageId)
      return row?.sender_type === 'user'
    }
    if (item?.kind === 'solo_chat') {
      const row = this.store.get('SELECT sender_type FROM solo_messages WHERE id = ?', item.messageId)
      return row?.sender_type === 'user'
    }
    return false
  },
  // 争用口径 A 收口：bot 空闲时把挂起消息建回运行。chat/solo_chat 各取首条建运行、其余
  // 同 kind 并入 merged_messages 同轮注入（合批成一条）；dm/dm_reply 一次只放行一条（回信
  // 契约），余量留队列下一拍。建行失败（并发撞 UNIQUE）的消息全部留队列，不丢消息。
  // D-287 合批语义回补（DSHBOTS-290，ADR §2.3）：①D-272 用户提问保护——用户提问不并入
  // 非用户触发的挂起组（并入后提问只能挤在 Merged messages 段、没有直接回答锚点），提问
  // 组单独成组且优先放行；②窗口 coalesce_window_ms（默认 30s）——与组首入队时间差超过
  // 窗口不并；③上限 coalesce_max_messages（默认 5）——单组消息总数（首条+合并）封顶。
  drainPendingMessages() {
    const prefix = 'bot_pending_msgs:'
    const max = Number(this.store.setting('coalesce_max_messages', String(COALESCE_MAX_MESSAGES_DEFAULT)))
    // max<=1 = 关闭合批（与 D-287 入队合并同口径）；非法值同样回退为不并。
    const cap = Number.isFinite(max) && max > 1 ? max : 1
    const windowMs = Number(this.store.setting('coalesce_window_ms', String(COALESCE_WINDOW_MS_DEFAULT)))
    // DSHBOTS-308 旧键一次性迁移：308 前队列键无域段（bot_pending_msgs:<botId>），按
    // item.projectId ?? '~solo' 并入对应域键后删旧键（先写后删、按 messageId 去重，中断
    // 重跑幂等），防丢挂起消息——chat 项有 projectId、solo 项无=天然落 '~solo' 域。
    for (const row of this.store.all(`SELECT key, value FROM settings WHERE key LIKE '${prefix}%'`)) {
      const rest = row.key.slice(prefix.length)
      if (rest.includes(':')) continue
      const legacy = jsonParse(row.value, [])
      if (Array.isArray(legacy)) {
        for (const item of legacy) {
          const domain = item?.projectId ?? '~solo'
          const key = this.pendingMessagesKey(rest, domain)
          const list = jsonParse(this.store.setting(key), [])
          const safe = Array.isArray(list) ? list : []
          if (!safe.some(existing => existing?.messageId === item?.messageId)) {
            this.store.setSetting(key, JSON.stringify([...safe, item]))
          }
        }
      }
      this.store.run('DELETE FROM settings WHERE key = ?', row.key)
    }
    const rows = this.store.all(`SELECT key, value FROM settings WHERE key LIKE '${prefix}%'`)
    for (const row of rows) {
      const rest = row.key.slice(prefix.length)
      const colon = rest.indexOf(':')
      if (colon === -1) continue
      const botId = rest.slice(0, colon)
      const domain = rest.slice(colon + 1)
      let items = jsonParse(row.value, [])
      if (!Array.isArray(items) || !items.length) continue
      // DSHBOTS-304 挂起项去重清扫（建回前预检）：双投失败方挂起项与胜利方运行共存时——
      // 消息族建回永撞全局 UNIQUE idempotency_key 成永生占位，任务族按恒新幂等键重复建行；
      // 清扫在分组前完成，被覆盖/作废项直接消账，余项自然重组（同组合并不受影响）。
      // 幂等键/task 维度与域无关（全局口径），保持现状。
      const kept = items.filter(item => !this.heldItemSuperseded(botId, item))
      if (kept.length !== items.length) {
        this.store.setSetting(this.pendingMessagesKey(botId, domain), JSON.stringify(kept))
        if (!kept.length) continue
        items = kept
      }
      // DSHBOTS-308：busy 只看本域（bot, domain），他工作区队列本轮照常建回（并行）。
      if (this.botBusy(botId, domain)) continue
      const bot = this.store.get('SELECT * FROM bots WHERE id = ?', botId)
      if (!bot || bot.status !== 'active') {
        this.store.setSetting(this.pendingMessagesKey(botId, domain), '[]')
        continue
      }
      // 相邻同 kind 的 chat/solo_chat 挂起消息合成一组（用户提问只并入同为用户触发的组、
      // 窗口内、未超上限）；dm/dm_reply/task 独立成组逐条放行。
      const groups = []
      for (const item of items) {
        const last = groups[groups.length - 1]
        const mergeableKind = item.kind === 'chat' || item.kind === 'solo_chat'
        const withinWindow = Number.isFinite(windowMs)
          && Date.parse(item.queuedAt ?? '') - Date.parse(last?.first?.queuedAt ?? '') <= windowMs
        if (last && last.first.kind === item.kind && mergeableKind
          && last.first.projectId === item.projectId
          && last.merge.length + 1 < cap
          && withinWindow
          && this.heldItemIsUserQuestion(item) === this.heldItemIsUserQuestion(last.first)) {
          last.merge.push(item)
        } else {
          groups.push({ first: item, merge: [] })
        }
      }
      // 用户提问组优先放行（D-272 出队优先的队列侧对偶），sort 稳定保住组间先后。
      groups.sort((a, b) => Number(this.heldItemIsUserQuestion(b.first)) - Number(this.heldItemIsUserQuestion(a.first)))
      const consumed = new Set()
      for (const group of groups) {
        if (this.botBusy(botId, domain)) break
        const runId = this.insertHeldMessageRun(bot, group)
        if (!runId) break
        consumed.add(group.first.messageId)
        for (const entry of group.merge) consumed.add(entry.messageId)
        if (group.first.kind === 'dm' || group.first.kind === 'dm_reply') break
      }
      const leftover = items.filter(item => !consumed.has(item?.messageId))
      this.store.setSetting(this.pendingMessagesKey(botId, domain), JSON.stringify(leftover))
    }
  },

  // 建私信执行运行：目标 Bot 的 dm 会话收到来信，产出回信写入 bot_messages.reply。
  enqueueDmRun(message, target) {
    const existing = this.store.get(
      "SELECT id FROM runs WHERE kind = 'dm' AND trigger_ref = ?",
      message.id,
    )
    if (existing) return existing.id
    // 争用口径 A：bot 忙时不落 runs 行，挂待处理队列（一条来信一条回信，不合批）。
    // 域=dm 所属项目（项目外私信 project_id 为 NULL → '~solo'，DSHBOTS-308）。
    const domain = message.project_id ?? '~solo'
    if (this.botBusy(target.id, domain)) {
      this.holdPendingMessage(target.id, domain, { kind: 'dm', messageId: message.id, projectId: message.project_id, queuedAt: nowIso() })
      return null
    }
    const runId = id('run')
    const createdAt = nowIso()
    try {
      this.store.run(
        `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status,
          attempt, idempotency_key, queued_at)
         VALUES (?, ?, ?, 'dm', 'read', 'dm', ?, 'queued', 1, ?, ?)`,
        runId, message.project_id, target.id, message.id, `dm:${message.id}`, createdAt,
      )
    } catch (error: any) {
      if (this.isRunBotUniqueViolation(error)) {
        const merged = this.activeRunByIdempotencyKey(`dm:${message.id}`)
        if (merged) return merged
        this.holdPendingMessage(target.id, domain, { kind: 'dm', messageId: message.id, projectId: message.project_id, queuedAt: nowIso() })
        return null
      }
      throw error
    }
    this.store.run(
      "UPDATE bot_messages SET status = 'delivered', run_id = ? WHERE id = ?",
      runId, message.id,
    )
    this.insertRunEvent(runId, 'queued', '收到 team_message_bot 私信，开始处理')
    return runId
  },

  // 回信投递回发送方会话：忙时 steer 注入，闲时排 dm_reply 运行。
  deliverBotReply(message) {
    const caller = this.store.get('SELECT * FROM bots WHERE id = ?', message.from_bot_id)
    if (!caller || caller.status !== 'active') return null
    // 控制面收敛（DSHBOTS-289/299）：回信目标按收敛顺序解析——来源任务未终态时按 runs 归属
    // 亲和回原任务会话（steer/排运行都指向它），否则落发送方在 (bot, project) 维度的
    // kind='bot' 控制面绑定（project_id IS 兼容项目外私信的 NULL）。
    const originTask = message.origin_kind === 'task' && message.origin_task_id
      ? this.store.get('SELECT * FROM tasks WHERE id = ?', message.origin_task_id)
      : null
    const binding = (originTask ? this.runtime.taskAffinityBinding(originTask) : undefined)
      ?? this.store.get(
        "SELECT * FROM session_bindings WHERE bot_id = ? AND kind = 'bot' AND alias = 0 AND project_id IS ?",
        caller.id,
        message.project_id ?? null,
      )
    // 无绑定（会话被轮换清理或首次私信）：走 dm_reply 运行，由 startRun 重建会话。
    let plan
    if (!binding) {
      plan = 'run'
    } else {
      try {
        plan = deliveryPlan({ row: message, callerSessionBusy: this.runtime.sessionBusy(binding.session_id) })
      } catch (error: any) {
        this.logger.warn?.('dsh-team: 私信 %s 投递计划失败：%s', message.id, error?.message ?? error)
        return null
      }
    }
    if (plan === 'steer') {
      const fromBot = this.store.get('SELECT name FROM bots WHERE id = ?', message.to_bot_id)
      void this.runtime.steer(binding.session_id, replyDeliveryPrompt({
        fromBotName: fromBot?.name ?? 'teammate',
        reply: message.reply ?? '',
        originKind: message.origin_kind ?? 'project',
      }))
      this.insertRunEvent(message.run_id, 'reply_delivered', `回信已 steer 注入发送方会话（${message.id.slice(-6)}）`)
      return null
    }
    const runId = id('run')
    const createdAt = nowIso()
    // task_id 留空（one_active_run_per_task 不限 kind，任务排队中投回信会撞索引）；
    // 任务会话定位由 sessionKindFor→bot_messages.origin_kind 完成，不依赖 run.task_id。
    // 幂等：outbox 重投时不能重复建运行，否则唯一索引会直接把重试打成失败。
    const existingRun = this.store.get('SELECT id FROM runs WHERE idempotency_key = ?', `dm_reply:${message.id}`)
    if (existingRun) return existingRun.id
    try {
      this.store.run(
        `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
          attempt, idempotency_key, queued_at)
         VALUES (?, ?, ?, NULL, 'dm_reply', 'read', 'dm_reply', ?, 'queued', 1, ?, ?)`,
        runId, message.project_id, caller.id,
        message.id, `dm_reply:${message.id}`, createdAt,
      )
    } catch (error: any) {
      if (this.isRunBotUniqueViolation(error)) {
        const merged = this.activeRunByIdempotencyKey(`dm_reply:${message.id}`)
        if (merged) return merged
        const domain = message.project_id ?? '~solo'
        this.holdPendingMessage(caller.id, domain, { kind: 'dm_reply', messageId: message.id, projectId: message.project_id, queuedAt: nowIso() })
        return null
      }
      throw error
    }
    this.insertRunEvent(runId, 'queued', '私信回信排队投递给发送方会话')
    return runId
  },
  // triggerType（DSHBOTS-258）：'wechat' 表示消息来自微信通道（项目外 director 专属工作区），
  // 与群聊直达（enqueueChatRun 的 origin 口径）同语义——运行收尾据此把 solo 回复推回微信管理员。
  enqueueSoloChatRun(bot, messageId, { triggerType = 'mention' } = {}) {
    const existing = this.store.get(
      "SELECT id FROM runs WHERE trigger_ref = ? AND bot_id = ? AND kind = 'solo_chat'",
      messageId,
      bot.id,
    )
    if (existing) return existing.id
    // 争用口径 A：bot 忙时不落 runs 行，挂待处理队列，空闲后由 drainPendingMessages 合批建回。
    // solo_chat 运行 project_id 恒 NULL → 域恒 '~solo'（DSHBOTS-308）。
    if (this.botBusy(bot.id, '~solo')) {
      this.holdPendingMessage(bot.id, '~solo', { kind: 'solo_chat', messageId, triggerType, queuedAt: nowIso() })
      return null
    }
    const runId = id('run')
    const createdAt = nowIso()
    try {
      this.store.run(
        `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status,
          attempt, idempotency_key, queued_at)
         VALUES (?, NULL, ?, 'solo_chat', 'write', ?, ?, 'queued', 1, ?, ?)`,
        runId, bot.id, triggerType, messageId, `solo_chat:${messageId}`, createdAt,
      )
    } catch (error: any) {
      if (this.isRunBotUniqueViolation(error)) {
        const merged = this.activeRunByIdempotencyKey(`solo_chat:${messageId}`)
        if (merged) return merged
        this.holdPendingMessage(bot.id, '~solo', { kind: 'solo_chat', messageId, triggerType, queuedAt: nowIso() })
        return null
      }
      throw error
    }
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued',
      triggerType === 'wechat'
        ? '微信消息触发（项目外单聊直达）'
        : triggerType === 'feishu'
          ? '飞书消息触发（项目外单聊直达）'
          : '单聊消息触发',
      createdAt,
    )
    return runId
  },
  enqueueChatRun(project, bot, messageId, origin = null) {
    if (bot.status !== 'active') return null
    const existing = this.store.get(
      "SELECT id FROM runs WHERE trigger_ref = ? AND bot_id = ? AND kind = 'chat'",
      messageId,
      bot.id,
    )
    if (existing) return existing.id
    // 争用口径 A：bot 忙时不落 runs 行，挂待处理队列，空闲后由 drainPendingMessages 合批建回。
    // 域=chat 所属项目（DSHBOTS-308）。
    if (this.botBusy(bot.id, project.id)) {
      this.holdPendingMessage(bot.id, project.id, { kind: 'chat', messageId, projectId: project.id, origin, queuedAt: nowIso() })
      return null
    }
    const runId = id('run')
    const createdAt = nowIso()
    // 通道直达（DSHBOTS-208/329）：trigger_type 记来源通道（'wechat'/'feishu'），
    // 运行收尾据此把 bot 回复推回该通道管理员；普通群聊消息保持 'mention' 不推。
    const triggerType = originTriggerType(origin)
    try {
      this.store.run(
        `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status,
          attempt, idempotency_key, queued_at)
         VALUES (?, ?, ?, 'chat', 'read', ?, ?, 'queued', 1, ?, ?)`,
        runId, project.id, bot.id, triggerType, messageId, `chat:${messageId}:${bot.id}`, createdAt,
      )
    } catch (error: any) {
      if (this.isRunBotUniqueViolation(error)) {
        const merged = this.activeRunByIdempotencyKey(`chat:${messageId}:${bot.id}`)
        if (merged) return merged
        this.holdPendingMessage(bot.id, project.id, { kind: 'chat', messageId, projectId: project.id, origin, queuedAt: nowIso() })
        return null
      }
      throw error
    }
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued',
      triggerType === 'wechat'
        ? '微信群聊消息触发（直达）'
        : triggerType === 'feishu'
          ? '飞书群聊消息触发（直达）'
          : '群聊消息触发',
      createdAt,
    )
    return runId
  },
  async cancelRunInternal(runId, updateTask = true) {
    const run = this.runRow(runId)
    if (!['queued', 'running'].includes(run.status)) return run
    await this.runtime?.cancelRun(runId)
    this.store.run(
      "UPDATE runs SET status = 'canceled', ended_at = ?, cancel_requested = 1 WHERE id = ?",
      nowIso(),
      runId,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'canceled', '运行已取消', nowIso(),
    )
    if (updateTask && run.task_id) {
      this.setTaskStatus(run.task_id, 'todo', { type: 'system', id: 'system' }, { ifIs: 'in_progress' })
      this.addTaskEvent(run.task_id, 'run_canceled', { type: 'system', id: 'system' }, { runId })
    }
    return this.runRow(runId)
  },
  async cancelRun(runId, actor = this.actor()) {
    const run = this.runRow(runId)
    await this.cancelRunInternal(runId, true)
    this.audit(actor, 'run.cancel', 'run', runId, {})
    return this.runRow(runId)
  },

  // 运行轨迹：模型回合、思考文本、助手文本、工具调用与工具结果的展示账本。
  runTrajectory(runId) {
    const run = this.runRow(runId)
    const rows = this.store.all(
      'SELECT seq, kind, title, detail, turn, step, created_at FROM run_trajectory WHERE run_id = ? ORDER BY seq ASC',
      run.id,
    )
    return {
      runId: run.id,
      entries: rows.map(row => ({
        seq: row.seq,
        kind: row.kind,
        title: row.title,
        detail: row.detail,
        turn: row.turn ?? null,
        step: row.step ?? null,
        at: row.created_at,
      })),
    }
  },
  async cancelRunsForTask(taskId) {
    const runs = this.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", taskId)
    for (const run of runs) await this.cancelRunInternal(run.id, false)
  },
  // 看板拖出执行中（todo/blocked）：任务主动暂停而非终局取消，
  // error_code='PAUSED_BY_BOARD' 让它与 SUPERSEDED（清理冗余，不进执行历史）区分开，保留可重试的执行历史。
  async pauseRunsForBoard(taskId) {
    const runs = this.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", taskId)
    let paused = 0
    for (const run of runs) {
      await this.runtime?.cancelRun(run.id)
      const changed = this.store.run(
        "UPDATE runs SET status = 'canceled', ended_at = ?, cancel_requested = 1, error_code = 'PAUSED_BY_BOARD', error_message = ? WHERE id = ? AND status IN ('queued', 'running')",
        nowIso(), '任务被移出执行中，运行暂停', run.id,
      )
      if (Number(changed?.changes ?? 0) === 1) {
        this.insertRunEvent(run.id, 'board_pause', '任务被移出执行中，看板暂停')
        paused += 1
      }
    }
    return paused
  },
  async retryRun(runId, actor = this.actor()) {
    const run = this.runRow(runId)
    if (!['failed', 'canceled'].includes(run.status)) throw conflict('只有失败或已取消的运行可以重试')
    if (!run.task_id) throw badRequest('群聊运行不自动重试，请重新发送消息')
    const task = this.taskRow(run.task_id)
    const active = this.store.get("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)
    if (active) throw conflict('该任务已有活动运行')
    if (!task.assignee_bot_id) throw badRequest('任务没有负责人')
    const newRunId = id('run')
    const createdAt = nowIso()
    // 重试同样按任务当前的写范围声明快照。
    const writeScopes = JSON.stringify(readWriteScopes(task.write_scopes))
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, write_scopes, queued_at)
       VALUES (?, ?, ?, ?, 'task', 'write', 'retry', ?, 'queued', ?, ?, ?, ?)`,
      newRunId, task.project_id, task.assignee_bot_id, task.id, task.id,
      Number(run.attempt) + 1, `retry:${task.id}:${Date.now()}:${newRunId}`, writeScopes, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), newRunId, 'queued', `重试 ${run.attempt}`, createdAt,
    )
    this.addTaskEvent(task.id, 'retried', actor, { runId: newRunId, previousRunId: runId })
    void this.tick()
    return this.store.get('SELECT * FROM runs WHERE id = ?', newRunId)
  },
  async executeRun(runId) {
    const run = this.runRow(runId)
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
    const project = run.project_id ? this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id) : null
    // 配置版本快照（C2/DSHBOTS-334）：任务运行独占会话（D-308），本运行的治理配置即
    // 派发时刻的生效值——bot 角色版本（bots.current_revision）+ 可编辑提示词段覆盖正文
    // （缺省段记 null，默认文本随发版可追溯）+ 实际下发模型（runs 行三列，D-25）。
    // 回答「这张卡按哪版规则跑的」；只记账不闸门（ADR §3：变更不撤销在途，恢复前复核
    // 由派发链闸门承担）。只对 kind='task' 记：消息族运行共用控制面冻结会话（D-91），
    // 生效文本是冻结时的旧值，快照「当时 settings」反而误导。
    if (run.kind === 'task') {
      const overrides = parsePromptOverrides(this.store.setting('prompt_overrides', ''))
      const segments = Object.fromEntries(
        Object.keys(PROMPT_SEGMENT_DEFAULTS).map(key => [key, overrides?.[key]?.text ?? null]),
      )
      const model = run.model_provider
        ? { provider: run.model_provider, model: run.model_model, effort: run.model_effort ?? null }
        : { provider: bot.provider, model: bot.model, effort: bot.effort ?? null }
      this.store.run(
        'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
        id('evt'), run.id, 'config_snapshot',
        JSON.stringify({ bot_revision: Number(bot.current_revision) || 0, model, prompt_segment_overrides: segments }),
        nowIso(),
      )
    }
    try {
      const task = run.task_id ? this.taskRow(run.task_id) : null
      // DSHBOTS-112：vision 派生运行按 project_id 归位原消息（群聊 messages / 单聊
      // solo_messages），trigger_ref 即原消息 id——startRun 据此把附图随首条 prompt
      // 带给代理模型（与 chat/solo_chat 同一链路）。
      const chatMessage = (run.kind === 'chat' || (run.kind === 'vision' && run.project_id)) && run.trigger_ref
        ? this.store.get('SELECT * FROM messages WHERE id = ?', run.trigger_ref)
        : (run.kind === 'solo_chat' || (run.kind === 'vision' && !run.project_id)) && run.trigger_ref
          ? this.store.get('SELECT * FROM solo_messages WHERE id = ?', run.trigger_ref)
          : null
      // 合批消息（DSHBOTS-231）：领取时合并进来的同通道排队消息，与触发消息同一轮注入。
      const extraMessages = this.mergedMessagesFor(run)
      if (run.mode === 'read') this.fingerprints.set(runId, this.workspaceFingerprint(project))
      const sessionKind = this.sessionKindFor(run)
      await this.runtime.startRun({
        run,
        bot,
        project,
        task: task ?? this.sessionTaskFor(run, sessionKind),
        chatMessage,
        extraMessages,
        sessionKind,
      })
    } catch (error: any) {
      this.logger.warn?.('dsh-team: run %s failed to start: %s', runId, error)
      this.fingerprints.delete(runId)
      await this.finishRun({
        runId,
        status: 'failed',
        output: '',
        error: {
          code: error?.code ?? 'START_FAILED',
          message: error?.message ?? String(error),
        },
      })
    }
  },

  // 跨类别运行的目标会话类别：dm_reply 按来信来源的类别。
  sessionKindFor(run) {
    // DSHBOTS-112：单聊读图代理运行落 bot 的 solo 会话（与 solo_chat 同一绑定）。
    if (run.kind === 'vision' && !run.project_id) return 'solo'
    if (run.kind === 'dm_reply') {
      const message = run.trigger_ref
        ? this.store.get('SELECT origin_kind FROM bot_messages WHERE id = ?', run.trigger_ref)
        : null
      return message?.origin_kind === 'task' ? 'task' : message?.origin_kind === 'dm' ? 'dm' : 'project'
    }
    return undefined
  },

  // dm_reply 的 runs.task_id 留空（避开 one_active_run_per_task 索引），
  // 但它要落进来源的那个任务会话：这里把任务行解析出来交给 runtime，
  // runtime 才能按 task 类别找回同一条会话绑定，而不是退化成项目会话。
  sessionTaskFor(run, sessionKind) {
    if (sessionKind !== 'task') return null
    let taskId = null
if (run.kind === 'dm_reply') {
      const message = run.trigger_ref
        ? this.store.get('SELECT origin_task_id FROM bot_messages WHERE id = ?', run.trigger_ref)
        : null
      taskId = message?.origin_task_id ?? null
    }
    if (!taskId) return null
    return this.store.get('SELECT * FROM tasks WHERE id = ?', taskId) ?? null
  },

  // 合批消息（DSHBOTS-231）：本运行领取时合并进来的同通道排队消息。
  // 按 merged_messages 记录的消息 id 顺序取回；消息已被删除的条目跳过，不阻塞本次运行。
  // 两张消息表的列不完全一致（solo_messages 没有 reply_to_id），按运行类别选列。
  mergedMessagesFor(run) {
    const ids = jsonParse(run.merged_messages, [])
    if (!Array.isArray(ids) || !ids.length) return []
    const columns = run.kind === 'solo_chat'
      ? 'id, sender_type, sender_id, body'
      : 'id, sender_type, sender_id, body, reply_to_id'
    const table = run.kind === 'solo_chat' ? 'solo_messages' : 'messages'
    const rows = []
    for (const messageId of ids) {
      const row = this.store.get(`SELECT ${columns} FROM ${table} WHERE id = ?`, messageId)
      if (row) rows.push(row)
    }
    return rows
  },
  insertRunEvent(runId, type, message) {
    if (!runId) return
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, type, this.maskSecretValues(message), nowIso(),
    )
  },

  // 成功写运行的交付产物清单：项目目录 git status 的相对路径快照（M/A/?? 状态），
  // 再用 git check-ignore 剔除 .gitignore 排除的路径。非 git 仓库或 git 不可用时跳过并记
  // run_event；清单上限 200 条，不复制文件内容。
  captureRunArtifacts(run, project) {
    const dir = this.projectWorkDir(project)
    if (!existsSync(join(dir, '.git'))) {
      this.insertRunEvent(run.id, 'artifacts_skipped', '项目工作区不是 git 仓库，跳过产物记录')
      return null
    }
    let raw
    try {
      raw = execFileSync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall'], {
        cwd: dir,
        timeout: 5_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      this.insertRunEvent(run.id, 'artifacts_skipped', 'git 不可用，跳过产物记录')
      return null
    }
    const list = []
    for (const line of String(raw).split('\n')) {
      if (line.length < 4) continue
      // porcelain 的两字状态位是「索引位 + 工作区位」：' M' 是改了工作区，'AM' 是先加后改，
      // 两处都脏就都写出来。删除（' D'）不算产物，其余状态不收。
      const statusField = line.slice(0, 2)
      let path = line.slice(3).trim()
      if (!path || path.startsWith('"')) continue
      let status
      if (statusField === '??') {
        status = '??'
      } else if (statusField.includes('R')) {
        // 重命名：porcelain 形如 "R  old -> new"，只认新路径。
        const arrow = path.indexOf(' -> ')
        if (arrow === -1) continue
        path = path.slice(arrow + 4).trim()
        if (!path) continue
        status = 'R'
      } else if (statusField.includes('A')) {
        status = 'A'
      } else if (statusField.includes('M')) {
        status = 'M'
      } else {
        continue
      }
      list.push({ path, status })
      if (list.length >= 200) break
    }
    if (!list.length) return null
    // 清单是给人看「这次改了什么」的，不收 .gitignore 排除的文件。git status 本身不列
    // ignored 的未跟踪文件，但「ignore 规则补上之前就已存在」的路径与「已跟踪但后被
    // ignore」的脏文件仍会混进来，这里对全部候选路径统一二次过滤（含已跟踪文件）。
    // 必须带 --no-index：check-ignore 默认查索引，已跟踪文件一律不判为 ignored，
    // --no-index 才会纯按 ignore 规则匹配出这类脏文件。
    // check-ignore 退出码 0=有命中、1=无命中都算正常；其余退出码视为过滤失败，
    // 保留原清单并记 run_event，不静默吞掉。
    try {
      const check = spawnSync('git', ['-c', 'core.quotePath=false', 'check-ignore', '--no-index', '--stdin'], {
        cwd: dir,
        timeout: 5_000,
        encoding: 'utf8',
        input: list.map(item => item.path).join('\n'),
      })
      if (check.status === 0 || check.status === 1) {
        const ignored = new Set(String(check.stdout ?? '').split('\n').filter(Boolean))
        const filtered = list.filter(item => !ignored.has(item.path))
        return filtered.length ? JSON.stringify(filtered) : null
      }
      this.insertRunEvent(run.id, 'artifacts_ignore_failed', `git check-ignore 异常退出（${check.signal ?? check.status}），清单未做忽略过滤`)
    } catch {
      this.insertRunEvent(run.id, 'artifacts_ignore_failed', 'git check-ignore 不可用，清单未做忽略过滤')
    }
    return JSON.stringify(list)
  },

  // 项目目录的 git 指纹；不是 git 仓库时返回 null，跳过审计。
  workspaceFingerprint(project) {
    if (!project?.slug) return null
    const dir = this.projectWorkDir(project)
    if (!existsSync(join(dir, '.git'))) return null
    try {
      return execFileSync('git', ['status', '--porcelain'], {
        cwd: dir,
        timeout: 5_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return null
    }
  },

  // 只读运行（群聊、验收、受阻处理）不应该改文件；改了就在群里点名。
  // DSHBOTS-94：指纹变化先归因——窗口内（started_at→结束时刻）存在并发写运行且变化
  // 落在其写范围内（或其未声明范围）时不点名，改记 run_event 留痕；只有无人认领的
  // 变化才维持点名告警，告警里带上对不上号的并发写运行号。
  auditReadRunWrites(run, project) {
    if (run.mode !== 'read' || !this.fingerprints.has(run.id)) {
      this.fingerprints.delete(run.id)
      return
    }
    const before = this.fingerprints.get(run.id)
    this.fingerprints.delete(run.id)
    if (before === null || !project) return
    const after = this.workspaceFingerprint(project)
    if (after === null || after === before) return
    // finishRun 在更新 runs 行之前调用本方法，此时 run.ended_at 还没落库，用当前时刻收口。
    const windowEnd = run.ended_at ?? nowIso()
    const windowStart = run.started_at ?? run.queued_at ?? windowEnd
    const concurrentWrites = (this.store.all(
      `SELECT r.id, r.write_scopes, t.number AS task_number
       FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
       WHERE r.project_id = ? AND r.mode = 'write' AND r.id != ?
         AND r.started_at IS NOT NULL AND r.started_at <= ?
         AND (r.ended_at IS NULL OR r.ended_at >= ?)`,
      project.id, run.id, windowEnd, windowStart,
    ) ?? []).map(row => ({
      id: row.id,
      label: row.task_number ? `${project.key}-${row.task_number}` : row.id,
      scopes: readWriteScopes(row.write_scopes),
    }))
    const decision = attributeWorkspaceChange({ before, after, concurrentWrites })
    if (decision.silent) {
      this.insertRunEvent(
        run.id,
        'read_audit_attributed',
        `工作区变化已归因到并发写运行（${decision.attributedTo.join('、')}），不点名只读运行`,
      )
      return
    }
    const suspectNote = decision.suspects.length
      ? `（存在并发写运行 ${decision.suspects.join('、')}，但变化不在其写范围内）`
      : ''
    // 同指纹去重（DSHBOTS-96 P1-2）：after 内容 hash 相同说明是同一工作区状态再次被扫到，
    // 已点名过就不再重复插群消息，只留 run_event 供追溯。
    const dedupKey = `${project.id}:${sha256(after)}`
    if (this.readAuditAlerted.has(dedupKey)) {
      this.insertRunEvent(run.id, 'read_audit_dup', '工作区指纹与已告警记录相同，本次不重复点名')
      this.logger.warn?.('dsh-team: read-only run %s changed the workspace (duplicate fingerprint, alert suppressed)', run.id)
      return
    }
    this.readAuditAlerted.set(dedupKey, run.id)
    this.insertMessage({
      projectId: project.id,
      senderType: 'system',
      senderId: 'system',
      body: `⚠️ 工作区在只读运行（${run.kind}，运行 ${run.id}）期间被修改，未归因到并发写运行${suspectNote}：\n\`\`\`\n${after.slice(0, 400)}\n\`\`\`\n若此变更应由任务产出，请立卡跟进。`,
      taskId: run.task_id ?? undefined,
      runId: run.id,
    })
    this.logger.warn?.('dsh-team: read-only run %s changed the workspace', run.id)
  },
  runView(run) {
    const bot = this.store.get('SELECT name, provider, model, fallback_provider, fallback_model, file_policy FROM bots WHERE id = ?', run.bot_id)
    const task = run.task_id ? this.store.get('SELECT number, title, sandbox_override FROM tasks WHERE id = ?', run.task_id) : undefined
    const project = run.project_id ? this.store.get('SELECT key FROM projects WHERE id = ?', run.project_id) : undefined
    // recovery 是重启恢复的内部瞬态标记（置位→注入→清零），不属于 API 视图，随 attention_json 一并剥出。
    // merged_messages 是合批消息 id 列表（DSHBOTS-231），同样剥出原始 JSON，只给解析后的 id。
    const { write_scopes: rawScopes, attention_json: attentionJson, merged_messages: mergedRaw, recovery: _recovery, ...rest } = run
    const fallbackRef = bot?.fallback_provider && bot?.fallback_model ? `${bot.fallback_provider}/${bot.fallback_model}` : null
    const usedRef = run.model_provider && run.model_model ? `${run.model_provider}/${run.model_model}` : null
    return {
      ...rest,
      artifacts: jsonParse(run.artifacts, []),
      attention: parseAttention(attentionJson),
      mergedMessageIds: Array.isArray(jsonParse(mergedRaw, [])) ? jsonParse(mergedRaw, []) : [],
      botName: bot?.name ?? 'Bot',
      taskIdentifier: task ? `${project?.key ?? 'T'}-${task.number}` : null,
      taskTitle: task?.title ?? null,
      writeScopes: readWriteScopes(rawScopes),
      // 生效沙箱档（DSHBOTS-156）：非 write 运行恒 read-only，任务写运行取派发覆盖（只收紧）或 bot 配置档。
      // 口径唯一来源 effectiveSandbox，与起会话落 run_events 的档位一致。
      sandboxMode: effectiveSandbox(run, bot, task).mode ?? null,
      // 备用模型标记：configured=配了备用，applied=这条运行走了备用，
      // degraded=主模型不可用且配了备用但这条没走（自动切换只对任务运行生效）。
      modelFallback: {
        configured: Boolean(fallbackRef),
        ref: fallbackRef,
        applied: Boolean(usedRef),
        usedModel: usedRef ?? (bot?.provider && bot?.model ? `${bot.provider}/${bot.model}` : null),
        degraded: Boolean(fallbackRef) && !usedRef && isProviderUnavailableCode(run.error_code),
      },
    }
  },

  // 回答结构化提问（DSHBOTS-43）：仅负责人（owner）可调。
  // 回答作为一条 @该 bot 的群聊消息投回原会话（复用既有 chat 投递通道，触发 chat_run），
  // 单聊运行走 solo 通道；同时清空 attention_json 并记 run_events 'attention_answered'。
  async answerAttention(runId, answer, actor = this.actor()) {
    if (actor?.type !== 'user') throw forbidden('只有项目负责人可以回答结构化提问')
    const cleanAnswer = text(answer, 20_000)
    if (!cleanAnswer) throw badRequest('回答不能为空')
    ensureAttentionSchema(this.store)
    const run = this.runRow(runId)
    const attention = parseAttention(run.attention_json)
    if (!attention) throw conflict('该运行没有待回答的结构化提问')
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
    if (!bot) throw notFound('运行的 Bot 已不存在')
    if (run.project_id) {
      const messageId = this.insertMessage({
        projectId: run.project_id,
        senderType: 'user',
        senderId: actor?.id ?? this.localUserId,
        body: `回复提问「${attention.question}」：${cleanAnswer}`,
        mentions: [bot.id],
        runId,
      })
      if (messageId) {
        this.enqueueOutbox({
          kind: 'chat_run',
          payload: { projectId: run.project_id, botId: bot.id, messageId },
          projectId: run.project_id,
          sourceId: messageId,
          idempotencyKey: `chat:${messageId}:${bot.id}`,
        })
      }
    } else {
      const messageId = this.insertSoloMessage({
        botId: bot.id,
        senderType: 'user',
        senderId: actor?.id ?? this.localUserId,
        body: `回复提问「${attention.question}」：${cleanAnswer}`,
        runId,
      })
      if (messageId) {
        this.enqueueOutbox({
          kind: 'solo_chat_run',
          payload: { botId: bot.id, messageId },
          projectId: null,
          sourceId: messageId,
          idempotencyKey: `solo:${messageId}`,
        })
      }
    }
    this.store.run('UPDATE runs SET attention_json = NULL WHERE id = ?', runId)
    this.insertRunEvent(runId, 'attention_answered', `负责人已回答提问：${attention.question}`)
    this.audit(actor, 'attention.answer', 'run', runId, { question: attention.question })
    void this.tick()
    return this.runView(this.runRow(runId))
  },

  // 产物清单视图：HTTP 端点与运行详情面板共用。
  listRunArtifacts(runId) {
    const run = this.runRow(runId)
    const list = jsonParse(run.artifacts, [])
    return { runId, artifacts: Array.isArray(list) ? list : [] }
  },

  // 产物文件定位：仅允许读取该运行清单里的相对路径，且必须落在项目工作区内（含符号链接校验）。
  artifactFile(runId, relPath) {
    const run = this.runRow(runId)
    const project = run.project_id
      ? this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id)
      : null
    if (!project?.slug) throw notFound('运行没有关联的项目工作区')
    const list = jsonParse(run.artifacts, [])
    if (!Array.isArray(list) || !list.some(item => item?.path === relPath)) {
      throw forbidden('文件不在该运行的产物清单中')
    }
    const dir = this.projectWorkDir(project)
    let absolutePath
    try {
      absolutePath = assertInside(dir, join(dir, relPath))
    } catch {
      throw forbidden('产物路径越界')
    }
    let info
    try {
      info = statSync(absolutePath)
    } catch {
      throw notFound('产物文件不存在')
    }
    if (!info.isFile()) throw notFound('产物不是常规文件')
    const realFile = realpathSync(absolutePath)
    const realDir = realpathSync(dir)
    if (realFile === realDir || !realFile.startsWith(realDir + sep)) throw forbidden('产物路径越界')
    return { absolutePath, size: info.size }
  },
}
