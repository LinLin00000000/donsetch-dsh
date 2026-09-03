/**
 * Version parsing/comparison: the gate between untrusted release
 * tags and anything we install or upgrade to.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { compareSemver, highestVersion, isNewer, parseSemver } = await import('../dist/version.js')

test('parseSemver accepts canonical and v-prefixed tags', () => {
  assert.deepEqual(parseSemver('3.5.2'), { major: 3, minor: 5, patch: 2, prerelease: [] })
  assert.deepEqual(parseSemver('v3.5.2'), { major: 3, minor: 5, patch: 2, prerelease: [] })
  assert.deepEqual(parseSemver(' 3.5.2 '), { major: 3, minor: 5, patch: 2, prerelease: [] })
  assert.deepEqual(parseSemver('0.1.2-rc.1'), { major: 0, minor: 1, patch: 2, prerelease: ['rc', '1'] })
  assert.deepEqual(parseSemver('1.0.0-rc.1').prerelease, ['rc', '1'])
})

test('parseSemver rejects junk and hostile shapes', () => {
  for (const bad of [
    '',
    'latest',
    '3.5',
    '3.5.2.1',
    'v3.5.x',
    '3.5.2-',
    '3.5.2-rc.',
    '3.5.2+build1',
    'x.y.z',
    '3.5.2; rm -rf /',
    'v'.repeat(70),
    '-3.5.2',
    '3.5.2-rc.1-rc.2\x00',
  ]) {
    assert.equal(parseSemver(bad), null, `must reject ${JSON.stringify(bad)}`)
  }
})

test('ordering: release > prerelease > lower numbers', () => {
  assert.equal(compareSemver('3.5.2', '3.5.1'), 1)
  assert.equal(compareSemver('3.5.1-rc.2', '3.5.1-rc.1'), 1)
  assert.equal(compareSemver('3.5.1', '3.5.1-rc.9'), 1)
  assert.equal(compareSemver('3.5.2-rc.1', '3.5.1'), 1)
  assert.equal(compareSemver('4.0.0', '3.99.99'), 1)
  assert.equal(compareSemver('3.5.2', '3.5.2'), 0)
  assert.equal(compareSemver('v3.5.2', '3.5.2'), 0)
  // numeric vs alphanumeric prerelease identifiers, semver rule
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1)
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1)
})

test('isNewer and highestVersion use strict semver', () => {
  assert.equal(isNewer('3.5.2', '3.5.1'), true)
  assert.equal(isNewer('3.5.1', '3.5.2-rc.1'), false)
  assert.equal(highestVersion(['3.5.0', '3.5.2', 'junk', '3.5.1-rc.1']), '3.5.2')
  assert.equal(highestVersion(['junk1', 'not-a-tag']), null)
  assert.equal(highestVersion([]), null)
})