# ADR：每 bot 单会话控制面 + 任务子智能体化（总监-组长-员工）

- 状态：已拍板（owner 四问全答），待总监评审后按分期派实施卡
- 范围：dsh-team-bots 会话模型与任务执行链路的大版本级重构；全面切换，不做新旧并行开关
- 结论一句话：工作区每个 bot 收敛为一条控制面会话（新绑定 `kind='bot'`，结转另计）；任务由总监派发给 bot，bot 按任务号开子智能体施工（写范围/沙箱从任务卡继承）；bot 会话串行/合批/插话；子智能体并发上限由 DSH 宿主设定，本项目不另设限。

## 1 目标模型：会话 / 绑定 / 运行 / 子智能体

### 1.1 四层定义与关系

| 层 | 定义 | 唯一性 / 数量关系 |
|---|---|---|
| 会话 session | 宿主 DSH 会话，bot 的唯一控制面载体：收派发、收群聊/私信/单聊、开子智能体、出交付 | 每 bot 每工作区恰 1 条活跃绑定；结转别名（alias=1）另计 |
| 绑定 binding | `session_bindings` 行，入站消息与派发解析「该找哪个会话」的唯一入口 | 收敛为单道 `kind='bot'`，`UNIQUE(bot_id) WHERE alias=0` |
| 运行 run | `runs` 行，一次控制面轮次的调度与记账单元（排队/执行/收尾、用量、run_events） | 每会话串行：同一 bot 同时至多 1 条 queued/running |
| 子智能体 subagent | bot 会话内按任务号开辟的宿主子会话，承载具体施工 | 并发上限=宿主 subagent 槽位设定；按任务号打标签，与任务卡 N:1 |

链路关系：绑定→会话 1:1（活跃）；会话→运行 1:N（串行推进）；运行→子智能体 1:N（并发上限归宿主设定）；子智能体执行时从任务卡继承写范围与沙箱。

角色映射：总监（director/chief）派卡与验收；组长（bot）在自己的控制面会话里拆解、开员工（子智能体）、合并审查、出交付报告；员工（子智能体）只做施工，不直接对外说话。

### 1.2 现状与收敛对照

现状（src/db-migrations.ts `BINDINGS_DDL`）：`task` / `project` / `dm` / `solo` 四道车道各一条活跃绑定，分别由 `one_task_binding` / `one_project_binding` / `one_solo_binding` 唯一索引约束；任务由 bot 在每任务一条的任务会话里亲自执行。

| 现状道 | 收敛后 |
|---|---|
| `task`（每任务一条会话，bot 亲自执行） | 删除。任务派发落 bot 控制面会话，施工交给按任务号开辟的子智能体 |
| `project`（项目群会话） | 删除。群聊消息落 bot 控制面会话，`bot_messages.origin_kind='project'` 保留群线程展示 |
| `dm`（私信会话，`enqueueDmRun` 落 `dm:<bot>:<project>` 车道） | 删除。私信落 bot 控制面会话，origin 标记 `dm`；「DM 不进运行中任务」问题结构性消失 |
| `solo`（项目外单聊会话） | 删除。单聊落 bot 控制面会话（solo bot 的控制面就是它的唯一会话），origin 标记 `solo` |

历史绑定处理：切换迁移时把既有 task/project/dm/solo 活跃行整体置 `alias=1`（沿用结转别名机制，旧 session id 仍可解析历史 origin），再为每个 bot 建一条 `kind='bot'` 活跃绑定。结转（rollover）机制不变，只是对象变成控制面会话：重开控制面时旧行转 alias，`runs_session_idx` 继续服务历史运行归属。

## 2 执行链路

### 2.1 任务全链路（派发→施工→交付→验收）

