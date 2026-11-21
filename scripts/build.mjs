// 把 .ts/.mts 源码擦除成同名 .js/.mjs。
// 使用 Node 内置的 stripTypeScriptTypes（strip 模式）：类型位置替换为空白，
// 行号、列、注释、字符串字面量与 import 说明符全部原样保留，因此产物与源码
// 逐行对齐，静态资源路径、浏览器 ESM 说明符与源码级断言都不需要跟着改。
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { execSync } from 'node:child_process'

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

const stripTo = (file, source) => file.endsWith('.mts')
  ? `${file.slice(0, -4)}.mjs`
  : `${file.slice(0, -3)}.js`

// ── 脏产物检测（覆盖前执行，见 RULES.md 第 4 条）──
// .js/.mjs 是构建产物：正常状态下它恒等于 strip(.ts)。若某个 .ts 相对 git HEAD 未改，
// 而它的产物却与 strip 结果不一致，这个分歧只可能来自手改产物——历史上这类改动会被
// 下面的整树重写静默吞掉（pretest 全量重建），当事人却以为已经改到源码并报了完成。
// 检测到即失败并指名文件，把这类错误从「静默丢弃」变成「响亮报错」。
// 同时检测孤儿产物：src/ui/tests 下存在 .js/.mjs 却没有同名 .ts（git 不跟踪它们，
// 不会被分发也不会被重建），同样只有手新建一种来源。scripts/ 下的手工 .mjs 工具
// （build/finalize/preflight/release/doctor）不在检测范围。
const guardErrors = []
let modifiedTs = new Set()
let trackedFiles = new Set()
try {
  modifiedTs = new Set(
    execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(name => /\.m?ts$/.test(name)),
  )
  trackedFiles = new Set(
    execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean),
  )
} catch {
  // 无 git 或非仓库环境（如安装包内重建）：跳过脏产物检测，构建行为不变。
}
const generatedDests = new Set()
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const dest = stripTo(file, source)
  generatedDests.add(dest)
  const rel = relative(ROOT, file)
  if (modifiedTs.size && !modifiedTs.has(rel) && existsSync(dest)) {
    const expected = stripTypeScriptTypes(source, { mode: 'strip' })
    if (readFileSync(dest, 'utf8') !== expected) {
      guardErrors.push(`${relative(ROOT, dest)} 与未被修改的 ${rel} 的编译产物不一致（疑似手工修改产物；请把改动移植到 ${rel}，或删掉该产物让构建重建）`)
    }
  }
}
for (const dir of [join(ROOT, 'src'), join(ROOT, 'ui'), join(ROOT, 'tests')]) {
  if (!statSync(dir).isDirectory()) continue
  function* orphanScan(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) yield* orphanScan(full)
      else if (entry.isFile() && /\.[jm]js$/.test(entry.name)) yield full
    }
  }
  for (const orphan of orphanScan(dir)) {
    const rel = relative(ROOT, orphan)
    // git 已跟踪的无 .ts 同名文件是合法 fixture（如 tests/fixtures/*.mjs），只拦未跟踪的。
    if (!generatedDests.has(orphan) && trackedFiles.size && !trackedFiles.has(rel)) {
      guardErrors.push(`${rel} 没有对应的 .ts 源且未被 git 跟踪（产物目录不接受手工新建的 js 文件）`)
    }
  }
}
if (guardErrors.length) {
  console.error('[build] 构建产物完整性检测失败：')
  for (const message of guardErrors) console.error(`  - ${message}`)
  console.error('[build] .ts 是唯一源；请把上述改动移植到对应 .ts 后重试。')
  process.exit(1)
}

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const output = stripTypeScriptTypes(source, { mode: 'strip' })
  writeFileSync(stripTo(file, source), output)
}

console.log(`[build] ${files.length} TypeScript files -> JS`)
