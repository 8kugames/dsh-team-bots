# superagent B 路线移植排期方案

来源：DSHBOTS-134（2026-11-04）。基线：dsh-team-bots `82ef88b`（0.2.156）起步，期间 `ae44d33`（DSHBOTS-129）落地，本文锚点在当前树（`06ea964`）逐行核对，所引文件均不受该卡影响。对照仓 `/Users/silesjian/Desktop/Tools/others/dsh-superagent-prototype`（下称「原型」，文档 docs/000-008 + src/ 全读）。
性质：只读评估与排期，本卡不改任何 src/ui/tests。所有「现状」锚点均为本卡实读核对；行为断言引用现有测试用例标题作先例。

## 0. 结论速览

| 机制 | 一句话移植面 | 档位 | 建议卡 |
| --- | --- | --- | --- |
| ① worker slot（5s 前台转后台 preset） | 自带 cordis.patch.yml 加 worker preset + prompt 纪律块 | S | 卡 D |
| ② turn 后台工作 30min 上限 | run 不再等于一次 turn：lifecycle 引入后台等待态 + untilQuiet/kill 移植 | L | 卡 E |
| ③ recovery note 重启恢复 | 复用 core.js 既有 running→queued 重排队，补一个注入式恢复提示块 | S | 卡 A |
| ④ stored work 先落库后执行+退避 | outbox 已实现主干，只补 coalescing 与无责延迟两类缺口 | S | 卡 B |
| ⑤ 工单七态（stage 判定表） | 新增纯函数 taskStage 派生「在等谁」，UI/API 消费，不新增存储态 | M | 卡 C |

档位定义：S = 单次提交可完成（约半天内）；M = 单卡 1–2 天；L = 卡内需分阶段验收（≥2 天）。
排期总形态：**第一波 A ∥ B ∥ C（写范围互斥并行）→ 第二波 D → 第三波 E**。A/B/C 独立即有收益且互不碰文件；D 改全局代理行为需单独灰度；E 是最大件且消费 D 的行为常态化与 B 的投递模式。

## 1. 五机制逐项评估

### 1.1 机制①：worker slot —— shell 前台 5s 转后台 job + 同 slot 唤醒

**原型机制**（原型 cordis.patch.yml，worker preset `dsh-superagent-worker`）：bash-sandbox/pwsh-sandbox `timeoutMs:5000 maxTimeoutMs:5000`——前台命令超 5s 自动转后台 job，工具立即返回 job 句柄；tool-jobs `waitTimeoutMs:5000`——job 等待最多 5s，job 结束带结果唤醒所属 worker；子代理走 standard preset（其 shell 60s 才转后台）。配套 WorkerSlots（原型 src/executor/dsh.ts）：`reserve()` 同步先于 await，防两个启动抢最后一个 slot；人消息唤醒可超并发上限 1 个且优先于 launch。

**现状对照**：
- preset 旋钮已存在：src/config.js:118-119（`routerPreset`/`workerPreset`，默认空串，env `DSH_TEAM_WORKER_PRESET`/`DSH_TEAM_ROUTER_PRESET`），src/services/runtime/session.js:133-148 `defaultAgentPreset`：task 会话用 `config.workerPreset ?? 'standard'`。**缺的是 preset 定义本身**——我们的 cordis.patch.yml 仅 3 行插件注册，未定义任何 preset。
- 并发记账已有等价物：scheduler tick 的 maxRuns 闸门（src/services/scheduler.js:396-398）、人保底槽 +1（:397、:419、:480-481，DSHBOTS-43，tests/human-slot.test.js 4 例）、同任务串行 claimKey（:226）、写范围闸门（:431）。「person 超限 1 个、优先于机器」这条原型规则我们已用人保底槽落地。
- 关键缺口：宿主的 job 唤醒路径我们完全没接。standard preset 下前台命令 60s 转后台 job；turn 结束后 job 结束若唤醒会话，lifecycle（src/services/runtime/lifecycle.js:222+，turn/end → completionHandler → finishRun）已把 run 收尾，唤醒 turn 成为无 run 记账的孤儿 turn。原型「同 slot 唤醒」的记账部分属机制②，不在本卡。

**移植面**（仅 preset 部分）：
- cordis.patch.yml：新增 worker preset 定义（bash/pwsh-sandbox 与 tool-jobs 的 5s 参数），约 30 行 YAML。
- src/services/runtime/prompt.js：worker 提示词加「长命令转后台」纪律块（启动长命令拿句柄 → 继续别的活 → job 结束会带结果回来；参考既有条件注入块先例：时效块 D-125、subtask 纪律块 D-132）。
- src/config.js：可选——把 `workerPreset` 默认值指向新 preset（或保持空串由部署方显式开启，建议后者，见风险）。
- 不动 DB、不动 scheduler。