1. **派发**：总监 `team_assign_task` 派卡（机制不变）→ 调度器为负责人 bot 入队一条 `kind='task'` 运行，`session_id` 解析到该 bot 的 `kind='bot'` 绑定。排队期合批：同会话排队的多条入站（含新派卡、群聊、私信）按既有合批窗口合并注入（见 §2.3）。
2. **控制面接卡**：bot 会话收到派发消息（卡面全文：目标、验收标准、写范围、沙箱档、时限）。bot 自行决定拆法：小卡亲自做；可拆的卡按任务号开子智能体（一卡至少一个专属子智能体，标签=任务号，如 `DSHBOTS-284`）。
3. **子智能体施工**：子智能体提示词从任务卡继承写范围与沙箱档，在其上下文内完成实现与自测；产出（变更清单、验证命令与结果、风险）回报控制面。跨成员写范围互斥仍在派发侧闸门判定（§2.4），不因执行者变成子智能体而放松。
4. **交付**：bot 合并并亲自审查子智能体产出（现状提示词已要求 review child output），在控制面产出交付报告。run-finish 收尾机制不变：任务级幂等键合批、交付报告写 `task_comments`、同事务把卡转 `in_review`（src/services/run-finish.ts 现路径）。
5. **验收**：总监 `team_review_task` 裁决（accept/return），验收看门狗与自动收口规则不变；验收核验委派（核验 subagent 并行）发生在总监会话，结构性不受影响。

### 2.2 DM / 群聊 / 插话如何落控制面

- **私信（DM）**：入站私信不再建独立 dm 运行，而是落目标 bot 控制面会话（origin 标记发送方）。bot 忙时进入该会话排队队列参与合批，闲时直接开轮次。若私信内容指向某张在跑卡，bot 在同一会话内把它转交给该卡子智能体（或亲自处理）——不再需要「恰好一条运行任务才 steer」的特例修补。
- **群聊**：项目群消息照旧逐 bot 各自响应，但响应轮次发生在各自控制面会话（origin 标记 project）；群线程 UI 按 `bot_messages.origin_kind/origin_task_id` 过滤渲染，不依赖独立会话。
- **插话（steer）**：所有向运行中内容注入的既有通道——卡面变更通知（task-notify）、任务评论直通（steerRunningTaskRun）、任务提醒、提问应答（questions answer steer 回原 agent）——目标统一改为 bot 控制面会话的 `session_id`；到达后由 bot 分流：属于某在跑卡的转交对应子智能体，其余自行消化。忙时 steer、闲时排队的回信投递策略（dm_reply 语义）收敛为「回信落控制面」，`dm_reply` 独立 kind 删除。

### 2.3 串行 / 合批

- **串行**：同一 bot 会话同时至多一条 queued/running 运行（新增 `one_active_run_per_bot` 部分唯一索引实现，替代按车道隔离的并行）。不同 bot 之间照旧并行。
- **合批**：入站合批（同绑定道排队消息合并注入、用户提问保护、窗口与上限设置项）与出站 outbox per-kind 合批白名单机制整体保留，作用道从「四车道」改为「bot 会话单道」；同 bot 的多条排队消息在下一轮合并注入。

### 2.4 写范围与沙箱

- 派发侧闸门不变：跨运行并行仍以双方声明写范围且前缀互不重叠为前提（write-lock 判定纯函数与调度逻辑不动）；没声明写范围的卡串行。
- 执行侧继承：子智能体提示词写明本卡写范围与沙箱档，构成其写入边界。现状已知缺口——子代理写继承父会话沙箱、不受任务写范围调度闸门约束（src/services/runtime/prompt.ts 既有声明）——按三层补偿：①派发时跨成员互斥（不变）；②子智能体提示词写入边界（新增）；③交付时 workspace 变更归因核查（attributeWorkspaceChange 现机制）对未归因写入报警。实施卡需实验核验宿主能否对子会话收窄文件沙箱，能则升级为硬闸。

## 3 并发模型

项目侧只约束会话层，子智能体层完全交给宿主：

