// ui/i18n/zh.ts —— 中文文案字典聚合入口（按域拆分，DSHBOTS-233）
// 源语言为 zh；en 与 zh 键集一一对应。聚合顺序即域顺序，键不重叠。
import common from './zh/common.js'
import nav from './zh/nav.js'
import chat from './zh/chat.js'
import tasks from './zh/tasks.js'
import usage from './zh/usage.js'
import settings from './zh/settings.js'
import wechat from './zh/wechat.js'

export default {
  ...common,
  ...nav,
  ...chat,
  ...tasks,
  ...usage,
  ...settings,
  ...wechat,
}
