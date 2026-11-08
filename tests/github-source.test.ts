// tests/github-source.test.ts —— B4-②/DSHBOTS-335：GitHub 只读触发源守门。
// observe 口径：issue 只产生「留痕 + 候选通知」，绝不建卡/派单（权威链仍是 director 派单）。
// 守门五向：①env 解析 fail-closed（非法 JSON/非数组 → 空清单）；②缺省全关零开销（off/interval 闸）；
// ③首拍全部留痕+候选通知、次拍 (source, external_id) 去重零重发；④项目 key 不可达 filtered、
// gh 失败 failed 留痕；⑤gh runner 可注入（测试桩），纯解析函数对坏 JSON 降级。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { parseGithubWatchEnv, clampGithubPollMinutes } from '../src/config.js'
import { parseGithubIssues, pollGithubSource, pollGithubSources, GITHUB_POLL_INTERVAL_KEY } from '../src/services/github-source.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

const ISSUES_JSON = JSON.stringify([
  { number: 7, title: '登录页崩溃', url: 'https://github.com/o/r/issues/7', updatedAt: '2026-11-08T00:00:00Z' },
  { number: 9, title: '导出 CSV 慢', url: 'https://github.com/o/r/issues/9', updatedAt: '2026-11-08T01:00:00Z' },
  { number: 'bad', title: null },
])

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-source-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const projectView = await service.createProject({ name: 'Order', key: 'ORD', ownerBotId: director.id })
  return { root, store, service, director, project: projectView }
}

const teardown = async (root, store) => {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

test('env 解析 fail-closed：非法 JSON/非数组/缺字段 → 空清单；间隔钳制 0-1440', () => {
  assert.deepEqual(parseGithubWatchEnv(undefined), [])
  assert.deepEqual(parseGithubWatchEnv('not-json{{{'), [])
  assert.deepEqual(parseGithubWatchEnv('{"projectKey":"A"}'), [])
  assert.deepEqual(parseGithubWatchEnv('[{"projectKey":"ORD","repo":"o/r"},{"projectKey":"","repo":"x"}]'),
    [{ projectKey: 'ORD', repo: 'o/r' }])
  assert.equal(clampGithubPollMinutes(undefined), 0)
  assert.equal(clampGithubPollMinutes('0'), 0)
  assert.equal(clampGithubPollMinutes('15'), 15)
  assert.equal(clampGithubPollMinutes('99999'), 1440)
})

test('缺省全关：无来源/间隔 0 时轮询直接跳过，不触 gh', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  let ghCalls = 0
  service.githubRunner = async () => { ghCalls += 1; return '[]' }
  // 无来源 → disabled（即使间隔已配）。
  service.config.githubPollMinutes = 10
  assert.deepEqual(await pollGithubSources(service), { skipped: 'disabled' })
  // 有来源但间隔 0 → disabled。
  service.config.githubWatch = [{ projectKey: 'ORD', repo: 'o/r' }]
  service.config.githubPollMinutes = 0
  assert.deepEqual(await pollGithubSources(service), { skipped: 'disabled' })
  // 有源有间隔才真正轮询：首拍调 gh，次拍未到点跳过且不再调 gh。
  service.config.githubPollMinutes = 10
  const first = await pollGithubSources(service)
  assert.equal(ghCalls, 1, '首拍真正轮询一次')
  assert.deepEqual(await pollGithubSources(service), { skipped: 'interval' }, '间隔闸：未到点跳过')
  assert.equal(ghCalls, 1, '间隔闸内不触 gh')
})

test('首拍留痕+候选通知，次拍去重零重发；observe 不建卡', async (t) => {
  const { root, store, service, project } = await setup()
  t.after(async () => { await teardown(root, store) })
  service.githubRunner = async (args) => {
    assert.ok(args.includes('-R') && args.includes('o/r'), 'gh 参数带 repo')
    return ISSUES_JSON
  }
  const result = await pollGithubSource(service, { projectKey: 'ORD', repo: 'o/r' })
  assert.deepEqual(result, { recorded: 2, notified: 2 })
  const view = service.externalTriggersView(50)
  assert.equal(view.count, 2)
  assert.deepEqual(view.items.map(item => `${item.externalId}:${item.disposition}`),
    ['o/r#9:notified', 'o/r#7:notified'])
  assert.match(view.items[0].preview, /导出 CSV 慢/)
  const messages = store.all("SELECT body FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '【外部触发】%'", project.id)
  assert.equal(messages.length, 2, '每个新 issue 一条候选通知')
  assert.match(messages[0].body, /不自动建卡/)
  assert.equal(store.get("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?", project.id).count, 0, 'observe：零建卡')

  // 次拍：同一 issue 集合 → 全部 duplicate，零新通知。
  const second = await pollGithubSource(service, { projectKey: 'ORD', repo: 'o/r' })
  assert.deepEqual(second, { recorded: 0, notified: 0 })
  assert.equal(store.all("SELECT body FROM messages WHERE project_id = ? AND sender_type = 'system' AND body LIKE '【外部触发】%'", project.id).length, 2)
})

test('项目 key 不可达 filtered；gh 失败 failed 留痕', async (t) => {
  const { root, store, service } = await setup()
  t.after(async () => { await teardown(root, store) })
  const miss = await pollGithubSource(service, { projectKey: 'NOPE', repo: 'o/r' })
  assert.equal(miss.filtered, 1)
  assert.equal(store.get("SELECT disposition FROM external_triggers WHERE external_id = 'o/r:project'").disposition, 'filtered')

  service.githubRunner = async () => { throw new Error('gh not authed') }
  const failed = await pollGithubSource(service, { projectKey: 'ORD', repo: 'bad/repo' })
  assert.equal(failed.failed, 1)
  const row = store.get("SELECT * FROM external_triggers WHERE external_id = 'bad/repo:poll'")
  assert.equal(row.disposition, 'failed')
  assert.match(row.reason, /gh not authed/)
})

test('gh 坏输出降级：非法 JSON/缺字段条目过滤', () => {
  assert.deepEqual(parseGithubIssues('not-json'), [])
  assert.deepEqual(parseGithubIssues(ISSUES_JSON).map(issue => issue.number), [7, 9])
})