- **会话层（本项目控制）**：同一 bot 会话串行——同时至多一条 queued/running 运行；排队消息按合批窗口合并注入；运行中内容经 steer 插话（§2.2/§2.3）。
- **子智能体层（宿主控制）**：开多少、怎么排由 bot 在控制面自行调度；并发上限完全遵循 DSH 宿主 subagent 槽位设定（家级配置已见 `maxActiveSubagents` 形态，实测约 4，随宿主版本/配置而变）。本项目不定义并行上限常量、不做项目侧计数/闸门，控制面提示词不写具体上限数字；宿主槽位耗尽时的行为（排队/拒绝并提示）由宿主自身语义决定，本项目不叠加限制。
- **可观测性**：子智能体生命周期仍按任务号记入 run_events（§4.2），用于回答「我在跑哪几张卡、各自由哪个子智能体承载」——只记账，不闸门。

## 4 数据结构变更

### 4.1 session_bindings

- `kind` 域收敛为 `'bot'`（活跃行）；`task_id` 列保留仅历史行使用。
- 新增唯一索引：`UNIQUE(bot_id) WHERE kind='bot' AND alias=0`；`one_task_binding` / `one_project_binding` / `one_solo_binding` 三索引随旧道删除。
- 迁移：旧四道活跃行置 `alias=1` → 为每 bot 建 `kind='bot'` 行（session 复用该 bot 现有 project 会话或新建）。

### 4.2 runs 与 run_events

- `runs` 仍是控制面轮次的记账单元：`kind` 收敛为 `task`（施工/交付）与 `chat`（群聊/私信/单聊/回信，`trigger_type`/`trigger_ref` 区分来源）；`session_id` 一律指向 bot 控制面会话；`one_active_run_per_task` 保留（任务排队语义不变），新增 `one_active_run_per_bot`（实施勘误：现行运行时合批=「同 bot 多条 queued 领取时合并」（scheduler.coalesceQueuedRuns），先建该索引实测全量红 68 例（UNIQUE runs.bot_id），其激活须随 §5.2-2 入站合批改「入队合并」后同车落地，机制与存量串行化迁移已随第 1 步落地）。
- 子智能体不占 runs 行（其宿主子会话由宿主管理）：生命周期记入所属运行的 run_events（`subagent_spawned` / `subagent_result`，负载任务号标签与摘要）；用量由宿主归并进父会话后在 run 收尾随会话用量入账（归集口径在实施卡对账）。
- 交付报告归属不变：任务级幂等键 + `task_comments` 落库 + 卡转 `in_review`，报告本体属于任务卡而非会话。
- 任务卡状态机、工具面（team_assign_task / team_review_task / 评论/通知）不变。

### 4.3 保持不变的件

写范围判定纯函数与并行调度、死线规则（超线 queued 拒绝启动、run_events 留锚、重派重置窗口）、验收滞留三档收口、审批与提问机制、结转别名与运行归属索引、用量计价与对账管线、workspace 变更归因。

## 5 迁移方案（全面切换）

### 5.1 受影响功能清单

