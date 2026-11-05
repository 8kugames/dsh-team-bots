// 通知通道域（DSHBOTS-243）：成员通知与任务提醒。
// 投递面与留痕分离——宿主会话通道（runtime.steer，即时可达）负责投递，插件 messages
// 落库（进群聊流 / 任务线程）为准绳；任一通道失败只 warn，不阻塞另一通道。
// 宿主 send_message 工具是 Agent Team 作用域的（花名册按根会话隔离，每个项目 bot
// 会话都是自己的 Team Lead），寻址不到另一个项目 bot 的会话；服务层可达的宿主原生
// 投递通道是 sessionController.prompt（runtime.steer 的封装），成员通知的即时投递
// 走它，句柄不可达或目标无绑定会话时降级为群聊流（insertMessage + chat_run）。

import { badRequest, notFound } from '../errors.js'
import { text } from '../util.js'

export const notifyMethods = {
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
    const notice = `【通知】${from.name}：${body}`
    const messageId = this.insertMessage({
      projectId: project.id,
      senderType: 'bot',
      senderId: from.id,
      body: notice,
      mentions: [target.id],
    })
    const binding = this.store.get(
      "SELECT * FROM session_bindings WHERE bot_id = ? AND project_id = ? AND kind = 'project'",
      target.id,
      project.id,
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
