// src/services/terminal.js —— 终端命令域
// 工作台非交互式命令台：执行、取消、状态与历史。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { spawn } from 'node:child_process'
import { badRequest, conflict, notFound } from '../errors.js'
import { id, nowIso } from '../util.js'

// 工作台「终端」的硬限制：命令长度、输出封顶（只留末尾）、每项目历史条数。
// 硬超时走 config.terminalTimeoutMs（默认 120s，测试可注入短值）。
export const TERMINAL_COMMAND_MAX = 4000

export const TERMINAL_OUTPUT_CAP = 200 * 1024

export const TERMINAL_HISTORY_LIMIT = 20

// 追加终端输出并保持缓冲区有界：超过 2 倍封顶时裁到只留末尾一倍，均摊裁剪成本。
export function appendTerminalChunk(buffer, chunk) {
  const next = buffer + chunk
  return next.length > TERMINAL_OUTPUT_CAP * 2 ? next.slice(-TERMINAL_OUTPUT_CAP) : next
}

// 杀掉终端命令的整个进程组（detached spawn 使子进程自成组长）；组杀失败时回退杀直接子进程。
export function killTerminalGroup(child) {
  if (!child) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
  }
}

export const terminalMethods = {

  // ── 工作台终端（非交互式命令台）───────────────────────────────────────────
  // 安全口径与 Bot 相同：命令以当前用户执行、权限与服务进程一致；
  // HTTP 入口由宿主 owner 路由鉴权（见 src/api.js），此处不再重复校验。
  // 不做 PTY/xterm：无法承载 vim 等交互式程序，定位是快速执行命令行命令。
  runTerminalCommand(projectId, command, actor = this.actor()) {
    const project = this.projectRow(projectId)
    if (project.status !== 'active') throw badRequest('项目已归档，不能执行终端命令')
    const clean = String(command ?? '').trim()
    if (!clean) throw badRequest('命令不能为空')
    if (clean.length > TERMINAL_COMMAND_MAX) throw badRequest(`命令过长（最多 ${TERMINAL_COMMAND_MAX} 字符）`)
    // 同项目同时只允许一条运行：检查与插入之间无 await，单线程内不会交错。
    if (this.store.get("SELECT id FROM terminal_commands WHERE project_id = ? AND status = 'running'", project.id)) {
      throw conflict('该项目已有终端命令在运行，请先停止或等待它结束')
    }
    const commandId = id('term')
    const createdAt = nowIso()
    // 命令与聊天消息同一姿势：可能拼进密钥值，入库（行、审计）前先过掩码，密钥原文不落库。
    const storableCommand = this.maskSecretValues(clean)
    this.store.run(
      `INSERT INTO terminal_commands(id, project_id, command, status, created_at) VALUES (?, ?, ?, 'running', ?)`,
      commandId, project.id, storableCommand, createdAt,
    )
    const entry = { child: null, buffer: '', startedAtMs: Date.now(), timedOut: false, cancelRequested: false, timer: null }
    this.terminalActive.set(commandId, entry)
    try {
      entry.child = spawn('/bin/sh', ['-c', clean], {
        cwd: this.projectWorkDir(project),
        env: process.env,
        detached: true, // 独立进程组：kill(-pid) 能带走整条命令管线
      })
    } catch (error: any) {
      this.finishTerminalCommand(commandId, 'failed', null, `无法启动命令：${error?.message ?? error}`)
      throw badRequest(`无法启动命令：${error?.message ?? error}`)
    }
    entry.child.stdout?.setEncoding('utf8')
    entry.child.stderr?.setEncoding('utf8')
    entry.child.stdout?.on('data', chunk => { entry.buffer = appendTerminalChunk(entry.buffer, chunk) })
    entry.child.stderr?.on('data', chunk => { entry.buffer = appendTerminalChunk(entry.buffer, chunk) })
    entry.timer = setTimeout(() => {
      entry.timedOut = true
      killTerminalGroup(entry.child)
    }, this.config.terminalTimeoutMs ?? 120_000)
    entry.timer.unref?.()
    entry.child.on('close', () => {
      const code = entry.child.exitCode
      if (entry.timedOut) this.finishTerminalCommand(commandId, 'timeout', code, '命令超时，进程组已被终止')
      else if (entry.cancelRequested) this.finishTerminalCommand(commandId, 'canceled', code, '手动停止')
      else if (code === 0) this.finishTerminalCommand(commandId, 'succeeded', 0, null)
      else this.finishTerminalCommand(commandId, 'failed', code, code === null ? '命令被信号终止' : null)
    })
    entry.child.on('error', error => {
      this.finishTerminalCommand(commandId, 'failed', null, `命令执行失败：${error?.message ?? error}`)
    })
    this.audit(actor, 'terminal.run', 'project', project.id, { command: storableCommand })
    return this.terminalCommandView(this.store.get('SELECT * FROM terminal_commands WHERE id = ?', commandId))
  },
  cancelTerminalCommand(commandId, actor = this.actor()) {
    const row = this.store.get('SELECT * FROM terminal_commands WHERE id = ?', commandId)
    if (!row) throw notFound('终端命令不存在')
    if (row.status !== 'running') throw conflict('命令已结束，无需停止')
    const entry = this.terminalActive.get(commandId)
    if (!entry) {
      // 理论上重启即置 interrupted，这里兜底清理无进程可控的 running 行。
      this.finishTerminalCommand(commandId, 'canceled', null, '服务重启后手动清理')
    } else {
      entry.cancelRequested = true
      killTerminalGroup(entry.child)
    }
    this.audit(actor, 'terminal.cancel', 'terminal_command', commandId, {})
    return this.terminalCommandView(this.store.get('SELECT * FROM terminal_commands WHERE id = ?', commandId))
  },
  terminalState(projectId) {
    // 顺手清理：每项目只保留最近 TERMINAL_HISTORY_LIMIT 条，不新增定时器。
    this.store.run(
      `DELETE FROM terminal_commands WHERE project_id = ? AND id NOT IN (
         SELECT id FROM terminal_commands WHERE project_id = ? ORDER BY created_at DESC LIMIT ?)`,
      projectId, projectId, TERMINAL_HISTORY_LIMIT,
    )
    const history = this.store.all(
      'SELECT * FROM terminal_commands WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
      projectId, TERMINAL_HISTORY_LIMIT,
    ).map(row => this.terminalCommandView(row))
    const running = history.find(row => row.status === 'running') ?? null
    let active = null
    if (running) {
      const entry = this.terminalActive.get(running.id)
      active = {
        ...running,
        // 实时 tail 同样先过掩码：密钥值不得进 UI。
        output: entry ? this.maskSecretValues(entry.buffer.slice(-TERMINAL_OUTPUT_CAP)) : running.output,
        elapsedMs: entry ? Date.now() - entry.startedAtMs : null,
      }
    }
    return { active, history }
  },

  // 收尾是幂等的：'error' 与 'close' 可能先后触发，Map 里的 entry 释放即视为已收尾。
  finishTerminalCommand(commandId, status, exitCode, errorMessage) {
    const entry = this.terminalActive.get(commandId)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      this.terminalActive.delete(commandId)
    }
    // 输出先过密钥掩码再落库：密钥值不得进库（也就不会进 UI 与历史）。
    const output = this.maskSecretValues(String(entry?.buffer ?? '').slice(-TERMINAL_OUTPUT_CAP))
    // 服务停机竞态：子进程在 store 关闭后才退出时，收尾写库失败只告警，不再炸进程。
    try {
      const row = this.store.get('SELECT project_id FROM terminal_commands WHERE id = ?', commandId)
      this.store.run(
        `UPDATE terminal_commands SET status = ?, exit_code = ?, output = ?, error_message = ?, ended_at = ? WHERE id = ?`,
        status, exitCode, output, errorMessage, nowIso(), commandId,
      )
      if (row) this.trimTerminalHistory(row.project_id)
    } catch (error: any) {
      this.logger.warn?.(`dsh-team: terminal command ${commandId} 收尾落库失败：${error?.message ?? error}`)
    }
  },
  trimTerminalHistory(projectId) {
    this.store.run(
      `DELETE FROM terminal_commands WHERE project_id = ? AND id NOT IN (
         SELECT id FROM terminal_commands WHERE project_id = ? ORDER BY created_at DESC LIMIT ?)`,
      projectId, projectId, TERMINAL_HISTORY_LIMIT,
    )
  },
  terminalCommandView(row) {
    return {
      id: row.id,
      // 命令本身也可能拼了密钥值（如 echo $TOKEN 的展开结果），出视图前同样过掩码。
      command: this.maskSecretValues(row.command),
      status: row.status,
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
      output: row.output ?? '',
      errorMessage: row.error_message ?? null,
      createdAt: row.created_at,
      endedAt: row.ended_at ?? null,
      durationMs: row.ended_at && row.created_at
        ? Math.max(0, new Date(row.ended_at).getTime() - new Date(row.created_at).getTime())
        : null,
    }
  },
}