| # | 功能 | 现锚点 | 影响与去向 |
|---|---|---|---|
| 1 | 会话绑定与入站路由 | db-migrations `BINDINGS_DDL`/三索引；runs.ts `sessionKindFor` 与 enqueue 家族 | 统一解析 `kind='bot'`；四车道删除 |
| 2 | DM 与回信投递 | runs.ts `enqueueDmRun`（无条件 dm 车道）、dm_reply 忙 steer/闲排队 | DM 落控制面；dm_reply kind 删除 |
| 3 | 群聊运行 | chat 车道 enqueue、chatRunPrompt | 同一会话承接，提示词合并进控制面提示词 |
| 4 | 任务派发运行 | task-dispatch / task-runs、`one_active_run_per_task` | run 落 bot 会话；施工改子智能体 |
| 5 | 入站/出站合批 | scheduler `OUTBOX_COALESCE_KINDS`、`coalesceQueuedRuns`（含用户提问保护） | 机制保留，道改为 bot 会话单道 |
| 6 | 插话/通知注入 | task-notify 卡面变更 steer、task-runs 评论直通、notify 任务提醒、questions 应答 steer | 目标会话统一为控制面 |
| 7 | 交付与验收 | run-finish 任务级幂等键、in_review 转换、review 委派、review 看门狗、验收竞态终态 | 归属机制不变；运行来源字段适配 |
| 8 | 结转 rollover | alias 别名、`runs_session_idx` | 对象改为控制面会话；别名机制复用于旧道迁移 |
| 9 | 微信通道 | wechat 入站路由、solo-wechat-push、出站合批、指令/默认目标/peer 持久化 | 入站落控制面；出站治理保留，道重定 |
| 10 | solo 单聊 | solo_chat 运行、soloWorkspace、solo 提示词 | 并入控制面（origin=solo）；solo bot 即其控制面 |
| 11 | 死线 | scheduler `taskDeadlineInfo`、TASK_DEADLINE 拒启动 | 规则不变；拒启作用在 bot 会话排队运行上 |
| 12 | 滞留提醒 | notify 受阻滞留、review 看门狗滞留锚 | 不变；滞留锚取数路径适配单道 |
| 13 | 写范围闸门 | write-lock 判定块、并行放行逻辑 | 派发侧不变；执行侧新增子智能体继承（§2.4） |
| 14 | 提示词 | prompt.ts task/chat/solo 分支、subagent 指引段、prompt 预算 | 合成控制面提示词；静态前缀预算重核（现 ≤1900 红线） |
| 15 | 用量与归因 | runs 用量列、usage-reconcile、attributeWorkspaceChange | 口径适配子智能体并入；对账在实施卡核验 |

### 5.2 迁移顺序（同一发版火车内的实施卡序列，非功能开关）

1. **库与绑定收敛**：DDL/索引迁移 + 旧道 alias 化 + 每 bot 建 `kind='bot'` 行；`one_active_run_per_bot`。
2. **入站路由收敛**：enqueue 家族、sessionKindFor、DM/群聊/solo/微信入站全部解析控制面；合批道重定。
3. **任务子智能体化**：控制面提示词（接卡/开子智能体/写范围沙箱继承/交付模板）、子代理账本 run_events。
4. **收尾与治理适配**：run-finish 交付、review/看门狗、死线、滞留、steer/插话、微信出站、用量归因、结转。
5. **守门与回归**：测试重写与新增不变量守门（§5.3），全量绿后发版。

顺序依赖：2 依赖 1；3 依赖 2；4 与 3 可部分并行（不同文件面）；5 收口。每步都是可独立验收的实施卡，但合入同一版本发布——全面切换，不存在新旧并存的中间发布。实施勘误（DSHBOTS-285 实测）：`one_active_run_per_bot` 的激活点从第 1 步移至第 2 步——它与现行「领取时合批」语义冲突（同 bot 多条 queued 共存是现行合批前提），第 1 步仅落地机制（activateBotRunSerialization：存量串行化+建索引）与守门，第 2 步改「入队合并」后激活。

实施记录（DSHBOTS-288，owner 已拍板）：

- **顺序逆转（2 与 3 对调）**：第 3 步「控制面会话收敛」先行——ensureSession/sessionKindFor/bindingLaneKey/claimKey 统一解析 `kind='bot'` 控制面绑定（ensureBotBinding 兜底），删除 task/project/dm/solo 四车道建行；第 2 步「激活 one_active_run_per_bot + 入站路由收敛」随后收口。理由：bot 级唯一索引要求跨 kind 串行，先收敛会话可让争用设计只在「单控制面会话」上做，避免在四车道上先实现一遍再拆。
- **task-vs-chat 争用口径 A（待处理队列）**：bot 忙（存在 queued/running 运行）时到达的**消息**不落 runs 行，进入按 bot 维度的待处理队列（settings 持久化或内存实现）；bot 空闲后（运行收尾或下一拍 tick 检查挂起队列）把积压消息合批成一条运行。task 运行与消息互斥排队、不互相吞并：task/review 运行不被消息合批吞并；dm/dm_reply 按回信契约（一条来信一条回信）不参与合批。入队侧判定 bot 忙即挂起（不建 run 行，不撞 `one_active_run_per_bot` 唯一约束）。

