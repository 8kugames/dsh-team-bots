// src/services/file-policy.js —— Bot 文件权限档位
// 与 DSH 宿主 SANDBOX_MODES 一一对应；默认工作区内修改。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { badRequest } from '../errors.js'

// bot 文件权限档位，与 DSH 宿主 SANDBOX_MODES 一一对应；默认工作区内修改。
export const FILE_POLICIES = ['read-only', 'workspace-write', 'danger-full-access']

export const FILE_POLICY_LABELS = {
  'read-only': '只读',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全访问',
}

export function normalizeFilePolicy(value) {
  if (value === undefined || value === null || value === '') return 'workspace-write'
  if (!FILE_POLICIES.includes(value)) throw badRequest(`文件权限无效，允许值：${FILE_POLICIES.join(' / ')}`)
  return value
}

// 派发沙箱覆盖可选值（DSHBOTS-156）：只收收紧档。danger-full-access 不在其中——
// 覆盖不得把任务运行放大到比 bot 配置档更宽，完全访问只能来自 bot 配置本身。
export const SANDBOX_OVERRIDES = ['read-only', 'workspace-write']

// 解析派发入参 sandbox（DSHBOTS-156）：缺省/'inherit' → null（跟随 bot 配置档）；
// 档位值必须在允许集内，且不得比 bot 配置档更宽（只收紧不放大，fail closed——
// bot 配置档本身不合法时无法证明覆盖没有放宽，直接拒绝）。
// 运行侧还有同口径兜底：effectiveSandbox 只在不比 bot 配置宽时采用覆盖
// （重派/换负责人等旁路不重校验，防止旧覆盖在新 bot 更严配置下放大权限）。
export function resolveSandboxOverride(bot, value) {
  if (value === undefined || value === null || value === '' || value === 'inherit') return null
  if (!SANDBOX_OVERRIDES.includes(value)) {
    throw badRequest(`沙箱覆盖无效，允许值：inherit / ${SANDBOX_OVERRIDES.join(' / ')}`)
  }
  const policyRank = FILE_POLICIES.indexOf(bot?.file_policy)
  if (policyRank < 0) throw badRequest(`Bot 文件权限档无效（${bot?.file_policy}），不能套用沙箱覆盖`)
  if (FILE_POLICIES.indexOf(value) > policyRank) {
    throw badRequest(`沙箱覆盖只能收紧不能放宽：${value} 比 Bot 配置档 ${bot.file_policy} 更宽`)
  }
  return value
}
