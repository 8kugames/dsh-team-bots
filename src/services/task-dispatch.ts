// src/services/task-dispatch.js —— 任务派单与改派域
// 覆盖：派发门禁（assertDispatchTarget）、派单/重派（assignTask / assignFromBot）、
// 看板拖拽联动（transitionTask / applyBoardDragDirective）、总监强制受阻（forceBlockTask）、
// Bot 会话入口（forceBlockFromBot）与派单辅助（写范围清洗/重复卡检测/任务号解析/owner 上下文）。
// 任务建档、状态流转与视图见 ./tasks.js。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用）。

import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { nowIso } from '../util.js'
import { filterIgnoredWriteScopes, parseWriteScopes, parseWriteScopesFromDescription, readWriteScopes } from './write-scopes.js'
import { resolveSandboxOverride } from './file-policy.js'
import { ensureTaskSandboxSchema } from './task-sandbox-schema.js'

export const taskDispatchMethods = {
  // 派发门禁（DSHBOTS-262）：暂停中的 Bot 不接新卡——新建派单、改派、重派一律拒绝，
  // 先恢复（bot status → active）再派；归档/移除等其余不可用态沿用 assertMember 既有口径。
  assertDispatchTarget(projectId, botId) {
    const bot = this.store.get('SELECT name, status FROM bots WHERE id = ?', botId)
    if (bot?.status === 'paused') throw badRequest(`Bot ${bot.name} 已暂停，先恢复再派卡`)
    this.assertMember(projectId, botId)
  },
  // 无主卡领取开工的写范围声明闸门（DSHBOTS-270）：与 assignFromBot「派单必须声明写
  // 范围」同口径的预判——卡面清单优先，空则从描述「写范围：」行兜底解析
  // （parseWriteScopesFromDescription），再过忽略规则清洗（全部命中 .gitignore 被剔除
  // = 实际未声明）。拒绝文案按 D-269 口径 = 原因 + 替代命令；带声明的卡直接放行。
  assertClaimScopes(task, project) {
    const declared = readWriteScopes(task.write_scopes)
    const scopes = filterIgnoredWriteScopes(
      declared.length ? declared : parseWriteScopesFromDescription(task.description),
      this.projectWorkDir(project),
    ).kept
    if (scopes.length) return
    throw badRequest(
      `领取开工必须声明写范围：任务 ${project.key}-${task.number} 未声明写范围，`
      + '其写运行会与同项目其他写运行全部保守串行，一条卡即可堵死队列。'
      + '请先补声明再领取：用工作台 update_task / task_update_scopes 给该卡补 write_scopes，'
      + '或在卡面描述里写一行「写范围：a, b」（由 parseWriteScopesFromDescription 兜底解析）；'
      + '补声明后重新领取即可按声明范围并行。',
    )
  },
  // sandboxOverride 选项（DSHBOTS-156）：undefined=不动（重派未传 sandbox 时保留旧覆盖）；
  // null=显式清掉回落 bot 配置档（重派传 sandbox='inherit'）；字符串=收紧档（派发入口已校验）。
  async assignTask(taskId, botId, actor = this.actor(), { autoStart = true, sandboxOverride } = {} as any) {
    const task = this.taskRow(taskId)
    const project = this.projectRow(task.project_id)
    this.assertDispatchTarget(project.id, botId)
    // 共享板无主卡声明闸门（DSHBOTS-270）：无主卡获得 owner 即领取开工——assignTask 稍后
    // 会排 task_run outbox 进施工，未声明写范围的写运行被调度器按「未声明」保守串行
    // （scheduler 既定语义不动），既堵自己也占道。与总监派单同口径在入口拒绝；
    // 改派（卡已有 owner）与 autoStart=false 的重派/存量补挂流程不在此口。
    if (!task.assignee_bot_id && autoStart !== false) this.assertClaimScopes(task, project)
    const active = this.store.get(
      "SELECT id, kind FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      taskId,
    )
    // 换负责人闸门（DSHBOTS-169）：queued 占位运行（死队列，永远不会被领取）不是执行中，
    // 不再阻断改派——事务内按 SUPERSEDED 口径清掉后放行；只有 running 的任务运行照旧阻断
    // （文案不变）。同负责人重派不走此闸，行为不变。
    const reassigning = task.assignee_bot_id !== botId
    if (reassigning && this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'running' LIMIT 1",
      taskId,
    )) throw conflict('任务有正在执行的运行，不能更换负责人')
    const supersedeQueued = reassigning && !!this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'queued' LIMIT 1",
      taskId,
    )
    ensureTaskSandboxSchema(this.store)
    const sandboxTouched = sandboxOverride !== undefined
    // 存量 NULL 预算卡补挂（DSHBOTS-198）：COALESCE 只补空，显式已设的卡不覆盖。
    const defaultTimeBudget = this.defaultTaskTimeBudget()
    this.store.transaction(() => {
      // queued 占位清理与改派同事务（DSHBOTS-169）：SUPERSEDED 不进任务执行历史，run 事件可审计。
      // 助手是同步函数（体内无 await），抛错会让整个事务回滚，不会留下「改派已生效但占位还在」的半成品。
      if (supersedeQueued) this.cancelSupersededQueuedRuns(taskId)
      this.store.run(
        `UPDATE tasks SET assignee_bot_id = ?, review_target = ?,
          status = CASE WHEN status IN ('backlog', 'blocked') THEN 'todo' ELSE status END,
          time_budget_minutes = COALESCE(time_budget_minutes, ?),
          version = version + 1, updated_at = ?${sandboxTouched ? ', sandbox_override = ?' : ''} WHERE id = ?`,
        ...(sandboxTouched
          ? [botId, actor.type === 'bot' ? 'owner_bot' : 'user', defaultTimeBudget, nowIso(), sandboxOverride ?? null, taskId]
          : [botId, actor.type === 'bot' ? 'owner_bot' : 'user', defaultTimeBudget, nowIso(), taskId]),
      )
      this.addTaskEvent(taskId, 'assigned', actor, {
        botId,
        ...(sandboxTouched && { sandbox: sandboxOverride ?? 'inherit' }),
      })
      this.audit(actor, 'task.assign', 'task', taskId, { botId, ...(sandboxTouched && { sandbox: sandboxOverride ?? 'inherit' }) })
    })
    // 总监bot的验收/受阻处理运行本身占用任务的唯一活动运行名额，
    // 此时由 finishRun 的收尾逻辑负责重新排队执行，这里跳过。
    // 换负责人清掉 queued 占位后名额已空：重算判定才会按新负责人重排 task_run（DSHBOTS-169）。
    // 幂等键：task_run 是先写者赢闸（ON CONFLICT DO NOTHING 且撞键不再 applyOutboxRow），
    // 稳定键 task:<id>:assigned 会在再次改派时撞上历史 delivered 行而被静默吞掉、排不出新运行
    // （不限清 queued 占位场景，无活跃运行的改派同样会写键）。凡换负责人一律带事务内单调自增
    // 的 task.version 后缀（确定性、跨改派不碰撞）；同负责人重派保持稳定键，slotHeld 已提供幂等。
    const slotHeld = supersedeQueued
      ? this.store.get(
        "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
        taskId,
      )
      : active
    if (!slotHeld) {
      const assignedVersion = reassigning ? this.taskRow(taskId).version : null
      this.enqueueOutbox({
        kind: 'task_run',
        payload: { taskId, triggerType: 'assigned' },
        projectId: task.project_id,
        taskId,
        idempotencyKey: `task:${taskId}:assigned${assignedVersion === null ? '' : `:v${assignedVersion}`}`,
      })
    }
    if (autoStart) void this.tick()
    return this.taskView(this.taskRow(taskId))
  },
  async transitionTask(taskId, status, actor = this.actor()) {
    const before = this.taskRow(taskId)
    // 离开「进行中」前的活跃运行数：运行中止已由 updateTask 内的写占用释放统一完成，
    // 这里只按中止条数决定要不要发看板暂停的系统指令消息，避免同一处中止被算两遍。
    const activeRuns = Number(this.store.get(
      "SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      taskId,
    )?.n ?? 0)
    // 看板拖拽沿用 D-54 的运行触发类型（board_resume）：拖入「执行中」的通知与开工由
    // updateTask 内的统一触发点完成（同一任务只发一条消息、只入队一次运行）。
    await this.updateTask(taskId, { status }, actor, { startTriggerType: 'board_resume' })
    await this.applyBoardDragDirective(before, status, { activeRuns })
    // 重新取数：拖拽联动可能刚入队或暂停了运行，沿用 updateTask 的返回会带过期的 latestRun。
    return this.taskView(this.taskRow(taskId))
  },
  // 看板拖拽联动（DSHBOTS-54）：拖出到 todo/blocked 自动暂停。
  // 拖入「执行中」一侧的通知与开工已收进 updateTask 内的统一触发点（DSHBOTS-100）：
  // blocked/in_review → in_progress 与编辑表单改状态同样要通知并开工，逻辑只有那一处，
  // 这里不再重复发消息、重复入队（同一任务只发一条）。
  // 指令消息由系统直接发（sender_type='system'，不触发 bot 运行）；
  // 出向 in_review/done/canceled 的写运行中止由 updateTask 内的写占用释放统一处理（DSHBOTS-73）。
  async applyBoardDragDirective(before, afterStatus, { activeRuns = 0 } = {}) {
    if (before.status === afterStatus) return
    if (before.status === 'in_progress' && (afterStatus === 'todo' || afterStatus === 'blocked')) {
      // 运行中止已由 updateTask 内的写占用释放统一完成（同一处处理），这里只按中止条数发系统指令消息。
      if (activeRuns > 0) {
        const project = this.projectRow(before.project_id)
        this.insertMessage({
          projectId: before.project_id,
          senderType: 'system',
          senderId: 'system',
          taskId: before.id,
          body: `任务 ${project.key}-${before.number} 已移出执行中，运行已暂停。`,
        })
      }
    }
  },
  // 总监强制受阻（DSHBOTS-232 ②）：把「进行中」任务强制移「受阻」并中止其名下全部
  // 排队/执行中运行。运行中止走既有 abort 链路（cancelRunInternal → runtime.cancelRun），
  // 与看板暂停（PAUSED_BY_BOARD，可续跑的暂停语义）区分：强制受阻是中止语义，
  // 稳定码 TASK_FORCE_BLOCKED + run 事件 force_blocked + 审计 task.force_blocked 留痕。
  // 先停运行再改状态：状态变更经 updateTask 单一触发点，此时活跃运行已清空，
  // 不会落进看板暂停分支造成双重口径。
  async forceBlockTask(taskId, actor = this.actor()) {
    const task = this.taskRow(taskId)
    if (task.status !== 'in_progress') throw conflict(`任务不在进行中，不能强制受阻（当前 ${task.status}）`)
    const runs = this.store.all(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      taskId,
    )
    const stoppedRuns = []
    for (const run of runs) {
      await this.cancelRunInternal(run.id, false)
      this.store.run(
        'UPDATE runs SET error_code = ?, error_message = ? WHERE id = ?',
        'TASK_FORCE_BLOCKED', '总监强制移为受阻，运行中止', run.id,
      )
      this.insertRunEvent(run.id, 'force_blocked', '总监强制受阻，运行中止')
      stoppedRuns.push(run.id)
    }
    await this.updateTask(taskId, { status: 'blocked' }, actor)
    this.audit(actor, 'task.force_blocked', 'task', taskId, { stoppedRuns })
    const project = this.projectRow(task.project_id)
    this.insertMessage({
      projectId: task.project_id,
      senderType: 'system',
      senderId: 'system',
      taskId,
      body: `任务 ${project.key}-${task.number} 被总监强制移为受阻，运行已中止。`,
    })
    return this.taskView(this.taskRow(taskId))
  },
  // 总监会话入口（team_block_task 工具）：与 reviewFromBot 同款 owner 校验。
  async forceBlockFromBot(sessionId, input) {
    const { project, actor } = this.ownerContextFor(sessionId)
    const task = this.resolveBotTask(project, input.task)
    return this.forceBlockTask(task.id, actor)
  },
  resolveBotTask(project, ref) {
    const raw = String(ref ?? '').trim()
    if (!raw) throw badRequest('缺少任务编号')
    let task
    if (raw.startsWith('task_')) {
      task = this.store.get('SELECT * FROM tasks WHERE id = ? AND project_id = ?', raw, project.id)
    } else {
      const match = raw.match(/^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d+)$/)
      if (match && (!match[1] || match[1].toLowerCase() === project.key.toLowerCase())) {
        task = this.store.get('SELECT * FROM tasks WHERE project_id = ? AND number = ?', project.id, Number(match[2]))
      }
    }
    if (!task) throw notFound(`找不到任务 ${raw}`)
    return task
  },
  ownerContextFor(sessionId) {
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw forbidden('只有项目群中的 Bot 可以执行该操作')
    if (!binding.project_id) throw forbidden('单聊会话不在项目中，无法管理任务')
    const project = this.projectRow(binding.project_id)
    // DSHBOTS-269 失败语义引导：拒绝文案 = 原因 + 替代命令/正确下一步。
    if (project.owner_bot_id !== binding.bot_id) {
      throw forbidden(
        '只有项目总监 Bot 可以执行该操作：总监命令（如 team_assign_task 派单/重派、'
        + 'team_review_task 验收关单、team_block_task 强制受阻）由项目 owner 总监 Bot 调用；'
        + '成员请在项目群内向总监请求代为执行。',
      )
    }
    return { binding, project, actor: { type: 'bot', id: binding.bot_id } }
  },
  // 派单侧同写范围重复检测（DSHBOTS-82）：同一文件上叠 N 张小卡时，各卡各立各排，
  // 后面的卡只能等前一张跑完，形成排队空转。这里在派单入口找「写范围完全一致」的同项目在办卡。
  // 只比完全一致（集合相等，顺序无关）；相交但不同的放行——那属于正常的串行依赖，
  // 正确性由调度器写范围闸门保证，不在派单入口拦截。
  findDuplicateScopeTask(projectId, scopes) {
    const target = new Set(scopes)
    if (!target.size) return null
    const candidates = this.store.all(
      `SELECT id, number, title, write_scopes FROM tasks
        WHERE project_id = ? AND status IN ('todo', 'in_progress', 'blocked')`,
      projectId,
    )
    for (const row of candidates) {
      const other = readWriteScopes(row.write_scopes)
      if (other.length !== target.size) continue
      if ([...target].every(scope => other.includes(scope))) return row
    }
    return null
  },
  // 派单清洗（DSHBOTS-168）：写范围声明的程序化质量闸门，三入口共用——
  // createTask（owner 派单路径权威清洗）、assignFromBot（经 createTask 同一清洗）、
  // taskUpdateScopes（改卡入口）。两步：
  // ① ignored 机械移除——命中项目 .gitignore 的条目没有写保护价值，剔除并落审计
  //   task.scopes_normalize（removed=[...]）；全部被移除后调用方各自的「必须声明写
  //   范围」闸门自然接管（清单为空）。非 git 目录 / git 不可用时保守放行不清洗。
  // ② 一级目录驳回——清洗后仍不含 / 的条目（src、tests 这类整目录声明）直接拒绝：
  //   整目录会把同项目全部写运行判为冲突锁死并发，这不是清洗能救的，必须改卡。
  normalizeDispatchScopes(project, scopes, { actor, taskId }) {
    const { kept, removed } = filterIgnoredWriteScopes(scopes, this.projectWorkDir(project))
    if (removed.length) this.audit(actor, 'task.scopes_normalize', 'task', taskId, { removed })
    const bare = kept.filter(scope => !scope.includes('/'))
    if (bare.length) {
      throw badRequest(
        `写范围不能声明整目录：${bare.join('、')} —— 写范围必须声明到二级路径或具体文件，`
        + '整目录声明会锁死同项目全部写运行。',
      )
    }
    return kept
  },
  async assignFromBot(sessionId, input) {
    const { project, actor } = this.ownerContextFor(sessionId)
    const member = this.membersOf(project.id).find(bot => bot.name.toLowerCase() === String(input.assignee ?? '').toLowerCase())
    if (!member) throw badRequest(`项目中没有 Bot ${input.assignee}`)
    // 派发沙箱覆盖（DSHBOTS-156）：可选 sandbox 只收紧不放大，校验对准承接 bot 的配置档；
    // 缺省 = 跟随 bot 配置（新卡 NULL/重派保留旧值），'inherit' 显式回落 bot 配置（重派清覆盖）。
    const sandboxOverride = input.sandbox === undefined
      ? undefined
      : resolveSandboxOverride(this.botRow(member.id), input.sandbox)
    if (input.taskId || input.task) {
      const task = this.resolveBotTask(project, input.taskId ?? input.task)
      if (['done', 'canceled'].includes(task.status)) throw conflict(`任务 ${project.key}-${task.number} 已结束，不能重派`)
      // 任务卡修正闭环（DSHBOTS-232 ①）：重派可同时改卡面（标题/描述/优先级）——先经
      // updateTask 落卡，卡面变化由其统一触发点通知负责人修正，再走原重派链路。
      // 写范围不在此口改：入队运行快照与调度闸门消费的不是同一份数据，
      // 改范围走工作台 taskUpdateScopes（含排队运行快照同步），不在这里开第二入口。
      const patch: any = {}
      if (input.title !== undefined) patch.title = input.title
      if (input.description !== undefined) patch.description = input.description
      if (input.priority !== undefined) patch.priority = input.priority
      if (Object.keys(patch).length) await this.updateTask(task.id, patch, actor)
      const updated = await this.assignTask(task.id, member.id, actor, { autoStart: false, sandboxOverride })
      void this.tick()
      return updated
    }
    // 派单必须声明写范围（程序化闸门，不靠派单方自觉）：未声明写范围的任务其写运行会与
    // 同项目所有写运行判为冲突并保守串行，一条空范围任务就能把整队堵死。这里直接拒绝，
    // 而不是留到调度器里把并发能力悄悄吃掉。
    const parsedScopes = input.write_scopes === undefined || input.write_scopes === null
      ? parseWriteScopesFromDescription(input.description)
      : parseWriteScopes(input.write_scopes)
    // 闸门按清洗后清单预判（DSHBOTS-168）：全部命中忽略规则 = 实际未声明，落上面的
    // 拒绝。原清单透传 createTask 做权威清洗+审计（审计需真实 taskId），此处只预览不落账。
    const scopes = filterIgnoredWriteScopes(parsedScopes, this.projectWorkDir(project)).kept
    if (!scopes.length) {
      throw badRequest(
        '派单必须声明写范围：传 write_scopes 路径数组，或在描述里写一行「写范围：a, b」。'
        + '未声明会让该任务的写运行与同项目其他写运行全部串行，一条任务即可堵死队列。',
      )
    }
    // 同写范围重复卡拦截（DSHBOTS-82）：同项目已有「写范围完全一致」的在办卡时直接拒绝，
    // 避免同一文件上叠 N 张排队卡空转。force_duplicate 是逃生口：跳过检测，但留审计痕迹。
    // 紧急豁免（DSHBOTS-126）：priority='urgent' 的新卡放行——紧急任务无视排队立即施工，
    // 但创建消息报备与哪张在办卡共用车道，不静默并行。
    const duplicate = this.findDuplicateScopeTask(project.id, scopes)
    const forceDuplicate = input.force_duplicate === true
    const urgentExempt = input.priority === 'urgent'
    if (duplicate && !forceDuplicate && !urgentExempt) {
      // DSHBOTS-269 失败语义引导：拒绝文案 = 原因 + 替代命令（改卡重派而非新开卡）。
      throw conflict(
        `已存在同写范围任务 ${project.key}-${duplicate.number} ${duplicate.title}，请勿重复派单：`
        + '请用 team_assign_task 重派原任务改卡（task=原任务号，附 title/description 即修正卡面），不要为新内容新开卡；'
        + '确需第二张同范围卡时传 force_duplicate=true（每次使用留审计）；紧急任务（priority=urgent）豁免此拦截，可立即派单施工。',
      )
    }
    const task = await this.createTask({
      projectId: project.id,
      title: input.title,
      description: input.description,
      assigneeBotId: member.id,
      priority: input.priority,
      // 透传原始清单（DSHBOTS-168）：清洗+审计由 createTask 统一做（审计挂真实 taskId）。
      writeScopes: parsedScopes,
      // 总监派单可带父子/依赖关系（snake_case 透传，createTask 内统一校验与落库）。
      parentTaskId: input.parent_task_id,
      blockedBy: input.blocked_by,
      // 时效要求（新任务 only）：重派已有任务（上面 input.taskId/input.task 分支）不更新该字段。
      timeBudgetMinutes: input.time_budget_minutes ?? input.timeBudgetMinutes,
      // 紧急豁免共用车道报备（DSHBOTS-126）：urgent 放行同写范围派单时，创建消息注明与哪张在办卡共用车道。
      laneShareTask: urgentExempt && duplicate ? `${project.key}-${duplicate.number}` : null,
      sandboxOverride,
      autoStart: true,
      postCard: true,
    }, actor)
    if (forceDuplicate) {
      this.audit(actor, 'dispatch_force_duplicate', 'task', task.id, {
        writeScopes: scopes,
        duplicateTaskId: duplicate?.id ?? null,
        duplicateIdentifier: duplicate ? `${project.key}-${duplicate.number}` : null,
      })
    }
    return task
  },
}
