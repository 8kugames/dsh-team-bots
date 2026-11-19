// src/services/vision-proxy.js —— 读图代理域（DSHBOTS-112）
// Bot 主模型无视觉能力却收到带图消息时，自动派生 kind='vision'、mode='read' 的
// 只读转写运行：用配置的代理模型（visionProxyProvider/visionProxyModel）把图片
// 转写成中文结构化文本，以「[图片转写] …」system 消息写回原消息所在会话，并给同
// 一条消息派生续答运行（image_offload=1，不再下发二进制图），主模型当轮即可基于
// 转写正文回答用户。原对话不受派生阻塞：原 chat 运行照常带图下发，
// 宿主仍按现状报「模型不支持图片」（不静默）；转写失败或代理未配置时同样
// 只留审计（vision.fallback），不重试、不刷额度。
// 本文件是纯函数模块（手法同 message-images.js）：service 实例由调用方显式传入，
// 不经 service.js 的 defineMethods 挂载，因此这里的方法不挂在原型上。

import { id, nowIso } from '../util.js'

// 宿主无视觉报错口径：dsh-api-session-controller prompt() 对 inputModalities 定义且
// 不含 image 的模型抛 `Model "X" does not support image input.`（reason
// MODEL_DOES_NOT_SUPPORT_IMAGES）；pi-ai 传输层另有 `... does not support image input for ...`。
// 两种串 + 错误码统一在这里判定。
export function isImageUnsupportedError(error) {
  if (!error) return false
  const code = String(error?.code ?? '').toUpperCase()
  const reason = String(error?.reason ?? '').toUpperCase()
  if (code === 'MODEL_DOES_NOT_SUPPORT_IMAGES' || reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES') return true
  return /does not support image input/i.test(String(error?.message ?? error ?? ''))
}

// 代理模型配置：provider 与 model 都非空才启用，否则 null（不派生，按现状报错）。
export function visionProxyTarget(config) {
  const provider = String(config?.visionProxyProvider ?? '').trim()
  const model = String(config?.visionProxyModel ?? '').trim()
  return provider && model ? { provider, model, ref: `${provider}/${model}` } : null
}

// 主模型是否确定无视觉：与宿主 prompt() 同一数据源（ctx.llm.resolveModelInfo 的
// inputModalities）同一判定——能力表未定义（undefined）时宿主放行，这里也返回
// false（此时图片由宿主降级为占位文本，不触发派生）。解析失败同样返回 false，
// 宁可少派生也不误派生。
export async function modelLacksImageSupport(runtime, bot) {
  try {
    const info = await runtime?.ctx?.llm?.resolveModelInfo?.(bot?.provider, bot?.model)
    const modalities = info?.inputModalities
    return Array.isArray(modalities) ? !modalities.includes('image') : false
  } catch {
    return false
  }
}

// 消息（群聊/单聊通用）是否带图：message_images 按 message_id 或 solo_message_id 命中。
export function messageHasImages(store, messageId) {
  if (!messageId) return false
  const row = store.get(
    'SELECT 1 AS ok FROM message_images WHERE message_id = ? OR solo_message_id = ? LIMIT 1',
    messageId, messageId,
  )
  return Boolean(row)
}

// 幂等派生一条读图转写运行。幂等键 `vision:<消息id>:<botid>` 不带时间戳：同一条
// 消息对同一个 Bot 终生只派生一次（含失败后也不重派，不刷代理额度）。UNIQUE
// 撞车时查回既有行返回。派生成功后立即 tick 让调度器尽快领取。
export function spawnVisionProxyRun(service, { bot, message, target }) {
  const proxy = target ?? visionProxyTarget(service.config)
  if (!bot || !message?.id || !proxy) return null
  const idempotencyKey = `vision:${message.id}:${bot.id}`
  const existing = service.store.get(
    "SELECT * FROM runs WHERE idempotency_key = ? AND kind = 'vision'",
    idempotencyKey,
  )
  if (existing) return existing
  const runId = id('run')
  const createdAt = nowIso()
  try {
    service.store.transaction(() => {
      service.store.run(
        `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref,
           status, attempt, idempotency_key, model_provider, model_model, queued_at)
         VALUES (?, ?, ?, 'vision', 'read', 'vision_proxy', ?, 'queued', 1, ?, ?, ?, ?)`,
        runId, message.project_id ?? null, bot.id, message.id, idempotencyKey,
        proxy.provider, proxy.model, createdAt,
      )
      // run_events 住运行归属的聊天库（chat-db-split Phase 3）：路由行取自本回调刚
      // 插入的 runs 参数（project_id/bot_id），与 runs 插入同回调保持撞车不落事件。
      service.runChatStore({ id: runId, project_id: message.project_id ?? null, bot_id: bot.id }).run(
        'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
        id('evt'), runId, 'queued',
        `主模型无视觉，派生读图代理运行（${proxy.ref}）转写消息 ${message.id} 的图片`,
        createdAt,
      )
    })
  } catch (insertError: any) {
    if (String(insertError).includes('UNIQUE')) {
      return service.store.get('SELECT * FROM runs WHERE idempotency_key = ?', idempotencyKey) ?? null
    }
    throw insertError
  }
  service.logger?.info?.('dsh-team: vision proxy run %s queued for message %s (%s)', runId, message.id, proxy.ref)
  void service.tick()
  return service.store.get('SELECT * FROM runs WHERE id = ?', runId)
}

// 主动评估入口（sendMessage / sendSoloMessage 落库投递后 fire-and-forget 调用）：
// 消息带图 && 主模型确定无视觉 → 已配置代理则派生转写运行；未配置则只记
// vision.fallback 审计（按现状报错，不派生不重试）。任何异常只告警，绝不阻塞发送。
// messageStore（chat-db-split Phase 1）：附图所在聊天库，由调用方随消息上下文带入。
export async function considerVisionProxy(service, { bot, message, messageStore = null }) {
  try {
    if (!bot || !message?.id) return null
    if (bot.status !== 'active') return null
    if (!messageHasImages(messageStore ?? service.store, message.id)) return null
    if (!await modelLacksImageSupport(service.runtime, bot)) return null
    const target = visionProxyTarget(service.config)
    if (!target) {
      service.audit({ type: 'bot', id: bot.id }, 'vision.fallback', 'bot', bot.id, {
        messageId: message.id, reason: 'proxy_not_configured',
      })
      return null
    }
    return spawnVisionProxyRun(service, { bot, message, target })
  } catch (error: any) {
    service.logger?.warn?.('dsh-team: vision proxy consideration failed: %s', error?.message ?? error)
    return null
  }
}

// 被动兜底入口（runs.finishRun 失败分支调用）：chat/solo_chat 运行带着图片失败、
// 且错误表明模型无视觉时补派生——覆盖主动预判漏掉的场景（能力表解析失败、会话
// 当前模型与 Bot 配置不一致等）。幂等键保证与主动派生不重复。
export function maybeSpawnVisionAfterFailure(service, { run, bot, error }) {
  try {
    if (!isImageUnsupportedError(error)) return null
    if (run?.kind !== 'chat' && run?.kind !== 'solo_chat') return null
    const message = run.trigger_ref
      ? service.runChatStore(run).get(
        run.kind === 'chat'
          ? 'SELECT * FROM messages WHERE id = ?'
          : 'SELECT * FROM solo_messages WHERE id = ?',
        run.trigger_ref,
      )
      : null
    if (!message || !messageHasImages(service.runChatStore(run), message.id)) return null
    const target = visionProxyTarget(service.config)
    if (!target) {
      service.audit({ type: 'bot', id: bot.id }, 'vision.fallback', 'bot', bot.id, {
        runId: run.id, messageId: message.id, reason: 'proxy_not_configured',
      })
      return null
    }
    return spawnVisionProxyRun(service, { bot, message, target })
  } catch (spawnError: any) {
    service.logger?.warn?.('dsh-team: vision proxy spawn after failure failed: %s', spawnError?.message ?? spawnError)
    return null
  }
}

// 续答派生（闭环）：转写写回后同一条消息再排一次 chat/solo_chat 运行，让主模型基于
// 转写正文回答用户。首发运行已因主模型无视觉失败，其幂等键（chat:<msg>:<bot>）会被
// enqueueChatRun 的既有行查询挡下，所以续答自带新键；image_offload=1 让 startRun
// 跳过二进制附图，转写正文由提示词近期窗口带入。
export function spawnVisionFollowupRun(service, { run, bot, message }) {
  if (!bot || !message?.id) return null
  const isSolo = !run?.project_id
  const idempotencyKey = isSolo
    ? `solo_chat:${message.id}:vision`
    : `chat:${message.id}:${bot.id}:vision`
  const existing = service.store.get('SELECT * FROM runs WHERE idempotency_key = ?', idempotencyKey)
  if (existing) return existing
  // 沿用首发运行的 trigger_type：通道直达（微信/飞书）的回推语义不能丢。
  const source = service.store.get(
    `SELECT trigger_type FROM runs WHERE trigger_ref = ? AND bot_id = ?
       AND kind IN ('chat', 'solo_chat') ORDER BY queued_at DESC LIMIT 1`,
    message.id, bot.id,
  )
  const runId = id('run')
  const createdAt = nowIso()
  try {
    service.store.transaction(() => {
      service.store.run(
        `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref,
           status, attempt, idempotency_key, image_offload, queued_at)
         VALUES (?, ?, ?, ?, 'read', ?, ?, 'queued', 1, ?, 1, ?)`,
        runId, run?.project_id ?? null, bot.id, isSolo ? 'solo_chat' : 'chat',
        source?.trigger_type ?? 'mention', message.id, idempotencyKey, createdAt,
      )
      service.runChatStore({ id: runId, project_id: run?.project_id ?? null, bot_id: bot.id }).run(
        'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
        id('evt'), runId, 'queued',
        `转写完成，续答消息 ${message.id}（本轮不下发二进制图）`,
        createdAt,
      )
    })
  } catch (insertError: any) {
    if (String(insertError).includes('UNIQUE')) {
      return service.store.get('SELECT * FROM runs WHERE idempotency_key = ?', idempotencyKey) ?? null
    }
    throw insertError
  }
  service.logger?.info?.('dsh-team: vision followup run %s queued for message %s', runId, message.id)
  void service.tick()
  return service.store.get('SELECT * FROM runs WHERE id = ?', runId)
}

// 转写运行收尾（runs.finishRun 的 kind='vision' 分支）：成功且产出非空 → 以
// 「[图片转写] …」system 消息写回原消息所在会话（群聊挂 reply_to 原消息，单聊
// 落 solo_messages），并审计 vision.transcribe，随后派生续答运行；失败或空产出 → 只审计
// vision.fallback（原对话已按现状报过「模型不支持图片」，这里不再插消息、不重试）。
export async function completeVisionRun(service, { run, bot, status, output, error }) {
  const actor = { type: 'bot', id: bot?.id }
  const message = run.trigger_ref
    ? service.runChatStore(run).get(
      run.project_id
        ? 'SELECT * FROM messages WHERE id = ?'
        : 'SELECT * FROM solo_messages WHERE id = ?',
      run.trigger_ref,
    )
    : null
  const clean = String(output ?? '').trim()
  if (status === 'succeeded' && clean) {
    const body = `[图片转写] ${clean}`
    if (run.project_id && message) {
      service.insertMessage({
        projectId: run.project_id,
        senderType: 'system',
        senderId: 'system',
        body,
        replyToId: message.id,
        runId: run.id,
      })
    } else if (message) {
      service.insertSoloMessage({
        botId: bot.id,
        senderType: 'system',
        senderId: 'system',
        body,
        runId: run.id,
      })
    }
    service.audit(actor, 'vision.transcribe', 'bot', bot.id, {
      runId: run.id, messageId: message?.id ?? run.trigger_ref,
    })
    // 闭环：转写已写回，同一条消息再排一次续答运行，让主模型基于转写正文回答用户
    // （首发运行已因主模型无视觉失败，不会自己产出正文）。派生失败只告警，不拖累收尾。
    try {
      if (message) spawnVisionFollowupRun(service, { run, bot, message })
    } catch (followupError: any) {
      service.logger?.warn?.('dsh-team: vision followup spawn failed: %s', followupError?.message ?? followupError)
    }
    return
  }
  service.audit(actor, 'vision.fallback', 'bot', bot.id, {
    runId: run.id,
    messageId: message?.id ?? run.trigger_ref,
    reason: status === 'succeeded' ? 'empty_transcription' : 'transcribe_failed',
    errorCode: error?.code ?? null,
  })
}
