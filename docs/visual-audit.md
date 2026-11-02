# DSHBOTS-60 全站视觉走查报告（明暗两套）

- 走查日期：2026-11-02
- 预览环境：`PORT=4317 npm run dev`（scripts/dev-server.js 本地预览，fake runtime）
- 造数：AUD 前缀项目 `prj_9136b9ede3a3409a9b0599e1`（6 成员、6 条群聊消息、5 个任务含父子/依赖、3 条 solo 消息、1 条 pending 审批卡片、12 次 run 产生真实用量数据），验完已清理。
- 截图：`.preview/audit/`（不入库），共 28 张，命名 `{light|dark}-<视图>[-变体].png`。
- 方法：`.dev/shot.mjs`（CDP headless，1440×900@2x，prefers-color-scheme 模拟），图片缩略条通过 DataTransfer 注入文件触发；归档抽屉/归档项目设置通过先归档再点击抽屉进入。

## 结论

未发现 P0（功能受损）问题。主要问题集中在任务面板的关系呈现缺失与成员卡片的间距失衡。

## 问题清单（按严重程度排序）

### P1-1 任务面板：已完成任务不显示、顶部计数与实际不符
- 视图：任务（tasks）
- 截图：`.preview/audit/light-tasks.png`、`.preview/audit/dark-tasks.png`
- 现象：数据库中存在 1 条 done 任务，但「已完成」分组计数为 0、列表无该任务；头部统计「4 任务」而项目设置页显示任务总数 5（`light-settings.png`）。各分组计数之和（1+2+1+0+0+0+0=4）与头部一致，说明是分组查询把 done 任务整体漏掉了，不是过滤口径差一。
- 建议修法：核对任务面板分组树的 status 查询条件与「已完成」组的匹配值（怀疑 done 与组键不一致，或被时间过滤条件错误拦截），并让头部总数 = 各组计数之和 + 漏组兜底提示。

### P1-2 任务面板：父子与依赖关系零视觉呈现
- 视图：任务（tasks）
- 截图：`.preview/audit/light-tasks.png`（AUD-4 同时带 parent_task_id 与 blocked_by，仍平铺在「待执行」组）
- 现象：子任务无缩进、无父任务标识；被依赖阻塞的任务无「被 N 个任务阻塞」徽标，也不进入「受阻」组（受阻组计数 0）。
- 建议修法：按 D-58 计划落地父子缩进与阻塞徽标；至少在行内加 `父：AUD-3` / `阻塞：AUD-5` 的文字标记。

### P1-3 成员 tab：成员卡片高度异常、中部大片空白
- 视图：成员（members）
- 截图：`.preview/audit/light-members.png`、`.preview/audit/dark-members.png`
- 现象：头像/名称/模型行与底部「空闲·合计 tokens·成本」之间有约 300px 垂直空白，明暗两套一致，整页被撑到 2576px 高。疑似固定 min-height 或空占位元素。
- 建议修法：移除成员卡的固定高度（或空占位），让卡片按内容自适应，底部元信息紧随内容。

### P1-4 任务面板：空分组保留大块竖向空白
- 视图：任务（tasks）
- 截图：`.preview/audit/light-tasks.png`（受阻/待验收/已完成/已取消四组为 0）
- 现象：空组虽计数为 0，但组与组之间保留了 ~70–90px 的空行区域，页面下半段几乎全是空白。
- 建议修法：空组只保留一行组头（或默认折叠），去掉占位空白。

### P2-1 图片输入缩略条：缩略图内文件名溢出、删除按钮遮挡
- 视图：群聊 · 输入框图片缩略条
- 截图：`.preview/audit/light-chat-images.png`、`.preview/audit/dark-chat-images.png`
- 现象：56px 缩略图内直接渲染文件名，长名断行成两行并溢出裁切（显示 `audit-ligh t-`），删除按钮叠在缩略图左上、与文字重叠。
- 建议修法：缩略图内不渲染文件名（文件名移到 tooltip 或缩略条下方的一行），删除按钮挪到缩略图右外角或悬停时显示。

### P2-2 群聊：右栏成员计数与头部口径不一致且未标注
- 视图：群聊（chat）
- 截图：`.preview/audit/light-chat.png`
- 现象：头部「6 个成员」、右栏「项目成员 5」，右栏口径是剔除总监，但两处都没有说明，容易被当成计数 bug。
- 建议修法：右栏计数旁注明「不含总监」，或统一为同一口径。

### P2-3 成员卡片：状态行语义重复
- 视图：成员（members）
- 截图：`.preview/audit/light-members.png`
- 现象：每张卡显示「空闲」「空闲中」两行绿点状态（run_status 与 busy 两个来源），语义重复且无法区分。
- 建议修法：合并为单一状态行；如需保留两级，第二级应换更弱的样式（如灰色文字）以区分主次。

## 明暗主题与对比度核对（无新增问题）

- 审批卡片（`light-chat.png` / `dark-chat.png`）：明暗下「允许一次 / 拒绝」按钮对比度均清晰，状态描边一致。
- 用量统计（`light-usage.png` / `dark-usage.png` / `*-usage-domain.png`）：全局与本域两组卡在暗色下层次清晰，图表单色柱与表格数字对比度足够。
- 终端（`light-terminal.png` / `dark-terminal.png`）：暗色下终端面板底色与页面底色差异偏小但输入区有描边区分，可接受。
- 归档抽屉与归档项目设置（`*-chat-archived-drawer.png` / `*-chat-archived-settings.png`）：侧栏「已归档」分组、「移除追踪 / 项目再开」按钮明暗渲染一致。
- 全局配置（`light-global.png` / `dark-global.png`）：无异常。

## 覆盖清单

| 视图 | 明 | 暗 |
| --- | --- | --- |
| 群聊 chat | light-chat.png | dark-chat.png |
| 审批卡片弹层（聊天内嵌） | light-chat.png | dark-chat.png |
| 图片输入缩略条 | light-chat-images.png | dark-chat-images.png |
| 单聊（director） | light-chat-solo-director.png | dark-chat-solo-director.png |
| 单聊（artist，含 solo 消息） | light-chat-solo-artist.png | dark-chat-solo-artist.png |
| Bot 配置 solo-config | light-solo-config.png | dark-solo-config.png |
| 任务面板 tasks | light-tasks.png | dark-tasks.png |
| 成员 members | light-members.png | dark-members.png |
| 用量·全局 usage(global) | light-usage.png | dark-usage.png |
| 用量·本群 usage(domain) | light-usage-domain.png | dark-usage-domain.png |
| 终端 terminal | light-terminal.png | dark-terminal.png |
| 项目设置 settings | light-settings.png | dark-settings.png |
| 归档抽屉 | light-chat-archived-drawer.png | dark-chat-archived-drawer.png |
| 归档项目设置（再开/移除） | light-chat-archived-settings.png | dark-chat-archived-settings.png |
| 总览bots bots-overview | light-bots-overview.png | dark-bots-overview.png |
| 全局配置 global | light-global.png | dark-global.png |

## 环境备注（非 UI 问题）

走查期间发现 `scripts/dev-server.js:50-52` 在 task 型 run 回包时 `project` 可为 null 导致预览服务崩溃（TypeError: Cannot read properties of null (reading 'name')），已做最小判空修复以完成走查；该修复属 dev 预览脚本，与 ui/src 车道无冲突，建议后续单独评审是否合入。
