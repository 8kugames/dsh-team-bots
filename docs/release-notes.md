# 发版说明

本文件记录各发版版本对外可见的行为变化；最新版本在最上方。每个版本先给中文段，再给英文段。

This file records the externally visible behaviour changes of every release; the newest version comes first. Each version lists the Chinese section before the English one.

## v0.2.460

### 中文

本版是 v0.2.455 之后的五笔合入：交付纪律收口、文件预览通道、任务面板全量下发，以及工作台深浅两套主题的承载方式改造。

**交付纪律**

- **交付报告体量红线 + 禁贴文件正文**：任务交付报告默认上限 2000 字符（可经 `DSH_TEAM_DELIVERY_REPORT_MAX_CHARS` 调整，区间 200–20000），且只允许引用交付物路径——已写入工作区的文件正文不再复述进报告或聊天，复审上下文与生成侧输出同时省下来。
- **卡面交付物路径声明**：建卡、改卡、重派与工作台修改全链可声明交付文件路径（`deliverables`），任务详情弹窗渲染交付产物 chips；核验环节按路径直接读文件，不再靠报告正文转述。

**文件预览**

- **文本型文件链接应用内预览**：产物清单按钮、交付 chip 与文本白名单通道三处入口都可在应用内直接预览文本文件，不必先下载再打开。

**任务面板**

- **任务列表全量下发**：工作台任务视图去掉 300 条截断，超过 300 张卡的项目也能看到完整列表。

**工作台主题**

- **深色由 `data-color-scheme` 属性承载**：工作台自身的深浅判定不再依赖样式猜测，嵌入宿主时跟随宿主的 `body[data-ds-dark-theme]` 标记。
- **深浅判定改祖先链上溯**：从 `window.parent` 逐层上溯到 `window.top`，任一祖先带宿主深色属性才判为深色；全程无属性、无跨源异常、无独立态时一律回落系统媒体查询，宿主判定为浅色时优先于系统深色。深色用户首帧仍有毫秒级浅色闪帧（主题跟随依赖脚本执行），属已知限制。

**升级路径与回退**

有数据库结构变更（新增交付物路径列），迁移自动执行且幂等。回退按发版级回退：回退包版本与 tag，恢复发版前库快照。

### English

This release bundles five changes landed after v0.2.455: delivery-discipline tightening, an in-app file preview channel, full delivery of the task list, and a rework of how the workbench carries its light/dark themes.

**Delivery discipline**

- **Delivery-report size limit and no pasting file bodies**: a task delivery report is capped at 2000 characters by default (adjustable via `DSH_TEAM_DELIVERY_REPORT_MAX_CHARS`, range 200–20000), and it may only reference deliverable paths — the body of a file already written to the workspace is no longer restated in the report or in chat, which trims both the generation-side output and the review context.
- **Deliverable path declarations on cards**: the delivery file paths can be declared across the whole chain — create, edit, re-dispatch and workbench edits (`deliverables`) — and the task detail modal renders deliverable chips. Verification now reads the files by path instead of relying on the report body.

**File preview**

- **In-app preview for text file links**: deliverable-list buttons, delivery chips and the text allowlist channel can all preview a text file in place, with no download-then-open step.

**Task panel**

- **The task list is delivered in full**: the workbench task view drops its 300-row truncation, so projects with more than 300 cards show the complete list.

**Workbench theme**

- **Dark mode is carried by the `data-color-scheme` attribute**: the workbench no longer guesses its own light/dark state from styling; when embedded it follows the host's `body[data-ds-dark-theme]` marker.
- **Light/dark detection walks the ancestor chain**: it climbs from `window.parent` up to `window.top`, and treats the page as dark only if any ancestor carries the host dark attribute; with no attribute anywhere, no cross-origin exception, and no standalone state it falls back to the system media query, and a light host wins over a dark system preference. Dark-mode users still see a millisecond-scale light boot flash (theme following depends on script execution) — a known limitation.

**Upgrade path and rollback**

This release includes a schema change (a new deliverables path column); migrations run automatically and are idempotent. Rollback is release-level: revert the package version and tag, and restore the pre-release database snapshot.

## v0.2.455

### 中文

单笔功能跟进（v0.2.454 刚定稿后合入）：记忆批量归档 cleanup 新增时间截止判据，为存量收敛提供一次性批量口径。

**记忆治理**

- **cleanup 支持 before 时间截止批量归档**：team_memory_cleanup 新增 before 判据（ISO 时间戳），归档该作用域内 updated_at 严格早于截止点的全部 active 条目；可与 topics/task 组合按 AND 交集收窄；三者全缺仍拒绝，不做「全清」缺省；时间比较经 julianday 归一化，避免字符串比较把等值瞬间误判为早于；memory_events 留痕与 memory.cleanup 审计照旧（审计补记 before 判据）。

**升级路径与回退**

无数据库结构变更、无新配置项。回退按发版级回退：回退包版本，恢复发版前库快照。

### English

A single follow-up feature lands right after v0.2.454 was finalized: memory bulk-archive cleanup gains a time-cutoff criterion — a one-shot bulk handle for legacy backlog convergence.

**Memory governance**