**依赖**：无硬依赖；但价值兑现依赖机制②（无唤醒记账时，转后台的 job 结果常在下一次运行才被读到）。
**档位**：S。
**风险**：
1. 全局行为变更：preset 作用于所有 task 会话（defaultAgentPreset 是全局配置），现有 bot 的命令习惯按阻塞式 bash 假设写成，5s 截断会让「跑个 npm test」立即转后台，若 bot 不会用 job 句柄就空手收 turn。建议默认关闭、按项目/bot 灰度（config 已支持 env 覆盖）。
2. 提示词纪律必须同步落地，否则 preset 单独上线=交付质量回退。
3. 与审批链路交互：审批发生在工具调用时（pre-execute 暂存 D-128），命令转后台不绕过审批，无新风险，但验收时需回归 tests/approval-target.test.js。

### 1.2 机制②：turn 后台工作 30min 上限

**原型机制**（docs/003-execution.md + src/executor/background.ts + dsh.ts）：turn 结束时会话仍拥有在跑 shell job 或子代理 → 工单保持 worker slot、继续 working；job/子代理结束以同 slot 唤醒 Executor 带结果；turn 结束后的后台工作至多 30 分钟（BACKGROUND_LIMIT_MS），到限杀 shell job、报 waiting（报告含被杀 job 名）；子代理不杀（杀即唤醒）；handoff（ready/提问/blocked 后无人消息）立即释放 slot，供人用的 job（如 review server）留着继续跑不受限。实现件：`untilQuiet`（childrenEnd→jobsEnd 循环，agent idle 且无 owned job 且无子代理才算静默）、`killJobs`（先起 wait 再 kill，结局被收集不再唤醒）、`stopSubagents`（drain 10s → cancel keepInbox）；jobs/subagents 服务来自 `ctx.get('jobs')` / `ctx.get('subagents')`（background.ts:29）。

**现状对照**：
- run = 一次 turn：src/services/runtime/lifecycle.js:222+ turn/end 即 completionHandler → finishRun，无任何 turn 后延续。ctx.get('jobs') 全仓未使用；子代理只有用量归因（lifecycle.js ownerForChild/childOwner），无生命周期跟踪。
- 有利的巧合：调度槽按 runs.status='running' 记账（scheduler.js:357+ tick 活跃查询），run 生命周期一旦延长到「静默为止」，占槽自动成立，scheduler 主闸门不用改。
- 冲突点：reapStalledRuns（scheduler.js:231-265）按 last_progress_at 判 stall，stallTimeoutMs 默认 20min（src/config.js:97）**小于** 30min 上限——后台等待中的 run 若无进度事件会被误杀，必须豁免或续期进度。
- 重启交互：core.js:79-89 已把 running→queued 重排队（配机制③的 recovery note 正好闭环）；进程死亡时宿主侧 job 自然终止。

**移植面**：
- 新文件 src/services/runtime/background.js：移植 untilQuiet/killJobs/collectJob/stopSubagents（原型 background.ts 165 行，适配我们的 services 结构）。
- src/services/runtime/lifecycle.js：turn/end 分叉——有 owned job/子代理在跑 → 进入后台等待（run 保持 running，起 30min 定时器，订阅 job events）；静默 → 正常 finishRun；到限 → killJobs + 注入被杀说明 + finishRun；宿主唤醒产生的新 turn 归入同一 run（turn/start 时 run 仍 running 即续用，不新开）。
- src/services/runtime/session.js startRun：后台等待态的 pending 生命周期延长，runTimeoutMs 语义改为「前台 turn 超时」（与 30min 后台限并存，两者取先）。
- src/services/scheduler.js：reapStalledRuns 对后台等待 run 的豁免/续期（例如 job 事件 touchProgress）。
- src/services/runs.js finishRun：收尾文案区分「静默完成」与「30min 到限被杀」；run_events 新增 background_wait/background_killed 类型（无 DDL 变更，run_events.type 是自由文本）。
- 任务终态时的 stopBackground：cancelRunInternal（runs.js:195）扩为 kill 后台 job + 释放子代理。

