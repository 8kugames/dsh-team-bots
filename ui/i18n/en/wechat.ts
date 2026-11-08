// ui/i18n/en/wechat.ts —— English copy dictionary: wechat domain (DSHBOTS-233)
export default {
  // High-frequency toasts
  "toast.wechatConnected": "WeChat channel connected",
  // Global configuration page (DSHBOTS-204)
  "channel.sectionWechat": "WeChat channel",
  "channel.sectionWechatDesc": "After scanning to authorize, task updates are pushed to the admin on WeChat.",
  // DSHBOTS-220: ui/modules copy
  "二维码已生成，请用微信扫码": "QR code generated; scan it with WeChat",
  "在服务端启用 wechat 通道后，这里会出现扫码绑定入口。": "Once the wechat channel is enabled on the server, a QR binding entry will appear here.",
  "已退出微信绑定": "WeChat binding removed",
  "待扫码": "Waiting to scan",
  "待输验证码": "Waiting for verification code",
  "微信通道未启用": "WeChat channel not enabled",
  "微信验证码": "WeChat verification code",
  "扫码后手机上的验证码": "The verification code shown on your phone after scanning",
  "扫码绑定": "Scan to bind",
  "提交验证码": "Submit code",
  "请输入微信验证码": "Enter the WeChat verification code",
  "退出绑定后需要重新扫码才能恢复推送。确认退出？": "After unbinding, you must scan the QR code again to restore push. Unbind now?",
  "验证码已提交": "Verification code submitted",
  // Feishu channel (DSHBOTS-327/333): read-only status card (no QR flow; credentials injected server-side)
  "channel.sectionFeishu": "Feishu channel",
  "channel.sectionFeishuDesc": "Connects automatically once the app credentials are configured; task updates are pushed to the admin on Feishu.",
  "连接冲突": "Connection conflict",
  "未配置飞书应用凭据（feishuAppId / feishuAppSecret），配置后自动连接。": "Feishu app credentials (feishuAppId / feishuAppSecret) are not configured; it connects automatically once they are set.",
  "检测到连接冲突：同一 App ID 在多处登录（exceed_conn_limit），请先退出其他实例。": "Connection conflict: the same App ID is signed in elsewhere (exceed_conn_limit). Sign out the other instance first.",
  "机器人 ID": "Bot ID",
  "App ID": "App ID",
}
