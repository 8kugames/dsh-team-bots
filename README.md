# DSH Team Bots

运行在 Docker 中的 DSH Web + 团队 Bots 插件（包名 `dsh-team-bots`）。提供项目群聊、Linear 风格任务、Bot 长期记忆、共享技能池、版本化进化和全局/项目/Bot 三档用量统计。

所有 Bot 执行统一走 DeepSeek Harness（DSH）Session，不接入 Claude Code、Codex、AutoGen 或其他 agent runtime。

## 功能

- 每个 Bot 独立配置角色、模型、reasoning effort 和长期记忆。
- 首次启动默认出场负责人「chief」与五个游戏团队伙伴：designer、programmer、graphics-rendering、devops、artist（定义见 `src/seed-bots.js`）。
- 每个项目自动创建群聊、负责人 Bot、任务编号和独立工作区。
- 群聊支持普通消息、`@Bot`、`/task @Bot 标题`、`/remember 内容` 和 `/clear`（清空本群聊天记录，任务与记忆保留）；输入 `/` 或 `@` 会弹出命令、共享技能与成员的自动补全。
- 任务运行使用独立会话，长任务不会阻塞同一个 Bot 的群聊回复。
- Linear 风格任务面板：状态、优先级、负责人、评论、运行记录、拖拽流转。
- 任务详情面板显示交付产物清单：图片（png/jpg/gif/webp）内联预览、点击新窗口查看，其余文件按路径列出；产物在成功的写运行结束时由项目工作区 `git status` 采集（最多 200 条），SVG 一律以附件下载防脚本注入。
- 负责人 Bot 可用 `team_assign_task` 向成员分派或重派任务，用 `team_review_task` 验收交付。
- Bot 可用 `team_remember` 写入记忆，用 `team_propose_evolution` 提交角色/技能提案。
- Bot 之间可用 `team_message_bot` 直接私信协作，回信自动送回发起会话（忙时注入、闲时新轮投递）。
- 会话上下文由内置 steward 接管：占用达到窗口阈值时自动总结滚动到新会话，checkpoint 播种给下一轮，长任务不再被截断。
- 每轮任务与群聊回复后自动进行记忆审查，值得留存的结论自动写入记忆（`memory_review` 关闭可停用；群聊审查用 `chat_memory_review` 单独关）。
- 密钥管道：管理页登记的密钥 AES-256-GCM 加密落库、物化为项目 `.team/secrets.env`，Bot 侧 `set -a; . .team/secrets.env` 使用；密钥值在消息、记忆、运行输出落库前一律掩码为 `$DSH_SECRET_名称`；Bot 可用 `team_request_secret` 发起待审请求。
- 微信通道（`DSH_TEAM_WECHAT=1` 开启）：设置页扫码绑定个人微信（腾讯 iLink 官方协议，协议实现 vendored 自 `vendor/wechat-ilink`，上游 Tencent/openclaw-weixin MIT），在微信里对 ClawBot 说「绑定」成为管理员；此后任务完成主动推送，微信内可回复 `状态`、`详情 key-N`、`验收 key-N [评语]`、`驳回 key-N 理由` 管理验收；未连接期间的消息落盘补发。
- 共享技能池固定为 `/workspace/.agents/skills`，技能变更需审批；技能可查看全文详情，并可按项目单独关闭（关闭后该项目的补全不再列出，Bot 系统提示会明确禁用清单）；技能池只列出技能根目录里当前存在的技能，文件被移除的技能在重新扫描后自动消失。
- 项目技能池：自动扫描当前项目工作区的 `.agents/skills`、`.claude/skills`、`.codex/skills` 三个根，按 frontmatter `name` 去重（`.agents` > `.claude` > `.codex`）；这些技能只在当前项目可用，会进入该项目会话的补全与 Bot 系统提示，并优先于同名共享技能；发现结果不写入共享技能池。
- token、调用次数、成本和运行时长按全局、项目、Bot 归集。

## Docker 启动

要求 Docker 24+、Compose v2.24+。容器挂载宿主机的 `~/.dsh`，因此全局 provider、插件、凭据和 DSH 配置全部继承；本插件只使用独立的 `~/.dsh/profiles/team-bots` profile。

