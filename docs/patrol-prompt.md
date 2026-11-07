# 团队巡检 prompt（A5/DSHBOTS-329）

供项目总监 bot（或 owner 手动触发）定期巡检的自足 prompt。来源：吸收 superagent 原型
`docs/006-deployment.md` 的 Hourly check 守护思路；巡检对象与阈值均对应本项目既有机制，
不新增任何自动处置——只核对、只报告，处置一律走显式人工/总监动作（D-281 口径）。

## 使用方式

把下面的 prompt 原文发给总监 bot（群聊 @ 或单聊），或在任务卡描述里引用。建议频率：
每天一次（工作时间开始时），或在 `npm run doctor` 退出码非 0 时手动触发。

## Prompt 原文

```text
做一次团队巡检，逐项核对并在结尾给出一行结论（每项：正常 / 需要关注 + 证据）：

1. 消息投递队列：检查全局设置页的 outbox 计数（或 state.outbox）。failed > 0 时列出
   条目与最早失败时间（notify_receipts / wechat_triggers 视图可查），不要自行重置。
2. 滞留卡：tasks 表里 in_review/blocked/backlog/todo 中超过各自阈值（in_review 24h /
   blocked 48h / 待执行 72h）的卡——即 needsAttention.needsYou.stale 的口径。逐卡说明
   滞留时长与建议处置（验收/解阻/派发），只建议不执行。
3. 验收看门狗干跑观察：若 review_auto_close=observe，列出最近 task_events 中
   type='review_watchdog_observe' 的条目（would 动作与依据），判断是否值得切到正式开启。
4. 密钥状态：有没有 TTL 临近或刚过期的一次性密钥副本（secrets 域的请求/批准记录）；
   未批准的密钥请求卡是否滞留。
5. 微信通道：wechatStatus 的 phase 是否 connected；触发留痕（wechat_triggers）里最近
   一小时有没有 rejected/failed 需要人工处理。
6. 磁盘与目录：数据目录（dataDir）所在盘剩余空间是否充裕；`npm run doctor` 最近一次
   退出码是多少（0=正常，1=目录/权限，2=host refs 需人工配置，3=两类并存）。

结论行格式：`巡检 <日期>：<N> 项正常，<M> 项需要关注：<列表>`。需要关注项给出「谁该
动手」（总监验收/owner 配置/运维修目录）与下一步命令，不要代做。
```

## 与退出码的衔接

`npm run doctor` 的退出码分级（0/1/2/3）供定时任务或脚本判断是否叫人；巡检 prompt 是
退出码非 0 时的人类可读延伸——先跑 doctor 定位环境层，再用本 prompt 做业务层核对。