### 5.3 回归策略（204 个测试源文件（+编译产物）/ 1534 例）

- **不动层**：纯函数与规则引擎测试——写范围判定、合批窗口/保护、死线数学、看门狗分级、计价对账、路径工具等，语义未变者原样保留。
- **重写层**：会话/绑定/车道夹具类——dm、run-coalesce、session-rollover、review-*、wechat-*、solo-*、任务派发类：按「单控制面会话 + origin 标记」模型重写断言（从「落哪条车道会话」改为「落 bot 会话 + origin 正确 + 串行/合批行为正确」）。
- **新增守门层**：不变量测试见 §6（每 bot 一会话、DM 落控制面、子智能体账本、并发未额外设限、旧车道零残留）。
- **逐项对应**（§5.1 清单 ↔ 测试处置）：

| §5.1 项 | 处置 | 对应测试面 |
|---|---|---|
| 1 路由 / 2 DM / 4 派发 | 夹具重写 | dm、任务派发类、绑定夹具 |
| 3 群聊 / 10 solo | 夹具重写 | solo-*、chat 类 |
| 5 合批 | 逻辑不动，道重定向 | run-coalesce、outbox-coalesce |
| 6 插话 | 断言重定向到控制面 | notify-tool、task-start-notify、questions 类 |
| 7 交付/验收 | 来源字段适配 | review-auto/delegate/watchdog/queue-final-state、run-finish 类 |
| 8 结转 | 对象改控制面 | session-rollover |
| 9 微信 | 道重定 | wechat-commands/default-target/notify/peers-persist、solo-wechat-push |
| 11 死线 / 12 滞留 | 规则不动 | task-deadline、review-watchdog |
| 13 写范围 | 纯函数不动 + 新增继承锚 | write-lock-state + 新增子代理继承例 |
| 14 提示词 | 重构守门 | prompt-budget、prompt-prefix-order、user-question-priority |
| 15 用量 | 对账口径适配 | usage 类 |
| 新增不变量 | 新增 | §6 V1–V5 守门 |
- **发版闸门**：全量 `npm test` 100% 通过才发版（沿用 CI publish 闸门与 Node22 glob 口径）。

## 6 验收标准（可测）

| # | 标准 | 判定方式 |
|---|---|---|
| V1 | 每 bot 一会话 | 集成测试：对同一 bot 相继触发群聊、私信、任务派发、单聊，断言其 `alias=0` 绑定恰 1 行且 `kind='bot'`；schema 测试断言新唯一索引存在、旧三索引已删 |
| V2 | DM 落控制面 | 测试：有运行中任务的 bot 收总监私信，断言无 `dm` kind 运行入队、消息落 bot 会话；内容被转交对应子智能体（账本/注入留痕） |
| V3 | 任务子智能体化 | 测试：派发后断言不新建任务会话绑定；run_events 含带任务号标签的 `subagent_spawned`/`subagent_result`；交付报告仍落 task_comments 且卡转 in_review；grep 断言 `dm:<bot>:<project>` 车道与任务绑定建行代码零残留 |
| V4 | 并发上限遵循宿主设定，本项目未额外设限 | 源码审查锚：断言插件源码无子代理并行上限常量、无项目侧计数/闸门逻辑，控制面提示词不含上限数字；宿主侧证据=宿主配置（家级 cordis patch `maxActiveSubagents`） |
| V5 | 全功能迁移零回归 | 全量 `npm test` 通过；§5.1 清单 15 项每项至少 1 例守门测试通过并在实施卡列出对应测试文件 |

