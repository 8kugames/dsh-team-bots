// solo-archive.js —— 单聊归档消息的 UI 入口门控（DSHBOTS-174）。
// 后端默认视图经归档窗口（DSHBOTS-171）隐去更早私信后，单聊首屏条数恒小于 CHAT_PAGE_SIZE，
// 旧「满页才亮按钮」阈值在单聊永不满足——归档消息 UI 层不可达（API 层 messagesPage 游标本就可达）。
// 本模块只判入口是否点亮；取数仍走既有 chatOlder 分片桶 + messagesPage 单聊游标，零新请求路径。
import { state } from './state.js'

// solo-archived-gate:start —— 单聊「加载更早」入口门控（tests/solo-archive-ui.test.js 按本标记块抽取断言）
// 契约：state.data.solo.archived = { count, hasMore }。仅当 view.solo.bot 与当前 soloBotId 匹配时可信
// （防切 bot 后旧数据串台点亮入口）；后端旧版本无此契约时返回 false，调用方回退旧阈值口径。
function soloArchivedHasMore() {
  const solo = state.data?.solo
  if (!solo || solo.bot?.id !== state.soloBotId) return false
  return Boolean(solo.archived?.hasMore)
}
// solo-archived-gate:end

export { soloArchivedHasMore }
