# 发版说明

本文件记录各发版版本对外可见的行为变化；最新版本在最上方。每个版本先给中文段，再给英文段。

This file records the externally visible behaviour changes of every release; the newest version comes first. Each version lists the Chinese section before the English one.

## v0.3.129

### 中文

**任务**

- **任务卡带版本化 Goal 锚点**：Goal 由建卡人或总监显式填写，每次修订升版本，run 只注入当前版本；带 Goal 的卡，总监验收 comment 必须引用 Goal vN 与完成标准编号，否则拒绝并列出缺什么。施工、验收、受阻处置 run 只以任务卡为启动上下文，例外仅限卡片显式引用的消息与点名评论，每次组装落 context_manifest 事件备查；工作台补了 Goal 的填写与编辑入口。
- **成员看板 busy 同口径**：成员看板的忙碌计数计入在跑子代理，与总览 bots 页一致。

**会话**

- **会话查看器**：新增只读查看域，从宿主事件日志抽取目录与增量游标消息流；工作台提供目录弹窗与只读消息流，运行中会话增量轮询、可翻旧，聊天流里带会话 chip。
- **子代理会话进查看器**：子代理账本落表，授权沿父绑定链继承，目录按父孙并集展示。
- **跳转原生会话**：任务运行行、成员卡与目录新增跳原生会话入口，经 client 半边桥接打开；会话目录未就绪时走重试泵反复尝试而非静默失败，跳转 chip 动作接入点击分发器。

**提示词**

- **身份提示词利于缓存**：随任务变化的角色行挪到身份提示词末尾，静态前缀可跨任务会话命中宿主缓存。
- **任务卡例外段共用 8k 总预算**：点名评论先取，引用消息用剩余预算，放不下的只列 ID 并记入 manifest 的 budget_skipped。

**工具**

- **集成工具面按项目按需可见（opt-in）**：宿主给每个 Agent 注册的 MCP 服务器与引擎桥工具，`team-bots` 预设筛不掉，团队 bot 用不上的定义每次调用都在重复计费。配 `DSH_TEAM_HIDE_TOOL_PREFIXES`（隐藏前缀清单）+ `DSH_TEAM_TOOL_FAMILY_MARKERS`（前缀=工作区标记路径，项目工作区里有标记的那一族保留、其余隐藏）即启用；两者缺省为空，什么都不隐藏，单聊不受影响。

### English

**Tasks**

- **Versioned Goal anchors on task cards**: the goal is written explicitly by the card creator or director, bumps a version on every revision, and runs only ever receive the current version. On cards carrying a Goal, the director's acceptance comment must cite the Goal version and completion-criterion IDs, or the acceptance is rejected with the missing items listed. Build, review and blocked-handling runs start from the task card alone; exceptions are limited to messages the card explicitly references and named comments, and every assembly is recorded as a context_manifest event. The workbench gained goal entry and editing controls.
- **Member board busy parity**: the member board's busy count now includes running subagents, matching the Bots overview page.

**Sessions**

- **Session viewer**: a new read-only session domain extracts a directory and incremental-cursor message stream from the host event log. The workbench offers a directory dialog and a read-only message stream with incremental polling for running sessions, history paging, and session chips in the chat stream.
- **Subagent sessions in the viewer**: the subagent ledger renders as a table, authorization follows the parent binding chain, and the directory shows the union of parent and grandchild agents.
- **Jump to native session**: task run rows, member cards and the directory gain entries that open the native session through a client-side bridge; when the session directory is not ready yet, a retry pump keeps trying instead of failing silently, and the chip action is wired into the click dispatcher.

**Prompts**

- **Cache-friendly identity prompt**: the task-dependent role lines moved to the end of the identity prompt, so the static prefix hits the host prompt cache across task sessions.
- **Shared 8k budget for card exceptions**: named comments are taken first, referenced messages use the remaining budget, and anything that does not fit is reduced to IDs recorded in the manifest's budget_skipped.

**Tools**

- **Host-integrated tools on demand (opt-in)**: host-registered MCP/bridge tool definitions that team bots never use are billed on every call. Set `DSH_TEAM_HIDE_TOOL_PREFIXES` (hidden prefixes) + `DSH_TEAM_TOOL_FAMILY_MARKERS` (`prefix=marker-path`; a project whose workspace has the marker keeps that family, the rest stay hidden) to enable. Defaults are empty — nothing is hidden; direct chats are unaffected.

## v0.3.114

### 中文

**审批**

- **完全权限总开关**：总览 bots 页「免审权限」卡顶新增「完全权限」toggle——打开后所有 Bot 与派发任务的生效沙箱统一 danger-full-access，不再收紧只读（含非写运行的 run_type 降档与任务派发覆盖）；派单策略闸不再拦配置只读的 bot。各 Bot 文件策略与派发覆盖原样保留，关闭即恢复原判定；仅工作台 owner 可切换，bot 自批被拒，开关切换落审计。

**项目**

- **项目 Key 支持下划线和短横线**：Key 仍以字母开头、最多 10 位，`_` 与 `-` 只能夹在字母数字之间（不相邻、不收尾）；任务号 `<key>-<序号>` 的各消费方（微信 /detail /reject /tr、子代理账本标签、finalize 卡号）同步放行，新建项目弹窗的校验提示一并更新。

**界面与通道**

- **首页归属宿主路由**：宿主 0.2.3 起精确路由 `/` 归宿主所有，插件不再注册同名路由（否则整个插件加载失败）。已登录访问首页由插件 302 进团队工作台；未登录认证页、`?token=` 兑换与扫码登录仍由宿主处理。

### English

**Approvals**