栈配置放在仓库外：`cp .env.example ~/.dsh/team-bots.env`（用 `DSH_TEAM_ENV_FILE` 可指向任意路径）。不要在项目根目录放 `.env`：compose 会自动加载它，direnv、编辑器 dotenv 插件或手动 `set -a; . .env` 还会把 `DSH_*` 带进本机进程，污染 `npm test` / `npm run dev`。文件可选，不创建则全部走 `docker-compose.yml` 里的默认值。

```sh
cp .env.example ~/.dsh/team-bots.env
# 填写 DEEPSEEK_API_KEY；把实际访问域名/IP 加入 DSH_TRUSTED_HOST
# Linux 下把 PUID/PGID 改成 ~/.dsh 和 workspace 的属主
npm run docker:up   # 扫描宿主能力后以 --env-file 启动（见下方宿主能力桥，推荐）
docker compose --env-file ~/.dsh/team-bots.env -f docker-compose.yml -f docker-compose.host-caps.yml logs -f dsh-team
```

Docker Compose 把 `${HOME}/.dsh` 挂到容器 `/home/node/.dsh`。若宿主没有 `profiles/team-bots`，入口脚本会从镜像模板初始化；不会覆盖宿主其他 profile 或全局配置。

### 宿主能力桥

宿主 `~/.dsh/cordis.patch.yml` 与当前 profile（`DSH_TEAM_PROFILE`，默认 `team-bots`；不复用宿主全局的 `DSH_PROFILE`，避免 shell 环境把容器带到别的 profile）的 patch 会以宿主绝对路径注册能力（例如 TapTap Maker MCP 的 `~/.taptap-maker/mcp-runtime/<ver>/dist/maker.js`）。`npm run docker:up` 在启动前自动扫描这些引用，推导挂载根并生成 `docker-compose.host-caps.yml`（已 gitignore，幂等再生），把每个能力**按原路径**挂进容器——注册引用逐字生效，宿主升级版本号后容器自动跟随：

- home 内的能力树挂两条：原路径（注册里的绝对路径原样解析）+ `/home/node/<目录>`（供运行时以 `os.homedir()` 定位数据与凭据），默认可写（能力树通常带需刷新的登录态）；
- home 外的目录挂原路径、只读；容器镜像自有的目录（`/usr`、`/opt` 等）永不被遮蔽，深层路径（如 npm 全局包所在）可正常挂载。

接入新的宿主能力只需在宿主 patch 里注册，再跑一次 `npm run docker:up`——无需手改任何 YAML。`npm run doctor`（本地与容器内均可）逐条报告引用解析结果，缺失项提示重新生成桥。macOS 上 Docker Desktop 的 File Sharing 默认不含 `/Applications` 等路径：生成器会警告，要么在 Docker 设置中添加该路径，要么移除该引用，否则容器无法启动。

访问 `http://<host>:13080/` 会自动完成登录并直接进入团队工作台：浏览器首次打开首页时，插件用当前启动 token 兑换一枚 30 天登录 Cookie，随后跳转到 `/api/dsh-team/ui`；此后打开首页同样直达工作台，无需任何手动步骤。禁用 Cookie 的浏览器会陷入重定向循环，此类客户端改用下面的手动 token 入口。

手动入口（无 Cookie 客户端 / API 调试）：从日志读取 `dsh web: http://127.0.0.1:3080/?token=...`，把容器内 `3080` 换成宿主机端口 `13080` 打开。

```text
http://<host>:13080/                    自动登录，直达团队工作台
http://<host>:13080/api/dsh-team/ui     DSH Team Bots 团队工作台（直连）
```

自动登录意味着**能连上这个端口的人即获得 owner 访问**。默认端口绑定 `0.0.0.0`，局域网内可达即等于授权；需要收紧时用防火墙或把 `DSH_TEAM_PORT` 发布改为 `127.0.0.1:13080:3080`。Host 白名单栅栏（`DSH_TRUSTED_HOST`）对伪造 Host 的请求仍然返回 403。

