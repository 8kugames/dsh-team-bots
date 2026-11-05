# 全局配置页美术重设计规格（DSHBOTS-184）

状态：已落地（视觉稿 + 明暗双主题实现稿）。功能迁移仍在 programmer 车道，本卡只出方案与视觉。
改动文件：`ui/modules/settings.js`（结构改动，已在卡面报备）、`ui/styles/global-config.css`（新域文件）、`src/http.js`（UI_STYLE_PARTS 登记）、`tests/styles-split.test.js`、`tests/global-config-layout.test.js`。

## 1. 问题定义

盘点结论（只读取证已核）：

- 9 个功能块混排一页：界面偏好、DSH 路径、DSH 服务、团队统计、运行时效、系统运维、微信通道、API 密钥、模型价格。
- 版式：顶部 12 列网格塞 3 张 1/3 宽小卡，下方全宽长卡纵向堆叠；没有页面标题，也没有分组导航。
- 保存入口 5 处分散，且五种性质完全不同的内容（偏好 / 路径 / 运维 / 密钥 / 价格）挤在同一视觉层级里。
- 交互问题：memory_review 假开关、缺 chat_memory_review 控件、原生 confirm、保存反馈只有 toast、整页文案未 i18n。

美术侧要解决的是前三项：**让读者知道「这一页有什么、按什么分组、谁归谁管」**，并把「本页常设」与「计划迁走」的模块在视觉上分开。交互项属功能车道，见第 8 节。

## 2. 信息架构：四组 + 一个指标带

页面骨架（自上而下）：

```
页头 global-head      eyebrow + 标题 + 说明 + 团队指标带（横向 5 格）
导航 global-nav       sticky 锚点条：偏好 / 运行与预算 / 环境与版本 / 接入与计价
分组 gsec × 4         序号 + 组标题 + 组说明 + 模块计数 + 组内 12 列槽位
```

分组表：

| # | 分组 | 组内模块 | 去向 |
|---|------|----------|------|
| 01 | 偏好 | 界面（字号 / 配色 / 通知 / 语言） | **留本页** |
| 02 | 运行与预算 | 运行时效、系统与运维 | **留本页** |
| 03 | 环境与版本 | DSH 路径、DSH 服务 | **待迁移** → 「关于」页 |
| 04 | 接入与计价 | 微信通道、API 密钥、模型价格 | **待迁移** → 「通道」「密钥」「用量」页 |

指标带承载原「团队与资源」卡（活跃 Bot / 群聊项目 / 共享技能 / 待审提案 / 模型价格规则）。它不是配置项而是概览，因此从「卡片」降级为页头的一条指标带，并在带尾注明「与「总览」页重复，计划迁出本页」——既立刻消除重复卡，也把去重意图标在明处。

分组依据是**变更频率与责任域**的混排降噪：偏好=本机外观、运行=运行时行为、环境=本机安装态、接入=外部依赖与计价。这四组恰好对应四种典型的「谁来改、什么时候改」，读者不必再靠卡片顺序猜。

## 3. 布局网格

- 组内容器 `.gsec-body`：`grid-template-columns: repeat(12, minmax(0,1fr))`，列间距 16px。
- 卡片由「槽位」包裹，槽位决定跨列，卡片自身结构不动（价格卡在 `ui/modules/modal-forms.js`，不在本卡写范围，因此用槽位 + CSS 伪元素兜住）：
  - `.g-slot--full`（1/-1）、`.g-slot--two-thirds`（span 8）、`.g-slot--half`（span 6）、`.g-slot--third`（span 4）。
- 实测（1440 宽视口、内容区 1200px）：半栏 564px、2/3 栏 757px、整栏 1144px。
- 同行卡片**等高**：槽位 `align-items: stretch` + 槽位内卡片 `flex: 1`，底边对齐而非参差。
- 窄屏：≤860px 时所有槽位塌成单列，界面卡内部的两列字段也塌成一列；≤1080px 时页头指标带从右侧移到标题下方。

## 4. 卡片层级与留白节奏

- 页头卡片：padding 22/24/20，圆角 14px，`--surface` + `--shadow-card`。
- 分组头：序号（mono 12px，强调色）· 标题（`--fs-title` 600）· 说明（`--fs-small`，`--ink-3`）· 右侧模块计数（`--fs-caption`），下压一条 1px 分隔线。
- 卡片：沿用既有 `.form-card`（padding 18/20、圆角、边框），只把卡头下边距压到 14px、去掉外边距残留。
- 界面卡内部：`.g-fields` 两列字段网格（字号 / 配色 一行，通知 / 语言 一行），底部 `.g-foot` 用一条上边线分隔「说明 kv + 保存按钮」。
- 间距刻度统一在 4 / 8 / 12 / 16 / 20 / 24 / 26 / 32：组间距 26px，组头到内容 16px，卡间距 16px，字段间距 16/24px。
- 迁移标记 `.g-move-note`：卡内底部的虚线分隔条，`--fs-caption`、`--ink-3`。文案统一用「计划迁移 · 目标页」，不写成「已迁移」——迁移尚未发生，措辞必须如实。