- **Full-access master toggle**: a "Full access" switch at the top of the approval-permissions card on the Bots overview page. When on, every bot and dispatched task runs at danger-full-access — read-only tightening no longer applies (including the run-type downgrade of non-write runs and dispatch sandbox overrides), and the dispatch gate no longer rejects read-only bots for write cards. Per-bot file policies and overrides are kept untouched and apply again once the toggle is off. Only the workbench owner can toggle it; bots cannot self-approve, and every switch is audited.

**Projects**

- **Project keys accept underscores and hyphens**: a key still starts with a letter and is at most 10 characters, while `_` and `-` may now appear between alphanumerics (never adjacent or trailing). Consumers of task identifiers `<key>-<number>` — WeChat /detail, /reject and /tr, subagent ledger labels and finalize card numbers — accept the wider form, and the create-project dialog's validation message was updated to match.

**UI & channels**

- **Home page follows host routing**: since host 0.2.3 the exact route `/` belongs to the host, so the plugin no longer registers it (registering it failed the whole plugin load). Authenticated visits to `/` are redirected by the plugin into the team workbench; the unauthenticated page, `?token=` exchange and QR login stay with the host.

## v0.3.109

### 中文

**记忆**

- **记忆审查准入泛化**：下线按规则沉淀的准入口径，改同主题覆写融合；日志式主题降级为待审，减少低价值记忆占用配额。

**提示词**

- **表述去电报体/翻译腔**：去除诱导生硬句式的表述；字数帽明确只约束内容量、不限句子结构。

**工程**

- **脏产物检测**：构建覆盖前发现手改的 .js 产物即报错；RULES.md 固化 TypeScript 单一真源规则。

### English

**Memory**

- **Generalized memory review admission**: the rule-based promotion gate is retired in favour of same-topic overwrite merging; log-style topics are demoted to pending review, keeping low-value memories out of the quota.

**Prompts**

- **Copy de-telegraphed**: wording that induced telegram-style or translated prose was removed; word caps now explicitly limit content volume only, not sentence structure.

**Tooling**

- **Dirty-artifact detection**: the build errors if a hand-edited .js artifact is about to be overwritten; RULES.md now fixes TypeScript as the single source of truth.

## v0.3.105

### 中文

**读图代理闭环（DSHBOTS-112）**

- **无视觉主模型也能回答带图消息**：主模型不支持图片导致首轮失败时，读图代理转写图片并写回会话，随后给同一条消息自动派生续答运行（runs.image_offload=1，不再下发二进制图），主模型当轮即可基于转写正文回答用户；续答沿用首发运行的通道 trigger_type，幂等键防重派。
- **失败分类新增「模型无视觉」**：与「未知」失败区分，通知里说明已转交读图代理转写。

**界面与通道**

- **markdown 文件预览渲染展示**：.md/.markdown 文件走聊天气泡同款 richText 消毒管线渲染；聊天消息里的本地文件链接（普通链接也改写）点击按扩展分流进图片查看器或文本预览弹层。
- **飞书出站全面改 markdown 卡片**：出站一律走 markdown 卡片并改用 JSON 2.0 结构（标题/表格等标准 markdown 才渲染）；提问卡去掉 markdown 列表记号、选项按「1:」编号并分段，防整卡被重编号。
- **微信指令归一化**：固定指令前缀归一化全角符号，中文输入法的 `/？` 与 `／？` 按半角匹配。
- **提问答复文案去 CR**：提问与答复文案去掉 CR 坏空白，飞书卡片与答复气泡不再被劈行。

### English

**Vision proxy closed loop (DSHBOTS-112)**

- **Vision-less main models can now answer image messages**: when the primary model rejects image input, the vision proxy transcribes the image into the conversation and automatically derives a follow-up run for the same message (runs.image_offload=1, no binary re-send), so the main model answers from the transcription in the same turn; the follow-up keeps the original channel trigger_type and is idempotency-keyed.
- **A new "no vision" failure category** distinguishes this from unknown failures, noting that the vision proxy took over transcription.

**UI and channels**

- **Markdown file preview renders**: .md/.markdown files go through the same richText sanitization pipeline as chat bubbles; local file links inside chat messages (plain links included) route by extension to the image viewer or text preview modal.
- **Feishu goes all-in on markdown cards**: outbound cards use the JSON 2.0 structure so standard markdown (headings/tables) renders; question cards drop list markers and number options "1:"-style with paragraph breaks to prevent re-numbering.
- **WeChat command normalization**: fixed command prefixes normalize full-width symbols, so `/？` and `／？` from Chinese IMEs match the half-width forms.
- **CR cleanup for Q&A text**: question and answer text strips CR whitespace, so Feishu cards and reply bubbles no longer break mid-line.

## v0.3.98

### 中文

**数据拓扑（聊天分库 Phase 3，完成体）**

- **控制面明细迁入聊天库**：运行事件（run_events）、任务评论/任务事件、终端命令随运行/项目迁入各自的群聊或单聊 SQLite；`runs` 的交付正文与产物清单转到聊天库 `run_payload`，顶库只保留调度行——领取事务与唯一活跃索引的单库原子性原样保住。顶库 64MB → 43MB，事件 25,615 条精确对账。
- **跨库事务语义**：顶库事务内的聊天库写（任务事件、交付评论等）改为提交后落库，外层回滚即丢弃，不再残留半截事件。
- **修复（自 Phase 1 的回归）**：bot @mention 派发的群聊运行恢复「机器流量档」降档——分库后候选排序的旧 JOIN 恒空导致失效；改为领取时按聊天库实测触发消息定档。

**Agent preset 与界面**

- **team-bots agent preset 随包发布并设为默认**：插件会话命中该默认；worker 会话跟随宿主默认预设，不再硬编码 standard。
- **总览 bots 卡片状态按工作负载显示**：空闲中/任务中两态，子代理在跑也计为任务中。
- **交付摘要保留 markdown 块结构**，整段交付报告不再被压成一个标题。
- **免审规则修复**：行首 `**/` glob 边界允许空白前缀，相对路径命令可命中关键词免审规则。

