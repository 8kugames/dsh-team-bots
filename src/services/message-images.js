// DSHBOTS-36 聊天图片输入：消息附图的校验与存储。
// 迁移体自管（db.js 已贴 800 行上限，一行不加），手法与 approvals.js 一致。
// 存储口径：base64 不进 messages.body，另存 message_images 表；正文与图片各行各司。
// 口径来源：宿主 dsh-attachment 的 ImageMediaType 只有 png/jpeg/webp/gif 四种，插件与之对齐，
// 不放行 SVG（可执行脚本）。
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    const part      = { type: 'image', mediaType: image.mediaType, data: image.data }
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

// ── 大 PNG 转 JPEG（DSHBOTS-109）───────────────────────────────────────────
// PNG 大图 base64 体积大、上传慢、部分模型处理效率低：入库与上传前把超过阈值
// 的 PNG 归一成 JPEG。gif/webp 不动（动图与透明语义保留）。解码用 sharp——
// 插件自身不依赖 sharp，优先复用宿主安装树里已有的（dsh-attachment-local 的
// 依赖）；解析不到或转码失败一律回退原图原样上传，绝不阻塞发送。
export const PNG_JPEG_QUALITY = 85
export const PNG_JPEG_MAX_EDGE = 2048

let sharpModule
let sharpResolved = false
let sharpMissingWarned = false

// 懒解析 sharp，结果进程内缓存。候选依次为：
// ① 裸 'sharp'（若宿主环境把它放进了插件可解析范围）；
// ② 从本文件目录逐级向上找 node_modules/sharp（源码仓开发态）；
// ③ 从 process.cwd() 逐级向上；
// ④ 从进程入口（dsh 的 lib/bin.js）逐级向上——生产环境 dsh 全局安装树里
//    node_modules/sharp（dsh-attachment-local 的传递依赖）就在这条链上。
function resolveSharp() {
  if (sharpResolved) return sharpModule
  sharpResolved = true
  const require = createRequire(import.meta.url)
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()]
  if (process.argv[1]) starts.push(dirname(resolve(process.argv[1])))
  const candidates = ['sharp']
  const seen = new Set(candidates)
  for (const start of starts) {
    for (let dir = start; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', 'sharp')
      if (!seen.has(candidate)) {
        seen.add(candidate)
        candidates.push(candidate)
      }
      if (dirname(dir) === dir) break
    }
  }
  for (const candidate of candidates) {
    try {
      const mod = require(candidate)
      if (typeof mod === 'function') {
        sharpModule = mod
        return sharpModule
      }
    } catch {
      // 候选不存在，继续往上找
    }
  }
  return null
}

// 单张转换：返回新的图片描述对象，失败/不划算返回 null（调用方回退原图）。
// PNG 的透明通道 JPEG 承载不了，按惯例压平到白底；rotate() 先吃掉 EXIF 方向。
async function convertPngToJpeg(sharp, data, logger) {
  const buffer = await sharp(Buffer.from(data, 'base64'))
    .rotate()
    .resize({ width: PNG_JPEG_MAX_EDGE, height: PNG_JPEG_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: PNG_JPEG_QUALITY })
    .toBuffer()
  if (buffer.length === 0) return null
  // 转出来反而更大（阈值边缘的低复杂度 PNG 可能如此）就不换，白转不如不转。
  if (buffer.length >= Buffer.from(data, 'base64').length) return null
  logger?.info?.('dsh-team: PNG 转 JPEG 完成，%s -> %s 字节', Buffer.from(data, 'base64').length, buffer.length)
  return { mediaType: 'image/jpeg', data: buffer.toString('base64'), bytes: buffer.length }
}

// 对已通过校验的图片描述列表做转码扫描：只动超阈值的 PNG，其余原样保留。
// sharpFactory 参数供测试注入假解码器；缺省走 resolveSharp。
export async function convertImagesForUpload(images, thresholdBytes, logger = null, sharpFactory = resolveSharp) {
  const list = Array.isArray(images) ? images : []
  if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) return list
  const needs = list.filter(image => image.mediaType === 'image/png' && image.bytes > thresholdBytes)
  if (needs.length === 0) return list
  const sharp = sharpFactory()
  if (!sharp) {
    if (!sharpMissingWarned) {
      sharpMissingWarned = true
      logger?.warn?.('dsh-team: 环境内无 sharp，大 PNG 不做 JPEG 归一，原样上传')
    }
    return list
  }
  const out = []
  for (const image of list) {
    if (image.mediaType !== 'image/png' || image.bytes <= thresholdBytes) {
      out.push(image)
      continue
    }
    try {
      const converted = await convertPngToJpeg(sharp, image.data, logger)
      out.push(converted ? { ...image, ...converted } : image)
    } catch (error     ) {
      // 转码失败回退原图，不阻塞发送。
      logger?.warn?.('dsh-team: PNG 转 JPEG 失败，回退原图：%s', error?.message ?? error)
      out.push(image)
    }
  }
  return out
}

// 外部输入 → 校验 + 转码，落库前的完整归一入口（sendMessage / sendSoloMessage 用）。
export async function prepareImagesForStorage(input, thresholdBytes, logger = null, sharpFactory ) {
  const images = normalizeImageInputs(input)
  return convertImagesForUpload(images, thresholdBytes, logger, sharpFactory)
}
