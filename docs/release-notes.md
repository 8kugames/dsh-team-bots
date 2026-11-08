# 发版说明

本文件记录各发版版本对外可见的行为变化；最新版本在最上方。每个版本先给中文段，再给英文段。

This file records the externally visible behaviour changes of every release; the newest version comes first. Each version lists the Chinese section before the English one.

## v0.2.395

### 中文

两笔变更：修掉总监侧运行落到成员任务会话的错位；director 验收从提示约束升级为机械约束（0.2.394 未单独发版，内容并入本版）。

**修复**

- **总监侧 review/handle 运行不再吃任务亲和**：落总监自己的控制面绑定（成员 task/dm_reply、in_review 改判、结转 alias 亲和不变）。

**产品化**

- **director 验收机械闸**：team_review_task 前置校验调用方当前活跃运行的子代理账目（run_events 的 subagent_spawned），无账目且未注明「兜底验收」即拒绝；comment 含「兜底验收」放行；微信管理员与看板走 applyReview 不经闸。

**升级路径与回退**

无数据库结构变更、无新配置项，0.2.393 直升 0.2.395。回退按发版级回退：回退包版本与 tag，恢复发版前库快照。

### English

Two changes: the director's runs no longer land in a member's task session, and the director's acceptance rule becomes a mechanical gate (v0.2.394 was never released and is folded in here).

**Fixes**

- **The director's review/handle runs no longer follow task affinity**: they land in the director's own control-plane binding (member task/`dm_reply`, `in_review` re-judgement and carried-over alias affinity are unchanged).

**Productisation**

- **The director's acceptance gate**: `team_review_task` first checks the caller's active run for subagent accounting (`subagent_spawned` in `run_events`); with no accounting and no "兜底验收" note the call is rejected. A comment containing "兜底验收" passes; the WeChat administrator and board paths call `applyReview` directly.

**Upgrade path and rollback**

No schema change, no new setting: upgrade straight from 0.2.393 to 0.2.395. Rollback is release-level — revert the package version and the tag, restore the pre-release database snapshot.

## v0.2.393

### 中文

0.2.378 与 0.2.367 已从 npm 撤回，registry 的 latest 仍停在 0.2.364，npm 使用者一次性拿到 0.2.378 之后的全部变化。

**架构（会话与调度模型）**

- **串行域收窄为 (bot, 工作区)**：同 bot 跨工作区可并行，工作区内互斥；唯一活跃运行索引与待处理队列键同步域化，旧键首次 drain 时并入对应域，消息不丢。
- **任务运行豁免 bot 串行域**：单 bot 可同时推进多张卡，写范围交叠才排队。
- **每卡一张任务专属会话**：卡线程消息、核验回执、返工往返都落本卡会话，不挤总监会话。
- **施工方式自选**：解除强制子智能体化，亲做或派 <bot 名>-<任务号> 专属子代理。
- **bot 会话名后缀改 8 位 uuid**：不再用用户看不懂的「控制面」，存量会话名不追溯。

**稳定性（并发与运行时长）**

- **入队 UNIQUE-safe 双层修复**：撞唯一索引不再抛错，落进该域待处理队列；失败方落挂起前复查既有运行，命中即与成功方合并消账。
- **review/handle 运行预算分档**：超时上限改为 min(全局上限, 分档)，分档默认 10 分钟，review_timeout_minutes 可覆盖（3–60），环境变量优先。
- **纪律三层产品化**：核验指令只落总监模板（源码守门钉住边界）；team_assign_task 拦截「核验/审计/复核」派给成员 bot（owner bot 不限）；派单策略闸按 assignee 的 file_policy 拦截写卡派给只读 bot。

**产品改进**

- **审批/提问倒计时默认 5 分钟且全局可调**：approval_timeout_minutes 与 question_timeout_minutes（1–60），优先级 环境变量 > settings > 默认值。
- **提权审批卡带来源群聊标识**：卡头部带来源群的 [KEY] 标识，单聊显示「单聊」。
- **滞留提醒四态三档**：待执行 72h、待验收 24h、受阻 48h，每日至多提醒一次，只提醒不自动处置。
- **展示路径脱敏为 ~ 前缀**：真实路径解析与读写不受影响。
- **群聊回复 Markdown 分级**：长回复带小标题，短回复保持自然语言，微信走纯文本版式。

