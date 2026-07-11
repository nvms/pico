import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newerVersion, isDevInstall } from '../src/core/update.js'

test('newerVersion compares semver numerically', () => {
  assert.equal(newerVersion('0.7.0', '0.8.0'), '0.8.0')
  assert.equal(newerVersion('0.7.0', '0.7.1'), '0.7.1')
  assert.equal(newerVersion('0.7.0', '1.0.0'), '1.0.0')
  assert.equal(newerVersion('0.7.0', '0.7.0'), null)
  assert.equal(newerVersion('0.10.0', '0.9.9'), null)
  assert.equal(newerVersion('0.7.0', null), null)
})

test('isDevInstall detects source checkouts by path', () => {
  assert.equal(isDevInstall('file:///Users/x/code/pico/dist/pico.js'), true)
  assert.equal(isDevInstall('file:///opt/homebrew/lib/node_modules/picocode/dist/pico.js'), false)
})
