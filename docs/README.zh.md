# DSH Team Bots

[English](../README.md)

DSH Team Bots 是 npm 包 `dsh-team-bots`，一个 DSH（DeepSeek Harness）插件，把一整个协作的 bot 团队装进同一个工作区：项目群聊、任务板、按写范围并行调度、记忆与技能、用量与成本，外加一条个人微信通道。

![DSH Team Bots 工作区](assets/tasks.png)

本文件是项目文档的中文版，英文版见 [../README.md](../README.md)。

---

## 1. 项目简介与定位

`dsh-team-bots` 跑在 DSH Web 进程里 —— 没有独立服务 —— 让多个 bot 在同一个项目空间里分工，并把整个协作暴露成一个可操作的 Web 工作区。

1. **协作发生在项目里，而不是聊天窗里。** 每个项目有自己的群聊、成员、任务和工作目录；项目 director bot 在那里拆分、派发和验收工作。
2. **并行是声明出来的，不是碰运气。** 任务声明它会写哪些路径；调度器只在两个写 run 都声明、且写路径前缀互不重叠时，才让它们在同一项目里并行。没声明的一律按串行处理。
3. **一切可追溯。** 每个 run 都保留轨迹、时长、token 数和成本；bot 配置保留可回滚的不可变历史；密钥在落盘时加密，使用时才物化成一次性明文文件，用完即焚。

仓库结构：`index.js` 是插件入口，`src/` 是服务端与调度器，`ui/` 是工作区前端，`tests/` 是守门测试，`docs/` 是设计稿、评审记录和截图。

---

## 2. 快速开始

### 2.1 环境要求与安装

Node.js ≥ 22.19（见 `package.json` 的 `engines`），并装好 DSH CLI（`dsh --version`）；插件跑在 DSH Web 进程里，没有独立进程和端口。

```sh
cd <repo>
npm pack                                        # 产出 dsh-team-bots-<version>.tgz
dsh plugin --profile <name> add ./dsh-team-bots-<version>.tgz
dsh --profile <name>                             # 从启动日志里读带 token 的 dsh web 入口
```

### 2.2 重装与本地预览

```sh
npm run profile:install -- --profile <name>     # 省略 --profile 时装进 team-bots
npm run dev                                     # 本地预览 http://127.0.0.1:4317，假 runtime
```

`profile:install` 把仓库打包并重装进 profile。**profile 里的插件文件是快照，DSH 不会自动加载替换后的文件**：改了代码必须重装，否则页面会卡在「connecting to the team space」。团队数据与 profile 解耦：数据目录只由 `DSH_TEAM_WORKSPACE` / `DSH_TEAM_DATA` 决定。预览服务器用的是假 DSH runtime —— **不做鉴权、不动 DSH 配置、不可用于生产**；端口可用 `PORT` 覆盖。

### 2.3 数据、密钥与技能放在哪

数据位于 `DSH_TEAM_DATA`（缺省 `<workspace>/.data`，工作区根目录 `DSH_TEAM_WORKSPACE`，缺省 `~/.dsh/workspace/team-bots`）：`team.sqlite`、`wechat-channel.sqlite`、`secret.key`、`memory/`、`messages/` 和 `secrets-runtime/`（TTL 到期即焚）。备份时请把 `secret.key` 一起带走 —— 没有它，已有的密文永远解不开。表结构变更走 `src/db-migrations.js` 的幂等迁移。技能来自固定在 `~/.agents/skills` 的共享池，以及项目本地的 `<project>/.agents/skills`、`<project>/.claude/skills`、`<project>/.codex/skills`。

常用变量的模板在 `.env.example`；**不要把 `.env` 放在仓库根目录**，否则 `DSH_*` 会漏进 `npm test` 和 `npm run dev`。

### 2.4 访问入口与常用环境变量

```text
http://<host>:<port>/                     自动登录，直接进入团队工作区
http://<host>:<port>/api/dsh-team/ui      DSH Team Bots 工作区（直达）
http://<host>:<port>/index.html           DSH 原生 Web UI
```