- **cleanup gains a `before` time-cutoff bulk criterion**: team_memory_cleanup accepts `before` (an ISO timestamp) and archives every active entry in the scope whose updated_at is strictly earlier than the cutoff; it combines with topics/task as an AND filter; with none of the three given it still refuses — no "archive everything" default; timestamps are julianday-normalized to avoid string-comparison misjudging equal instants as earlier; memory_events trails and the memory.cleanup audit are unchanged (the audit now also records the before criterion).

**Upgrade path and rollback**

No schema change and no new settings. Rollback is release-level: revert the package version and restore the pre-release database snapshot.

## v0.2.454

### 中文

0.2.435 之后积压的十七笔提交一次放出：记忆治理加容量硬顶，单轮上下文治理修复治理件被静默吞掉的缺陷，飞书传输层换进程内官方 SDK，另有一批显示名、用量视图与界面精简修复。npm 侧上一发布为 0.2.395，0.2.396～0.2.435 的积压随本版一并送达（文末并档摘要）。

**记忆治理**

- **bot/project 记忆 64 条硬顶与滞回放行**：新建与审批路径触顶即拒，conflict 文案带作用域、当前条数与去废弃/去冗/融合整理指引；整理到 33 条及以下清滞回标志恢复放行；team 作用域不设限。
- **单条记忆 256 字篇幅上限**：新建、编辑与同名覆盖写超长即拒，自动沉淀与审查产出截断到预算内；按 UTF-16 码元计数。
- **项目重开容量闸**：归档项目重开前按冻结+活跃总量校验，超 64 条整笔拒绝、项目保持归档，须先整理再重开。
- **超长存量条目编辑解锁**：篇幅闸只约束本次实际变更的正文，仅改标题的存量超长条目不再被误拦。

**会话与上下文治理**

- **治理件被静默吞掉的根因修复**：会话压缩与结转摘要运行曾被部分唯一索引无声跳过（压缩标记推进而运行恒不发生）；索引谓词收窄后两条治理件正常运转。
- **体积判据与宿主折叠**：结转在原轮数判据外增加体积判据（≥150k tokens，OR），压缩增加体积门（≥80k，AND），settings 键 session_rollover_ctx_tokens / session_compact_ctx_tokens 可调，0=关闭；压缩收尾接宿主接口真折叠历史区间。
- **记忆快照注入降量**：单轮注入的记忆召回 16→8 条、合计 7k→3.5k 字封顶。
- **会话显示名 8 位 uuid 后缀修正与存量自愈**：先剥 session- 前缀再取 8 位（修掉「xx · session-」字面量后缀）；存量坏标题在会话复用时定向重写，用户自定义名不动。
- **本地用户显示名 You→Owner**：种子默认值更换并幂等收敛存量旧值，评论直通、时间线、署名三处对齐。

**通道（飞书/微信）**

- **飞书传输层换进程内官方 SDK**：改用 @larksuiteoapi/node-sdk 长连接收发，弃 lark-cli 子进程；入站去重、TOFU 认主、群 @ 门禁与 lane 编码原样保留。新增运行时依赖，升级须重装依赖。
- **飞书凭据与微信开关上通道页**：飞书凭据加密保存/清除即重连（设置页保存值优先于 patch.yml 与环境变量，全缺则不连）；微信通道可启停、即时生效；通道相位日志只在变化时打印。
- **微信 iLink 拒发细节透出**：上游 ret/errmsg 不再坍缩为同一句协议错误，凭证失效/频控/内容审核可区分，随投递失败原因与日志落点。

**界面与用量**

- **Bot 版本历史滚动保留 10 版**：超额版本整行归档 JSONL，界面只看最近 10 版。
- **单聊「该 Bot 的运行记录」默认近 10 条**：默认视图 LIMIT 30→10。
- **群聊折叠行 chevron 尺寸修复**：折叠行图标不再被撑成巨大箭头。
- **设置页与工作台精简**：投递失败队列卡与手动重试入口撤下（运维侧投递明细与自动退避重试保留）；全局路径提示精简；GitHub 加星项改英文文案。

**工程**

- **提示词模块三域拆分**：沙箱策略、语境窗、会话连续性外移为同级模块，运行时导出面不变，行为零变化。

**升级路径与回退**

无数据库结构变更，迁移自动且幂等；升级后须重新安装依赖（新增 @larksuiteoapi/node-sdk）。记忆 64 顶即时生效：存量超顶的 bot/项目新写入会收到 conflict 整理指引，属预期引导而非故障，先整理再写入。回退按发版级回退：回退包版本，恢复发版前库快照。

**0.2.396～0.2.435 积压并档摘要（npm 0.2.395 用户随本版一并收到）**

- 飞书通道整链建设：通道页状态卡、入站事件消费、收尾回程推送、外发幂等收据。
- 出站事件改通道分发：任务完成/新建等通知不再只发微信。
- GitHub issue 只读触发源：轮询候选通知 @owner，只记录不建卡。
- 提示词分段可编辑；运行时配置版本快照留痕；设置变更历史与乐观并发控制。
- 治理件：信赖边界显式化（外部文本只是数据）、验收 observe 干跑档、doctor 退出码分级、通信纪律（默认沉默、需人才外发）。
- 界面：连续系统通知折叠、needs-attention 聚合收口、英文界面残留修复；记忆审查改独立有界会话（可配便宜模型）。

