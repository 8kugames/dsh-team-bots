// src/services/usage.js —— 用量与定价域
// 预算口径、用量估算与模型价格维护。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { badRequest, notFound } from '../errors.js'
import { monthUsageForProject, monthUsageGlobal, setPrice } from '../usage.js'
import { priceKey } from '../pricing.js'



export const usageMethods = {
  globalBudget() {
    const token = Number(this.store.setting('global_token_budget', '') || 0)
    const cost = Number(this.store.setting('global_cost_budget', '') || 0)
    return {
      tokenBudget: Number.isFinite(token) && token > 0 ? token : 0,
      costBudget: Number.isFinite(cost) && cost > 0 ? cost : 0,
    }
  },

  // 成本不完整时（部分调用没有命中价格表）按 token 占比折算，
  // 否则未计价调用会被当成 0 成本，预算就会低估真实花销。
  estimatedCost(usage) {
    if (usage.cost === null) return null
    if (usage.costComplete) return usage.cost
    const pricedTokens = usage.totalTokens - Number(usage.unpricedTokens ?? 0)
    if (pricedTokens <= 0) return usage.cost
    return usage.cost * (usage.totalTokens / pricedTokens)
  },

  // budgetError(project 传 null 表示项目外运行，只受全局预算约束)
  budgetError(project) {
    const currency = this.budgetCurrency()
    const global = this.globalBudget()
    if (global.tokenBudget || global.costBudget) {
      const usage = monthUsageGlobal(this.store, currency)
      if (global.tokenBudget && usage.totalTokens >= global.tokenBudget) {
        return `全局本月 token 预算已用尽（${usage.totalTokens}/${Math.round(global.tokenBudget)}）`
      }
      const cost = this.estimatedCost(usage)
      if (global.costBudget && cost !== null && cost >= global.costBudget) {
        const hint = usage.costComplete ? '' : '（含未计价调用的估算值）'
        return `全局本月成本预算已用尽（${cost.toFixed(4)}/${global.costBudget} ${currency}${hint}）`
      }
    }
    if (!project || (!project.token_budget && !project.cost_budget)) return null
    const usage = monthUsageForProject(this.store, project.id, currency)
    if (project.token_budget && usage.totalTokens >= project.token_budget) {
      return `项目本月 token 预算已用尽（${usage.totalTokens}/${Math.round(project.token_budget)}）`
    }
    const cost = this.estimatedCost(usage)
    if (project.cost_budget && cost !== null && cost >= project.cost_budget) {
      const hint = usage.costComplete ? '' : '（含未计价调用的估算值）'
      return `项目本月成本预算已用尽（${cost.toFixed(4)}/${project.cost_budget} ${currency}${hint}）`
    }
    return null
  },
  latestPrices() {
    const rows = this.store.all('SELECT * FROM model_prices ORDER BY effective_at DESC')
    const latest = new Map()
    for (const row of rows) {
      const key = priceKey(row.provider, row.model)
      if (!latest.has(key)) latest.set(key, row)
    }
    return [...latest.values()].sort((a, b) => {
      const left = `${a.provider} ${a.model}`.toLowerCase()
      const right = `${b.provider} ${b.model}`.toLowerCase()
      return left.localeCompare(right)
    })
  },
  async savePrice(input, actor = this.actor()) {
    const priceId = setPrice(this.store, input)
    this.audit(actor, 'price.save', 'model_price', priceId, input)
    return this.store.get('SELECT * FROM model_prices WHERE id = ?', priceId)
  },

  // 把某条价格恢复为配置里的默认值：写一条新版本，保留历史。
  async resetPrice(input, actor = this.actor()) {
    const provider = String(input.provider ?? '').trim()
    const model = String(input.model ?? '').trim()
    if (!model) throw badRequest('缺少参数 model')
    const defaults = this.config.modelPrices ?? []
    const fallback = defaults.find(item => item.model.toLowerCase() === model.toLowerCase()
      && item.provider.toLowerCase() === provider.toLowerCase())
      ?? defaults.find(item => item.model.toLowerCase() === model.toLowerCase())
    if (!fallback) throw notFound(`模型 ${model} 没有配置默认价格`)
    const priceId = setPrice(this.store, {
      provider,
      model,
      inputPerMtok: fallback.inputPerMtok,
      cacheReadPerMtok: fallback.cacheReadPerMtok,
      cacheWritePerMtok: fallback.cacheWritePerMtok,
      outputPerMtok: fallback.outputPerMtok,
      currency: fallback.currency,
    })
    this.audit(actor, 'price.reset', 'model_price', priceId, { provider, model })
    return this.store.get('SELECT * FROM model_prices WHERE id = ?', priceId)
  },
}
