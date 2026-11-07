# 发版说明

本文件记录各发版版本对外可见的行为变化；最新版本在最上方。每个版本先给中文段，再给英文段。

This file records the externally visible behaviour changes of every release; the newest version comes first. Each version lists the Chinese section before the English one.

## v0.2.367

### 中文

本版是「每 bot 单会话控制面 + 任务子智能体化」架构迁移的收官发布（ADR §5.2 五步全部实施，DSHBOTS-285→296）。这是会话模型的**全面切换**，没有新旧并行的开关或过渡期，升级后行为变化如下。

- **单控制面会话（每 bot 一条）**：每个 bot 只保留一条控制面会话（绑定 `kind='bot'`），任务派发、群聊、私信、单聊、微信直达等全部流量都落到这条会话上统一承接。升级时既有的 task/project/dm/solo 四条旧车道绑定会**自动 alias 化保留**（历史消息与运行归属仍可解析），并为每个 bot 建一条控制面绑定，无需人工迁移。
- **bot 级串行（争用口径 A）**：同一 bot 同时至多一条运行（queued/running）。bot 忙时到达的**消息**不建运行，进入该 bot 的待处理队列，空闲后合批建成一条运行（多条消息合并成一轮）；任务运行与消息**互斥排队**——在跑的卡不被消息合批吞并，消息也不顶掉正在跑的任务。
- **任务子智能体化**：bot 接到派卡后按任务号开专属子智能体施工（子智能体标签 = 任务号，一卡一个，不并卡），子智能体从任务卡继承声明的写范围与沙箱档作为写入边界。子智能体生命周期记入运行事件（`run_events` 的 `subagent_spawned` / `subagent_result`，负载任务号标签与产出摘要），可回答「这张卡由哪个子智能体承载」。并发开多少由 DSH 宿主设定，项目侧不另设上限常量与闸门。
- **结转与压缩**：结转阈值 **256→512 轮**（配置键 `session_rollover_turns` 不变，0=关闭）；新增 **64 轮闲时总结压缩**（`session_compact_turns`，0=关闭）——会话轮次跨过 64 的倍数且该会话空闲时排一次只读总结运行、回原会话执行，忙时推后、跨窗口合批为一次。**压缩 ≠ 结转**：压缩只在原会话内做连续性总结，不换会话、不清空历史；真正的上下文重置仍是 512 轮结转。结转后未终态任务的消息按任务亲和回到原会话。
- **滞留提醒四态三档**：四个卡状态各配一档滞留阈值——待执行（`todo`/`backlog`）72h、待验收（`in_review`）24h、受阻（`blocked`）48h。滞留后每日至多提醒一次，只提醒不自动处置；待执行提醒点名由总监派发或推进（`team_assign_task` 派发/合并/取消）。
- **升级与回退**：全面切换没有运行时开关，回退按**发版级回退**处理（回退包版本与 tag，并恢复发版前的库快照）；因此升级前建议先对库做一次快照备份。

### English

This release closes the "one control-plane session per bot + task subagents" architecture migration (all five steps of ADR §5.2 landed, DSHBOTS-285→296). The session model **switches over completely**: there is no flag that runs the old and new model side by side, and no transition period. After the upgrade, behaviour changes as follows.

