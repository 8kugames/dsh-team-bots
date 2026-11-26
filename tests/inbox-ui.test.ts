// tests/inbox-ui.test.ts —— 收件箱前端：计数徽标、锚点窗口合并、已读竞态保护与事件接线。
// 前端用例沿用仓库先例：读源断言（tests/helpers/ui-sources.js）+ 标记块执行（tests/desktop-notify.test.ts）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readUiSource } from './helpers/ui-sources.js'
import './helpers/eval-shim.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readSource = (...segments) => readFileSync(join(root, ...segments), 'utf8')
const uiSource = readUiSource()
const apiSource = readSource('ui', 'modules', 'api.ts')

const countBlock = /\/\/ ===== inbox-count:start =====[\s\S]*?\/\/ ===== inbox-count:end =====/.exec(uiSource)?.[0]
assert.ok(countBlock, 'ui 源码缺少 inbox-count 标记块')
const paginationBlock = /\/\/ chat-pagination:start[\s\S]*?\/\/ chat-pagination:end/.exec(uiSource)?.[0]
assert.ok(paginationBlock, 'ui 源码缺少 chat-pagination 标记块')

const counts = new Function('approvalBadgeText', `${countBlock.replace(/export /g, '')}
return { inboxCounts, inboxTotal, inboxBadge }`)(value => (Number(value) > 99 ? '99+' : String(Number(value) || 0)))

test('收件箱计数：四类待办求和，提案只计 pending，徽标 99+ 封顶、0 不出', () => {
  const data = {
    pendingApprovals: { count: 2, items: [{ id: 'a' }, { id: 'b' }] },
    pendingQuestions: { count: 1, items: [] },
    proposals: [{ id: 'p1', status: 'pending' }, { id: 'p2', status: 'approved' }, { id: 'p3', status: 'canary' }],
    pendingOwnerMentions: { count: 3, items: [{ id: 'm' }] },
  }
  assert.deepEqual(counts.inboxCounts(data), { approvals: 2, questions: 1, proposals: 1, mentions: 3 })
  assert.equal(counts.inboxTotal(data), 7, '徽标 = 四类之和，与明细条数无关')
  assert.deepEqual(counts.inboxCounts(null), { approvals: 0, questions: 0, proposals: 0, mentions: 0 }, '空数据不炸')
  assert.equal(counts.inboxBadge(0), '')
  assert.match(counts.inboxBadge(7), /class="unread-badge inbox-badge">7</)
  assert.match(counts.inboxBadge(150), />99\+</)
})

test('锚点窗口：生效时替代最新窗口展示，旧分片仍在前，「之后还有 N 条」含载入后新到的消息', () => {
  const state = {
    chatMode: 'group', soloBotId: null, chatAnchor: null,
    chatOlder: { key: null, items: [], hasMore: false, loading: false },
  }
  const pagination = new Function('state', 'activeProject', `${paginationBlock}
return { activeChatAnchor, anchorNewerCount, mergedChatMessages }`)(state, () => ({ id: 'p1' }))
  const latest = [{ id: 'n1', created_at: '2026-01-03T00:00:00.000Z' }, { id: 'n2', created_at: '2026-01-04T00:00:00.000Z' }]
  assert.deepEqual(pagination.mergedChatMessages(latest).map(m => m.id), ['n1', 'n2'], '无锚点时就是最新窗口')

  // 载入时最新窗口的最后一条是 n2（不是锚点本身）：锚点与它之间的 239 条已记在 newerCount 里。
  state.chatAnchor = {
    key: 'group:p1', anchorId: 'a9', items: [{ id: 'a9', created_at: '2026-01-01T00:00:00.000Z' }],
    newerCount: 239, loadedNewest: { createdAt: '2026-01-04T00:00:00.000Z', id: 'n2' },
  }
  assert.deepEqual(pagination.mergedChatMessages(latest).map(m => m.id), ['a9'], '锚点窗口替代最新窗口，二者不拼接')
  state.chatOlder = { key: 'group:p1', items: [{ id: 'a8', created_at: '2025-12-31T23:59:59.000Z' }], hasMore: false, loading: false }
  assert.deepEqual(pagination.mergedChatMessages(latest).map(m => m.id), ['a8', 'a9'], '锚点之前翻出的旧分片仍排在前面')
  assert.equal(pagination.anchorNewerCount(state.chatAnchor, latest), 239, '载入时记下的条数；最新窗口里已存在的消息不重复计')
  const arrived = [...latest, { id: 'n3', created_at: '2026-01-05T00:00:00.000Z' }]
  assert.equal(pagination.anchorNewerCount(state.chatAnchor, arrived), 240, '载入之后新到的消息计入')
  assert.equal(pagination.anchorNewerCount({ ...state.chatAnchor, loadedNewest: null }, arrived), 239, '载入时没有最新窗口就只认记下的条数')

  state.chatMode = 'solo'
  state.soloBotId = 'b1'
  assert.equal(pagination.activeChatAnchor(), null, '切会话即失效')
  state.chatMode = 'group'
  state.chatAnchor = { ...state.chatAnchor, key: 'group:p2' }
  assert.equal(pagination.activeChatAnchor(), null, '别的项目留下的锚点不串用')
})

