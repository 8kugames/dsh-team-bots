// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/apiClient.ts
import { randomBytes } from "node:crypto";

// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/errors.ts
var WechatIlinkError = class extends Error {
  constructor(code, message, retryable, options) {
    super(message, options);
    this.code = code;
    this.retryable = retryable;
    this.name = "WechatIlinkError";
  }
};
function asWechatIlinkError(error) {
  if (error instanceof WechatIlinkError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new WechatIlinkError(
      "ABORTED",
      "The iLink operation was cancelled.",
      true,
      {
        cause: error
      }
    );
  }
  return new WechatIlinkError(
    "NETWORK_ERROR",
    "The iLink request failed.",
    true,
    {
      cause: error
    }
  );
}

// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/types.ts
var MessageType = { NONE: 0, USER: 1, BOT: 2 };
var MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };
var MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5
};
var TypingStatus = { TYPING: 1, CANCEL: 2 };

// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/codec.ts
function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  } catch {
  }
  throw new WechatIlinkError(
    "BAD_RESPONSE",
    "iLink returned invalid JSON.",
    true
  );
}
function mediaBase(kind, media) {
  return {
    kind,
    downloadUrl: media?.full_url,
    encryptedQuery: media?.encrypt_query_param,
    aesKeyBase64: media?.aes_key
  };
}
function optionalByteLength(value) {
  if (typeof value !== "string" || value.trim() === "") return void 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : void 0;
}
function decodeQuote(item) {
  const ref = item.ref_msg;
  if (!ref) return void 0;
  const quoted = ref.message_item;
  if (!quoted) {
    return ref.title ? { title: ref.title, media: [] } : void 0;
  }
  const text = quoted.type === MessageItemType.TEXT && typeof quoted.text_item?.text === "string" ? quoted.text_item.text : quoted.type === MessageItemType.VOICE && typeof quoted.voice_item?.text === "string" ? quoted.voice_item.text : void 0;
  const decoded = decodeItemMedia(quoted);
  return {
    ...ref.title ? { title: ref.title } : {},
    ...text ? { text } : {},
    media: decoded ? [decoded] : []
  };
}
function decodeItemMedia(item) {
  switch (item.type) {
    case MessageItemType.IMAGE:
      return {
        ...mediaBase("image", item.image_item?.media),
        aesKeyHex: item.image_item?.aeskey,
        encryptedByteLength: item.image_item?.mid_size
      };
    case MessageItemType.VOICE:
      return {
        ...mediaBase("voice", item.voice_item?.media),
        voiceEncoding: item.voice_item?.encode_type,
        transcript: item.voice_item?.text
      };
    case MessageItemType.FILE:
      return {
        ...mediaBase("file", item.file_item?.media),
        fileName: item.file_item?.file_name,
        byteLength: optionalByteLength(item.file_item?.len),
        md5Hex: item.file_item?.md5
      };
    case MessageItemType.VIDEO:
      return {
        ...mediaBase("video", item.video_item?.media),
        encryptedByteLength: item.video_item?.video_size
      };
    default:
      return null;
  }
}
function decodeInboundMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.message_type != null && message.message_type !== MessageType.USER)
    return null;
  const senderId = typeof message.from_user_id === "string" ? message.from_user_id.trim() : "";
  const recipientId = typeof message.to_user_id === "string" ? message.to_user_id.trim() : "";
  const contextToken = typeof message.context_token === "string" ? message.context_token.trim() : "";
  const messageId = stableInboundMessageId(message);
  if (!senderId || !contextToken || !messageId) return null;
  const textParts = [];
  const media = [];
  let quote;
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    quote ??= decodeQuote(item);
    switch (item.type) {
      case MessageItemType.TEXT:
        if (typeof item.text_item?.text === "string" && item.text_item.text) {
          textParts.push(item.text_item.text);
        }
        break;
      case MessageItemType.IMAGE:
        media.push(decodeItemMedia(item));
        break;
      case MessageItemType.VOICE:
        if (typeof item.voice_item?.text === "string" && item.voice_item.text) {
          textParts.push(item.voice_item.text);
        }
        media.push(decodeItemMedia(item));
        break;
      case MessageItemType.FILE:
        media.push(decodeItemMedia(item));
        break;
      case MessageItemType.VIDEO:
        media.push(decodeItemMedia(item));
        break;
    }
  }
  return {
    messageId,
    senderId,
    ...recipientId ? { recipientId } : {},
    clientId: message.client_id,
    createdAt: message.create_time_ms,
    contextToken,
    text: textParts.join("\n"),
    media,
    ...quote ? { quote } : {}
  };
}
function stableInboundMessageId(message) {
  const clientId = typeof message.client_id === "string" ? message.client_id.trim() : "";
  if (clientId) return `client:${clientId}`;
  if (typeof message.message_id === "number" && Number.isFinite(message.message_id) && Number.isInteger(message.message_id)) {
    return `message:${message.message_id}`;
  }
  if (typeof message.message_id === "string" && message.message_id.trim()) {
    return `message:${message.message_id.trim()}`;
  }
  if (typeof message.seq === "number" && Number.isFinite(message.seq) && Number.isInteger(message.seq)) {
    return `seq:${message.seq}`;
  }
  return "";
}

// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/apiClient.ts
var AUTHORIZATION_ORIGIN = new URL("https://ilinkai.weixin.qq.com");
function versionInteger(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return (major & 255) << 16 | (minor & 255) << 8 | patch & 255;
}
function sanitizeBotAgent(raw) {
  const product = /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/;
  const accepted = raw.trim().split(/\s+/).filter((token) => product.test(token));
  const result = [];
  let length = 0;
  for (const token of accepted) {
    const next = length + (result.length ? 1 : 0) + Buffer.byteLength(token);
    if (next > 256) break;
    result.push(token);
    length = next;
  }
  return result.join(" ") || "Cindy/unknown";
}
function validateTencentIlinkBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink base URL is invalid.",
      false
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "" && url.port !== "443" || url.search || url.hash || url.pathname !== "/" || !(url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"))) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink base URL must be a Tencent credential-free HTTPS origin.",
      false
    );
  }
  return url;
}
async function readBoundedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink response exceeded the size limit.",
      true
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WechatIlinkError(
          "BAD_RESPONSE",
          "iLink response exceeded the size limit.",
          true
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8"
  );
}
function combineSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timeoutReached = false;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };
}
var IlinkApiClient = class _IlinkApiClient {
  constructor(options) {
    this.options = options;
    this.baseUrl = validateTencentIlinkBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch;
  }
  fetchImpl;
  baseUrl;
  baseInfo() {
    return {
      channel_version: this.options.clientVersion ?? "unknown",
      bot_agent: sanitizeBotAgent(this.options.botAgent)
    };
  }
  headers(authenticated, jsonBody) {
    const headers = {
      "iLink-App-Id": this.options.appId ?? "bot",
      "iLink-App-ClientVersion": String(
        versionInteger(this.options.clientVersion ?? "0.0.0")
      ),
      "X-WECHAT-UIN": Buffer.from(
        String(randomBytes(4).readUInt32BE(0))
      ).toString("base64")
    };
    if (this.options.routeTag) headers.SKRouteTag = this.options.routeTag;
    if (jsonBody) {
      headers["Content-Type"] = "application/json";
      headers.AuthorizationType = "ilink_bot_token";
    }
    if (authenticated) {
      if (this.options.token?.trim())
        headers.Authorization = `Bearer ${this.options.token.trim()}`;
    }
    return headers;
  }
  async request(endpoint, init, signal, timeoutMs = this.options.apiTimeoutMs ?? 15e3, baseUrl = this.baseUrl) {
    const url = new URL(endpoint, baseUrl);
    const combined = combineSignal(signal, timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: this.headers(init.authenticated, init.method === "POST"),
        signal: combined.signal,
        redirect: "manual",
        ...init.body === void 0 ? {} : { body: JSON.stringify(init.body) }
      });
      const text = await readBoundedText(
        response,
        this.options.maxResponseBytes ?? 4 * 1024 * 1024
      );
      if (!response.ok) {
        throw new WechatIlinkError(
          "HTTP_ERROR",
          `iLink request failed with HTTP ${response.status}.`,
          response.status >= 500
        );
      }
      return parseJsonObject(text);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (signal.aborted) {
          throw new WechatIlinkError(
            "ABORTED",
            "The iLink operation was cancelled.",
            true,
            {
              cause: error
            }
          );
        }
        if (combined.timedOut()) {
          throw new WechatIlinkError(
            "TIMEOUT",
            "The iLink request timed out.",
            true,
            {
              cause: error
            }
          );
        }
      }
      throw asWechatIlinkError(error);
    } finally {
      combined.cleanup();
    }
  }
  beginQr(localTokens, signal) {
    return this.request(
      "ilink/bot/get_bot_qrcode?bot_type=3",
      {
        method: "POST",
        body: { local_token_list: localTokens.slice(-10) },
        authenticated: false
      },
      signal,
      this.options.apiTimeoutMs ?? 15e3,
      AUTHORIZATION_ORIGIN
    );
  }
  async pollQr(qrCode, verificationCode, signal, baseUrl) {
    const query = new URLSearchParams({ qrcode: qrCode });
    if (verificationCode) query.set("verify_code", verificationCode);
    try {
      return await this.request(
        `ilink/bot/get_qrcode_status?${query}`,
        { method: "GET", authenticated: false },
        signal,
        this.options.longPollTimeoutMs ?? 35e3,
        baseUrl ? validateTencentIlinkBaseUrl(baseUrl) : this.baseUrl
      );
    } catch (error) {
      if (error instanceof WechatIlinkError && error.code === "TIMEOUT") {
        return { status: "wait" };
      }
      throw error;
    }
  }
  async getUpdates(cursor, signal) {
    try {
      return await this.request(
        "ilink/bot/getupdates",
        {
          method: "POST",
          authenticated: true,
          body: {
            get_updates_buf: cursor,
            base_info: this.baseInfo()
          }
        },
        signal,
        this.options.longPollTimeoutMs ?? 35e3
      );
    } catch (error) {
      if (error instanceof WechatIlinkError && error.code === "TIMEOUT") {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw error;
    }
  }
  notifyStart(signal) {
    return this.notifyLifecycle("ilink/bot/msg/notifystart", signal);
  }
  notifyStop(signal) {
    return this.notifyLifecycle("ilink/bot/msg/notifystop", signal);
  }
  async sendText(request, signal) {
    if (!request.peerId.trim() || !request.contextToken.trim() || !request.clientId.trim() || request.text.length === 0 || Array.from(request.text).length > 3500) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "The iLink text message is incomplete.",
        false
      );
    }
    const response = await this.request(
      "ilink/bot/sendmessage",
      {
        method: "POST",
        authenticated: true,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: request.peerId,
            client_id: request.clientId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [
              { type: MessageItemType.TEXT, text_item: { text: request.text } }
            ],
            context_token: request.contextToken,
            run_id: request.runId
          },
          base_info: this.baseInfo()
        }
      },
      signal
    );
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the message.",
        true
      );
    }
  }
  async getUploadUrl(request, signal) {
    const response = await this.request(
      "ilink/bot/getuploadurl",
      {
        method: "POST",
        authenticated: true,
        body: {
          filekey: request.fileKey,
          media_type: request.mediaType,
          to_user_id: request.peerId,
          rawsize: request.rawSize,
          rawfilemd5: request.rawMd5,
          filesize: request.encryptedSize,
          no_need_thumb: true,
          aeskey: request.aesKeyHex,
          base_info: this.baseInfo()
        }
      },
      signal
    );
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the media upload request.",
        true
      );
    }
    return {
      uploadParam: typeof response.upload_param === "string" ? response.upload_param : void 0,
      uploadFullUrl: typeof response.upload_full_url === "string" ? response.upload_full_url : void 0
    };
  }
  async sendMedia(request, signal) {
    const { ref, fileName } = request.uploaded;
    if (!request.peerId.trim() || !request.contextToken.trim() || !request.clientId.trim() || !ref.encryptedQuery || !ref.aesKeyBase64) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "The iLink media message is incomplete.",
        false
      );
    }
    const item = mediaItemFor(ref, fileName);
    const response = await this.request(
      "ilink/bot/sendmessage",
      {
        method: "POST",
        authenticated: true,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: request.peerId,
            client_id: request.clientId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [item],
            context_token: request.contextToken,
            run_id: request.runId
          },
          base_info: this.baseInfo()
        }
      },
      signal
    );
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the media message.",
        true
      );
    }
  }
  getConfig(peerId, contextToken, signal) {
    if (!peerId.trim() || !contextToken.trim()) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "The iLink typing request is incomplete.",
        false
      );
    }
    return this.request(
      "ilink/bot/getconfig",
      {
        method: "POST",
        authenticated: true,
        body: {
          ilink_user_id: peerId,
          context_token: contextToken,
          base_info: this.baseInfo()
        }
      },
      signal
    );
  }
  async setTyping(peerId, ticket, active, signal) {
    if (!peerId.trim() || !ticket.trim()) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "The iLink typing request is incomplete.",
        false
      );
    }
    const response = await this.request(
      "ilink/bot/sendtyping",
      {
        method: "POST",
        authenticated: true,
        body: {
          ilink_user_id: peerId,
          typing_ticket: ticket,
          status: active ? TypingStatus.TYPING : TypingStatus.CANCEL,
          base_info: this.baseInfo()
        }
      },
      signal
    );
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the typing request.",
        true
      );
    }
  }
  static messagesFrom(response) {
    if (response.msgs === void 0) return [];
    if (!Array.isArray(response.msgs)) {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        "iLink returned an invalid message list.",
        true
      );
    }
    return response.msgs.filter(
      (message) => message !== null && typeof message === "object" && !Array.isArray(message)
    );
  }
  messagesFrom(response) {
    const messages = _IlinkApiClient.messagesFrom(response);
    if (messages.length > (this.options.maxPollMessages ?? 100)) {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        "iLink returned too many messages in one poll.",
        true
      );
    }
    for (const message of messages) {
      if (message.item_list !== void 0 && (!Array.isArray(message.item_list) || message.item_list.length > (this.options.maxItemsPerMessage ?? 20))) {
        throw new WechatIlinkError(
          "BAD_RESPONSE",
          "iLink returned an invalid message item list.",
          true
        );
      }
    }
    return messages;
  }
  notifyLifecycle(endpoint, signal) {
    return this.request(
      endpoint,
      {
        method: "POST",
        authenticated: true,
        body: { base_info: this.baseInfo() }
      },
      signal,
      5e3
    );
  }
};
function mediaItemFor(ref, fileName) {
  const media = {
    encrypt_query_param: ref.encryptedQuery,
    aes_key: ref.aesKeyBase64,
    encrypt_type: 1
  };
  switch (ref.kind) {
    case "image":
      return {
        type: MessageItemType.IMAGE,
        image_item: {
          media,
          mid_size: ref.encryptedByteLength ?? ref.byteLength
        }
      };
    case "video":
      return {
        type: MessageItemType.VIDEO,
        video_item: {
          media,
          video_size: ref.encryptedByteLength ?? ref.byteLength
        }
      };
    case "file":
      return {
        type: MessageItemType.FILE,
        file_item: {
          media,
          file_name: fileName,
          len: ref.byteLength === void 0 ? void 0 : String(ref.byteLength)
        }
      };
    case "voice":
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "Outbound voice messages are not supported.",
        false
      );
  }
}

// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/auth.ts
import { randomUUID } from "node:crypto";
function requiredString(value, field) {
  if (typeof value === "string" && value.trim()) return value;
  throw new WechatIlinkError("BAD_RESPONSE", `iLink omitted ${field}.`, false);
}
function requiredTencentQrUrl(value) {
  const raw = requiredString(value, "qrcode_img_content");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink returned an invalid QR URL.",
      false
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || !(url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"))) {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink returned an invalid QR URL.",
      false
    );
  }
  return url.toString();
}
var AUTHORIZATION_TTL_MS = 5 * 6e4;
var IlinkAuthorization = class {
  constructor(api, observer = {}) {
    this.api = api;
    this.observer = observer;
  }
  active = /* @__PURE__ */ new Map();
  async begin(localTokens, signal) {
    const response = await this.api.beginQr(localTokens, signal);
    const challenge = {
      id: randomUUID(),
      qrCodeUrl: requiredTencentQrUrl(response.qrcode_img_content),
      createdAt: Date.now()
    };
    this.active.set(challenge.id, {
      qrCode: requiredString(response.qrcode, "qrcode"),
      pollBaseUrl: "https://ilinkai.weixin.qq.com",
      localTokens: [...localTokens],
      createdAt: challenge.createdAt
    });
    return challenge;
  }
  async wait(challenge, signal) {
    const active = this.active.get(challenge.id);
    if (!active) {
      throw new WechatIlinkError(
        "AUTH_EXPIRED",
        "The WeChat authorization challenge is no longer active.",
        true
      );
    }
    let verificationCode;
    let currentChallenge = { ...challenge };
    let refreshCount = 0;
    try {
      while (!signal.aborted) {
        if (Date.now() - active.createdAt > AUTHORIZATION_TTL_MS) {
          throw new WechatIlinkError(
            "AUTH_TIMEOUT",
            "The WeChat authorization timed out.",
            true
          );
        }
        const status = await this.api.pollQr(
          active.qrCode,
          verificationCode,
          signal,
          active.pollBaseUrl
        );
        switch (status.status) {
          case "wait":
            await this.observer.onEvent?.({ status: "waiting" });
            break;
          case "scaned":
            verificationCode = void 0;
            await this.observer.onEvent?.({ status: "scanned" });
            break;
          case "need_verifycode":
            if (!this.observer.requestVerificationCode) {
              throw new WechatIlinkError(
                "PROTOCOL_ERROR",
                "A WeChat verification code is required.",
                true
              );
            }
            await this.observer.onEvent?.({
              status: "verification-required",
              retry: verificationCode !== void 0
            });
            verificationCode = await this.observer.requestVerificationCode(
              verificationCode !== void 0,
              signal
            );
            if (!/^\d{1,12}$/.test(verificationCode)) {
              throw new WechatIlinkError(
                "PROTOCOL_ERROR",
                "The WeChat verification code is invalid.",
                false
              );
            }
            break;
          case "verify_code_blocked":
            throw new WechatIlinkError(
              "AUTH_TIMEOUT",
              "Verification attempts were blocked.",
              true
            );
          case "expired":
            refreshCount += 1;
            if (refreshCount > 3) {
              throw new WechatIlinkError(
                "AUTH_EXPIRED",
                "The WeChat QR code expired too many times.",
                true
              );
            }
            {
              const response = await this.api.beginQr(
                active.localTokens,
                signal
              );
              active.qrCode = requiredString(response.qrcode, "qrcode");
              active.pollBaseUrl = "https://ilinkai.weixin.qq.com";
              currentChallenge = {
                id: challenge.id,
                qrCodeUrl: requiredTencentQrUrl(response.qrcode_img_content),
                createdAt: Date.now()
              };
            }
            verificationCode = void 0;
            await this.observer.onEvent?.({
              status: "qr-refreshed",
              challenge: currentChallenge
            });
            break;
          case "binded_redirect":
            throw new WechatIlinkError(
              "AUTH_ALREADY_BOUND",
              "This WeChat connection is already bound.",
              false
            );
          case "scaned_but_redirect":
            if (!status.redirect_host || !/^[A-Za-z0-9.-]+$/.test(status.redirect_host)) {
              throw new WechatIlinkError(
                "BAD_RESPONSE",
                "iLink returned an invalid authorization redirect.",
                true
              );
            }
            active.pollBaseUrl = validateTencentIlinkBaseUrl(
              `https://${status.redirect_host}`
            ).origin;
            break;
          case "confirmed":
            validateTencentIlinkBaseUrl(
              requiredString(status.baseurl, "baseurl")
            );
            return {
              token: requiredString(status.bot_token, "bot_token"),
              botId: requiredString(status.ilink_bot_id, "ilink_bot_id"),
              userId: requiredString(status.ilink_user_id, "ilink_user_id"),
              baseUrl: requiredString(status.baseurl, "baseurl")
            };
          default:
            throw new WechatIlinkError(
              "BAD_RESPONSE",
              "iLink returned an unknown authorization status.",
              true
            );
        }
      }
      throw new WechatIlinkError(
        "ABORTED",
        "The iLink operation was cancelled.",
        true
      );
    } finally {
      this.active.delete(challenge.id);
    }
  }
};

// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/chunk.ts
function splitRawText(text, maxCodePoints) {
  const points = Array.from(text);
  const chunks = [];
  let offset = 0;
  while (offset < points.length) {
    let end = Math.min(offset + maxCodePoints, points.length);
    if (end < points.length) {
      while (end > offset && (points[end - 1] === "`" || points[end] === "`")) {
        end -= 1;
      }
      if (end === offset) end = Math.min(offset + maxCodePoints, points.length);
      const minimumBreak = offset + Math.floor(maxCodePoints * 0.6);
      for (let candidate = end; candidate > minimumBreak; candidate -= 1) {
        if (points[candidate - 1] === "\n" || /\s/u.test(points[candidate - 1])) {
          end = candidate;
          break;
        }
      }
    }
    chunks.push(points.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}
function togglesFence(text) {
  return (text.match(/^\s*```/gm) ?? []).length;
}
function chunkWechatText(text, maxCodePoints = 3500) {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) {
    throw new RangeError("maxCodePoints must be a positive integer");
  }
  const points = Array.from(text);
  if (points.length === 0) return [];
  if (maxCodePoints < 9) return splitRawText(text, maxCodePoints);
  const rawChunks = splitRawText(text, maxCodePoints - 8);
  const chunks = [];
  let fenceOpen = false;
  for (const raw of rawChunks) {
    const prefix = fenceOpen ? "```\n" : "";
    if (togglesFence(raw) % 2 === 1) fenceOpen = !fenceOpen;
    const suffix = fenceOpen ? "\n```" : "";
    chunks.push(`${prefix}${raw}${suffix}`);
  }
  return chunks;
}

// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/markdown.ts
var CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
function removeMarkdownImages(markdown) {
  let output = "";
  let offset = 0;
  while (offset < markdown.length) {
    const start = markdown.indexOf("![", offset);
    if (start < 0) return output + markdown.slice(offset);
    const altEnd = markdown.indexOf("]", start + 2);
    if (altEnd < 0) return output + markdown.slice(offset);
    if (markdown[altEnd + 1] !== "(") {
      output += markdown.slice(offset, altEnd + 1);
      offset = altEnd + 1;
      continue;
    }
    const destinationEnd = markdown.indexOf(")", altEnd + 2);
    if (destinationEnd < 0) return output + markdown.slice(offset);
    output += markdown.slice(offset, start);
    offset = destinationEnd + 1;
  }
  return output;
}
function filterPlainMarkdown(markdown) {
  return removeMarkdownImages(markdown).replace(/^#{5,6}\s+/gm, "").replace(/~~([^~]+)~~/g, "$1").replace(
    /(\*{1,3}|_{1,3})([^*_\n]+)\1/g,
    (whole, marker, body) => CJK.test(body) && marker.length !== 2 ? body : whole
  );
}
function filterInlineCodeAware(markdown) {
  let output = "";
  let offset = 0;
  while (offset < markdown.length) {
    const start = markdown.indexOf("`", offset);
    if (start < 0) return output + filterPlainMarkdown(markdown.slice(offset));
    output += filterPlainMarkdown(markdown.slice(offset, start));
    let markerEnd = start;
    while (markdown[markerEnd] === "`") markerEnd += 1;
    const marker = markdown.slice(start, markerEnd);
    const end = markdown.indexOf(marker, markerEnd);
    if (end < 0) return output + markdown.slice(start);
    output += markdown.slice(start, end + marker.length);
    offset = end + marker.length;
  }
  return output;
}
function filterWechatMarkdown(markdown) {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return line;
    }
    return fenced ? line : filterInlineCodeAware(line);
  }).join("");
}

// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/mediaCrypto.ts
import { createCipheriv, createDecipheriv } from "node:crypto";
function assertKey(key) {
  if (key.byteLength !== 16) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media key must be 16 bytes.",
      false
    );
  }
  return Buffer.from(key);
}
function encryptAes128Ecb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", assertKey(key), null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
function decryptAes128Ecb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", assertKey(key), null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function aes128EcbPaddedSize(plaintextSize) {
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "Media size must be a safe integer.",
      false
    );
  }
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/mediaTransfer.ts
import { createHash, randomBytes as randomBytes2 } from "node:crypto";
var WECHAT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
var WECHAT_MEDIA_CIPHERTEXT_MAX_BYTES = WECHAT_MEDIA_MAX_BYTES + 16;
var CDN_FALLBACK_ORIGIN = "https://novac2c.cdn.weixin.qq.com";
function isTencentMediaUrl(url) {
  return url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443") && (url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"));
}
function requireTencentMediaUrl(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      `${label} is not a valid URL.`,
      false
    );
  }
  if (!isTencentMediaUrl(url)) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      `${label} must be a credential-free Tencent HTTPS URL.`,
      false
    );
  }
  return url;
}
function downloadUrlFor(ref) {
  if (ref.downloadUrl) {
    return requireTencentMediaUrl(ref.downloadUrl, "iLink media download URL");
  }
  if (!ref.encryptedQuery?.trim()) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media omitted its download reference.",
      false
    );
  }
  const url = new URL("/c2c/download", CDN_FALLBACK_ORIGIN);
  url.searchParams.set("encrypted_query_param", ref.encryptedQuery);
  return url;
}
function parseAesKey(ref) {
  if (ref.aesKeyHex && /^[0-9a-fA-F]{32}$/.test(ref.aesKeyHex)) {
    return Buffer.from(ref.aesKeyHex, "hex");
  }
  if (!ref.aesKeyBase64) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media omitted its AES key.",
      false
    );
  }
  const decoded = Buffer.from(ref.aesKeyBase64, "base64");
  if (decoded.byteLength === 16) return decoded;
  if (decoded.byteLength === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new WechatIlinkError(
    "PROTOCOL_ERROR",
    "iLink media AES key has an invalid encoding.",
    false
  );
}
async function readBoundedBytes(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink media exceeded the size limit.",
      false
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WechatIlinkError(
          "BAD_RESPONSE",
          "iLink media exceeded the size limit.",
          false
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}
async function downloadWechatMedia(ref, fetchImpl, signal) {
  const response = await fetchImpl(downloadUrlFor(ref), {
    method: "GET",
    redirect: "manual",
    signal
  });
  if (!response.ok || response.status < 200 || response.status >= 300) {
    throw new WechatIlinkError(
      "HTTP_ERROR",
      `iLink media download failed with HTTP ${response.status}.`,
      response.status >= 500
    );
  }
  const encrypted = await readBoundedBytes(
    response,
    WECHAT_MEDIA_CIPHERTEXT_MAX_BYTES
  );
  let plaintext;
  try {
    plaintext = decryptAes128Ecb(encrypted, parseAesKey(ref));
  } catch (error) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media decryption failed.",
      false,
      { cause: error }
    );
  }
  if (plaintext.byteLength === 0 || plaintext.byteLength > WECHAT_MEDIA_MAX_BYTES || ref.kind === "file" && ref.byteLength !== void 0 && plaintext.byteLength !== ref.byteLength) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media plaintext size did not match its metadata.",
      false
    );
  }
  if (ref.md5Hex && createHash("md5").update(plaintext).digest("hex") !== ref.md5Hex.toLowerCase()) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media checksum did not match its metadata.",
      false
    );
  }
  return plaintext;
}
function prepareWechatUpload(bytes) {
  if (bytes.byteLength === 0 || bytes.byteLength > WECHAT_MEDIA_MAX_BYTES) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "WeChat outbound media must be between 1 byte and 5 MB.",
      false
    );
  }
  const aesKey = randomBytes2(16);
  return {
    aesKey,
    aesKeyHex: aesKey.toString("hex"),
    ciphertext: encryptAes128Ecb(bytes, aesKey),
    fileKey: randomBytes2(16).toString("hex"),
    md5Hex: createHash("md5").update(bytes).digest("hex")
  };
}
function expectedWechatCiphertextSize(bytes) {
  return aes128EcbPaddedSize(bytes);
}
async function uploadWechatCiphertext(args, fetchImpl, signal) {
  const rawUrl = args.uploadFullUrl?.trim();
  let url;
  if (rawUrl) {
    url = requireTencentMediaUrl(rawUrl, "iLink media upload URL");
  } else if (args.uploadParam?.trim()) {
    url = new URL("/c2c/upload", CDN_FALLBACK_ORIGIN);
    url.searchParams.set("encrypted_query_param", args.uploadParam);
    url.searchParams.set("filekey", args.fileKey);
  } else {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink omitted its media upload URL.",
      true
    );
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(args.ciphertext),
    redirect: "manual",
    signal
  });
  if (!response.ok || response.status !== 200) {
    throw new WechatIlinkError(
      "HTTP_ERROR",
      `iLink media upload failed with HTTP ${response.status}.`,
      response.status >= 500
    );
  }
  const downloadParam = response.headers.get("x-encrypted-param")?.trim();
  if (!downloadParam) {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink media upload omitted x-encrypted-param.",
      true
    );
  }
  return downloadParam;
}

