// src/services/chat.js —— 群聊与单聊消息域
// 群聊/单聊消息写入、视图、slash 指令与 Bot 回复落库。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { realpathSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { assertInside } from '../paths.js'
import { summarizeForUi, upsertBotMessage } from '../botmsg.js'
import { id, jsonParse, nowIso, parseMentions, text } from '../util.js'

export const commandTaskPattern = /^\/task\s+@([\p{L}\p{N}_-]+)\s+([\s\S]+)$/u

export const commandRememberPattern = /^\/remember\s+([\s\S]+)$/u

export const commandClearPattern = /^\/clear$/u

export const chatMethods = {
  insertMessage({ projectId, senderType, senderId, body, mentions = [], taskId = null, runId = null, replyToId = null, createdAt = nowIso() }) {
    const group = this.groupOf(projectId)
    if (!group) throw notFound('项目群聊不存在')
    const messageId = id('msg')
    // 群消息持久化前过密钥掩码：密文值不进转录，模型下一轮只会看到 $<NAME> 标签（NAME 与 .team/secrets.env 里的变量名一致）。
    const maskedBody = this.maskSecretValues(body)
    this.store.run(
      `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, task_id, run_id, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      messageId, projectId, group.id, senderType, senderId, maskedBody, JSON.stringify(mentions), taskId, runId, replyToId, createdAt,
    )
    return messageId
  },

  // 消息发送者显示名：bot 查名字，system 固定「系统」，其余按用户 actor 取名。
  senderNameOf(senderType, senderId) {
    if (senderType === 'bot') return this.store.get('SELECT name FROM bots WHERE id = ?', senderId)?.name ?? 'Bot'
    if (senderType === 'system') return '系统'
    return this.actorName({ type: 'user', id: senderId })
  },

  // 引用视图：excerpt 取原消息正文前 120 字。入库正文已过 maskSecretValues，这里不再掩码；
  // 目标行已被删（/clear 或级联）时 reply_to 置 null，引用悬空不炸视图。
  replyView(replyToId) {
    if (!replyToId) return null
    const row = this.store.get('SELECT id, sender_type, sender_id, body FROM messages WHERE id = ?', replyToId)
    if (!row) return null
    return { id: row.id, sender_name: this.senderNameOf(row.sender_type, row.sender_id), excerpt: row.body.slice(0, 120) }
  },
  messageView(row) {
    const senderName = this.senderNameOf(row.sender_type, row.sender_id)
    const task = row.task_id ? this.store.get('SELECT number, title, project_id FROM tasks WHERE id = ?', row.task_id) : undefined
    const project = task ? this.store.get('SELECT key FROM projects WHERE id = ?', task.project_id) : undefined
    return {
      ...row,
      mentions: jsonParse(row.mentions_json, []),
      senderName,
      reply_to: this.replyView(row.reply_to_id),
      taskIdentifier: task && project ? `${project.key}-${task.number}` : null,
      taskTitle: task?.title ?? null,
    }
  },
  async sendMessage(projectId, bodyInput, actor = this.actor(), replyTo = null) {
    const project = this.projectRow(projectId)
    if (project.status !== 'active') throw conflict('项目已归档')
    const body = text(bodyInput, 20_000)
    if (!body) throw badRequest('消息不能为空')
    const members = this.membersOf(projectId).filter(bot => bot.status === 'active')
    if (commandClearPattern.test(body)) {
      const cleared = this.clearChatHistory(projectId, actor)
      return { cleared }
    }
    if (commandRememberPattern.test(body)) {
      const messageId = this.insertMessage({
        projectId,
        senderType: actor.type,
        senderId: actor.id,
        body,
      })
      await this.rememberCommand(projectId, body, actor)
      return { messageId, memory: true }
    }
    const command = commandTaskPattern.exec(body)
    if (command) {
      const assigneeName = command[1]
      const title = text(command[2].split('\n')[0], 200)
      if (!title) throw badRequest('任务标题不能为空')
      const assignee = members.find(bot => bot.name === assigneeName)
      if (!assignee) throw badRequest(`@${assigneeName} 不是该项目成员`)
      const messageId = this.insertMessage({
        projectId,
        senderType: actor.type,
        senderId: actor.id,
        body,
        mentions: [assignee.id],
      })
      const task = await this.createTask({
        projectId,
        title,
        description: command[2],
        assigneeBotId: assignee.id,
        priority: 'medium',
        autoStart: true,
        sourceMessageId: messageId,
        postCard: true,
      }, actor)
      this.store.run('UPDATE messages SET task_id = ? WHERE id = ?', task.id, messageId)
      return { messageId, taskId: task.id }
    }
    // 引用回复：目标消息必须存在于同项目，否则 400。命令路径（/clear、/remember、/task）不走到这里，按规格忽略引用。
    const replyMessage = replyTo
      ? this.store.get('SELECT id, sender_type, sender_id FROM messages WHERE id = ? AND project_id = ?', String(replyTo), projectId)
      : null
    if (replyTo && !replyMessage) throw badRequest('引用的消息不存在')
    const mentions = parseMentions(body, members)
    // 目标解析：显式 @mention 优先（引用只作上下文）；无显式 @ 时引用 bot 消息则定向该 bot（替换 owner 兜底）；最后落 owner。
    const targets = (mentions.length > 0
      ? mentions
      : members.filter(bot => bot.id === (replyMessage?.sender_type === 'bot' ? replyMessage.sender_id : project.owner_bot_id))
    ).slice(0, 3)
    const messageId = this.insertMessage({
      projectId,
      senderType: actor.type,
      senderId: actor.id,
      body,
      mentions: mentions.map(bot => bot.id),
      replyToId: replyMessage?.id ?? null,
    })
    for (const bot of targets) {
      this.enqueueOutbox({
        kind: 'chat_run',
        payload: { projectId: project.id, botId: bot.id, messageId },
        projectId: project.id,
        sourceId: messageId,
        idempotencyKey: `chat:${messageId}:${bot.id}`,
      })
    }
    void this.tick()
    return { messageId, runBots: targets.map(bot => bot.id) }
  },

  // /clear：清空本群全部聊天记录。任务、记忆等不受影响；操作进审计。
  clearChatHistory(projectId, actor = this.actor()) {
    const project = this.projectRow(projectId)
    const count = Number(this.store.get('SELECT COUNT(*) AS count FROM messages WHERE project_id = ?', project.id)?.count ?? 0)
    this.store.run('DELETE FROM messages WHERE project_id = ?', project.id)
    this.audit(actor, 'chat.clear', 'project', project.id, { cleared: count })
    return count
  },
  async rememberCommand(projectId, body, actor) {
    const matched = commandRememberPattern.exec(body)
    if (!matched) return false
    const project = this.projectRow(projectId)
    this.createMemory({
      scopeType: 'project',
      scopeId: project.id,
      topic: body.slice(10, 60),
      content: matched[1],
      source: 'chat-command',
      createdBy: `${actor.type}:${actor.id}`,
    })
    this.insertMessage({
      projectId,
      senderType: 'system',
      senderId: 'system',
      body: '已写入项目记忆。',
    })
    return true
  },

  // ===== 单聊：项目外与单个 Bot 的一对一会话，工作目录 _the_bots/<solo_dir> =====
  insertSoloMessage({ botId, senderType, senderId, body, runId = null, createdAt = nowIso() }) {
    const messageId = id('msg')
    // 单聊同样过密钥掩码：单聊正文会进模型上下文，明文密钥不该落库。
    const maskedBody = this.maskSecretValues(body)
    this.store.run(
      `INSERT INTO solo_messages(id, bot_id, sender_type, sender_id, body, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      messageId, botId, senderType, senderId, maskedBody, runId, createdAt,
    )
    return messageId
  },
  soloMessageView(row) {
    const senderName = row.sender_type === 'bot'
      ? this.store.get('SELECT name FROM bots WHERE id = ?', row.sender_id)?.name ?? 'Bot'
      : row.sender_type === 'system' ? '系统' : this.actorName({ type: 'user', id: row.sender_id })
    return { ...row, senderName }
  },
  clearSoloHistory(botId, actor = this.actor()) {
    const bot = this.botRow(botId)
    const count = Number(this.store.get('SELECT COUNT(*) AS count FROM solo_messages WHERE bot_id = ?', bot.id)?.count ?? 0)
    this.store.run('DELETE FROM solo_messages WHERE bot_id = ?', bot.id)
    this.audit(actor, 'chat.solo_clear', 'bot', bot.id, { cleared: count })
    return count
  },
  async sendSoloMessage(botId, bodyInput, actor = this.actor()) {
    const bot = this.botRow(botId)
    if (bot.status !== 'active') throw conflict('Bot 已归档或暂停')
    const body = text(bodyInput, 20_000)
    if (!body) throw badRequest('消息不能为空')
    if (commandClearPattern.test(body)) {
      const cleared = this.clearSoloHistory(bot.id, actor)
      return { cleared }
    }
    if (commandRememberPattern.test(body)) {
      const matched = commandRememberPattern.exec(body)
      const messageId = this.insertSoloMessage({
        botId: bot.id,
        senderType: actor.type,
        senderId: actor.id,
        body,
      })
      this.createMemory({
        scopeType: 'bot',
        scopeId: bot.id,
        topic: body.slice(10, 60),
        content: matched[1],
        source: 'chat-command',
        createdBy: `${actor.type}:${actor.id}`,
      })
      this.insertSoloMessage({
        botId: bot.id,
        senderType: 'system',
        senderId: 'system',
        body: `已写入 ${bot.name} 的记忆。`,
      })
      return { messageId, memory: true }
    }
    const messageId = this.insertSoloMessage({
      botId: bot.id,
      senderType: actor.type,
      senderId: actor.id,
      body,
    })
    this.enqueueOutbox({
      kind: 'solo_chat_run',
      payload: { botId: bot.id, messageId },
      projectId: null,
      sourceId: messageId,
      idempotencyKey: `solo_chat:${messageId}`,
    })
    void this.tick()
    return { messageId, runBot: bot.id }
  },

  // 群聊只放结论：压缩空白、取首段、按上限截断。
  chatSummary(output, maxChars = this.config.chatReplyMaxChars) {
    const clean = String(output ?? '').replace(/\s+/g, ' ').trim()
    if (!clean) return '模型未返回文本。'
    if (clean.length <= maxChars) return clean
    return `${clean.slice(0, maxChars).trimEnd()}…`
  },

  // ===== Bot 间私信（team_message_bot）=====

  // 工具入口：同项目成员间具名幂等私信。发信人由会话绑定推出；返回给调用 Bot 的结果里带状态，重发同名请求不产生新工作。
  messageFromBot({ sessionId, toName, requestId, textBody }) {
    const origin = sessionId
      ? this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
      : null
    if (!origin) throw badRequest('找不到发起会话的项目绑定')
    const fromBotId = origin.bot_id
    const from = this.store.get('SELECT * FROM bots WHERE id = ?', fromBotId)
    if (!from || from.status !== 'active') throw forbidden('发信 Bot 不存在或不可用')
    if (!toName || typeof toName !== 'string') throw badRequest('缺少收信 Bot 名称')
    if (!requestId || typeof requestId !== 'string') throw badRequest('缺少 request_id（每次逻辑请求一个稳定名字，重发同名不重复执行）')
    const project = this.projectRow(origin.project_id)
    const target = (this.membersOf(project.id) ?? []).find(bot => bot.name === toName.trim())
    if (!target) throw notFound(`项目 ${project.name} 里没有叫 ${toName} 的成员 Bot`)
    if (target.id === fromBotId) throw badRequest('不能给自己发私信')
    // 私信正文过密钥掩码：私信会进对方模型上下文，明文密钥不该落库。
    const maskedText = this.maskSecretValues(text(textBody, 50_000))
    let row = null
    let created = false
    // 落库与入队同一事务：消息不会停在「已入库但没人投递」的悬空状态。
    this.store.transaction(() => {
      const result = upsertBotMessage(this.store, {
        projectId: project.id,
        fromBotId,
        toBotId: target.id,
        requestId,
        text: maskedText,
        originSessionId: sessionId,
        originKind: origin.kind,
        originTaskId: origin.task_id ?? null,
      })
      // request_id 是幂等键：同名但内容不同说明调用方复用了名字，必须报错而不是悄悄丢弃新内容。
      if (result.conflict) {
        throw conflict(`request_id「${requestId}」已被内容不同的私信占用，请换一个 request_id 再发`)
      }
      row = result.row
      created = result.created
      if (created) {
        this.enqueueOutbox({
          kind: 'dm_run',
          payload: { messageId: row.id },
          projectId: project.id,
          sourceId: row.id,
          idempotencyKey: `dm_run:${row.id}`,
        })
      }
    })
    if (created) void this.tick()
    // enqueueOutbox 同步投递会推进状态（pending→delivered），返回前重读最新行。
    const fresh = this.store.get('SELECT * FROM bot_messages WHERE id = ?', row.id) ?? row
    return {
      messageId: fresh.id.slice(-6),
      status: fresh.status,
      created,
      hint: fresh.status === 'replied' ? '该请求此前已有回信，回信会重新投递' : '私信已入队，回信将送回你的当前会话',
    }
  },
  botMessagesView(projectId) {
    const rows = this.store.all(
      'SELECT * FROM bot_messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 50',
      projectId,
    )
    const bots = new Map(this.store.all('SELECT id, name FROM bots').map(bot => [bot.id, bot.name]))
    return summarizeForUi(rows).map(item => ({
      ...item,
      fromName: bots.get(item.from) ?? item.from,
      toName: bots.get(item.to) ?? item.to,
    }))
  },

  // ── 聊天图片通道（GET /api/dsh-team/file）──────────────────────────────
  // 定位聊天消息里 markdown 图片引用的工作区文件：只认项目工作目录或单聊 Bot
  // 工作区内的白名单图片，路径解析 + realpath 双重防穿越（与 artifactFile 同口径）。
  // SVG 可执行脚本，永不放行；尺寸上限由 HTTP 层把关（MAX_CHAT_IMAGE_BYTES）。
  chatFile({ projectId, soloBotId, path } = {}) {
    const CHAT_IMAGE_TYPES = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    }
    const relPath = String(path ?? '').trim()
    if (!relPath) throw badRequest('缺少参数 path')
    let dir
    if (projectId) {
      dir = this.projectWorkDir(this.projectRow(String(projectId)))
    } else if (soloBotId) {
      const bot = this.botRow(String(soloBotId))
      if (!bot?.solo_dir) throw notFound('该 Bot 没有单聊工作区')
      dir = join(this.config.workspace, '_the_bots', bot.solo_dir)
    } else {
      throw badRequest('缺少参数 projectId 或 soloBotId')
    }
    const contentType = CHAT_IMAGE_TYPES[extname(relPath).toLowerCase()]
    if (!contentType) throw badRequest('仅支持 png / jpg / jpeg / gif / webp 图片')
    let absolutePath
    try {
      absolutePath = assertInside(dir, join(dir, relPath))
    } catch {
      throw forbidden('图片路径越界')
    }
    let info
    try {
      info = statSync(absolutePath)
    } catch {
      throw notFound('图片文件不存在')
    }
    if (!info.isFile()) throw notFound('图片不是常规文件')
    const realFile = realpathSync(absolutePath)
    const realDir = realpathSync(dir)
    if (realFile === realDir || !realFile.startsWith(realDir + sep)) throw forbidden('图片路径越界')
    return { absolutePath, size: info.size, contentType }
  },
}