界面按工作区逻辑组织多项目：左侧树展示「群聊」（每个群聊对应一个项目）与「Bots」两棵列表，底部是全局配置；选中群聊后，顶部以 tab 切换群聊、任务、Bots、技能、记忆、进化、用量、设置八个模块，有待人工处理事项（待验收任务、待审提案）的 tab 会亮小红点。

## 本地运行（不用 Docker）

Docker 在这里只做一件事——**当沙箱**。Bot 运行在 DSH 的 `danger-full-access` 下，能执行任意命令；容器把它关在可随意丢弃的文件系统里，直接在宿主机跑，等于把你账户的全部权限交给自动执行的 Bot。**改 UI、调 prompt 用本地，真正跑任务用容器。**

### 模式 A：本机真实 DSH（有完整能力，没有沙箱）

本机已可检测到 DSH CLI（`dsh --version`）。把插件装进同一个 `team-bots` profile 即可，UI 路由与容器内完全一致：

```sh
cd <repo>
npm pack                                        # 产出 dsh-team-bots-<version>.tgz
dsh plugin --profile team-bots add ./dsh-team-bots-<version>.tgz
DSH_TEAM_WORKSPACE=$HOME/workspace \
DSH_TEAM_DATA=$HOME/workspace/.data \
  dsh --profile team-bots
# 打开 http://127.0.0.1:<port>/api/dsh-team/ui
```

路径解析规则：`DSH_TEAM_WORKSPACE` > 容器内 `/workspace`（存在时）> `~/workspace`。**本机不会去创建根目录下的 `/workspace`**。数据目录默认落在工作区下的 `.data`。

风险要自己承担：Bot 用你的 uid 运行，读写你的 `~/.ssh`、`~/.aws` 和任何其他目录；只建议用于 UI 验证和单次调试。

### 模式 B：纯 UI 开发预览

```sh
npm run dev        # http://127.0.0.1:4317
```

使用假 runtime，不动任何 DSH 配置，数据写在仓库内的 `.dev/`，无认证。改 UI 用它，不要用它跑任务。

### 路径与权限自查

```sh
npm run doctor                                   # 本机
docker compose exec dsh-team node /home/node/.dsh/profiles/team-bots/node_modules/dsh-team-bots/scripts/doctor.mjs
```

输出 Node/DSH 版本、是否判定为容器环境、`DSH_HOME`、`workspace`、`.data`、`.agents` 的类型与实际路径，并标注是否可写；有问题时退出码 1。启动报错先跑它。

## 字体、主题与 DSH 能力

- 字体默认使用本地打包的 Inter，中文回退到 PingFang SC / Microsoft YaHei。
- 界面采用 DS Bot 风格的极简平面层级，跟随系统明暗模式。
- 顶栏 `Aa` 或左侧「全局配置」可调整字号（100%–140%），保存在浏览器本地。
- 每个 Bot 是 DSH 原生 Session；角色作为 system prompt section 注入，不替换 DSH prompt。
- 模型、reasoning effort、Tools、插件、MCP、Skill 注册表、文件工具、流式事件和登录态全部继承 DSH。
- 本插件只额外注册 `team_assign_task`、`team_review_task`、`team_remember`、`team_propose_evolution`、`team_recall`，并将 `/workspace/.agents` 注册为 Skill Provider。
- 全局配置来自宿主机 `~/.dsh`，插件 profile 固定为 `~/.dsh/profiles/team-bots`。

## 目录

```text
~/.dsh/                      -> /home/node/.dsh（宿主机挂载）
  cordis.patch.yml           -> 宿主机全局 provider / 插件配置
  profiles/team-bots/        -> DSH Team Bots 插件的 DSH profile
  sessions/                  -> DSH 原生会话
WORKSPACE_HOST_DIR/          -> /workspace
  .agents/skills/            -> 共享技能池
  .data/                     -> 团队 SQLite、运行记录、记忆镜像
  _the_bots/{bot}/           -> 各 Bot 的单聊专属工作区
  {project-slug}/            -> 各项目工作区
```

所有可变团队数据都在 `/workspace/.data`，不依赖宿主 `/data` 卷；DSH 全局配置与会话仍在宿主 `~/.dsh`。备份必须包含宿主机 `~/.dsh` 和 `/workspace`。不要挂载宿主机根目录或 Docker socket。

