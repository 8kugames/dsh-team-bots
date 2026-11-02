# DSH Team Bots

DSH Web + 团队 Bots 插件（包名 `dsh-team-bots`），本机随 DSH 运行。提供项目群聊、Linear 风格任务、Bot 长期记忆、共享技能池、版本化进化和全局/项目/Bot 三档用量统计。

所有 Bot 执行统一走 DeepSeek Harness（DSH）Session，不接入 Claude Code、Codex、AutoGen 或其他 agent runtime。

## 功能

- 每个 Bot 独立配置角色、模型、reasoning effort 和长期记忆。
- 首次启动默认出场总监「director」与五个游戏团队伙伴：designer（策划）、programmer（程序）、graphics（图形渲染）、devops（工具链与运维）、artist（美术）（定义见 `src/seed-bots.js`）。
- 每个项目自动创建群聊、总监 Bot、任务编号和独立工作区。
- 群聊支持普通消息、`@Bot`、`/task @Bot 标题`、`/remember 内容` 和 `/clear`（清空本群聊天记录，任务与记忆保留）；输入 `/` 或 `@` 会弹出命令、共享技能与成员的自动补全。
- 任务运行使用独立会话，长任务不会阻塞同一个 Bot 的群聊回复。
- Linear 风格任务面板：状态、优先级、负责人、评论、运行记录、拖拽流转。
- 任务详情面板显示交付产物清单：图片（png/jpg/gif/webp）内联预览、点击新窗口查看，其余文件按路径列出；产物在成功的写运行结束时由项目工作区 `git status` 采集（最多 200 条），SVG 一律以附件下载防脚本注入。
- 总监 Bot 可用 `team_assign_task` 向成员分派或重派任务，用 `team_review_task` 验收交付。
- Bot 可用 `team_remember` 写入记忆，用 `team_propose_evolution` 提交角色/技能提案。
- Bot 之间可用 `team_message_bot` 直接私信协作，回信自动送回发起会话（忙时注入、闲时新轮投递）。
- 每轮任务与群聊回复后自动进行记忆审查，值得留存的结论自动写入记忆（`memory_review` 关闭可停用；群聊审查用 `chat_memory_review` 单独关）。
- 密钥管道：管理页登记的密钥 AES-256-GCM 加密落库、物化为项目 `.team/secrets.env`，Bot 侧 `set -a; . .team/secrets.env` 使用；密钥值在消息、记忆、运行输出、轨迹落库前一律掩码为 `$名称`（名称与 `.team/secrets.env` 里的变量名一致）；Bot 可用 `team_request_secret` 发起待审请求。
- 微信通道（`DSH_TEAM_WECHAT=1` 开启）：设置页扫码绑定个人微信（腾讯 iLink 官方协议，协议实现 vendored 自 `vendor/wechat-ilink`，上游 Tencent/openclaw-weixin MIT），扫码授权成功后自动把授权者绑定为管理员；此后任务完成主动推送，微信内可回复 `状态`、`详情 key-N`、`验收 key-N [评语]`、`驳回 key-N 理由` 管理验收；未连接期间的消息落盘补发。
- 共享技能池固定为本机 `~/.agents/skills`（与用户其他 agent 工具共用同一目录），技能变更需审批；技能可查看全文详情，并可按项目单独关闭（关闭后该项目的补全不再列出，Bot 系统提示会明确禁用清单）；技能池只列出技能根目录里当前存在的技能，文件被移除的技能在重新扫描后自动消失。
- 项目技能池：自动扫描项目目录（项目设了生产目录时以生产目录为准，否则为工作区 `{project-slug}`）的 `.agents/skills`、`.claude/skills`、`.codex/skills` 三个根，按 frontmatter `name` 去重（`.agents` > `.claude` > `.codex`）；这些技能只在当前项目可用，会进入该项目会话的补全与 Bot 系统提示，并优先于同名共享技能；发现结果不写入共享技能池。
- token、调用次数、成本和运行时长按全局、项目、Bot 归集。

## 启动

本插件随 DSH Web 在本机进程内运行。要求 Node 22.19+ 与已安装的 DSH CLI（`dsh --version` 自查）。插件直接安装进指定的 `--profile`（可以是日常 `web` 等任意 profile；profile 不存在时 `dsh plugin` 按模板初始化）：