首次访问首页会用当前启动 token 换一张 30 天登录 cookie。自动登录意味着**任何能访问到端口的人都是 owner**，所以请只监听本机或可信网络；要公网暴露，需要一个正确转发 Host 与 WebSocket 的 HTTPS 反向代理。

真正要紧的两个路径是 `DSH_TEAM_WORKSPACE`（团队工作区根目录）和 `DSH_TEAM_DATA`（团队数据库与 run 记录）；其余变量、缺省值和解析顺序（显式 env > 页面保存值 > 代码缺省）都在 `src/config.js`。

---

## 3. 功能总览

- **项目群聊：** 每个项目一个群聊、一个 director bot。支持纯文本、`@Bot`、`/task @Bot <标题>`、`/remember` 和 `/clear`，`/` 与 `@` 可补全命令、技能和成员。结论留在聊天里，完整交付走任务评论。
- **任务板：** Linear 风格、按状态分组的面板，带父子树、优先级与负责人，评论会送进正在跑的会话，支持拖拽流转，行内展示交付物和 run 列表。
- **按写范围并行调度：** 由声明的写范围决定同一项目的两个写 run 能否同时跑；写 run 彼此独立，任务和聊天互不阻塞。
- **记忆与技能池：** bot 级和项目级长期记忆，带人工审核队列；共享技能池固定在 `~/.agents/skills`，项目可追加自己的技能目录；技能变更走提案审批并保留回滚快照。
- **版本化演进与团队工具：** 角色、模型、强度和技能变更走提案审批，bot 配置保留不可变、可回滚的历史。插件注册了任务派发、评审、记忆、召回、演进提案、bot 间直发消息和密钥申请等团队工具。
- **密钥流水线：** 落盘用 AES-256-GCM；审批通过后物化到数据目录（**不是项目工作区**），run 结束或 TTL 到期即焚；消息和 run 输出里始终以 `$<name>` 掩码。
- **用量与成本：** token、调用次数、成本和运行时长按全局、项目、bot 三级汇总；成本来自可配置的模型价格，未配置价格的调用不按 0 计费；支持 CSV 导出和月度对账。
- **审批、提问与终端：** 提权或要人回答的请求变成工作区卡片 —— 审批超时变 `rejected`，提问过期后仍可回答。每个项目有一个交互式终端，带硬超时、实时 tail、取消和持久历史。
- **微信通道与代码卫生：** 扫码授权后推送任务，外加纯文本命令面（见 4.4）；每个项目有行数上限（缺省 800），每个 run 结束时扫描，超限文件触发一条【系统指令】请 director 派拆分卡。

---

## 4. 架构与目录说明

### 4.1 装配链路

`index.js` 里的 `apply(ctx, config)` 是唯一入口，它按依赖顺序把各层装起来 —— 配置、数据库、领域服务、宿主 runtime、团队工具、技能池、HTTP。`service.initialize()` 先建库、播种缺省 bot 与 buddy，之后 `service.start()` 才拉起调度器。

### 4.2 `src/` 目录

| 路径 | 职责 |
| --- | --- |
| `index.js`、`src/config.js`、`src/db.js`、`src/db-migrations.js` | 插件入口；配置解析；SQLite 访问与幂等迁移 |
| `src/service.js`、`src/services/`、`src/runtime.js`、`src/services/runtime/` | `TeamService` 门面及其领域方法；宿主适配器（提示词、会话、模型恢复、轨迹） |
| `src/http.js`、`src/api.js`、`src/tools.js`、`src/botmsg.js`、`src/skill-parse.js` | HTTP 路由与 UI 切片；`/api/dsh-team/api` 分发入口；团队工具；bot 间消息；技能包解析 |
| `src/wechat/`、`src/secrets.js`、`src/pricing.js`、`src/usage*.js`、`src/skills*.js`、`src/seed-bots.js`、`src/updater.js`、`src/paths.js`、`src/util.js`、`src/errors.js` | 微信通道；密钥加解密；定价与用量；技能池；种子 bot；更新检查；路径边界；工具函数；错误类型 |

### 4.3 `ui/` 目录