**English**

- **A team-bots agent preset ships as the default**: plugin sessions match this default; worker sessions follow the host default preset instead of a hardcoded standard.
- **Overview bot cards show workload-based status**: idle vs. working, with running subagents counted as working.
- **Delivery summaries keep their markdown block structure**, so whole reports are no longer collapsed into a single heading.
- **Approval-bypass fix**: a leading `**/` glob boundary now allows whitespace prefixes, so relative-path commands can match keyword bypass rules.

### English

**Data topology (chat DB split Phase 3, final)**

- **Control-plane detail moves into chat stores**: run events, task comments/events and terminal commands now live in each group/solo chat SQLite; run output and artifact lists moved to `run_payload`, leaving the top DB with scheduling rows only — claim transactions and unique active-run indexes keep their single-database atomicity. Top DB shrinks 64MB → 43MB with 25,615 events reconciled exactly.
- **Cross-database transaction semantics**: chat-store writes inside top-database transactions now flush after commit and are discarded on rollback, so no half-written events remain.
- **Fix (regression since Phase 1)**: chat runs dispatched from bot @mentions regain their machine-traffic tier demotion — the old ordering JOIN went permanently empty after the split; tiers are now measured from the trigger message in its chat store at claim time.

## v0.3.80

### 中文

**派单**

- **写范围命中 .gitignore 不再拒绝派单**：命中 .gitignore 的条目改染色进卡（保留声明留痕），不再整卡驳回；既有清洗与审计口径不变。

### English

**Dispatch**

- **Write scopes hitting .gitignore no longer reject dispatch**: entries matching .gitignore are now tinted onto the card (keeping the declaration for the audit trail) instead of rejecting the whole card; the existing cleanup and audit behaviour is unchanged.

## v0.3.79

### 中文

**界面**

- **浮雕材质体系**：卡片、按钮、分段、输入、标签等骨架件改为双影浮雕语言，并全局适配到聊天气泡、作曲盒、弹层、侧栏与浮层；顶栏底缘改落影，磨砂顶盖读作有板厚的盖层；轨迹终态条目去掉残留细框，凹槽族视觉统一；测试断言跟随材质体系更新。
- **待办条目乐观切换**：待回答提问/待处理审批条目点击即乐观切换并先出骨架，不再等待数秒级 state 组装。

**运行时**

- **结转摘要幂等修复**：幂等键带尝试代次，终态运行不再占死补排。

**性能**

- **用量快照装配提速**：零用量判断改 EXISTS、breakdown 按维度一次预取，去掉两处全窗口放大。

**文档**

- README 任务板、用量统计与全局配置双语素材按新界面重拍。

### English

**UI**

- **Embossed material system**: skeleton elements (cards, buttons, segmented controls, inputs, tags) switch to a double-shadow embossed language, applied globally to chat bubbles, composer, modals, sidebar and overlays; the top bar gets a bottom drop shadow reading as a thick frosted lid; trajectory terminal entries lose their leftover hairline borders and the recessed family is visually unified; test assertions follow the material system.
- **Optimistic pending-item switching**: tapping a pending question or approval entry switches optimistically and shows a skeleton first instead of waiting seconds for the state assembly.

**Runtime**

- **Rollover summary idempotency fix**: the idempotency key now carries the attempt generation, so terminal runs no longer deadlock the re-dispatch.

**Performance**

- **Usage snapshot assembly**: zero-usage checks become EXISTS and the breakdown is prefetched per dimension once, removing two full-window scans.

**Docs**

- README screenshots for the task board, usage stats and global configuration retaken in both languages against the new UI.

## v0.3.70

### 中文

**审批与配置**

- **免审规则配置改版**：免审规则改为卡片式列表，新增/编辑拉起 modal；路径规则支持 ~ 家目录；规则保存后即时刷新，并对保存时已在等待中的提权卡追溯放行；免审目标提取兜底更多参数名；工具字段 placeholder 给出示例并提示「留空 = 任意工具」。
- **Bot 级 agent preset 覆盖**：Bot 配置页新增 Agent 预设下拉（默认跟随全局），Bot 单聊配置页（solo-config）同步展示；Worker/Router 预设跟随策略维持全局默认，不做 Worker 缺省 minimal 的变更（相关提交已回退）。

### English

**Approvals and configuration**

- **Approval-bypass rule configuration redesign**: rules become a card list with a modal for creating and editing; path rules accept the ~ home prefix; saving a rule refreshes the list immediately and retroactively releases approval cards that were already waiting; approval-target extraction covers more parameter names; the tool field placeholder shows an example and notes that an empty value matches any tool.
- **Per-bot agent preset override**: the bot configuration page gains an agent-preset dropdown (defaulting to the global value), mirrored on the solo-config page; the global preset-following behaviour is unchanged, and the "Worker defaults to minimal" change was reverted.

## v0.3.64

### 中文

**全局设置**

- **运行参数卡**：全部运行期 `DSH_TEAM_*` 环境变量（29 项）可在全局设置页「关于与系统状态」分组配置，生效优先级 env 显式 > 设置保存值 > 启动默认，界面实时回显当前生效值与默认值。
- **分组改 tab 分页**：用量统计、密钥管理、全局配置三页的分组导航从页内锚点改为 tab 分页容器，一次只渲染激活分组，长页单屏化；任务看板保持原样。tab 支持 `?tab=` 深链。

**文档与工程**

- README 配图按语言分套重拍（英文配主 README、中文配 README.zh），统一 1280×800 单屏；清除无引用的旧设计稿截图。
- 推送前预检：pre-push 钩子做净树检查 + 与 CI 同源的 typecheck/test。

