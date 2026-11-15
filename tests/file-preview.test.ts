// tests/file-preview.test.ts —— DSHBOTS-347：文本型文件链接应用内预览。
// ① 纯逻辑：白名单 / 截断 / chip URL 生成（markdown.test.js 式标记块抽取求值）；
// ② 源码锚：modal-forms.js 文本分支出 preview-file 按钮且非白名单仍 <a target=_blank>；
//    tasks.js chips 挂 data-url；chat.js 白名单含 .md/.json 且拒 .svg/.zip/.env；
//    http.js /api/dsh-team/file projectId/soloBotId 二选一校验仍在、文本 2MB 上限；
// ③ 路由行为：文本扩展通过、越界 403、非白名单 400、超上限 413（installHttp 假路由）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { installHttp } from '../src/http.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const modulesDir = join(root, 'ui', 'modules')
const modalFormsJs = readFileSync(join(modulesDir, 'modal-forms.js'), 'utf8')
const tasksJs = readFileSync(join(modulesDir, 'tasks.js'), 'utf8')
const filePreviewJs = readFileSync(join(modulesDir, 'file-preview.js'), 'utf8')
const chatJs = readFileSync(join(root, 'src', 'services', 'chat.js'), 'utf8')
const httpJs = readFileSync(join(root, 'src', 'http.js'), 'utf8')

// —— file-preview-logic 标记块抽取（同 tests/markdown.test.js 的求值方式）——
const logicBlock = /\/\/ file-preview-logic:start[\s\S]*?\/\/ file-preview-logic:end/.exec(filePreviewJs)?.[0]
assert.ok(logicBlock, 'ui/modules/file-preview.js 缺少 file-preview-logic 标记块')
const { isPreviewableText, clipPreviewText, deliverableFileUrl } = new Function(
  `${logicBlock}\nreturn { isPreviewableText, clipPreviewText, deliverableFileUrl }`,
)()

test('isPreviewableText：白名单只收文本扩展，svg/env/zip/图片不入列', () => {
  for (const path of ['a.md', 'b.JSON', 'c.yaml', 'd.toml', 'e.html', 'f.log', 'g.sh', 'h.csv']) {
    assert.ok(isPreviewableText(path), `${path} 应可预览`)
  }
  for (const path of ['a.svg', 'a.zip', 'a.env', 'config.env', '.env', 'a.png', 'a.bin', 'noext']) {
    assert.ok(!isPreviewableText(path), `${path} 不得进预览白名单`)
  }
})

test('clipPreviewText：256KB 与 2000 行先到先裁，小文件原样', () => {
  const small = clipPreviewText('hello\nworld')
  assert.equal(small.body, 'hello\nworld')
  assert.equal(small.truncated, false)
  const fat = clipPreviewText('x'.repeat(300 * 1024))
  assert.equal(fat.body.length, 256 * 1024)
  assert.equal(fat.truncated, true)
  const tall = clipPreviewText(Array.from({ length: 2500 }, (_, i) => `line-${i}`).join('\n'))
  assert.equal(tall.body.split('\n').length, 2000)
  assert.equal(tall.truncated, true)
})

test('deliverableFileUrl：项目路径拼 /api/dsh-team/file，越界与缺项目不生成', () => {
  assert.equal(deliverableFileUrl('p1', 'docs/a.md'), '/api/dsh-team/file?projectId=p1&path=docs%2Fa.md')
  assert.equal(deliverableFileUrl('p1', '报告 最终.json'), '/api/dsh-team/file?projectId=p1&path=%E6%8A%A5%E5%91%8A+%E6%9C%80%E7%BB%88.json')
  assert.equal(deliverableFileUrl('p1', '../secret.md'), null, '.. 段拒绝')
  assert.equal(deliverableFileUrl('p1', 'docs/../../x.md'), null, '中段 .. 拒绝')
  assert.equal(deliverableFileUrl('p1', '/abs.md'), null, '绝对路径拒绝')
  assert.equal(deliverableFileUrl('', 'a.md'), null, '无项目不生成')
})

test('taskDeliverablesBlock：文本 chip 挂 data-url 走 /file，非文本保持纯文字', () => {
  const fnSrc = /export function taskDeliverablesBlock\(task\) \{[\s\S]*?\n\}/.exec(tasksJs)?.[0]
  assert.ok(fnSrc, 'tasks.js 缺少 taskDeliverablesBlock')
  const block = new Function('t', 'attr', 'esc', 'pageProject', 'isPreviewableText', 'deliverableFileUrl',
    `${fnSrc.replace(/^export /, '')}\nreturn taskDeliverablesBlock`)((k) => k, (v) => String(v ?? ''), (v) => String(v ?? ''),
    () => null, isPreviewableText, deliverableFileUrl)
  const html = block({ project_id: 'p1', deliverables: ['docs/a.md', 'bin/x.zip', '../escape.md'] })
  assert.match(html, /data-action="preview-file" data-url="\/api\/dsh-team\/file\?projectId=p1&path=docs%2Fa\.md"/, '文本 chip 挂 data-url')
  assert.match(html, /data-path="docs\/a\.md"/)
  const zipChip = /<span class="approval-chip mono" title="bin\/x\.zip">[^<]*<\/span>/.exec(html)
  assert.ok(zipChip, '.zip 不生成链接')
  const escapeChip = /<span class="approval-chip mono" title="\.\.\/escape\.md">/.exec(html)
  assert.ok(escapeChip, '越界路径不生成链接')
  const solo = block({ deliverables: ['docs/a.md'] })
  assert.ok(!solo.includes('data-url='), '无项目上下文不生成链接')
})

