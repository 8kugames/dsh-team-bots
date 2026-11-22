// DSHBOTS-32 群聊审批：宿主 approval/request waterfall 的插件侧应答器。
// 认领 session_bindings 命中的 bot 会话：绑定到项目的走群聊卡片；绑定为单聊（kind='solo'、
// project_id 为空）的走单聊卡片（DSHBOTS-218）；其余 next() 透传（人类会话审批继续走 Web UI）。
// 决策权仅用户（type=user）持有，bot 一律 forbidden 不能自批；pending 之外拒绝重复应答，动作写审计。
// DSHBOTS-365 免审白名单：命中规则的提权请求不落待办卡，插件在认领入口即时替 owner 应答
// allowed-once；approvals 行照落（status='allowed'、decided_by='auto:rule:<id>'）+ 审计事件
// approval.auto_allow，免审不免留痕。规则存 settings 'approval_auto_rules'（JSON 数组，仿
// prompt_overrides 独立编辑面先例，不进 settingsView 单值键域），仅 type=user 可写。
// 注意：本域自管迁移（db.js 已贴 800 行上限，一行不加），手法与 db.js 的 addColumn/recordMigration 一致。
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { id, nowIso } from '../util.js'
import { effectiveApprovalTimeoutMs } from '../config.js'
import { botInActiveProject } from './questions.js'
import { columnNotNull, rebuildTable } from '../db-migrations.js'
import { APPROVAL_FULL_ACCESS_SETTING } from './runtime/sandbox-policy.js'

// project_id 可空：单聊会话没有项目归属（DSHBOTS-218），卡片锚点改落 solo_messages。
const APPROVALS_TABLE_DDL = `
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  bot_id TEXT NOT NULL,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  call_id TEXT,
  reason TEXT,
  display_reason TEXT,
  tool_target TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
`
const APPROVALS_DDL = `
CREATE TABLE IF NOT EXISTS approvals (${APPROVALS_TABLE_DDL});
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS approvals_project_idx ON approvals(project_id, created_at);
`

// 迁移体全在本文件：建表、messages 加 kind/approval_id 两列、幂等登记迁移名。
// 重启清理也在此——宿主侧请求随进程消失，不可能再被应答，库里残留的 pending 一律置 timeout。
export function ensureApprovalSchema(store) {
  store.exec(APPROVALS_DDL)
  // 旧库 approvals.project_id 是 NOT NULL（群聊专用时期），单聊会话无处归属：重建放宽为可空。
  if (columnNotNull(store.db, 'approvals', 'project_id')) {
    rebuildTable(store.db, 'approvals', `CREATE TABLE approvals (${APPROVALS_TABLE_DDL})`)
    store.exec('CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at)')
    store.exec('CREATE INDEX IF NOT EXISTS approvals_project_idx ON approvals(project_id, created_at)')
  }
  const messageColumns = store.all('PRAGMA table_info(messages)').map(column => column.name)
  if (!messageColumns.includes('kind')) {
    store.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'")
  }
  if (!messageColumns.includes('approval_id')) {
    store.exec('ALTER TABLE messages ADD COLUMN approval_id TEXT')
  }
  // 旧库的 approvals 表没有 tool_target 列（新库建表 DDL 已带）。
  const approvalColumns = store.all('PRAGMA table_info(approvals)').map(column => column.name)
  if (!approvalColumns.includes('tool_target')) {
    store.exec('ALTER TABLE approvals ADD COLUMN tool_target TEXT')
  }
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    'approvals_table', nowIso(),
  )
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    'messages_approval_link', nowIso(),
  )
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    'approvals_tool_target', nowIso(),
  )
  store.run(
    "UPDATE approvals SET status = 'timeout' WHERE status = 'pending'",
  )
  // 出厂预置默认免审规则（DSHBOTS-365 增量）：仅键未初始化（null）时播种一次；非-null
  // 一律不动——'[]' 是 owner 显式清空，永不回播；重复执行幂等，不做回填迁移。
  if (store.setting(APPROVAL_RULES_SETTING) === null) {
    store.setSetting(APPROVAL_RULES_SETTING, JSON.stringify(DEFAULT_APPROVAL_AUTO_RULES))
  }
  // 存量预置行迁移（口径改 glob）：仍是出厂原样的预置行替换为三条关键词 glob；owner 自建或
  // 改过的行不动，显式清空（[]）不回播。迁移后预置行都带通配符，重复执行不再命中。
  const migrated = migrateApprovalPresetRules(store.setting(APPROVAL_RULES_SETTING))
  if (migrated) store.setSetting(APPROVAL_RULES_SETTING, migrated)
}

