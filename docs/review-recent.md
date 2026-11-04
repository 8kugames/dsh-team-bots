# 近期任务复核与查缺补漏（DSHBOTS-138，2026-11-04）

只读审计。复核范围：近两天已关单 D-115/116/121/122/128/129/130/131/132/133/135/136/137 的挂账遗留项；生产库 `.dev/data/team.sqlite` 只读抽查；第一波三卡（D-135/136/137）接口交叉核对。所有结论均附 file:line 或 SQL 证据，工作树未触碰 src/ ui/ tests/。

基线：HEAD `a06554e`（D-137 交付），工作树存在他人在途改动 `src/usage.js`（本次未触碰）。

## 1. 挂账遗留项逐条核对

### a. D-106 挂账：删除密钥弹窗旧 .team/secrets.env 文案 —— 已收口

- `ui/app.js:5145` 现文案为「删除密钥 ${name}？相关项目已下发的一次性运行时副本会立即失效，重新使用需再次申请。」，不再提旧路径；`ui/app.js` 全文已无 `secrets.env` 匹配（grep 全仓 32 处命中仅 src/tests，无 ui/app.js）。
- 守门测试已钉住：`tests/approval-ui-states.test.js:189-195`（doesNotMatch `/\.team\/secrets\.env/` + 断言新文案两个要素）。
- 落地 commit `6d554d9`（D-108「密钥删除文案改口径」）。

### b. D-129 挂账：时效 hint「软性时限」在 D-131 硬中止后同步 —— 已收口

- `ui/i18n/zh.js:205`：`'task.timeBudgetNote': '硬性时限：到期运行将被中止；与全局运行超时取更短者'`；`ui/i18n/en.js:206` 同口径英文。
- 两个消费点同键：`ui/app.js:3437`（新建任务表单）与 `ui/app.js:3588`（任务详情 hint）均走 `t('task.timeBudgetNote')`，无硬编码旁路。
- `ui/` 全目录 grep「软性 / soft limit」零命中；`tests/task-time-budget-ui.test.js:96-100` 钉住渲染结构与中文文案。
- 落地 commit `b25e554`（D-131 本体，i18n 属其范围外延）。

### c. D-127 挂账：dev-server MIME 无测试守门 —— 未收口（低危，建议顺手修）

- `scripts/dev-server.js:113-114`：STATIC_SLICES 命中后统一硬编码 `'text/javascript; charset=utf-8'`，无按扩展名的 MIME 推断（app.js/modules/fonts 各自硬编码，`:102/:105/:110`）。
- `tests/dev-server-static-routes.test.js` 三例只锁：切片表内容（:23-29）、目标文件非空（:31-36）、线上路由注册（:38-42）——无任何 Content-Type 断言。
- 当前切片表仅 .js 条目（`scripts/dev-server.js:21-25`），事实正确；风险仅在将来加入非 .js 切片时静默错 MIME 且测试不红。
- 建议：P2 顺手修——在该测试加一行「所有切片目标以 .js 结尾」断言即可守住；不值得做完整 MIME 映射。

### d. D-102 挂账：approval-ux 1 个 test() 含 3 场景拆分 —— 已收口

- `tests/approval-ux.test.js` 现为 10 个单场景 test()（:71/:103/:127/:132/:163/:172/:182/:208/:215/:232）；文件由 e21e947（D-113）重建为 8 例单场景结构，后续增至 10 例。
- 残余：`:71` 例在一个 test() 内串「聚合断言 + 决策一条后收敛断言」两组，属同一连贯流程（建两条 → 验聚合 → 决一条 → 验收敛），粒度可接受——建议不修（P2）。

### e. D-107 挂账：review_delegate 拼任务全文顶爆 400 —— 主体已收口（D-113），同族分支有残余缺口【新发现 P1】

已收口部分：

- `src/services/runtime/prompt.js:363-368`：review_delegate 分支对 task.description 做 8K 字符截断并注明盲区（注释引 DSHBOTS-113、事故 m_33bddb），落地 commit `19563c4`。
- 评论侧天然有界：`prompt.js:336-343` 每条截 800 字符、限最近 5 条。
- 生产验证：现库 `SELECT count(*) FROM runs WHERE error_message LIKE '%max length%' OR error_message LIKE '%Prompt%'` = 0，重建后未复发。

