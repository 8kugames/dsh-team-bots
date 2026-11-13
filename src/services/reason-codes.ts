// src/services/reason-codes.js —— run_events 事件类型注册表（B10/DSHBOTS-337）。
// 吸收原型 core/reasons.ts「结构化原因码注册表」的口径，按 team 现实收窄：
// run_events.type 本就是结构化码（34 类，可过滤、可断言），message 是站点语境的
// 人类细节（同码不同站点的措辞天然不同，如 queued 有 10 种触发语境）——原型
// 「码→唯一文案」的第二层在这里会与 type 列形成双真值，不引入。
// 本注册表的职责：①type 全集的单一登记面（域归属 + 双语规范释义，术语表锚点）；
// ②「新事件必须登记」的守门依据（tests/reason-codes.test.ts 扫描全部 type 字面量
// ⊆ 本表，新闸门/新事件落码时必须先来登记）。
//
// 动态 type（非字面量，如 run.kind 直写）不在静态扫描范围，登记仍需人工核对本表。

export const RUN_EVENT_DOMAINS = ['dispatch', 'run', 'review', 'memory', 'notify', 'ops']

export const RUN_EVENT_TYPES = {
  queued: { domain: 'dispatch', zh: '运行入队', en: 'Run queued' },
  board_resume: { domain: 'dispatch', zh: '看板拖入执行中', en: 'Resumed via board drag' },
  board_pause: { domain: 'dispatch', zh: '任务移出执行中', en: 'Paused via board' },
  task_blocked_dep: { domain: 'dispatch', zh: '依赖未完结，暂缓领取', en: 'Blocked by unfinished dependencies' },
  task_deadline: { domain: 'dispatch', zh: '整卡死线已到，拒绝启动新施工运行', en: 'Card deadline reached; new build runs refused' },
  task_left_in_progress: { domain: 'dispatch', zh: '任务离开执行中', en: 'Task left in-progress' },
  force_blocked: { domain: 'dispatch', zh: '总监强制受阻，运行中止', en: 'Force-blocked by director' },
  stale_superseded: { domain: 'dispatch', zh: '任务已结束，排队运行被清理', en: 'Stale queued run superseded' },
  canceled: { domain: 'run', zh: '运行已取消', en: 'Run canceled' },
  human_slot: { domain: 'dispatch', zh: '借人的消息保底槽放行', en: 'Admitted via human reserve slot' },
  run_parallel: { domain: 'dispatch', zh: '写范围不重叠，并行放行', en: 'Parallel admission via disjoint write scopes' },
  plan_retry: { domain: 'dispatch', zh: '限流重试到期，派生新运行', en: 'Rate-limit retry due; derived run spawned' },
  quota_wait: { domain: 'dispatch', zh: '额度耗尽，排队等待恢复', en: 'Quota exhausted; waiting for reset' },
  quota_fallback: { domain: 'dispatch', zh: '额度耗尽，走备用模型', en: 'Quota exhausted; switched to fallback model' },
  quota_exhausted: { domain: 'run', zh: '额度耗尽入账', en: 'Quota exhaustion recorded' },
  model_fallback: { domain: 'run', zh: '主模型不可用，切换备用模型', en: 'Primary model unavailable; fallback applied' },
  review_fallback: { domain: 'review', zh: '委派核验未产出可用结论，回退', en: 'Delegated review returned nothing usable; fallback' },
  reviewed: { domain: 'review', zh: '记忆审查完成', en: 'Memory review completed' },
  started: { domain: 'run', zh: '运行启动', en: 'Run started' },
  recovered: { domain: 'run', zh: '宿主重启重排队恢复', en: 'Recovered after host restart' },
  sandbox_mode: { domain: 'run', zh: '文件沙箱档位应用', en: 'File sandbox mode applied' },
  config_snapshot: { domain: 'run', zh: '治理配置版本快照', en: 'Governance config snapshot' },
  steered: { domain: 'run', zh: '评论/提示直通注入运行', en: 'Steered into running session' },
  reply_delivered: { domain: 'run', zh: '回信已注入发送方会话', en: 'Reply steered to sender session' },
  attention_answered: { domain: 'notify', zh: '负责人已回答结构化提问', en: 'Owner answered the structured question' },
  notified: { domain: 'notify', zh: '任务提醒已注入', en: 'Task reminder injected' },
  partner_notice: { domain: 'notify', zh: '伙伴提醒记账', en: 'Partner notice recorded' },
  card_changed: { domain: 'notify', zh: '卡面变更修正提示已注入', en: 'Card amendment injected' },
  accept_reminder: { domain: 'memory', zh: '验收边界沉淀提醒已注入', en: 'Acceptance memory reminder injected' },
  scopes_updated: { domain: 'run', zh: '写范围修改同步快照', en: 'Write-scope snapshot refreshed' },
  artifacts_skipped: { domain: 'ops', zh: '产物记录跳过', en: 'Artifact recording skipped' },
  artifacts_ignore_failed: { domain: 'ops', zh: '忽略过滤不可用', en: 'gitignore filter unavailable' },
  read_audit_dup: { domain: 'ops', zh: '工作区指纹与已告警记录相同，不重复点名', en: 'Workspace fingerprint unchanged; no re-alert' },
  read_audit_attributed: { domain: 'ops', zh: '工作区变化已归因到并发写运行', en: 'Workspace change attributed to a concurrent write run' },
  code_hygiene_alert: { domain: 'ops', zh: '代码卫生告警（超行数判定线）', en: 'Code hygiene alert (file over the line limit)' },
  rollover_summary_ready: { domain: 'memory', zh: '交接摘要已就绪', en: 'Handoff summary ready' },
  rollover_summary_failed: { domain: 'memory', zh: '交接摘要未生成', en: 'Handoff summary failed' },
  session_compact_done: { domain: 'memory', zh: '会话总结压缩完成', en: 'Session summary compaction finished' },
  session_compact_failed: { domain: 'memory', zh: '会话总结压缩未生成', en: 'Session summary compaction failed' },
  session_compact_fold: { domain: 'memory', zh: '宿主历史折叠完成', en: 'Host history range folded' },
  session_compact_fold_skipped: { domain: 'memory', zh: '宿主无压缩服务，保持仅总结轮', en: 'Host compaction unavailable; summary turn only' },
  session_compact_fold_failed: { domain: 'memory', zh: '宿主历史折叠未执行', en: 'Host history fold not performed' },
}

// 规范释义（术语表锚点）：按域给 zh/en；未知码回退原码展示（不抛错）。
export function runEventTypeLabel(type, locale = 'zh') {
  const entry = RUN_EVENT_TYPES[type]
  if (!entry) return String(type)
  return locale === 'en' ? entry.en : entry.zh
}