**修复**

- **flake 夹具**：无序 LIMIT 1 取行改为确定性查询。
- **发布提交摘要取自 release-notes**：缺说明文件、缺版本小节或中文段无摘要，即在 preflight 拒绝发版。
- **验收期卡线程消息路由**：in_review 改路由给项目 owner bot，修掉验收指令落 assignee 会话被身份闸拒绝；in_progress/blocked/todo 维持 assignee 亲和。

**升级路径与回退**

从 0.2.364 直升 0.2.393（0.2.365～0.2.378 无可安装版本），迁移自动且幂等；代码与数据库必须同版本，否则并发多运行会撞唯一索引。回退按发版级回退：回退包版本与 tag，恢复库快照；升级前先做库快照备份。

### English

v0.2.378 and v0.2.367 were withdrawn from npm, so the registry's `latest` is still 0.2.364 and an npm user gets everything from 0.2.378 onwards in one step.

**Architecture (sessions and scheduling)**

- **Narrower serialisation domain**: a bot's domain shrinks from "per bot" to **(bot, workspace)** — parallel across workspaces, mutually exclusive inside one. The unique-active-run index and the pending-queue key are domainised too, and legacy keys merge into their domain on first drain without losing messages.
- **Task runs are exempt from the bot serialisation domain**: one bot can drive several cards at once; only overlapping write scopes queue.
- **One dedicated session per card**: the card's thread messages, review receipts and rework round-trips stay in that card's own session instead of the director's.
- **Construction method is your choice**: mandatory subagent enforcement is dropped — build it yourself or dispatch a dedicated "<bot name>-<task number>" subagent.
- **Bot session names end in an 8-character uuid**: the user-hostile "控制面" suffix is gone; existing names are not renamed retroactively.

**Stability (concurrency and run budgets)**

- **UNIQUE-safe enqueueing, fixed on two levels**: hitting the unique index no longer throws; the run lands in that domain's pending queue, and the losing side re-checks for an existing run and merges with the winner.
- **Tiered budgets for review/handle runs**: the ceiling becomes `min(global limit, tier)`, the **tier defaulting to 10 minutes**; `review_timeout_minutes` overrides it (3–60) and the environment variable wins.
- **Discipline productised in three layers**: review instructions live only in the director templates (a source-level guard pins the boundary); `team_assign_task` refuses "核验/审计/复核" tasks for member bots (owner bots unaffected); the dispatch policy gate refuses write-scoped cards for read-only bots.

**Product improvements**

- **Approval/question countdown defaults to 5 minutes and is globally configurable**: `approval_timeout_minutes` and `question_timeout_minutes` (1–60), with environment variables beating settings and settings beating the default.
- **Privilege-approval cards name their source chat**: the card header carries the source group's `[KEY]` chip; single chats show "单聊".
- **Stall reminders in four states, three thresholds**: 72h pending, 24h in review, 48h blocked; at most one reminder a day and it **only reminds, never disposes**.
- **Paths displayed with a `~` prefix**: real path resolution and I/O keep the original absolute paths.
- **Graded Markdown replies in group chats**: long replies carry headings, short ones stay natural, WeChat gets a plain-text layout.

**Fixes**

- **Flaky fixtures**: unordered `LIMIT 1` row selection was replaced by deterministic queries.
- **The release commit summary comes from release-notes**: a missing file, a missing version section or an empty Chinese summary makes the release tool refuse to publish.
- **Card-thread routing during review**: `in_review` messages go to the project owner bot, fixing review instructions being rejected by the identity gate in the assignee's session; `in_progress`/`blocked`/`todo` keep assignee affinity.

**Upgrade path and rollback**

