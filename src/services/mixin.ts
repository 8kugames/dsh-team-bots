// 把按域拆出的方法集合挂回 TeamService 原型。
// 域方法文件只放方法体，挂载后 service.method(...) 的调用方式与 this 语义都不变。
export function defineMethods(target, groups) {
  for (const group of groups) {
    for (const [name, fn] of Object.entries(group)) {
      Object.defineProperty(target, name, { value: fn, writable: true, configurable: true })
    }
  }
}
