// 共享运行时桩：无状态六方法形态（setCompletionHandler/catalog/validateBotConfig/
// startRun/cancelRun）。需要记录 started、捕获 handler 或自定义返回值的测试仍各自定义，
// 不在本 helper 内做配置化（避免万能桩反向耦合全部用例）。
export class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }: { run: { id: string } }) { return `session-${run.id}` }
  async cancelRun() { return true }
}