Upgrade straight from 0.2.364 to 0.2.393 (no installable 0.2.365–0.2.378 exists); migrations are automatic and idempotent, and code and database must move together or concurrent runs hit the unique index. Roll back at the release level: revert the package version and the tag, restore a database snapshot, and snapshot before upgrading.

## v0.2.378

### 中文

0.2.365～0.2.377 从未发布到 npm，registry 从 0.2.364 直接跳到本版。会话模型**再次切换**，没有新旧并行的开关或过渡期。

**架构（会话与调度模型）**

- **每 (bot, project) 一条控制面会话**：同 bot 在不同项目各自独立上下文，互不串味。
- **单聊归位**：落该 bot 的专属工作区会话（(bot, 无项目) 域），不再混进项目控制面。
- **微信直达一律落 director 专属工作区**：/tr <项目KEY> 投到 director 单聊并带 [项目 KEY] 上下文，不再往项目群聊插触发消息。
- **任务子智能体化**：按任务号开专属子代理施工（一卡一个，不并卡），继承任务卡的写范围与沙箱档；生命周期记入 run_events 的 subagent_spawned/subagent_result，可回答「这张卡由哪个子代理承载」，并发上限由 DSH 宿主设定。
- **争用口径 A（bot 级串行 + 待处理队列）**：同 bot 至多一条活跃运行；bot 忙时到达的消息不建运行，进待处理队列，空闲后合批；任务与消息互斥排队。
- **结转 512 轮 / 闲时压缩 64 轮**：结转阈值 256→512（session_rollover_turns，0=关闭）；新增 64 轮闲时总结压缩（session_compact_turns，0=关闭），空闲时排一次只读总结运行回原会话执行，忙时推后、跨窗口合批。压缩只在原会话内做连续性总结，不换会话、不清历史，真正的上下文重置仍是 512 轮结转。

**稳定性（并发与运行时长）**

- **入队全路径 UNIQUE-safe**：同拍双投不再抛错，失败方落挂起前复查既有运行、命中即合并消账；存量卡住的挂起项下一拍自愈。
- **review/handle 运行预算分档**：超时上限改为 min(全局上限, 分档)，分档默认 10 分钟，启动瞬间定格。

**纪律产品化（核验归口）**

- **提示词边界**：核验指令只落总监侧 review/handle 模板，成员模板只留自校段，源码级守门钉住。
- **派单闸**：team_assign_task 建卡与重派两路都拦截「核验/审计/复核」派给成员 bot（owner bot 不限）；「验收/验证」不纳入拦截词，避免误伤实施类工作。

**产品改进**

- **展示层路径脱敏**：home 目录前缀显示为 ~/ 形式，真实读写不受影响。
- **群聊回复 Markdown 结构化分级**：长回复带小标题，短回复自然语言，微信走纯文本版式。
- **滞留提醒四态三档**：待执行 72h、待验收 24h、受阻 48h，每日至多提醒一次，只提醒不自动处置。

**界面**

- 英文界面残留的中文文案已清干净，并补三道 i18n 守门防止回潮；用量页四个时间档位键补齐中英两套。
- 工作台左下角状态计数器整块移除，只留全局配置、密钥与切回官方入口。

**修复**

- 测试夹具播种的无序 LIMIT 1 取行改为确定性查询，这类 flaky 不再随机出现。

**升级路径与回退**

从 0.2.364 直升 0.2.378，中间版本号从未发布，迁移自动且幂等；代码与数据库必须同步升降，否则并发多运行会撞唯一索引。回退按发版级回退：回退包版本与 tag，恢复库快照；升级前先做库快照备份。

### English

0.2.365–0.2.377 never reached npm, so the registry jumps straight from 0.2.364 to this version. The session model **switches again**: no flag runs the old and new model side by side.

**Architecture (sessions and scheduling)**

