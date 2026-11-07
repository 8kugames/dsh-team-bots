# 发版说明

本文件记录各发版版本对外可见的行为变化；最新版本在最上方。每个版本先给中文段，再给英文段。

This file records the externally visible behaviour changes of every release; the newest version comes first. Each version lists the Chinese section before the English one.

## v0.2.378

### 中文

本版是 0.2.365～0.2.377 这段**从未发布到 npm** 的开发成果的合并发布（0.2.367 曾短暂发布后被撤回，registry 上从 0.2.364 直接跳到本版）。因此从生产实际使用者的视角看，本版一次性带来下列全部变化——会话模型是**再次切换**，没有新旧并行的开关或过渡期。

**架构（会话与调度模型）**

- **每 (bot, project) 一条控制面会话**：bot 的流量按「bot × 项目」维度落到各自的控制面会话上，同一 bot 在不同项目里各自有独立上下文，互不串味。
- **单聊归位**：单聊回到该 bot 的专属工作区会话（`(bot, 无项目)` 域），不再混进项目控制面；工作台里的提问与审批卡片仍由这一域承接。
- **微信直达一律落 director 专属工作区**：`/tr <项目KEY>` 显式转发时改为投到 director 的单聊（正文带 `[项目 KEY]` 上下文），不再往项目群聊里插一条触发项目内 chat 运行的消息。
- **任务子智能体化**：bot 接到派卡后按任务号开专属子智能体施工（标签 = 任务号，一卡一个，不并卡），子智能体从任务卡继承写范围与沙箱档作为写入边界；子智能体的生命周期记入运行事件（`run_events` 的 `subagent_spawned` / `subagent_result`，带任务号标签与产出摘要），可以回答「这张卡由哪个子智能体承载」。并发上限由 DSH 宿主设定。
- **争用口径 A（bot 级串行 + 待处理队列）**：同一 bot 同时至多一条活跃运行。bot 忙时到达的**消息**不建运行，进入该 bot 的待处理队列，空闲后合批建成一条运行；**任务**与消息互斥排队——在跑的卡不被消息合批吞并，消息也不顶掉正在跑的任务。
- **结转 512 轮 / 闲时压缩 64 轮**：结转阈值 256→**512** 轮（配置键 `session_rollover_turns`，0 = 关闭）；新增 **64 轮闲时总结压缩**（`session_compact_turns`，0 = 关闭）——会话轮次跨过 64 的倍数且该会话空闲时排一次只读总结运行、回原会话执行，忙时推后、跨窗口合批。**压缩 ≠ 结转**：压缩只在原会话内做连续性总结，不换会话、不清空历史；真正的上下文重置仍是 512 轮结转。

**稳定性（并发与运行时长）**

- **入队全路径 UNIQUE-safe**：busy 闸是「先查后插」，多进程（web profile 服务与工作区会话实例共享同一个库）同拍过检后各自插入时，后到者会撞「同 bot 唯一活跃运行」索引直抛错误，被外层记为投递失败并最终卡住消息。本版起这类撞车**不再抛错**，而是按争用口径 A 落进待处理队列，空闲后合并建回；同拍双投的第二层也做了收口——失败方在落挂起前复查既有运行，命中即与成功方合并消账，存量已卡住的挂起项在下一拍自愈，不再长期占住队列头阻塞该 bot 的其它消息。
- **review / handle 运行预算分档**：验收与处置类运行（`review`、`handle`）的超时上限改为 `min(全局上限, review 分档)`，**分档默认 10 分钟**（settings 的 `review_timeout_minutes` 可覆盖，取值区间 3–60；环境变量 `DSH_TEAM_REVIEW_TIMEOUT_MINUTES` 优先）；群聊/私信/单聊沿用全局上限，任务时效的取小逻辑不变。启动瞬间定格，不追溯。

**纪律产品化（核验归口）**

- **提示词边界**：验收核验指令只落在 director 侧的 review/handle 模板里；成员 bot 的模板只保留「自校段」（自己跑测试、证据进交付报告）。这条边界有源码级守门钉住，后续任何人改模板一旦漂移即测试转红。
- **派单闸**：`team_assign_task` 建卡与重派/改卡两路，都会机械拦截标题或描述里含「核验 / 审计 / 复核」的任务派给**成员 bot**（直接拒绝并回执提示改措辞）；派给项目总监（owner bot）不受限制。为避免误伤实施类工作，「验收 / 验证」不纳入拦截词。

