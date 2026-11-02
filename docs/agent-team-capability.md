# Bot 子智能体能力与最小启用配置核查（DSHBOTS-27）

- 日期：2026-11-02；执行：devops（只读审计，未改 src/ ui/ tests/）
- 版本锚点：插件 dsh-team-bots 0.2.23（本仓库工作区）；宿主 dsh 安装于 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`；`@deepseek-ai/dsh-subagent` 与 `@deepseek-ai/dsh-experimental-agent-team-profile` 均 0.2.1-rc.5（位于宿主 `node_modules/@deepseek-ai/` 内，`~/.dsh/profiles/web/node_modules/` 无 @deepseek-ai 目录，bundle 由宿主级 node_modules 解析）。
- 方法：静态读代码 + 本会话行为实证（笔者本人即插件在 web profile 下创建的 bot 会话，其工具目录可直接核对）。

## 1. 两个包各自注册了什么

**`@deepseek-ai/dsh-subagent`（家级 `~/.dsh/cordis.patch.yml:20-23` 引用，`maxActiveSubagents: 4`）**
- 包描述（package.json）：「Abstract subagent seam (ctx.subagents): named-provider registry for delegating to child agents」——它只是接线层（seam），**自身不带 cordis.patch.yml，不注册任何工具或 preset**。
- 实际工具由别的包提供：`dsh-tool-subagent`（spawn/fork 两个实例，见下）、`dsh-tool-subagent-control`、`dsh-subagent-spawn-in-process` / `dsh-subagent-fork-in-process`（provider 实现）。
- 家级 patch 里还有 `subagent-model-selection-settings`（`~/.dsh/profiles/web/cordis.patch.yml:69-77`，enabled: true，allowedModels 限 zai/glm-5.3-flash、minimax-cn/MiniMax-M3.1-Flash、zai/glm-5.3）。

**`@deepseek-ai/dsh-experimental-agent-team-profile`（profile bundles 成员，`~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`）**
- `lib/index.js` 仅 `export {}`——**全部声明走包内 cordis.patch.yml**：
  - `disabled: true` 四个根级组件 id：`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`（意在关掉直委派工具族）；
  - `insert` 三个组件：`agent-team`（maxMembers 8 / maxTasks 256 / maxMessageBytes 65536 / disposalTimeoutMs 5000）、`tool-agent-team`（freshProvider: spawn / forkProvider: fork）、`ui-agent-team`；
  - **不注册任何 agent preset**。
- `tool-agent-team`（`dsh-experimental-tool-agent-team/lib/index.js`）工具面共 9 个：`spawn_teammate`(:251)、`send_message`(:293)、`list_agents`(:321)、`wait_agent`(:330)、`interrupt_agent`(:352)、`team_task_create`(:365)、`team_task_list`(:400)、`team_task_get`(:444)、`team_task_update`(:457)，另有提示词组件 `team:policy`(:235) / `team:identity`(:240)。
- 插件自身（本仓库 `src/tools.js`）另向会话暴露 7 个项目工具：`team_assign_task`(:10)、`team_review_task`(:37)、`team_recall`(:58)、`team_remember`(:76)、`team_propose_evolution`(:97)、`team_message_bot`(:136)、`team_request_secret`(:162)。插件根 `cordis.patch.yml` 只 insert 自身组件，无工具裁剪、无 preset。

**preset 从哪来**：可用 preset 全部由 `dsh-web-app/presets/` 提供——`standard.patch.yml`（preset-standard，order 1）、`minimal.patch.yml`（order 3）、`ptc.patch.yml`。注册机制是 `dsh-agent-preset` 组件向 `ctx.agentPresets.register(config)` 注册（`dsh-agent-preset/lib/index.js:25`），registry 按 `record.config.id` 列举（`dsh-agent-preset-registry/lib/index.js:574`）。

## 2. bot 会话实际拿到的工具面

选择链路（插件侧，本仓库）：
- `src/config.js:106-107`：`routerPreset` / `workerPreset` 默认空串（可被 env `DSH_TEAM_ROUTER_PRESET` / `DSH_TEAM_WORKER_PRESET` 覆盖）。
- `src/services/runtime/session.js:113-127` `defaultAgentPreset(kind)`：task 会话取 `config.workerPreset`，其余取 `config.routerPreset`；两者为空时按 `[wanted, 'standard']` 顺序取第一个**确实存在**的 preset（:120-122 的 available 过滤），即默认回退 `standard`。
- `src/services/runtime/session.js:173`：`sessionController.create({ cwd, ...(await this.defaultAgentPreset(kind)) })`。
- `src/services/runtime/lifecycle.js:327-343` `capabilityInfo()`（行号已随工作区漂移，director 引用的 287-298 现移到此处）：只统计 `toolCount` / `toolNames`（:337-338），**不裁剪工具面**——统计口径，不是闸门。

**结论：bot 会话不只「装了 bundle」，而是拿到了完整的两族委派工具。** 决定性证据是 `standard.patch.yml` 的内容：其 `delegation` 组（cordis:group）显式声明了 `tool-subagent-control`、`tool-subagent-control/list-agents`、`tool-subagent`（provider spawn，toolName `subagent`）、`tool-subagent-fork`（provider fork，toolName `subagent_fork`）、`workflow-ptc`、`tool-workflow`——即旧 subagent 工具族由 **preset 组合自身**授予，bundle 根级的 `disabled: true` 声明拦不住 preset 内的同名子组件（两处是独立的 cordis 声明，preset 组合以其 plugins 列表为准）。

行为实证（本会话，插件按上述链路以 `agentPreset: 'standard'` 创建的 bot 会话）：工具目录同时含 `subagent` / `subagent_fork` / `workflow` 与 `spawn_teammate` / `send_message` / `list_agents` / `wait_agent` / `interrupt_agent` / `team_task_*` / `team_message_bot` 等两族工具。**「preset 没启用所以 bot 调不到 spawn/subagent」的假设不成立——现实是过度启用（两族并存）而非缺失。**

## 3. 最小启用配置：建议与 diff

**建议：不改插件代码，走既有配置键；若要专用 preset，先定义 preset 再指向它。** 依据：
- `workerPreset` / `routerPreset` 的读取→过滤→回退链路在 `src/config.js:106-107` 与 `src/services/runtime/session.js:113-127` 已完整存在，插件「自己知道要用哪种 preset」这件事已经做到了，差的只是把值配出来；写死在 `defaultAgentPreset()` 反而丢掉按部署调整的余地。
- 指向不存在的 preset id 是安全的：available 过滤（session.js:120-122）会静默回退 `standard`，不会起不来。
- 改 profile/bundle 层再插一遍全局 disable 已被 agent-team-profile 试过，实证未达效（见第 2 节），不是可行路径。

**现状其实无需任何动作即「已启用」**（两族工具都在）。若目标是给 bot 配专用 preset（例如 worker 用标准面、router 用受限面），最小 diff 是在 web profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 里给 `dsh-team-bots` 组件（现约 :98-100）补 config：

```yaml
- id: dsh-team-bots
  config:
    wechatEnabled: true
    workerPreset: standard      # task 会话：保持全量工具面（含 subagent + team 两族）
    routerPreset: standard      # project/dm 会话；当前没有更合适的受限 preset，先显式声明占位