test('已读竞态保护：本会话标过已读的 @owner 事项不被迟到的旧响应盖回收件箱', () => {
  const match = apiSource.match(/export function dropReadOwnerMentions\([\s\S]*?\n\}/)
  assert.ok(match, 'api.ts 必须导出 dropReadOwnerMentions')
  const drop = new Function('state', `${match[0].replace(/^export /, '')}\nreturn dropReadOwnerMentions`)({ ownerMentionReadIds: new Set(['m1']) })
  const stale = { pendingOwnerMentions: { count: 2, items: [{ id: 'm1' }, { id: 'm2' }] } }
  const kept = drop(stale)
  assert.deepEqual(kept.pendingOwnerMentions.items.map((item: any) => item.id), ['m2'])
  assert.equal(kept.pendingOwnerMentions.count, 1)
  const untouched = { pendingOwnerMentions: { count: 1, items: [{ id: 'm2' }] } }
  assert.equal(drop(untouched), untouched, '没有命中就不改写对象')
  const noIds = new Function('state', `${match[0].replace(/^export /, '')}\nreturn dropReadOwnerMentions`)({ ownerMentionReadIds: new Set() })
  assert.equal(noIds(untouched), untouched)
})

test('事件接线：跳转、标已读、回到最新、锚点模式下不上报群聊已读', () => {
  const clickSource = readSource('ui', 'modules', 'events-click.ts')
  assert.match(clickSource, /case 'focus-owner-mention':[\s\S]{0,200}await focusOwnerMention\(item\)/)
  assert.match(clickSource, /case 'inbox-mark-read':[\s\S]{0,200}await markOwnerMentionRead\(item\)/)
  assert.match(clickSource, /case 'inbox-mark-all-read':\s*await markAllOwnerMentionsRead\(\)/)
  assert.match(clickSource, /case 'chat-back-to-latest':[\s\S]{0,260}state\.chatAnchor = null[\s\S]{0,160}state\.chatAtBottom = true/, '回到最新：清锚点与分片桶后贴底')
  // 消息行带定位锚点与跳转高亮类。
  assert.match(uiSource, /<div class="message-row\$\{isUser \? ' user' : ''\}\$\{focused\}" data-message-id="\$\{attr\(message\.id\)\}">/)
  // 锚点窗口不等于看到了最新消息：不上报已读水位。
  assert.match(apiSource, /if \(state\.chatAnchor\?\.key === `group:\$\{projectId\}`\) return/)
  // 跳转：消息不在最近一页时按锚点取数，命中后离开底部视角并滚动定位。
  const inboxSource = readSource('ui', 'modules', 'inbox.ts')
  assert.match(inboxSource, /api\('messages_page', \{ projectId: item\.project_id, anchorId: item\.id, limit: CHAT_PAGE_SIZE \}/)
  assert.match(inboxSource, /state\.chatAtBottom = false[\s\S]{0,120}render\(\)\s*document\.querySelector\(`\.message-row\[data-message-id="\$\{item\.id\}"\]`\)\?\.scrollIntoView\(\{ block: 'center' \}\)/)
})

test('后端接线：state 顶层聚合、标已读接口、总监提示词、owner 保留名、入口与高亮样式', () => {
  assert.match(readSource('src', 'services', 'system.ts'), /pendingOwnerMentions: this\.ownerMentionsPending\(\)/)
  const api = readSource('src', 'api.ts')
  assert.match(api, /'mark_chat_read', 'inbox_mark_read', 'inbox_mark_all_read',/, 'ACTIONS 登记标已读接口')
  assert.match(api, /case 'inbox_mark_read':[\s\S]{0,200}service\.markOwnerMentionRead\(required\(payload\.projectId, 'projectId'\), required\(payload\.messageId, 'messageId'\), actor\)/)
  assert.match(readSource('src', 'services', 'bots.ts'), /isReservedBotName\(name\)\) throw conflict\(/, 'owner 保留名：新建与改名都拒绝')
  assert.match(readSource('src', 'services', 'runtime', 'prompt.ts'), /- `@owner` is director-only: start a group message with `@owner` only when the owner must see it or make a decision/)
  assert.match(readSource('ui', 'styles', 'frame.css'), /\.inbox-entry \{/)
  assert.match(readSource('ui', 'styles', 'chat-cards.css'), /\.message-row\.message-focus > \.message-body-wrap \{/)
  assert.match(readSource('ui', 'styles', 'chat-cards.css'), /\.chat-anchor-bar \{/)
})
