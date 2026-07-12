import test from 'node:test'
import assert from 'node:assert/strict'
import { compactNumber } from '../src/ui/format.js'

test('compactNumber shortens thousands and millions', () => {
  assert.equal(compactNumber(836), '836')
  assert.equal(compactNumber(8_836), '8.8k')
  assert.equal(compactNumber(1_759_377), '1.8m')
})
