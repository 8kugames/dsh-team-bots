// 事件接线：看板/全局动作（原 app.js click 委托的 board 段）。
// 自带 switch，未命中返回 false；命中即处理并返回 true。
import { state } from './state.js'
import { t } from './i18n.js'
import { activeProject, applyUiScale, applyUiTheme, toast } from './util.js'
import { api, loadState } from './api.js'
import { sendMessage } from './composer.js'
import { closeModal, openBot, openModal, openTask, openTrajectory } from './modal-forms.js'
import { loadOlderMessages, loadSoloDetail } from './chat.js'
import { taskChildrenKey, taskGroupKey } from './tasks.js'
import { toggleDesktopNotify } from './cards.js'
import { usageMode } from './usage.js'
import { UI_SCALE_KEY, UI_THEME_KEY, syncLanguage, refresh, startWechatPoll, stopWechatPoll, bootError, render, chatContextPending, beginChatPending, endChatPending, init } from '../app.js'

export async function handleBoardAction(action, target) {
  switch (action) {
    case 'retry-boot':
      state.bootError = null
      await init()
      break
    case 'nav': {
      // 带 data-project-id 的导航：从调度页的任务行跳到该项目的任务页（顺带切回群聊上下文）。
      const navProjectId = target.dataset.projectId
      state.view = target.dataset.view || 'chat'
      // 用量页三态（DSHBOTS-56）：侧栏入口=全局视图（与上下文零耦合）；群聊 tab=本群；单聊 tab=本 bot。
      // 口径由入口决定，不再按当前上下文收敛。
      if (state.view === 'usage') {
        state.usageMode = target.dataset.usageMode === 'solo' || target.dataset.usageMode === 'domain'
          ? target.dataset.usageMode
          : 'global'
        state.usageScope = 'global'
        state.usageBot = null
      }
      if (navProjectId) {
        state.projectId = navProjectId
        state.chatMode = 'group'
        state.replyTo = null
        await refresh()
        break
      }
      if (state.view === 'solo-config') void loadSoloDetail()
      render()
      break
    }
    case 'toggle-tree': {
      const key = target.dataset.tree
      if (key && key in state.tree) {
        state.tree[key] = !state.tree[key]
        render()
      }
      break
    }
    case 'toggle-task-group': {
      // 分组折叠（DSHBOTS-58）：展开态记在 state.openPanels（key: task-group:<status>），默认全展开。
      const status = target.dataset.status
      if (!status) break
      const key = taskGroupKey(status)
      if (state.openPanels.has(key)) state.openPanels.delete(key)
      else state.openPanels.add(key)
      render()
      break
    }
    case 'toggle-task-children': {
      // 子任务折叠（DSHBOTS-58）：展开态记在 state.openPanels（key: task-children:<taskId>），默认收起。
      const taskId = target.dataset.taskId
      if (!taskId) break
      const key = taskChildrenKey(taskId)
      if (state.openPanels.has(key)) state.openPanels.delete(key)
      else state.openPanels.add(key)
      render()
      break
    }
    case 'reset-scale': {
      const scale = applyUiScale(1)
      try { localStorage.setItem(UI_SCALE_KEY, String(scale)) } catch {}
      render()
      break
    }
    case 'set-theme': {
      state.theme = applyUiTheme(target.dataset.theme)
      try { localStorage.setItem(UI_THEME_KEY, state.theme) } catch {}
      render()
      break
    }
    case 'toggle-notify': {
      await toggleDesktopNotify()
      break
    }
    case 'save-settings': {
      const value = id => document.getElementById(id)?.value ?? ''
      const patch = {
        budget_currency: value('settings-currency'),
        memory_review: value('settings-memory-review'),
        global_token_budget: value('settings-global-token-budget'),
        global_cost_budget: value('settings-global-cost-budget'),
        retention_usage_days: value('settings-retention-usage'),
        retention_run_event_days: value('settings-retention-run'),
        retention_message_days: value('settings-retention-message'),
      }
      await api('update_settings', patch)
      await loadState(state.projectId)
      toast('系统设置已保存', 'success')
      break
    }
    // 界面语言（DSHBOTS-162）：保存后 loadState 拿回新的 state.language，
    // 由既有 syncLanguage 热切换（换字典 + toast.languageSwitched + render），无需重启。
    case 'save-ui-language': {
      const value = document.getElementById('settings-ui-language')?.value ?? 'auto'
      await api('update_settings', { ui_language: value })
      await loadState(state.projectId)
      // poll() 只取数不切语言（ui/app.js:620-642），热切换必须由保存动作自己触发（DSHBOTS-162 R1）。
      syncLanguage()
      toast(t('toast.uiLanguageSaved'), 'success')
      break
    }
    case 'save-run-limits': {
      const value = id => document.getElementById(id)?.value ?? ''
      await api('update_settings', {
        run_timeout_minutes: value('settings-run-timeout'),
        stall_watchdog_minutes: value('settings-stall-watchdog'),
      })
      await loadState(state.projectId)
      toast('运行时效已保存', 'success')
      break
    }
    case 'reconcile-usage': {
      const result = await api('reconcile_usage', {})
      const reconciliation = result?.reconciliation ?? {}
      toast(`对账完成：检查 ${reconciliation.runsChecked ?? 0} 个运行，差异 ${reconciliation.mismatched ?? 0} 个`, 'success')
      await loadState(state.projectId)
      break
    }
    case 'check-dsh-update': {
      state.dshUpdate = await api('dsh_update_info', {})
      render()
      break
    }
    case 'wechat-login': {
      const result = await api('wechat_login', {})
      state.wechatAuth = { qrSvg: result.qrSvg, qrCodeUrl: result.qrCodeUrl }
      toast('二维码已生成，请用微信扫码', 'success')
      startWechatPoll()
      render()
      break
    }
    case 'wechat-code': {
      const code = document.getElementById('wechat-code')?.value?.trim()
      if (!code) {
        toast('请输入微信验证码', 'error')
        break
      }
      await api('wechat_code', { code })
      state.wechatAuth = null
      toast('验证码已提交', 'success')
      startWechatPoll()
      break
    }
    case 'wechat-logout': {
      if (!window.confirm('退出绑定后需要重新扫码才能恢复推送。确认退出？')) break
      await api('wechat_logout', {})
      state.wechatAuth = null
      stopWechatPoll()
      await refresh({ quiet: true })
      toast('已退出微信绑定', 'success')
      break
    }
    case 'select-project':
      state.projectId = target.dataset.projectId
      state.replyTo = null // 切项目即切群聊，引用不能跨项目
      state.chatMode = 'group'
      state.view = 'chat'
      // 乐观切换（DSHBOTS-167）：先出骨架让点击立即有反馈，再异步取数落真实列表。
      const pendingSeq = beginChatPending({ projectId: state.projectId, chatMode: 'group', soloBotId: null })
      render()
      try {
        await refresh()
      } finally {
        // refresh 成功时内部已 render；只有它没落真实内容（取数失败或项目回退到别的项目）
        // 时才补一次，否则骨架会一直停在那里。
        const stuckOnSkeleton = chatContextPending()
        endChatPending(pendingSeq)
        if (stuckOnSkeleton) render()
      }
      break
    case 'refresh':
      await refresh()
      break
    case 'close-modal':
      closeModal()
      break
    case 'new-project':
      openModal({ type: 'new-project' })
      break
    case 'new-bot':
      openModal({ type: 'new-bot' })
      break
    case 'new-task': {
      if (!activeProject()) {
        toast('请先创建项目', 'error')
        break
      }
      openModal({ type: 'new-task' })
      break
    }
    // 派生子任务（D-63）：从任务详情 footer 进入，复用新建任务表单并预填 parentTaskId；
    // 任何任务都可派生（子任务同样可以作为父任务），不加额外限制。
    case 'derive-subtask': {
      if (!activeProject()) {
        toast('请先创建项目', 'error')
        break
      }
      const parentId = target.dataset.taskId || ''
      if (!parentId || !(state.data?.tasks ?? []).some(task => task.id === parentId)) {
        toast('父任务不存在或已刷新，请重试', 'error')
        break
      }
      openModal({ type: 'new-task', parentTaskId: parentId })
      break
    }
    case 'new-memory':
      if (!activeProject()) {
        toast('请先创建项目', 'error')
        break
      }
      openModal({ type: 'memory', memory: null })
      break
    case 'new-proposal':
      if (!activeProject()) {
        toast('请先创建项目', 'error')
        break
      }
      openModal({ type: 'proposal', kind: target.dataset.kind || 'bot_update' })
      break
    case 'new-price':
      openModal({ type: 'price' })
      break
    case 'edit-price': {
      const model = target.dataset.model
      const provider = target.dataset.provider ?? ''
      const price = (state.data?.prices ?? []).find(item => item.model === model && (item.provider ?? '') === provider)
      openModal({ type: 'price', price: price ?? { model, provider } })
      break
    }
    case 'reset-price': {
      const model = target.dataset.model
      if (!window.confirm(`把 ${model} 的价格恢复为配置默认值？`)) break
      await api('reset_price', { provider: target.dataset.provider ?? '', model })
      closeModal()
      await loadState(state.projectId, { quiet: true })
      render()
      toast(`${model} 已恢复默认价格`, 'success')
      break
    }
    case 'open-task':
      await openTask(target.dataset.taskId)
      break
    case 'open-trajectory':
      await openTrajectory(target.dataset.runId)
      break
    case 'edit-bot':
      await openBot(target.dataset.botId)
      break
    case 'send-message':
      await sendMessage()
      break
    case 'load-older':
      await loadOlderMessages()
      break
    default:
      return false
  }
  return true
}
