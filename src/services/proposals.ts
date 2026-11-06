// src/services/proposals.js —— 提案与技能域
// Bot 提案的评估、决策、灰度与晋升，技能绑定与回滚。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { publishSkill, rollbackSkill, skillSnapshot, stageSkill, syncSkills } from '../skills.js'
import { scanProjectSkills } from '../project-skills.js'
import { id, jsonParse, nowIso, parseDisabledSkills, sha256, slugify, text } from '../util.js'

// DSHBOTS-271 融合稿闸门：进化 bot_update 的 instructions 必须是「原指令+新增内容」的融合稿，
// 纯替换稿会把原提示词整体顶掉。保留率 = 原 instructions 的非空行（trim 后）在提案稿
// 行集合中的保留占比；低于阈值即拒绝（原因+替代指引，D-269 口径）。
// 原 instructions 为空（首次立指令）没有可保留内容，保留率恒为 1，直接放行并在 diff 留痕。
export const MERGE_KEEP_RATIO = 0.6
export const MERGE_DRAFT_GUIDANCE = '进化指令必须是原指令+新增内容的融合稿：保留原有指令全文再写改动，不是全新替换稿也不是增量补丁'

export function mergeKeepRatio(original: unknown, proposed: unknown): number {
  const originLines = String(original ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  if (!originLines.length) return 1
  const proposedLines = new Set(String(proposed ?? '').split('\n').map(line => line.trim()).filter(Boolean))
  const kept = originLines.filter(line => proposedLines.has(line)).length
  return kept / originLines.length
}

// 创建侧与应用侧（applyProposal 审批落地前）共用同一闸门函数，防创建后 bots.instructions
// 已被 updateBot 直改通道改写、或绕过创建路径提交的纯替换稿落地。
export function assertMergeDraft(original: unknown, proposed: unknown): number {
  const ratio = mergeKeepRatio(original, proposed)
  if (ratio >= MERGE_KEEP_RATIO) return ratio
  throw badRequest(`原指令保留率 ${(ratio * 100).toFixed(0)}%，低于 ${MERGE_KEEP_RATIO * 100}%：${MERGE_DRAFT_GUIDANCE}`)
}



export const proposalsMethods = {
  async createProposal(input, actor = this.actor()) {
    const kind = input.kind
    if (!['bot_update', 'skill'].includes(kind)) throw badRequest('当前版本仅支持 bot_update 与 skill 提案')
    const title = text(input.title, 200)
    if (!title) throw badRequest('提案标题不能为空')
    if (kind === 'bot_update') {
      if (!input.botId) throw badRequest('Bot 提案必须指定 Bot')
      this.botRow(input.botId)
    }
    if (kind === 'skill' && !input.payload?.content) throw badRequest('技能提案必须包含内容')
    const payload = input.payload ?? {}
    // 融合稿闸门（DSHBOTS-271）：bot_update 带 instructions 时按当前原稿校验保留率；skill 提案不经过此闸门。
    if (kind === 'bot_update' && payload.instructions !== undefined) {
      assertMergeDraft(this.botRow(input.botId).instructions, payload.instructions)
    }
    const canary = this.proposalCanary(input, kind)
    const diff = kind === 'bot_update' ? this.botProposalDiff(input.botId, payload) : this.skillProposalDiff(payload)
    const proposalId = id('prop')
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO proposals(id, kind, bot_id, project_id, title, rationale, payload_json, evaluation,
          evaluation_json, diff_json, canary_json, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        proposalId, kind, input.botId ?? null, input.projectId ?? null, title,
        text(input.rationale, 10_000), JSON.stringify(payload), text(input.evaluation, 6000),
        JSON.stringify({ verdict: 'pending', notes: text(input.evaluation, 6000), evaluatedBy: null, evaluatedAt: null }),
        JSON.stringify(diff), JSON.stringify(canary),
        `${actor.type}:${actor.id}`, nowIso(),
      )
      this.audit(actor, 'proposal.create', 'proposal', proposalId, { kind, title })
    })
    return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
  },

  // 差异统一成 {字段: {from, to}}，前端与审计日志用同一形状。
  botProposalDiff(botId, payload) {
    const bot = this.botRow(botId)
    const diff = {}
    for (const field of ['role', 'instructions', 'provider', 'model', 'effort']) {
      if (payload[field] === undefined) continue
      const before = bot[field] ?? null
      if (String(before ?? '') === String(payload[field] ?? '')) continue
      const entry: { from: unknown; to: unknown; firstInstructions?: boolean } = { from: before, to: payload[field] }
      // 首次立指令留痕（DSHBOTS-271）：原 instructions 为空时融合闸门放行，diff 标记首立。
      if (field === 'instructions' && !String(before ?? '').trim()) entry.firstInstructions = true
      diff[field] = entry
    }
    return diff
  },
  skillProposalDiff(payload) {
    const slug = slugify(payload.slug ?? '')
    const current = slug ? this.store.get('SELECT slug, version, checksum FROM skills WHERE slug = ?', slug) : null
    return {
      slug: { from: current?.slug ?? null, to: slug || null },
      version: { from: current?.version ?? null, to: text(payload.version, 40) || '1.0.0' },
      checksum: { from: current?.checksum ?? null, to: sha256(String(payload.content ?? '')) },
      bytes: { from: current ? String(payload.content ?? '').length : 0, to: String(payload.content ?? '').length },
    }
  },
  proposalCanary(input, kind) {
    const raw = input.canary ?? null
    if (!raw) return null
    const projectIds = (Array.isArray(raw.projectIds) ? raw.projectIds : []).filter(Boolean)
    const botIds = (Array.isArray(raw.botIds) ? raw.botIds : []).filter(Boolean)
    if (kind === 'bot_update' && (projectIds.length || botIds.length)) {
      throw badRequest('Bot 配置提案暂不支持灰度')
    }
    if (kind === 'skill' && !projectIds.length) {
      throw badRequest('技能灰度必须指定至少一个项目')
    }
    for (const projectId of projectIds) this.projectRow(projectId)
    return projectIds.length ? { projectIds } : null
  },
  proposalView(proposal) {
    return {
      ...proposal,
      payload: jsonParse(proposal.payload_json, {}),
      diff: jsonParse(proposal.diff_json, null),
      evaluation: jsonParse(proposal.evaluation_json, null),
      canary: jsonParse(proposal.canary_json, null),
      botName: proposal.bot_id ? this.store.get('SELECT name FROM bots WHERE id = ?', proposal.bot_id)?.name ?? null : null,
      approvedBy: proposal.approved_by ?? null,
      appliedAt: proposal.applied_at ?? null,
    }
  },

  // 评估：记录对提案的评估结论，供审批参考与留痕；评估不是审批的前置条件，
  // 人工批准/拒绝即最终决定（评估人与审批人是同一用户，两步门槛只会造成死锁）。
  async evaluateProposal(proposalId, evaluation, actor = this.actor()) {
    const proposal = this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId)
    if (!proposal) throw notFound('提案不存在')
    if (!['pending', 'canary'].includes(proposal.status)) throw conflict('提案已处理')
    const verdict = ['pass', 'fail', 'pending'].includes(evaluation?.verdict) ? evaluation.verdict : 'pending'
    const payload = {
      verdict,
      notes: text(evaluation?.notes, 6000),
      evaluatedBy: `${actor.type}:${actor.id}`,
      evaluatedAt: nowIso(),
    }
    this.store.run('UPDATE proposals SET evaluation_json = ? WHERE id = ?', JSON.stringify(payload), proposalId)
    this.audit(actor, 'proposal.evaluate', 'proposal', proposalId, { verdict })
    return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
  },
  async decideProposal(proposalId, decision, actor = this.actor()) {
    if (!['approved', 'rejected'].includes(decision)) throw badRequest('审批结果无效')
    const proposal = this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId)
    if (!proposal) throw notFound('提案不存在')
    if (proposal.status !== 'pending') throw conflict('提案已处理')
    const payload = jsonParse(proposal.payload_json, {})
    const canary = jsonParse(proposal.canary_json, null)
    if (decision === 'approved') {
      const applied = await this.applyProposal(proposal, payload, canary, actor)
      const nextStatus = applied.canary ? 'canary' : 'approved'
      this.store.run(
        'UPDATE proposals SET status = ?, decided_by = ?, decided_at = ?, approved_by = ?, applied_at = ? WHERE id = ?',
        nextStatus, `${actor.type}:${actor.id}`, nowIso(), `${actor.type}:${actor.id}`, nowIso(), proposalId,
      )
      this.audit(actor, `proposal.${decision}`, 'proposal', proposalId, { canary: applied.canary, detail: applied.detail })
      return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
    }
    this.store.run(
      'UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?',
      decision, `${actor.type}:${actor.id}`, nowIso(), proposalId,
    )
    this.audit(actor, `proposal.${decision}`, 'proposal', proposalId, {})
    return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
  },
  async applyProposal(proposal, payload, canary, actor) {
    if (proposal.kind === 'bot_update') {
      // 应用侧复核（DSHBOTS-271）：审批落地前按 bots.instructions 当前值重跑同一闸门——
      // 创建提案后原指令可能已被 updateBot 直改通道改写，此处防过期的融合稿或绕过创建路径的纯替换稿落地。
      if (payload.instructions !== undefined) {
        assertMergeDraft(this.botRow(proposal.bot_id).instructions, payload.instructions)
      }
      await this.updateBot(proposal.bot_id, {
        ...(payload.role !== undefined ? { role: payload.role } : {}),
        ...(payload.instructions !== undefined ? { instructions: payload.instructions } : {}),
        ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
      }, actor)
      return { canary: false, detail: { botId: proposal.bot_id } }
    }
    if (proposal.kind === 'skill') {
      if (canary?.projectIds?.length) {
        const staged = await stageSkill(this.config, payload)
        for (const projectId of canary.projectIds) {
          this.setSkillBinding({ scopeType: 'project', scopeId: projectId, slug: staged.slug, version: staged.version, status: 'canary' }, actor)
        }
        syncSkills(this.store, this.config.skillRoot)
        return { canary: true, detail: { slug: staged.slug, version: staged.version, projectIds: canary.projectIds } }
      }
      const published = await publishSkill(this.config, payload)
      syncSkills(this.store, this.config.skillRoot)
      this.setSkillBinding({
        scopeType: 'global', scopeId: 'global', slug: published.slug, version: published.version, status: 'active',
      }, actor)
      return { canary: false, detail: { slug: published.slug, version: published.version } }
    }
    throw badRequest('提案类型无效')
  },

  // 灰度提案转正：技能版本全量生效，灰度项目的绑定升级为 active。
  async promoteProposal(proposalId, actor = this.actor()) {
    const proposal = this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId)
    if (!proposal) throw notFound('提案不存在')
    if (proposal.status !== 'canary') throw conflict('只有灰度中的提案可以转正')
    const payload = jsonParse(proposal.payload_json, {})
    const canary = jsonParse(proposal.canary_json, null)
    const published = await publishSkill(this.config, payload)
    syncSkills(this.store, this.config.skillRoot)
    for (const projectId of canary?.projectIds ?? []) {
      this.setSkillBinding({ scopeType: 'project', scopeId: projectId, slug: published.slug, version: published.version, status: 'active' }, actor)
    }
    this.setSkillBinding({
      scopeType: 'global', scopeId: 'global', slug: published.slug, version: published.version, status: 'active',
    }, actor)
    this.store.run(
      "UPDATE proposals SET status = 'approved', applied_at = ? WHERE id = ?",
      nowIso(), proposalId,
    )
    this.audit(actor, 'proposal.promote', 'proposal', proposalId, { slug: published.slug, version: published.version })
    return this.proposalView(this.store.get('SELECT * FROM proposals WHERE id = ?', proposalId))
  },

  // 技能绑定：项目/全局维度把某个技能钉在指定版本，取代只能禁用的旧能力。
  setSkillBinding({ scopeType, scopeId, slug, version, status = 'active' }, actor = this.actor()) {
    const scope = scopeType === 'project' ? 'project' : scopeType === 'global' ? 'global' : null
    if (!scope) throw badRequest('绑定作用域无效')
    const cleanSlug = slugify(slug ?? '')
    if (!cleanSlug) throw badRequest('技能 slug 无效')
    if (scope === 'project') this.projectRow(scopeId)
    const bindingId = id('bind')
    const now = nowIso()
    this.store.run(
      `INSERT INTO skill_bindings(id, scope_type, scope_id, slug, version, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_type, scope_id, slug) DO UPDATE SET
         version = excluded.version, status = excluded.status, updated_at = excluded.updated_at`,
      bindingId, scope, scopeId ?? 'global', cleanSlug, text(version, 40) || null,
      status === 'canary' ? 'canary' : 'active', `${actor.type}:${actor.id}`, now, now,
    )
    this.audit(actor, 'skill.bind', 'skill', cleanSlug, { scope, scopeId, version, status })
    return this.store.get('SELECT * FROM skill_bindings WHERE scope_type = ? AND scope_id = ? AND slug = ?', scope, scopeId ?? 'global', cleanSlug)
  },
  skillBindings(projectId = null) {
    const rows = projectId
      ? this.store.all("SELECT * FROM skill_bindings WHERE scope_type = 'global' OR (scope_type = 'project' AND scope_id = ?)", projectId)
      : this.store.all('SELECT * FROM skill_bindings')
    return rows.map(row => ({
      ...row,
      projectName: row.scope_type === 'project'
        ? this.store.get('SELECT name FROM projects WHERE id = ?', row.scope_id)?.name ?? row.scope_id
        : '全局',
    }))
  },
  async rollbackSkillVersion(slug, version, actor = this.actor()) {
    const cleanSlug = slugify(slug ?? '')
    const result = rollbackSkill(this.config, { slug: cleanSlug, version: text(version, 40) })
    syncSkills(this.store, this.config.skillRoot)
    this.audit(actor, 'skill.rollback', 'skill', cleanSlug, { version: result.version })
    return result
  },
  proposeFromBot(sessionId, input) {
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw forbidden('只有项目群中的 Bot 可以提交进化提案')
    const kind = input.kind === 'skill' ? 'skill' : 'bot_update'
    return this.createProposal({
      kind,
      botId: binding.bot_id,
      projectId: binding.project_id,
      title: input.title,
      rationale: input.rationale,
      payload: input.payload ?? {},
      evaluation: input.evaluation,
    }, { type: 'bot', id: binding.bot_id })
  },

  // 当前项目的技能池：扫描项目目录（生产目录优先，见 projectWorkDir）的
  // .agents / .claude / .codex 三个根，同名技能按根优先级去重；只做发现，不写入共享技能池。
  projectSkillView(project) {
    const dir = this.projectWorkDir(project)
    const { skills } = scanProjectSkills(dir)
    return skills.map(skill => ({
      name: skill.name,
      slug: skill.slug,
      description: skill.description,
      version: skill.version,
      path: skill.path,
      root: skill.root,
      roots: skill.roots,
      duplicates: skill.duplicates,
      relativePath: skill.relativePath,
    }))
  },
  async syncSkillsNow(actor = this.actor()) {
    const entries = syncSkills(this.store, this.config.skillRoot)
    this.audit(actor, 'skills.sync', 'skill', '*', { count: entries.length })
    return {
      count: entries.length,
      skills: skillSnapshot(this.store, this.config),
    }
  },

  // 项目内关闭/恢复技能：仅影响该项目（补全过滤 + Bot 系统提示禁用清单），技能池本身不变。
  async setProjectSkillDisabled(projectId, slug, disabled, actor = this.actor()) {
    await this.initialize()
    const project = this.projectRow(projectId)
    const cleanSlug = String(slug ?? '').trim()
    const skill = this.store.get('SELECT slug FROM skills WHERE slug = ?', cleanSlug)
    if (!skill) throw notFound(`技能 ${cleanSlug || '(空)'} 不存在`)
    const current = parseDisabledSkills(project.disabled_skills)
    const next = disabled === true
      ? [...new Set([...current, cleanSlug])]
      : current.filter(item => item !== cleanSlug)
    this.store.run('UPDATE projects SET disabled_skills = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), nowIso(), project.id)
    this.audit(actor, 'project.skill_toggle', 'project', project.id, { slug: cleanSlug, disabled: disabled === true })
    return this.projectView(this.projectRow(project.id))
  },

  // 技能详情：按需读盘返回 SKILL.md 全文与版本历史（不进 state 载荷）。
  async skillDetail(slug) {
    await this.initialize()
    const cleanSlug = String(slug ?? '').trim()
    const row = this.store.get('SELECT * FROM skills WHERE slug = ?', cleanSlug)
    if (!row) throw notFound(`技能 ${cleanSlug || '(空)'} 不存在`)
    const fallbackPath = join(this.config.skillRoot, 'skills', cleanSlug, 'SKILL.md')
    let content = ''
    let readable = false
    for (const locator of [row.path, fallbackPath]) {
      if (!locator) continue
      try {
        content = readFileSync(locator, 'utf8')
        readable = true
        break
      } catch {}
    }
    const versions = this.store.all(
      'SELECT version, checksum, status, created_at FROM skill_versions WHERE slug = ? ORDER BY created_at DESC',
      cleanSlug,
    )
    return { ...row, content, readable, sharedPath: fallbackPath, versions }
  },
}