- **One control-plane session per (bot, project)**: the same bot keeps a separate context in each project and nothing bleeds across projects.
- **One-to-one chats go back to the bot's own workspace**: a direct chat lands in that bot's solo session (the `(bot, no project)` domain) instead of a project control-plane session.
- **WeChat direct messages always land in the director's own workspace**: an explicit `/tr <projectKEY>` forward goes to the director's solo chat with `[project KEY]` context, instead of posting a trigger into the project group.
- **Task subagents**: a bot opens a dedicated subagent per task number (one per card, no merging) that inherits the card's write scopes and sandbox profile; the lifecycle is recorded in `run_events` (`subagent_spawned` / `subagent_result`), so you can tell which subagent carried a card. The concurrency limit is up to the DSH host.
- **Contention mode A (per-bot serialization + pending queue)**: a bot has at most one active run; messages arriving while it is busy wait in the pending queue and are merged into one run when it goes idle; tasks and messages queue against each other exclusively.
- **512-turn rollover / 64-turn idle compaction**: the rollover threshold moves 256 → **512** (`session_rollover_turns`, 0 disables it) and a new **64-turn idle summary compaction** (`session_compact_turns`, 0 disables it) runs a read-only summary back in the original session when it is idle, deferred while busy and merged across windows. Compaction only writes a continuity summary inside the original session — it neither swaps the session nor clears history — and the real context reset is still the 512-turn rollover.

**Stability (concurrency and run time)**

- **UNIQUE-safe enqueue on every path**: same-tick double dispatch no longer throws; the losing side re-checks for an existing run and merges with the winner, and already-wedged pending items self-heal on the next tick.
- **Budget tier for review/handle runs**: the ceiling becomes `min(global limit, tier)` with the **tier defaulting to 10 minutes**, frozen at startup.

**Discipline as product behaviour (verification ownership)**

- **Prompt boundary**: verification instructions exist only in the director-side review/handle templates; member bots keep only the self-check section. A source-level guard pins the boundary.
- **Dispatch gate**: both the create and the re-dispatch path of `team_assign_task` reject "核验 / 审计 / 复核" tasks for **member bots** (owner bots unaffected); "验收 / 验证" are deliberately not blocked so implementation work is not caught by mistake.

**Product improvements**

- **Path redaction in displayed output**: home-directory paths show as `~/…`; real path resolution and file access are unaffected.
- **Structured, tiered Markdown for group-chat replies**: long replies get headings, short ones stay natural, WeChat gets a plain-text layout.
- **Stale-card reminders in three tiers across four states**: 72h pending, 24h in review, 48h blocked; at most one reminder a day and it only reminds.

**Interface**

- Chinese leftovers in the English interface are gone and three i18n guards prevent regressions; the usage page's four time-window keys got their missing Chinese and English entries.
- The status counters in the workbench's lower-left corner are removed entirely; only global settings, secrets and the "back to official" entry remain.

**Fixes**

- Intermittent test-fixture failures (unordered `LIMIT 1` row selection) were replaced by deterministic queries.

**Upgrade path and rollback**

Upgrade straight from 0.2.364 to 0.2.378 (the intermediate versions were never published); migrations are automatic and idempotent, and code and database must move together or concurrent runs hit the unique index. Roll back at the release level: revert the package version and the tag, restore a database snapshot, and snapshot before upgrading.

## v0.2.367

### 中文

「每 bot 单会话控制面 + 任务子智能体化」架构迁移的收官发布（ADR §5.2 五步全部实施，DSHBOTS-285→296）。会话模型**全面切换**，没有新旧并行的开关或过渡期。

