# dsh-team-bots

DSH（DeepSeek Harness）团队机器人插件：项目空间、群聊、任务板、记忆与用量统计。

## 分支模型

- **开发在 [`dev`](https://github.com/8kugames/dsh-team-bots/tree/dev) 分支进行**：源码、测试与全部开发历史都在 dev。
- **`main` 是发版专用分支**：只保留发版所需最小元数据，不承载开发历史。
- **npm 发版**：在 dev 的发版提交上打 `v*` tag 并推送，`.github/workflows/publish.yml` 由 tag 触发，从 tag 所在提交检出、测试并发布到 npm；版本号与包内容以 tag 所在提交为准。

安装与使用说明见 [dev 分支 README](https://github.com/8kugames/dsh-team-bots/blob/dev/README.md)。
