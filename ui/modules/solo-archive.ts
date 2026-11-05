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