残余缺口（P1，建议立卡）：

- `src/services/runtime/prompt.js:394`（owner review 分支）与 `prompt.js:411`（handle 分支）仍 `${task.description}` 全量拼接、无截断——同为「任务全文进提示词」表面，长描述任务走 owner 验收或故障处理时是同族 400 风险。
- 建议方案：把 8K 截断逻辑从 review_delegate 分支提为 promptFor 顶部助手（与 `timeBudgetBlockFor`（:348）同位），三分支共用；截断点维持 8K 字符与 D-113 口径一致；保底字段 = title / status / write_scopes（天然短）+ 截断后 description + threads（已有界）。

### f. 旧共享板 task-4/5/6 转正式卡情况

- task-4 弹窗闪烁解耦 —— 已收口（D-111，commits `1c73930`+`eead6d3`）：`ui/app.js:3103` 遮罩期取数但不重建、记 pending；`tests/modal-layer.test.js:250` 断言遮罩开着时整页重建次数为 0。
- task-5 终态运行徽标守卫 —— 已收口（D-137，`a06554e`）：`src/services/task-stage.js:17` 终态一律 ended；`tests/task-stage-ui.test.js:15-25` 断言终态不渲染 chip 与运行点。
- task-6 已完成任务驳回退 backlog —— 未收口：`src/services/tasks.js:27` `TRANSITIONS.done = new Set(['todo'])`，无 done→backlog 路径；现有回流语义是 done→todo（重新派单）。需产品裁定驳回已完成任务应回 todo（现状）还是 backlog（旧板意图）；建议立裁定卡或显式关闭（P2）。

## 2. 生产库抽查（`.dev/data/team.sqlite`，只读）

时间背景：11-01 崩溃后重建库，runs 时间窗 2026-11-02~03。

- 最近 30 条 runs（按 ended/queued 降序）：全部 succeeded、attempt=1、error_code 空——chat mention / memory_review / solo_chat 混排。
- 全表状态分布：`succeeded|(none)|95`，仅此一行。**无 SUPERSEDED、无 failed 终态运行、无 stale 残留**。
- retry/plan_wait：`retry_after_ms` 非空计数 0；无 plan_wait 状态运行。**无溢出**。
- outbox：仅 chat_run(43)/solo_chat_run(13) 且全 delivered、attempts≤1；无 review_delegate_auto 行、无 defer 痕迹（符合预期：defer 首个触发方是未来卡 E）。
- artifacts：`runs.artifacts` 非空计数 0；run_events 有 1 条 `artifacts_skipped`（「项目工作区不是 git 仓库，跳过产物记录」）——**gitignore 产物误收无复发**，守门逻辑在正常拒绝。
- 【新发现 P2·数据卫生】run_events 存在 5 条孤儿事件（run_id=`run_dsh66_audit`，runs 表无此行）：failed×2（「超过 20 分钟没有任何进展，已中止」，与 `src/services/scheduler.js:286` 停滞守卫文案一致）+ recovered×1 + artifacts_skipped×1 + succeeded×1，时间 2026-11-03 00:45~00:53。src 无生成含 `dsh66` 字样 id 的代码路径（grep 零命中），来源无法归因（疑似手工/脚本插入）。该孤儿 succeeded 事件同时解释了 succeeded 事件 96 vs runs 95 的差 1。run_events 无外键约束故孤儿可存在；taskView 按 task_id 查询不受影响。建议不修；如在意可做一次性清理。
- 抽查边界如实记录：崩溃前备份 `.dev/data.crashed-solo/team.sqlite.bak-20261101-1136` 复制三件套到 /tmp 后 runs 表 0 行（WAL 未能随改名恢复），**崩溃前历史无法抽查**。

## 3. 第一波三卡接口交叉核对

### D-137 waiting 预留位 × D-136 defer 通道（卡 E 口径）——咬合一致，无漂移