```sh
cd <repo>
npm pack                                        # 产出 dsh-team-bots-<version>.tgz
dsh plugin --profile <名字> add ./dsh-team-bots-<version>.tgz
dsh --profile <名字>                             # 从启动日志读取 dsh web 的带 token 入口
```

一键刷新（打包到仓库 `.dist/` 并重装进指定 profile，依赖钉在本地 tarball；缺省装 `team-bots`）：`npm run profile:install -- --profile <名字>`，完成后重启 DSH 生效。

无论装进哪个 profile，团队数据都与 profile 解耦：数据目录只由 `DSH_TEAM_WORKSPACE` / `DSH_TEAM_DATA` 决定（缺省 `~/.dsh/workspace/team-bots/.data`），换 profile 安装或并存多份安装读写的都是同一份数据。

项目管理走工作区目录：`DSH_TEAM_WORKSPACE` 指定任意目录，项目、`_the_bots` 单聊区与团队数据（`.data`）都落在它下面；不设置时默认 `~/.dsh/workspace/team-bots/`。共享技能池不随工作区走，固定为本机 `~/.agents/skills`。数据目录还可用 `DSH_TEAM_DATA` 单独指定。常用变量的模板见 `.env.example`——本地按需导出即可，不要在仓库根目录放 `.env`：direnv、编辑器 dotenv 插件或手动 `set -a; . .env` 会把 `DSH_*` 带进本机进程，污染 `npm test` / `npm run dev`。

首次访问 `http://<host>:<port>/` 会自动完成登录并直接进入团队工作台：浏览器首次打开首页时，插件用当前启动 token 兑换一枚 30 天登录 Cookie，随后跳转到 `/api/dsh-team/ui`；此后打开首页同样直达工作台，无需任何手动步骤。禁用 Cookie 的浏览器会陷入重定向循环，此类客户端改用下面的手动 token 入口。

手动入口（无 Cookie 客户端 / API 调试）：从启动日志读取 `dsh web: http://127.0.0.1:<port>/?token=...` 打开。

```text
http://<host>:<port>/                     自动登录，直达团队工作台
http://<host>:<port>/api/dsh-team/ui      DSH Team Bots 团队工作台（直连）
http://<host>:<port>/index.html           DSH 原生 Web 界面
```

工作台与 DSH 原生界面可自由切换：原生界面右下角有「团队工作台」悬浮入口（本插件通过宿主 `webserver/index-inject` 机制注入），工作台侧栏底部与左上角 logo 都提供「DSH 原生界面」入口。

自动登录意味着**能连上这个端口的人即获得 owner 访问**。服务只应监听本机或受信任网络；需要对外提供时走 HTTPS 反向代理并正确转发 Host 与 WebSocket。Host 白名单栅栏（`DSH_TRUSTED_HOST`，DSH 核心 env）对伪造 Host 的请求仍然返回 403。

界面按工作区逻辑组织多项目：左侧树展示「群聊」（每个群聊对应一个项目）与「Bots」两棵列表，底部是总览bots、用量统计与全局配置；选中群聊后，顶部以 tab 切换群聊、任务、成员、技能、记忆、终端、设置等模块，有待人工处理事项（待验收任务、待审提案）的 tab 会亮小红点。用量统计入口按进入时的上下文给口径：群聊=本项目汇总、单聊=该 bot 的项目外汇总，也可切到全局口径。

## UI 开发预览

```sh
npm run dev        # http://127.0.0.1:4317
```

使用假 runtime，不动任何 DSH 配置，数据写在仓库内的 `.dev/`，无认证。改 UI、调 prompt 用它，不要用它跑任务。

## 路径与权限自查

```sh
npm run doctor
```

输出 Node/DSH 版本、`DSH_HOME`、`workspace`、`.data`、共享技能池 `~/.agents` 的类型与实际路径，并标注是否可写；有问题时退出码 1。启动报错先跑它。它还会逐条报告 `~/.dsh/cordis.patch.yml` 里引用的宿主绝对路径是否解析得到（patch 注册的 MCP 能力按本机绝对路径生效，断链会让对应 bundle 每次启动失败）。

