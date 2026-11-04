# DSH Team Bots

DSH 团队 Bots 插件（npm 包名 `dsh-team-bots`）——把一支会协作的 Bot 小队装进同一个工作台：项目群聊、任务看板、写范围并行调度、记忆与技能、用量与成本，外加一条个人微信通道。

本文件是仓库的主文档。仓库根目录的 `README.md` 只保留一行指引，指向这里。

---

## 目录

- [1. 项目简介与定位](#1-项目简介与定位)
- [2. 快速开始](#2-快速开始)
- [3. 功能总览](#3-功能总览)
- [4. 架构与目录说明](#4-架构与目录说明)
- [5. 测试与开发约定](#5-测试与开发约定)
- [6. 故障排查与常见问题](#6-故障排查与常见问题)

---

## 1. 项目简介与定位

`dsh-team-bots` 是一个 DSH（DeepSeek Harness）插件，随 DSH Web 在同一进程内运行，不另起服务。它做的事情是：让多个 Bot 在同一批项目空间里分工协作，并把协作过程暴露成一块可操作的网页工作台。

三个定位要点：

1. **协作发生在项目里，而不是发生在聊天窗口里。** 每个项目有自己的群聊、成员、任务与工作目录；项目总监 Bot 负责在群聊里拆单、派单、验收。
2. **并行靠声明，不靠运气。** 任务可以声明自己要写哪些路径，调度器据此判定同项目的两个写运行能否并行：两侧都声明且路径前缀互不重叠才放行，任一未声明按保守串行处理。
3. **一切可回溯。** 每次运行有轨迹、耗时、token 与成本；Bot 配置有不可变历史可回滚；密钥只以密文落库，使用时物化成一次性明文文件，用完即焚。

仓库自身的形态：`index.js` 是插件装配入口，`src/` 是服务端与调度，`ui/` 是工作台前端，`tests/` 是守门测试，`docs/` 放设计方案、评审记录与截图。

---

## 2. 快速开始

### 2.1 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 22.19（见 `package.json` 的 `engines`） |
| DSH CLI | 已安装，`dsh --version` 可自查 |
| 插件形态 | 随 DSH Web 进程内运行，无独立进程、无独立端口 |

### 2.2 安装到 DSH profile

```sh
cd <repo>
npm pack                                        # 产出 dsh-team-bots-<version>.tgz
dsh plugin --profile <name> add ./dsh-team-bots-<version>.tgz
dsh --profile <name>                             # 从启动日志读取 dsh web 的带 token 入口
```

### 2.3 一键重装（profile 是快照）

```sh
npm run profile:install -- --profile <name>     # 不带 --profile 时装进 team-bots
```

这条命令把当前仓库 `npm pack` 到仓库内 `.dist/`，再用 `dsh plugin add` 重装进目标 profile，并改写该 profile 的 patch 文件触发一次 recomposition——效果等同于重启 DSH，但不用停进程。

**这一点最容易踩坑：profile 里的插件文件是快照，DSH 不会自动加载被替换的文件。** 改完代码后必须重装（`npm run profile:install`），否则线上仍在跑旧代码，页面会停在「正在连接团队空间」。

团队数据与 profile 解耦：数据目录只由 `DSH_TEAM_WORKSPACE` / `DSH_TEAM_DATA` 决定，换 profile 安装或并存多份安装，读写的都是同一份数据。

### 2.4 本地预览

```sh
npm run dev        # http://127.0.0.1:4317，假 runtime，数据写在仓库 .dev/ 下
```

预览服务使用假的 DSH runtime，**没有认证、不动任何 DSH 配置、不能用于生产**。端口可用 `PORT` 覆盖。

### 2.5 数据、密钥与技能放在哪

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

常用变量的模板见仓库根目录 `.env.example`。请用 direnv 或编辑器 dotenv 插件导出，**不要在仓库根目录放 `.env`**——那会把 `DSH_*` 带进 `npm test` 与 `npm run dev`。

### 2.6 访问入口与自动登录

```text
http://<host>:<port>/                     自动登录，直达团队工作台
http://<host>:<port>/api/dsh-team/ui      DSH Team Bots 工作台（直连）
http://<host>:<port>/index.html           DSH 原生 Web 界面
```

首次打开首页会用当前启动 token 兑换一枚 30 天登录 Cookie 并跳转到工作台，无需手动步骤。自动登录意味着**能连上该端口的人即获得 owner 访问权限**，服务只应监听本机或受信任网络；对外提供服务必须走 HTTPS 反向代理并正确转发 Host 与 WebSocket。

### 2.7 常用环境变量

缺省值取自 `src/config.js`（配置解析链路：显式 env > 页面保存值 > 代码缺省）。页面保存值可被同名 env 覆盖。

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

## 3. 功能总览

**项目群聊**：每个项目一间群聊和一位项目总监 Bot。支持普通消息、`@Bot`、`/task @Bot 标题`、`/remember`、`/clear`；输入 `/` 或 `@` 弹出命令、技能与成员补全。群聊只放结论，完整交付进任务评论。

**任务看板**：Linear 风格面板，按状态分组，父子任务树、优先级与负责人、评论直投运行中的会话、拖拽流转；任务详情内联展示交付产物与运行列表。

**写范围并行调度**：任务声明自己要写的路径后，同项目的两个写运行按声明范围判定——范围互不重叠即可并行，重叠或有一方未声明则串行。写运行彼此独立，任务与群聊互不阻塞。

**记忆与技能池**：Bot 级与项目级长期记忆；任务交付后派生一次记忆审查运行（`memory_review` 控制，群聊回复另受 `chat_memory_review` 控制），抽取出的可复用事实进待审队列由人复核。共享技能池固定在 `~/.agents/skills`，项目还能自带技能目录；技能变更走提案审批并保留可回滚快照。

**版本化进化与团队工具**：角色、模型、强度与技能变更走提案审批，Bot 配置保留不可变历史可回滚。插件注册七个团队工具：`team_assign_task`、`team_review_task`、`team_remember`、`team_recall`、`team_propose_evolution`、`team_message_bot`、`team_request_secret`，Bot 之间可直接私信协作。

**密钥管道**：密钥 AES-256-GCM 加密落库；批准后一次性物化到数据目录（**不进项目工作区**），任务运行结束或 TTL 到期即焚；消息与运行输出一律掩码为 `$名称`。

**用量与成本**：全局 / 项目 / Bot 三档口径归集 token、调用次数、成本与运行时长；成本按可配置的模型价格计算，未配置价格的调用不按 0 计费。支持明细导出 CSV 与月度对账。

**审批与提问**：Bot 请求提权或需要人回答问题时，转成工作台里的卡片；审批有等待窗口，超时自动回 rejected；提问到期保留卡片可补答。

**终端**：项目内可交互终端，命令有硬超时，可实时 tail 与取消；历史落库。

**个人微信通道**：扫码授权后把任务动态推到微信，并支持一套纯文本指令面（见 4.4）。

**代码卫生**：项目可约定单文件行数上限（缺省 800 行），每轮运行收尾扫描工作区源码文件，超标即向项目群发一条【系统指令】，要求总监安排拆分卡。

---

## 4. 架构与目录说明

### 4.1 装配链路

`index.js` 的 `apply(ctx, config)` 是唯一入口，顺序即依赖顺序：

```
resolveConfig(config)      → src/config.js      解析 env / 注入配置，得到缺省化后的配置
openDatabase(dbPath)       → src/db.js          打开并迁移 SQLite
new TeamService(...)       → src/service.js     领域门面（方法由 src/services/* 挂载）
new DshRuntime(...)        → src/runtime.js     宿主 runtime 适配（提示词、会话、模型恢复）
installTeamTools(...)      → src/tools.js       注册七个团队工具
installSkillProvider(...)  → src/skills.js      技能池接入
installHttp(...)           → src/http.js        HTTP 路由与 UI 静态切片
```

服务初始化是异步的：`service.initialize()` 完成建库与播种（默认 Bot 与伙伴）后才 `service.start()` 拉起调度器。

### 4.2 `src/` 目录

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
| `src/wechat/` | 微信通道：`channel.js`（连接与推送）、`commands.js`（指令面）、`store.js`（outbox 与状态） |
| `src/secrets.js`、`src/services/secrets.js` | 密钥加密、物化与掩码 |
| `src/pricing.js`、`src/usage.js`、`src/usage-reconcile.js` | 价格表、用量归集与对账 |
| `src/skills.js`、`src/project-skills.js` | 技能池与项目技能扫描 |
| `src/seed-bots.js`、`src/updater.js`、`src/paths.js`、`src/util.js`、`src/errors.js` | 种子 Bot、更新检查、路径边界、通用工具、错误类型 |

### 4.3 `ui/` 目录

前端是原生 ES module，没有构建步骤，按切片直接从 HTTP 路由加载。

| 路径 | 说明 |
| --- | --- |
| `ui/index.html` | 页面壳：样式单 link、vendor 脚本、模块入口 |
| `ui/app.js` | 应用入口与渲染骨架，784 行（受 800 行铁律约束） |
| `ui/modules/` | **20 个模块域**：`state`、`api`、`util`、`icons`、`markdown`、`i18n`、`typing-linger`、`cards`、`usage`、`settings`、`composer`、`tasks`、`modal-layer`、`modal-forms`、`chat`、`solo-archive`、`events-board`、`events-click`、`events-submit`、`events-misc`。每个切片经 `/api/dsh-team/modules/<file>` 路由单独加载，跨切片引用一律走显式 `import` |
| `ui/styles/` | **21 个样式域**：`base`、`boot`、`frame`、`main`、`buttons`、`surfaces`、`avatars`、`chat`、`chat-cards`、`chat-composer`、`chat-images`、`tasks`、`cards`、`usage`、`settings`、`global-config`、`modal`、`toast`、`a11y`、`wide`、`terminal` |
| `ui/i18n/zh.js`、`ui/i18n/en.js` | 界面字典 |

两条硬约定：

1. **样式分片必须登记。** 拼接顺序由 `src/http.js` 的 `UI_STYLE_PARTS` 决定，新增样式文件必须同时在表里登记；登记顺序即层叠顺序，登记表的完整性由 `tests/styles-split.test.js` 守门。
2. **800 行铁律。** `ui/styles/*.css` 与 `ui/app.js` 单文件均须 < 800 行，超过就要按职责拆到新域文件。

### 4.4 微信通道

通道默认关闭（`DSH_TEAM_WECHAT=0`），扫码授权后生效。指令面是纯文本，`帮助 / help / ?` 可随时拉取：

| 指令 | 作用 |
| --- | --- |
| `帮助` / `help` / `?` | 查看指令帮助 |
| `状态` | 概览各项目与待验收任务 |
| `验收 <任务号> [评语]` | 通过验收，如 `验收 web-3 做得好` |
| `驳回 <任务号> <理由>` | 退回重做，理由必填 |
| `详情 <任务号>` | 查看任务卡片与最近评论 |
| `q` | 列出可派单的项目 key |
| `<key>: <消息>` | 转发消息到项目群聊由总监安排，如 `web: 上线新版官网` |

推送走本地 outbox，有三条与「微信漏推/不补发」直接相关的语义边界：

- 通道连接建立（进程重启或换号重登）之前堆积的待发项一律作废，不补发；同一连接期内的瞬断重连不算新链接，不作废存量。
- 单条待发最多尝试 3 次（`OUTBOX_MAX_ATTEMPTS`），达限即废弃、永不补发；不可重试的错误直接废弃。
- 同一轮多条推送会合并成一次发送（合批窗口 1.5 秒，最多回显最旧 5 条原文）；**恰 1 条时不合并**。

排查时先看 `outbox.attempts`（重试计数，持久化，进程重启不归零）与 `gave_up_at`（废弃时间）：这两个字段有值即说明是被设计性丢弃的，不是 bug。

### 4.5 数据与迁移

主库是 SQLite，schema 变更一律走 `src/db-migrations.js` 的幂等迁移（`PRAGMA table_info` 判列后再补），旧库直接升级，不需要手工重建。数据备份请连同 `secret.key` 一起带走。

---

## 5. 测试与开发约定

### 5.1 常用命令

```sh
npm test                        # node --test "tests/*.test.js"
npm run dev                     # 本地预览（假 runtime）
npm run doctor                  # 检查 Node/DSH 版本与工作区、技能池路径的可写性
npm run profile:install         # 打包并重装进 profile（缺省 team-bots）
npm run verify:agent-team       # 校验 Agent Teams 层接线
npm run backup                  # 备份团队数据
npm run restore-check           # 备份可恢复性校验
npm run load-test               # 负载压测
npm run fault-test              # 故障注入
```

### 5.2 守门测试

`tests/` 下有 154 个 `*.test.js`，除功能用例外还钉住若干架构约定：

- `tests/styles-split.test.js`：`UI_STYLE_PARTS` 与 `ui/styles/` 目录一一对应（无孤儿、无缺件、无重复）、单文件 < 800 行、线上与预览共用同一份样式汇总、拼接零漂移。
- `tests/code-hygiene.test.js`：代码卫生的行数约定语义（缺省 800、判定线 = 上限 × 110%、限值 0 关闭、同一超标去重、回落达标后可再告警）。
- 跨切片 `import` 守门与 token-format 守门覆盖整份 `ui/` 源码：切片拆分后漏 import 会让页面停在 boot screen，这类失败必须由守门提前拦下。

### 5.3 提交约定

- 每次提交由 pre-commit 钩子把 `package.json` 的 patch 位 +1（`DSH_SKIP_VERSION_BUMP=1` 可跳过，用于回滚或手工发版）。**提交后的版本号以 `git show HEAD -- package.json` 为准**，不要以工作区文件为准。
- 提交信息用 Conventional Commits 风格并带卡号，例如 `feat(ui): 全局配置页美术重设计（DSHBOTS-184）`。
- 路径精确提交（`git commit -- <pathspec>`），只认自己写范围内的文件，不把工作树里别人的在途改动卷进来。
- 工作区里常有其他会话的脏文件，提交前后用 `git status --short` 核对。

### 5.4 CI

push `v*` tag 触发发布工作流（`.github/workflows/publish.yml`）：拉取依赖后跑全量 `npm test`，全绿才 `npm publish` 到 registry.npmjs.org。

---

## 6. 故障排查与常见问题

**Q：改了代码，页面还是旧的？**
profile 里的插件文件是快照，不会被自动热更。跑 `npm run profile:install -- --profile <名字>` 重装。页面停在「正在连接团队空间」通常也是这个原因（模块切片路由没装上）。

**Q：数据存在哪里？换台机器怎么带走？**
`<DSH_TEAM_DATA>` 目录下是 `team.sqlite`、`wechat-channel.sqlite`、`secret.key`、`memory/`、`messages/`。用 `npm run backup` 备份，**别漏 `secret.key`**——缺了它既有的密文就再也解不开。

**Q：微信没收到推送？**
先看 `outbox.attempts` 与 `gave_up_at`：有值说明是设计性丢弃（连接建立前堆积、重试 3 次超限、不可重试错误），不是漏发；没有值说明还在待发队列里。

**Q：项目群里冒出「代码卫生告警」是什么？**
每轮运行收尾会扫描项目工作区里的源码文件，超过项目约定的单文件行数上限（缺省 800，判定线 880）就发一条【系统指令】要求总监安排拆分卡。把项目设置里的行数约定调大或设为 0 可以关闭。

**Q：全局配置页上的「计划迁移 · 目标页」是什么意思？**
该模块的功能迁移还没落地，这里只是视觉标注，不要按已迁移理解。迁移完成后本页会删掉对应模块与该标注。

**Q：切 English 之后还有中文，是 bug 吗？**
已知缺口。界面语言下拉本身已生效，但设置页与全局配置页的卡片标题、说明等主体文案仍大量硬编码中文，完整 i18n 尚未覆盖。

**Q：能公网开放吗？**
插件不自带沙箱：Bot 会话在 DSH 的 `danger-full-access` 下以当前用户身份执行命令，能读写该用户可达的一切文件；`<工作区>/{project}` 只是逻辑隔离，不是强沙箱。加上首页自动登录（能访问端口即 owner），公网开放必须走 HTTPS 反向代理并自行加鉴权，互不信任的团队不要共用同一个 DSH 实例与工作区。

---

## License

Apache-2.0，见仓库根目录的 `LICENSE` 与 `NOTICE`。
