import test from 'node:test'
import assert from 'node:assert/strict'
import { contextBar } from '../src/ui/context-bar.js'

test('renders context usage as a four-character bar', () => {
  assert.equal(contextBar(0), '    ')
  assert.equal(contextBar(10), '▍   ')
  assert.equal(contextBar(50), '██  ')
  assert.equal(contextBar(72), '██▉ ')
  assert.equal(contextBar(100), '████')
})

test('rounds and clamps context usage', () => {
  assert.equal(contextBar(-10), '    ')
  assert.equal(contextBar(1), '    ')
  assert.equal(contextBar(2), '▏   ')
  assert.equal(contextBar(200), '████')
})