前端是纯 ES 模块，无构建步骤，每个切片由 HTTP 路由直接加载。`ui/modules/` 每个领域一个模块，`ui/styles/` 每个领域一个 CSS 文件，`ui/i18n/{zh,en}.js` 是界面字典。这棵树的贡献约定（样式切片注册、800 行铁律）见 `CONTRIBUTING.md`。

### 4.4 微信通道

通道缺省关闭（`DSH_TEAM_WECHAT=0`），扫码授权后启用。命令面是纯文本，随时可用 `帮助 / help / ?` 唤出：

| 命令 | 作用 |
| --- | --- |
| `帮助` / `help` / `?` | 显示命令帮助 |
| `状态` | 项目与待验收任务总览 |
| `验收 <任务号> [评语]` | 验收交付，如 `验收 web-3 做得好` |
| `驳回 <任务号> <原因>` | 打回重做，原因必填 |
| `详情 <任务号>` | 显示任务卡与最新评论 |
| `q` | 列出可指派的项目 key |
| `<key>: <消息>` | 转发消息到项目群聊交 director 安排，如 `web: 上线新版官网` |

推送走本地 outbox，其丢弃策略（重试预算、批量窗口、连接周期保留）定义在 `src/wechat/channel.js`。排查漏推时看 `outbox.attempts` 和 `gave_up_at`：有值说明该条目是被设计丢弃的，没值说明还在队列里。

---

## 5. 测试与开发约定

### 5.1 常用命令

```sh
npm test                        # node --test "tests/*.test.js"
npm run dev                     # 本地预览（假 runtime）
npm run doctor                  # 检查 Node/DSH 版本，以及工作区与技能池路径的可写性
npm run profile:install         # 打包并重装进 profile（缺省 team-bots）
npm run backup                  # 备份团队数据
npm run restore-check           # 检查备份能否恢复
```

### 5.2 守门测试与提交约定

`npm test` 覆盖每个功能域，另加几条架构约定的钉子。守门测试细节、提交约定和 `ui/` 贡献约定都在 `CONTRIBUTING.md`。

### 5.3 CI

推送 `v*` tag 触发发布工作流（`.github/workflows/publish.yml`）：装依赖、跑完整 `npm test`，全绿才发布到 registry.npmjs.org。

---

## 6. 故障排查与常见问题

**Q：改了代码，页面还是旧的？**
profile 里的插件文件是快照，不会热加载。用 `npm run profile:install -- --profile <name>` 重装。页面卡在「connecting to the team space」通常也是同一个原因。

**Q：数据在哪，怎么搬到另一台机器？**
`<DSH_TEAM_DATA>` 下有 `team.sqlite`、`wechat-channel.sqlite`、`secret.key`、`memory/` 和 `messages/`。用 `npm run backup` 备份，**不要把 `secret.key` 落下** —— 没有它，已有密文永远解不开。

**Q：微信没收到推送？**
先看 `outbox.attempts` 和 `gave_up_at`：有值说明条目是被设计丢弃的，不是漏发；没值说明还在队列里。

**Q：项目聊天里的「代码卫生」提醒是什么？**
每个 run 结束时会扫描项目工作区里的源文件，超过项目行数上限（缺省 800，判定线 880）的文件会触发一条【系统指令】请 director 派拆分卡。可在项目设置里调高上限，或设为 0 关闭检查。

**Q：能暴露到公网吗？**
插件本身不带沙箱：bot 会话以当前用户身份跑在 DSH 的 `danger-full-access` 下。加上自动登录（能访问端口就是 owner），公网暴露需要 HTTPS 反向代理和自有鉴权；互不信任的团队不应共用同一个 DSH 实例和工作区。

---

## 截图

用量统计带汇总窗口、最近 14 天明细、按模型 / 按 bot / 按项目拆分和 CSV 导出：

![用量统计](assets/usage.png)

全局配置页只保留偏好、运行时效与系统运维核心组；通道、密钥、版本与价格规则在各自的一级页：

![全局配置](assets/global-config-light.png)

---

## License

Apache-2.0，见仓库根目录的 `LICENSE` 和 `NOTICE`。
