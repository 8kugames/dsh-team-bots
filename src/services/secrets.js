// src/services/secrets.js —— 密钥与掩码域
// 项目密钥的存取、掩码、审批与 Bot 申请流程。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AppError, badRequest, forbidden, notFound } from '../errors.js'
import { SecretBox, maskSecrets, materializeEnvFile, normalizeSecretName, secretFingerprint, secretKeyFingerprint } from '../secrets.js'
import { id, nowIso, text } from '../util.js'



export const secretsMethods = {

  // ===== 密钥管道 =====
  ensureSecretBox() {
    if (this._secretBox) return this._secretBox
    const keyFile = this.config.secretKeyPath
    const keyHex = String(process.env.DSH_TEAM_SECRET_KEY ?? '').trim()
    // 库里已有密文时不允许悄悄换密钥：缺文件直接报错，指纹不符也报错。
    const hasCiphertext = Number(this.store.get('SELECT COUNT(*) AS n FROM secrets')?.n ?? 0) > 0
    this._secretBox = keyHex
      ? new SecretBox({ keyHex })
      : new SecretBox({ keyFile, requireExisting: hasCiphertext })
    this.verifySecretKeyFingerprint()
    return this._secretBox
  },

  // 主密钥指纹：首次用到密钥时登记到 settings。
  // 换机恢复最常见的事故是密钥文件没跟着数据库一起备份，指纹不匹配当场暴露，
  // 好过等密文解不开时才发现既有密钥已经读不出来。
  verifySecretKeyFingerprint() {
    const keyFile = this.config.secretKeyPath
    const envKey = String(process.env.DSH_TEAM_SECRET_KEY ?? '').trim()
    const material = envKey || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '')
    if (!material) return null
    const fingerprint = secretKeyFingerprint(material)
    const known = this.store.setting('secret_key_fingerprint')
    if (!known) {
      this.store.setSetting('secret_key_fingerprint', fingerprint)
      return fingerprint
    }
    if (known === fingerprint) return fingerprint
    const secretCount = Number(this.store.get('SELECT COUNT(*) AS n FROM secrets')?.n ?? 0)
    if (secretCount > 0) {
      throw new AppError(
        'SECRET_KEY_MISMATCH',
        '密钥与数据库登记的指纹不一致：已拒绝继续，避免用错密钥写坏既有密文（请恢复备份中的密钥文件）',
      )
    }
    // 库里还没有密文，指纹不一致没有数据风险：直接改登记。
    this.store.setSetting('secret_key_fingerprint', fingerprint)
    return fingerprint
  },

  // 解密后的 {name, value} 全集（掩码用），写入时失效缓存。
  secretEntries() {
    if (this._secretEntries) return this._secretEntries
    const rows = this.store.all('SELECT * FROM secrets')
    const box = rows.length ? this.ensureSecretBox() : null
    this._secretEntries = rows.map(row => ({
      name: row.name,
      value: box.decrypt({ valueEnc: row.value_enc, valueIv: row.value_iv, valueTag: row.value_tag }),
      scope: row.scope,
      projectId: row.project_id,
    }))
    return this._secretEntries
  },

  // 掩码必须 fail-closed：解密失败就显式报错，绝不放行原文——
  // 放行原文等于把密钥明文写进转录、记忆和模型上下文。
  maskSecretValues(body) {
    if (typeof body !== 'string' || !body) return body
    const entries = this.secretEntries()
    if (!entries.length) return body
    return maskSecrets(body, entries)
  },
  listSecrets() {
    const rows = this.store.all('SELECT * FROM secrets ORDER BY scope, name')
    return rows.map((row) => {
      const project = row.project_id ? this.store.get('SELECT key, name FROM projects WHERE id = ?', row.project_id) : null
      return {
        id: row.id,
        scope: row.scope,
        projectName: project?.name ?? null,
        name: row.name,
        purpose: row.purpose,
        fingerprint: row.fingerprint,
        updatedBy: row.created_by,
        updatedAt: row.updated_at,
      }
    })
  },

  // 写入后物化：团队级写所有活动项目，项目级写该项目。bot 的 shell 里 `set -a; . .team/secrets.env` 生效。
  async materializeProjectSecrets(project) {
    const rows = this.store.all(
      "SELECT * FROM secrets WHERE scope = 'team' OR (scope = 'project' AND project_id = ?)",
      project.id,
    )
    const entries = rows.map((row) => {
      const box = this.ensureSecretBox()
      return { name: row.name, value: box.decrypt({ valueEnc: row.value_enc, valueIv: row.value_iv, valueTag: row.value_tag }) }
    })
    if (!entries.length) return null
    const dir = this.projectWorkDir(project)
    return materializeEnvFile(entries, dir)
  },
  async upsertSecret({ scope, projectId, name, purpose, value }, actor = this.actor()) {
    if (!['team', 'project'].includes(scope)) throw badRequest('密钥作用域必须是 team 或 project')
    if (scope === 'project' && !projectId) throw badRequest('项目级密钥必须指定项目')
    if (scope === 'project') this.projectRow(projectId)
    const normalized = normalizeSecretName(name)
    const trimmed = String(value ?? '')
    if (trimmed.length < 8) throw badRequest('密钥值至少 8 个字符（太短的值不参与掩码，也不允许存）')
    const box = this.ensureSecretBox()
    const { valueEnc, valueIv, valueTag } = box.encrypt(trimmed)
    const fingerprint = secretFingerprint(trimmed)
    const now = nowIso()
    const existing = this.store.get(
      "SELECT id FROM secrets WHERE scope = ? AND IFNULL(project_id, '') = ? AND name = ?",
      scope, scope === 'project' ? projectId : '', normalized,
    )
    let secretId
    this.store.transaction(() => {
      if (existing) {
        secretId = existing.id
        this.store.run(
          'UPDATE secrets SET purpose = ?, value_enc = ?, value_iv = ?, value_tag = ?, fingerprint = ?, created_by = ?, updated_at = ? WHERE id = ?',
          text(purpose, 200) ?? '', valueEnc, valueIv, valueTag, fingerprint, `${actor.type}:${actor.id}`, now, secretId,
        )
      } else {
        secretId = id('sec')
        this.store.run(
          `INSERT INTO secrets(id, scope, project_id, name, purpose, value_enc, value_iv, value_tag, fingerprint, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          secretId, scope, scope === 'project' ? projectId : null, normalized,
          text(purpose, 200) ?? '', valueEnc, valueIv, valueTag, fingerprint,
          `${actor.type}:${actor.id}`, now, now,
        )
      }
      this.audit(actor, existing ? 'secret.update' : 'secret.create', 'secret', secretId, { scope, name: normalized })
    })
    this._secretEntries = null
    const targets = scope === 'team'
      ? this.store.all("SELECT * FROM projects WHERE status = 'active'")
      : [this.projectRow(projectId)]
    for (const project of targets) await this.materializeProjectSecrets(project)
    return { id: secretId, name: normalized, fingerprint }
  },
  async deleteSecret(secretId, actor = this.actor()) {
    const row = this.store.get('SELECT * FROM secrets WHERE id = ?', secretId)
    if (!row) throw notFound('密钥不存在')
    this.store.transaction(() => {
      this.store.run('DELETE FROM secrets WHERE id = ?', secretId)
      this.audit(actor, 'secret.delete', 'secret', secretId, { scope: row.scope, name: row.name })
    })
    this._secretEntries = null
    // 删除后剩余条目重新物化；没有剩余条目时保留旧文件会误导，删除之。
    const targets = row.scope === 'team'
      ? this.store.all("SELECT * FROM projects WHERE status = 'active'")
      : [this.projectRow(row.project_id)]
    for (const project of targets) {
      const path = await this.materializeProjectSecrets(project)
      if (!path) {
        // 删掉密钥后必须把工作区里的明文 env 一并清掉；清不掉要留痕，不能默默留着明文文件。
        try {
          rmSync(join(this.projectWorkDir(project), '.team', 'secrets.env'), { force: true })
        } catch (error) {
          this.logger.warn?.('dsh-team: 删除密钥后清理 %s 失败：%s', project.slug, error?.message ?? error)
        }
      }
    }
    return { deleted: true }
  },

  // Bot 发起的密钥请求：进待审队列 + 群里一张系统卡片，用户在设置页批准（写值）或拒绝。
  requestSecretFromBot({ sessionId, name, reason }) {
    const binding = sessionId
      ? this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
      : null
    if (!binding?.project_id) throw badRequest('密钥请求必须在项目会话内发起')
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', binding.bot_id)
    if (!bot || bot.status !== 'active') throw forbidden('发起请求的 Bot 不存在或不可用')
    const normalized = normalizeSecretName(name)
    const requestId = id('secreq')
    this.store.run(
      `INSERT INTO secret_requests(id, project_id, bot_id, name, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      requestId, binding.project_id, binding.bot_id, normalized, text(reason, 500) ?? '', nowIso(),
    )
    const project = this.projectRow(binding.project_id)
    // 长理由围栏化（DSHBOTS-96 P3-2）：正文保持一句话可扫读，>100 字符的理由单独成块。
    const reasonText = text(reason, 300) ?? '（未说明）'
    const reasonBlock = reasonText.length > 100 ? `理由：\n\`\`\`\n${reasonText}\n\`\`\`` : `理由：${reasonText}`
    this.insertMessage({
      projectId: binding.project_id,
      senderType: 'system',
      senderId: 'system',
      body: `${bot.name} 请求密钥 ${normalized}（项目 ${project.name}）。\n${reasonBlock}\n请在设置页「密钥」中批准或拒绝。`,
    })
    return { requestId, name: normalized, status: 'pending' }
  },
  listSecretRequests() {
    const rows = this.store.all(
      "SELECT * FROM secret_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50",
    )
    return rows.map((row) => {
      const bot = this.store.get('SELECT name FROM bots WHERE id = ?', row.bot_id)
      const project = row.project_id ? this.store.get('SELECT name FROM projects WHERE id = ?', row.project_id) : null
      return {
        id: row.id,
        projectName: project?.name ?? null,
        botName: bot?.name ?? 'Bot',
        name: row.name,
        reason: row.reason,
        createdAt: row.created_at,
      }
    })
  },
  async approveSecretRequest(requestId, { value }, actor = this.actor()) {
    const request = this.store.get("SELECT * FROM secret_requests WHERE id = ? AND status = 'pending'", requestId)
    if (!request) throw notFound('密钥请求不存在或已处理')
    const created = await this.upsertSecret({
      scope: 'project',
      projectId: request.project_id,
      name: request.name,
      purpose: `bot 请求（${request.reason?.slice(0, 120) ?? '未说明'}）`,
      value,
    }, actor)
    this.store.run(
      "UPDATE secret_requests SET status = 'approved', handled_at = ? WHERE id = ?",
      nowIso(), requestId,
    )
    if (request.project_id) {
      this.insertMessage({
        projectId: request.project_id,
        senderType: 'system',
        senderId: 'system',
        body: `密钥 ${request.name} 已批准并物化到项目 .team/secrets.env，Bot 下次 shell 里 set -a; . .team/secrets.env 即可使用。`,
      })
    }
    return created
  },
  async denySecretRequest(requestId, actor = this.actor()) {
    const request = this.store.get("SELECT * FROM secret_requests WHERE id = ? AND status = 'pending'", requestId)
    if (!request) throw notFound('密钥请求不存在或已处理')
    this.store.run(
      "UPDATE secret_requests SET status = 'denied', handled_at = ? WHERE id = ?",
      nowIso(), requestId,
    )
    this.audit(actor, 'secret_request.deny', 'secret_request', requestId, { name: request.name })
    if (request.project_id) {
      this.insertMessage({
        projectId: request.project_id,
        senderType: 'system',
        senderId: 'system',
        body: `密钥 ${request.name} 的请求被拒绝。`,
      })
    }
    return { denied: true }
  },
}
