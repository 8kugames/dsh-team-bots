// src/services/task-stage.js —— 任务工单七态纯推导（唯一口径来源）。
//
// 哲学与 runHoldsWriteLock（scheduler.js）同构：stage 不落库、不新增存储状态位，
// 由事实（任务状态、结构化提问、最近运行）派生「在等谁」，存储真值仍归 tasks.status，
// 防双真值打架。判定表以 docs/superagent-port-plan.md §1.5 为准，自上而下第一匹配行获胜：
//   ended → person/answer → person/review → person/failed → person/blocked
//   → working → working/queued → queued → idle。
// 预留位（只占枚举与标签表，判定表恒不返回）：
//   waiting —— 机制②（后台等待）落地后的后台态；当前无派生来源。
//   person/delivery —— 原型「投递失败重试中」；我们的映射表没有对应触发事实。
// 返回两层结构 {stage, action?}，中文文案由 TASK_STAGE_LABEL 查表；调用方不得从
// latestRun.status 自行拼接文案，UI 只消费 taskView 下发的 stageLabel。
// 终态（done/canceled）一律 ended、不渲染任何徽标——即使任务上还挂着遗留运行
// （回归锁：「已完成」列出现过「已取消/运行中」标签的历史 bug）。

export function taskStage(task, latestRun, attention) {
  if (task?.status === 'done' || task?.status === 'canceled') return { stage: 'ended' }
  // 有待回答的结构化提问：无论任务处于哪个状态，先在等人回答。
  if (attention) return { stage: 'person', action: 'answer' }
  // in_review 且无待答提问：在等人验收。核验运行在跑也不算机器执行——它本身是验收环节的一部分。
  if (task?.status === 'in_review') return { stage: 'person', action: 'review' }
  // 最近运行失败：在等人处理故障（失败常态是任务转 blocked；owner 手动回流 in_progress 同口径）。
  if (latestRun?.status === 'failed') return { stage: 'person', action: 'failed' }
  // 人工阻塞且无失败运行：在等人处置（非故障性卡住：依赖闸门、资源等待、外部原因）。
  if (task?.status === 'blocked') return { stage: 'person', action: 'blocked' }
  if (latestRun?.status === 'running' && latestRun?.kind === 'task') return { stage: 'working' }
  if (latestRun?.status === 'queued') return { stage: 'working', action: 'queued' }
  // todo 且无活跃运行：已派单待执行（含被依赖闸门拦住的——同样在等执行机会，不区分）。
  if (task?.status === 'todo') return { stage: 'queued' }
  return { stage: 'idle' }
}

// 标签查表：key 为 stage 或 `stage/action`；ended 映射 null（不显示）。
// 标签说「在等谁、等什么」，不露内部状态码；waiting / person/delivery 为预留位文案。
export const TASK_STAGE_LABEL = {
  'person/answer': '等待你回答',
  'person/review': '等待验收',
  'person/failed': '需要你处理',
  'person/blocked': '等人处理',
  'person/delivery': '等外部交付',
  working: '正在执行',
  'working/queued': '排队中',
  queued: '待执行',
  waiting: '后台等待',
  idle: '空闲',
  ended: null,
}

// stage 结构 → 标签文案：UI 只消费查表结果（taskView 已挂 stageLabel），不自行拼字符串。
export function taskStageLabel(stage) {
  if (!stage) return null
  const key = stage.action ? `${stage.stage}/${stage.action}` : stage.stage
  return TASK_STAGE_LABEL[key] ?? null
}
