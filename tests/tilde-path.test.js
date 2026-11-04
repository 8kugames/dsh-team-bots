// DSHBOTS-186：工作区路径显示缩写 tildePath 的语义边界 + 前端接线回归锁。
// 口径：缩写只发生在展示位（pathCode、终端标题栏文本）；data-copy、title 与请求载荷
// 一律保留完整路径——复制与跳转仍给全路径是本卡硬约束，接线锁专门断言这一点。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// util.js 依赖 state.js（顶层读 location）且自身顶层取 toast-root：给最小桩（同 ui-modules-import.test.js）。
globalThis.location = new URL('http://127.0.0.1:3080/api/dsh-team/ui?view=chat')
globalThis.document = { getElementById: () => null }

const { tildePath } = await import(pathToFileURL(join(root, 'ui/modules/util.js')))

test('macOS 家目录前缀 /Users/{用户} 缩写为 ~', () => {
  assert.equal(tildePath('/Users/silesjian/Desktop/Tools/DSHBots'), '~/Desktop/Tools/DSHBots')
  assert.equal(tildePath('/Users/foo'), '~')
})

test('Linux 家目录前缀 /home/{用户} 同样缩写', () => {
  assert.equal(tildePath('/home/dev/projects/bot'), '~/projects/bot')
  assert.equal(tildePath('/home/dev'), '~')
})

test('非家目录前缀原样返回：其他绝对路径/相对路径/已是 ~/缺用户段', () => {
  assert.equal(tildePath('/tmp/work'), '/tmp/work')
  assert.equal(tildePath('/opt/homebrew/lib'), '/opt/homebrew/lib')
  assert.equal(tildePath('relative/path'), 'relative/path')
  assert.equal(tildePath('~/already'), '~/already')
  assert.equal(tildePath('/Users'), '/Users')
})

test('空值归一为空串', () => {
  assert.equal(tildePath(''), '')
  assert.equal(tildePath(null), '')
  assert.equal(tildePath(undefined), '')
})

test('前端接线锁：展示位走 tildePath，data-copy/title/copyPath 保留完整路径', () => {
  const read = (rel) => readFileSync(join(root, rel), 'utf8')
  const count = (src, needle) => src.split(needle).length - 1

  const chat = read('ui/modules/chat.js')
  // chat.js 三处工作区展示位（群聊侧栏/单聊侧栏/单聊配置页）全部包 tildePath；
  // 复制按钮的 data-copy 仍是完整路径。
  assert.equal(count(chat, 'pathCode(tildePath('), 3, 'chat.js 工作区展示位应全部缩写')
  assert.equal(count(chat, 'pathCode('), 3, 'chat.js 不应再有未缩写的 pathCode 展示位')
  assert.ok(chat.includes('data-copy="${attr(project.workspace_path)}"'), '群聊复制按钮必须保留完整路径')
  assert.equal(count(chat, `data-copy="\${attr(bot.soloWorkspace ?? '')}"`), 2, '单聊两处复制按钮必须保留完整路径')

  const settings = read('ui/modules/settings.js')
  // D-186 卡面口径的「当前生效」行仍在 settings.js；全局「工作区」行随 DSH 路径卡
  // 迁到关于页（DSHBOTS-197），缩写与完整路径复制语义不变，只是换了宿主文件。
  assert.equal(count(settings, 'pathCode(tildePath('), 1, 'settings.js 仅一处工作区展示位缩写（当前生效）')
  assert.ok(settings.includes('copyPath(project.workspace_path)'), '当前生效的复制必须保留完整路径')

  const globalPages = read('ui/modules/global-pages.js')
  assert.equal(count(globalPages, 'pathCode(tildePath('), 1, '关于页工作区展示位缩写（DSHBOTS-197 迁入）')
  assert.ok(globalPages.includes('copyPath(paths.workspace)'), '全局工作区的复制必须保留完整路径')

  const tasks = read('ui/modules/tasks.js')
  // 终端标题栏：显示文本缩写，title 悬浮仍给完整路径。
  assert.ok(tasks.includes('esc(tildePath(project.workspace_path ?? project.name))'), '终端标题栏显示文本应缩写')
  assert.ok(tasks.includes(`title="\${attr(project.workspace_path ?? '')}"`), '终端标题栏 title 必须保留完整路径')
})
