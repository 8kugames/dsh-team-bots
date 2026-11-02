// DSHBOTS-36 聊天图片输入：消息附图的校验与存储。
// 迁移体自管（db.js 已贴 800 行上限，一行不加），手法与 approvals.js 一致。
// 存储口径：base64 不进 messages.body，另存 message_images 表；正文与图片各行各司。
// 口径来源：宿主 dsh-attachment 的 ImageMediaType 只有 png/jpeg/webp/gif 四种，插件与之对齐，
// 不放行 SVG（可执行脚本）。
import { badRequest } from '../errors.js'
import { id, nowIso } from '../util.js'

// 与宿主 @deepseek-ai/dsh-attachment 的 ImageMediaType 保持一致。
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

// 单图 5MB、单条消息 4 张：超限一律 bad_request（invalid_request 语义）。
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES_PER_MESSAGE = 4
const MAX_IMAGE_NAME_CHARS = 200

const MESSAGE_IMAGES_DDL = `
CREATE TABLE IF NOT EXISTS message_images (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  solo_message_id TEXT REFERENCES solo_messages(id) ON DELETE CASCADE,
  project_id TEXT,
  bot_id TEXT,
  media_type TEXT NOT NULL,
  data TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  CHECK ((message_id IS NULL) <> (solo_message_id IS NULL))
);
CREATE INDEX IF NOT EXISTS message_images_message_idx ON message_images(message_id);
CREATE INDEX IF NOT EXISTS message_images_solo_idx ON message_images(solo_message_id);
CREATE INDEX IF NOT EXISTS message_images_project_idx ON message_images(project_id);
`

// 建表 + 幂等登记迁移名。消息删除（/clear、项目移除追踪）走 FK 级联，
// 外键开关在 db.js 打开时是 ON，因此图片行随消息行一起消失。
export function ensureMessageImagesSchema(store) {
  store.exec(MESSAGE_IMAGES_DDL)
  store.run(
    'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
    'message_images_table',
    nowIso(),
  )
}

// base64 严格判定：Node 的 Buffer.from 对脏字符是宽容的，这里先按字符集与长度卡住，
// 免得非法串被静默解码成残缺字节再进库。
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

function normalizeImageData(raw) {
  let data = String(raw ?? '').trim()
  // 前端常见的是 data URL；只取逗号后的 base64 段，声明类型仍以 mediaType 字段为准。
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',')
    if (comma < 0) throw badRequest('图片数据不是合法的 base64')
    data = data.slice(comma + 1).trim()
  }
  if (!data) throw badRequest('图片数据为空')
  if (!BASE64_PATTERN.test(data) || data.length % 4 !== 0) throw badRequest('图片数据不是合法的 base64')
  const bytes = Buffer.from(data, 'base64').length
  if (bytes === 0) throw badRequest('图片数据为空')
  if (bytes > MAX_IMAGE_BYTES) throw badRequest(`单张图片不能超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB`)
  return { data, bytes }
}

// 外部输入（API payload）→ 内部图片描述。缺省（undefined/null）返回空数组，
// 保证「不带 images」与旧行为完全一致。
export function normalizeImageInputs(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw badRequest('images 必须是数组')
  if (input.length > MAX_IMAGES_PER_MESSAGE) {
    throw badRequest(`一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`)
  }
  return input.map((item, index) => {
    if (!item || typeof item !== 'object') throw badRequest(`第 ${index + 1} 张图片格式无效`)
    const mediaType = String(item.mediaType ?? '').trim().toLowerCase()
    if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
      throw badRequest(`不支持的图片类型 ${mediaType || '(空)'}，仅支持 ${IMAGE_MEDIA_TYPES.join(' / ')}`)
    }
    const { data, bytes } = normalizeImageData(item.data)
    const name = item.name === undefined || item.name === null
      ? null
      : String(item.name).trim().slice(0, MAX_IMAGE_NAME_CHARS) || null
    return { mediaType, data, bytes, name }
  })
}

// 图片描述 → 宿主 PromptContentPart 的 image 分片。
// 宿主会自己把不能吃图片的模型降级成占位文本，插件不判模型能力。
export function toImageContentParts(images) {
  const list = Array.isArray(images) ? images : []
  return list.map(image => {
    const part = { type: 'image', mediaType: image.mediaType, data: image.data }
    if (image.name) part.name = image.name
    return part
  })
}

// 落库：群聊消息挂 message_id，单聊消息挂 solo_message_id，两者互斥（CHECK 约束保证）。
export function insertMessageImages(store, { messageId, soloMessageId = null, images, projectId = null, botId = null }) {
  const list = Array.isArray(images) ? images : []
  if (list.length === 0) return []
  const createdAt = nowIso()
  const views = []
  for (const image of list) {
    const imageId = id('img')
    store.run(
      `INSERT INTO message_images(id, message_id, solo_message_id, project_id, bot_id, media_type, data, bytes, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      imageId, soloMessageId ? null : messageId, soloMessageId, projectId, botId,
      image.mediaType, image.data, image.bytes, image.name ?? null, createdAt,
    )
    views.push({ id: imageId, mediaType: image.mediaType, name: image.name ?? null, bytes: image.bytes })
  }
  return views
}

// 视图元数据：不含 base64（列表接口不放大响应体）。
export function messageImageViews(store, messageId) {
  if (!messageId) return []
  const rows = store.all(
    'SELECT id, media_type, name, bytes FROM message_images WHERE message_id = ? OR solo_message_id = ? ORDER BY created_at, id',
    messageId, messageId,
  )
  return rows.map(row => ({ id: row.id, mediaType: row.media_type, name: row.name ?? null, bytes: row.bytes }))
}

// 运行期取图：把库里存的图片还原成宿主 image 分片，供首条 prompt 组装。
export function imageContentPartsForMessage(store, messageId) {
  if (!messageId) return []
  const rows = store.all(
    'SELECT media_type, data, name FROM message_images WHERE message_id = ? OR solo_message_id = ? ORDER BY created_at, id',
    messageId, messageId,
  )
  return toImageContentParts(rows.map(row => ({ mediaType: row.media_type, data: row.data, name: row.name })))
}

// 按 id 取图（带 base64）。越权与不存在的判定在服务层做，这里只给数据。
export function messageImageRow(store, imageId) {
  if (!imageId) return null
  return store.get('SELECT * FROM message_images WHERE id = ?', imageId) ?? null
}