**依赖**：软依赖机制①（preset 让后台 job 成为常态；没有它，仅 standard preset 60s 转后台与显式子代理会触发，价值窗口小）；硬依赖无，但强烈建议在卡 B（scheduler.js 先落定）之后做，避免同文件并行。
**档位**：L（五件中最大）。
**风险**：
1. run≠一次 turn 是全局语义变更，steer/timeoutRun/cancelRun/reapStalledRuns 的交互都要重推；用量记账跨唤醒 turn 的归集（usage_events 按 run 载体）要重验。
2. 「job 结束唤醒会话」的宿主行为细节（哪些 preset 配置下唤醒、唤醒消息形态）需在卡 E 设计时以实验核验，本卡只确认 jobs/subagents 服务可用（原型同宿主已用）。
3. handoff 语义（供人用的 job 留着不杀不占槽）需要 UI 提示配套（任务详情展示遗留 job），否则用户不知道有东西在跑。第一版可收窄为「全部杀掉」，handoff 留作后续增强——在卡 E 内明确取舍即可。

### 1.3 机制③：recovery note 重启恢复

**原型机制**（dsh.ts resume() + Engine 侧）：宿主重启后，运行中的 Assignment 以「host restarted」结束，紧接建新 Assignment 并注入 recovery note——提示 Executor 检查 worktree/git 历史/PR 状态核实现状、不重复已做过的外部动作；最老工单优先。

**现状对照**：
- 重排队已有：src/services/core.js:79-89 启动时 `running→queued`，run_events 记 `recovered`「宿主重启，运行重新排队」；重排队保序（不改 queued_at，tick 按优先级+queued_at FIFO 出队）。**缺的只是注入给 worker 的恢复提示**——重跑时 prompt.js 按标准任务提示词重组，会话历史虽在（session_bindings 复用，session.js:149），但没有任何一句话告诉 worker「你上次被打断，先核对再继续」。
- attempt 语义已区分：重启重排队不 bump attempt（runs.attempt 只在 retryRun runs.js:266 时 +1），recovery note 与重试计数无关，互不干扰。

**移植面**：
- 迁移：runs 加 `recovery` 标记列（域自管迁移，房规先例 src/services/attention-schema.js:20-25 的 runs_attention），core.js 重排队时置位，startRun 消费后清除。
- src/services/runtime/prompt.js：注入恢复块（中文，对齐原型语义：「上次执行因宿主重启中断。先检查工作区与 git 状态核实现状，再从中断点继续；已执行过的外部动作（提交/发布/消息）不要重复。」）。条件注入先例充分（时效块、subtask 纪律块）。
- tests/recovery-note.test.js：置位→注入→消费清除→多次重启多次注入（每次重排队后首跑各一次）。

**依赖**：无。与机制②天然互补（后台等待中被重启的 run 走同一条重排队+note 路径）。
**档位**：S。
**风险**：低。唯一口径问题：首跑即被重启（会话无历史）也会注入 note，措辞上「先核实现状」对新会话无害但略空——可接受，或按 session_bindings 是否已存在分支，属实现细节。

### 1.4 机制④：stored work 先落库后执行 + 指数退避

**原型机制**（src/app/effects.ts）：决策后动作先在调用方事务内落 effect 表（`ON CONFLICT(kind,key) DO UPDATE` 覆盖 payload、generation+1、attempts=0——同键合并保队列位），提交后才开始执行；失败指数退避 `min(max, initial*2^min(attempts,16))`；`Later` 异常=暂不可行不计失败只延后；连续 3 次失败（FAILURES_BEFORE_ERROR=3）才报系统问题；分 kind 并发上限/保序/静默。

**现状对照**——**outbox 已实现主干**：
- 先落库后执行：src/services/scheduler.js:42-64 `enqueueOutbox` 调用方事务内插行，`idempotency_key UNIQUE` 幂等，due≤now 同栈立即投递。
- 指数退避：scheduler.js:66-120 `applyOutboxRow` 失败 → `available_at=now+min(60s, 1s*2^attempts)`；attempts≥5 或 permanent → failed。与原型的差异只是参数（我们 1s 起/60s 顶/5 次，原型按 kind 配 2s-300s），无结构差距。
- 重启存活：行持久化，dispatchOutbox（:114-119）每拍领 due pending。
- 与原型比的两处缺口：
  1. **coalescing**：我们 `DO NOTHING` 先写者赢——同键重复入队不刷新 payload。对 review_delegate_auto 重试这类「投递时应取最新状态」的 kind，原型语义（覆盖 payload+清零 attempts）更对。
  2. **无责延迟（Later）**：我们所有失败都计 attempts，5 次即 failed。将来机制②引入「无空闲 slot 先等等」类投递时会需要不计数延迟。

