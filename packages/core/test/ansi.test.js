import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripAnsi, createSgrTracker } from '../src/ansi.js'

test('stripAnsi removes csi sequences', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m plain'), 'red plain')
})

test('the tracker carries open styles and drops them on reset', () => {
  const sgr = createSgrTracker()
  sgr.feed('\x1b[1m\x1b[32mgreen')
  assert.equal(sgr.style(), '\x1b[1m\x1b[32m')
  sgr.feed(' still\x1b[0m done')
  assert.equal(sgr.style(), '')
})

test('a sequence split across chunks is applied once complete', () => {
  const sgr = createSgrTracker()
  sgr.feed('text \x1b[3')
  assert.equal(sgr.style(), '')
  sgr.feed('4mblue')
  assert.equal(sgr.style(), '\x1b[34m')
})

test('a leading zero resets before applying the rest', () => {
  const sgr = createSgrTracker()
  sgr.feed('\x1b[1m')
  sgr.feed('\x1b[0;31m')
  assert.equal(sgr.style(), '\x1b[31m')
})