- **单控制面会话（每 bot 一条）**：每个 bot 只保留一条控制面会话（kind='bot'），任务派发、群聊、私信、单聊、微信直达全部流量统一承接；既有 task/project/dm/solo 四条旧车道绑定自动 alias 化保留（历史消息与运行归属仍可解析），无需人工迁移。
- **bot 级串行（争用口径 A）**：同 bot 至多一条运行（queued/running）；bot 忙时到达的消息不建运行，进待处理队列，空闲后合批；任务运行与消息互斥排队。
- **任务子智能体化**：按任务号开专属子代理施工（继承写范围与沙箱档），生命周期记入 run_events 的 subagent_spawned/subagent_result，可回答「这张卡由哪个子代理承载」；并发上限由 DSH 宿主设定。
- **结转与压缩**：结转阈值 256→512 轮（session_rollover_turns，0=关闭）；新增 64 轮闲时总结压缩（session_compact_turns，0=关闭），空闲时排只读总结运行回原会话执行，忙时推后、跨窗口合批。压缩不换会话、不清历史，真正的上下文重置仍是 512 轮结转；结转后未终态任务的消息按任务亲和回到原会话。
- **滞留提醒四态三档**：待执行 72h、待验收 24h、受阻 48h，每日至多提醒一次，只提醒不自动处置。
- **升级与回退**：全面切换没有运行时开关，回退按发版级回退（回退包版本与 tag，恢复库快照），升级前先做库快照备份。

### English

Closes the "one control-plane session per bot + task subagents" migration (all five steps of ADR §5.2 landed, DSHBOTS-285→296). The session model **switches over completely**: no flag runs the old and new model side by side.

- **One control-plane session per bot**: each bot keeps a single control-plane session (`kind='bot'`) that all traffic lands on. The four existing lane bindings (task/project/dm/solo) are **kept as aliases**, so history stays resolvable and nothing needs migrating by hand.
- **Per-bot serialization (contention mode A)**: at most one run per bot; busy-time messages wait in the pending queue and are merged into one run when idle; task runs and messages queue against each other exclusively.
- **Task subagents**: a dedicated subagent per task number inherits the card's write scopes and sandbox profile, and its lifecycle is recorded in `run_events` (`subagent_spawned` / `subagent_result`), so you can tell which subagent carried a card. The concurrency limit is up to the DSH host.
- **Rollover and compaction**: the rollover threshold moves **256 → 512** turns and a new **64-turn idle summary compaction** runs a read-only summary back in the original session when it is idle, deferred while busy and merged across windows. Compaction neither swaps the session nor clears history — the real context reset is still the 512-turn rollover — and after a rollover, messages of unfinished tasks return to the original session through task affinity.
- **Stale-card reminders in three tiers across four states**: 72h pending, 24h in review, 48h blocked; at most one reminder a day and it only reminds.
- **Upgrade and rollback**: the switch-over has no runtime flag, so a rollback reverts the package version and the tag and restores a pre-release database snapshot; snapshot before upgrading.

## v0.2.364

### 中文

- **任务级死线（D-274）**：任务卡死线 = 首次派发时刻 + `time_budget_minutes` × 2。存量老卡下次被重派时立即触发一次升级（系统评论 + 卡转 `blocked` + owner 通知），按提示改 `time_budget_minutes` 延期即可。这是设计行为，不是故障。
- **工具分工**：交付类卡走 `npm run finalize`（`--card` 带卡号），发版类卡走 `npm run release`，两者不要混用——finalize 负责单笔交付收口，release 负责整包发版。
- **CI 与本地同绿**：收口守门夹具的内层测试脚本改用 glob 形式（`node --test "tests/*.test.js"`）。此前目录参数在 Node 22 下被当成 glob 解析并退化成 require 目录，发版流水线因此在测试步失败、包发布不出去；本地 Node 26 不复现。

### English

- **Task-level deadline (D-274)**: a card's deadline = first dispatch time + `time_budget_minutes` × 2. Existing cards trigger one escalation on their next re-dispatch (a system comment, the card moving to `blocked`, an owner notification); extend `time_budget_minutes` as the hint says. This is designed behaviour, not a failure.
- **Separation of tools**: delivery cards go through `npm run finalize` (with `--card` and the card number in the commit message), release cards through `npm run release`; the two must not be mixed — finalize closes a single delivery, release handles a whole package release.
- **CI is green where local is green**: the finalize gate fixture's inner test script now uses a glob (`node --test "tests/*.test.js"`). The directory argument used before degrades into requiring a directory under Node 22, so the release pipeline failed at the test step and the package could not be published; local Node 26 does not reproduce it.
