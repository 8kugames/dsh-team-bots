// src/services/secrets.js —— 密钥与掩码域
// 项目密钥的存取、掩码、审批与 Bot 申请流程。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AppError, badRequest, forbidden, notFound } from '../errors.js'
import {
  SecretBox, maskSecrets, normalizeSecretName, secretFingerprint, secretKeyFingerprint,
  secretsRuntimeDir, secretsRuntimeEnvPath, writeRuntimeEnvFileSync,
} from '../secrets.js'
import { id, nowIso, text } from '../util.js'

// 后台焚毁（TTL 巡检、任务运行结束）没有人类操作者，审计落系统主体。
const SYSTEM_ACTOR = { type: 'system', id: 'dsh-team' }



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

  // ===== 一次性密钥运行时（DSHBOTS-106） =====
  // 明文不再进项目工作区：批准后写 <dataDir>/secrets-runtime/<projectId>.env（目录 0700、文件 0600），
  // 在先到者发生时焚毁：①该项目下一条 task 运行 finishRun（成功/失败都删，见 runs.js）；
  // ②TTL（config.secretsRuntimeTtlMs）到期，sweepSecretsRuntime 巡检；③密钥吊销/删除。
  // 重新使用需再次批准，每次批准都重新物化。路径只通过批准回执向 Bot 披露，不进 state 视图。
  materializeSecretsRuntime(project, actor) {
    const rows = this.store.all(
      "SELECT * FROM secrets WHERE scope = 'team' OR (scope = 'project' AND project_id = ?)",
      project.id,
    )
    const box = this.ensureSecretBox()
    const entries = rows.map(row => ({
      name: row.name,
      value: box.decrypt({ valueEnc: row.value_enc, valueIv: row.value_iv, valueTag: row.value_tag }),
    }))
    const filePath = secretsRuntimeEnvPath(this.config.dataDir, project.id)
    // 同步落盘（fs 同步族）再回执：避免批准消息先于文件可读到达，Bot 侧 source 扑空。
    writeRuntimeEnvFileSync(entries, filePath)
    this.audit(actor, 'secret.materialize', 'project', project.id, { names: entries.length, ttlMs: this.config.secretsRuntimeTtlMs })
    return filePath
  },

  // 焚毁一次性文件：不存在时是幂等空操作（不记审计）；删除失败要留痕，不能默默留着明文。
  burnProjectSecretsRuntime(projectId, reason, actor = SYSTEM_ACTOR) {
    const filePath = secretsRuntimeEnvPath(this.config.dataDir, projectId)
    try {
      if (!existsSync(filePath)) return false
      rmSync(filePath, { force: true })
    } catch (error: any) {
      this.logger.warn?.('dsh-team: 焚毁项目 %s 运行时密钥失败：%s', projectId, error?.message ?? error)
      return false
    }
    this.audit(actor, 'secret.burn', 'project', projectId, { reason })
    return true
  },

  // 旧残留清理（DSHBOTS-106 迁移）：物化改走数据目录后，项目侧 .team/secrets.env 全是历史
  // 遗留，启动巡检与批准/删除时顺带删除；管理目录与生产目录都查，能删空的 .team 目录一并收走。
  cleanupLegacyProjectSecretFile(project) {
    const dirs = new Set([join(this.config.workspace, project.slug)])
    if (project.production_dir) dirs.add(project.production_dir)
    for (const dir of dirs) {
      try {
        rmSync(join(dir, '.team', 'secrets.env'), { force: true })
        rmdirSync(join(dir, '.team'))
      } catch {}
    }
  },

  // TTL 巡检：挂在调度 tick 上，内部节流 15 秒扫一次 secrets-runtime；进程内首次执行时
  // 顺带做一次全项目旧 .team/secrets.env 迁移清理（等于启动时清理）。
  sweepSecretsRuntime() {
    const now = Date.now()
    if (this._secretsSweepAt && now < this._secretsSweepAt) return
    this._secretsSweepAt = now + 15_000
    if (!this._secretsLegacyCleaned) {
      this._secretsLegacyCleaned = true
      for (const project of this.store.all('SELECT * FROM projects')) {
        this.cleanupLegacyProjectSecretFile(project)
      }
    }
    let files = []
    try {
      files = readdirSync(secretsRuntimeDir(this.config.dataDir))
    } catch {
      return
    }
    const ttl = Number(this.config.secretsRuntimeTtlMs)
    for (const name of files) {
      if (!name.endsWith('.env')) continue
      const filePath = join(secretsRuntimeDir(this.config.dataDir), name)
      try {
        if (now - statSync(filePath).mtimeMs < ttl) continue
      } catch {
        continue
      }
      this.burnProjectSecretsRuntime(name.slice(0, -'.env'.length), 'ttl')
    }
  },

  // 兼容旧调用点（projects.js 建项目/切生产目录）：一次性语义下不再物化明文，只清旧残留。
  async materializeProjectSecrets(project) {
    this.cleanupLegacyProjectSecretFile(project)
    return null
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
    // DSHBOTS-106：入库不再落盘——明文只在批准（approveSecretRequest）时一次性物化到数据目录。
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
    // DSHBOTS-106：吊销/删除即焚——受影响项目的一次性运行时文件当场删掉，重新使用需再次批准；
    // 项目侧旧 .team/secrets.env 残留顺带清理。
    const targets = row.scope === 'team'
      ? this.store.all("SELECT * FROM projects WHERE status = 'active'")
      : [this.projectRow(row.project_id)]
    for (const project of targets) {
      this.burnProjectSecretsRuntime(project.id, 'secret_delete', actor)
      this.cleanupLegacyProjectSecretFile(project)
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
      const project = this.projectRow(request.project_id)
      // 批准时顺带清掉项目侧旧 .team/secrets.env 残留（迁移），再一次性物化到数据目录。
      this.cleanupLegacyProjectSecretFile(project)
      const envPath = this.materializeSecretsRuntime(project, actor)
      const ttlMinutes = Math.max(1, Math.round(this.config.secretsRuntimeTtlMs / 60_000))
      // 路径只在批准回执里向 Bot 披露（不进 state 视图、不进常规群聊消息）。
      this.insertMessage({
        projectId: request.project_id,
        senderType: 'system',
        senderId: 'system',
        body: `密钥 ${request.name} 已批准，一次性物化到 ${envPath}（0600）。该文件在本项目下一条任务运行结束时或约 ${ttlMinutes} 分钟后自动焚毁，再次使用需重新申请批准。Bot 在 shell 里执行：set -a; . ${envPath}; set +a`,
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
