// src/services/runtime/session-continuity.js —— 会话连续性域
// 结转摘要与闲时压缩两条运行提示词。
// 本文件只放方法体，方法挂到 DshRuntime 原型上（见 src/runtime.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

export const continuityMethods = {
  // 结转摘要运行提示词（DSHBOTS-145）：在旧会话上下文里让 bot 自写交接摘要。
  // 项目会话与单聊会话都支持（project 可为空）——bot 已在本会话里，历史无需重放。
  rolloverSummaryPrompt({ bot, project }) {
    const header = project
      ? [`Project: ${project.name} (${project.key})`, `You are: ${bot.name}`].join('\n')
      : [`You are: ${bot.name}`, 'Mode: one-on-one conversation (outside projects)'].join('\n')
    return `${header}

# Handoff summary request
This conversation has reached its turn limit and will be rolled over to a fresh session. Write a handoff summary for the next session so work continues without losing context.
- Write in Chinese, plain prose, at most 400 characters.
- Cover: work in progress (what was being done and where it stopped), key decisions already made, and open questions or blockers.
- Do not repeat the task description or anything already recorded in long-term memory.
- Do not call any tool and do not write files. Reply with the summary text only.`
  },
  // 闲时总结压缩运行提示词（DSHBOTS-286）：在原会话上下文里让 bot 自写连续性总结。
  // 压缩不等于结转：会话不换，总结只为收敛上下文头绪；宿主未暴露历史截断接口，
  // 持久事实应趁此轮落记忆或任务评论（能力边界见 ADR「结转与压缩」）。
  sessionCompactPrompt({ bot, project }) {
    const header = project
      ? [`Project: ${project.name} (${project.key})`, `You are: ${bot.name}`].join('\n')
      : [`You are: ${bot.name}`, 'Mode: one-on-one conversation (outside projects)'].join('\n')
    return `${header}

# Session compaction request
This conversation has grown long and is now idle. Write a working summary to keep future turns focused.
- Write in Chinese, plain prose, at most 300 characters.
- Cover: current focus, work in progress with its exact state, and the next concrete steps.
- If any durable fact, decision or lesson emerged that is not yet recorded, persist it now with your memory tools (team_remember); everything else stays in this reply only.
- Do not write files. Reply with the summary text only.`
  },
}
