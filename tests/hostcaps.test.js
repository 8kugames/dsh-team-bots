import test from 'node:test'
import assert from 'node:assert/strict'
import { capabilityRoot, planCapabilityMounts } from '../scripts/host-capabilities.mjs'

const HOME = '/Users/tester'

test('home-internal reference mounts its first-level tree twice, rw', () => {
  const plan = planCapabilityMounts([`${HOME}/.taptap-maker/mcp-runtime/0.0.39/dist/maker.js`], HOME)
  assert.deepEqual(plan.roots.map(r => ({ root: r.root, kind: r.kind })), [
    { root: `${HOME}/.taptap-maker`, kind: 'home' },
  ])
  assert.deepEqual(plan.mounts, [
    { source: `${HOME}/.taptap-maker`, target: `${HOME}/.taptap-maker`, mode: 'rw' },
    { source: `${HOME}/.taptap-maker`, target: '/home/node/.taptap-maker', mode: 'rw' },
  ])
  assert.equal(plan.skipped.length, 0)
})

test('references under the same tree collapse into one root', () => {
  const plan = planCapabilityMounts([
    `${HOME}/.taptap-maker/mcp-runtime/0.0.39/dist/maker.js`,
    `${HOME}/.taptap-maker/mcp-runtime/0.0.40/dist/maker.js`,
    `${HOME}/.other-tool/bin/run`,
  ], HOME)
  assert.deepEqual(plan.roots.map(r => r.root), [`${HOME}/.taptap-maker`, `${HOME}/.other-tool`])
  assert.deepEqual(plan.roots[0].refs, [
    `${HOME}/.taptap-maker/mcp-runtime/0.0.39/dist/maker.js`,
    `${HOME}/.taptap-maker/mcp-runtime/0.0.40/dist/maker.js`,
  ])
  assert.equal(plan.mounts.length, 4)
})

test('external reference mounts its own directory read-only', () => {
  const plan = planCapabilityMounts(['/opt/tools/maker/dist/maker.js'], HOME)
  assert.deepEqual(plan.roots.map(r => r.root), ['/opt/tools/maker/dist'])
  assert.deepEqual(plan.mounts, [
    { source: '/opt/tools/maker/dist', target: '/opt/tools/maker/dist', mode: 'ro' },
  ])
})

test('image-owned directories are never shadowed, deep external paths mount ro', () => {
  // dirname is itself an image-owned directory → skipped
  assert.equal(capabilityRoot('/opt/tool.js', HOME), null)
  assert.equal(capabilityRoot('/usr/local/tool.js', HOME), null)
  assert.equal(capabilityRoot('/usr/bin/node', HOME), null)
  const plan = planCapabilityMounts(['/opt/tool.js', '/usr/local/tool.js', '/usr/bin/node'], HOME)
  assert.equal(plan.mounts.length, 0)
  assert.equal(plan.skipped.length, 3)
  // a deep npm-global style path only shadows a path the image does not define → mounted
  const deep = planCapabilityMounts(['/usr/local/lib/node_modules/@scope/mcp/dist/index.js'], HOME)
  assert.deepEqual(deep.mounts, [
    { source: '/usr/local/lib/node_modules/@scope/mcp/dist', target: '/usr/local/lib/node_modules/@scope/mcp/dist', mode: 'ro' },
  ])
})

test('degenerate references are skipped', () => {
  assert.equal(capabilityRoot('/', HOME), null)
  assert.equal(capabilityRoot(HOME, HOME), null)
  assert.equal(capabilityRoot('/plain.js', HOME), null)
})

test('trailing slashes and relative resolution do not change the root', () => {
  assert.equal(capabilityRoot(`${HOME}/.taptap-maker/`, HOME).root, `${HOME}/.taptap-maker`)
  assert.equal(capabilityRoot(`${HOME}/./.taptap-maker/x.js`, HOME).root, `${HOME}/.taptap-maker`)
})
