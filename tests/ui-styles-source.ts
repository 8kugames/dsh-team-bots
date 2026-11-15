// 测试侧 CSS 读取口径（DSHBOTS-160）：ui/styles.css 已按 Section 域拆到 ui/styles/*.css，
// 「页面 CSS 含某规则」类源码断言一律读本汇总——与线上 styles() 同函数、同顺序。
// 不直读单个域文件：域归属再调整不该弄红无关测试。
import { readUiStyles } from '../src/http.js'

let cache
export async function uiStylesSource() {
  cache ??= await readUiStyles()
  return cache
}