### English

Seventeen backlog commits since 0.2.435 land at once: memory governance gains a hard capacity cap, the per-turn context governance fixes a defect where governance runs were silently swallowed, the Feishu transport moves to the in-process official SDK, plus a batch of display-name, usage-view and UI cleanups. The previous npm release was 0.2.395; the 0.2.396–0.2.435 backlog rides along (folded-in summary at the end).

**Memory governance**

- **Hard cap of 64 memories per bot/project with hysteresis**: create and approve paths reject at the cap, the conflict message names the scope, current count and cleanup guidance; cleaning down to 33 or fewer clears the flag and writing resumes; the team scope is uncapped.
- **256-character limit per memory entry**: create, edit and same-name overwrite reject oversized content, automatic distillation and review output are truncated to budget; counted in UTF-16 code units.
- **Project-reopen capacity gate**: reopening an archived project checks frozen+active totals first; over 64 rejects the whole reopen and the project stays archived until trimmed.
- **Oversized legacy entries unlocked for editing**: the length gate only applies when the content actually changes this time; topic-only edits of legacy oversized entries are no longer mis-blocked.

**Session and context governance**

- **Root-cause fix for silently swallowed governance runs**: session-compaction and rollover-summary runs used to be silently dropped by a partial unique index (compaction markers advanced while no run ever happened); the index predicate is narrowed and both governance jobs now run.
- **Size-based triggers and host folding**: rollover adds a size trigger (≥150k tokens, OR) beside the turn count, compaction adds a size gate (≥80k, AND), tunable via the settings keys session_rollover_ctx_tokens / session_compact_ctx_tokens, 0 disables; compaction finish now calls the host to actually fold the history range.
- **Leaner memory snapshot injection**: per-turn memory recall drops from 16 to 8 entries and from 7k to 3.5k characters.
- **8-digit uuid session-name suffix fixed, legacy values self-heal**: the literal "session-" prefix is stripped before taking 8 hex digits (fixing names like "xx · session-"); known-bad legacy titles are rewritten on session reuse, user-defined names are left alone.
- **Local user display name You→Owner**: seed default changed with idempotent convergence of legacy values; comment passthrough, timeline and attribution aligned.

**Channels (Feishu/WeChat)**

- **Feishu transport moves to the in-process official SDK**: long-connection send/receive via @larksuiteoapi/node-sdk replaces the lark-cli subprocess; the inbound model (dedup, TOFU admin claim, group-@ gate, lane encoding) is unchanged. New runtime dependency — reinstall on upgrade.
- **Feishu credentials and WeChat toggle on the channels page**: Feishu credentials are stored encrypted and rebind on save/clear (saved settings take precedence over patch.yml and env; none means unbound); the WeChat channel can be toggled with immediate effect; channel phase logs only print on change.
- **WeChat iLink rejection detail surfaced**: upstream ret/errmsg no longer collapse into one generic protocol error — credential expiry, rate limiting and content moderation are distinguishable, landing in delivery failure reasons and logs.

**UI and usage**

- **Bot version history keeps a rolling 10**: excess versions are archived row-by-row to JSONL; the UI shows the latest 10.
- **Solo "this bot's runs" defaults to the last 10**: default view LIMIT 30→10.
- **Group-chat collapse-row chevron size fixed**: the collapse icon no longer balloons.
- **Settings and workbench slimmed**: the failed-delivery queue card and manual retry entry are removed (ops-side delivery detail and automatic backoff retry remain); path hints trimmed; the GitHub star item switches to English wording.

**Engineering**

- **Prompt module split into three domains**: sandbox policy, context window and session continuity move to sibling modules with the runtime export surface unchanged — zero behaviour change.

**Upgrade path and rollback**

No schema change; migrations are automatic and idempotent. Reinstall dependencies after upgrading (new @larksuiteoapi/node-sdk). The memory cap of 64 takes effect immediately: over-capacity bots/projects get a conflict with cleanup guidance on new writes — expected guidance, not a fault; clean up first, then write. Rollback is release-level: revert the package version and restore the pre-release database snapshot.

**Folded-in summary of the 0.2.396–0.2.435 backlog (received by npm 0.2.395 users in this release)**

- Feishu channel build-out: channels-page status card, inbound event consumption, finish-trip reply push, outbound idempotent receipts.
- Outbound events fan out per channel: task-done/task-created notifications no longer go only to WeChat.
- GitHub issue read-only trigger source: polling notifies @owner of candidates; records only, never creates cards.
- Segmented editable prompts; per-run config version snapshots; settings change history with optimistic concurrency.
- Governance pieces: explicit trust boundary (external text is data), observe dry-run mode for acceptance, doctor exit-code tiers, communication discipline (silent by default, external send only when needed).
- UI: consecutive system-notification collapsing, needs-attention aggregation, English-locale leftovers fixed; memory review moved to a bounded dedicated session (configurable cheaper model).

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