### English

**Global settings**

- **Runtime settings card**: all runtime `DSH_TEAM_*` environment variables (29 entries) are now configurable on the Global settings page, with precedence explicit env > saved setting > startup default; the UI shows the effective and default values inline.
- **Groups become tabs**: the grouped pages (usage stats, secrets, global configuration) switch from in-page anchors to a tabbed container that renders only the active group, keeping each page single-screen; the task board is unchanged. Tabs support `?tab=` deep links.

**Docs and tooling**

- README screenshots retaken per language (English for the main README, Chinese for README.zh) at a uniform 1280×800 single screen; unreferenced design-draft screenshots removed.
- Pre-push preflight: clean-tree check plus typecheck/test identical to CI.

## v0.3.55

### 中文

本版是 v0.3.12 之后 dev 分支的大批次合发：覆盖运行/调度、通道、任务板、记忆、审批与工作台界面等 600 余个提交。含多处数据库结构变更（会话单活跃绑定、串行域、任务亲和、账本与审计表等，开库自动迁移）；无新增必须配置，运行时效、结转等新配置均有默认值。

**运行与调度**

- **会话生命周期重构**：每 bot 单活跃绑定收敛为唯一建行点；512 轮会话结转 + 64 轮闲时总结压缩；任务亲和路由使运行优先落绑定任务会话；入队即合并同车道排队运行，用户提问单独成组优先放行。
- **bot 串行域收窄为 (bot, 工作区)**：单 bot 可在多项目并行；派单级单 bot 多任务并行；owner 任务与总监核验运行忙时挂起队列，空闲自动建回，宿主重启不再杀活跃运行。
- **任务级时效**：time_budget 约束整卡耗时，优先级分档兜底；review/handle 运行分档预算治总监单车道长尾；审批/提问等待超时默认 3→10 分钟并可配；待执行滞留阈值分档梯度提醒。

**任务板与验收**

- **reviewer 产品默认角色**：新群自动带入种子 reviewer，验收核验运行优先落 reviewer 名下；验收机械闸扩展到委派核验运行的子代理账目。
- **变更栅栏**：team_assign_task 改卡可选 expected_version，版本冲突拒绝并回附最近变更事实；重派即新死线窗口。
- **派单质量闸**：核验类卡不得派成员 bot；派单校验 assignee 沙箱策略；无主卡领取/编辑须补写范围声明；交付报告体量红线与交付物路径声明。

**通道与通知**

- **飞书通道落地**：进程内官方 SDK WSClient 传输、凭据模型、出站发送与回程闭环、触发语境提示与状态卡。
- **微信通道强化**：外发幂等收据与 sent/gone 终态、入站 Trigger 留痕、GitHub issue 只读触发源；出站事件按通道分发，不再硬编码微信。
- **分级通知**：reply_mode 新增 mentioned_only 档真实生效；环境消息延迟接单；系统连续通知默认折叠（Quiet by default）。

**记忆**

- **bot 域记忆下放为各 Bot 自管**，总监可点名代管；bot/project 记忆 64 条硬顶与滞回放行；版本历史滚动保留最近 10 版；cleanup 支持 before 批量归档；记忆审查改走独立有界会话可配便宜模型。
- **全文检索修复**：旧库非 trigram 分词的 memories_fts 开库检测并重建回填；短于 3 字符关键词走 LIKE 子串兜底。

**审批与配置**

- **免审规则白名单**：glob 匹配、命中即时放行并留痕，配置迁到总览页紧凑权限卡。
- **设置乐观并发**：revision 令牌 + 409 + 草稿三方合并；设置变更历史只读视图；分段可编辑提示词。

**界面与可访问性**

- **工作台界面大改版**：动效层 token 阶梯、日间/夜间配色三档、文本文件应用内预览、路径 tilde 缩写、全局用量页与配置页布局修复。
- **可访问性**：表单集中内联校验、任务卡/侧栏键盘可达与上下文菜单、遮罩打开背景 inert、可点目标尺寸提升。
- **性能**：state 轮询版本短路 + 视图作用域签名 + 视图载荷缓存与切换 SWR 回放（群聊/单聊切换秒开）；prepared statement 缓存；空闲周期 tick 收敛为单索引探针。

### English

This release ships the large batch accumulated on dev since v0.3.12: more than 600 commits across runs/scheduling, channels, the task board, memory, approvals and the workbench UI. It contains several database schema changes (single active bot binding, serialization domains, task affinity, ledger and audit tables — all applied automatically on startup); no mandatory configuration is added and every new setting ships with a default.

**Runs and scheduling**

- **Session lifecycle rebuild**: per-bot single active binding becomes the only row-creation point; 512-turn rollover plus 64-turn idle compaction; task-affinity routing; same-lane queued runs coalesce at enqueue time and user questions get their own priority group.
- **Bot serialization narrowed to (bot, workspace)**: one bot can work across projects in parallel, including task-level parallelism; owner-task and director review runs queue while busy and resume when idle, surviving host restarts.
- **Task-level timing**: time_budget caps whole-card effort with priority-tier fallbacks; tiered review-run budgets; approval/question wait timeouts default to 10 minutes and are configurable; stale-card thresholds become a four-state gradient.

**Task board and review**

- **A default reviewer role**: new groups seed a reviewer bot and verification runs land there first; the mechanical review gate covers delegated verification runs' subagent accounting.
- **Mutation fence**: team_assign_task accepts expected_version and rejects conflicting edits with the latest card facts; re-dispatch resets the deadline window.
- **Dispatch quality gates**: verification cards cannot be dispatched to member bots; assignee file-policy checks; claimed cards must declare write scopes; delivery reports have size and path-declaration limits.

