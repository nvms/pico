import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../src/cli-args.js'

test('defaults to interactive with no args', () => {
  assert.deepEqual(parseArgs([]), { mode: 'interactive' })
})

test('parses headless flags', () => {
  const opts = parseArgs(['-p', 'fix the test', '--json', '-m', 'flash', '--effort', 'high', '--max-tool-calls', '10', '-q'])
  assert.equal(opts.mode, 'headless')
  assert.equal(opts.prompt, 'fix the test')
  assert.equal(opts.json, true)
  assert.equal(opts.model, 'flash')
  assert.equal(opts.effort, 'high')
  assert.equal(opts.maxToolCalls, 10)
  assert.equal(opts.quiet, true)
})

test('rejects bad input', () => {
  assert.throws(() => parseArgs(['-p']), /requires a value/)
  assert.throws(() => parseArgs(['-p', '  ']), /non-empty/)
  assert.throws(() => parseArgs(['--effort', 'extreme']), /invalid effort/)
  assert.throws(() => parseArgs(['--max-tool-calls', 'zero']), /positive number/)
  assert.throws(() => parseArgs(['--frobnicate']), /unknown argument/)
})

test('help and version modes', () => {
  assert.equal(parseArgs(['-h']).mode, 'help')
  assert.equal(parseArgs(['--version']).mode, 'version')
})

test('resume takes a session id or path', () => {
  assert.equal(parseArgs(['-p', 'go', '--resume', 'abc-123']).resume, 'abc-123')
})
