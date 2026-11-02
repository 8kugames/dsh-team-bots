# 并行调度使用说明（写范围 / write scopes）

面向派单者（人和 bot 通用）：怎么让同项目的两个写任务真正并行，怎么写声明，怎么确认真的并行了。

调度器闸门实现在 `src/services/scheduler.js` 的 `tick()`（约 252–333 行），判定函数在 `src/services/write-scopes.js`。本说明描述的是当前已上线的真实行为，与 `scripts/verify-parallel.mjs` 的可复跑验证一一对应。

## 1. 什么时候会并行

同项目两条**写运行**同时放行，必须同时满足：

1. **同一个项目**：两条 run 的 `project_id` 相同（同一工作目录才需要防撞）。
2. **都是写运行**：`runs.mode = 'write'`。任务运行（`kind='task'`）固定是 write。
3. **双方都声明了写范围**：任何一侧为空集合（未声明）即视为冲突。
4. **路径前缀互不重叠**：按**路径分段**比较——两条路径相等，或一方是另一方的目录前缀（`src/ui` 与 `src/ui/app.js` 重叠；注意 `ui/module` 与 `ui/modules` 是**不同目录**，不重叠）。

满足全部四条 → 后放行的那条 run 会落一条 `run_events.type='run_parallel'` 事件（先放行的不会有，因为它放行时同项目还没有在跑的写运行）。

### 什么情况退化成串行

- 任一侧未声明写范围（空集合）——保守串行，安全边界不因并行能力而削弱。
- 双方都声明了但范围重叠。
- 全局并发已满：`DSH_TEAM_MAX_RUNS` 默认 6（`src/config.js`，允许 1–16）。
- 同一条任务同时只允许一条活跃运行（库内唯一索引），重跑/重试不走并行。
- 派单后要等调度节拍（默认 1.5s 一个 tick）才会出队，别把「没立刻跑」当成「没并行」。

只读运行（群聊 chat、私信回信 dm_reply、总监验收 review）不走写闸门，不挡写运行，也不被写运行挡。

## 2. 怎么声明写范围

两个入口，二选一：

- **派单工具参数**：`team_assign_task` 传 `write_scopes: ["ui/modules", "src/db"]`（仅新建任务时生效）。
- **任务描述兜底**：描述里写一行（必须行首），未传参数时才解析：
  ```
  写范围：ui/modules, src/db
  write_scopes: ui/modules, src/db
  ```
  中英文冒号均可，逗号 / 顿号 / 中文逗号分隔；多条命中取第一条；行首匹配是为了不误伤正文里顺带提到的词。

路径规则（非法项直接报错，不静默降级）：

- 工作区相对路径；拒绝绝对路径和含 `..` 的路径。
- 目录写前缀即可（如 `ui/modules` 覆盖该目录全部内容）；`./`、尾部 `/`、`\` 会被归一化。
- 上限 50 条，单条 ≤ 240 字符；重复项自动去重。
- 显式传空数组 = 明确不声明 = 串行。
- 写范围在**入队时快照**进 `runs.write_scopes`；之后改任务声明不影响已排队的运行。

## 3. 范围要写准

写宽了白白挡住别人（本可并行的任务被你一个过宽前缀串行化），写窄了会和别人撞车（实际改的文件超出声明，闸门放行了本该挡住的碰撞）。

正例：

1. 改 UI 组件，同事在动数据库：`写范围：ui/modules`，与同事的 `src/db` 天然不重叠，并行。
2. 单文件精确声明：改调度器就写 `src/services/scheduler.js`，与声明 `src/services/write-scopes.js` 的任务并行互不挡。
3. 新增独立目录：新脚本任务声明 `scripts/`，文档任务声明 `docs/`，两条并行。

反例：

1. 【写宽】只改一个页面却声明 `写范围：ui`——所有动 `ui/` 下任何文件的任务都被串行化。
2. 【写窄】要同时改 `ui/app.js` 和 `ui/styles.css`，只声明 `写范围：ui/app.js`——若另一任务声明了 `ui/styles.css`，闸门放行两条并行，实际却在同一目录互相覆盖。

## 4. 怎么确认真的并行了

生产库默认在 `~/.dsh/workspace/team-bots/.data/team.sqlite`（受 `DSH_HOME` / `DSH_TEAM_DATA` 影响）。直接粘贴：

```bash
# 同项目在跑的写运行（把 <项目id> 换成实际值；出现两条即并行）
sqlite3 ~/.dsh/workspace/team-bots/.data/team.sqlite "
SELECT r.id, r.task_id, r.bot_id, r.write_scopes, r.started_at
FROM runs r
WHERE r.status = 'running' AND r.mode = 'write' AND r.project_id = '<项目id>'
ORDER BY r.started_at;"