**Channels and notifications**

- **Feishu channel ships**: in-process official SDK WSClient transport, credential model, outbound delivery and round-trip closing, trigger context and status cards.
- **WeChat channel hardened**: idempotent outbound receipts with sent/gone terminal states, inbound trigger trail, a GitHub issue read-only trigger source; outbound events fan out per channel instead of hardcoding WeChat.
- **Tiered notifications**: a real mentioned_only reply mode; ambient messages defer pickup; consecutive system notices collapse by default (quiet by default).

**Memory**

- **Bot-scope memories become bot-managed** with director proxy management; 64-entry hard caps with hysteresis; version history keeps the last 10 revisions; cleanup supports before-cutoff batch archiving; memory review moves to a bounded session with a cheaper configurable model.
- **Full-text search fixes**: legacy non-trigram memories_fts tables are detected, rebuilt and backfilled on startup; keywords shorter than 3 characters fall back to LIKE substring matching.

**Approvals and configuration**

- **Approval bypass whitelist**: glob-matched rules pass privileged requests instantly with an audit trail; the card moves to the overview page.
- **Optimistic concurrency for settings**: revision tokens with 409 responses and three-way draft merges; a read-only settings history view; segmented editable prompts.

**UI and accessibility**

- **Workbench redesign**: a motion token ladder, three-mode light/dark theming, in-app text file preview, tilde-abbreviated paths, and layout fixes on the global usage and settings pages.
- **Accessibility**: centralized form inline validation, keyboard-reachable task cards with a context menu, inert backgrounds under modals, and larger touch targets.
- **Performance**: version short-circuit state polling with view-scoped signatures, view payload caching with stale-while-revalidate switching, prepared-statement caching, and an idle-gated periodic tick.

## v0.3.12

### 中文

本版是 v0.3.9 批次的补发：该批次的 tag 推上后被 typecheck 拦下、publish 被跳过，包始终没有进入 npm registry，本版把整批改动重新发出去。除补发外，本版还把 dev 分支的 CI 两道闸接上，让同类类型错误不再潜伏到发版才红。版本为 patch 级，无数据库结构变更，无新增服务端配置。

**发布**

- **补发 v0.3.9 批次**：v0.3.9 的 tag 因类型错误被拦下，该批次的完整改动在本版首次进入 npm registry。
- **类型声明修复解除发布阻断**：补上 TeamConfig.maxWriteScopesPerTask 的类型声明，并把拒绝派单用例的断言参数收窄为 unknown，typecheck 恢复全绿。
- **新增 dev push CI 两道闸**：dev 分支的 push 与发往 dev 的 PR 新增 typecheck+test 工作流，与 tag 发布路径同口径，类型错误在开发分支即被拦下。

v0.3.9 小节所列的 8 项特性（运行时 1 项、工具 1 项、调度 2 项、记忆 4 项）随本版首次上架，该小节的界面改动（路径展示补齐 tilde 缩写）一并随行。

### English

This release republishes the v0.3.9 batch: its tag was stopped by typecheck and publish was skipped, so the package never reached the npm registry, and this release ships the whole batch again. On top of the republication, dev pushes and pull requests targeting dev now run the same typecheck+test gate as the tag path, so the same class of type errors is caught on the development branch instead of only at release time. The bump is patch level; no database schema changes and no new server configuration.

**Release**

- **The v0.3.9 batch is republished**: the v0.3.9 tag was blocked by type errors, so this release puts that batch onto the npm registry for the first time.
- **The type declaration fix unblocks publishing**: TeamConfig.maxWriteScopesPerTask now carries its type declaration and the rejected-dispatch assertion narrows its parameter to unknown, which turns typecheck green again.
- **Two new CI gates on dev pushes**: pushes to dev and pull requests targeting dev now run a typecheck+test workflow with the same coverage as the tag path, so type errors are caught on the development branch.

The eight features listed in the v0.3.9 section (one runtime, one tool, two scheduling and four memory items) ship with this release for the first time, together with the interface change from that section (tilde abbreviations across path displays).

## v0.3.9

### 中文

本版修复两处长期静默失效的机制，并给记忆与调度补上自管通道：成员 bot 的工具层策略自 DSHBOTS-238 起从未真正生效，记忆容量锁的恢复线过苛导致整理完仍被挡住。版本为 patch 级，无数据库结构变更，无新增服务端配置。

**运行时**

- **备用模型切换覆盖内部运行**：内部运行种类集合（task/review/handle/memory_review）接入额度路由与备用模型派生，调度额度扣持闸同步扩到该集合，聊天类运行行为不变。Bot 更换 provider 时迁移 bot_quota 额度记录，保留更严的一条。

**工具**

- **成员 bot 工具层策略恢复**：工具层兜底此前把 restrict 摘下后裸调用，宿主侧接收者丢失并被吞成一条告警，成员 bot 一直可见总监专权工具。现改为保留接收者的方法调用，工具层策略恢复生效。

**调度**

- **并行吞吐默认值提升**：按近 7 天生产实测（常态并发 2–3、峰值 7），并行运行上限默认 6→10、队友数默认 3→5；派单预算分档放宽为 urgent/high 90 分钟、medium 60 分钟、low/none 30 分钟，直建卡兜底 40 分钟。
- **大卡拆分闸产品化**：新增单卡写范围上限（默认 8 条），派单建卡的写范围超限时拒绝并指引拆成 parent_task_id 子卡并行；只拦新建卡，重派存量卡不受限。

**记忆**