```

等价 env 方式：`DSH_TEAM_WORKER_PRESET=standard DSH_TEAM_ROUTER_PRESET=standard`（config.js:106-107 支持）。

前置条件提醒：现成 preset 只有 `standard` / `minimal` / `ptc` 三个（`dsh-web-app/presets/`），**没有 team 专用 preset**。`minimal` 连文件读都关（tool-fs `read/write/edit` 全 false，仅留 readImage），不适合当通用受限面。若确需「team worker preset」（比如去 plan-mode、收 subagent 只读），第一步是在某 bundle 的 presets 目录新增一个 `agent-preset` patch 声明，然后再把 `workerPreset` 指过去——这是两步，不属于本单的「最小启用」。

## 4. 风险：子智能体写入与 tasks.write_scopes 闸门互不相干

- 闸门现状：`src/service.js:1992`（工作区当前行号）对同项目写运行做**项目级串行**，且只比较 `runs` 表里 task 运行的 `write_scopes` 快照；DSHBOTS-23 复核已证它尚未按范围放行。
- 盲区一（本单主题）：会话内经 `subagent` / `subagent_fork` / `spawn_teammate` 派生的子智能体不是 runs 表里的运行，闸门完全看不见它们在写什么文件。同一项目里「A bot 的 task run 被串行闸门保护着」与「B bot 的 dm/chat 会话派子智能体改 `ui/app.js`」可以同时发生，互踩无告警。
- 盲区二（既有结论，重申）：chat / dm / solo 会话运行本身就不受写范围闸门管辖，父会话能写，子智能体继承父会话沙箱（子智能体无独立文件策略）。
- 现有缓解：按 bot 的文件权限档位 applyFilePolicy（`src/services/runtime/session.js:161`、:194）与目录隔离（solo 会话落各自 `_the_bots/<dir>`）能挡一部分，但对「同项目内 task run × 其他会话子智能体」这一组合无效。

建议（按成本递增）：
1. 约定面：子智能体/队友任务限只读与分析类；写文件一律走任务通道（带 write_scopes 声明的 task），让闸门兜底。
2. 提示词面：插件在 spawn/steer 提示词里注入当前任务的 write_scopes 与「禁写区」声明（prompt.js 已有按配置拼提示词的挂点，:316 一带）。
3. 机制面（跨任务）：把「会话内子智能体写」纳入声明式范围（宿主 per-agent write scope，写前校验），插件单方做不到，需要宿主能力，单独立项。

## 附：核查命令锚点

- 包定位：`ls /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（dsh-subagent、dsh-experimental-agent-team-profile 均在此，不在 `~/.dsh/profiles/web/node_modules/`）。
- preset 面：`cat /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/{standard,minimal,ptc}.patch.yml`。
- 行为实证：本会话（devops，插件创建的 bot 会话）工具目录两族并存，可由 `capabilityInfo` 的 toolNames 侧证。
