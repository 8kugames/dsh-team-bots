import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, isNonAlpha, validTargetVersion } from '../src/updater.js'

test('semver comparator handles rc and stable versions', () => {
  assert.ok(compareVersions('0.2.1-rc.5', '0.2.1-rc.4') > 0)
  assert.ok(compareVersions('0.2.1', '0.2.1-rc.5') > 0)
  assert.ok(compareVersions('0.3.0-rc.1', '0.2.9') > 0)
  assert.equal(compareVersions('0.2.1-rc.5', '0.2.1-rc.5'), 0)
})

test('only non-alpha semver versions are accepted', () => {
  assert.equal(isNonAlpha('0.2.1-rc.5'), true)
  assert.equal(isNonAlpha('0.2.1-alpha.1'), false)
  assert.equal(validTargetVersion('0.2.1-rc.5'), true)
  assert.equal(validTargetVersion('latest'), false)
})