## 7 风险与回退

### 7.1 风险与缓解

| 风险 | 评估 | 缓解 |
|---|---|---|
| 控制面上下文膨胀（全部车道挤一条会话） | 高 | 子智能体承载施工细节，控制面只留摘要与调度；定期结转重开控制面（alias 保历史解析）；合批窗口限制单轮注入量 |
| 单会话单点（会话卡死波及全部车道） | 中 | rollover 重开、运行取消/重试、死线与滞留守门照常兜底；排队运行不因会话故障丢失（runs 持久化） |
| 子智能体写越界（不受调度闸门约束） | 中 | §2.4 三层补偿；实施卡实验宿主子会话沙箱收窄，可行则升硬闸 |
| 提示词预算超限（多角色指引合并） | 中 | 控制面提示词按「静态前缀 + 按触发类型变化段」重构，守住预算红线并加守门测试 |
| 用量归集粒度变化（子智能体并入父会话） | 低 | usage-reconcile 对账口径在实施卡核验，偏差写进交付报告 |
| 并发行为随宿主版本/配置漂移 | 低 | 上限与超限语义以宿主为准，本项目不复制、不假设具体数值；文档与运维口径引用宿主配置为证 |
| 测试重写规模大 | 中 | §5.3 三层分类控制重写面；纯函数层不动 |

### 7.2 回退策略（全面切换下如何回退）

全面切换没有运行时开关，回退=发版级回退：①发版前对库做快照备份；②出问题时回退包版本（npm 版本钉扎/tag 回退）并恢复快照；③旧道绑定已 alias 化，旧版本代码按原逻辑遇无绑定会按需重建四车道，库内消息与运行留痕不丢。不做双写双读的并行期，回退窗口即下一个修复发版，代价已在拍板时接受。

## 8 结转与压缩（DSHBOTS-286）

单道收敛后全部车道流量挤一条控制面会话，轮次寿命需要补齐治理：结转阈值提到 512 轮并明确结转后的路由；新增 64 轮闲时总结压缩。

### 8.1 阈值与轮次口径

- 结转阈值 256→512：配置键 `session_rollover_turns` 不变（0=关闭，全局设置页可覆盖；生效链 env > 页面保存值 > 默认，src/config.ts `effectiveSessionRolloverTurns`）。
- 「轮次」口径 = runs 表按 session_id 的 `COUNT(*)`，不限 status——失败运行的提示词同样已进会话历史，count-all 才与真实增长一致（src/services/runtime/session.ts `shouldRolloverSession`）。

### 8.2 结转语义与 alias 幂等

- 512 轮结转 = 新任务/新会话走新 bot 控制面会话；旧会话绑定行 alias 化（alias=1 授权别名，DSHBOTS-256 机制：旧 session id 仍可解析历史归属，`runs_session_idx` 继续服务运行归属）。
- 摘要既有机制不变：达阈值先补排 `kind='rollover_summary'` 只读运行，bot 在旧会话自写交接摘要；就绪后下一次复用即结转，摘要经 `rollover_pending` 消费闸（DSHBOTS-213）由新会话首轮提示词注入（src/services/run-finish.ts 收尾写 settings、src/services/runtime/prompt.ts `rolloverSummaryBlock`）。
- alias 幂等：rollover 判定只作用于活跃绑定（alias=0）/活跃会话，alias 行永不触发结转——已结转旧会话即使因未终态任务继续承接流量、轮数继续增长，也不再二次结转。守卫位置在唯一调用点 `ensureSession` 的 `!existing.alias` 前置短路（DSHBOTS-288 删除了 `shouldRolloverSession` 内不可达的同义守卫死代码）。

### 8.3 结转后的任务亲和路由