test('源码锚：modal-forms.js 文本分支 preview-file，非白名单仍新窗口 <a>', () => {
  const buttonAt = modalFormsJs.indexOf('data-action="preview-file" data-url="${attr(url)}" data-path="${attr(path)}"')
  const anchorAt = modalFormsJs.indexOf('<a class="artifact-file" href="${attr(url)}" target="_blank" rel="noopener">')
  assert.ok(buttonAt > 0, '文本分支应输出 preview-file 按钮')
  assert.ok(anchorAt > 0, '非白名单应保留 <a target="_blank">')
  assert.ok(buttonAt < anchorAt, '文本分支先于 <a> 兜底分支')
  assert.ok(modalFormsJs.indexOf("ARTIFACT_IMAGE.test(path)") > 0, '图片分支不动')
})

test('源码锚：chat.js 白名单含 .md/.json 且拒 .svg/.zip/.env；http.js 校验与上限仍在', () => {
  assert.ok(chatJs.includes("'.md'"), 'chat.js 文本白名单应含 .md')
  assert.ok(chatJs.includes("'.json'"), 'chat.js 文本白名单应含 .json')
  assert.ok(!chatJs.includes("'.svg'"), 'chat.js 不得放行 .svg')
  assert.ok(!chatJs.includes("'.zip'"), 'chat.js 不得放行 .zip')
  assert.ok(!chatJs.includes("'.env'"), 'chat.js 不得放行 .env')
  assert.ok(httpJs.includes('projectId 与 soloBotId 必须二选一'), '/file 二选一校验必须在')
  assert.ok(httpJs.includes('MAX_CHAT_TEXT_BYTES'), '文本 2MB 上限常量必须在')
  assert.match(httpJs, /FILE_TOO_LARGE[\s\S]{0,120}413/, '超限仍走 413')
  assert.ok(httpJs.includes("modules/file-preview.js"), 'file-preview 模块路由必须注册')
})

// —— 路由级行为：真实 service + installHttp 假路由（同 tests/artifacts.test.ts 口径）——
function fakeHttp(service: TeamService) {
  const routes = new Map()
  const ctx: any = {
    connection: { fetch: { register: (spec: any) => { routes.set(spec.path, spec); return () => routes.delete(spec.path) } } },
    webServer: { register: () => () => {} },
    effect: () => {},
  }
  installHttp(ctx, service, { info() {}, error() {} } as any)
  return (pathWithQuery: string) => {
    const path = pathWithQuery.split('?')[0]
    const spec: any = routes.get(path)
    if (!spec) throw new Error(`没有注册路由 ${path}`)
    return spec.fetch(new Request(`http://localhost${pathWithQuery}`))
  }
}

async function setup() {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-file-preview-'))
  const workspace = join(tmpRoot, 'workspace')
  const dataDir = join(tmpRoot, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'") as any
  const project = await (service as any).createProject({ name: 'Preview', key: 'PRV', ownerBotId: director.id })
  const dir = (service as any).projectWorkDir((service as any).projectRow(project.id))
  await mkdir(join(dir, 'docs'), { recursive: true })
  await writeFile(join(dir, 'docs', 'readme.md'), '# hello\n中文内容\n', 'utf8')
  await writeFile(join(dir, 'notes.json'), '{"a":1}', 'utf8')
  await writeFile(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'utf8')
  await writeFile(join(dir, 'icon.svg'), '<svg onload="x()"/>', 'utf8')
  await writeFile(join(dir, 'archive.zip'), 'PK', 'utf8')
  await writeFile(join(dir, '.env'), 'SECRET=1', 'utf8')
  await writeFile(join(dir, 'config.env'), 'SECRET=1', 'utf8')
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(3 * 1024 * 1024), 'utf8')
  await writeFile(join(workspace, 'secret.md'), 'outside', 'utf8')
  return { tmpRoot, service, project, dir, fetchRoute: fakeHttp(service) }
}

test('路由行为：文本通过 / 越界 403 / 非白名单 400 / 超上限 413 / 二选一 400', async (t) => {
  const { tmpRoot, project, fetchRoute } = await setup()
  t.after(async () => { await rm(tmpRoot, { recursive: true, force: true }) })
  const hit = (path: string) => fetchRoute(`/api/dsh-team/file?projectId=${project.id}&path=${encodeURIComponent(path)}`)

  const md = await hit('docs/readme.md')
  assert.equal(md.status, 200)
  assert.match(md.headers.get('content-type') ?? '', /^text\/plain/, '文本统一 text/plain 下发')
  assert.ok((await md.text()).includes('# hello'))

  const json = await hit('notes.json')
  assert.equal(json.status, 200)
  assert.match(json.headers.get('content-type') ?? '', /^text\/plain/)

  const png = await hit('shot.png')
  assert.equal(png.status, 200)
  assert.equal(png.headers.get('content-type'), 'image/png', '图片口径不动')

  const escape = await hit('../secret.md')
  assert.equal(escape.status, 403, '越界 403')

  for (const path of ['icon.svg', 'archive.zip', '.env', 'config.env']) {
    const res = await hit(path)
    assert.equal(res.status, 400, `${path} 应 400 拒绝`)
  }

  const big = await hit('big.txt')
  assert.equal(big.status, 413, '文本超 2MB 上限 413')

  const noScope = await fetchRoute(`/api/dsh-team/file?path=${encodeURIComponent('docs/readme.md')}`)
  assert.equal(noScope.status, 400, '缺 projectId/soloBotId 400')
  const bothScope = await fetchRoute(`/api/dsh-team/file?projectId=${project.id}&soloBotId=b1&path=${encodeURIComponent('docs/readme.md')}`)
  assert.equal(bothScope.status, 400, '两参同给 400')
})