## 群聊和任务

- 普通消息由项目负责人 Bot 响应。
- `@Builder 看一下这个问题` 直接调用 Builder，不额外唤醒负责人。
- `/task @Builder 实现登录页` 创建 `KEY-1` 任务并立即排队。
- `/remember 发布必须先通过回归测试` 写入项目记忆。
- `/clear` 清空本群聊天记录（发送前会弹确认；任务、记忆不受影响，操作进审计日志）。
- 输入框补全：输入 `/` 列出命令与共享技能（全量展示、弹层内滚动），输入 `@` 列出项目成员；↑↓ 选择、Enter 或 Tab 插入，Esc 关闭。项目内已关闭的技能不会出现在补全里。
- 任务完成后进入 `in_review`。用户派单的任务由用户验收；负责人 Bot 通过 `team_assign_task` 派单的任务自动转负责人 Bot 用 `team_review_task` 验收，验收不通过可退回重做。
- 任务执行失败置 `blocked`，自动转负责人 Bot 处理：可用 `team_assign_task` 重派（含换人），需要用户决策时提请用户介入。
- 负责人 Bot 通过 `team_assign_task` 分派，任务和运行都可在面板追踪。
- 任务运行期间在面板追加的评论会直投给正在执行的会话，Bot 在当轮按新信息调整；没有运行中的任务时，评论只落库并进入下一次运行的上下文。

## 单聊（项目外）

聊天页顶部可在 **群聊 / 单聊** 之间切换，Bots 页每张卡片的「单聊」按钮直达对应会话。每个 Bot 一条独立单聊线程，不挂任何项目：

- 单聊会话运行在 Bot 自己的专属工作区 `_the_bots/{bot}`（目录在启动和建 Bot 时自动创建，命名取自 Bot 名的 slug）。
- 没有 项目/任务 上下文：`team_assign_task`、`team_review_task` 不可用，`team_remember` 只能写 bot/team 范围记忆。
- `/clear` 清空与该 Bot 的单聊记录；`/remember 内容` 直接写一条该 Bot 的记忆。
- 调度上单聊是写运行但独立于项目写锁：不同 Bot 的单聊互相并行，同一 Bot 的单聊与群聊回复串行（共用会话串行键），任务运行不受影响；用量只计入全局预算。
- 消息保留随全局 `retention_message_days` 一并清理。

## 会话与并发

每个 Bot 在项目中有一对会话：**项目会话**负责群聊回复、验收和受阻处理，**任务会话**按任务独立创建。因此同一个 Bot 在跑任务时仍能回群聊，多个任务也不会互相污染上下文。

调度器按两条规则领取排队中的运行：

| 规则 | 行为 |
| --- | --- |
| 会话串行 | 同一条会话上的运行永远串行；任务运行独占自己的会话，所以任务之间、任务与群聊之间可以并行 |
| 项目写锁 | 同一项目共享一个工作目录，所以同一项目同时只允许一个**写**运行；群聊、验收等只读运行不受限 |

`DSH_TEAM_MAX_RUNS` 是全局并发上限，跨项目生效。运行结束后任务会话保留，退回重做和重试会复用同一会话继续上下文。

### 上下文滚动（steward 接管）

每条会话的上下文占用（输入 + 缓存读 + 缓存写 token）随用量事件实时记账。占用达到窗口检查线（默认 `(window − reserve) × 0.8`，reserve 取模型 maxTokens，至少保住窗口一半）时，下一个运行让位给 steward 总结：旧会话按固定五节模板（工作现状 / 逐条结果 / 决策与理由 / 依赖约束 / 未完成请求原话）自总结产出 checkpoint，随后旧绑定删除、新会话在下一个运行自动播种 checkpoint 开工。总结失败时降级为无摘要换新会话（继续逼近上限的代价更大）。原会话若在此期间被重试/重派复用，checkpoint 一样会播种进新会话。

### Bot 私信（team_message_bot）

