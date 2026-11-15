// 把 .ts/.mts 源码擦除成同名 .js/.mjs。
// 使用 Node 内置的 stripTypeScriptTypes（strip 模式）：类型位置替换为空白，
// 行号、列、注释、字符串字面量与 import 说明符全部原样保留，因此产物与源码
// 逐行对齐，静态资源路径、浏览器 ESM 说明符与源码级断言都不需要跟着改。
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'index.ts')
const DIRS = ['src', 'ui', 'scripts', 'tests'].map(name => join(ROOT, name))

function* sources(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) {
      yield* sources(full)
    } else if (entry.isFile() && /\.m?ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield full
    }
  }
}

const files = [ENTRY]
for (const dir of DIRS) {
  if (statSync(dir).isDirectory()) files.push(...sources(dir))
}

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const output = stripTypeScriptTypes(source, { mode: 'strip' })
  const dest = file.endsWith('.mts')
    ? `${file.slice(0, -4)}.mjs`
    : `${file.slice(0, -3)}.js`
  writeFileSync(dest, output)
}

console.log(`[build] ${files.length} TypeScript files -> JS`)
