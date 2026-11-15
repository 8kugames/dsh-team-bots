// 回归：插件重载竞态——轮次取消的 abort 监听/超时定时器可能在 store.close() 之后
// 迟到结算（16:28 重载曾把 dsh web 打成 fatal：Error: statement has been finalized）。
// settleApproval 的库写必须容错；stop() 必须清掉自身持有的在途审批定时器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

function buildService(dir: string, warnings: string[]) {
  const store = openDatabase(join(dir, 'team.db'))
  const config = resolveConfig({ workspace: dir, dataDir: join(dir, 'data'), skillRoot: join(dir, '.agents') })
  const logger = { info() {}, warn: (...args: unknown[]) => warnings.push(args.join(' ')), error() {} }
  return { store, service: new TeamService({ store, config, logger }) }
}

test('settleApproval 在 store 关闭后不得抛出（abort 监听迟到结算）', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbots-late-settle-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const warnings: string[] = []
  const { store, service } = buildService(dir, warnings)
  let answered = 0
  ;(service as any).approvalPending = new Map([[
    'ap-late',
    { resolve: () => { answered += 1 }, timer: setTimeout(() => {}, 60_000) },
  ]])
  store.close()
  // 曾在此抛出并经 abort 分发冒泡为宿主 fatal；现在必须被吞成 warn。
  service.settleApproval('ap-late', 'cancelled', null, null)
  assert.equal(answered, 0, 'cancelled 分支 hostAnswer 为空，不得向宿主应答')
  assert.equal(warnings.length, 1, '写库失败要留一条 warn 痕迹')
  assert.match(warnings[0], /审批结算写库失败/)
})

test('stop() 清空在途审批定时器', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbots-stop-timers-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { store, service } = buildService(dir, [])
  let fired = false
  const timer = setTimeout(() => { fired = true }, 20)
  ;(service as any).approvalPending = new Map([['ap-1', { resolve() {}, timer }]])
  service.stop()
  assert.equal((service as any).approvalPending.size, 0, 'pending 表应清空')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(fired, false, '已清的定时器不得再触发')
  store.close()
})
