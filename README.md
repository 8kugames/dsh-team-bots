# DSHBots

运行在 Docker 中的 DSH Web + 团队 Bots 插件。提供项目群聊、Linear 风格任务、Bot 长期记忆、共享技能池、版本化进化和全局/项目/Bot 三档用量统计。

所有 Bot 执行统一走 DeepSeek Harness（DSH）Session，不接入 Claude Code、Codex、AutoGen 或其他 agent runtime。

## 功能

- 每个 Bot 独立配置角色、模型、reasoning effort 和长期记忆。
- 每个项目自动创建群聊、负责人 Bot、任务编号和独立工作区。
- 群聊支持普通消息、`@Bot`、`/task @Bot 标题` 和 `/remember 内容`。
- Linear 风格任务面板：状态、优先级、负责人、评论、运行记录、拖拽流转。
- 负责人 Bot 可用 `team_assign_task` 向成员分派或重派任务，用 `team_review_task` 验收交付。
- Bot 可用 `team_remember` 写入记忆，用 `team_propose_evolution` 提交角色/技能提案。
- 共享技能池固定为 `/workspace/.agents/skills`，技能变更需审批。
- token、调用次数、成本和运行时长按全局、项目、Bot 归集。

## Docker 启动

要求 Docker 24+、Compose v2.24+。容器挂载宿主机的 `~/.dsh`，因此全局 provider、插件、凭据和 DSH 配置全部继承；本插件只使用独立的 `~/.dsh/profiles/bots` profile。

```sh
cp .env.example .env
# 填写 DEEPSEEK_API_KEY；把实际访问域名/IP 加入 DSH_TRUSTED_HOST
# Linux 下把 PUID/PGID 改成 ~/.dsh 和 workspace 的属主
docker compose up -d --build
docker compose logs -f dsh-team
```

Docker Compose 把 `${HOME}/.dsh` 挂到容器 `/home/node/.dsh`。若宿主没有 `profiles/bots`，入口脚本会从镜像模板初始化；不会覆盖宿主其他 profile 或全局配置。

首次登录：从日志中读取 `dsh web: http://127.0.0.1:3080/?token=...`，把容器内 `3080` 换成宿主机端口 `13080` 打开，设置登录 Cookie。

之后访问：

```text
http://<host>:13080/                    DSH Web
http://<host>:13080/api/dsh-team/ui     DSHBots 团队工作台
```

团队工作台挂在 DSH 的认证路由下，必须先在 DSH Web 完成登录。

界面按工作区逻辑组织多项目：左侧树展示「群聊」（每个群聊对应一个项目）与「Bots」两棵列表，底部是全局配置；选中群聊后，顶部以 tab 切换群聊、任务、Bots、技能、记忆、进化、用量、设置八个模块，有待人工处理事项（待验收任务、待审提案）的 tab 会亮小红点。

## 字体、主题与 DSH 能力

- 字体默认使用本地打包的 Inter，中文回退到 PingFang SC / Microsoft YaHei。
- 配色使用 Catppuccin：浅色 `Latte`、深色 `Macchiato`，跟随系统 `prefers-color-scheme`。
- 顶栏 `Aa` 或左侧「全局配置」可调整字号（80%–140%），保存在浏览器本地。
- 每个 Bot 是 DSH 原生 Session；角色作为 system prompt section 注入，不替换 DSH prompt。
- 模型、reasoning effort、Tools、插件、MCP、Skill 注册表、文件工具、流式事件和登录态全部继承 DSH。
- 本插件只额外注册 `team_assign_task`、`team_review_task`、`team_remember`、`team_propose_evolution`，并将 `/workspace/.agents` 注册为 Skill Provider。
- 全局配置来自宿主机 `~/.dsh`，插件 profile 固定为 `~/.dsh/profiles/bots`。

## 目录

```text
~/.dsh/                      -> /home/node/.dsh（宿主机挂载）
  cordis.patch.yml           -> 宿主机全局 provider / 插件配置
  profiles/bots/             -> DSHBots 插件的 DSH profile
  sessions/                  -> DSH 原生会话
WORKSPACE_HOST_DIR/          -> /workspace
  .agents/skills/            -> 共享技能池
  {project-slug}/            -> 各项目工作区
DSH_TEAM_DATA_DIR/           -> /data
  team-bots/team.sqlite      -> 平台元数据、任务、运行、用量
  team-bots/memory/          -> 可读 Markdown 记忆镜像
```

备份必须包含宿主机 `~/.dsh`、`/data` 和 `/workspace`。不要挂载宿主机根目录或 Docker socket。

## 群聊和任务

- 普通消息由项目负责人 Bot 响应。
- `@Builder 看一下这个问题` 直接调用 Builder，不额外唤醒负责人。
- `/task @Builder 实现登录页` 创建 `KEY-1` 任务并立即排队。
- `/remember 发布必须先通过回归测试` 写入项目记忆。
- 任务完成后进入 `in_review`。用户派单的任务由用户验收；负责人 Bot 通过 `team_assign_task` 派单的任务自动转负责人 Bot 用 `team_review_task` 验收，验收不通过可退回重做。
- 任务执行失败置 `blocked`，自动转负责人 Bot 处理：可用 `team_assign_task` 重派（含换人），需要用户决策时提请用户介入。
- 负责人 Bot 通过 `team_assign_task` 分派，任务和运行都可在面板追踪。

## 模型与强度

模型列表来自 DSH 的 provider 注册表。Bot 保存 `provider + model + effort`，每次运行前通过 `sessionController.selectModel` 应用。没有配置模型时 Bot 可以创建，但运行会明确报错。

若使用 OpenAI 兼容中转，在宿主机 `~/.dsh/cordis.patch.yml` 中配置 DSH provider，参考 [DSH / DS-Bot 配置方式](https://github.com/Fei2411/DS-Bot/blob/main/docker/README.md#custom-model-endpoint)。团队插件不维护独立 provider 配置。

## 记忆与进化

- `bot` 记忆只进入该 Bot 的上下文。
- `project` 记忆进入该项目所有 Bot 的上下文。
- 任务成功后会沉淀交付摘要；密钥和密码会被过滤。
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

1. 插件配置（宿主 `~/.dsh/profiles/bots/cordis.patch.yml` 或 bundle patch）：

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

限制：单容器内无法可靠按 Bot 归因 CPU/内存，因此 v1 只归因 token、成本、调用次数和运行时长。

## 安全边界

- Docker 容器是安全边界，DSH 在容器内使用 `danger-full-access`。
- `/workspace/{project}` 是逻辑隔离，不是强沙箱；不要在一个容器中运行互不信任的团队。
- 生产必须通过 HTTPS 反向代理，并正确转发 Host 和 WebSocket。
- 不要给容器挂载宿主机根目录、SSH 私钥、其他项目或 Docker socket。
- 群聊、自动记忆和任务会产生模型调用，请设置项目预算和并发上限。

## 开发

```sh
node --test "tests/*.test.js"
node scripts/dev-server.js
# 打开 http://127.0.0.1:4317
```

开发预览使用假 DSH runtime，无认证，不能用于生产。

## 基线

- DSH：`0.2.1-rc.5`（Docker build arg 可覆盖，但升级需重跑契约测试）
- 架构参考：[DS-Bot](https://github.com/Fei2411/DS-Bot)、[Cindy](https://github.com/makecindy/cindy)
- License: Apache-2.0，见 `LICENSE` 和 `NOTICE`