- **容量锁恢复线 33→54**：记忆硬顶仍是 64 条，触顶后需整理到的恢复线由 33 上调到 54（硬顶减 10，覆盖审查单轮最大突发），不再让恢复线本身成为新的阻塞源。
- **审查拒写带内留痕**：记忆审查写入被拒时把拒因写进运行事件（拒写条数、因容量锁被拒的条数与拒因原文），返回体同步给出拒写计数，不再只留一条无人处理的系统日志。
- **bot 域记忆下放自管**：任意项目群 Bot 都能列出、写入与清理自己的 bot 域记忆（点名参数只接受自己），项目域与团队域仍归总监。
- **总监记忆工具支持 bot 点名代管**：总监的记忆工具可按 bot 的 id 或精确名代管成员 Bot 的记忆域，作为成员 Bot 触顶后无法自清的合法整理通道，权限仍走总监闸门。

**界面**

- **路径展示补齐 tilde 缩写**：DSH 路径卡、管理数据行、技能页与技能详情、以及目录选择器头部统一改用 ~ 缩写展示；复制、悬停提示与输入框回填仍保留完整路径。

### English

This release repairs two mechanisms that had been silently ineffective and opens self-service paths for memory and scheduling: the tool-layer policy for member bots never actually took effect since DSHBOTS-238, and the memory capacity lock's restore line was so tight that a cleaned-up scope stayed blocked. The bump is patch level; no database schema changes and no new server configuration.

**Runtime**

- **Fallback model switching now covers internal runs**: internal run kinds (task/review/handle/memory_review) join quota routing and fallback model derivation, and the scheduler's quota hold gate extends to the same set; chat runs behave as before. When a bot changes provider its bot_quota record is migrated, keeping the stricter of the two.
- **Member-bot tool-layer policy is effective again**: the tool-layer fallback used to detach restrict and call it bare, losing the receiver on the host side and swallowing the failure as one warning, so member bots kept seeing director-only tools. The call now keeps its receiver and the tool-layer policy takes effect again.

**Scheduling**

- **Higher default parallelism**: based on seven days of production measurements (typical concurrency 2–3, peak 7), the default parallel run limit rises from 6 to 10 and the default teammate count from 3 to 5; dispatch budgets are relaxed to 90 minutes for urgent/high, 60 for medium and 30 for low/none, with 40 minutes as the direct-creation fallback.
- **Large-card split gate productised**: a new per-card write-scope limit (8 by default) refuses dispatch when the declared write scopes exceed it and points to splitting the work into parent_task_id child cards; only new cards are gated, re-dispatching existing cards is unaffected.

**Memory**

- **Capacity lock restore line moved from 33 to 54**: the hard cap stays at 64 entries, but a latched scope now only has to be cleaned down to 54 (cap minus 10, covering the largest single-round review burst) before new writes are accepted, so the restore line stops being a blocker of its own.
- **Rejected review writes leave a trace**: when a memory review write is refused, the reason is recorded in the run event (rejected count, how many were refused by the capacity lock and the original reasons), and the return value carries the same counts, instead of a system log nobody handles.
- **Bot-scoped memory is self-managed**: any bot in a project group can list, write and clean up its own bot-scoped memory (the bot argument only accepts itself); project and team scopes remain the director's.
- **Director memory tools can manage a named bot's scope**: the director's memory tools can manage a member bot's memory scope by id or exact name, giving member bots a legitimate cleanup path once they hit the cap; permissions still pass through the director gate.

**Interface**

- **Tilde abbreviations complete across path displays**: the DSH path card, the management data row, the skill page and skill detail view, and the directory picker header all render paths with ~ abbreviations; copying, hover tooltips and input back-fill still keep the full path.

## v0.3.0

### 中文