**产品改进**

- **展示层路径脱敏**：提示词与文本输出里，home 目录前缀的绝对路径统一转成 `~/` 形式（隐私友好、也更短）；一切真实的路径解析与读写仍使用原始绝对路径，不受影响。
- **群聊回复 Markdown 结构化分级**：长回复固定带小标题，短回复保持自然语言，微信通道走纯文本版式。
- **滞留提醒四态三档**：四个卡状态各配一档滞留阈值——待执行（`todo`/`backlog`）72h、待验收（`in_review`）24h、受阻（`blocked`）48h。滞留后每日至多提醒一次，**只提醒不自动处置**；待执行提醒点名由总监派发或推进（`team_assign_task` 派发/合并/取消）。

**界面**

- 英文界面里残留的中文文案已清干净（轨迹标题按运行类型翻译、图片占位走词典、清理孤儿词条），并补了三道 i18n 守门防止回潮；用量页汇总窗口的四个时间档位键也补齐了中英两套。
- 工作台左下角的状态计数器（圆点与「团队空闲 / 任务数 / Bots 数 / 待审数」）整块移除，底部只保留全局配置、密钥与切回官方等入口。

**修复**

- 测试夹具播种时的间歇性失败（多行表上用无序 `LIMIT 1` 取行，SQLite 不保证行序）已全部改为确定性查询，这类 flaky 不再随机出现。

**升级路径与回退**

- **从 0.2.364 直接升到 0.2.378**：中间版本号从未发布，升级只需一步。数据库迁移自动且幂等（重复启动不会重复改结构），历史上已前移的库会被迁移账本识别并跳过。
- **务必代码与数据库同步升降**：运行时代码与库结构必须同版本——旧代码配新库（例如 0.2.364 的运行时配 0.2.373 迁移后的库）缺少 busy 闸，并发多运行会直接撞唯一索引。这是本次「消息卡在队列里出不来」一类现象的根因之一，升级到本版后该错配窗口关闭。
- **回退按发版级回退**：本版没有运行时开关，回退需回退包版本与 tag，并恢复发版前的库快照；升级前建议先对库做一次快照备份。

### English

This release ships everything developed for 0.2.365–0.2.377, a range that **never reached npm** (0.2.367 was published briefly and then withdrawn, so the registry jumps straight from 0.2.364 to this version). From the point of view of an actual user on production, this release brings all of the following at once. The session model **switches again**: there is no flag that runs the old and the new model side by side, and there is no transition period.

**Architecture (sessions and scheduling)**

- **One control-plane session per (bot, project)**: a bot's traffic is routed per "bot × project" pair, so the same bot keeps a separate context in each project and nothing bleeds across projects.
- **One-to-one chats go back to the bot's own workspace**: a direct chat lands in that bot's dedicated solo session (the `(bot, no project)` domain) instead of mixing into a project control-plane session; the workbench's question and approval cards are still served from this domain.
- **WeChat direct messages always land in the director's own workspace**: an explicit `/tr <projectKEY>` forward is now delivered to the director's solo chat (with `[project KEY]` context in the body) instead of posting a message into the project group that triggers a project-internal chat run.
- **Task subagents**: once a bot receives a card it opens a dedicated subagent per task number (subagent label = task number, one subagent per card, no card merging), and the subagent inherits the card's declared write scopes and sandbox profile as its write boundary. The subagent lifecycle is recorded in run events (`subagent_spawned` / `subagent_result` in `run_events`, carrying the task-number label and an output summary), so you can answer which subagent carried a given card. The concurrency limit is up to the DSH host.
- **Contention mode A (per-bot serialization + pending queue)**: a bot has at most one active run at a time. **Messages** that arrive while the bot is busy do not create a run; they wait in that bot's pending queue and are merged into a single run once the bot is idle. **Tasks** and messages queue against each other exclusively: a running card is never swallowed by a message batch, and a message never preempts a task that is already running.
- **512-turn rollover / 64-turn idle compaction**: the rollover threshold moves 256 → **512** turns (config key `session_rollover_turns`, 0 disables it), and a new **64-turn idle summary compaction** is added (`session_compact_turns`, 0 disables it) — when a session crosses a multiple of 64 turns and is idle, one read-only summary run is scheduled and executed back in the original session; while the session is busy it is deferred, and across windows it is merged into a single run. **Compaction ≠ rollover**: compaction only writes a continuity summary inside the original session, it neither swaps the session nor clears history, while a real context reset is still the 512-turn rollover.