// ../../../../../private/tmp/cindy-src/packages/wechat-ilink/src/transport.ts
var TencentIlinkTransport = class {
  constructor(options) {
    this.options = options;
    this.api = new IlinkApiClient(options);
    this.authorization = new IlinkAuthorization(
      this.api,
      options.authorizationObserver
    );
  }
  api;
  authorization;
  beginAuthorization(signal) {
    return Promise.resolve(this.options.localTokens?.() ?? []).then(
      (tokens) => this.authorization.begin(tokens, signal)
    );
  }
  waitAuthorization(challenge, signal) {
    return this.authorization.wait(challenge, signal);
  }
  async notifyStart(signal) {
    this.assertLifecycleResponse(await this.api.notifyStart(signal), "start");
  }
  async notifyStop(signal) {
    this.assertLifecycleResponse(await this.api.notifyStop(signal), "stop");
  }
  async poll(cursor, signal) {
    const response = await this.api.getUpdates(cursor, signal);
    if (response.ret !== void 0 && typeof response.ret !== "number") {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        "iLink returned an invalid poll status.",
        true
      );
    }
    if (response.errcode !== void 0 && typeof response.errcode !== "number") {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        "iLink returned an invalid poll error code.",
        true
      );
    }
    const ret = typeof response.ret === "number" ? response.ret : 0;
    if (response.errcode === -14) {
      throw new WechatIlinkError(
        "AUTH_REPLACED",
        "The iLink credential is no longer active.",
        false
      );
    }
    if (ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the poll request.",
        true
      );
    }
    const messages = this.api.messagesFrom(response).map(decodeInboundMessage).filter((message) => message !== null);
    return {
      cursor: typeof response.get_updates_buf === "string" ? response.get_updates_buf : cursor,
      messages,
      suggestedTimeoutMs: typeof response.longpolling_timeout_ms === "number" ? response.longpolling_timeout_ms : void 0
    };
  }
  async sendMessage(request, signal) {
    await this.api.sendText(request, signal);
    return { clientId: request.clientId };
  }
  async getTypingTicket(peerId, contextToken, signal) {
    const response = await this.api.getConfig(peerId, contextToken, signal);
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the typing configuration request.",
        true
      );
    }
    if (typeof response.typing_ticket !== "string" || !response.typing_ticket) {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        "iLink omitted typing_ticket.",
        true
      );
    }
    return response.typing_ticket;
  }
  setTyping(peerId, ticket, active, signal) {
    return this.api.setTyping(peerId, ticket, active, signal);
  }
  downloadMedia(ref, signal) {
    return downloadWechatMedia(ref, this.options.fetch, signal);
  }
  async uploadMedia(request, signal) {
    if (request.kind === "voice") {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "Outbound voice messages are not supported.",
        false
      );
    }
    const prepared = prepareWechatUpload(request.bytes);
    const mediaType = request.kind === "image" ? 1 : request.kind === "video" ? 2 : 3;
    const upload = await this.api.getUploadUrl(
      {
        peerId: request.peerId,
        fileKey: prepared.fileKey,
        mediaType,
        rawSize: request.bytes.byteLength,
        rawMd5: prepared.md5Hex,
        encryptedSize: expectedWechatCiphertextSize(request.bytes.byteLength),
        aesKeyHex: prepared.aesKeyHex
      },
      signal
    );
    const encryptedQuery = await uploadWechatCiphertext(
      {
        uploadFullUrl: upload.uploadFullUrl,
        uploadParam: upload.uploadParam,
        fileKey: prepared.fileKey,
        ciphertext: prepared.ciphertext
      },
      this.options.fetch,
      signal
    );
    return {
      fileName: request.fileName,
      ref: {
        kind: request.kind,
        encryptedQuery,
        // iLink's sendmessage media.aes_key uses base64(hex-text), while the
        // upload request above still uses the raw AES key as a hex string.
        aesKeyBase64: Buffer.from(prepared.aesKeyHex).toString("base64"),
        byteLength: request.bytes.byteLength,
        encryptedByteLength: prepared.ciphertext.byteLength
      }
    };
  }
  async sendMedia(request, signal) {
    await this.api.sendMedia(request, signal);
    return { clientId: request.clientId };
  }
  assertLifecycleResponse(response, operation) {
    if (response.ret !== void 0 && typeof response.ret !== "number") {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        `iLink returned an invalid ${operation} notification status.`,
        true
      );
    }
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        `iLink rejected the ${operation} notification.`,
        true
      );
    }
  }
};
export {
  IlinkApiClient,
  IlinkAuthorization,
  MessageItemType,
  MessageState,
  MessageType,
  TencentIlinkTransport,
  TypingStatus,
  WECHAT_MEDIA_MAX_BYTES,
  WechatIlinkError,
  aes128EcbPaddedSize,
  asWechatIlinkError,
  chunkWechatText,
  decodeInboundMessage,
  decryptAes128Ecb,
  downloadWechatMedia,
  encryptAes128Ecb,
  expectedWechatCiphertextSize,
  filterWechatMarkdown,
  parseJsonObject,
  prepareWechatUpload,
  sanitizeBotAgent,
  uploadWechatCiphertext,
  validateTencentIlinkBaseUrl
};
