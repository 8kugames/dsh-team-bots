// 任务通知域：任务生命周期事件的对外通知锚点。
// 微信推送收敛（DSHBOTS-182）：通道只在「创建成功」与「真正完成（→done 转换）」
// 各推一条（创建→完成闭环），交付（in_review/待验收）节点不推。幂等不靠通知键，
// 靠锚定一次性事件本身：创建是单次 INSERT；done 是受 TRANSITIONS 守卫的状态转换
// （done→done 不构成转换）。通道未启用时静默（无可用通道即 no-op）；
// DSHBOTS-328：出站经 channelNotify 扇出到各已启用通道（微信/飞书），不再只到微信。
// 通知失败不能把已落库的变更打挂。
// notifyTaskStarted（DSHBOTS-100）是群内开工通知+运行入队（非微信推送），
// 与两个微信锚点同属任务通知域，一并落在本文件。
// 微信推送文案排版集中在 src/wechat/format.js（DSHBOTS-211）。

import { taskCreated, taskDone } from '../wechat/format.js'

export const taskNotifyMethods = {
  // 「任务进入进行中」的唯一落点。
  // 幂等口径：已有活跃运行时不重复入队、不重复发消息（不能对已经在跑的任务再喊一次开始）；
  // 没有负责人时不发消息也不入队（没人可通知、也没人可开工）。
  // 先入队后发消息：入队失败时宁可没有消息，也不留一条指向空转的「开始」。
  notifyTaskStarted(task, { triggerType = 'task_started' } = {}) {
    const assigneeId = task.assignee_bot_id
    if (!assigneeId) return null
    const active = this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      task.id,
    )
    if (active) return null
    // 负责人 bot 行缺失（数据异常）或已暂停/归档（DSHBOTS-262）时整体跳过：通知与开工
    // 都指不到人——看板拖拽/表单改状态是派发链路的隐形入口，暂停中不该被唤醒
    // （enqueueTaskRun 对 pending task_run 补投兜底同口径）；也不能让通知失败反过来
    // 把已经落库的状态变更顶掉。
    const bot = this.store.get('SELECT name, status FROM bots WHERE id = ?', assigneeId)
    if (!bot || bot.status !== 'active') return null
    const project = this.projectRow(task.project_id)
    const identifier = `${project.key}-${task.number}`
    try {
      this.enqueueOutbox({
        kind: 'task_run',
        payload: { taskId: task.id, triggerType },
        projectId: task.project_id,
        taskId: task.id,
        idempotencyKey: `task:${task.id}:${triggerType}:${Date.now()}`,
      })
      this.insertMessage({
        projectId: task.project_id,
        senderType: 'system',
        senderId: 'system',
        taskId: task.id,
        body: `任务 ${identifier} 已开始（${bot.name}）。`,
        mentions: [assigneeId],
      })
    } catch (error: any) {
      // 状态变更已经落库，通知/开工失败不能反过来把整次 update_task 打挂（用户会看到报错但状态已变）。
      this.logger.warn?.('dsh-team: 任务开始通知失败 %s: %s', identifier, error?.message ?? error)
      return null
    }
    void this.tick()
    return { taskId: task.id, triggerType }
  },
  // 任务卡修正闭环（DSHBOTS-232 ①）：已派单卡的卡面（标题/描述/优先级/写范围）变更时，
  // 群内发系统消息点名负责人「按新卡面修正」；负责人名下该任务有正在执行的运行时，
  // 再向其会话注入一条修正提示（复用 steer 通道，与评论直通同机制）。
  // 通知失败不回滚已落库的卡面变更（与 notifyTaskStarted 同口径）。
  async notifyTaskCardChanged(task) {
    const assigneeId = task.assignee_bot_id
    if (!assigneeId) return null
    const bot = this.store.get('SELECT name FROM bots WHERE id = ?', assigneeId)
    if (!bot) return null
    const project = this.projectRow(task.project_id)
    const identifier = `${project.key}-${task.number}`
    try {
      this.insertMessage({
        projectId: task.project_id,
        senderType: 'system',
        senderId: 'system',
        taskId: task.id,
        body: `任务 ${identifier} 卡面已变更，请按新卡面修正。`,
        mentions: [assigneeId],
      })
    } catch (error: any) {
      this.logger.warn?.('dsh-team: 卡面变更通知失败 %s: %s', identifier, error?.message ?? error)
      return null
    }
    const run = this.store.get(
      "SELECT id, session_id FROM runs WHERE task_id = ? AND status = 'running' AND session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      task.id,
    )
    if (run && this.runtime?.steer) {
      try {
        await this.runtime.steer(
          run.session_id,
          `Task card ${identifier} has just been amended by the owner. Re-read the latest card (title/description/priority/write scopes) and correct the work in progress accordingly; mention the amendment in the delivery report.`,
        )
        this.insertRunEvent(run.id, 'card_changed', `卡面变更修正提示已注入（${identifier}）`)
      } catch (error: any) {
        this.logger.warn?.('dsh-team: 卡面变更修正提示注入失败 %s: %s', identifier, error?.message ?? error)
      }
    }
    return { taskId: task.id, steered: Boolean(run) }
  },
  // 任务完成通知（DSHBOTS-182）：锚定 →done 转换，触发点在 updateTask。
  // 幂等收据键（A3/DSHBOTS-323）：task-done:<task.id>——同卡重复推送在通道存留期内被吸收。
  // DSHBOTS-328：出站经 channelNotify 扇出到各已启用通道（微信/飞书），不再只到微信。
  notifyTaskDone(task) {
    const project = this.projectRow(task.project_id)
    const identifier = `${project.key}-${task.number}`
    try {
      this.channelNotify?.(taskDone(identifier, task.title), { receiptKey: `task-done:${task.id}` })
    } catch (error: any) {
      this.logger.warn?.('dsh-team: 任务完成通知失败 %s: %s', identifier, error?.message ?? error)
    }
  },
  // 任务创建通知（DSHBOTS-182 增补）：锚定创建成功（单次 INSERT），触发点在 createTask。
  // 文案含 KEY-N/标题/派给谁；无负责人时如实注明「暂未指派」。
  // 幂等收据键（A3/DSHBOTS-323）：task-created:<task.id>。
  // DSHBOTS-328：出站经 channelNotify 扇出到各已启用通道（微信/飞书），不再只到微信。
  notifyTaskCreated(task) {
    const project = this.projectRow(task.project_id)
    const identifier = `${project.key}-${task.number}`
    const assignee = task.assignee_bot_id ? this.botRow(task.assignee_bot_id)?.name : null
    try {
      this.channelNotify?.(taskCreated(identifier, task.title, assignee), { receiptKey: `task-created:${task.id}` })
    } catch (error: any) {
      this.logger.warn?.('dsh-team: 任务创建通知失败 %s: %s', identifier, error?.message ?? error)
    }
  },
}
