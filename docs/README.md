# DSH Team Bots / DSH 团队 Bots

DSH Team Bots is a plugin for DSH (DeepSeek Harness). It runs inside the DSH Web process — no separate service — and packs a collaborating crew of bots into one workspace: project group chats, a task board, write-scope parallel scheduling, memory and skills, usage and cost accounting, plus a personal WeChat channel.

DSH Team Bots 是 DSH（DeepSeek Harness）的插件，与 DSH Web 同进程运行，不另起服务。它把一支会协作的 Bot 小队装进同一个工作台：项目群聊、任务看板、写范围并行调度、记忆与技能、用量与成本，外加一条个人微信通道。

This file is the repository's main document. The root `README.md` keeps only a pointer to it.

本文件是仓库的主文档。仓库根目录的 `README.md` 只保留一行指引，指向这里。

Every section lists the English version first and the Chinese version right after it. The two carry identical technical facts; when they ever disagree, the source code wins.

每个章节先给英文版，紧接中文对照版。两版技术事实完全一致；若出现分歧，以源码为准。

---

## Contents / 目录

- [1. Project Overview / 项目简介与定位](#1-project-overview--项目简介与定位)
- [2. Quick Start / 快速开始](#2-quick-start--快速开始)
- [3. Feature Overview / 功能总览](#3-feature-overview--功能总览)
- [4. Architecture and Layout / 架构与目录说明](#4-architecture-and-layout--架构与目录说明)
- [5. Testing and Development Conventions / 测试与开发约定](#5-testing-and-development-conventions--测试与开发约定)
- [6. Troubleshooting and FAQ / 故障排查与常见问题](#6-troubleshooting-and-faq--故障排查与常见问题)

---

## 1. Project Overview / 项目简介与定位

`dsh-team-bots` is a DSH plugin that runs inside the DSH Web process, with no extra process and no extra port. What it does is let several bots share a set of project spaces and split the work, while exposing the whole collaboration process as a web workspace you can actually operate.

`dsh-team-bots` 是一个 DSH（DeepSeek Harness）插件，随 DSH Web 在同一进程内运行，不另起服务。它做的事情是：让多个 Bot 在同一批项目空间里分工协作，并把协作过程暴露成一块可操作的网页工作台。

Three positioning points:

三个定位要点：

1. **Collaboration happens in projects, not in a chat window.** Every project owns its group chat, members, tasks and working directory; the project director bot splits work, assigns it and accepts results in that chat.

   **协作发生在项目里，而不是发生在聊天窗口里。** 每个项目有自己的群聊、成员、任务与工作目录；项目总监 Bot 负责在群聊里拆单、派单、验收。
2. **Parallelism is declared, not hoped for.** A task can declare which paths it intends to write; the scheduler then decides whether two write runs in the same project may run at once: both sides must declare, and their path prefixes must not overlap. If either side does not declare, the runs are treated as serial.

   **并行靠声明，不靠运气。** 任务可以声明自己要写哪些路径，调度器据此判定同项目的两个写运行能否并行：两侧都声明且路径前缀互不重叠才放行，任一未声明按保守串行处理。
3. **Everything is traceable.** Every run has a trajectory, duration, token count and cost; bot configuration keeps an immutable history that can be rolled back; secrets are stored encrypted, materialised as one-time plaintext files only when used, and burned right after.

   **一切可回溯。** 每次运行有轨迹、耗时、token 与成本；Bot 配置有不可变历史可回滚；密钥只以密文落库，使用时物化成一次性明文文件，用完即焚。

Repository shape: `index.js` is the plugin entry point, `src/` holds the server side and the scheduler, `ui/` is the workspace frontend, `tests/` are the guard tests, `docs/` holds design specs, review records and screenshots.

仓库自身的形态：`index.js` 是插件装配入口，`src/` 是服务端与调度，`ui/` 是工作台前端，`tests/` 是守门测试，`docs/` 放设计方案、评审记录与截图。

---

## 2. Quick Start / 快速开始

### 2.1 Requirements / 环境要求

| Item | Requirement |
| --- | --- |
| Node.js | ≥ 22.19 (see `engines` in `package.json`) |
| DSH CLI | installed; `dsh --version` self-checks |
| Plugin form | runs inside the DSH Web process — no standalone process, no standalone port |

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 22.19（见 `package.json` 的 `engines`） |
| DSH CLI | 已安装，`dsh --version` 可自查 |
| 插件形态 | 随 DSH Web 进程内运行，无独立进程、无独立端口 |

### 2.2 Install into a DSH profile / 安装到 DSH profile

```sh
cd <repo>
npm pack                                        # produces dsh-team-bots-<version>.tgz
dsh plugin --profile <name> add ./dsh-team-bots-<version>.tgz
dsh --profile <name>                             # read the tokenised dsh web entry from the startup log
```

### 2.3 One-shot reinstall (a profile is a snapshot) / 一键重装（profile 是快照）

```sh
npm run profile:install -- --profile <name>     # installs into team-bots when --profile is omitted
```

This command packs the current repository with `npm pack` into the repository's `.dist/`, reinstalls it into the target profile with `dsh plugin add`, and rewrites that profile's patch file to trigger a recomposition — the effect is a DSH restart without stopping the process.

这条命令把当前仓库 `npm pack` 到仓库内 `.dist/`，再用 `dsh plugin add` 重装进目标 profile，并改写该 profile 的 patch 文件触发一次 recomposition——效果等同于重启 DSH，但不用停进程。

**This is the easiest thing to get wrong: the plugin files inside a profile are a snapshot, and DSH does not pick up replaced files on its own.** After changing code you must reinstall (`npm run profile:install`), otherwise the running instance still executes the old code and the page sticks at "connecting to the team space".

**这一点最容易踩坑：profile 里的插件文件是快照，DSH 不会自动加载被替换的文件。** 改完代码后必须重装（`npm run profile:install`），否则线上仍在跑旧代码，页面会停在「正在连接团队空间」。

Team data is decoupled from profiles: the data directory is decided only by `DSH_TEAM_WORKSPACE` / `DSH_TEAM_DATA`, so reinstalling into another profile — or keeping several installs side by side — reads and writes the same data.

团队数据与 profile 解耦：数据目录只由 `DSH_TEAM_WORKSPACE` / `DSH_TEAM_DATA` 决定，换 profile 安装或并存多份安装，读写的都是同一份数据。

### 2.4 Local preview / 本地预览

```sh
npm run dev        # http://127.0.0.1:4317, fake runtime, data under .dev/ in the repository
```

The preview server uses a fake DSH runtime. It has **no authentication, touches no DSH configuration, and must not be used in production**. The port can be overridden with `PORT`.

预览服务使用假的 DSH runtime，**没有认证、不动任何 DSH 配置、不能用于生产**。端口可用 `PORT` 覆盖。

### 2.5 Where data, secrets and skills live / 数据、密钥与技能放在哪

| Content | Location |
| --- | --- |
| Team workspace root | `DSH_TEAM_WORKSPACE`, default `~/.dsh/workspace/team-bots` |
| Team data directory | `DSH_TEAM_DATA`, default `<workspace>/.data` |
| Main database | `<data dir>/team.sqlite` |
| WeChat channel database | `<data dir>/wechat-channel.sqlite` |
| Secret master key file | `<data dir>/secret.key` (back it up together with the database — existing ciphertext is undecryptable without it) |
| Long-term memory / message attachments | `<data dir>/memory/`, `<data dir>/messages/` |
| One-time secret runtime files | `<data dir>/secrets-runtime/`, burned when the TTL expires |
| Shared skill pool | fixed at `~/.agents/skills`, shared with the other agent tools on the machine |
| Project-local skills | `<project>/.agents/skills`, `<project>/.claude/skills`, `<project>/.codex/skills` |

| 内容 | 位置 |
| --- | --- |
| 团队工作区根 | `DSH_TEAM_WORKSPACE`，缺省 `~/.dsh/workspace/team-bots` |
| 团队数据目录 | `DSH_TEAM_DATA`，缺省 `<工作区>/.data` |
| 主数据库 | `<数据目录>/team.sqlite` |
| 微信通道库 | `<数据目录>/wechat-channel.sqlite` |
| 密钥主密钥文件 | `<数据目录>/secret.key`（备份必须一起带走，缺了既有密文解不开） |
| 长期记忆 / 消息附件 | `<数据目录>/memory/`、`<数据目录>/messages/` |
| 一次性密钥运行时文件 | `<数据目录>/secrets-runtime/`，TTL 到期即焚 |
| 共享技能池 | 固定在 `~/.agents/skills`，与本机其他 agent 工具共用同一目录 |
| 项目自带技能 | `<项目>/.agents/skills`、`<项目>/.claude/skills`、`<项目>/.codex/skills` |

A template for the common variables lives in `.env.example` at the repository root. Export it with direnv or an editor dotenv plugin — **do not put a `.env` file in the repository root**, because that would leak `DSH_*` into `npm test` and `npm run dev`.

常用变量的模板见仓库根目录 `.env.example`。请用 direnv 或编辑器 dotenv 插件导出，**不要在仓库根目录放 `.env`**——那会把 `DSH_*` 带进 `npm test` 与 `npm run dev`。

### 2.6 Entry points and auto-login / 访问入口与自动登录

```text
http://<host>:<port>/                     auto-login, straight into the team workspace
http://<host>:<port>/api/dsh-team/ui      the DSH Team Bots workspace (direct)
http://<host>:<port>/index.html           the native DSH web UI
```

The first visit to the home page exchanges the current startup token for a 30-day login cookie and redirects to the workspace — there is no manual step. Auto-login means **anyone who can reach the port becomes owner**, so the service should only listen on localhost or a trusted network; exposing it publicly requires an HTTPS reverse proxy that forwards Host and WebSocket correctly.

首次打开首页会用当前启动 token 兑换一枚 30 天登录 Cookie 并跳转到工作台，无需手动步骤。自动登录意味着**能连上该端口的人即获得 owner 访问权限**，服务只应监听本机或受信任网络；对外提供服务必须走 HTTPS 反向代理并正确转发 Host 与 WebSocket。

### 2.7 Common environment variables / 常用环境变量

Defaults come from `src/config.js` (resolution order: explicit env > value saved on the page > code default). A value saved on the page can be overridden by an env variable of the same name.

缺省值取自 `src/config.js`（配置解析链路：显式 env > 页面保存值 > 代码缺省）。页面保存值可被同名 env 覆盖。

| Variable | Default | Purpose |
| --- | --- | --- |
| `DSH_TEAM_WORKSPACE` | `~/.dsh/workspace/team-bots` | team workspace root |
| `DSH_TEAM_DATA` | `<workspace>/.data` | team database and run records |
| `DSH_TEAM_MAX_RUNS` | `6` | global concurrent run limit (1–16) |
| `DSH_TEAM_RUN_TIMEOUT_MS` | `3600000` | hard timeout for a single run (30 s – 6 h) |
| `DSH_TEAM_MAX_RUN_TOKENS` | `0` | per-run token cap, 0 disables it |
| `DSH_TEAM_STALL_TIMEOUT_MS` | `1200000` | silence before a run counts as stalled, 0 disables it |
| `DSH_TEAM_SESSION_ROLLOVER_TURNS` | `256` | accumulated turns of one bound session before rollover, 0 disables it |
| `DSH_TEAM_CHAT_MAX_CHARS` | `800` | group-chat reply compression cap (full deliveries always go to task comments) |
| `DSH_TEAM_APPROVAL_TIMEOUT_MS` | `180000` | privilege-escalation approval window, auto-rejected on expiry |
| `DSH_TEAM_QUESTION_TIMEOUT_MS` | `180000` | question hand-off window |
| `DSH_TEAM_SECRETS_TTL_MS` | `1800000` | lifetime of one-time secret runtime files |
| `DSH_TEAM_DM_ARCHIVE_DAYS` / `DSH_TEAM_DM_KEEP_RECENT` | `7` / `100` | direct-message archive filter: days and count, intersected |
| `DSH_TEAM_UI_LANGUAGE` | `auto` | UI language: `auto` follows the DSH host, `zh` / `en` override it |
| `DSH_TEAM_SECRET_KEY` | — | secret master key (64 hex characters) |
| `DSH_TEAM_MODEL_PRICES` | — | model price JSON array (per million tokens), overriding the built-in defaults |
| `DSH_TEAM_AGENT_TEAM` | `0` | enable the native Agent Teams layer |
| `DSH_TEAM_MAX_TEAMMATES` | `3` | teammates per crew (1–8) |
| `DSH_TEAM_WECHAT` | `0` | personal WeChat channel (active after QR authorisation) |
| `DSH_TEAM_VISION_PROXY_PROVIDER` / `DSH_TEAM_VISION_PROXY_MODEL` | — | vision proxy model: a read-only transcription model used when the main model cannot see images |
| `DSH_TEAM_AUTO_REVIEW_DELEGATE` | `true` | spawn a sub-agent to verify a delivery when it enters pending review |
| `DSH_TEAM_CODE_HYGIENE_EXTS` | built-in whitelist | extension overrides for the code-hygiene scan |
| `DSH_TEAM_USAGE_SNAPSHOT_CACHE_MS` | `30000` | usage snapshot TTL cache |
| `DSH_TEAM_CATALOG_STALE_MS` | `300000` | stale-while-revalidate window for the model catalogue |

| 变量 | 缺省 | 作用 |
| --- | --- | --- |
| `DSH_TEAM_WORKSPACE` | `~/.dsh/workspace/team-bots` | 团队工作区根目录 |
| `DSH_TEAM_DATA` | `<工作区>/.data` | 团队数据库与运行记录 |
| `DSH_TEAM_MAX_RUNS` | `6` | 全局并发运行上限（1–16） |
| `DSH_TEAM_RUN_TIMEOUT_MS` | `3600000` | 单个运行的硬超时（30 秒–6 小时） |
| `DSH_TEAM_MAX_RUN_TOKENS` | `0` | 单运行 token 上限，0 关闭 |
| `DSH_TEAM_STALL_TIMEOUT_MS` | `1200000` | 多久没有新事件判定卡住，0 关闭 |
| `DSH_TEAM_SESSION_ROLLOVER_TURNS` | `256` | 同一绑定会话累计轮数超过阈值即结转，0 关闭 |
| `DSH_TEAM_CHAT_MAX_CHARS` | `800` | 群聊回复压缩上限（完整交付始终进任务评论） |
| `DSH_TEAM_APPROVAL_TIMEOUT_MS` | `180000` | 提权审批等待窗口，到时自动回 rejected |
| `DSH_TEAM_QUESTION_TIMEOUT_MS` | `180000` | 提问转接等待窗口 |
| `DSH_TEAM_SECRETS_TTL_MS` | `1800000` | 一次性密钥运行时文件的存活窗口 |
| `DSH_TEAM_DM_ARCHIVE_DAYS` / `DSH_TEAM_DM_KEEP_RECENT` | `7` / `100` | 单聊归档过滤：天数与条数取交集 |
| `DSH_TEAM_UI_LANGUAGE` | `auto` | 界面语言：`auto` 跟随 DSH 宿主，`zh` / `en` 显式覆盖 |
| `DSH_TEAM_SECRET_KEY` | — | 密钥主密钥（64 位十六进制） |
| `DSH_TEAM_MODEL_PRICES` | — | 模型价格 JSON 数组（每百万 token），覆盖内置默认 |
| `DSH_TEAM_AGENT_TEAM` | `0` | 启用原生 Agent Teams 层 |
| `DSH_TEAM_MAX_TEAMMATES` | `3` | 单支队伍队友数上限（1–8） |
| `DSH_TEAM_WECHAT` | `0` | 个人微信通道（扫码授权后生效） |
| `DSH_TEAM_VISION_PROXY_PROVIDER` / `DSH_TEAM_VISION_PROXY_MODEL` | — | 读图代理模型：主模型无视觉能力时派生的只读转写模型 |
| `DSH_TEAM_AUTO_REVIEW_DELEGATE` | `true` | 交付进入待验收时自动派生子代理核验运行 |
| `DSH_TEAM_CODE_HYGIENE_EXTS` | 内置白名单 | 代码卫生扫描的扩展名覆盖 |
| `DSH_TEAM_USAGE_SNAPSHOT_CACHE_MS` | `30000` | 用量快照 TTL 缓存 |
| `DSH_TEAM_CATALOG_STALE_MS` | `300000` | 模型目录 stale-while-revalidate 窗口 |

---

## 3. Feature Overview / 功能总览

**Project group chat.** Every project has one group chat and one project director bot. It supports plain messages, `@Bot`, `/task @Bot <title>`, `/remember` and `/clear`; typing `/` or `@` opens completions for commands, skills and members. The group chat carries conclusions only — full deliveries go to task comments.

**项目群聊**：每个项目一间群聊和一位项目总监 Bot。支持普通消息、`@Bot`、`/task @Bot 标题`、`/remember`、`/clear`；输入 `/` 或 `@` 弹出命令、技能与成员补全。群聊只放结论，完整交付进任务评论。

**Task board.** A Linear-style panel grouped by status, with a parent/child task tree, priority and assignee, comments delivered straight into a running session, and drag-to-transition; task details inline the delivery artefacts and the run list.

**任务看板**：Linear 风格面板，按状态分组，父子任务树、优先级与负责人、评论直投运行中的会话、拖拽流转；任务详情内联展示交付产物与运行列表。

**Write-scope parallel scheduling.** Once a task declares the paths it will write, two write runs in the same project are judged by those declarations: non-overlapping scopes may run in parallel, overlapping scopes — or an undeclared side — run serially. Write runs are independent of each other, and neither tasks nor group chats block one another.

**写范围并行调度**：任务声明自己要写的路径后，同项目的两个写运行按声明范围判定——范围互不重叠即可并行，重叠或有一方未声明则串行。写运行彼此独立，任务与群聊互不阻塞。

**Memory and the skill pool.** Bot-level and project-level long-term memory; a memory-review run is spawned after a task delivery (controlled by `memory_review`, with group-chat replies additionally controlled by `chat_memory_review`), and the reusable facts it extracts enter a review queue for a human to confirm. The shared skill pool is fixed at `~/.agents/skills`, and a project may bring its own skill directories; skill changes go through proposal approval and keep a rollback snapshot.

**记忆与技能池**：Bot 级与项目级长期记忆；任务交付后派生一次记忆审查运行（`memory_review` 控制，群聊回复另受 `chat_memory_review` 控制），抽取出的可复用事实进待审队列由人复核。共享技能池固定在 `~/.agents/skills`，项目还能自带技能目录；技能变更走提案审批并保留可回滚快照。

**Versioned evolution and team tools.** Changes to roles, models, intensity and skills go through proposal approval, and bot configuration keeps an immutable, rollback-capable history. The plugin registers seven team tools: `team_assign_task`, `team_review_task`, `team_remember`, `team_recall`, `team_propose_evolution`, `team_message_bot` and `team_request_secret`; bots can message each other directly.

**版本化进化与团队工具**：角色、模型、强度与技能变更走提案审批，Bot 配置保留不可变历史可回滚。插件注册七个团队工具：`team_assign_task`、`team_review_task`、`team_remember`、`team_recall`、`team_propose_evolution`、`team_message_bot`、`team_request_secret`，Bot 之间可直接私信协作。

**Secret pipeline.** Secrets are encrypted with AES-256-GCM and stored; once approved they are materialised into the data directory (**never into a project workspace**) and burned when the run ends or the TTL expires; messages and run output always mask them as `$name`.

**密钥管道**：密钥 AES-256-GCM 加密落库；批准后一次性物化到数据目录（**不进项目工作区**），任务运行结束或 TTL 到期即焚；消息与运行输出一律掩码为 `$名称`。

**Usage and cost.** Tokens, call counts, cost and runtime are aggregated at three levels — global, project and bot; cost is computed from configurable model prices, and calls without a price are not billed as zero. Detail exports are available as CSV, together with monthly reconciliation.

**用量与成本**：全局 / 项目 / Bot 三档口径归集 token、调用次数、成本与运行时长；成本按可配置的模型价格计算，未配置价格的调用不按 0 计费。支持明细导出 CSV 与月度对账。

**Approvals and questions.** When a bot asks for extra privileges or needs a human answer, it becomes a card in the workspace; approvals have a waiting window and expire to `rejected`, while an expired question keeps its card so it can still be answered.

**审批与提问**：Bot 请求提权或需要人回答问题时，转成工作台里的卡片；审批有等待窗口，超时自动回 rejected；提问到期保留卡片可补答。

**Terminal.** Each project has an interactive terminal with hard command timeouts, live tailing and cancellation; history is persisted.

**终端**：项目内可交互终端，命令有硬超时，可实时 tail 与取消；历史落库。

**Personal WeChat channel.** After QR authorisation, task activity is pushed to WeChat, and a plain-text command surface is available (see 4.4).

**个人微信通道**：扫码授权后把任务动态推到微信，并支持一套纯文本指令面（见 4.4）。

**Code hygiene.** A project can set a per-file line limit (800 by default); every run scans the workspace source files on the way out, and an over-limit file triggers one 【系统指令】 message to the project chat asking the director to schedule a split.

**代码卫生**：项目可约定单文件行数上限（缺省 800 行），每轮运行收尾扫描工作区源码文件，超标即向项目群发一条【系统指令】，要求总监安排拆分卡。

---

## 4. Architecture and Layout / 架构与目录说明

### 4.1 Wiring / 装配链路

`apply(ctx, config)` in `index.js` is the single entry point, and its order is the dependency order:

`index.js` 的 `apply(ctx, config)` 是唯一入口，顺序即依赖顺序：

```
resolveConfig(config)      → src/config.js      parse env / injected config into a defaulted config
openDatabase(dbPath)       → src/db.js          open and migrate SQLite
new TeamService(...)       → src/service.js     domain facade (methods mounted from src/services/*)
new DshRuntime(...)        → src/runtime.js     host runtime adapter (prompts, sessions, model recovery)
installTeamTools(...)      → src/tools.js       register the seven team tools
installSkillProvider(...)  → src/skills.js      wire the skill pool
installHttp(...)           → src/http.js        HTTP routes and UI style slices
```

Service initialisation is asynchronous: `service.initialize()` creates the database and seeds the default bots and buddies first, then `service.start()` brings up the scheduler.

服务初始化是异步的：`service.initialize()` 完成建库与播种（默认 Bot 与伙伴）后才 `service.start()` 拉起调度器。

### 4.2 The `src/` directory / `src/` 目录

| Path | Responsibility |
| --- | --- |
| `index.js` | plugin entry point and wiring |
| `src/config.js` | configuration resolution: env / value saved on the page / code default, three levels |
| `src/db.js`, `src/db-migrations.js` | SQLite access and idempotent migrations (a new column can be added repeatedly) |
| `src/service.js` | the `TeamService` facade; domain methods are mounted onto the prototype via `defineMethods` in `src/services/*` |
| `src/services/` | domain method bodies: bots, projects, chat, tasks, runs, scheduler, memory, secrets, proposals, terminal, usage, system, wechat, approvals, questions, hygiene, model-fallback, write-scopes, file-policy, and more |
| `src/runtime.js`, `src/services/runtime/` | host adapter: prompt assembly, session lifecycle, model recovery, trajectories |
| `src/http.js` | HTTP routes, UI style slices, the `UI_STYLE_PARTS` style concatenation table |
| `src/api.js` | the `POST /api/dsh-team/api` single entry point for action dispatch |
| `src/tools.js` | team tool registration |
| `src/botmsg.js` | bot-to-bot direct messages via `team_message_bot`: idempotent persistence and delivery prompt assembly |
| `src/skill-parse.js` | skill package (`SKILL.md`) parsing: frontmatter first, falling back to the directory name and the first paragraph |
| `src/wechat/` | WeChat channel: `channel.js` (connection and push), `commands.js` (command surface), `store.js` (outbox and state) |
| `src/secrets.js`, `src/services/secrets.js` | secret encryption, materialisation and masking |
| `src/pricing.js`, `src/usage.js`, `src/usage-reconcile.js` | price table, usage aggregation and reconciliation |
| `src/skills.js`, `src/project-skills.js` | skill pool and project skill scanning |
| `src/seed-bots.js`, `src/updater.js`, `src/paths.js`, `src/util.js`, `src/errors.js` | seed bots, update check, path boundaries, general utilities, error types |

| 路径 | 职责 |
| --- | --- |
| `index.js` | 插件入口与装配 |
| `src/config.js` | 配置解析：env / 页面保存值 / 代码缺省的三级优先级 |
| `src/db.js`、`src/db-migrations.js` | SQLite 访问与幂等迁移（新增列可重复执行） |
| `src/service.js` | `TeamService` 门面；领域方法由 `src/services/*` 通过 `defineMethods` 挂到原型上 |
| `src/services/` | 领域方法体：bots、projects、chat、tasks、runs、scheduler、memory、secrets、proposals、terminal、usage、system、wechat、approvals、questions、hygiene、model-fallback、write-scopes、file-policy 等 |
| `src/runtime.js`、`src/services/runtime/` | 宿主适配：提示词组装、会话生命周期、模型恢复、轨迹 |
| `src/http.js` | HTTP 路由、UI 静态切片、`UI_STYLE_PARTS` 样式拼接表 |
| `src/api.js` | `POST /api/dsh-team/api` 单入口的动作分发 |
| `src/tools.js` | 团队工具注册 |
| `src/botmsg.js` | `team_message_bot` 的 Bot 间私信：幂等落库与投递提示词拼装 |
| `src/skill-parse.js` | 技能包（`SKILL.md`）解析：frontmatter 优先，缺失时回退目录名与正文首段 |
| `src/wechat/` | 微信通道：`channel.js`（连接与推送）、`commands.js`（指令面）、`store.js`（outbox 与状态） |
| `src/secrets.js`、`src/services/secrets.js` | 密钥加密、物化与掩码 |
| `src/pricing.js`、`src/usage.js`、`src/usage-reconcile.js` | 价格表、用量归集与对账 |
| `src/skills.js`、`src/project-skills.js` | 技能池与项目技能扫描 |
| `src/seed-bots.js`、`src/updater.js`、`src/paths.js`、`src/util.js`、`src/errors.js` | 种子 Bot、更新检查、路径边界、通用工具、错误类型 |

### 4.3 The `ui/` directory / `ui/` 目录

The frontend is plain ES modules with no build step; every slice is loaded straight from an HTTP route.

前端是原生 ES module，没有构建步骤，按切片直接从 HTTP 路由加载。

| Path | Notes |
| --- | --- |
| `ui/index.html` | page shell: style links, vendor scripts, module entry |
| `ui/app.js` | application entry and render skeleton, 784 lines (bound by the 800-line rule) |
| `ui/modules/` | **20 module domains**: `state`, `api`, `util`, `icons`, `markdown`, `i18n`, `typing-linger`, `cards`, `usage`, `settings`, `composer`, `tasks`, `modal-layer`, `modal-forms`, `chat`, `solo-archive`, `events-board`, `events-click`, `events-submit`, `events-misc`. Each slice is loaded on its own via the `/api/dsh-team/modules/<file>` route, and cross-slice references always go through explicit `import` |
| `ui/styles/` | **21 style domains**: `base`, `boot`, `frame`, `main`, `buttons`, `surfaces`, `avatars`, `chat`, `chat-cards`, `chat-composer`, `chat-images`, `tasks`, `cards`, `usage`, `settings`, `global-config`, `modal`, `toast`, `a11y`, `wide`, `terminal` |
| `ui/i18n/zh.js`, `ui/i18n/en.js` | interface dictionaries |

| 路径 | 说明 |
| --- | --- |
| `ui/index.html` | 页面壳：样式单 link、vendor 脚本、模块入口 |
| `ui/app.js` | 应用入口与渲染骨架，784 行（受 800 行铁律约束） |
| `ui/modules/` | **20 个模块域**：`state`、`api`、`util`、`icons`、`markdown`、`i18n`、`typing-linger`、`cards`、`usage`、`settings`、`composer`、`tasks`、`modal-layer`、`modal-forms`、`chat`、`solo-archive`、`events-board`、`events-click`、`events-submit`、`events-misc`。每个切片经 `/api/dsh-team/modules/<file>` 路由单独加载，跨切片引用一律走显式 `import` |
| `ui/styles/` | **21 个样式域**：`base`、`boot`、`frame`、`main`、`buttons`、`surfaces`、`avatars`、`chat`、`chat-cards`、`chat-composer`、`chat-images`、`tasks`、`cards`、`usage`、`settings`、`global-config`、`modal`、`toast`、`a11y`、`wide`、`terminal` |
| `ui/i18n/zh.js`、`ui/i18n/en.js` | 界面字典 |

Two hard conventions:

两条硬约定：

1. **Style slices must be registered.** The concatenation order is decided by `UI_STYLE_PARTS` in `src/http.js`, so a new style file must be registered in that table as well; the registration order is the cascade order, and `tests/styles-split.test.js` guards the table's completeness.

   **样式分片必须登记。** 拼接顺序由 `src/http.js` 的 `UI_STYLE_PARTS` 决定，新增样式文件必须同时在表里登记；登记顺序即层叠顺序，登记表的完整性由 `tests/styles-split.test.js` 守门。
2. **The 800-line rule.** Both `ui/styles/*.css` and `ui/app.js` must stay under 800 lines per file; beyond that, split by responsibility into new domain files.

   **800 行铁律。** `ui/styles/*.css` 与 `ui/app.js` 单文件均须 < 800 行，超过就要按职责拆到新域文件。

### 4.4 The WeChat channel / 微信通道

The channel is off by default (`DSH_TEAM_WECHAT=0`) and becomes active after QR authorisation. Its command surface is plain text, and `帮助 / help / ?` pulls it up at any time:

通道默认关闭（`DSH_TEAM_WECHAT=0`），扫码授权后生效。指令面是纯文本，`帮助 / help / ?` 可随时拉取：

| Command | Effect |
| --- | --- |
| `帮助` / `help` / `?` | show the command help |
| `状态` | overview of the projects and the tasks pending review |
| `验收 <task number> [comment]` | accept a delivery, e.g. `验收 web-3 做得好` |
| `驳回 <task number> <reason>` | send it back for rework; the reason is mandatory |
| `详情 <task number>` | show the task card and its latest comments |
| `q` | list the project keys that can be assigned |
| `<key>: <message>` | forward a message into the project chat for the director to arrange, e.g. `web: 上线新版官网` |

| 指令 | 作用 |
| --- | --- |
| `帮助` / `help` / `?` | 查看指令帮助 |
| `状态` | 概览各项目与待验收任务 |
| `验收 <任务号> [评语]` | 通过验收，如 `验收 web-3 做得好` |
| `驳回 <任务号> <理由>` | 退回重做，理由必填 |
| `详情 <任务号>` | 查看任务卡片与最近评论 |
| `q` | 列出可派单的项目 key |
| `<key>: <消息>` | 转发消息到项目群聊由总监安排，如 `web: 上线新版官网` |

Pushes go through a local outbox, and three semantic boundaries directly explain "WeChat missed the push / it was not resent":

推送走本地 outbox，有三条与「微信漏推/不补发」直接相关的语义边界：

- Items that piled up before the channel connection was established (a process restart, or a re-login under a new account) are discarded and never resent; a transient reconnect inside one connection epoch is not a new connection and does not void what is already queued.
- A queued item is attempted at most three times (`OUTBOX_MAX_ATTEMPTS`); past the limit it is discarded for good and never resent, and a non-retryable error is discarded immediately.
- Several pushes in the same round are merged into one send (a 1.5 s batching window, echoing at most the 5 oldest originals); **exactly one item is not merged**.

- 通道连接建立（进程重启或换号重登）之前堆积的待发项一律作废，不补发；同一连接期内的瞬断重连不算新链接，不作废存量。
- 单条待发最多尝试 3 次（`OUTBOX_MAX_ATTEMPTS`），达限即废弃、永不补发；不可重试的错误直接废弃。
- 同一轮多条推送会合并成一次发送（合批窗口 1.5 秒，最多回显最旧 5 条原文）；**恰 1 条时不合并**。

When investigating, look at `outbox.attempts` (the retry counter, persisted, not reset by a restart) and `gave_up_at` (the discard timestamp): a value in either means the item was dropped by design, not by a bug.

排查时先看 `outbox.attempts`（重试计数，持久化，进程重启不归零）与 `gave_up_at`（废弃时间）：这两个字段有值即说明是被设计性丢弃的，不是 bug。

### 4.5 Data and migrations / 数据与迁移

The main database is SQLite, and every schema change goes through the idempotent migrations in `src/db-migrations.js` (`PRAGMA table_info` checks the column first, then adds it), so old databases upgrade in place without a manual rebuild. When you back up, take `secret.key` along.

主库是 SQLite，schema 变更一律走 `src/db-migrations.js` 的幂等迁移（`PRAGMA table_info` 判列后再补），旧库直接升级，不需要手工重建。数据备份请连同 `secret.key` 一起带走。

---

## 5. Testing and Development Conventions / 测试与开发约定

### 5.1 Common commands / 常用命令

```sh
npm test                        # node --test "tests/*.test.js"
npm run dev                     # local preview (fake runtime)
npm run doctor                  # check Node/DSH versions and the writability of the workspace and skill-pool paths
npm run profile:install         # pack and reinstall into a profile (team-bots by default)
npm run verify:agent-team       # verify the Agent Teams layer wiring
npm run backup                  # back up the team data
npm run restore-check           # check that a backup can be restored
npm run load-test               # load test
npm run fault-test              # fault injection
```

### 5.2 Guard tests / 守门测试

`tests/` holds 154 `*.test.js` files. Besides the functional cases, several architectural conventions are pinned down:

`tests/` 下有 154 个 `*.test.js`，除功能用例外还钉住若干架构约定：

- `tests/styles-split.test.js`: `UI_STYLE_PARTS` corresponds one-to-one with the `ui/styles/` directory (no orphans, no missing entries, no duplicates), each file stays under 800 lines, production and preview share the same style summary, and the concatenation has zero drift.
- `tests/code-hygiene.test.js`: the semantics of the code-hygiene line limit (800 by default, the judgement line at limit × 110 %, a limit of 0 disabling it, one alert per violation, and a fresh alert after the file falls back under the limit).
- Cross-slice `import` guards and token-format guards cover the whole `ui/` source tree: a missing import after a slice split leaves the page on the boot screen, so this class of failure has to be caught by the guards in advance.

- `tests/styles-split.test.js`：`UI_STYLE_PARTS` 与 `ui/styles/` 目录一一对应（无孤儿、无缺件、无重复）、单文件 < 800 行、线上与预览共用同一份样式汇总、拼接零漂移。
- `tests/code-hygiene.test.js`：代码卫生的行数约定语义（缺省 800、判定线 = 上限 × 110%、限值 0 关闭、同一超标去重、回落达标后可再告警）。
- 跨切片 `import` 守门与 token-format 守门覆盖整份 `ui/` 源码：切片拆分后漏 import 会让页面停在 boot screen，这类失败必须由守门提前拦下。

### 5.3 Commit conventions / 提交约定

- Every commit bumps the patch digit of `package.json` by one. The hook lives in `.githooks/pre-commit` and runs `scripts/version-bump.mjs`; it is activated by the local git setting `core.hooksPath=.githooks`, so a fresh clone needs `git config core.hooksPath .githooks` once to get the same behaviour. `DSH_SKIP_VERSION_BUMP=1` skips the bump (manual releases, rollback commits). **Take the committed version from `git show HEAD -- package.json`**, not from the file in the working tree.
- Commit messages use Conventional Commits style and carry the card number, e.g. `feat(ui): 全局配置页美术重设计（DSHBOTS-184）`.
- Commit with an exact pathspec (`git commit -- <pathspec>`): only the files inside your own write scope, so in-flight work from other sessions never gets swept in.
- The working tree often carries dirty files from other sessions; check `git status --short` before and after committing.

- 每次提交会把 `package.json` 的 patch 位 +1。钩子放在 `.githooks/pre-commit`，实际执行 `scripts/version-bump.mjs`；它由本地 git 配置 `core.hooksPath=.githooks` 启用，新克隆需执行一次 `git config core.hooksPath .githooks` 才有同样行为。`DSH_SKIP_VERSION_BUMP=1` 可跳过（手工发版、回滚提交等场景）。**提交后的版本号以 `git show HEAD -- package.json` 为准**，不要以工作区文件为准。
- 提交信息用 Conventional Commits 风格并带卡号，例如 `feat(ui): 全局配置页美术重设计（DSHBOTS-184）`。
- 路径精确提交（`git commit -- <pathspec>`），只认自己写范围内的文件，不把工作树里别人的在途改动卷进来。
- 工作区里常有其他会话的脏文件，提交前后用 `git status --short` 核对。

### 5.4 CI / 持续集成

Pushing a `v*` tag triggers the publish workflow (`.github/workflows/publish.yml`): it installs the dependencies, runs the full `npm test`, and only publishes to registry.npmjs.org when everything is green.

push `v*` tag 触发发布工作流（`.github/workflows/publish.yml`）：拉取依赖后跑全量 `npm test`，全绿才 `npm publish` 到 registry.npmjs.org。

---

## 6. Troubleshooting and FAQ / 故障排查与常见问题

**Q: I changed the code but the page is still the old one?**
The plugin files inside a profile are a snapshot and are not hot-reloaded. Reinstall with `npm run profile:install -- --profile <name>`. A page stuck at "connecting to the team space" usually has the same cause (the module slice routes are not installed).

**Q：改了代码，页面还是旧的？**
profile 里的插件文件是快照，不会被自动热更。跑 `npm run profile:install -- --profile <名字>` 重装。页面停在「正在连接团队空间」通常也是这个原因（模块切片路由没装上）。

**Q: Where does the data live, and how do I move it to another machine?**
Under `<DSH_TEAM_DATA>`: `team.sqlite`, `wechat-channel.sqlite`, `secret.key`, `memory/`, `messages/`. Back it up with `npm run backup`, and **do not leave `secret.key` behind** — without it the existing ciphertext can never be decrypted again.

**Q：数据存在哪里？换台机器怎么带走？**
`<DSH_TEAM_DATA>` 目录下是 `team.sqlite`、`wechat-channel.sqlite`、`secret.key`、`memory/`、`messages/`。用 `npm run backup` 备份，**别漏 `secret.key`**——缺了它既有的密文就再也解不开。

**Q: WeChat did not receive the push?**
Look at `outbox.attempts` and `gave_up_at` first: a value means the item was dropped by design (piled up before the connection was established, three attempts exceeded, or a non-retryable error), not that it was missed; no value means it is still in the queue.

**Q：微信没收到推送？**
先看 `outbox.attempts` 与 `gave_up_at`：有值说明是设计性丢弃（连接建立前堆积、重试 3 次超限、不可重试错误），不是漏发；没有值说明还在待发队列里。

**Q: What is the "code hygiene" alert in the project chat?**
At the end of every run the source files in the project workspace are scanned, and a file over the project's line limit (800 by default, judgement line 880) triggers one 【系统指令】 asking the director to schedule a split. Raise the limit in the project settings, or set it to 0 to switch the check off.

**Q：项目群里冒出「代码卫生告警」是什么？**
每轮运行收尾会扫描项目工作区里的源码文件，超过项目约定的单文件行数上限（缺省 800，判定线 880）就发一条【系统指令】要求总监安排拆分卡。把项目设置里的行数约定调大或设为 0 可以关闭。

**Q: What does "planned migration · target page" on the global configuration page mean?**
The functional migration of that module has not landed yet — this is only a visual annotation, so do not read it as "already migrated". Once the migration is done, the module and its annotation will be removed from this page.

**Q：全局配置页上的「计划迁移 · 目标页」是什么意思？**
该模块的功能迁移还没落地，这里只是视觉标注，不要按已迁移理解。迁移完成后本页会删掉对应模块与该标注。

**Q: There is still Chinese after switching to English — is that a bug?**
A known gap. The interface language dropdown itself works, but the card titles and descriptions of the settings page and the global configuration page are still largely hard-coded Chinese; full i18n coverage is not in place yet.

**Q：切 English 之后还有中文，是 bug 吗？**
已知缺口。界面语言下拉本身已生效，但设置页与全局配置页的卡片标题、说明等主体文案仍大量硬编码中文，完整 i18n 尚未覆盖。

**Q: Can it be exposed to the public internet?**
The plugin ships no sandbox: bot sessions run under DSH's `danger-full-access` as the current user and can read and write everything that user can reach; `<workspace>/{project}` is logical isolation, not a strong sandbox. Combined with auto-login on the home page (reaching the port means owner), public exposure requires an HTTPS reverse proxy plus your own authentication, and teams that do not trust each other must not share one DSH instance and workspace.

**Q：能公网开放吗？**
插件不自带沙箱：Bot 会话在 DSH 的 `danger-full-access` 下以当前用户身份执行命令，能读写该用户可达的一切文件；`<工作区>/{project}` 只是逻辑隔离，不是强沙箱。加上首页自动登录（能访问端口即 owner），公网开放必须走 HTTPS 反向代理并自行加鉴权，互不信任的团队不要共用同一个 DSH 实例与工作区。

---

## License

Apache-2.0 — see `LICENSE` and `NOTICE` in the repository root.

Apache-2.0，见仓库根目录的 `LICENSE` 与 `NOTICE`。
