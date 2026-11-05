// 任务通知域：任务生命周期事件的对外通知锚点。
// 微信推送收敛（DSHBOTS-182）：微信通道只在「创建成功」与「真正完成（→done 转换）」
// 各推一条（创建→完成闭环），交付（in_review/待验收）节点不推。幂等不靠通知键，
// 靠锚定一次性事件本身：创建是单次 INSERT；done 是受 TRANSITIONS 守卫的状态转换
// （done→done 不构成转换）。通道未启用时静默（service.wechat 为 null）；
// 通知失败不能把已落库的变更打挂。
// notifyTaskStarted（DSHBOTS-100）是群内开工通知+运行入队（非微信推送），
// 与两个微信锚点同属任务通知域，一并落在本文件。

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
    // 负责人 bot 行缺失（数据异常）时整体跳过：通知与开工都指不到人，
    // 也不能让通知失败反过来把已经落库的状态变更顶掉。
    const bot = this.store.get('SELECT name FROM bots WHERE id = ?', assigneeId)
    if (!bot) return null
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
  // 任务完成微信推送（DSHBOTS-182）：锚定 →done 转换，触发点在 updateTask。
  notifyTaskDone(task) {
    const project = this.projectRow(task.project_id)
    const identifier = `${project.key}-${task.number}`
    try {
      this.wechat?.notify(`任务 ${identifier}《${task.title}》已完成。回复「详情 ${identifier}」查看。`)
    } catch (error: any) {
      this.logger.warn?.('dsh-team: 任务完成微信通知失败 %s: %s', identifier, error?.message ?? error)
    }
  },
  // 任务创建微信推送（DSHBOTS-182 增补）：锚定创建成功（单次 INSERT），触发点在 createTask。
  // 文案含 KEY-N/标题/派给谁；无负责人时如实注明「暂未指派」。
  notifyTaskCreated(task) {
    const project = this.projectRow(task.project_id)
    const identifier = `${project.key}-${task.number}`
    const assignee = task.assignee_bot_id ? this.botRow(task.assignee_bot_id)?.name : null
    try {
      this.wechat?.notify(
        `任务 ${identifier}《${task.title}》已创建${assignee ? `，派给 ${assignee}` : '，暂未指派'}。回复「详情 ${identifier}」查看。`,
      )
    } catch (error: any) {
      this.logger.warn?.('dsh-team: 任务创建微信通知失败 %s: %s', identifier, error?.message ?? error)
    }
  },
}
