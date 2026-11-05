// 事件接线：document submit 委托（原 app.js 的表单提交监听）。
import { state } from './state.js'
import { activeProject, toast } from './util.js'
import { api, loadState } from './api.js'
import { closeModal, normalizeTimeBudgetMinutes, openTask, parseFallbackFields, reloadTaskModal } from './modal-forms.js'
import { saveTaskFromForm } from './composer.js'
import { loadSoloDetail } from './chat.js'
import { refresh, startTerminalPoll, render, formPayload } from '../app.js'

document.addEventListener('submit', async (event) => {
  const form = (event.target as any).closest('form[data-form]')
  if (!form) return
  event.preventDefault()
  const type = form.dataset.form
  const payload = formPayload(form)
  try {
    if (type === 'create-project') {
      const result = await api('create_project', {
        name: payload.name,
        key: payload.key || undefined,
        description: payload.description,
        ownerBotId: payload.ownerBotId,
        memberIds: new FormData(form).getAll('memberIds'),
        productionDir: (payload.productionDir as string)?.trim() || undefined,
      })
      closeModal()
      state.projectId = result.id
      state.view = 'chat'
      await refresh()
      toast('项目已创建', 'success')
      return
    }
    if (type === 'remove-tracking') {
      // 第二步表单：项目名一致才提交（input 监听门禁已保证按钮可用）。
      await api('remove_project_tracking', {
        projectId: payload.projectId,
        confirmName: payload.confirmName,
        purgeWorkdir: payload.purge === '1',
      })
      closeModal()
      // 移除后若正停在该项目上，回到群聊并让 loadState 重新解析可用项目，避免引用已删除的数据。
      if (state.projectId === payload.projectId) {
        state.projectId = null
        state.view = 'chat'
      }
      await refresh()
      toast('已移除追踪，管理数据已清理', 'success')
      return
    }
    if (type === 'create-bot' || type === 'update-bot') {
      const ref = String(payload.modelRef || '')
      const slash = ref.indexOf('/')
      const provider = slash > 0 ? ref.slice(0, slash) : null
      const model = slash > 0 ? ref.slice(slash + 1) : null
      // 备用模型：留空 = 不启用（三个字段一起清空，由后端按 null 落库）。
      const fallback = parseFallbackFields(payload.fallbackModelRef, payload.fallbackEffort)
      const common = {
        name: payload.name,
        role: payload.role,
        instructions: payload.instructions,
        color: payload.color,
        provider,
        model,
        effort: payload.effort || null,
        filePolicy: payload.filePolicy || undefined,
        fallbackProvider: fallback.fallbackProvider,
        fallbackModel: fallback.fallbackModel,
        fallbackEffort: fallback.fallbackEffort,
      }
      if (type === 'create-bot') {
        await api('create_bot', common)
        toast('Bot 已创建', 'success')
      } else {
        await api('update_bot', { botId: payload.botId, patch: common })
        toast('Bot 配置已更新', 'success')
      }
      closeModal()
      await refresh()
      if (state.view === 'solo-config') await loadSoloDetail()
      return
    }
    if (type === 'invite-member') {
      const botId = String(payload.botId || '')
      // 未选人时不提交，弹窗保持打开（零变更）。
      if (!botId) {
        toast('请先选择一个 Bot', 'error')
        return
      }
      await api('add_member', { projectId: activeProject()?.id, botId })
      closeModal()
      await refresh()
      toast('已邀请加入项目', 'success')
      return
    }
    if (type === 'create-task') {
      // 父任务与依赖任务（DSHBOTS-58）：多选字段用 getAll 取全部选中项；空值即不建关系。
      const blockedBy = new FormData(form).getAll('blockedBy').map(String).filter(Boolean)
      // 时效要求（分钟）：选填；空串/0/负数 → null（整键不传），正数取整数分钟。
      const timeBudgetMinutes = normalizeTimeBudgetMinutes(payload.time_budget_minutes)
      const task = await api('create_task', {
        projectId: payload.projectId,
        title: payload.title,
        description: payload.description,
        assigneeBotId: payload.assigneeBotId || null,
        priority: payload.priority,
        parentTaskId: payload.parentTaskId || null,
        blockedBy,
        autoStart: form.querySelector('[name="autoStart"]')?.checked === true,
        // 时效要求（分钟）：选填；空串/0/负数归一为 null 且整键不传（服务端钳 1..10080，NULL 即不注入提示词）。
        ...(timeBudgetMinutes === null ? {} : { time_budget_minutes: timeBudgetMinutes }),
      })
      closeModal()
      await loadState(state.projectId, { quiet: true })
      render()
      toast(`已创建 ${task.identifier}`, 'success')
      await openTask(task.id)
      return
    }
    if (type === 'update-task') {
      const taskId = payload.taskId
      await saveTaskFromForm(taskId)
      await loadState(state.projectId, { quiet: true })
      await reloadTaskModal(taskId)
      toast('任务已保存', 'success')
      return
    }
    if (type === 'add-comment') {
      const comment = await api('add_comment', { taskId: payload.taskId, body: payload.body })
      await loadState(state.projectId, { quiet: true })
      await reloadTaskModal(payload.taskId)
      toast(comment?.steered ? '评论已直通执行中的会话' : '评论已添加', 'success')
      return
    }
    if (type === 'create-memory') {
      const [scopeType, scopeId] = String(payload.scope || '').split(':')
      await api('create_memory', {
        scopeType,
        scopeId,
        topic: payload.topic,
        content: payload.content,
      })
      closeModal()
      await refresh()
      toast('记忆已写入', 'success')
      return
    }
    if (type === 'update-memory') {
      await api('update_memory', {
        memoryId: payload.memoryId,
        topic: payload.topic,
        content: payload.content,
      })
      closeModal()
      await refresh()
      toast('记忆已更新', 'success')
      return
    }
    if (type === 'create-proposal') {
      const kind = payload.kind
      const proposal = await api('create_proposal', {
        kind,
        botId: payload.botId || null,
        projectId: payload.projectId || null,
        title: payload.title,
        rationale: payload.rationale,
        evaluation: payload.evaluation,
        payload: kind === 'skill'
          ? {
            slug: payload.slug,
            name: payload.name,
            description: payload.description,
            content: payload.content,
            version: payload.version,
          }
          : { instructions: payload.instructions },
      })
      if (kind === 'skill' && !payload.content) throw new Error('技能内容不能为空')
      closeModal()
      await refresh()
      toast('提案已提交审批', 'success')
      return
    }
    if (type === 'save-price') {
      if (!String(payload.model ?? '').trim()) throw new Error('模型不能为空')
      const price = value => (String(value ?? '').trim() === '' ? 0 : Number(value))
      if ([payload.inputPerMtok, payload.outputPerMtok, payload.cacheReadPerMtok, payload.cacheWritePerMtok].some(value => Number.isNaN(price(value)))) throw new Error('价格需要是数字')
      await api('save_price', {
        provider: payload.provider ?? '',
        model: payload.model,
        inputPerMtok: price(payload.inputPerMtok),
        cacheReadPerMtok: price(payload.cacheReadPerMtok),
        cacheWritePerMtok: price(payload.cacheWritePerMtok),
        outputPerMtok: price(payload.outputPerMtok),
        currency: ((payload.currency as string) || 'CNY').toUpperCase(),
      })
      closeModal()
      await refresh()
      toast('模型价格已保存，新调用将按此计价', 'success')
      return
    }
    if (type === 'save-project') {
      // 成员改在「成员」tab 用邀请/移除管理（增量 API）；设置页不再全量提交成员表。
      await api('update_project', {
        projectId: payload.projectId,
        patch: {
          name: payload.name,
          description: payload.description,
          ownerBotId: payload.ownerBotId,
          replyMode: payload.replyMode,
          tokenBudget: payload.tokenBudget === '' ? null : Number(payload.tokenBudget),
          costBudget: payload.costBudget === '' ? null : Number(payload.costBudget),
          codeHygieneLimitLines: payload.codeHygieneLimitLines === '' ? null : Number(payload.codeHygieneLimitLines),
          productionDir: String(payload.productionDir ?? ''),
        },
      })
      await refresh()
      toast('项目设置已保存', 'success')
      return
    }
    if (type === 'upsert-secret') {
      const scope = payload.scope === 'team' ? 'team' : 'project'
      if (scope === 'project' && !payload.projectId) throw new Error('项目级密钥必须选择项目')
      if (String(payload.value ?? '').length < 8) throw new Error('密钥值至少 8 个字符')
      await api('upsert_secret', {
        scope,
        projectId: scope === 'project' ? payload.projectId : null,
        name: payload.name,
        purpose: payload.purpose ?? '',
        value: payload.value,
      })
      await refresh()
      toast('密钥已保存', 'success')
      return
    }
    if (type === 'approve-secret') {
      if (String(payload.value ?? '').length < 8) throw new Error('密钥值至少 8 个字符')
      await api('approve_secret_request', { requestId: payload.requestId, value: payload.value })
      await refresh()
      toast('密钥请求已批准并物化', 'success')
      return
    }
    if (type === 'terminal-run') {
      const command = String(payload.command ?? '').trim()
      if (!command) throw new Error('命令不能为空')
      await api('run_command', { projectId: payload.projectId, command })
      state.terminalDraft = ''
      await loadState(state.projectId, { quiet: true })
      render()
      startTerminalPoll()
      return
    }
  } catch (error: any) {
    toast(error.message || String(error), 'error')
  }
})