## 字体、主题与 DSH 能力

- 字体默认使用本地打包的 Inter，中文回退到 PingFang SC / Microsoft YaHei。
- 界面采用 DS Bot 风格的极简平面层级，跟随系统明暗模式。
- 顶栏 `Aa` 或左侧「全局配置」可调整字号（100%–140%），保存在浏览器本地。
- 每个 Bot 是 DSH 原生 Session；角色作为 system prompt section 注入，不替换 DSH prompt。
- 模型、reasoning effort、Tools、插件、MCP、Skill 注册表、文件工具、流式事件和登录态全部继承 DSH。
- 本插件只额外注册 `team_assign_task`、`team_review_task`、`team_remember`、`team_recall`、`team_propose_evolution`、`team_message_bot`、`team_request_secret` 七个团队工具，并将 `~/.agents` 注册为 Skill Provider。
- 全局配置来自本机 `~/.dsh`；插件装在你指定的 `~/.dsh/profiles/<名字>`（缺省 `team-bots`），数据不随 profile 走。

## 目录

```text
~/.dsh/
  cordis.patch.yml           全局 provider / 插件配置
  profiles/<名字>/           安装了本插件的 DSH profile（缺省 team-bots，可装多份共享同一数据）
  sessions/                  DSH 原生会话
  workspace/team-bots/       默认团队工作区（DSH_TEAM_WORKSPACE 可指向别处）
    .data/                   团队 SQLite、运行记录、记忆镜像
    _the_bots/{bot}/         各 Bot 的单聊专属工作区
    {project-slug}/          各项目管理目录（无外部生产目录时兼作项目技能池位置）
```

新建项目时可指定**生产目录**（绝对路径，可指向既有代码库等本机目录）：Bot 会话的工作目录、项目技能池、`.team/secrets.env` 物化与运行产物清单都跟随生产目录。界面上可手输路径，也可点「选择」逐级浏览本机目录。未指定时生产目录就是 `<工作区>/{project-slug}`，行为不变。

所有可变团队数据都在工作区的 `.data`，不依赖仓库目录；DSH 全局配置与会话在本机 `~/.dsh`。备份必须同时包含 `~/.dsh`（profile、sessions）、整个工作区目录（含 `.data/secret.key`）、共享技能池 `~/.agents` 以及各项目的外部生产目录。

## 群聊和任务

- 普通消息由项目总监 Bot 响应。
- `@Builder 看一下这个问题` 直接调用 Builder，不额外唤醒总监。
- `/task @Builder 实现登录页` 创建 `KEY-1` 任务并立即排队。
- `/remember 发布必须先通过回归测试` 写入项目记忆。
- `/clear` 清空本群聊天记录（发送前会弹确认；任务、记忆不受影响，操作进审计日志）。
- 输入框补全：输入 `/` 列出命令与共享技能（全量展示、弹层内滚动），输入 `@` 列出项目成员；↑↓ 选择、Enter 或 Tab 插入，Esc 关闭。项目内已关闭的技能不会出现在补全里。
- 任务完成后进入 `in_review`。用户派单的任务由用户验收；总监 Bot 通过 `team_assign_task` 派单的任务自动转总监 Bot 用 `team_review_task` 验收，验收不通过可退回重做。
- 任务执行失败置 `blocked`，自动转总监 Bot 处理：可用 `team_assign_task` 重派（含换人），需要用户决策时提请用户介入。
- 总监 Bot 通过 `team_assign_task` 分派，任务和运行都可在面板追踪。
- 任务运行期间在面板追加的评论会直投给正在执行的会话，Bot 在当轮按新信息调整；没有运行中的任务时，评论只落库并进入下一次运行的上下文。

## 单聊（项目外）

每个 Bot 一个独立的 1V1 对话窗口，与项目完全解耦：左侧 Bots 树点击 Bot 即打开它的对话窗口（当前对象在树上高亮，Bots 页的「单聊」按钮同样直达）。窗口本身就是会话——不依赖、也不显示任何项目上下文，标题与眉题只属于这个 Bot。

