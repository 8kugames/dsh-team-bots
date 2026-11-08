// src/feishu/index.ts —— 飞书通道公共出口（DSHBOTS-333：传输层换进程内官方 SDK）
export {
  FeishuChannel,
  FeishuError,
  createSdkTransport,
  toFeishuError,
  isGone,
  isRetryable,
  isConnLimit,
  parseInboundEvent,
  laneOf,
  stripMentionPlaceholders,
  INBOUND_DEDUP_TTL_MS,
  INBOUND_DEDUP_LIMIT,
  NON_OWNER_COOLDOWN_MS,
} from './channel.js'
export type { FeishuTransport } from './channel.js'
export { FeishuStore } from './store.js'
export { outboundChunks, RULE, CHUNK_MAX_CHARS, welcomeAdmin, failureText } from './format.js'
