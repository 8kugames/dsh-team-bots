// src/feishu/index.ts —— 飞书通道公共出口（DSHBOTS-323 卡①）
export { FeishuChannel, CliError, isGone, isRetryable, CONSUME_RETRY_DELAYS_MS, CONSUME_READY_TIMEOUT_MS } from './channel.js'
export { FeishuStore } from './store.js'
export { outboundChunks, RULE, CHUNK_MAX_CHARS, welcomeAdmin, failureText } from './format.js'