**移植面**：
- src/services/scheduler.js：enqueueOutbox 增加 per-kind 合并策略（opt-in，仅 review_delegate_auto 等重试型 kind 开 `DO UPDATE`）；新增 defer 不计数路径（available_at 前移、attempts 不动）。
- src/services/runs.js：queueAutoReviewDelegate（:525）排队点改用合并语义。
- tests：沿用 tests/plan-retry.test.js 的幂等/派生守卫写法，新增 coalescing 与 defer 用例。

**依赖**：无。是机制②唤醒投递的软前置（B 先落定，E 的投递模式直接复用）。
**档位**：S。
**风险**：改 `DO NOTHING`→`DO UPDATE` 动的是幂等语义，必须 per-kind 白名单——plan_retry 派生（scheduler.js:267+）依赖先写者赢防止重复派生，不能一刀切。白名单写反方向（默认合并、例外保持）不可取，默认保持现状。

### 1.5 机制⑤：工单七态（stage 判定表）

**原型机制**（src/core/stage.ts + docs/003-execution.md）：stage 不存储，从 Reports/Inputs/Attention **派生**，自上而下首行命中：ended → person/delivery（投递失败重试中）→ person/answer（有 attention 待人答）→ person/review（最新报告 ready 待验收）→ person/blocked、failed（报告 blocked/failed 且其后无人类消息）→ working/queued（无 Assignment 或 pending）→ idle（最新报告 waiting 或 Assignment 已结束，等 Trigger 续命）→ working（其余）。价值：一眼看出「在等谁」，人/机责任边界清晰。

**现状对照**：
- 存储态已有七个且更贴工作流：tasks.js:15 `TASK_STATUSES = {backlog, todo, in_progress, blocked, in_review, done, canceled}`，:20-27 显式转移表。但「在等谁」这一轴是糊的：in_review 既可能是等人验收也可能是带提问等人答；in_progress 可能真在跑（有 running run）也可能卡在重排队间隙；blocked 混用「运行失败待 owner」与人工阻塞。
- 派生信号已散落各处：runs.attention_json（attention-schema.js:24，D-116 结构化提问）、finishRun 成功→in_review（runs.js:550+）、失败无 fallback→blocked、queueAutoReviewDelegate 的 attentionPending 特判（runs.js:525-530，tests/review-auto.test.js「交付带提问不派核验」）、plan_wait 紫态（tests/plan-retry.test.js）。
- 缺的就是一个**统一判定函数**。原型「派生不存储」的哲学与我们的 runHoldsWriteLock（scheduler.js:31，D-73 纯函数）同构，房规现成。

**移植面**：
- 新文件 src/services/task-stage.js：`taskStage(task, latestRun, attentionPending)` 纯函数，映射到我们的七态：`working`（有 running/queued 任务 run）/ `working/background`（机制②落地后的后台等待，先留枚举位）/ `person/answer`（in_review 且有 pending attention）/ `person/review`（in_review 无 attention）/ `person/blocked`、`person/failed`（blocked 且最近 run failed / owner handle 待决）/ `queued`（todo 无 run，含依赖闸门拦住的）/ `ended`（done/canceled）。
- src/api.js：任务列表/详情响应附 stage 字段。
- ui/app.js + ui/modules：卡片与详情页 chip 消费 stage（复用现有状态 chip 样式 token，参考 D-116 提问卡四态的做法）。
- 不动 scheduler 决策（queueAutoReviewDelegate 的 attentionPending 特判暂不迁移到 taskStage 上，见风险 2）、不动 DDL。

**依赖**：无硬依赖；机制②落地后补 `working/background` 一档即可。
**档位**：M（纯函数 S，UI 消费与三处状态源对齐是大头）。
**风险**：
1. 双真值打架：stage 与现有 plan_wait 紫态、attention 卡片态语义交叠，UI 必须明确 stage 是「展示层统一视图」而非新状态源，存储态仍以 tasks.status 为准。
2. 判定源收敛是诱人的重构（把 runs.js:525 的特判迁到 taskStage），但会跨进 scheduler 消费面——本卡不做，留作后续卡（在卡 C 验收时评估）。

## 2. 排期建议：卡片拆分

五张卡（编号以实际立卡为准，此处按内容命名）。写范围均按项目写范围锁口径声明（不含 package.json，DSHBOTS-133）：