同项目成员之间点对点通信，`request_id` 具名幂等——同名重发不重复执行，只返回当前状态。回信投递分两路：发起会话正忙（任务运行中）时直接 steer 注入当前轮；空闲时排一轮 `dm_reply` 只读运行送达，若发起方的任务会话已经滚动，投递靠 `origin_task_id` 找到当前绑定。私信与回信在群聊面板的「Bot 私信」区可见，不进群聊消息流。

## 密钥管道

- 设置页登记密钥（`team` 全团队或 `project` 单项目），值 AES-256-GCM 加密落库，密钥文件 `data/secret.key`（0600）。
- 写入/删除后自动物化到目标项目工作区 `.team/secrets.env`（0600，`.team/` 已进 .gitignore）；Bot 在 shell 里 `set -a; . .team/secrets.env` 后以 `$DSH_SECRET_名称` 使用。
- 值永不回显：管理页只显示指纹（sha256 前 8 位）；消息、运行输出、记忆落库前把已知密钥值替换为 `$DSH_SECRET_名称` 掩码。
- Bot 用 `team_request_secret` 发起请求（附理由），群里出系统卡片，设置页批准（写入值并物化）或拒绝。
- 容器内全员 `danger-full-access` 保持不变：安全边界仍是容器（见「安全边界」）。

## 限额与看门狗

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_TEAM_MAX_RUNS` | 3 | 全局并发运行上限 |
| `DSH_TEAM_RUN_TIMEOUT_MS` | 900000 | 单个运行的硬超时 |
| `DSH_TEAM_MAX_RUN_TOKENS` | 0 | 单运行 token 上限，超出即中止（0 关闭） |
| `DSH_TEAM_STALL_TIMEOUT_MS` | 600000 | 运行多久没有新事件就判定卡住并回收 |
| `DSH_TEAM_CHAT_MAX_CHARS` | 800 | 群聊消息保留的结论长度 |

运行超时、超预算、卡住都会走同一条失败链路：运行标记失败、任务置 `blocked`、负责人 Bot 接手。

## 官方 Agent Teams 开关

构建与运行使用同一个 `DSH_TEAM_AGENT_TEAM`（默认 0）：构建时为 1 才把 `@deepseek-ai/dsh-experimental-agent-team-profile@<DSH 版本>` 装进镜像 profile 模板，运行时为 1 才在 profile 里启用。要开团队层，在 `~/.dsh/team-bots.env` 设一次 `DSH_TEAM_AGENT_TEAM=1`，两端同时生效。

- `1`：每个任务会话可以把任务拆成具名 teammate 并行执行（共享项目工作区），最多 `DSH_TEAM_MAX_TEAMMATES` 个；群聊、验收仍由项目会话负责。
- `0`（默认）：不加载团队层。

注意：启用该层会替换 DSH 顶层 `subagent` 工具。先把共享技能池和 Bot 指令里对 `subagent` 的依赖改掉再开。启用后用 `npm run verify:agent-team`（容器内同路径）检查 profile 状态；Router 会话要真正不带写工具，需按 `docs/agent-teams-plan.md` 附录 A 定义受限 agent preset 并设 `DSH_TEAM_ROUTER_PRESET`，只读运行的越权写入由项目写审计兜底。

## 模型与强度

模型列表来自 DSH 的 provider 注册表。Bot 保存 `provider + model + effort`，每次运行前通过 `sessionController.selectModel` 应用。没有配置模型时 Bot 可以创建，但运行会明确报错。

若使用 OpenAI 兼容中转，在宿主机 `~/.dsh/cordis.patch.yml` 中配置 DSH provider，参考 [DSH / DS-Bot 配置方式](https://github.com/Fei2411/DS-Bot/blob/main/docker/README.md#custom-model-endpoint)。团队插件不维护独立 provider 配置。

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

| model | hit | miss | out | currency |
| --- | --- | --- | --- | --- |
| deepseek-flash | 0.2 | 2 | 8 | CNY |
| glm-5.3 | 2 | 8 | 28 | CNY |
| glm-5.3-flash | 0.23 | 0.8 | 2.8 | CNY |
| MiniMax-M3.1-Flash | 0.1 | 1 | 4 | CNY |

覆盖方式三选一，优先级从高到低：

1. 插件配置（宿主 `~/.dsh/profiles/team-bots/cordis.patch.yml` 或 bundle patch）：

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
            provider: zhipu   # 可选，留空表示按模型名匹配任意 provider
            hit: 2
            miss: 8
            out: 28
            currency: CNY
```

