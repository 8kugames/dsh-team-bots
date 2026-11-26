// src/client.ts —— 浏览器半边（dsh.client 声明，由 DSH 原生 SPA 的 client cordis 加载）。
// 团队工作台（插件页）与原生界面之间没有 URL 路由可深链（原生 SPA 无 hash/query 路由），
// 跳转靠这一层桥：插件页写 localStorage 待开键 + BroadcastChannel 广播，本半边消费并调
// ctx.uiWorkspace.openSession(sessionId) 精确打开对应会话。
//
// 产物形态（dsh-client-modules 契约）：宿主把本文件原文内联进
// classic script 执行，因此本文件不能有 ESM 语法——顶层不得出现 import/export，
// 必须以 window.__ModuleLoader__.load({id, factory}) 自注册，工厂返回 {inject, apply}。
// id 必须是包名。tests/client-bridge.test.ts 用 VM 执行构建产物来守这条契约。
//
// 关键时序：openSession 要求目标会话已在浏览器会话目录里（sessions.retain 对未知 id 抛
// unknown session）。冷启动（跳转开的新标签）时目录还在异步加载，直接调用必然失败——
// 所以打开动作进重试泵：600ms 一拍反复尝试，目录就绪即成功；超限则 console.warn 明确
// 失败原因（不静默）。热路径（BroadcastChannel/storage）同样走泵，覆盖目录未就绪的窗口。
// openSession 在 retain 失败时不改任何 UI 状态，重试无副作用。
(function () {
	const CHANNEL = 'dsh-team-bots'
	const PENDING_KEY = 'dsh-team-bots:open-session'
	const RETRY_MS = 600
	const RETRY_MAX = 25 // ≈15s：会话目录加载通常秒级；超限视为目标不在当前界面目录。

	interface BridgeWindow {
		localStorage?: {
			getItem(key: string): string | null
			removeItem(key: string): void
		}
		BroadcastChannel?: new (name: string) => {
			onmessage: ((event: { data?: unknown }) => void) | null
			close(): void
		}
		addEventListener?(type: string, listener: (event: { key?: string; newValue?: string | null }) => void): void
		removeEventListener?(type: string, listener: (event: unknown) => void): void
	}

	interface BridgeContext {
		uiWorkspace?: { openSession?(sessionId: string): void }
		effect?(fn: () => void, tag?: string): unknown
	}

	// 诊断出口：原生页控制台读不到插件内部状态，这里把最近一次尝试的结果挂到全局，
	// 便于排查「点了没反应」到底卡在哪一步（服务缺失 / 会话不在目录 / 打开失败）。
	const debugState = {
		attempts: [] as Array<{ sessionId: string; at: number; ok: boolean; error?: string }>,
		serviceAvailable: false,
	}
	;(globalThis as unknown as Record<string, unknown>)['__dshTeamBots'] = debugState
	const record = (sessionId: string, ok: boolean, error?: string): void => {
		debugState.attempts.push({ sessionId, at: Date.now(), ok, error })
		if (debugState.attempts.length > 20) debugState.attempts.shift()
	}

	interface LoaderFacade {
		__ModuleLoader__?: {
			load(registration: {
				id: string
				factory(require: (specifier: string) => unknown): Record<string, unknown>
			}): void
		}
	}

	/**
	 * 装跳转桥：监听待开键与广播，按需调用原生界面的 openSession。
	 * @param win - 浏览器全局（可注入替身，便于测试）。
	 * @param ctx - 浏览器插件上下文。
	 */
	function createBridge(win: BridgeWindow, ctx: BridgeContext): void {
		// 重试泵：sessionId -> 已试次数。openSession 抛错（目录未就绪）就留着下一拍再试。
		const queue = new Map<string, number>()
		let timer: ReturnType<typeof setTimeout> | null = null
		const pump = (): void => {
			timer = null
			debugState.serviceAvailable = typeof ctx.uiWorkspace?.openSession === 'function'
			for (const [sessionId, attempts] of queue) {
				try {
					if (!debugState.serviceAvailable) throw new Error('uiWorkspace service unavailable')
					ctx.uiWorkspace?.openSession?.(sessionId)
					record(sessionId, true)
					queue.delete(sessionId)
				} catch (error) {
					const message = (error as Error)?.message ?? String(error)
					record(sessionId, false, message)
					if (attempts + 1 >= RETRY_MAX) {
						queue.delete(sessionId)
						// 明确失败：多半是目标会话不在当前界面的会话目录（未连接对应工作区）。
						console.warn('[dsh-team-bots] 无法在原生界面打开会话', sessionId, message)
					} else {
						queue.set(sessionId, attempts + 1)
					}
				}
			}
			if (queue.size > 0) timer = setTimeout(pump, RETRY_MS)
		}
		const open = (sessionId: unknown): void => {
			if (typeof sessionId !== 'string' || !sessionId) return
			if (!queue.has(sessionId)) queue.set(sessionId, 0)
			if (timer === null) pump()
		}
		const consumePending = (): void => {
			try {
				const pending = win.localStorage?.getItem?.(PENDING_KEY)
				if (pending) {
					win.localStorage?.removeItem?.(PENDING_KEY)
					open(pending)
				}
			} catch {
				// 存储不可用时只剩广播通道。
			}
		}
		// 冷启动：SPA 本标签刚起，消费插件页留下的待开请求（目录未就绪由泵兜住）。
		consumePending()
		// 热路径：BroadcastChannel（同源跨标签，插件页 post）。
		try {
			const channel = new win.BroadcastChannel!(CHANNEL)
			channel.onmessage = (event) => {
				const data = event?.data as { type?: string; sessionId?: string } | undefined
				if (data?.type === 'open-session') open(data.sessionId)
			}
			ctx.effect?.(() => () => {
				try {
					channel.close()
				} catch {
					// 已关闭。
				}
			}, 'dsh-team-bots: client bridge')
		} catch {
			// 浏览器不支持广播时只剩待开键。
		}
		// storage 事件双保险：插件页写键即触发（仅其他标签收到），本标签消费后删键。
		const onStorage = (event: { key?: string; newValue?: string | null }): void => {
			if (event?.key !== PENDING_KEY || event.newValue == null) return
			try {
				win.localStorage?.removeItem?.(PENDING_KEY)
			} catch {
				// 忽略。
			}
			open(event.newValue)
		}
		win.addEventListener?.('storage', onStorage)
		// 清理逻辑必须是 effect 回调的返回值：cordis 的 effect 回调体立即执行，
		// 把清理写在体里会在注册瞬间就把重试定时器清掉（只试一次就静默放弃）。
		ctx.effect?.(() => () => {
			win.removeEventListener?.('storage', onStorage)
			if (timer !== null) clearTimeout(timer)
		}, 'dsh-team-bots: storage bridge')
	}

	const loader = (typeof window !== 'undefined' ? (window as unknown as LoaderFacade) : null)?.__ModuleLoader__
	if (loader !== undefined) {
		loader.load({
			id: 'dsh-team-bots',
			factory() {
				return {
					/** Cordis 服务：uiWorkspace 提供 openSession。 */
					inject: ['uiWorkspace'],
					/**
					 * 在原生 SPA 的浏览器 cordis 里装跳转桥。
					 * @param ctx - 浏览器插件上下文。
					 */
					apply(ctx: BridgeContext) {
						createBridge(window as unknown as BridgeWindow, ctx)
					},
				}
			},
		})
	}
})()