单聊有自己的顶部导航：**对话 / 配置 / 技能 / 记忆 / 进化 / 用量**（与群聊上下文的 群聊/任务/… tab 集互不混用）。配置收拢在独立的 **配置页**：名称/角色/模型/强度/颜色/角色指令一页改完（右上角「保存配置」生成新版本），右侧栏集中运行统计、专属工作区路径与版本历史回滚。技能/记忆/进化/用量在单聊上下文一律呈现团队全局口径——不带任何项目的开关或筛选，记忆页只显示 团队 + 当前 Bot 自己的记忆，用量页的「本项目」口径不可选：

- 单聊会话运行在 Bot 自己的专属工作区 `_the_bots/{bot}`（目录在启动和建 Bot 时自动创建，命名取自 Bot 名的 slug）。
- 没有 项目/任务 上下文：`team_assign_task`、`team_review_task` 不可用，`team_remember` 只能写 bot/team 范围记忆。
- `/clear` 清空与该 Bot 的单聊记录；`/remember 内容` 直接写一条该 Bot 的记忆。
- 调度上单聊是写运行但独立于项目写锁：不同 Bot 的单聊互相并行，同一 Bot 的单聊与群聊回复串行（共用会话串行键），任务运行不受影响；用量只计入全局预算。
- 消息保留随全局 `retention_message_days` 一并清理。

## 会话与并发

每个 Bot 在项目中有一对会话：**项目会话**负责群聊回复、验收和受阻处理，**任务会话**按任务独立创建。因此同一个 Bot 在跑任务时仍能回群聊，多个任务也不会互相污染上下文。

调度器按两条规则领取排队中的运行：

| 规则     | 行为                                                                                       |
| -------- | ------------------------------------------------------------------------------------------ |
| 会话串行 | 同一条会话上的运行永远串行；任务运行独占自己的会话，所以任务之间、任务与群聊之间可以并行   |
| 项目写锁 | 同一项目共享一个工作目录，所以同一项目同时只允许一个**写**运行；群聊、验收等只读运行不受限 |

`DSH_TEAM_MAX_RUNS` 是全局并发上限，跨项目生效。运行结束后任务会话保留，退回重做和重试会复用同一会话继续上下文。

### Bot 私信（team_message_bot）

同项目成员之间点对点通信，`request_id` 具名幂等——同名重发不重复执行，只返回当前状态。回信投递分两路：发起会话正忙（任务运行中）时直接 steer 注入当前轮；空闲时排一轮 `dm_reply` 只读运行送达，若发起方的任务会话已经滚动，投递靠 `origin_task_id` 找到当前绑定。私信与回信在群聊面板的「Bot 私信」区可见，不进群聊消息流。

## 密钥管道

- 设置页登记密钥（`team` 全团队或 `project` 单项目），值 AES-256-GCM 加密落库，密钥文件 `data/secret.key`（0600）；也可用 `DSH_TEAM_SECRET_KEY` 提供主密钥（64 位十六进制），两者不同时生效，以环境变量为准。
- 写入/删除后自动物化到目标项目工作区 `.team/secrets.env`（0600，`.team/` 已进 .gitignore）；Bot 在 shell 里 `set -a; . .team/secrets.env` 后以 `$名称` 使用。
- 值永不回显：管理页只显示指纹（sha256 前 8 位）；消息、运行输出、记忆、轨迹落库前把已知密钥值替换为 `$名称` 掩码。
- 主密钥指纹登记在库的 settings 里，启动时比对：库里已有密文而密钥对不上直接拒绝启动，不会静默换一把新密钥写坏既有密文。`data/secret.key` 必须与 `team.sqlite` 一起备份（`npm run backup` 会一并带走它和 `wechat-channel.sqlite`）。
- Bot 用 `team_request_secret` 发起请求（附理由），群里出系统卡片，设置页批准（写入值并物化）或拒绝。
- Bot 以当前用户身份运行（见「安全边界」），密钥物化与掩码照常生效。

## 限额与看门狗