- **One control-plane session per bot**: each bot keeps a single control-plane session (bound with `kind='bot'`), and all traffic — task dispatch, group chats, direct messages, one-to-one chats, WeChat — lands on that one session. On upgrade, the four existing lane bindings (task/project/dm/solo) are **kept as aliases** (historical messages and run ownership stay resolvable), and a control-plane binding is created for every bot, so nothing has to be migrated by hand.
- **Per-bot serialization (contention mode A)**: a bot has at most one run at a time (queued/running). **Messages** that arrive while the bot is busy do not create a run; they wait in that bot's pending queue and are merged into a single run once the bot is idle. Task runs and messages **queue against each other exclusively**: a running card is never swallowed by a message batch, and a message never preempts a task that is already running.
- **Task subagents**: once a bot receives a card it opens a dedicated subagent per task number (subagent label = task number, one subagent per card, no card merging), and the subagent inherits the card's declared write scopes and sandbox profile as its write boundary. The subagent lifecycle is recorded in run events (`subagent_spawned` / `subagent_result` in `run_events`, carrying the task-number label and an output summary), so you can answer which subagent carried a given card. How many subagents run concurrently is up to the DSH host; the project side adds no limit constant and no gate.
- **Rollover and compaction**: the rollover threshold moves **256 → 512 turns** (the config key `session_rollover_turns` is unchanged, 0 disables it), and a new **64-turn idle summary compaction** is added (`session_compact_turns`, 0 disables it) — when a session crosses a multiple of 64 turns and is idle, one read-only summary run is scheduled and executed back in the original session; while the session is busy it is deferred, and across windows it is merged into a single run. **Compaction ≠ rollover**: compaction only writes a continuity summary inside the original session, it neither swaps the session nor clears history, while a real context reset is still the 512-turn rollover. After a rollover, messages of tasks that have not reached a terminal state return to the original session through task affinity.
- **Stale-card reminders in three tiers across four states**: each of the four card states gets its own staleness threshold — pending (`todo`/`backlog`) 72h, in review (`in_review`) 24h, blocked (`blocked`) 48h. Once a card goes stale, at most one reminder is sent per day; it only reminds and never disposes of the card automatically, and the pending reminder names the director as the one to dispatch or push it (`team_assign_task` dispatch/merge/cancel).
- **Upgrade and rollback**: the switch-over has no runtime flag, so a rollback is handled as a **release-level rollback** (roll back the package version and tag, and restore the pre-release database snapshot); taking a database snapshot before upgrading is therefore recommended.

## v0.2.364

### 中文

- **任务级死线（D-274）**：任务卡的死线 = 首次派发时刻 + `time_budget_minutes` × 2。存量老卡（首次派发时已超预算 × 2 = 40 分钟）下次被重派时会立即触发一次升级：系统评论 + 卡状态转 `blocked` + owner 通知。此时按升级提示改 `time_budget_minutes` 延期即可，重派即拿到完整的新窗口。这属于设计行为，不是故障。
- **工具分工**：交付类卡走 `npm run finalize`（`--card` 带上项目卡号，提交信息含卡号）；发版类卡走 `npm run release`。两者不要混用——`finalize` 负责单笔交付收口（build → typecheck → test → commit → push），`release` 负责整包发版（push dev → dev 落 main → push main + tag → 回 dev 同步）。
- **CI 与本地同绿**：收口守门夹具的内层测试脚本改用 glob 形式（`node --test "tests/*.test.js"`）。此前用的目录参数在 Node 22 下会被当成 glob 解析并退化成 require 目录，发版流水线因此在测试步失败、包发布不出去；本地 Node 26 不复现，故此前版本未真正发布。

### English

- **Task-level deadline (D-274)**: the deadline of a task card = first dispatch time + `time_budget_minutes` × 2. Existing cards (those whose first dispatch already passed budget × 2 = 40 minutes) trigger one escalation the next time they are re-dispatched: a system comment, the card status moving to `blocked`, and an owner notification. Follow the escalation hint and change `time_budget_minutes`; the re-dispatch then gets the full new window. This is designed behaviour, not a failure.
- **Separation of tools**: delivery cards go through `npm run finalize` (pass the project card number with `--card` and keep it in the commit message); release cards go through `npm run release`. The two must not be mixed — `finalize` closes a single delivery (build → typecheck → test → commit → push), while `release` handles a whole package release (push dev → dev lands on main → push main + tag → sync dev back).
- **CI is green where local is green**: the inner test script of the finalize gate fixture now uses a glob (`node --test "tests/*.test.js"`). The directory argument used before is parsed as a glob under Node 22 and degrades into requiring a directory, so the release pipeline failed at the test step and the package could not be published; local Node 26 does not reproduce it, so the earlier versions were never actually released.
