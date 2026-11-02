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