| 环境变量                    | 默认   | 作用                                    |
| --------------------------- | ------ | --------------------------------------- |
| `DSH_TEAM_MAX_RUNS`         | 3      | 全局并发运行上限                        |
| `DSH_TEAM_RUN_TIMEOUT_MS`   | 900000 | 单个运行的硬超时                        |
| `DSH_TEAM_MAX_RUN_TOKENS`   | 0      | 单运行 token 上限，超出即中止（0 关闭） |
| `DSH_TEAM_STALL_TIMEOUT_MS` | 600000 | 运行多久没有新事件就判定卡住并回收      |
| `DSH_TEAM_CHAT_MAX_CHARS`   | 800    | 群聊消息保留的结论长度                  |

运行超时、超预算、卡住都会走同一条失败链路：运行标记失败、任务置 `blocked`、总监 Bot 接手。

## 原生 Agent Teams 开关

`DSH_TEAM_AGENT_TEAM`（默认 0）控制插件侧是否启用原生团队层。启用前需先给所用 profile 安装配套包 `@deepseek-ai/dsh-experimental-agent-team-profile@<DSH 版本>` 并挂入 profile bundle；插件侧只控制提示词与调度。要开团队层，启动前导出 `DSH_TEAM_AGENT_TEAM=1`。

- `1`：每个任务会话可以把任务拆成具名 teammate 并行执行（共享项目工作区），最多 `DSH_TEAM_MAX_TEAMMATES` 个；群聊、验收仍由项目会话负责。
- `0`（默认）：不加载团队层。

注意：启用该层会替换 DSH 顶层 `subagent` 工具。先把共享技能池和 Bot 指令里对 `subagent` 的依赖改掉再开。启用后用 `npm run verify:agent-team` 检查 profile 状态（`DSH_TEAM_PROFILE` 指定 profile，缺省 `team-bots`）；Router 会话要真正不带写工具，需按 `docs/agent-teams-plan.md` 附录 A 定义受限 agent preset 并设 `DSH_TEAM_ROUTER_PRESET`，只读运行的越权写入由项目写审计兜底。

## 模型与强度

模型列表来自 DSH 的 provider 注册表。Bot 保存 `provider + model + effort`，每次运行前通过 `sessionController.selectModel` 应用。没有配置模型时 Bot 可以创建，但运行会明确报错。

