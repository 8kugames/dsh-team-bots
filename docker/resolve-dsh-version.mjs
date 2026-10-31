const registry = (process.env.NPM_REGISTRY || 'https://registry.npmjs.org/').replace(/\/+$/, '')

const parse = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
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

const compare = (left, right) => {
  const a = parse(left)
  const b = parse(right)
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  return comparePre(a.pre, b.pre)
}

const isNonAlpha = version => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
  && !/(?:^|[-.])alpha(?:[-.]|$)/i.test(version)

const response = await fetch(`${registry}/@deepseek-ai%2Fdsh`, {
  headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
  signal: AbortSignal.timeout(30_000),
})
if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
const data = await response.json()
const versions = Object.keys(data.versions ?? {}).filter(isNonAlpha).sort(compare)
if (versions.length === 0) {
  const latest = data['dist-tags']?.latest
  if (latest && isNonAlpha(latest)) {
    process.stdout.write(latest)
    process.exit(0)
  }
  throw new Error('No non-alpha DSH version found in the npm registry')
}
process.stdout.write(versions.at(-1))