本版把 [dsh-agent-team](https://github.com/Contexera/dsh-agent-team) 的五项协作理念按本仓自己的形态落地，次版本号翻位标识行为面变化。无数据库结构变更，无新增服务端配置。

**运行时**

- **执行者不得验收**：bot 验收者只要担任过本卡负责人（含历史改派）就被机械拒绝，须转派给未执行过本卡的 bot，或由人在看板验收。退回重做不受限制，人与系统看门狗也不受此闸。
- **群聊回复模式真实生效，并新增「仅被点名」档**：`reply_mode` 此前存而不用，现在三档全部生效。新增的 `mentioned_only` 档下，没人被点名的消息不会立即唤醒任何 bot，但总监的思考气泡会立刻亮起，总监在一秒后自动接单；点名与引用回复在所有档位都照常直达。
- **群消息尾窗分级注入**：点名本 bot 的消息保持全文并加「→你」标记，其他 bot 的闲聊折叠为短背景摘要，人发的消息不折叠。以此降低噪音并节省 token。
- **任务状态事件流补全**：所有直改任务状态的路径统一经 `setTaskStatus`，状态更新与权威 `status` 事件同事务落库，事件流因此可以完整重放任务状态机。新增 `task_projection_drift` 接口做只读巡检，事件流与任务表不一致时报出漂移，不自动修复。

**工具**

- **变更栅栏**：`team_assign_task` 改卡可带 `expected_version`。卡在读取之后发生过交付、流转或他人编辑时写入被拒，拒绝里列出最近变更，据此重新裁决即可重试；不带该参数时保持先写后赢的旧行为。

**记忆**

- **验收沉淀提醒**：任务验收通过后只为负责人记一个待提醒标记，他在这张卡所属项目的下一次运行里会收到一段一次性提醒，指引把值得跨任务保留的结论写进 `team_remember`。不产生额外轮次，也不往会话日志注入内容。

### English

This release lands five collaboration ideas from [dsh-agent-team](https://github.com/Contexera/dsh-agent-team) in this repository's own vocabulary; the minor bump marks the behaviour changes. No database schema changes and no new server configuration.

**Runtime**

- **Whoever builds does not verify**: a bot reviewer that has ever been the card's assignee, including past reassignments, is now refused on accept; the review goes to a bot that never executed the card, or to the human on the board. Returns for rework, the human owner, and the system watchdog are not gated.
- **Group reply modes take effect, with a new "Mentioned only" mode**: `reply_mode` was stored but never consumed and now fully works. In the new `mentioned_only` mode a message that addresses nobody wakes no bot immediately, the director's thinking bubble appears at once, and the director claims it after one second; explicit mentions and replies deliver in every mode.
- **Tiered tail-window injection**: messages that mention the bot keep their full text with a marker, other bots' chatter collapses into short background digests, and human messages are never collapsed, cutting noise and tokens.
- **Authoritative task status events**: every path that changes a task's status now goes through `setTaskStatus`, committing the update and an authoritative `status` event in one transaction, so the event stream fully replays the task state machine. A new read-only `task_projection_drift` endpoint reports any drift between the ledger and the task table without repairing it.

**Tools**

- **Mutation fence**: `team_assign_task` amendments accept an optional `expected_version`. If the card changed since you last saw it the write is refused with the recent changes listed, so you can re-decide and retry; omitting the parameter keeps the previous last-write-wins behaviour.

**Memory**

- **Acceptance reminder**: accepting a task records a pending marker for the assignee, whose next run in that project carries a one-time reminder to persist durable conclusions with `team_remember`. It costs no extra turn and injects nothing into the session log.

## v0.2.465


### 中文

本版是 v0.2.461 之后的三笔合入：验收机械闸改按评审周期查账、恢复演练主备份判定收窄、记忆锁定期文案与日志插值修复。

**运行时**

- **验收闸门改按评审周期查账**：验收机械闸不再只看「当前活跃运行」，改为按本任务的评审周期查账——周期起点取最近一次交付（`run_succeeded`）或看板流转（`status → in_review`）事件的 `MAX(created_at)`，周期内存在子代理账目（`subagent_spawned`）即放行。两跳正规流程（`review_delegate` 派子代理 → 新运行只做裁决）此前必被误拦，现已正常放行；账目挂在别的任务、别的会话或早于最近交付锚点时仍然拒绝。
- **账目认领线扩到两条**：账目运行的归属判定由「当次运行」扩到「本任务的 owner 派单运行（task_id + bot_id）」或「调用方会话的任意运行」，覆盖验收子代理挂在上一跳已结束运行上的实际形态。
- **子代理落账回退任意 running 运行**：owner bot 的派单账优先记 `kind='task'` 的 running 运行；无施工运行时回退该 bot 任意 `kind` 的 running 运行（review/chat），总监验收链的核验子代理不再永远查不中而不落账。

**工具与运维**

- **恢复演练主备份判定收窄**：恢复演练挑「最新一份备份」时只认 `team-<stamp>.sqlite`，不再把同名前缀的附件（`.wechat.sqlite` 附件库、`.secret.key` 密钥、`.json` 清单）当主备份挑走——附件被挑走时演练会因找不到同名清单而失败。
- **restore-check 导出可测、被 import 不自动开跑**：主备份判定函数改为导出，被测试 import 时不自动开跑（与 doctor 同口径），并新增 3 例守门测试钉住判定、排序与不自动开跑三条行为。
- **dev-server capabilityInfo 版本对齐**：`capabilityInfo()` 返回的版本号由 `0.2.1-rc.5` 对齐到 `0.2.461`，预览服务对外报出的版本与实际发版一致。

**记忆与日志**

- **整理锁定期文案如实**：记忆条数回落但滞回标志仍在（34–63 条的整理锁定期）时，拒新增文案如实说明「此前触顶 64 条上限，现处整理锁定期（当前 N 条）」，不再谎称「已达 N/64」；触顶态文案保持原样。
- **日志前缀并入首参格式串**：`createLogger` 的 `[dsh-team]` 前缀改为并入首参格式串后再交给 `console.*`，此前前缀独占首参导致后续参数里的 `%s`/`%d` 永不插值（owner 看到的是字面 `%s`）。

**升级路径与回退**

无数据库结构变更、无新增服务端配置项。回退按发版级回退：回退包版本与 tag，恢复发版前库快照。

### English

This release bundles three changes landed after v0.2.461: the review gate now looks up the subagent ledger per review cycle, the restore drill narrows main-backup detection, and the memory lock-period wording plus log interpolation are fixed.

**Runtime**

- **The review gate looks up the ledger per review cycle**: the mechanical acceptance gate no longer inspects only the currently active run. It now queries the subagent ledger within the task's review cycle, whose start is the `MAX(created_at)` of the latest delivery (`run_succeeded`) or board transition (`status → in_review`); a `subagent_spawned` entry inside that cycle passes the gate. The two-hop happy path (`review_delegate` spawns a subagent → a new run only adjudicates) was previously always rejected and now passes, while entries bound to another task, another session, or a point before the latest delivery anchor are still refused.
- **The ledger claim now spans two lines**: the run that owns the ledger entry is matched either by the task's owner dispatch run (`task_id` + `bot_id`) or by any run of the caller's session, covering the real shape where the verification subagent is booked on the already-finished previous hop.
- **Ledger booking falls back to any running run**: the owner bot's dispatch entry prefers the `kind='task'` running run, and falls back to any `kind` of running run (review/chat) for that bot when no construction run exists, so verification subagents in the director's acceptance chain are no longer silently unbooked.

**Tooling and operations**

- **Restore-drill main-backup detection is narrowed**: picking the newest backup now only accepts `team-<stamp>.sqlite`; the same-prefix attachments (`.wechat.sqlite` side database, `.secret.key` key, `.json` manifest) are no longer picked as the main backup, which previously made the drill fail with a missing manifest.
- **restore-check exports a testable predicate and does not auto-run when imported**: the main-backup predicate is exported and the drill only starts when invoked directly (same convention as doctor), with 3 new guard tests pinning the predicate, the sort order, and the no-auto-run behaviour.
- **dev-server capabilityInfo version is aligned**: `capabilityInfo()` now reports `0.2.461` instead of `0.2.1-rc.5`, so the preview service advertises the version that is actually released.

**Memory and logging**

- **The lock-period wording states the truth**: when the hysteresis flag is still set while the entry count has dropped back (the 34–63 entry lock period), the rejection message truthfully states that the 64-entry cap was hit earlier and that the scope is now in the lock period with the current count, instead of claiming "reached N/64"; the cap-state wording is unchanged.
- **The log prefix joins the first format string**: `createLogger` merges the `[dsh-team]` prefix into the first format string before handing it to `console.*`. Previously the prefix occupied the first argument alone, so `%s`/`%d` in later arguments were never interpolated (owners saw a literal `%s`).

**Upgrade path and rollback**

No schema change and no new server-side setting. Rollback is release-level: revert the package version and tag, and restore the pre-release database snapshot.

## v0.2.461

### 中文

本版是 v0.2.460 之后的四笔合入：归档会话不再复用、`/tr` 恢复直达项目群聊、配色支持日间/夜间切换，以及设置保存改用 patch/revision 分离契约。

**运行时**

- **归档会话不再复用**：复用会话前先查宿主归档名单，命中即解除绑定并新建会话，不再拿已被宿主归档的会话继续跑。控制面绑定、任务亲和、记忆审查会话、结转/压缩运行四处复用点统一走这道闸；宿主查不到该服务（旧宿主）时按未归档处理。
- **blocked 无输出按失败上报**：宿主对归档会话拒跑模型步骤，turn/end 记 blocked 且无 assistant 文本；这种运行改按 `SESSION_BLOCKED` 失败上报，不再当成功落库（群聊里表现为「模型未返回文本」），失败分类新增「会话受阻」一类。

**通道（微信/飞书）**

- **`/tr <key>` 恢复直达项目群聊**：消息以通道管理员身份插入项目群聊并触发 chat 运行（origin 透传），回复经 run-finish 推回微信/飞书。自由文本仍落 director 专属会话；直达项目群聊时若无可定向 Bot（无 `@` 且 owner 不可用），走 `no_owner` 拒投出口，不入对话。

**界面**

- **配色支持日间/夜间切换**：设置页「偏好 → 界面」新增明暗分段开关（跟随/日间/夜间），与既有调色板选择正交；手动档压过自动判定，「跟随」档仍由观察器实时跟随宿主切深浅，偏好落盘在浏览器 localStorage 的 `dshb:ui-color-scheme`，刷新后保持。
- **设置保存改用 patch/revision 分离契约**：`update_settings` 统一走 `{ patch, revision }` 形态（服务端兼容旧调用形态）；修订号冲突时静默三方合并，用户草稿回贴表单，不丢已填内容。
- **markdown 图片失败给出可定位原因**：图片路径解析补空格、`file://` 协议与反斜杠归一；失败 chip 按状态分类——未改写的外部链接给通用提示，已改写再探失败按 403（路径越界）与 404（工作区里找不到）分别提示。

**升级路径与回退**

无数据库结构变更、无新增服务端配置项（明暗偏好是浏览器端 localStorage 键 `dshb:ui-color-scheme`）。回退按发版级回退：回退包版本与 tag，恢复发版前库快照。

### English

This release bundles four changes landed after v0.2.460: archived sessions are no longer reused, `/tr` reaches the project group chat directly again, the colour scheme gains a day/night switch, and settings saving moves to the patch/revision split contract.

**Runtime**

- **Archived sessions are no longer reused**: before reusing a session the plugin consults the host's archived-session list; on a hit the binding is retired and a new session is created instead of running on an already archived session. The check covers all four reuse points — control-plane binding, task affinity, memory-review sessions, and rollover/compaction runs; when the host does not expose the service (older hosts) the session is treated as not archived.
- **Blocked runs without output are reported as failures**: the host refuses to run model steps for archived sessions and records a blocked turn/end with no assistant text; such runs are now reported as a `SESSION_BLOCKED` failure instead of being stored as a success (which surfaced in group chats as "the model returned no text"). The failure classification gains a "session blocked" category.

**Channels (WeChat/Feishu)**

- **`/tr <key>` reaches the project group chat directly again**: the message is inserted into the project group chat as the channel administrator and triggers a chat run (with `origin` passed through); the reply is pushed back to WeChat/Feishu via run-finish. Free text still lands in the director's solo session; when a direct project-group message has no addressable Bot (no `@` and the owner is unavailable) it is refused with the `no_owner` outcome and never enters the conversation.

**Interface**

- **The colour scheme gains a day/night switch**: settings → preferences → interface now offers a three-way segment (follow / day / night), orthogonal to the existing palette choice; a manual choice overrides the automatic detection, the follow option still tracks the host in real time, and the preference is persisted in the browser's localStorage under `dshb:ui-color-scheme`, so it survives a reload.
- **Settings saving uses the patch/revision split contract**: `update_settings` uniformly takes the `{ patch, revision }` shape (the server still accepts the old form); on a revision conflict the change is silently three-way merged and the user's draft is pasted back into the form instead of being lost.
- **Markdown image failures report a locatable reason**: image path resolution now tolerates spaces, `file://` URLs and backslash separators, and the failure chip distinguishes an unrewritten external link (generic hint) from a rewritten path that 403s (path out of bounds) or 404s (not found in the workspace).

**Upgrade path and rollback**

No schema change and no new server-side setting (the day/night preference is the browser-side localStorage key `dshb:ui-color-scheme`). Rollback is release-level: revert the package version and tag, and restore the pre-release database snapshot.

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