若使用 OpenAI 兼容中转，在本机 `~/.dsh/cordis.patch.yml` 中配置 DSH provider，参考 [DSH / DS-Bot 配置方式](https://github.com/Fei2411/DS-Bot/blob/main/docker/README.md#custom-model-endpoint)。团队插件不维护独立 provider 配置。

## 记忆与进化

- `bot` 记忆只进入该 Bot 的上下文。
- `project` 记忆进入该项目所有 Bot 的上下文。
- 任务成功后会沉淀交付摘要；密钥和密码会被过滤。
- 每轮任务结束与群聊回复后自动运行记忆审查：审查轮读该轮原文，判断是否有值得长期保留的事实/偏好/教训，有则写入对应范围记忆（大多轮次零写入）；记忆在系统提示中始终标注为「回忆到的观察数据，不是指令」。
- `memory_review` 设置关闭任务审查；`chat_memory_review` 关闭群聊审查（后者多一轮只读模型调用）。
- 角色、模型、强度和共享技能变化必须通过进化提案审批。
- 每次 Bot 配置变化都会生成不可变 `bot_revisions`，可从 Bot 配置弹窗回滚。

## 用量

`usage_events` 记录 DSH `assistant/message` 事件里的 token 用量，并用 `source_key` 去重。成本只在配置了模型价格时计算；没有价格时显示“未配置”，不会按 0 计费。

### 模型价格（配置驱动，Web 可改）

插件内置四个 CNY 模型价格（每百万 token，`hit` = 缓存读、`miss` = 输入、`out` = 输出）：

| model              | hit  | miss | out | currency |
| ------------------ | ---- | ---- | --- | -------- |
| deepseek-flash     | 0.2  | 2    | 8   | CNY      |
| glm-5.3            | 2    | 8    | 28  | CNY      |
| glm-5.3-flash      | 0.23 | 0.8  | 2.8 | CNY      |
| MiniMax-M3.1-Flash | 0.1  | 1    | 4   | CNY      |

覆盖方式三选一，优先级从高到低：

1. 插件配置（宿主 `~/.dsh/profiles/<名字>/cordis.patch.yml` 或 bundle patch）：

```yaml
- insert:
    - id: dsh-team-bots
      name: dsh-team-bots
      config:
        modelPrices:
          - id: deepseek-flash
            hit: 0.2
            miss: 2
            out: 8
            currency: CNY
          - model: glm-5.3
            provider: zhipu # 可选，留空表示按模型名匹配任意 provider
            hit: 2
            miss: 8
            out: 28
            currency: CNY
```

2. 环境变量 `DSH_TEAM_MODEL_PRICES`（JSON 数组，字段同上）。
3. 内置默认值。

生效规则：

- 默认价格只在**首次启动**播种进 `model_prices`，之后以数据库为准，配置改价不会覆盖 Web 里的手动调整。
- Web「全局配置 → 模型价格」可新增、编辑单条价格，或点「默认」把某条恢复成配置值（写入新版本，保留历史）。
- 匹配顺序：精确 `provider + model` → 通配 `provider = ''`（按模型名匹配任意 provider）→ 忽略大小写。
- 币种随价格记录；`CNY` 用 ¥ 显示。不同币种的价格混在一起汇总时不做汇率换算。

输入、输出、缓存读写都按每百万 token 计价。

限制：不做按 Bot 的 CPU/内存归因，只归因 token、成本、调用次数和运行时长。

## 安全边界

- 本插件不自带沙箱：Bot 会话在 DSH 的 `danger-full-access` 下以当前用户身份执行任意命令，能读写该用户可达的一切文件；`~/.dsh/cordis.patch.yml` 注册的 MCP 能力也按本机路径直接生效，其登录态与缓存同样暴露给 Bot。
- `<工作区>/{project}` 只是逻辑隔离，不是强沙箱；互不信任的团队不要共用同一个 DSH 实例与工作区。
- 生产必须通过 HTTPS 反向代理，并正确转发 Host 和 WebSocket。
- 群聊、自动记忆和任务会产生模型调用，请设置项目预算和并发上限。

## 开发

```sh
node --test "tests/*.test.js"
node scripts/dev-server.js
# 打开 http://127.0.0.1:4317
```

开发预览使用假 DSH runtime，无认证，不能用于生产。

## DSH 版本与升级

运行中可在「全局配置 → DSH 运行时」查看当前版本，并查询 npm 上最新非 alpha 版本（registry 可用 `NPM_REGISTRY` 覆盖）。查询失败时报 `DSH_REGISTRY_UNAVAILABLE`，不影响运行。

不支持热升级/热重启：发起升级或重启会直接返回 409 `DSH_HOT_UPGRADE_UNSUPPORTED`，页面提示手动升级。实际升级步骤：

1. 确认没有排队/运行中的任务。
2. 手动安装目标版本：`npm install -g @deepseek-ai/dsh@<version>`。
3. 以相同 profile 重启 DSH，回到「DSH 运行时」确认版本已更新。

## 故障排查

**`mkdir: cannot create directory '~/.agents': Too many levels of symbolic links`**

本机 `~/.agents` 或工作区里的 `.data` 是自引用/断链符号链接（同步盘、手工 `ln -s`、半恢复的备份都可能造成），`mkdir -p` 直接以 ELOOP 退出。插件启动时会先探测：

- 链接能解析到真实目录：保留，不动。
- 链接断链、自引用：打印一行说明后替换成真实目录。
- 目标存在但不是目录：报错退出，不会静默覆盖。

`ensureSkillRoot`（`src/paths.js`）同样处理；技能池固定在本机 `~/.agents`，指向别处的有效链接会原样保留并按解析后的目标使用。

**工作区不可写**

Bot 与服务以当前用户运行，工作区目录属主必须可写。用 `npm run doctor` 逐项检查 `workspace`、`.data`、`~/.agents` 的实际路径与可写性。

## 基线

- DSH：本机安装的版本；最新版检查见「全局配置 → DSH 运行时」。
- 架构参考：[DS-Bot](https://github.com/Fei2411/DS-Bot)、[Cindy](https://github.com/makecindy/cindy)
- License: Apache-2.0，见 `LICENSE` 和 `NOTICE`
