// src/services/runtime/lifecycle.js —— 事件绑定与超时取消域
// 宿主事件订阅、子会话归属、用量记账、超时与取消。
// 本文件只放方法体，方法挂到 DshRuntime 原型上（见 src/runtime.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { randomUUID } from 'node:crypto'
import { recordUsage } from '../../usage.js'
import { nowIso, sha256, stripLeakedToolMarkup } from '../../util.js'
import { contentText, reasonOf } from './trajectory.js'
import { convertImagesForUpload, toImageContentParts } from '../message-images.js'

// teammate 等子会话的父指向在不同 DSH 版本里字段不一，逐个探测。
export const PARENT_ACCESSORS = [
  session => session?.parentSessionId,
  session => session?.parentId,
  session => session?.parent?.sessionId,
  session => session?.parent?.id,
  session => session?.parent,
  session => session?.subagent?.parentSessionId,
  session => session?.subagent?.parent?.sessionId,
  session => session?.meta?.parentSessionId,
  session => session?.meta?.parent,
  session => session?.descriptor?.parentSessionId,
  session => session?.address?.parent,
]

export function sessionParentId(session) {
  for (const accessor of PARENT_ACCESSORS) {
    let value
    try {
      value = accessor(session)
    } catch {
      continue
    }
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

export function isSubagentLike(session) {
  return Boolean(session?.subagent) || session?.mode === 'subagent' || sessionParentId(session) !== undefined
}

// strip-tool-markup:start
// provider 偶发把工具调用序列化成普通 text 块（真实样本形如
// `<tool_call>\n]<]minimax[>[<invoke name="read">]<]minimax[>[<file_path>...<offset>1858`）。
// 整段只剩这类标记残片的文本不是交付报告，运行收尾选文本时丢弃并回退更早的正常正文。
// 判定分两步：先看是否带泄漏标记，没带标记的普通文本（含短回复）直接保留；
// 带标记的再复用 util 的 stripLeakedToolMarkup 剥壳，剥完字母/汉字数低于阈值即「整段残片」，
// 剥完仍有成段散文的正常正文不会被误伤。
const TOOL_MARKUP_MARKERS = [
  /<tool_call>/,
  /<invoke\b/,
  /<\][\w.-]*\[>/, // 形如 <]minimax[> 的括号残渣
]
const MIN_DELIVERABLE_PROSE_CHARS = 12

export function isToolMarkupFragment(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  if (!TOOL_MARKUP_MARKERS.some(pattern => pattern.test(value))) return false
  const prose = stripLeakedToolMarkup(value).match(/\p{L}/gu)
  return (prose?.length ?? 0) < MIN_DELIVERABLE_PROSE_CHARS
}

// 运行收尾的交付文本选择：texts 按时间升序存各轮非空 text 块（最后一轮即 lastText），
// 从后往前取第一段非残片正文；整轮只有残片就回退更早的正常正文，再没有返回 ''，
// 由收尾按「模型未返回文本」处理。
export function selectDeliverableText(texts) {
  const list = Array.isArray(texts) ? texts : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const value = list[i]
    if (typeof value !== 'string' || !value.trim()) continue
    if (isToolMarkupFragment(value)) continue
    return value
  }
  return ''
}
// strip-tool-markup:end

export const lifecycleMethods = {
  attach() {
    if (this.attached) return
    this.attached = true
    const off = this.ctx.on?.('session/event', (session, event) => this.handleEvent(session, event))
    this.ctx.effect?.(() => () => {
      off?.()
      for (const pending of this.pending.values()) clearTimeout(pending.timer)
      this.pending.clear()
      this.pendingByRun.clear()
      this.childOwner.clear()
      this.parentHints.clear()
      this.promptFreeze.clear()
    }, 'dsh-team: runtime event binding')
    const offModels = this.ctx.on?.('llm/adapters-updated', () => {
      this.modelsCache = { at: 0, value: [] }
    })
    this.ctx.effect?.(() => () => offModels?.(), 'dsh-team: model cache invalidation')
    this.installPrompt()
  },
  installPrompt() {
    const systemPrompt = this.ctx.systemPrompt
    if (!systemPrompt?.section) return
    this.ctx.effect?.(() => {
      const disposeSection = systemPrompt.section({
        name: 'dsh-team-bot-identity',
        order: 620,
        interpolate: false,
        text: context => this.systemPromptFor(context),
      })
      // 记忆块走宿主 runtime-context 通道（D-85 方案 A）：渲染为历史尾部 user 快照，
      // 文本变化才追加，前缀缓存不动；interpolate:false 防记忆文本里的 {{ }} 被变量插值。
      const disposeMemory = systemPrompt.context
        ? systemPrompt.context({
          name: 'dsh-team-memory',
          order: 620,
          interpolate: false,
          text: context => this.memoryContextFor(context),
        })
        : null
      return () => {
        disposeMemory?.()
        disposeSection?.()
      }
    }, 'dsh-team: bot identity')
  },

  // teammate 子会话只贡献用量，不参与根运行的 turn 生命周期。
  ownerForChild(session) {
    const sessionId = session?.id
    if (!sessionId) return undefined
    const cachedRun = this.childOwner.get(sessionId)
    if (cachedRun) return this.pendingByRun.get(cachedRun)
    let cursor = sessionId
    const seen = new Set([sessionId])
    while (cursor) {
      const parentId = this.parentHints.get(cursor)
      if (!parentId || seen.has(parentId)) break
      seen.add(parentId)
      const root = this.pending.get(parentId)
      if (root) {
        this.childOwner.set(sessionId, root.runId)
        return root
      }
      cursor = parentId
    }
    // 兜底：只有一个运行在飞行中时，可确认是子代理来源的会话归给它。
    if (this.pending.size === 1 && isSubagentLike(session)) {
      const only = [...this.pending.values()][0]
      this.childOwner.set(sessionId, only.runId)
      return only
    }
    return undefined
  },
  noteParent(session) {
    const sessionId = session?.id
    if (!sessionId || this.parentHints.has(sessionId)) return
    const parentId = sessionParentId(session)
    if (parentId) this.parentHints.set(sessionId, parentId)
  },
  releaseAttribution(runId) {
    for (const [sessionId, ownerRunId] of this.childOwner) {
      if (ownerRunId !== runId) continue
      this.childOwner.delete(sessionId)
      this.parentHints.delete(sessionId)
    }
  },
  async recordUsageEvent(pending, event, sessionId) {
    const usage = event.data?.usage
    if (!usage) return
    pending.usageCounter += 1
    const occurredAt = Number.isFinite(event.time) ? new Date(event.time).toISOString() : nowIso()
    // 幂等键必须只依赖事件自身身份，不能依赖处理时刻或进程内顺序，
    // 否则同一事件重放会写成两条用量。
    const messageId = String(event.data?.message?.id ?? event.id ?? event.data?.id ?? '')
    const fingerprint = messageId || sha256(JSON.stringify(usage))
    pending.usageCounters = pending.usageCounters ?? new Map()
    const ordinal = pending.usageCounters.get(fingerprint) ?? 0
    pending.usageCounters.set(fingerprint, ordinal + 1)
    const sourceKey = `run:${pending.runId}:sess:${sessionId}:turn:${pending.turn ?? 0}:msg:${fingerprint}:${ordinal}`
    const row = recordUsage(this.store, {
      sourceKey,
      sourceEventId: messageId || null,
      run: { id: pending.runId, project_id: pending.projectId, bot_id: pending.bot.id },
      provider: pending.bot.provider ?? '',
      model: pending.bot.model ?? '',
      usage,
      occurredAt,
    })
    if (!row) return
    pending.tokens = (pending.tokens ?? 0)
      + row.input_tokens + row.cache_read_tokens + row.cache_write_tokens + row.output_tokens + row.reasoning_tokens
    const cap = this.config.maxRunTokens
    if (cap && pending.tokens > cap && !pending.aborting) {
      pending.aborting = true
      await this.abortRun(pending, {
        code: 'RUN_BUDGET_EXCEEDED',
        message: `运行累计 ${pending.tokens} token，超过单运行上限 ${cap}，已中止`,
      })
    }
  },
  async abortRun(pending, error) {
    clearTimeout(pending.timer)
    this.pending.delete(pending.sessionId)
    this.pendingByRun.delete(pending.runId)
    this.releaseAttribution(pending.runId)
    // 被主动中止的运行没有 turn/end 事件，轨迹里补一条结束条目。
    this.recordTrajectory(pending, {
      type: 'turn/end',
      data: { reason: { kind: 'aborted', error: { message: error?.message ?? '' } } },
    })
    await this.cancelSession(pending.sessionId).catch(() => {})
    await this.completionHandler?.({
      runId: pending.runId,
      status: 'failed',
      output: selectDeliverableText(pending.texts),
      error,
    })
  },
  touchProgress(runId) {
    this.store.run('UPDATE runs SET last_progress_at = ? WHERE id = ?', nowIso(), runId)
  },
  async handleEvent(session, event) {
    const sessionId = session?.id
    if (!sessionId) return
    this.noteParent(session)
    const root = this.pending.get(sessionId)
    if (!root) {
      const owner = this.ownerForChild(session)
      if (!owner) return
      const type = event?.type
      if (type === 'assistant/message') {
        this.touchProgress(owner.runId)
        await this.recordUsageEvent(owner, event, sessionId)
      }
      // 子代理会话只追加思考与工具条目，不重复根运行的回合边界。
      this.recordTrajectory(owner, event, { root: false })
      return
    }
    this.recordTrajectory(root, event, { root: true })
    if (event?.type === 'turn/start') {
      root.started = true
      root.turn = event.data?.turn
      return
    }
    if (event?.type === 'assistant/message') {
      if (!root.started) return
      const textValue = contentText(event.data?.message?.content)
      if (textValue.trim()) {
        root.lastText = textValue
        root.texts.push(textValue)
      }
      this.touchProgress(root.runId)
      await this.recordUsageEvent(root, event, sessionId)
      return
    }
    if (event?.type !== 'turn/end' || !root.started) return
    clearTimeout(root.timer)
    this.pending.delete(sessionId)
    this.pendingByRun.delete(root.runId)
    const reason = reasonOf(event)
    const failed = reason.kind === 'error' || reason.kind === 'aborted'
    const output = selectDeliverableText(root.texts)
    const error = failed
      ? {
          code: reason.kind === 'aborted' ? 'ABORTED' : (reason.error?.code ?? 'MODEL_ERROR'),
          message: reason.error?.message ?? (reason.kind === 'aborted' ? '运行被中止' : '模型调用失败'),
          // 限流退避只有 provider 真发 Retry-After 才有值（宿主 failureSnapshot 已校验正有限数），拿不到就是 null，不伪造。
          retryAfterMs: reason.kind === 'error' && Number.isFinite(reason.error?.providerRetryAfterMs) && reason.error.providerRetryAfterMs > 0
            ? reason.error.providerRetryAfterMs
            : null,
        }
      : null
    this.releaseAttribution(root.runId)
    await this.completionHandler?.({
      runId: root.runId,
      status: error ? 'failed' : 'succeeded',
      output,
      error,
    })
  },
  async timeoutRun(runId) {
    const pending = this.pendingByRun.get(runId)
    if (!pending) return
    // 中止文案用启动时定格的时效，而不是当下生效值（进行中不追溯）。
    const runTimeoutMs = pending.runTimeoutMs ?? this.config.runTimeoutMs
    await this.abortRun(pending, {
      code: 'RUN_TIMEOUT',
      message: `运行超过 ${Math.round(runTimeoutMs / 60000)} 分钟，已中止`,
    })
  },
  async cancelSession(sessionId) {
    if (!sessionId) return
    try {
      // 公开 Remote 契约：内部走 agent.cancel({kind:'user'},{keepInbox:true})，
      // 不再直持内部 agent 对象，也不会清空待处理收件箱。
      await this.ctx.sessionController.cancel({ sessionId })
    } catch (error) {
      this.logger.warn?.('dsh-team: cancel session %s failed: %s', sessionId, error)
    }
  },
  async cancelRun(runId) {
    const pending = this.pendingByRun.get(runId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pending.delete(pending.sessionId)
    this.pendingByRun.delete(runId)
    this.releaseAttribution(runId)
    await this.cancelSession(pending.sessionId)
    return true
  },

  // 向运行中的会话追加一条人类输入：优先中途 steer，失败则退回排队投递。
  // images 可选：宿主的 PromptContentPart 支持 image 分片，不传时行为与从前完全一致。
  async steer(sessionId, body, images = []) {
    if (!sessionId || !this.ctx?.sessionController) return false
    // 中途注入的图片同样做大 PNG → JPEG 归一（无 sharp/转码失败回退原图，不阻塞投递）。
    const prepared = await convertImagesForUpload(images, this.config?.imagePngJpegThresholdBytes ?? 0, this.logger)
    const content = [{ type: 'text', text: body }, ...toImageContentParts(prepared)]
    try {
      // 公开 Remote 契约：宿主内部会构造完整用户消息（id/role/source）再 agent.steer，
      // 避免裸 content 在并发投递时撞 message.id 去重键。
      await this.ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'steer',
        content,
      }, AbortSignal.timeout(30_000))
      return true
    } catch (error) {
      this.logger.warn?.('dsh-team: steer session %s failed, falling back to queue: %s', sessionId, error)
    }
    await this.ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content,
    }, AbortSignal.timeout(30_000))
    return true
  },
  runPending(runId) {
    return this.pendingByRun.has(runId)
  },

  // 某会话是否有正在执行的本插件运行（bot 间回复投递时判断 steer 还是排队）。
  sessionBusy(sessionId) {
    return this.pending.has(sessionId)
  },
  capabilityInfo() {
    let tools = []
    try {
      tools = (this.ctx.tools?.schemas?.() ?? []).map(schema => schema.name).filter(Boolean)
    } catch {
      tools = []
    }
    return {
      native: true,
      profile: process.env.DSH_PROFILE || 'team-bots',
      version: process.env.DSH_RUNTIME_VERSION || 'unknown',
      toolCount: tools.length,
      toolNames: tools,
      modelProviderCount: new Set((this.modelsCache.value ?? []).map(item => item.provider)).size,
    }
  },
}