## 5. 视觉规范

- 颜色一律走 `ui/styles/base.css` 的 token（`--surface` / `--line` / `--ink` / `--ink-3` / `--accent` / `--accent-wash` / `--accent-text` / `--shadow-card`），本域文件**不写死任何色值**（守门断言：剥离注释后无 hex 字面量）。暗色（`prefers-color-scheme: dark`）与 Catppuccin 调色板因此自动成立。
- 导航条用 `color-mix(in srgb, var(--surface) 92%, transparent)` + `backdrop-filter: blur(10px)`，滚动时保持分组可见。
- 锚点命中高亮用 `.global-page:has(#g-xxx:target)` 选中对应导航条目（`--accent-wash` 底 + `--accent-text` 字）。
- 焦点态统一 `outline: 2px solid var(--accent)`。

## 6. 明暗双主题自查

取证：`scripts/dev-server.mjs` 预览服务（PORT 4318）+ Chrome headless CDP（`Emulation.setEmulatedMedia` 切 `prefers-color-scheme`，`--force-dark-mode` 无效），1440×1000 视口，整页截图 1440×2749。

- 明色：[global-config-light.png](../assets/global-config-light.png)
- 暗色：[global-config-dark.png](../assets/global-config-dark.png)

对比说明：

1. 两版共用同一套 DOM 与同一份 CSS，色差全部来自 base.css 的 token 覆盖；本域文件零色值字面量，所以不存在「某处忘了做暗色」的漏项。
2. 暗色下分组分隔线（`--line`）、组说明与迁移标记（`--ink-3`）仍保持可读对比，未出现灰底灰字。
3. 页头指标带在暗色下靠 `--surface` 与页面底色区分，数字用 `font-variant-numeric: tabular-nums`，明暗两版宽度一致、不跳动。
4. 迁移标记的虚线分隔用 `color-mix(in srgb, var(--ink-3) 45%, transparent)`，暗色下自动变淡，不需要单独覆写。

## 7. 落地清单与测试

- `ui/styles/global-config.css`：新增域文件（270 行 < 800 行铁律），在 `src/http.js` 的 `UI_STYLE_PARTS` 中登记于 `styles/settings.css` 之后。
  （卡面写的「ui/styles/settings.css（新）」与仓库现状不符：该文件已存在且承载表单基元，故同域另起新文件，原文件不动。）
- `tests/styles-split.test.js` +1 例：登记存在且紧跟 settings 域、关键选择器齐全、剥离注释后无 hex 色值。
- `tests/global-config-layout.test.js`（新文件，6 例）：分组与导航一一对应、分组头四要素、指标带降级、九块模块与交互入口不丢、迁移标注齐全、微信启用时带标注。
- 全量：落地到 dev 后 `npm test` → 1186 pass / 0 fail（dev 基线 1179，本卡 +7）。
- 落地提交（dev）：8976462 实现、7049bbd 方案与截图、d3b994d 按落地后代码重取截图。

## 8. 本卡未做（交给 programmer 车道）

以下都是功能改动，不在本卡写范围，方案已在第 2 节给出落点：

1. **功能迁移**：微信通道 → 通道页；API 密钥 → 独立密钥页；模型价格 → 用量页；DSH 路径 + DSH 服务 → 关于/系统状态页；「重新扫描技能」→ 技能页；「检查更新」→ 关于页。迁移完成后本页应删掉对应模块与「计划迁移」标记。
2. **保存入口收敛**：现为 5 处分散保存（界面语言、运行时效、系统设置、密钥、价格）。目标形态是「即时生效项就地保存 + 需要提交项按组一个保存入口」，可在分组头右侧放组级保存按钮，并把组内保存按钮收敛为组级一处。
3. **假开关与原生 confirm**：`memory_review` 无实际作用需删除或接线；缺 `chat_memory_review` 控件；原生 `confirm()` 换成应用内确认弹窗。
4. **整页 i18n**：本页主体文案仍大量硬编码中文（与 D-162 同源缺口），需另立整页 i18n 卡。