- waiting 只占枚举与标签位（`src/services/task-stage.js:9`、`:44`「后台等待」），判定表恒不返回（`task-stage.js:16-31` 无 waiting 行）。
- defer 通道（`src/services/scheduler.js:86-106`）：`error.defer === true` 走「不是失败」——不动 attempts、不进 5 次上限、available_at 沿退避曲线前移（上限 60s）、logger.info 留痕。
- 两者当前都无生产触发方（SQL：outbox 无 defer 痕迹、无 review_delegate_auto 行）——与记忆口径「首个触发方是机制②（卡 E）」一致。
- 接入点清晰：卡 E 落地时投递管道抛 `defer:true` 错误 + taskStage 判定表加 waiting 派生行。建议卡 E 验收标准写入三件事：①waiting 派生行；②defer 抛点；③`OUTBOX_COALESCE_KINDS`（`scheduler.js:44`，现仅 review_delegate_auto）是否需要为卡 E 的 kind 扩白名单。

### task-stage × scheduler 内联判定 —— 代码层一处守卫不对称，生产无碰撞实例

- 【新发现 P2】守卫不对称：入队侧 `queueAutoReviewDelegate`（`src/services/runs.js:530`）在 attentionPending 时跳过自动核验委派（「先让 owner 答话」）；但投递侧复看闸 `spawnReviewDelegate`（`src/services/tasks.js:714-728`）只复查 in_review + owner 可用 + one_active，**不复查 attention**。若 outbox 行 pending/退避期间任务落下待答提问，投递时仍会派出核验运行，而 UI stage 已按 `task-stage.js:19`（attention 优先于 :21 的 in_review）显示「等待你回答」。窗口窄（仅自动委派重试期间落入提问）、核验运行 read-only 无害；建议下次动 tasks.js 时顺手补一行 attention 复查，或并入卡 E。
- 生产实算（node 跑 `taskStage` 纯函数 × SQL 取 9 个在库任务，latestRun/attention 均空）：in_progress×2→idle、todo×4→queued、blocked×1→person/blocked、backlog→idle、done→ended。与 scheduler 事实一致（无排队运行、无 SUPERSEDED）。现库无 in_review 任务、runs 无 task 类运行（`SELECT count(*) FROM runs WHERE task_id IS NOT NULL` = 0）——**两口径在生产库无碰撞实例**，P874/P540 系手工造数。

## 4. 问题分级汇总与处理建议

| 级别 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| P0 | （无） | — | — |
| P1 | owner review / handle 分支任务全文无截断，同族 400 风险 | `src/services/runtime/prompt.js:394`、`:411` | 立卡：提取 8K 截断助手三分支共用 |
| P2 | dev-server MIME 无守门 | `scripts/dev-server.js:114`、`tests/dev-server-static-routes.test.js` | 顺手修：测试加一行 .js 后缀断言 |
| P2 | done→backlog 路径缺失（旧板 task-6 意图未落） | `src/services/tasks.js:27` | 立裁定卡或显式关闭 |
| P2 | spawnReviewDelegate 投递侧不复查 attention | `src/services/tasks.js:714-728` vs `src/services/runs.js:530` | 顺手修或并入卡 E |
| P2 | run_events 5 条孤儿（run_dsh66_audit，来源无法归因） | SQL：orphan 计数 5 | 不修（无功能影响），可选一次性清理 |
| P2 | approval-ux :71 例两组断言合并 | `tests/approval-ux.test.js:71-100` | 不修（粒度可接受） |

## 5. 总结

挂账 6 项中 4 项已被后续卡真正收口（a→D-108、b→D-131、d→D-113、e 主体→D-113；f 的 task-4→D-111、task-5→D-137）；未收口 2 项（c MIME 守门、f task-6 裁定）+ e 的同族残余缺口（P1，已立卡）+ 投递侧 attention 复查（P2，已立卡）。生产库干净：无异常终态、无 retry/plan_wait 溢出、无产物误收复发；唯一数据卫生点为 5 条无法归因的孤儿事件。第一波三卡（D-135/136/137）相互接口咬合一致，卡 E 接入清单已列。
