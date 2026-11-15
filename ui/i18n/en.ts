// ui/i18n/en.ts —— English copy dictionary聚合入口（按域拆分，DSHBOTS-233）
// 源语言为 zh；en 与 zh 键集一一对应。聚合顺序即域顺序，键不重叠。
import common from './en/common.js'
import nav from './en/nav.js'
import chat from './en/chat.js'
import tasks from './en/tasks.js'
import usage from './en/usage.js'
import settings from './en/settings.js'
import wechat from './en/wechat.js'

export default {
  ...common,
  ...nav,
  ...chat,
  ...tasks,
  ...usage,
  ...settings,
  ...wechat,
}
