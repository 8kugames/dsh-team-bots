import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const UI_DIR = fileURLToPath(new URL('../../ui', import.meta.url))

import './eval-shim.js'

// DSHBOTS-15 起 ui/app.js 拆为 ES modules：读源断言的测试统一读「app.js + ui/modules/*.js」
// 拼接源，断言文本不随搬家改动（内容命中与否与所在文件无关）。
export function readUiSource() {
  const modulesDir = join(UI_DIR, 'modules')
  const modules = readdirSync(modulesDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => readFileSync(join(modulesDir, name), 'utf8'))
    .join('\n')
  return `${readFileSync(join(UI_DIR, 'app.js'), 'utf8')}\n${modules}`
}