**Stability (concurrency and run time)**

- **UNIQUE-safe enqueue on every path**: the busy gate is a check-then-insert, so when several processes (the web profile service and workspace session instances share one database) pass the check in the same tick and each inserts, the later one hits the "one active run per bot" unique index and throws; that was recorded as a delivery failure and could wedge messages. From this version on such collisions **no longer throw**: they fall into the pending queue under contention mode A and are merged back once the bot is idle. The second layer of the same-tick double dispatch is closed too — the losing side re-checks for an existing run before recording a pending item, and merges with the winner instead of duplicating it; pending items that were already wedged self-heal on the next tick and no longer sit at the head of the queue blocking that bot's other messages.
- **Budget tier for review / handle runs**: the timeout ceiling for acceptance and disposition runs (`review`, `handle`) is now `min(global limit, review tier)`, with the **tier defaulting to 10 minutes** (the `review_timeout_minutes` setting can override it, range 3–60; the `DSH_TEAM_REVIEW_TIMEOUT_MINUTES` environment variable takes precedence). Group chats, direct messages and one-to-one chats keep the global limit, and the task time-budget rule is unchanged. The tier is frozen at startup and is not retroactive.

**Discipline as product behaviour (verification ownership)**

- **Prompt boundary**: verification instructions only exist in the director-side review/handle templates. Member bots keep only the self-check section (run your own tests, put the evidence in the delivery report). This boundary is pinned by a source-level guard, so any future template change that drifts fails the test.
- **Dispatch gate**: both the create and the re-dispatch/edit paths of `team_assign_task` mechanically reject a task whose title or description contains "核验 / 审计 / 复核" (verification / audit / review) when it is dispatched to a **member bot** — the request is rejected with a reply suggesting different wording. Dispatching to the project director (owner bot) is not restricted. "验收 / 验证" (acceptance / validation) are deliberately excluded from the blocked words so implementation work is not caught by mistake.

**Product improvements**

- **Path redaction in displayed output**: in prompts and text output, absolute paths under the home directory are shown in `~/` form (privacy-friendly and shorter). Real path resolution and file access still use the original absolute paths and are unaffected.
- **Structured, tiered Markdown for group-chat replies**: long replies get fixed headings, short replies stay natural language, and the WeChat channel gets a plain-text layout.
- **Stale-card reminders in three tiers across four states**: each of the four card states gets its own staleness threshold — pending (`todo`/`backlog`) 72h, in review (`in_review`) 24h, blocked (`blocked`) 48h. Once a card goes stale, at most one reminder is sent per day, and it **only reminds, it never disposes of the card automatically**; the pending reminder names the director as the one to dispatch or push it (`team_assign_task` dispatch/merge/cancel).

**Interface**

- Chinese leftovers in the English interface are gone (trajectory titles are translated per run kind, image placeholders come from the dictionary, orphan entries removed), and three i18n guards now prevent regressions. The four time-window keys of the usage page summary got their missing Chinese and English entries.
- The status counters in the workbench's lower-left corner (the dot and the "team idle / tasks / bots / pending reviews" line) are removed entirely; only the global settings, secrets and "back to official" entries remain there.

**Fixes**

- Intermittent test-fixture failures (picking a row with an unordered `LIMIT 1` on a multi-row table, where SQLite does not guarantee row order) are all replaced by deterministic queries, so these flakes no longer appear at random.

**Upgrade path and rollback**

- **Upgrade straight from 0.2.364 to 0.2.378**: the intermediate versions were never published, so the upgrade is a single step. Database migrations are automatic and idempotent (restarting does not re-apply them), and a library that was already migrated ahead of time is recognised by the migration ledger and skipped.
- **Always upgrade code and database together**: the runtime code and the database schema must be the same version — old code against a newer schema (for example the 0.2.364 runtime against a library already migrated by 0.2.373) has no busy gate, so concurrent runs hit the unique index directly. This was one of the root causes of messages getting stuck in the queue; upgrading to this version closes that mismatch window.
- **Rollback is a release-level rollback**: this version has no runtime flag, so a rollback means rolling back the package version and the tag and restoring the pre-release database snapshot; taking a database snapshot before upgrading is therefore recommended.

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
