# 发版说明

本文件记录各发版版本对外可见的行为变化；最新版本在最上方。

## v0.2.359

- **任务级死线（D-274）**：任务卡的死线 = 首次派发时刻 + `time_budget_minutes` × 2。存量老卡（首次派发时已超预算 × 2 = 40 分钟）下次被重派时会立即触发一次升级：系统评论 + 卡状态转 `blocked` + owner 通知。此时按升级提示改 `time_budget_minutes` 延期即可，重派即拿到完整的新窗口。这属于设计行为，不是故障。
- **工具分工**：交付类卡走 `npm run finalize`（`--card` 带上项目卡号，提交信息含卡号）；发版类卡走 `npm run release`。两者不要混用——`finalize` 负责单笔交付收口（build → typecheck → test → commit → push），`release` 负责整包发版（push dev → dev 落 main → push main + tag → 回 dev 同步）。
