import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const registry = (process.env.NPM_REGISTRY || 'https://registry.npmjs.org/').replace(/\/+$/, '')
// 每个包一条缓存：{ at, version }，5 分钟内复用。
const registryCache = new Map()

const parseVersion = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version))
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  }
}

const comparePre = (a, b) => {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1
    if (b[index] === undefined) return 1
    const na = /^\d+$/.test(a[index]) ? Number(a[index]) : null
    const nb = /^\d+$/.test(b[index]) ? Number(b[index]) : null
    if (na !== null && nb !== null && na !== nb) return na - nb
    if (na !== null && nb === null) return -1
    if (na === null && nb !== null) return 1
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

export const compareVersions = (left, right) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  return comparePre(a.pre, b.pre)
}

export const isNonAlpha = version => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
  && !/(?:^|[-.])alpha(?:[-.]|$)/i.test(version)

async function latestRegistryVersion(pkg, { force = false } = {}) {
  const cached = registryCache.get(pkg)
  if (!force && cached && Date.now() - cached.at < 5 * 60_000) return cached.version
  const response = await fetch(`${registry}/${encodeURIComponent(pkg)}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`npm registry 返回 ${response.status}`)
  const data = await response.json()
  const versions = Object.keys(data.versions ?? {}).filter(isNonAlpha).sort(compareVersions)
  const version = versions.at(-1) ?? data['dist-tags']?.latest
  if (!version || !isNonAlpha(version)) throw new Error(`npm registry 中没有可用的非 alpha ${pkg} 版本`)
  registryCache.set(pkg, { at: Date.now(), version })
  return version
}

export function latestDshVersion(opts = {}) {
  return latestRegistryVersion('@deepseek-ai/dsh', opts)
}

// dsh-team-bots（本插件）在 npm 的最新正式版：与 dsh 同口径过滤 alpha。
export function latestTeamBotsVersion(opts = {}) {
  return latestRegistryVersion('dsh-team-bots', opts)
}

export function validTargetVersion(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
}

// 从宿主入口向上探测 package.json 的目录级数上限（含起始目录）：覆盖
// …/@deepseek-ai/dsh/bin/*.js 到包根（2 级）余量充足，又不至于在无关目录树里捡到别的包。
const HOST_PACKAGE_LEVELS = 6

// dsh 宿主运行时版本探测链（DSHBOTS-146）：宿主进程从不设置 DSH_RUNTIME_VERSION，
// env-only 读取恒 unknown。三级回退：
// ① env.DSH_RUNTIME_VERSION（宿主将来可能提供，保留）；
// ② 从宿主入口脚本（process.argv[1]，如 …/@deepseek-ai/dsh/bin/*.js）逐级向上
//    最多 HOST_PACKAGE_LEVELS 级找最近的 package.json 读 version；
// ③ 仍拿不到返回 'unknown'。env/argv1 注入式传参（显式传 undefined 即视为缺省），
// 测试不依赖真实宿主。
export function detectDshRuntimeVersion(env, argv1) {
  const fromEnv = typeof env?.DSH_RUNTIME_VERSION === 'string' ? env.DSH_RUNTIME_VERSION.trim() : ''
  if (fromEnv) return fromEnv
  if (argv1) {
    let dir = dirname(resolve(String(argv1)))
    for (let level = 0; level < HOST_PACKAGE_LEVELS; level += 1) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (typeof pkg?.version === 'string' && pkg.version) return pkg.version
      } catch {
        // 本级没有 package.json、不可读或 JSON 损坏：视为未命中，继续向上。
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return 'unknown'
}
