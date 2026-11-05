import { state } from './state.js'
import { t } from './i18n.js'
import { activeProject, avatarSeedRandom, botById, toast } from './util.js'
import { api, loadState } from './api.js'
import { closeAutocomplete, closeImageViewer, ensureComposerImageInput, openInlineImage, openMessageImage, removePendingImage, saveTaskFromForm } from './composer.js'
import { closeDirPicker, closeModal, openBot, openModal, openSkillDetail, reloadTaskModal, renderDirPicker } from './modal-forms.js'
import { renderModalLayer } from './modal-layer.js'
import { exportUsageCsv, switchUsageWindow, usageMode } from './usage.js'
import { focusApprovalCard, focusQuestionCard, questionDraftSelection, questionSelectOption } from './cards.js'
import { loadSoloDetail } from './chat.js'
import { searchMemories } from './tasks.js'
import { handleBoardAction } from './events-board.js'
import { refresh, renderKeepingChatScroll, render, beginChatPending, endChatPending } from '../app.js'

async function refreshAfterTask(taskId) {
  await loadState(state.projectId, { quiet: true })
  await reloadTaskModal(taskId)
}


document.addEventListener('click', async (event) => {
  // 正文内嵌图（markdown <img>）没有 data-action：先于动作委托拦截，点击直接放大；
  // 附图缩略图在 .message-bubble 外，不受此分支影响，仍走 view-message-image 进查看器。
  const bubbleImg = (event.target as any).closest?.('.message-bubble img')
  if (bubbleImg) {
    event.preventDefault()
    openInlineImage(bubbleImg)
    return
  }
  const target = (event.target as any).closest('[data-action]')
  if (!target) return
  const action = target.dataset.action
  if (action === 'modal-backdrop') {
    if (event.target === target) closeModal()
    return
  }
  try {
    if (await handleBoardAction(action, target)) return
    switch (action) {
      case 'approval-decide': {
        // 群聊审批卡片按钮：本地立即回显已决状态（不等 2.8s 轮询），请求失败回滚并提示。
        const approvalId = target.dataset.approvalId
        const decision = target.dataset.decision
        if (!approvalId || !['allow', 'reject'].includes(decision)) break
        // 幂等：同一审批正在决策中时不再发请求（按钮已 disabled，这里再挡一层）。
        if (state.approvalDeciding.has(approvalId)) break
        const list = state.data?.approvals ?? []
        const index = list.findIndex(item => item.id === approvalId)
        const previous = index >= 0 ? { ...list[index] } : null
        const status = decision === 'allow' ? 'allowed' : 'rejected'
        state.approvalDeciding.add(approvalId)
        // 乐观回显：卡片立刻变已决，顶部徽标同步减一。
        if (previous) list[index] = { ...previous, status, decided_at: new Date().toISOString(), remainingMs: 0 }
        const pending = state.data?.pendingApprovals
        if (pending) {
          pending.items = (pending.items ?? []).filter(item => item.id !== approvalId)
          pending.count = Math.max(0, Number(pending.count ?? 0) - 1)
        }
        render()
        try {
          // 用后端返回的终态覆盖乐观值（decided_at 以后端为准）。
          const updated = await api('approval_decide', { approvalId, decision }, { quiet: true })
          if (updated && index >= 0) list[index] = updated
          else if (updated) list.push(updated)
        } catch (error: any) {
          // 回滚到决策前状态，避免「界面已决、后端仍 pending」的假成功。
          if (previous && index >= 0) list[index] = previous
          const rollback = state.data?.pendingApprovals
          if (rollback && previous) {
            rollback.items = [previous, ...(rollback.items ?? [])]
            rollback.count = Number(rollback.count ?? 0) + 1
          }
          toast(error?.message ? `${t("审批失败：")}${error.message}` : t("审批失败，请重试"), 'error')
        } finally {
          state.approvalDeciding.delete(approvalId)
          render()
        }
        break
      }
      case 'toggle-approvals':
        // 顶部「待处理审批」条：展开/收起跨项目明细。
        state.approvalPanelOpen = !state.approvalPanelOpen
        render()
        break
      case 'focus-approval': {
        // 点明细跳到对应项目群聊并滚动到该审批卡（复用 focusApprovalCard）。
        const item = (state.data?.pendingApprovals?.items ?? []).find(entry => entry.id === target.dataset.approvalId)
        if (!item) break
        state.approvalPanelOpen = false
        focusApprovalCard(item)
        break
      }
      case 'question-option': {
        // 选项切换：只改本地草稿与按钮态，不整页重绘（保住同卡内其它输入框的焦点与内容）。
        const questionId = target.dataset.questionId
        const label = target.dataset.label
        if (!questionId || label === undefined) break
        const draft = state.questionDraft.get(questionId)
        const question = (state.data?.questions ?? []).find(entry => entry.id === questionId)
        const item = question?.questions?.find(entry => entry.id === target.dataset.itemId)
        if (!draft || !item) break
        const selectedOf = questionSelectOption(draft, item, label, target.dataset.multi === '1')
        const group = target.closest('.question-options')
        if (group) {
          for (const btn of group.querySelectorAll('.question-option')) {
            const on = selectedOf.has(btn.dataset.label)
            btn.classList.toggle('is-selected', on)
            btn.setAttribute('aria-pressed', on ? 'true' : 'false')
          }
        }
        break
      }
      case 'question-submit': {
        // 提交回答：本地草稿 + 卡片内补充说明合成宿主 {answers:[{id,selected,custom}]}。
        const questionId = target.dataset.questionId
        if (!questionId || state.questionAnswering.has(questionId)) break
        const question = (state.data?.questions ?? []).find(entry => entry.id === questionId)
        if (!question || question.status !== 'pending') break
        const items = Array.isArray(question.questions) ? question.questions : []
        const draft = state.questionDraft.get(questionId) ?? { selected: new Map(), custom: {} }
        const card = target.closest('.question-card')
        const answers = items.map(item => {
          let custom = ''
          if (card) {
            for (const input of card.querySelectorAll('.question-custom')) {
              if (input.dataset.itemId === item.id) { custom = String(input.value ?? '').trim(); break }
            }
          }
          if (!custom) custom = String(draft.custom[item.id] ?? '').trim()
          return { id: item.id, selected: Array.from(questionDraftSelection(draft, item.id)), custom: custom || undefined }
        })
        // 幂等 + 乐观回显：卡片立刻变已答，顶部徽标同步减一。
        state.questionAnswering.add(questionId)
        const list = state.data?.questions ?? []
        const index = list.findIndex(entry => entry.id === questionId)
        const previous = index >= 0 ? { ...list[index] } : null
        if (previous) list[index] = { ...previous, status: 'answered', answered_at: new Date().toISOString(), answer: { answers }, remainingMs: 0 }
        const pending = state.data?.pendingQuestions
        if (pending) {
          pending.items = (pending.items ?? []).filter(entry => entry.id !== questionId)
          pending.count = Math.max(0, Number(pending.count ?? 0) - 1)
        }
        render()
        try {
          // 用后端返回的终态覆盖乐观值（answered_at 以后端为准）。
          const updated = await api('question_answer', { questionId, answers }, { quiet: true })
          if (updated && index >= 0) list[index] = updated
          else if (updated) list.push(updated)
          state.questionDraft.delete(questionId)
        } catch (error: any) {
          // 回滚到提交前状态，避免「界面已答、后端仍 pending」的假成功。
          if (previous && index >= 0) list[index] = previous
          const rollback = state.data?.pendingQuestions
          if (rollback && previous) {
            rollback.items = [previous, ...(rollback.items ?? [])]
            rollback.count = Number(rollback.count ?? 0) + 1
          }
          toast(error?.message ? `${t("回答失败：")}${error.message}` : t("回答失败，请重试"), 'error')
        } finally {
          state.questionAnswering.delete(questionId)
          render()
        }
        break
      }
      case 'toggle-questions':
        // 顶部「待回答提问」条：展开/收起跨项目明细。
        state.questionPanelOpen = !state.questionPanelOpen
        render()
        break
      case 'focus-question': {
        // 点明细跳到对应项目群聊并滚动到该提问卡（复用 focusQuestionCard）。
        const entry = (state.data?.pendingQuestions?.items ?? []).find(item => item.id === target.dataset.questionId)
        if (!entry) break
        state.questionPanelOpen = false
        focusQuestionCard(entry)
        break
      }
      case 'quote-message': {
        // 引用回复：把目标消息挂到 composer 上方的引用条；再点同一条则取消。
        const messageId = target.dataset.messageId
        if (!messageId) break
        state.replyTo = state.replyTo?.id === messageId
          ? null
          : { id: messageId, senderName: target.dataset.senderName ?? '', excerpt: (target.dataset.excerpt ?? '').slice(0, 120) }
        renderKeepingChatScroll()
        break
      }
      case 'cancel-reply':
        state.replyTo = null
        renderKeepingChatScroll()
        break
      case 'attach-image':
        // 打开 body 级单例 file input，选完由 change 事件读文件（accept 已在 input 上限定四种 MIME）。
        ensureComposerImageInput().click()
        break
      case 'remove-pending-image':
        removePendingImage(target.dataset.imageKey)
        break
      case 'view-message-image':
        await openMessageImage(target.dataset.imageId)
        break
      case 'close-image-viewer':
        closeImageViewer()
        break
      case 'solo-bot': {
        const botId = target.dataset.botId
        if (!botId) break
        // 从树上或 Bots 页打开 1V1 对话窗口；已在看同一个会话则不重复加载。
        // 草稿按 solo:<botId> 分开记，切换不清空（群聊/单聊/其他 Bot 各自保留）。
        if (state.soloBotId !== botId) {
          state.soloBotId = botId
          closeAutocomplete()
        }
        state.replyTo = null // 单聊无引用语义，跨上下文不留引用条
        state.chatMode = 'solo'
        state.view = 'chat'
        // 乐观切换（DSHBOTS-167）：先出骨架让点击立即有反馈，再异步取数落真实列表。
        const pendingSeq = beginChatPending({ projectId: state.projectId, chatMode: 'solo', soloBotId: botId })
        render()
        try {
          await loadState(state.projectId, { quiet: true })
        } catch {
          // 取数失败也要清标志并落回上一次可用数据，否则骨架常驻。
        } finally {
          endChatPending(pendingSeq)
        }
        render()
        break
      }
      case 'copy': {
        const value = target.dataset.copy
        if (value) {
          await navigator.clipboard.writeText(value).catch(() => {})
          toast(t('toast.copied'), 'success')
        }
        break
      }
       case 'pick-dir-open': {
         const input = document.getElementById(target.dataset.pickerFor) as HTMLInputElement | null
        const current = input?.value?.trim() ?? ''
        await renderDirPicker(target.dataset.pickerFor, current.startsWith('/') ? current : '')
        break
      }
      case 'pick-dir-nav': {
        await renderDirPicker(target.dataset.pickerFor, target.dataset.path || '')
        break
      }
      case 'pick-dir-up': {
        const from = target.dataset.path || '/'
        const parent = from.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
        await renderDirPicker(target.dataset.pickerFor, parent)
        break
      }
      case 'pick-dir-home': {
        await renderDirPicker(target.dataset.pickerFor, '')
        break
      }
       case 'pick-dir-choose': {
         const input = document.getElementById(target.dataset.pickerFor) as HTMLInputElement | null
        if (input && target.dataset.path) {
          input.value = target.dataset.path
          // 程序赋值不触发 input 事件，手动把所属表单标记为未保存，暂停自动刷新直到保存。
          input.closest('form')?.setAttribute('data-dirty', '1')
          closeDirPicker(target.dataset.pickerFor)
        }
        break
      }
      case 'pick-dir-close': {
        closeDirPicker(target.dataset.pickerFor)
        break
      }
      case 'sync-skills': {
        const result = await api('sync_skills', {})
        await loadState(state.projectId, { quiet: true })
        render()
        toast(`${t("已扫描")} ${result.count} ${t("个共享技能")}`, 'success')
        break
      }
      case 'skill-detail': {
        void openSkillDetail(String(target.dataset.slug || ''))
        break
      }
      case 'toggle-skill': {
        const project = activeProject()
        const slug = String(target.dataset.slug || '')
        const disabled = target.dataset.disabled === '1'
        if (!project || !slug) break
        await api('toggle_skill', { projectId: project.id, slug, disabled })
        await loadState(state.projectId, { quiet: true })
        render()
        toast(disabled ? `${t("已在项目「")}${project.name}${t("」关闭")} ${slug}` : `${t("已在项目「")}${project.name}${t("」恢复")} ${slug}`, 'success')
        break
      }
      case 'archive-bot': {
        const botId = target.dataset.botId
        const bot = botById(botId)
        if (!bot || !window.confirm(`${t("归档")} ${bot.name}${t("？总监关系必须先解除。")}`)) break
        await api('archive_bot', { botId })
        closeModal()
        await refresh()
        // 归档后留在当前页：solo-config 会随即切到 archived 分支，露出「移除追踪」入口。
        toast(t("Bot 已归档"), 'success')
        break
      }
      case 'roll-avatar':
      case 'toggle-avatar': {
        const botId = target.dataset.botId
        // roll = 随机新种子（未启用即启用）；toggle = 按当前状态翻转，关闭回落首字/首字母头像。
        const on = Boolean(botById(botId)?.avatar_seed)
        const seed = action === 'roll-avatar' || !on ? avatarSeedRandom() : null
        await api('update_bot', { botId, patch: { avatarSeed: seed } })
        await loadState(state.projectId, { quiet: true })
        if (state.view === 'solo-config') {
          await loadSoloDetail()
        } else {
          await openBot(botId)
        }
        toast(seed ? t("像素头像已更新") : t("已切回文字头像"), 'success')
        break
      }
      case 'rollback-bot': {
        const botId = target.dataset.botId
        if (!window.confirm(t("回滚到该版本？"))) break
        await api('rollback_bot', { botId, revisionId: target.dataset.revisionId })
        await loadState(state.projectId, { quiet: true })
        if (state.view === 'solo-config') {
          await loadSoloDetail()
        } else {
          await openBot(botId)
        }
        toast(t("已回滚并生成新版本"), 'success')
        break
      }
      case 'archive-project': {
        if (!window.confirm(t("归档项目？项目将停止新运行，工作区文件保留。"))) break
        await api('archive_project', { projectId: target.dataset.projectId })
        await refresh()
        toast(t("项目已归档"), 'success')
        break
      }
      case 'reopen-project': {
        await api('reopen_project', { projectId: target.dataset.projectId })
        await refresh()
        toast(t("项目已再开，恢复为进行中"), 'success')
        break
      }
      case 'remove-tracking-open': {
        const item = (state.data?.projects ?? []).find(project => project.id === target.dataset.projectId)
        if (!item) break
        openModal({ type: 'remove-tracking', projectId: item.id, name: item.name, step: 1, purge: false })
        break
      }
      case 'remove-tracking-step2': {
        if (state.modal?.type !== 'remove-tracking') break
        // 复选框状态在翻页时读取一次：第二步的确认文案与最终提交都以此为准。
        state.modal.purge = (document.getElementById('remove-tracking-purge') as HTMLInputElement | null)?.checked === true
        state.modal.step = 2
        // 弹窗层只认 renderModalLayer 直调：modal 打开期间整页渲染被 D-98 遮罩闸门
        // 拦截（app.js 只记 pending 不碰 #modal-root），误走整页路径会让翻页零响应（DSHBOTS-192）。
        renderModalLayer()
        break
      }
      case 'remove-tracking-back': {
        if (state.modal?.type !== 'remove-tracking') break
        state.modal.step = 1
        renderModalLayer()
        break
      }
      case 'bot-remove-tracking-open': {
        const bot = botById(target.dataset.botId)
        // 仅已归档 Bot 可移除追踪（软移除，DSHBOTS-193）；未归档一律零响应。
        if (!bot || bot.status !== 'archived') break
        openModal({ type: 'bot-remove-tracking', botId: bot.id, name: bot.name, step: 1 })
        break
      }
      case 'bot-remove-tracking-step2': {
        if (state.modal?.type !== 'bot-remove-tracking') break
        state.modal.step = 2
        // 弹窗层只认 renderModalLayer 直调（D-98 遮罩闸门，同 remove-tracking 口径）。
        renderModalLayer()
        break
      }
      case 'bot-remove-tracking-back': {
        if (state.modal?.type !== 'bot-remove-tracking') break
        state.modal.step = 1
        renderModalLayer()
        break
      }
      case 'bot-remove-tracking-confirm': {
        if (state.modal?.type !== 'bot-remove-tracking') break
        const botId = state.modal.botId
        const confirmName = (document.getElementById('remove-tracking-name') as HTMLInputElement | null)?.value ?? ''
        await api('remove_bot_tracking', { botId, confirmName })
        closeModal()
        // 正停在该 Bot 的单聊/配置页时回到群聊，避免引用已移除的 Bot；
        // 其他页面（如总览 bots 页）仅清理跳过，不传送视图。
        if (state.soloBotId === botId && (state.view === 'solo-config' || (state.view === 'chat' && state.chatMode === 'solo'))) {
          state.soloBotId = null
          state.view = 'chat'
          state.chatMode = 'group'
        }
        await refresh()
        toast(t("已移除追踪，Bot 已从工作台列表移除"), 'success')
        break
      }
      case 'reject-task': {
        // 驳回（DSHBOTS-141）：终态任务退回 backlog，走 transition_task 通道，与看板拖拽同口径；
        // 后端在离开终态且仍有活跃运行时会拒绝，错误文案直接透出。
        const taskId = target.dataset.taskId
        const task = (state.data?.tasks ?? []).find(item => item.id === taskId)
        if (!window.confirm(t('task.rejectConfirm', { title: task?.title ?? '' }))) break
        try {
          await api('transition_task', { taskId, status: 'backlog' }, { quiet: true })
          await refreshAfterTask(taskId)
          toast(t('task.rejectDone'), 'success')
        } catch (error: any) {
          toast(error.message || String(error), 'error')
        }
        break
      }
      case 'review-delegate': {
        // 验收核验委派（DSHBOTS-107）：核验运行由后端派生，结论评论落任务；裁决仍走拖卡/验收。
        const taskId = target.dataset.taskId
        await api('task_review_delegate', { taskId })
        await refreshAfterTask(taskId)
        toast(t("已委派子代理核验，结论将写回任务评论"), 'success')
        break
      }
      case 'run-task': {
        const taskId = target.dataset.taskId
        const assignee = await saveTaskFromForm(taskId)
        if (!assignee) {
          toast(t("请先选择负责人"), 'error')
          break
        }
        await api('assign_task', { taskId, botId: assignee })
        await refreshAfterTask(taskId)
        toast(t("任务已进入执行队列"), 'success')
        break
      }
      case 'cancel-run': {
        await api('cancel_run', { runId: target.dataset.runId })
        await refreshAfterTask(target.dataset.taskId || state.modal?.detail?.id)
        toast(t("运行已取消"), 'success')
        break
      }
      case 'retry-run': {
        const run = await api('retry_run', { runId: target.dataset.runId })
        await refreshAfterTask(run.task_id)
        toast(t("已重新排队"), 'success')
        break
      }
      case 'edit-scopes': {
        // 写范围编辑态（DSHBOTS-155）：只翻 modal 局部标志并同步弹窗层，不整页重建。
        if (state.modal?.type === 'task') state.modal.editingScopes = true
        renderModalLayer()
        break
      }
      case 'cancel-scopes-edit': {
        if (state.modal?.type === 'task') state.modal.editingScopes = false
        renderModalLayer()
        break
      }
      case 'update-scopes': {
        // 保存走 task_update_scopes（DSHBOTS-151/155）：归一、终态/running 拒改、queued 快照同步都在
        // 服务端裁决，失败文案（如「先等运行结束或取消」）原样透传给用户。
        const scopes = ((document.getElementById('task-write-scopes') as HTMLInputElement | null)?.value ?? '').split(/[,，、\s]+/).filter(Boolean)
        try {
          await api('task_update_scopes', { taskId: target.dataset.taskId, write_scopes: scopes }, { quiet: true })
          await refreshAfterTask(target.dataset.taskId)
          toast(t("写范围已更新"), 'success')
        } catch (error: any) {
          toast(error.message || String(error), 'error')
        }
        break
      }
      case 'open-artifact': {
        window.open(target.dataset.url, '_blank', 'noopener')
        break
      }
      case 'delete-secret': {
        const name = target.dataset.secretName || t("该密钥")
        // DSHBOTS-106 起明文只在批准时一次性物化到数据目录，项目工作区不再有明文密钥文件；
        // 删除即吊销：已下发的一次性运行时副本当场失效，重新使用要再走一次申请与批准。
        if (!window.confirm(t("删除密钥 ${name}？相关项目已下发的一次性运行时副本会立即失效，重新使用需再次申请。", { name: name }))) break
        await api('delete_secret', { secretId: target.dataset.secretId })
        await refresh()
        toast(t("密钥已删除"), 'success')
        break
      }
      case 'deny-secret-request': {
        if (!window.confirm(t("拒绝该密钥请求？发起的 Bot 会在群里收到系统提示。"))) break
        await api('deny_secret_request', { requestId: target.dataset.requestId })
        await refresh()
        toast(t("已拒绝该密钥请求"), 'success')
        break
      }
      case 'delete-memory': {
        if (!window.confirm(t("归档这条记忆？归档后不会再被 Bot 引用。"))) break
        await api('delete_memory', { memoryId: target.dataset.memoryId })
        await refresh()
        toast(t("记忆已归档"), 'success')
        break
      }
      case 'edit-memory': {
        const memory = (state.data?.memories ?? []).find(item => item.id === target.dataset.memoryId)
        if (memory) openModal({ type: 'memory', memory })
        break
      }
      case 'open-invite-member': {
        openModal({ type: 'invite-member', botId: '' })
        break
      }
      case 'remove-member': {
        const botId = target.dataset.botId
        const name = botById(botId)?.name ?? t("该成员")
        if (!window.confirm(t("确认将 ${name} 移出本项目？移除后不再接收本项目的提及与新任务。", { name: name }))) break
        await api('remove_member', { projectId: activeProject()?.id, botId })
        await refresh()
        toast(t("已移出项目"), 'success')
        break
      }
      case 'batch-decide-proposals': {
        const decision = target.dataset.decision
        const botId = target.dataset.botId
        const items = (state.data?.proposals ?? [])
          .filter(item => item.status === 'pending' && (item.bot_id ?? '') === botId)
        if (items.length === 0) break
        const bot = botById(botId)
        const label = decision === 'approved' ? t("通过并应用") : t("拒绝")
        if (!window.confirm(`${t("确认")}${label} ${bot?.name ?? t("未归属 Bot")} ${t("的全部")} ${items.length} ${t("条待审提案？")}`)) break
        for (const item of items) {
          await api('decide_proposal', { proposalId: item.id, decision })
        }
        await refresh()
        toast(`${t("已批量")}${label} ${items.length} ${t("条提案")}`, 'success')
        break
      }
      case 'decide-proposal': {
        const decision = target.dataset.decision
        const label = decision === 'approved' ? t("通过并应用") : t("拒绝")
        if (!window.confirm(t("确认${label}该提案？", { label: label }))) break
        await api('decide_proposal', { proposalId: target.dataset.proposalId, decision })
        await refresh()
        toast(decision === 'approved' ? t("提案已应用") : t("提案已拒绝"), 'success')
        break
      }
      case 'evaluate-proposal': {
        const verdict = target.dataset.verdict === 'fail' ? 'fail' : 'pass'
        const notes = window.prompt(t("评估说明（可留空）"), '') ?? ''
        await api('evaluate_proposal', { proposalId: target.dataset.proposalId, evaluation: { verdict, notes } })
        await refresh()
        toast(verdict === 'pass' ? t("已记录评估结论：通过") : t("已记录评估结论：不通过"), 'success')
        break
      }
      case 'promote-proposal': {
        if (!window.confirm(t("确认把灰度提案转正为全量生效？"))) break
        await api('promote_proposal', { proposalId: target.dataset.proposalId })
        await refresh()
        toast(t("提案已转正"), 'success')
        break
      }
      case 'usage-window':
        await switchUsageWindow(target.dataset.window)
        break
      case 'usage-scope':
        // 口径切换只属于全局视图；群聊/单聊 tab 的口径由入口固定，不接受切换。
        if (usageMode() !== 'global') break
        state.usageScope = target.dataset.scope
        state.usageBot = null
        render()
        break
      case 'usage-drill':
        state.usageBot = target.dataset.botId || null
        render()
        break
      case 'usage-clear-drill':
        state.usageBot = null
        render()
        break
      case 'export-usage-csv':
        await exportUsageCsv()
        break
      case 'search-memories':
        await searchMemories()
        break
      case 'clear-memory-search':
        state.memoryQuery = ''
        state.memoryResults = null
        render()
        break
      case 'approve-memory':
        await api('approve_memory', { memoryId: target.dataset.memoryId })
        await refresh()
        toast(t("记忆已通过"), 'success')
        break
      case 'reject-memory':
        await api('reject_memory', { memoryId: target.dataset.memoryId })
        await refresh()
        toast(t("记忆已拒绝"), 'success')
        break
      case 'rollback-skill':
        await api('rollback_skill', { slug: target.dataset.slug, version: target.dataset.version })
        await refresh()
        toast(`${t("技能已回滚到")} v${target.dataset.version}`, 'success')
        break
      case 'terminal-stop': {
        await api('cancel_command', { commandId: target.dataset.commandId })
        toast(t("停止信号已发送"), 'success')
        break
      }
      case 'terminal-fill': {
        state.terminalDraft = target.dataset.command ?? ''
        const cmdInput = document.getElementById('terminal-cmd-input') as HTMLInputElement | null
        if (cmdInput && !cmdInput.disabled) {
          cmdInput.value = state.terminalDraft
          cmdInput.focus()
        }
        break
      }
      default:
        break
    }
  } catch (error: any) {
    toast(error.message || String(error), 'error')
  }
})
