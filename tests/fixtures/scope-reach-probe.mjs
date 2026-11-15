// DSHBOTS-294 根级注册面与 cordis dispatch 可达性实测探针（D-292 限制③）。
// 由 tests/subagent-ledger.test.ts 子进程执行：真 cordis Context + 真 dsh-scope 子 scope
// 发射事件，断言插件根 ctx（untagged）监听可达 emit 与 waterfall 两条派发面。
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const host = process.env.DSH_TEST_HOST_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const pkg = name => `${host}/node_modules/@deepseek-ai/${name}`
for (const name of ['cordis', 'dsh-scope']) {
  if (!existsSync(pkg(name))) {
    console.log(`SKIP host package ${name} not found under ${host}`)
    process.exit(0)
  }
}

const { Context } = await import(pathToFileURL(`${pkg('cordis')}/lib/index.js`).href)
const { createScope } = await import(pathToFileURL(`${pkg('dsh-scope')}/lib/index.js`).href)

const root = new Context({})
const seen = { emit: false, waterfall: false }
root.on('subagent/end', info => { seen.emit = info?.probe === 1 })
root.on('tools/pre-execute', async (exec, next) => {
  if (exec?.probe === 2) seen.waterfall = true
  return next()
})

const scope = createScope(root, {})
scope.ctx.emit('subagent/end', { probe: 1 })
await scope.ctx.waterfall('tools/pre-execute', { probe: 2 }, async () => ({ allowed: true }))

console.log(`RESULT emit=${seen.emit} waterfall=${seen.waterfall}`)
process.exit(seen.emit && seen.waterfall ? 0 : 1)