| 卡 | 内容 | 档位 | 写范围 | 前置 |
| --- | --- | --- | --- | --- |
| 卡 A：recovery note | 机制③：重排队置位 recovery 列 + prompt 恢复块 + 消费清除 | S | src/services/core.js, src/services/runtime/prompt.js, src/services/recovery-schema.js(新), tests/recovery-note.test.js(新) | 无 |
| 卡 B：outbox 补强 | 机制④：per-kind coalescing 白名单 + defer 不计数延迟 | S | src/services/scheduler.js, src/services/runs.js, tests/outbox-coalesce.test.js(新) | 无 |
| 卡 C：task stage | 机制⑤：taskStage 纯函数 + api 暴露 + UI chip | M | src/services/task-stage.js(新), src/api.js, ui/app.js, ui/modules/, tests/task-stage.test.js(新), tests/task-stage-ui.test.js(新) | 无 |
| 卡 D：worker preset | 机制①：cordis.patch.yml worker preset + prompt 纪律块 + 灰度开关 | S | cordis.patch.yml, src/config.js, src/services/runtime/prompt.js, docs/ | 卡 A（同文件 prompt.js 串行） |
| 卡 E：后台工作延续 | 机制②：background.js 移植 + lifecycle 后台等待 + 30min 上限 + stall 豁免 + 终态 stopBackground | L | src/services/runtime/lifecycle.js, src/services/runtime/background.js(新), src/services/runtime/session.js, src/services/scheduler.js, src/services/runs.js, tests/background-wait.test.js(新) | 卡 D（行为常态化）；卡 B（scheduler.js 串行） |

**波次与并行度**：

```
第一波（并行 3 卡，写范围互斥）
  卡 A ──────────┐
  卡 B ──────────┼─→ 第二波：卡 D ─→ 第三波：卡 E
  卡 C ──────────┘
```

- 第一波三卡零前置、文件集两两不相交，可同时开工，是并行度最大点。
- 卡 D 依赖卡 A 只因 prompt.js 同文件（不同的注入块，D-125/D-132/D-126 先例证明块间独立，串行纯属避免写锁撞车）。
- 卡 E 是关键路径尾部：消费卡 D 的 preset（否则后台 job 触发面太小）与卡 B 的投递模式；与卡 B/A 的文件交集（scheduler.js/runs.js/session.js）也要求排后。卡 E 内部分两阶段验收：E1 观察与延续（untilQuiet + 后台等待 + 静默收尾）、E2 上限与治理（30min kill + stall 豁免 + 终态 stopBackground + handoff 取舍）。
- 总时长估计：第一波一个窗口（S/S/M 并行约 2 天）→ D 半天 → E 2–3 天。全程不阻塞其他在办卡：第一波之后任何时点只有一张 D 系卡占用 runtime/ 谱系。

## 3. 明确不移植清单与边界

**不移植**（A 方案范畴或无对应需求）：
1. Source/Trigger/ExternalChannel 全套外部接入层——GitHub/CI/邮件等 Trigger 采集、Channel 投递回路、Source 自有 bot 身份。我们的消息入口就是群聊/单聊/面板，不需要第二套接入。
2. Policy/Eval/Mandate 准入评估层——任务准入由 director 派单与 owner 验收流程承担，无独立评估服务需求。
3. Subscription 多路 fan-out 订阅。
4. 独立部署形态：orchestrator.sqlite 独立状态目录、目录锁、独立面板（原型 src/client/）、worker/router 独立 profile 进程模型、prepare 命令 10min 与 worktree/分支准备（我们的工作区=项目目录，无 prepare 步骤）。
5. Ticket/Assignment/Report 数据模型本身——tasks/runs/run_events/comments 已是等价账本，只搬机制不搬表。

**边界**：全部五卡都在 dsh-team-bots 单插件、单 SQLite 库、现有 UI 内演进；不新增外部服务、不改部署形态、不建独立 profile。原型的 Router/Worker preset 概念以「我们自己的 cordis.patch.yml 里两个 preset 定义 + 既有 config 旋钮」落地，仍是同一个插件进程。

## 4. 验证口径

- 本卡（只读）验证：现状锚点全部实读核对（上列 文件:行 均为本次会话所读）；tests/human-slot.test.js + tests/stale-run-guard.test.js 实跑 9/9 绿（2026-11-04，node --test）；scheduler/outbox 行为断言引用 tests/scheduling.test.js、tests/parallel-scheduling.test.js、tests/plan-retry.test.js、tests/review-auto.test.js 用例标题作先例。
- 后续卡的 DB 行为核验沿用现有房规：内存库 + 假 ctx 的服务级测试（先例即上述测试文件），不新造测试基建。
- 卡 E 开工前必须先做一次宿主行为核验实验：确认本插件 ctx 下 `ctx.get('jobs')`/`ctx.get('subagents')` 可用、job 结束唤醒会话的事件形态（原型可用不等于我们的 preset 组合可用）。