// 目标提取（纯函数）：按参数形状判别，不按工具名——宿主工具族会扩展，形状更稳。
// bash 类取 command 首行（超长截 120 字符，chip 只需要可辨认的意图）；
// edit/write/read 类取 file_path 原样（绝对路径入库，展示层再收成工作区相对形）。
// 路径位参数名按常见形状收口：file_path 优先，path/target_dir/dir/directory/cwd/workdir 兜底
// （免审不因工具换了参数名就永远提不到目标 → 永远落卡）。
const TOOL_TARGET_PATH_KEYS = ['file_path', 'path', 'target_dir', 'dir', 'directory', 'cwd', 'workdir']
export function toolTargetOf(arguments_) {
  if (!arguments_ || typeof arguments_ !== 'object') return null
  if (typeof arguments_.command === 'string') {
    const firstLine = arguments_.command.trim().split('\n')[0].trim()
    return firstLine ? firstLine.slice(0, 120) : null
  }
  for (const key of TOOL_TARGET_PATH_KEYS) {
    const value = arguments_[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

// pre-execute 目标缓存上限：只记最近若干次调用的目标，防长会话里无界增长。
const APPROVAL_TARGET_CACHE_LIMIT = 200

// ── 免审规则（DSHBOTS-365）──────────────────────────────────────────────────
// 结构化规则列表：主维度 path_prefix（工作区外目录前缀）/ command（命令首行前缀），
// 辅维度 bot_id / tool_name / sandbox（目标沙箱档；danger-full-access 可配、默认规则集为空
// 自然不含）。存储仿 prompt_overrides：settings 键 'approval_auto_rules' 存 JSON 数组，
// 独立编辑面（approvalRulesView / updateApprovalRules），不进 settingsView 单值键域。
export const APPROVAL_RULES_SETTING = 'approval_auto_rules'
export const APPROVAL_RULES_LIMIT = 50
// 规则可配的沙箱档：宿主 bash 族提权重试时的 sandbox_permissions 取值；空串 = 任意档。
export const APPROVAL_RULE_SANDBOXES = ['workspace-write', 'danger-full-access']

// 系统临时目录（$TMPDIR）：macOS 是 /var/folders/<user>/<hash>/T，名字不含 temp/tmp，
// 关键词 glob 覆盖不到——单独一行兜底；Linux 的 tmpdir() 就是 /tmp，已被覆盖就不重复一行。
const OS_TMPDIR = tmpdir().replace(/[/\\]+$/, '')

// 出厂预置默认规则（DSHBOTS-365 增量改口径）：关键词 glob 三条——
// **/temp/**、**/.tmp/**、**/tmp/** 命中即免审（路径与命令同一套 glob 方言），
// 再加系统临时目录一行（未被关键词覆盖时）。预置行仍是普通规则行，owner 可自行删改。
const KEYWORD_APPROVAL_AUTO_RULES = [
  { glob: '**/temp/**', key: 'temp' },
  { glob: '**/.tmp/**', key: 'dot_tmp' },
  { glob: '**/tmp/**', key: 'tmp' },
]
const TMPDIR_COVERED = KEYWORD_APPROVAL_AUTO_RULES.some(item => approvalGlobMatch(item.glob, OS_TMPDIR))
export const DEFAULT_APPROVAL_AUTO_RULES = [
  ...KEYWORD_APPROVAL_AUTO_RULES,
  ...(TMPDIR_COVERED ? [] : [{ glob: `${OS_TMPDIR}/**`, key: 'tmpdir' }]),
].map(item => ({
  id: `arul_default_${item.key}`,
  path_prefix: item.glob,
  command: '',
  bot_id: '',
  tool_name: '',
  sandbox: '',
  note: '',
  updated_at: nowIso(),
  updated_by: 'system:preset',
}))

// 系统预置行的「出厂原样」形态：id → 可接受的路径形态（口径迭代换过形态的都列进来）。
// 迁移时按这张表认出仍是出厂样的预置行换成当前默认集合；owner 改过路径的预置行不在表内，
// 视为 owner 自有行保留。owner 自建行（id 不在这张表）同样保留。
const SYSTEM_PRESET_PATTERNS = new Map<string, string[]>([
  ['arul_default_tmp', ['/tmp', '**/tmp/**']],
  ['arul_default_private_tmp', ['/private/tmp']],
  ['arul_default_var_tmp', ['/var/tmp']],
  ['arul_default_tmpdir', [OS_TMPDIR, `${OS_TMPDIR}/**`]],
  ['arul_default_home_dot_tmp', [join(homedir(), '.tmp').replace(/[/\\]+$/, '')]],
  ['arul_default_home_tmp', [join(homedir(), 'tmp').replace(/[/\\]+$/, '')]],
  ['arul_default_temp', ['**/temp/**']],
  ['arul_default_dot_tmp', ['**/.tmp/**']],
])

// settings 'approval_auto_rules' 解析：坏数据一律降级为空规则（不抛错，原卡流程兜底）。
export function parseApprovalRules(raw) {
  let parsed
  try {
    parsed = JSON.parse(String(raw ?? ''))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(item => item && typeof item === 'object')
}

// glob 方言（路径与命令共用）：** 跨任意层级（含 '/'）、* 跨任意字符但不跨 '/'、
// ? 单字符（不跨 '/'）、其余按字面量；整串命中才算匹配。尾部 '/**' 额外允许匹配目录自身
// （'/tmp/**' 命中 '/tmp' 与 '/tmp/a/b'，但不命中 '/tmpfoo'）。
export function approvalGlobToRegExp(pattern) {
  let text = String(pattern ?? '')
  let tail = ''
  if (text.endsWith('/**')) {
    text = text.slice(0, -3)
    tail = '(?:/.*)?'
  }
  let out = '^'
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '*') {
      const doubled = text[index + 1] === '*'
      if (!doubled) {
        out += '[^/]*'
        index += 1
        continue
      }
      index += 2
      if (text[index] === '/') {
        // 行首的 **/：前缀边界除「/ 结尾的任意前缀」外还允许「以空白结尾」（或串首）——
        // 命令维度的目标是命令首行（如 `mkdir -p .tmp/bots/x`），相对路径前面是空格不是 /，
        // 旧的 (?:.*/)? 永远吃不到这段前缀，关键词免审规则对相对路径命令整体失明。
        const atPatternStart = index === 2
        index += 1
        out += atPatternStart ? '(?:.*?[/\\s])?' : '(?:.*/)?'
      } else {
        out += '.*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      index += 1
      continue
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    index += 1
  }
  return new RegExp(`${out}${tail}$`)
}

export function approvalGlobMatch(pattern, value) {
  const text = String(value ?? '')
  if (!String(pattern ?? '') || !text) return false
  return approvalGlobToRegExp(pattern).test(text)
}

// 单条规则匹配（纯函数）：目标为空不命中；主维度二选一命中即中——
// 路径规则与命令规则都用 glob 整串匹配；不含通配符的存量规则保留旧前缀语义
// （路径按目录边界、命令按词边界），口径切换不静默废掉已配规则。
// 辅维度留空 = 通配，填了必须精确相等。
export function approvalRuleMatches(rule, { botId, toolName, target, sandbox }) {
  const value = String(target ?? '')
  if (!value) return false
  if (rule.bot_id && rule.bot_id !== botId) return false
  if (rule.tool_name && rule.tool_name !== toolName) return false
  if (rule.sandbox && rule.sandbox !== sandbox) return false
  const pathPattern = String(rule.path_prefix ?? '').trim()
  if (pathPattern && matchesRulePattern(pathPattern, value, 'path')) return true
  const commandPattern = String(rule.command ?? '').trim()
  if (commandPattern && matchesRulePattern(commandPattern, value, 'command')) return true
  return false
}

// 含通配符 → glob；不含通配符 → 存量前缀语义（路径按目录边界、命令按词边界）。
// 路径维度支持 ~ 开头：~ 与 ~/… 在匹配时展开为当前用户家目录（规则按字面存储，跨机器可移植）。
function matchesRulePattern(pattern, value, dimension) {
  if (dimension === 'path' && (pattern === '~' || pattern.startsWith('~/'))) {
    const home = homedir().replace(/[/\\]+$/, '')
    pattern = pattern === '~' ? home : `${home}${pattern.slice(1)}`
  }
  if (/[*?]/.test(pattern)) return approvalGlobMatch(pattern, value)
  if (dimension === 'path') return value === pattern || value.startsWith(`${pattern}/`)
  return value === pattern || value.startsWith(`${pattern} `)
}

// 存量预置行迁移：仍是出厂原样的预置行换成当前默认集合（口径迭代换过形态的都算「原样」），
// owner 自建行与改过路径的预置行不动，显式清空 '[]' 依然永不回播。
// 返回迁移后的 JSON 字符串，无需迁移时返回 null。
export function migrateApprovalPresetRules(raw) {
  let parsed
  try {
    parsed = JSON.parse(String(raw ?? ''))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const rows = parsed.filter(item => item && typeof item === 'object')
  const isSystemPreset = row => {
    const id = typeof row.id === 'string' ? row.id : ''
    const patterns = SYSTEM_PRESET_PATTERNS.get(id)
    if (!patterns || String(row.command ?? '').trim()) return false
    const path = String(row.path_prefix ?? '').replace(/[/\\]+$/, '')
    return patterns.some(pattern => pattern.replace(/[/\\]+$/, '') === path)
  }
  if (!rows.some(isSystemPreset)) return null
  const firstIndex = rows.findIndex(isSystemPreset)
  const kept = rows.filter(row => !isSystemPreset(row))
  const before = rows.slice(0, firstIndex).filter(row => !isSystemPreset(row)).length
  const presets = DEFAULT_APPROVAL_AUTO_RULES.map(rule => ({ ...rule }))
  return JSON.stringify([...kept.slice(0, before), ...presets, ...kept.slice(before)])
}

// 来源定位字段（DSHBOTS-240）：审批行 → 来源群聊（项目名/KEY）+ 任务 ID/标识/标题。
// 列表查询用 JOIN 一次取齐（approvalsPending / approvalsForProject / approvalsForBot 共用），
// 避免逐行 N+1；缺任务时任务字段留空，不猜。
function approvalSourceFields(row) {
  const key = row.project_key ?? ''
  return {
    projectName: row.project_name ?? '',
    projectKey: key,
    taskId: row.task_id ?? null,
    taskIdentifier: row.task_id ? `${row.task_project_key ?? key ?? 'T'}-${row.task_number}` : null,
    taskTitle: row.task_title ?? null,
  }
}

export const approvalsMethods = {
  // 由 core.attachRuntime 调用：注册宿主事件。runtime.ctx 不存在（测试桩）时跳过注册，
  // 但 pending Map 无条件初始化——handleApprovalRequest 直调（测试）也依赖它。
  approvalsAttach(runtime) {
    this.approvalPending = new Map()
    this.approvalTargets = new Map()
    if (this.approvalsAttached || !runtime?.ctx?.on) return
    this.approvalsAttached = true
    // prepend：宿主 approval/request 是「按注册序」的瀑布流——先执行的监听器若不调用 next()，
    // 就截断后面整条链路。web bundle 的 dsh-api-remotes 比本插件先加载，它把请求转给 DSH 原生审批面板，
    // 面板给出答案后直接 resolve 且不调 next()；插件若排在其后就永远收不到请求，审批请求全落到原生界面
    // （approvals 表零记录、工作台审批卡片不出现）。插到队首后：命中项目绑定的 bot 会话由插件自己应答，
    // 未命中的照旧 next() 透传给原生界面。
    const off = runtime.ctx.on('approval/request', (req, next) => this.handleApprovalRequest(req, next), { prepend: true })
    // approval/request 事件不带工具参数，目标取数只能从 tools/pre-execute 透传监听来：
    // 宿主先过 pre-execute 网关、gate 返回 ask 才发起审批，此刻 exec 里带着 callId/name/arguments。
    // 按 callId 记已提取目标与目标沙箱档（DSHBOTS-365 辅维度；先提短串再掩码，只存小字符串），
    // 审批发起时一次性取走；超量 FIFO 驱逐。
    const offPreExecute = runtime.ctx.on('tools/pre-execute', (exec, next) => {
      const callId = exec?.callId ? String(exec.callId) : ''
      const target = callId ? toolTargetOf(exec.arguments) : null
      if (callId && target) {
        const sandbox = typeof exec.arguments?.sandbox_permissions === 'string' ? exec.arguments.sandbox_permissions : ''
        this.approvalTargets.set(callId, { target: this.maskSecretValues(target), sandbox })
        if (this.approvalTargets.size > APPROVAL_TARGET_CACHE_LIMIT) {
          this.approvalTargets.delete(this.approvalTargets.keys().next().value)
        }
      }
      return next()
    })
    runtime.ctx.effect?.(() => () => {
      off?.()
      offPreExecute?.()
      for (const pending of this.approvalPending.values()) clearTimeout(pending.timer)
      this.approvalPending.clear()
      this.approvalTargets.clear()
    }, 'dsh-team: approval request binding')
  },

  // waterfall 监听器：命中 bot 会话且绑定到项目才认领走群聊卡片；单聊会话（kind='solo'、
  // project_id 为空）由工作台单聊卡片承接（DSHBOTS-218）；其余（未绑定、bot 间私信）透传。
  async handleApprovalRequest(req, next) {
    const sessionId = req?.agent?.session?.id
    // bindingOfSession 在 DshRuntime 原型上，服务层拿不到 this 绑定，这里直查同款 SQL。
    const binding = sessionId
      ? this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
      : undefined
    if (!binding) return next()

    const store = this.store
    // DSHBOTS-294：与 questions.ts 同款——solo 判定按「无 project 上下文的控制面会话」。
    const isSolo = !binding.project_id && (binding.kind === 'solo' || (binding.kind === 'bot' && !botInActiveProject(store, binding.bot_id)))
    if (!binding.project_id && !isSolo) return next()
    const bot = store.get('SELECT * FROM bots WHERE id = ?', binding.bot_id)
    const project = isSolo ? null : store.get('SELECT * FROM projects WHERE id = ?', binding.project_id)
    if (!bot || (!isSolo && !project)) return next()

    const run = store.get('SELECT id FROM runs WHERE session_id = ? ORDER BY queued_at DESC LIMIT 1', sessionId)
    const timeoutMs = effectiveApprovalTimeoutMs(this.config, key => this.store.setting(key))
    const createdAt = nowIso()
    const approvalId = id('apr')
    const toolName = String(req.toolName ?? 'tool').slice(0, 100)
    // 摘要优先展示中文文案；reason 是英文机读串，落库前统一过密钥掩码。
    const displayReason = req.displayReason?.zh ? this.maskSecretValues(String(req.displayReason.zh).slice(0, 2_000)) : null
    const reason = this.maskSecretValues(String(req.reason ?? '').slice(0, 2_000))
    // 本次调用的操作目标：pre-execute 阶段按 callId 记下，这里一次性取走（不留残页）；没有则为 NULL，
    // UI 回退到从摘要正则猜测的旧口径。sandbox 是目标沙箱档（免审规则辅维度，DSHBOTS-365）。
    const callId = req.callId ? String(req.callId) : null
    const cachedTarget = callId ? (this.approvalTargets.get(callId) ?? null) : null
    const toolTarget = cachedTarget?.target ?? null
    const targetSandbox = cachedTarget?.sandbox ?? ''
    if (callId) this.approvalTargets.delete(callId)

    store.run(
      `INSERT INTO approvals(id, project_id, run_id, bot_id, session_id, tool_name, call_id, reason, display_reason, tool_target, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      approvalId, project?.id ?? null, run?.id ?? null, bot.id, sessionId,
      toolName, callId, reason, displayReason, toolTarget,
      createdAt, new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
    )

    // DSHBOTS-365 免审白名单：命中规则的提权请求不落待办卡、不发群聊锚点/微信转发/通知，
    // 插件即时替 owner 应答 allowed-once。留痕两件套缺一不可：approvals 行 status='allowed'
    // + decided_by='auto:rule:<id>'（复用 settleApproval，decided_at 同步落库），审计事件
    // approval.auto_allow。每次调用一放行一结：规则每次现读，改规则即时生效，无持久授权。
    // 不进 approvalPending、不挂超时 timer、不挂 abort 监听——超时与轮次中止对已决条目天然不触。
    const autoRule = this.matchApprovalAutoRule({ botId: bot.id, toolName, target: toolTarget, sandbox: targetSandbox })
    if (autoRule) {
      this.settleApproval(approvalId, 'allowed', 'allowed-once', `auto:rule:${autoRule.id}`)
      this.audit(
        { type: 'system', id: 'system' }, 'approval.auto_allow', 'approval', approvalId,
        { ruleId: autoRule.id, toolName, botId: bot.id, target: toolTarget },
      )
      return 'allowed-once'
    }

    // 卡片锚点：群聊落 messages（kind=approval），单聊落 solo_messages（DSHBOTS-218）。
    // 状态渲染时查 approvals 表，消息体只是纯文本兜底，不承载状态。
    const summary = displayReason || reason || '请求执行需要授权的操作'
    const anchorBody = `【审批请求】${bot.name} 请求使用 ${toolName}：${summary}`
    if (isSolo) {
      this.insertSoloMessage?.({
        botId: bot.id, senderType: 'system', senderId: 'system',
        body: anchorBody, runId: run?.id ?? null, createdAt, kind: 'approval', approvalId,
      })
    } else {
      const group = this.groupOf(project.id)
      // 卡片锚点住项目聊天库（chat-db-split Phase 1）。
      this.groupChatStore(project.id).run(
        `INSERT INTO messages(id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, kind, approval_id, created_at)
         VALUES (?, ?, ?, 'system', ?, ?, '[]', 'approval', ?, ?)`,
        id('msg'), project.id, group?.id ?? null, bot.id, anchorBody, approvalId, createdAt,
      )
    }

    // DSHBOTS-215 问答回路：审批转发微信管理员（通道可用时）。只推纯文本镜像，
    // 状态仍由群卡片/工作台承载；管理员决定经「批 <token> 允许|拒绝」路由回本条目。
    // 单聊没有项目语境，不转发（微信侧只服务项目管理者）。
    if (project) {
      try {
        this.wechatApproval?.(project, { id: approvalId, bot_name: bot.name, tool_name: toolName, reason: summary })
      } catch (error: any) {
        this.logger?.warn?.('dsh-team: 微信审批转发失败: %s', error?.message ?? error)
      }
    }

    return new Promise(resolve => {
      this.approvalPending ??= new Map()
      const timer = setTimeout(() => {
        // 超时按 reject 结算当次（宿主约束：应答不能跨轮次持久化后补答）。
        this.settleApproval(approvalId, 'timeout', 'rejected', null)
      }, timeoutMs)
      this.approvalPending.set(approvalId, { resolve, timer })
      // 轮次中止：宿主自行结算 cancelled，这里只清条目，不重复应答；迟到应答宿主会丢弃。
      req.signal?.addEventListener('abort', () => {
        this.settleApproval(approvalId, 'cancelled', null, null)
      }, { once: true })
    })
  },

  // 统一结算：清定时器、出 pending 表、写终态。hostAnswer 非空才向宿主应答（abort 分支不答）。
  // 写库容错：结算可能由轮次取消的 abort 监听或超时定时器在插件重载（store.close()）之后
  // 迟到触发——曾在 abort 分发里裸抛 statement has been finalized，把整个 dsh 宿主打成 fatal 退出。
  settleApproval(approvalId, status, hostAnswer, decidedBy) {
    const pending = this.approvalPending?.get(approvalId)
    if (pending) {
      clearTimeout(pending.timer)
      this.approvalPending.delete(approvalId)
    }
    try {
      this.store.run(
        'UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = ?',
        status, decidedBy, nowIso(), approvalId, 'pending',
      )
    } catch (error: any) {
      this.logger?.warn?.('dsh-team: 审批结算写库失败（插件可能已重载）: %s', error?.message ?? error)
    }
    if (pending && hostAnswer) pending.resolve(hostAnswer)
  },

  // 群聊按钮入口（api action approval_decide）。鉴权：仅项目负责人（本地工作台用户）可作答，
  // bot 一律拒绝——审批是人对 bot 的授权，bot 不能自批（配合上下文隔离双保险）。动作写审计。
  async decideApproval(approvalId, decision, actor = this.actor()) {
    if (actor?.type !== 'user') throw forbidden('仅项目负责人可操作审批，bot 不能自批')
    if (!['allow', 'reject'].includes(decision)) throw badRequest('审批结果无效')
    const approval = this.store.get('SELECT * FROM approvals WHERE id = ?', approvalId)
    if (!approval) throw notFound('审批不存在')
    if (approval.status !== 'pending') throw conflict('审批已处理')
    const decidedBy = `${actor.type}:${actor.id}`
    this.settleApproval(approvalId, decision === 'allow' ? 'allowed' : 'rejected', decision === 'allow' ? 'allowed-once' : 'rejected', decidedBy)
    this.audit(actor, `approval.${decision}`, 'approval', approvalId, { toolName: approval.tool_name, botId: approval.bot_id })
    return this.approvalView(this.store.get('SELECT * FROM approvals WHERE id = ?', approvalId))
  },

  // 免审规则取数（DSHBOTS-365）：每次现读现解析——无缓存，改规则对下一次提权请求即时生效。
  approvalRulesView() {
    return parseApprovalRules(this.store.setting(APPROVAL_RULES_SETTING, ''))
  },

  // 免审规则匹配入口：按规则表顺序首中即返（表序即优先级）。目标为空（无 callId 缓存）
  // 一律不命中，保守回落原卡流程。
  matchApprovalAutoRule(input) {
    const target = String(input.target ?? '')
    if (!target) return null
    for (const rule of this.approvalRulesView()) {
      if (approvalRuleMatches(rule, input)) return rule
    }
    return null
  },

  // 免审规则保存（DSHBOTS-365）：独立编辑面（仿 updatePromptSegment 先例），仅 type=user
  // 可写——bot 写免审规则必须被拒，维持「bot 不能自批」边界。整表替换（UI 全量收集后提交），
  // 逐条校验：主维度至少一项、路径前缀必须是绝对路径、sandbox 档枚举收口、bot 必须存在。
  // 保存即审计；id 复用已有（编辑保 id），新条目发 arul_*。
  async updateApprovalRules(rulesInput, actor = this.actor()) {
    if (actor?.type !== 'user') throw forbidden('仅工作台 owner 可配置审批免审规则，bot 不能自批')
    if (!Array.isArray(rulesInput)) throw badRequest('免审规则必须是数组')
    if (rulesInput.length > APPROVAL_RULES_LIMIT) throw badRequest(`免审规则最多 ${APPROVAL_RULES_LIMIT} 条`)
    const knownIds = new Set(this.approvalRulesView().map(rule => rule.id))
    const usedIds = new Set<string>()
    const rules = rulesInput.map((raw, index) => {
      const item = raw && typeof raw === 'object' ? raw : {}
      const label = `第 ${index + 1} 条规则`
      const pathPrefix = String(item.path_prefix ?? '').trim().replace(/\/+$/, '')
      const command = String(item.command ?? '').trim().split('\n')[0].trim().slice(0, 200)
      if (!pathPrefix && !command) throw badRequest(`${label}缺少路径规则或命令规则（至少填一项）`)
      // 路径规则：绝对路径、~ 开头的家目录路径（~/…，匹配时展开），或含通配符的 glob
      // （关键词规则如 **/tmp/** 不必是绝对路径）。
      if (pathPrefix && !pathPrefix.startsWith('/') && !pathPrefix.startsWith('~') && !/[*?]/.test(pathPrefix)) {
        throw badRequest(`${label}路径规则必须是以 / 开头的绝对路径、~ 开头的家目录路径或含通配符的 glob`)
      }
      if (pathPrefix.length > 500) throw badRequest(`${label}路径规则超长（上限 500 字符）`)
      const botId = String(item.bot_id ?? '').trim()
      if (botId && !this.store.get('SELECT id FROM bots WHERE id = ?', botId)) throw badRequest(`${label}限定的 Bot 不存在`)
      const sandbox = String(item.sandbox ?? '').trim()
      if (sandbox && !APPROVAL_RULE_SANDBOXES.includes(sandbox)) {
        throw badRequest(`${label}沙箱档必须是 ${APPROVAL_RULE_SANDBOXES.join('/')} 或留空`)
      }
      // id 复用已有（编辑保 id）；新条目或输入撞 id（重复行）一律发新 id，保证表内 id 唯一。
      let ruleId = item.id && knownIds.has(String(item.id)) && !usedIds.has(String(item.id)) ? String(item.id) : id('arul')
      usedIds.add(ruleId)
      return {
        id: ruleId,
        path_prefix: pathPrefix,
        command,
        bot_id: botId,
        tool_name: String(item.tool_name ?? '').trim().slice(0, 100),
        sandbox,
        note: String(item.note ?? '').trim().slice(0, 200),
        updated_at: nowIso(),
        updated_by: `${actor.type}:${actor.id}`,
      }
    })
    this.store.setSetting(APPROVAL_RULES_SETTING, JSON.stringify(rules))
    // 推进 settings_revision：免审规则存 settings 表但不进 stateVersion 签名的任何表列，
    // 不 bump 的话保存后客户端轮询命中 unchanged 短路，规则列表最长 60s 才刷出来。
    this.store.setSetting('settings_revision', String(this.settingsRevision() + 1))
    // 追溯放行：发起时未命中而落卡的 pending 审批，保存规则后立刻重判一遍——命中即按同口径
    // allowed-once 放行并留痕，「先见卡、后补规则」不再要求重跑流程。沙箱档不入 approvals 表，
    // 限档规则（sandbox 非空）拿空档冒充命中不稳，不参与追溯。
    const pendingRows = this.store.all("SELECT id, bot_id, tool_name, tool_target FROM approvals WHERE status = 'pending'") ?? []
    for (const pendingRow of pendingRows) {
      const hit = this.matchApprovalAutoRule({ botId: pendingRow.bot_id, toolName: pendingRow.tool_name, target: pendingRow.tool_target, sandbox: '' })
      if (!hit) continue
      this.settleApproval(pendingRow.id, 'allowed', 'allowed-once', `auto:rule:${hit.id}`)
      this.audit(actor, 'approval.auto_allow', 'approval', pendingRow.id, {
        ruleId: hit.id, retroactive: true, toolName: pendingRow.tool_name, botId: pendingRow.bot_id, target: pendingRow.tool_target,
      })
    }
    this.audit(actor, 'approval_rules.update', 'settings', APPROVAL_RULES_SETTING, {
      count: rules.length,
      rules: rules.map(rule => ({ id: rule.id, path_prefix: rule.path_prefix, command: rule.command, sandbox: rule.sandbox })),
    })
    return this.approvalRulesView()
  },

  // 完全权限总开关（DSHBOTS-366 免审权限卡）：读侧每次现读现解析——无缓存，改开关对
  // 下一次会话/运行即时生效（applyFilePolicy 每次会话创建/复用都重读）。
  fullAccessAllEnabled() {
    return this.store.setting(APPROVAL_FULL_ACCESS_SETTING, '0') === '1'
  },

  // 开关写侧与免审规则同一信任边界：仅工作台 owner（type=user）可切，bot 不能自批
  // 权限面。存 '1'/'0'（仿 wechat_channel_enabled 先例）；bump settings_revision 让
  // 客户端轮询立刻刷到新状态（settings 不进 stateVersion 表列签名，走 revision 分量）。
  // bot 配置档与任务覆盖原样保留：关掉开关即恢复原判定，不做破坏性改写。
  async updateApprovalFullAccess(enabled, actor = this.actor()) {
    if (actor?.type !== 'user') throw forbidden('仅工作台 owner 可切换完全权限，bot 不能自批')
    const next = enabled === true || enabled === '1' || enabled === 'true'
    this.store.setSetting(APPROVAL_FULL_ACCESS_SETTING, next ? '1' : '0')
    this.store.setSetting('settings_revision', String(this.settingsRevision() + 1))
    this.audit(actor, 'approval_full_access.update', 'settings', APPROVAL_FULL_ACCESS_SETTING, { enabled: next })
    return { enabled: next }
  },

  // 目标展示形：绝对路径落在项目工作区内且剩余段非空、不含空白时收成相对路径（chip 少占宽）；
  // 命令、带空白的路径或库外路径原样返回。title 层恒用原始值，鼠标悬停可见全貌。
  toolTargetDisplay(target) {
    const prefix = `${this.config.workspace}/`
    if (typeof target === 'string' && target.startsWith(prefix)) {
      const rest = target.slice(prefix.length)
      if (rest && !/\s/.test(rest)) return rest
    }
    return target
  },

  approvalView(row) {
    const bot = this.store.get('SELECT name FROM bots WHERE id = ?', row.bot_id)
    const expiresAt = Date.parse(row.expires_at)
    // 来源群聊标识（DSHBOTS-312）：approvalView 单行路径（decide 等）也带 project_key/name，
    // 与列表 JOIN 口径一致——行里已带（列表查询 JOIN 产物）则不重查。
    const source = row.project_key !== undefined ? row : (row.project_id
      ? this.store.get('SELECT key AS project_key, name AS project_name FROM projects WHERE id = ?', row.project_id) ?? {}
      : {})
    return {
      ...row,
      botName: bot?.name ?? 'Bot',
      tool_target_display: row.tool_target ? this.toolTargetDisplay(row.tool_target) : null,
      projectKey: source.project_key ?? null,
      projectName: source.project_name ?? null,
      // 会话归属（DSHBOTS-218）：单聊审批没有项目，UI 据此显示来源列并决定跳转目标。
      scope: row.project_id ? 'project' : 'solo',
      remainingMs: row.status === 'pending' ? Math.max(0, expiresAt - Date.now()) : 0,
    }
  },

  // state 视图的待审批条目：pending 在前（按创建时间倒序），已决的跟在后面供卡片回显结果。
  // 来源定位字段同 approvalsPending（DSHBOTS-240）：桌面通知与顶部通知共用同一套取数口径。
  approvalsForProject(projectId) {
    const rows = this.store.all(
      `SELECT a.*, p.name AS project_name, p.key AS project_key,
              t.id AS task_id, t.number AS task_number, t.title AS task_title, tp.key AS task_project_key
       FROM approvals a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN runs r ON r.id = a.run_id
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN projects tp ON tp.id = t.project_id
       WHERE a.project_id = ?
       ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 30`,
      projectId,
    )
    return rows.map(row => ({ ...this.approvalView(row), ...approvalSourceFields(row) }))
  },

  // 单聊视图的待审批条目（DSHBOTS-218）：口径与 approvalsForProject 一致，按 bot 取项目外条目。
  approvalsForBot(botId) {
    const rows = this.store.all(
      `SELECT a.*, p.name AS project_name, p.key AS project_key,
              t.id AS task_id, t.number AS task_number, t.title AS task_title, tp.key AS task_project_key
       FROM approvals a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN runs r ON r.id = a.run_id
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN projects tp ON tp.id = t.project_id
       WHERE a.project_id IS NULL AND a.bot_id = ?
       ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 30`,
      botId,
    )
    return rows.map(row => ({ ...this.approvalView(row), ...approvalSourceFields(row) }))
  },

  // 全局待审视图（DSHBOTS-102）：跨项目聚合 status='pending'，按创建时间倒序。
  // count 是全库 pending 总数（徽标口径，已决一律不计），items 最多 50 条供顶部入口列明细。
  // 明细带项目名，用户不在该项目群聊页也能看到「谁、在哪个项目、要什么、还剩多久」。
  // scope 区分项目群聊 / 单聊（DSHBOTS-218）：顶部入口据此决定点击后跳哪个会话。
  // 来源定位（DSHBOTS-240）：额外带项目 key 与任务标识/标题——顶部跨会话审批通知要让
  // owner 不跳转就能判断「该批谁」。run_id → runs.task_id → tasks 两次主键连接，缺任务留空。
  approvalsPending(limit = 50) {
    const rows = this.store.all(
      `SELECT a.*, p.name AS project_name, p.key AS project_key,
              t.id AS task_id, t.number AS task_number, t.title AS task_title, tp.key AS task_project_key
       FROM approvals a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN runs r ON r.id = a.run_id
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN projects tp ON tp.id = t.project_id
       WHERE a.status = 'pending' ORDER BY a.created_at DESC LIMIT ?`,
      limit,
    )
    const count = Number(this.store.get("SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'")?.count ?? 0)
    return {
      count,
      items: rows.map(row => ({
        ...this.approvalView(row),
        ...approvalSourceFields(row),
      })),
    }
  },
}