# 并行放行事件（只落在「放行时同项目已有在跑写运行」的那条上）
sqlite3 ~/.dsh/workspace/team-bots/.data/team.sqlite "
SELECT e.run_id, e.message, e.created_at FROM run_events e
WHERE e.type = 'run_parallel' ORDER BY e.created_at DESC LIMIT 20;"

# 排查某任务为何没并行：看它运行快照里声明的范围是否为空
sqlite3 ~/.dsh/workspace/team-bots/.data/team.sqlite "
SELECT id, status, write_scopes FROM runs WHERE task_id = '<任务id>' ORDER BY queued_at;"
```

判读：两条同项目 write 同时 `running`，且后启动那条带 `run_parallel` 事件 = 真并行。`write_scopes` 是 `[]` 或空串 = 未声明 = 串行兜底，这是声明缺口不是闸门故障。

## 5. 已知限制

- **单聊运行不占项目锁**：`solo_chat` 的 `project_id` 为空，写在自己独立的单聊目录，不参与项目级写闸门。
- **老任务不会自动并行**：历史任务 `write_scopes = []`，调度按保守串行处理。补声明必须**新建任务**时带上（工具参数或描述行）——用 `team_assign_task` 的 task 参数重派旧任务不会更新写范围。
- 闸门只按声明防撞，工作区是共享的：并行双方仍应做路径限定提交，动共享文件（`package.json` 等）前先协调。

## 6. 可复跑验证

```bash
node scripts/verify-parallel.mjs
```

脚本用临时库 + 假 runtime 走真实 `tick()`，不碰生产库、不入测试套件；四个用例全过退出码 0，任一失败退出码 1：

| 用例 | 场景 | 预期 |
| --- | --- | --- |
| ① | 两条不相交写范围 | 同时 `running=2`，第二条有 `run_parallel` 事件 |
| ② | 相交写范围 | 只跑 1 条（先入队者），另一条排队 |
| ③ | 一侧未声明 | 只跑 1 条 |
| ④ | 两侧都未声明 | 只跑 1 条 |

实测输出（2026-11-02，11 项检查全部通过，exit 0）：

```
[PASS] 用例① 不相交写范围→并行 (A=["src/ui/"], B=["src/db/"]) — 同时 running=2
[PASS] 用例① 不相交写范围→并行 (A=["src/ui/"], B=["src/db/"]) — 第二条 run_parallel 事件
[PASS] 用例② 相交写范围→串行 (A=["src/ui/"], B=["src/ui/app.js"]) — 只跑 1 条且是先入队的 A
[PASS] 用例② 相交写范围→串行 (A=["src/ui/"], B=["src/ui/app.js"]) — B 保持排队
[PASS] 用例② 相交写范围→串行 (A=["src/ui/"], B=["src/ui/app.js"]) — 无 run_parallel 事件
[PASS] 用例③ 一侧未声明→串行 (A=["src/ui/"], B=[]) — 只跑 1 条且是先入队的 A
[PASS] 用例③ 一侧未声明→串行 (A=["src/ui/"], B=[]) — B 保持排队
[PASS] 用例③ 一侧未声明→串行 (A=["src/ui/"], B=[]) — 无 run_parallel 事件
[PASS] 用例④ 两侧都未声明→串行 (A=[], B=[]) — 只跑 1 条且是先入队的 A
[PASS] 用例④ 两侧都未声明→串行 (A=[], B=[]) — B 保持排队
[PASS] 用例④ 两侧都未声明→串行 (A=[], B=[]) — 无 run_parallel 事件
RESULT: 11/11 PASS
```