结转只把绑定行 alias 化，runs.task_id→session_id 的历史归属不动。结转后的入站路由按任务归属判定，不能只靠活跃绑定推导任务归属：在跑/未终态（status 不在 done/canceled）任务的后续消息仍落其原会话（即使该绑定已是 alias 行）；新任务与终态任务不享亲和，无归属消息落活跃绑定（新会话）。

实现为显式的 runs 归属解析（`taskAffinityBinding`，src/services/runtime/session.ts）：取该任务最近一次运行的 session_id（`ORDER BY COALESCE(started_at, queued_at) DESC`），映射到其绑定行（含 alias 行）。解析顺序：

1. 活跃 task 绑定（alias=0）；
2. 未终态任务的 runs 归属解析（含 alias 行）；
3. 活跃 lane 绑定；
4. 新建会话。

与 DSHBOTS-285 单绑定模型（`kind='bot'`，每 bot 恰一条 alias=0 活跃绑定，§4.1）共存：单绑定只决定「新流量」的家；任务亲和优先级高于活跃绑定，未终态任务消息据此回到旧会话。

### 8.4 64 轮闲时总结压缩

- 新增配置 `session_compact_turns`（默认 64，0=关闭，可覆盖；生效链同 §8.1，src/config.ts `effectiveSessionCompactTurns`）。
- 触发：会话复用时轮次跨过 64 倍数边界且会话闲（该会话除当前运行外无其他 queued/running 运行）→ 入队 `kind='session_compact'` 只读总结运行，回原会话执行（src/services/runtime/session.ts `maybeCompactSession`）。
- 机制形态复用 rollover_summary：trigger_ref=session_id、幂等键 `session_compact:<sessionId>:<window>`、窗口标记 `session_compact_marker:<sessionId>` 存 settings（src/config.ts）。
- 忙时推后：窗口标记不动，待下次复用且闲时再判；跨多个窗口合批为一次。
- 生效面：对仍在承接流量的会话生效——含旧会话上未终态任务产生的流量，即 alias 会话也可被压缩触发。
- 压缩≠结转：压缩后留原会话，不 alias 化绑定、不写 rollover_pending；窗口标记在入队时推进到窗口下界，运行失败不回退，由下一窗口再补。

### 8.5 宿主能力调查（证据）

- `ctx.sessionController` API 面无压缩/截断方法。证据：宿主类型声明 `node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/index.d.ts`（SessionController：create/resolveAgent/selectModel/prompt/cancel/fork/rename/events/wait/…，无一压缩或截断项）；本仓库 src 的用法即其中 create/resolveAgent/selectModel/prompt/cancel（src/services/runtime/session.ts、lifecycle.ts、notify.ts）。
- 宿主另有独立压缩缝隙 `ctx.compaction: CompactionEngine`，与 sessionController 同以 cordis Context 增强声明（宿主安装根 /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/ 下 `node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts`）：`compactNow`（闲时显式压缩，把有用历史区间替换为一个总结节点）、`compactRegion`（按区间强制折叠）、`compactIfNeeded`（压力自动策略）；实现为 `BasicCompactionEngine`（`@deepseek-ai/dsh-compaction-basic`），人命令 `/compact`（`@deepseek-ai/dsh-command-compact`）即架在此缝上。它属上下文窗口层的「区间折叠为总结节点」，不是截断丢弃。
- 截断式 API 无：grep `truncat` 在宿主自有包（宿主 lib/ 与 @deepseek-ai/*）零命中，仅 @types/node 等三方 SDK 类型文件命中，与插件无关。
- 落地口径：session_compact 仍为原会话内的总结运行——bot 自写连续性总结并借机把持久事实落入记忆/任务评论，会话历史本体不截断；真正的上下文重置仍是 512 轮结转。宿主 `compactNow` 缝隙即 session_compact 运行收尾处可选的接入点（插件 ctx 运行时可达性在实施卡实测后接入）。
