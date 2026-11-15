// DSHBOTS-220：ui 源码已 t() 化，测试用 new Function 求值真实源码块时沙箱内没有 t。
// 这里补一个兜底 t：文案回键本身、并按 ${name} 做参数插值（与真实 t() 的插值口径一致），
// 等价于改造前「中文字面量内联」的求值环境。与 document/window 等既有 shim 同性质，
// 不改变被测源码，也不放宽任何断言。
if (typeof globalThis.t !== 'function') {
  globalThis.t = (key, params) => String(key).replace(/\$\{(\w+)\}/g, (match, name) => (
    params == null || params[name] == null ? match : String(params[name])
  ))
}