2. 环境变量 `DSH_TEAM_MODEL_PRICES`（JSON 数组，字段同上；`docker-compose.yml` 已透传）。
3. 内置默认值。

生效规则：

- 默认价格只在**首次启动**播种进 `model_prices`，之后以数据库为准，配置改价不会覆盖 Web 里的手动调整。
- Web「全局配置 → 模型价格」可新增、编辑单条价格，或点「默认」把某条恢复成配置值（写入新版本，保留历史）。
- 匹配顺序：精确 `provider + model` → 通配 `provider = ''`（按模型名匹配任意 provider）→ 忽略大小写。
- 币种随价格记录；`CNY` 用 ¥ 显示。不同币种的价格混在一起汇总时不做汇率换算。

输入、输出、缓存读写都按每百万 token 计价。

限制：单容器内无法可靠按 Bot 归因 CPU/内存，只归因 token、成本、调用次数和运行时长。

## 安全边界

- Docker 容器是安全边界，DSH 在容器内使用 `danger-full-access`。
- `/workspace/{project}` 是逻辑隔离，不是强沙箱；不要在一个容器中运行互不信任的团队。
- 生产必须通过 HTTPS 反向代理，并正确转发 Host 和 WebSocket。
- 不要给容器挂载宿主机根目录、SSH 私钥、其他项目或 Docker socket。
- 宿主能力桥（`docker-compose.host-caps.yml`，自动生成）把 patch 引用的能力树挂入容器：home 内可写（与 `~/.dsh` 同一边界语义，bot 可读写宿主登录态与缓存），home 外只读。不需要某能力就从宿主 patch 注册中移除该引用，再跑 `npm run docker:up`。
- 群聊、自动记忆和任务会产生模型调用，请设置项目预算和并发上限。

## 开发

```sh
node --test "tests/*.test.js"
node scripts/dev-server.js
# 打开 http://127.0.0.1:4317
```

开发预览使用假 DSH runtime，无认证，不能用于生产。

## DSH 版本与升级

Docker 构建不写死 DSH 版本：未设置 `DSH_VERSION` 时，构建阶段从 npm registry 解析最新的非 alpha 版本并安装。需要固定时可在 `~/.dsh/team-bots.env` 设置 `DSH_VERSION`。

运行中可在「全局配置 → DSH 运行时」检查并升级：

1. 插件查询 npm 上最新非 alpha 版本。
2. 有排队/运行中任务时拒绝升级。
3. 写入升级请求，DSH 进程以退出码 75 结束。
4. 容器入口脚本以 root 安装目标版本，再以相同 profile 原地启动 DSH，完成热重启。

## 故障排查

**`mkdir: cannot create directory '/workspace/.agents': Too many levels of symbolic links`**

工作区里的 `.agents` 或 `.data` 是自引用/断链符号链接（同步盘、手工 `ln -s`、半恢复的备份都可能造成），`mkdir -p` 直接以 ELOOP 退出。入口脚本会先探测：

- 链接能解析到真实目录且在工作区内：保留，不动。
- 链接断链、自引用：打印一行说明后替换成真实目录。
- 目标存在但不是目录：报错退出，不会静默覆盖。

`ensureSkillRoot`（`src/paths.js`）同样处理，并拒绝指向工作区外的技能池链接。

**`/workspace` 不可写**

容器首次启动会创建缺失的挂载目录（属主 root）。入口脚本用 `gosu node test -w /workspace` 探测，只有不可写时才改属主，不会动已有的宿主目录结构。若仍提示不可写，检查 `~/.dsh/team-bots.env` 里的 `PUID`/`PGID` 是否等于宿主机目录属主。

## 基线

- DSH：构建时动态解析最新非 alpha 版本；实际版本显示在「全局配置 → DSH 运行时」。
- 架构参考：[DS-Bot](https://github.com/Fei2411/DS-Bot)、[Cindy](https://github.com/makecindy/cindy)
- License: Apache-2.0，见 `LICENSE` 和 `NOTICE`
